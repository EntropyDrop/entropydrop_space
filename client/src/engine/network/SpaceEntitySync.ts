import * as THREE from 'three';
import {
  SpaceEntityClient,
  type SpaceEntityRunState,
  type SpaceWorldEntityRecord,
} from '../../bootstrap/SpaceEntityClient.ts';
import { sha256Hex } from '../../bootstrap/NetworkSafety.ts';
import { ActionDomain } from '@entropydrop/space-engine/actions/BasicActions.ts';
import { CHUNK_SIZE_X } from '@entropydrop/space-engine/voxel/Chunk.ts';
import { TORUS_SIZE_X, TORUS_SIZE_Z, unwrapPeriodicNear, wrapX, wrapZ } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { ENTITY_IMPOSTOR_SETTING_LIMITS } from '../render/EntityImpostorSettings.ts';


export const SPACE_ENTITY_POLL_INTERVAL_MS = 2_000;
export const SPACE_ENTITY_CHECKPOINT_INTERVAL_MS = 6_000;

function wrappedCentimetres(value: number, wrap: (position: number) => number, extent: number) {
  return Math.round(wrap(value) * 100) % (extent * 100);
}

type SpaceEntitySyncOptions = {
  apiOrigin: string;
  token: string;
  worldId: string;
  currentUserId: string;
  controller: any;
  contraptions: any;
  world: any;
  getPlayerPosition: () => { x: number; z: number };
  getEntityImpostorDistance?: () => number;
  fetchImpl?: typeof fetch;
};

/**
 * Loads server-placed entities into the nearby browser simulation window.
 * Only the owner's browser advances scripts/physics. Everyone else receives a
 * stopped, collidable construction pose and cannot mutate the durable run bit.
 */
export class SpaceEntitySync {
  private readonly client: SpaceEntityClient;
  private readonly currentUserId: string;
  private readonly controller: any;
  private readonly contraptions: any;
  private readonly world: any;
  private readonly getPlayerPosition: () => { x: number; z: number };
  private readonly getEntityImpostorDistance: () => number;
  private readonly instanceId: string;
  private readonly loading = new Set<string>();
  private readonly leasedUntil = new Map<string, number>();
  private readonly executionEpochs = new Map<string, number>();
  private readonly latestRevisions = new Map<string, number>();
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly entityAliases = new Map<string, string>();
  private readonly localIdByServerId = new Map<string, string>();
  private readonly saveChains = new Map<string, Promise<void>>();
  private readonly createOperationIds = new Map<string, string>();
  private readonly initialCreateRecords = new Map<string, any>();
  private readonly pendingLocalRecords = new Map<string, any>();
  private readonly lastSnapshotJson = new Map<string, string>();
  private readonly pendingDeletes = new Set<string>();
  // Entity UUIDs are never reused. Keep successful deletions for this session
  // so an older in-flight AOI/definition reply cannot resurrect a deleted entity.
  private readonly deletedEntityIds = new Set<string>();
  private previousAoiIds = new Set<string>();
  private readonly lastAoiRecords = new Map<string, SpaceWorldEntityRecord>();
  private readonly retainedOutsideAoi = new Map<string, SpaceWorldEntityRecord>();
  private lastCheckpointAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private stopped = false;

  constructor(options: SpaceEntitySyncOptions) {
    this.client = new SpaceEntityClient(
      options.apiOrigin,
      options.token,
      options.worldId,
      options.fetchImpl,
    );
    this.currentUserId = options.currentUserId;
    this.controller = options.controller;
    this.contraptions = options.contraptions;
    this.world = options.world;
    this.getPlayerPosition = options.getPlayerPosition;
    this.getEntityImpostorDistance = options.getEntityImpostorDistance || (() => 0);
    if (typeof globalThis.crypto?.randomUUID !== 'function') {
      throw new Error('This browser cannot generate a secure entity executor identity.');
    }
    this.instanceId = globalThis.crypto.randomUUID();
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.contraptions?.setRemoteEntityPersistence?.({
      save: (record, options) => this.queueSave(record, options),
      remove: publicId => this.queueDelete(publicId),
    });
    this.controller?.setServerEntityRunStateHandler?.((contraption, desiredState) => (
      this.setRunState(contraption, desiredState)
    ));
    this.controller?.setServerEntityDeleteHandler?.(contraption => this.queueDelete(String(contraption.publicId), true));
    void this.poll();
    this.timer = setInterval(() => void this.poll(), SPACE_ENTITY_POLL_INTERVAL_MS);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    this.leasedUntil.clear();
    this.executionEpochs.clear();
    this.enforceExecutionLeases();
    this.controller?.setServerEntityRunStateHandler?.(null);
    this.controller?.setServerEntityDeleteHandler?.(null);
    this.contraptions?.setRemoteEntityPersistence?.(null);
  }

  hasRetainedImpostor(publicId: string) {
    return this.retainedOutsideAoi.has(publicId);
  }

  async poll() {
    if (this.stopped) return;
    this.enforceExecutionLeases();
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const position = this.getPlayerPosition();
      const radiusCm = Math.max(3, Math.min(24, Number(this.world?.renderDistance) || 8) + 2)
        * CHUNK_SIZE_X * 100;
      const list = await this.client.list(
        wrappedCentimetres(position.x, wrapX, TORUS_SIZE_X),
        wrappedCentimetres(position.z, wrapZ, TORUS_SIZE_Z),
        radiusCm,
      );
      if (this.stopped) return;
      try {
        await this.renewExecutionLeases(list.items);
      } catch (error) {
        console.warn('Space entity execution lease could not be renewed; entities stay stopped.', error);
      }
      if (this.stopped) return;
      await Promise.all(list.items.map(entity => this.applyRecord(entity)));
      const currentIds = new Set(list.items.map(entity => entity.id));
      if (!list.truncated) this.removeEntitiesOutsideAoi(currentIds, position, radiusCm / 100);
      // An incomplete list does not prove that a previously seen entity left
      // the AOI or was deleted. Keep it until a complete poll can reconcile it.
      if (!list.truncated) {
        this.previousAoiIds = currentIds;
        this.lastAoiRecords.clear();
      }
      for (const entity of list.items) {
        this.previousAoiIds.add(entity.id);
        this.lastAoiRecords.set(entity.id, entity);
        this.retainedOutsideAoi.delete(entity.id);
      }
      if (Date.now() - this.lastCheckpointAt >= SPACE_ENTITY_CHECKPOINT_INTERVAL_MS) {
        this.lastCheckpointAt = Date.now();
        for (const entityId of [...this.pendingDeletes]) this.queueDelete(entityId);
      }
      if (list.truncated) {
        console.warn('Space entity AOI was truncated; only the closest server entities are loaded.');
      }
    } catch (error) {
      console.warn('Space entity synchronization is temporarily unavailable.', error);
    } finally {
      this.enforceExecutionLeases();
      this.pollInFlight = false;
    }
  }

  /** Also called before each simulation frame, including after tab suspension. */
  enforceExecutionLeases() {
    const now = Date.now();
    const freeze = (entity: any) => {
      if (!entity?.serverManaged || entity.serverExecutionMode === 'hosted'
        || entity.serverDesiredRunState !== 'running'
        || (this.leasedUntil.get(String(entity.publicId)) || 0) > now) return;
      const physicsEnabled = entity.isPhysicsSimulationEnabled?.() ?? entity.physicsSimulationEnabled !== false;
      entity.serverExecutesLocally = false;
      if (entity.scriptStatus === 'stopped' && !physicsEnabled) return;
      entity.scriptStatus = 'stopped';
      entity.setPhysicsSimulationEnabled?.(false);
      if (typeof entity.setPhysicsSimulationEnabled !== 'function') entity.physicsSimulationEnabled = false;
    };
    for (const entity of this.contraptions.contraptions || []) freeze(entity);
    for (const records of this.contraptions.dormantContraptions?.values?.() || []) {
      for (const record of records.values()) freeze(record);
    }
    for (const [id, expires] of this.leasedUntil) {
      if (expires <= now) {
        this.leasedUntil.delete(id);
        this.executionEpochs.delete(id);
      }
    }
  }

  private acceptLeases(leases: Awaited<ReturnType<SpaceEntityClient['claimExecutionLeases']>>, requestedAt: number) {
    if (this.stopped) return;
    for (const lease of leases) {
      // Bound the deadline by the request start as well as server time. A slow
      // response must not extend an eight-second lease on this browser.
      const expires = Math.min(Date.parse(lease.lease_expires_at || ''), requestedAt + 8_000);
      if (lease.granted && expires > Date.now()) {
        this.leasedUntil.set(lease.entity_id, expires);
        this.executionEpochs.set(lease.entity_id, lease.execution_epoch);
      } else {
        this.leasedUntil.delete(lease.entity_id);
        this.executionEpochs.delete(lease.entity_id);
      }
    }
    this.enforceExecutionLeases();
    this.scheduleLeaseExpiry();
  }

  private scheduleLeaseExpiry() {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    if (!this.leasedUntil.size) return;
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = null;
      this.enforceExecutionLeases();
      this.scheduleLeaseExpiry();
    }, Math.max(1, Math.min(...this.leasedUntil.values()) - Date.now()));
    this.leaseTimer.unref?.();
  }

  private isStale(entity: SpaceWorldEntityRecord) {
    if (this.deletedEntityIds.has(entity.id)) return true;
    const active = this.contraptions.findActiveContraptionByPublicId?.(entity.id)
      || this.contraptions.contraptions?.find(item => String(item.publicId) === entity.id);
    return Math.max(this.latestRevisions.get(entity.id) || 0, Number(active?.serverRevision) || 0) > entity.revision;
  }

  private metadata(entity: SpaceWorldEntityRecord) {
    const executesLocally = entity.owner_user_id === this.currentUserId
      && entity.execution_mode !== 'hosted'
      && (this.leasedUntil.get(entity.id) || 0) > Date.now();
    return {
      serverManaged: true,
      serverExecutionMode: entity.execution_mode || 'browser',
      serverHostingEnabled: entity.hosting_enabled === true,
      serverOwnerUserId: entity.owner_user_id,
      serverOwnerName: entity.owner_name || null,
      serverExecutorName: executesLocally ? entity.owner_name || null : entity.executor_name || null,
      serverExecutionLeaseExpiresAt: executesLocally
        ? new Date(this.leasedUntil.get(entity.id)!).toISOString() : entity.execution_lease_expires_at || null,
      serverCanControl: entity.can_control,
      serverCanEdit: entity.can_edit,
      serverExecutesLocally: executesLocally,
      serverRevision: entity.revision,
      serverDesiredRunState: entity.desired_run_state,
      serverDefinitionDigest: entity.definition_digest,
      serverSnapshotDigest: entity.snapshot_digest,
    };
  }

  private dormantMetadata(entity: SpaceWorldEntityRecord) {
    const metadata = this.metadata(entity);
    const running = metadata.serverExecutesLocally && entity.desired_run_state === 'running';
    return {
      ...metadata,
      physicsSimulationEnabled: running,
      scriptStatus: running ? 'running' : 'stopped',
    };
  }

  private async renewExecutionLeases(entities: SpaceWorldEntityRecord[]) {
    const now = Date.now();
    const ownedRunning = entities.filter(entity => (
      entity.owner_user_id === this.currentUserId && entity.desired_run_state === 'running'
      && entity.execution_mode !== 'hosted'
    ));
    const runningIds = new Set(ownedRunning.map(entity => entity.id));
    for (const entity of entities) {
      if (!runningIds.has(entity.id)) this.leasedUntil.delete(entity.id);
    }
    const due = ownedRunning.filter(entity => (this.leasedUntil.get(entity.id) || 0) <= now + 4_000);
    if (due.length === 0) return;
    const leases = await this.client.claimExecutionLeases(
      this.instanceId,
      due.map(entity => entity.id),
    );
    this.acceptLeases(leases, now);
  }

  private applyPlayback(contraption: any, entity: SpaceWorldEntityRecord) {
    if (contraption.isWrenchGrabbed || this.controller?.wrenchGrab?.contraption === contraption) {
      return;
    }
    if (entity.execution_mode === 'hosted') {
      // Freeze the latest server pose. Global Stop would reset component state and
      // construction transforms, destroying the authoritative runtime snapshot.
      contraption.scriptStatus = 'stopped';
      contraption.setPhysicsSimulationEnabled?.(false);
      return;
    }
    const shouldRun = (this.leasedUntil.get(entity.id) || 0) > Date.now()
      && entity.desired_run_state === 'running'
      && contraption.serverDesiredRunState !== 'stopped';
    const isRunning = contraption.scriptStatus === 'running'
      || (contraption.scriptStatus !== 'stopped' && contraption.isPhysicsSimulationEnabled?.() !== false);
    if (shouldRun === isRunning) return;
    this.contraptions.performBasicAction({
      domain: ActionDomain.ENTITY,
      action: shouldRun ? 'start-scripts' : 'stop-scripts',
      target: { contraption },
      actor: { source: 'server-sync' },
    });
  }

  private async applyRecord(entity: SpaceWorldEntityRecord) {
    if (this.isStale(entity)) return;
    this.latestRevisions.set(entity.id, entity.revision);
    const active = this.contraptions.findActiveContraptionByPublicId?.(entity.id)
      || this.contraptions.contraptions?.find(item => String(item.publicId) === entity.id);
    if (active) {
      const remoteSnapshotChanged = active.serverSnapshotDigest !== entity.snapshot_digest;
      const remoteDefinitionChanged = active.serverDefinitionDigest !== entity.definition_digest;
      if (remoteSnapshotChanged && !remoteDefinitionChanged) {
        // A snapshot-only update (a running entity's periodic pose/physics
        // publication, or our own checkpoint echo) must be applied IN PLACE.
        // Removing and re-fetching the whole entity made it blink out for a
        // moment and reappear on every server snapshot change.
        if (await this.applySnapshotInPlace(active, entity)) return;
      }
      if (!remoteSnapshotChanged && !remoteDefinitionChanged) {
        this.applyRecordMetadata(active, entity);
        return;
      }
    }
    if (this.contraptions.updateDormantServerEntity?.(entity.id, this.dormantMetadata(entity))) return;
    if (this.loading.has(entity.id)) return;

    this.loading.add(entity.id);
    try {
      const [definition, snapshot] = await Promise.all([
        this.client.getDefinition(entity),
        this.client.getSnapshot(entity),
      ]);
      if (this.stopped || this.isStale(entity)) return;
      const parsed = this.controller.parseInventoryImport?.(definition, 'entity');
      if (!parsed?.ok) throw new Error(parsed?.error || 'Server entity failed local validation.');

      const origin = Array.isArray(snapshot?.constructorOrigin)
        ? new THREE.Vector3().fromArray(snapshot.constructorOrigin as number[])
        : new THREE.Vector3(
          entity.position.x_cm / 100,
          entity.position.y_cm / 100,
          entity.position.z_cm / 100,
        );
      const rotation = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        entity.yaw_quarter_turns * Math.PI / 2,
      );
      const restoreState = snapshot ? {
        ...snapshot,
        publicId: entity.id,
        ...this.metadata(entity),
      } : null;
      const created = this.contraptions.buildFromSlot(parsed.item, origin, restoreState, false);
      if (!created) throw new Error('Server entity could not be constructed.');
      // Preserve the current instance until its replacement is ready. Failed
      // or stale downloads must not erase local geometry and unsaved edits.
      if (active) this.contraptions.removeContraption?.(active, { skipSave: true, skipRemoteDelete: true });
      created.publicId = entity.id;
      if (!snapshot) {
        created.position.copy(origin).add(created.localCenter.clone().applyQuaternion(rotation));
        created.quaternion.copy(rotation);
        created.originWorldPos.copy(origin);
      }
      Object.assign(created, this.metadata(entity));
      created.updateTransform();
      this.applyPlayback(created, entity);
      created.serverPlaybackRevision = entity.revision;
    } catch (error) {
      console.warn(`Space entity ${entity.id} could not be loaded.`, error);
    } finally {
      this.loading.delete(entity.id);
    }
  }

  /**
   * Apply a server snapshot-only change to an existing contraption in place.
   * Returns false when the snapshot cannot be fetched/projected, in which case
   * the caller falls back to the remove-and-rebuild path.
   */
  private async applySnapshotInPlace(active: any, entity: SpaceWorldEntityRecord) {
    if (typeof this.contraptions.restoreContraptionStreamingState !== 'function') return false;
    if (active.isWrenchGrabbed || this.controller?.wrenchGrab?.contraption === active) {
      // Never fight an active wrench drag with a remote pose: accept the digest
      // (so the revision is not retried) but keep the locally held transform.
      this.applyRecordMetadata(active, entity);
      return true;
    }
    try {
      const snapshot = await this.client.getSnapshot(entity);
      if (this.stopped || this.isStale(entity)) return true;
      if (!snapshot) return false;
      this.contraptions.restoreContraptionStreamingState(active, {
        ...snapshot,
        ...this.metadata(entity),
      });
      this.applyRecordMetadata(active, entity);
      return true;
    } catch (error) {
      console.warn(`Space entity ${entity.id} snapshot could not be applied in place; rebuilding.`, error);
      return false;
    }
  }

  /** Merge server metadata and re-apply playback only when the revision changed. */
  private applyRecordMetadata(active: any, entity: SpaceWorldEntityRecord) {
    if (this.isStale(entity)) return;
    this.latestRevisions.set(entity.id, entity.revision);
    const revisionChanged = Number(active.serverPlaybackRevision) !== entity.revision;
    const metadata = this.metadata(entity);
    const executionChanged = active.serverExecutesLocally !== metadata.serverExecutesLocally;
    if (active.isWrenchGrabbed || this.controller?.wrenchGrab?.contraption === active || active.serverDesiredRunState === 'stopped') {
      if (entity.desired_run_state !== 'stopped' && Number(active.serverRevision) >= entity.revision) {
        metadata.serverDesiredRunState = 'stopped';
      }
    }
    Object.assign(active, metadata);
    // An entity may stop itself without changing the owner's durable Wrench
    // intent. Re-apply playback only when that intent revision changes.
    if (revisionChanged || executionChanged) {
      this.applyPlayback(active, entity);
      active.serverPlaybackRevision = entity.revision;
    }
  }

  private snapshotPayload(record: any) {
    const snapshot = { ...record };
    delete snapshot.slot;
    delete snapshot.serverManaged;
    delete snapshot.serverExecutionMode;
    delete snapshot.serverHostingEnabled;
    delete snapshot.serverOwnerUserId;
    delete snapshot.serverOwnerName;
    delete snapshot.serverExecutorName;
    delete snapshot.serverExecutionLeaseExpiresAt;
    delete snapshot.serverCanControl;
    delete snapshot.serverCanEdit;
    delete snapshot.serverExecutesLocally;
    delete snapshot.serverRevision;
    delete snapshot.serverPlaybackRevision;
    delete snapshot.serverDesiredRunState;
    delete snapshot.serverDefinitionDigest;
    delete snapshot.serverSnapshotDigest;
    const position = Array.isArray(record.position) ? record.position : [0, 0, 0];
    return {
      snapshot,
      position: {
        x_cm: wrappedCentimetres(Number(position[0]) || 0, wrapX, TORUS_SIZE_X),
        y_cm: Math.round((Number(position[1]) || 0) * 100),
        z_cm: wrappedCentimetres(Number(position[2]) || 0, wrapZ, TORUS_SIZE_Z),
      },
      desired_run_state: record.physicsSimulationEnabled === false ? 'stopped' : 'running',
    } as const;
  }

  private queueKey(publicId: string) {
    return this.localIdByServerId.get(publicId) || publicId;
  }

  private queueSave(record: any, options: { definitionChanged?: boolean } = {}) {
    if (!record?.publicId || !record?.slot) return;
    if (record.serverManaged === true && record.serverCanEdit !== true) return;
    const publicId = String(record.publicId);
    if (record.serverManaged !== true) {
      this.pendingLocalRecords.set(publicId, record);
      if (!this.initialCreateRecords.has(publicId)) this.initialCreateRecords.set(publicId, record);
    }
    const key = this.queueKey(publicId);
    const previous = this.saveChains.get(key) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.persistRecord(record, options.definitionChanged !== false))
      .catch(error => console.warn(`Space entity ${publicId} could not be persisted.`, error));
    this.saveChains.set(key, next);
    void next.finally(() => {
      if (this.saveChains.get(key) === next) this.saveChains.delete(key);
    });
  }

  private async persistRecord(record: any, _definitionChanged: boolean) {
    const originalPublicId = String(record.publicId);
    const serverId = this.entityAliases.get(originalPublicId)
      || (record.serverManaged === true ? originalPublicId : null);

    if (!serverId) {
      // Retries must reuse byte-identical create input. If the first response
      // was lost after commit, changing the body would correctly trip the
      // backend's operation-id reuse guard and could orphan the created row.
      const createRecord = this.initialCreateRecords.get(originalPublicId) || record;
      const payload = this.snapshotPayload(createRecord);
      const snapshotJson = JSON.stringify(payload.snapshot);
      const definition = this.controller.encodeInventoryItem?.('entity', createRecord.slot);
      if (!(definition instanceof Uint8Array)) throw new Error('Entity definition could not be encoded.');
      let createOperationId = this.createOperationIds.get(originalPublicId);
      if (!createOperationId) {
        createOperationId = globalThis.crypto.randomUUID();
        this.createOperationIds.set(originalPublicId, createOperationId);
      }
      const created = await this.client.createBrowser({ ...payload, definition }, createOperationId);
      this.entityAliases.set(originalPublicId, created.id);
      this.localIdByServerId.set(created.id, originalPublicId);
      this.adoptServerIdentity(originalPublicId, created);
      this.initialCreateRecords.delete(originalPublicId);
      this.pendingLocalRecords.delete(originalPublicId);
      this.lastSnapshotJson.set(created.id, snapshotJson);
      return;
    }

    const executing = (this.leasedUntil.get(serverId) || 0) > Date.now();
    // Frozen replicas keep the durable running intent. They must never publish
    // their local stopped pose as an owner/admin checkpoint.
    if (record.serverDesiredRunState === 'running' && !executing) return;
    const payload = this.snapshotPayload(record);
    const snapshotJson = JSON.stringify(payload.snapshot);
    const definition = this.controller.encodeInventoryItem?.('entity', record.slot);
    if (!(definition instanceof Uint8Array)) throw new Error('Entity definition could not be encoded.');
    const active = this.contraptions.findActiveContraptionByPublicId?.(serverId);
    const revision = Number(active?.serverRevision ?? record.serverRevision);
    if (!Number.isSafeInteger(revision) || revision < 1) return;
    const currentDefinitionDigest = active?.serverDefinitionDigest || record.serverDefinitionDigest;
    const definitionDigest = await sha256Hex(definition);
    const sendDefinition = !currentDefinitionDigest || definitionDigest !== currentDefinitionDigest;
    if (record.serverDesiredRunState === 'running' && (this.leasedUntil.get(serverId) || 0) <= Date.now()) return;
    if (!sendDefinition && this.lastSnapshotJson.get(serverId) === snapshotJson) return;
    let updated: SpaceWorldEntityRecord;
    try {
      updated = await this.client.checkpointBrowser(serverId, revision, {
        ...payload,
        ...(executing ? { execution_instance_id: this.instanceId, execution_epoch: this.executionEpochs.get(serverId) } : {}),
        ...(sendDefinition ? { definition } : {}),
      });
    } catch (error: any) {
      if (error?.code === 'ENTITY_REVISION_CONFLICT' && error?.detail?.current) {
        await this.applyRecord(error.detail.current as SpaceWorldEntityRecord);
        return;
      }
      throw error;
    }
    this.applyServerMetadata(serverId, updated);
    this.lastSnapshotJson.set(serverId, snapshotJson);
  }

  private adoptServerIdentity(localPublicId: string, entity: SpaceWorldEntityRecord) {
    this.latestRevisions.set(entity.id, entity.revision);
    const active = this.contraptions.findActiveContraptionByPublicId?.(localPublicId);
    if (active) {
      active.publicId = entity.id;
      Object.assign(active, this.metadata(entity));
      this.enforceExecutionLeases();
      return;
    }
    for (const records of this.contraptions.dormantContraptions?.values?.() || []) {
      const record = records.get(localPublicId);
      if (!record) continue;
      records.delete(localPublicId);
      record.publicId = entity.id;
      Object.assign(record, this.dormantMetadata(entity));
      records.set(entity.id, record);
      return;
    }
  }

  private applyServerMetadata(entityId: string, entity: SpaceWorldEntityRecord) {
    if (this.isStale(entity)) return;
    this.latestRevisions.set(entityId, entity.revision);
    const active = this.contraptions.findActiveContraptionByPublicId?.(entityId);
    if (active) Object.assign(active, this.metadata(entity));
    else this.contraptions.updateDormantServerEntity?.(entityId, this.dormantMetadata(entity));
  }

  private queueDelete(publicId: string, reportErrors = false) {
    const id = String(publicId || '');
    if (!id) return;
    const key = this.queueKey(id);
    const previous = this.saveChains.get(key) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (!this.entityAliases.has(id) && id.startsWith('ent_')) {
          const pendingRecord = this.pendingLocalRecords.get(id);
          if (pendingRecord) await this.persistRecord(pendingRecord, true);
        }
        const serverId = this.entityAliases.get(id) || (id.startsWith('ent_') ? null : id);
        if (!serverId) return;
        this.pendingDeletes.add(serverId);
        try {
          try {
            await this.client.delete(serverId);
          } catch (error: any) {
            if (error?.status !== 404) throw error;
          }
          this.deletedEntityIds.add(serverId);
        } finally {
          this.pendingDeletes.delete(serverId);
        }
        this.previousAoiIds.delete(serverId);
        this.lastAoiRecords.delete(serverId);
        this.retainedOutsideAoi.delete(serverId);
        this.lastSnapshotJson.delete(serverId);
        const localId = this.localIdByServerId.get(serverId) || id;
        this.localIdByServerId.delete(serverId);
        this.entityAliases.delete(localId);
        this.createOperationIds.delete(localId);
        this.initialCreateRecords.delete(localId);
        this.pendingLocalRecords.delete(localId);
      })
      .catch(error => {
        if (reportErrors) throw error;
        console.warn(`Space entity ${id} could not be deleted.`, error);
      });
    this.saveChains.set(key, next);
    return next;
  }

  private removeEntitiesOutsideAoi(currentIds: Set<string>, position: { x: number; z: number }, aoiRadius: number) {
    const candidates = new Set([...this.previousAoiIds, ...this.retainedOutsideAoi.keys()]);
    const impostorDistance = Math.max(0, Number(this.getEntityImpostorDistance()) || 0);
    for (const entityId of candidates) {
      if (currentIds.has(entityId)) continue;
      const active = this.contraptions.findActiveContraptionByPublicId?.(entityId);
      const record = this.lastAoiRecords.get(entityId) || this.retainedOutsideAoi.get(entityId);
      const distance = record ? Math.hypot(
        unwrapPeriodicNear(record.position.x_cm / 100, position.x, TORUS_SIZE_X) - position.x,
        unwrapPeriodicNear(record.position.z_cm / 100, position.z, TORUS_SIZE_Z) - position.z,
      ) : Infinity;
      // AOI absence only proves deletion while the old location is inside
      // this complete query. Keep bounded metadata for the independent render
      // cache outside it, freeing all full entity/physics data below. Cache up
      // to the supported maximum so shrinking then expanding the view slider
      // can reuse a baked plane without reloading the original construction.
      if (record && impostorDistance > 0 && distance > aoiRadius
        && distance <= ENTITY_IMPOSTOR_SETTING_LIMITS.maxDistance.max) {
        this.retainedOutsideAoi.set(entityId, record);
        while (this.retainedOutsideAoi.size > 128) {
          this.retainedOutsideAoi.delete(this.retainedOutsideAoi.keys().next().value!);
        }
      } else this.retainedOutsideAoi.delete(entityId);
      this.leasedUntil.delete(entityId);
      if (active?.serverManaged === true) {
        this.contraptions.removeContraption?.(active, {
          skipSave: true,
          skipRemoteDelete: true,
        });
      } else {
        this.contraptions.deleteDormantContraption?.(entityId);
      }
    }
  }

  private async setRunState(contraption: any, desiredState: SpaceEntityRunState) {
    const updated = await this.client.setRunState(
      String(contraption.publicId),
      desiredState,
      Number(contraption.serverRevision),
    );
    // A failed request must leave the current intent and valid execution lease
    // untouched. A delayed old Stop must not revoke a newer Start's lease.
    if (this.isStale(updated)) return updated;
    if (updated.desired_run_state === 'running' && updated.owner_user_id === this.currentUserId) {
      const requestedAt = Date.now();
      const leases = await this.client.claimExecutionLeases(this.instanceId, [updated.id]);
      this.acceptLeases(leases, requestedAt);
    } else {
      this.leasedUntil.delete(updated.id);
    }
    if (this.isStale(updated)) return updated;
    this.latestRevisions.set(updated.id, updated.revision);
    Object.assign(contraption, this.metadata(updated));
    if (!contraption.isWrenchGrabbed && this.controller?.wrenchGrab?.contraption !== contraption) {
      this.applyPlayback(contraption, updated);
    }
    contraption.serverPlaybackRevision = updated.revision;
    return updated;
  }
}
