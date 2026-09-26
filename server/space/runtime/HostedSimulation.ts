import { MICRO_DIVISIONS, MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import {
  THREE, World, ContraptionManager, ContraptionPhysics,
  portableEntityToRuntime, runtimeEntityToPortable, decodeInventoryResource, encodeInventoryResource,
  preloadQuickJSScriptRuntime,
  wrapX, wrapZ, wrapChunkX, wrapChunkZ, unwrapPeriodicNear, TORUS_SIZE_X, TORUS_SIZE_Z,
} from '@entropydrop/space-engine';

/** A bounded transaction candidate. No guest can access IPC, credentials or storage. */
export class HostedSimulation {
  world: World;
  scene = new THREE.Scene();
  revisions = new Map<string, number>();
  dirty = new Set<string>();
  allowed = new Set<string>();
  mutations: any[] = [];
  outboundMessages: any[] = [];
  actor: string | null = null;

  inBounds(c: any, anchor: number[]) {
    const box = new THREE.Box3();
    for (const block of c.blocks) {
      c.getBlockWorldBounds(block, box);
      for (const point of [box.min, box.max]) {
        const x = unwrapPeriodicNear(point.x, anchor[0], TORUS_SIZE_X);
        const z = unwrapPeriodicNear(point.z, anchor[1], TORUS_SIZE_Z);
        if (![x, point.y, z].every(Number.isFinite) || Math.abs(x - anchor[0]) > 32
          || Math.abs(z - anchor[1]) > 32 || point.y < 0 || point.y > 256) return false;
      }
    }
    return true;
  }

  constructor(seed: number, terrainGeneratorVersion = 1) {
    this.world = new World(this.scene, seed, null, terrainGeneratorVersion, true);
    // No renderer, browser, terrain mesh builds or local-storage timers are started.
    const originalCreate = this.world.getOrCreateChunk.bind(this.world);
    this.world.getOrCreateChunk = (cx, cz) => {
      if (!this.allowed.has(`${wrapChunkX(cx)},${wrapChunkZ(cz)}`)) throw new Error('hosting_area_limit');
      return originalCreate(cx, cz);
    };
  }

  record(mutation: any) {
    if (!this.actor) throw new Error('hosting_actor_required');
    if (this.mutations.length >= 256) throw new Error('hosting_edit_budget');
    const x = mutation.x ?? Math.floor(mutation.mx / MICRO_DIVISIONS);
    const z = mutation.z ?? Math.floor(mutation.mz / MICRO_DIVISIONS);
    const key = `${Math.floor(wrapX(x) / 16)},${Math.floor(wrapZ(z) / 16)}`;
    if (!this.allowed.has(key)) throw new Error('hosting_area_limit');
    this.dirty.add(key);
    this.mutations.push({ ...mutation, actor_entity_id: this.actor });
  }

  queueEntityMessage(sourceId: string, targetId: string, messageType: string,
    payload: string | number[], encoding: 'utf8' | 'protobuf', command: any) {
    if (!this.actor || this.actor !== sourceId) return { ok: false, reason: 'source_inactive' };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId)) {
      return { ok: false, reason: 'invalid_target_id' };
    }
    if (!/^[a-z][a-z0-9._-]{0,15}$/.test(messageType)) return { ok: false, reason: 'invalid_message_type' };
    if (encoding !== 'utf8' && encoding !== 'protobuf') return { ok: false, reason: 'invalid_encoding' };
    if (messageType === 'chat' && encoding !== 'utf8') return { ok: false, reason: 'chat_requires_utf8' };
    if (encoding === 'protobuf' && !/\.v[1-9][0-9]*$/.test(messageType)) {
      return { ok: false, reason: 'protobuf_type_requires_version' };
    }
    let body: string | number[];
    if (encoding === 'utf8') {
      if (typeof payload !== 'string') return { ok: false, reason: 'invalid_payload' };
      if (new TextEncoder().encode(payload).byteLength > 4096) return { ok: false, reason: 'payload_too_large' };
      body = payload;
    } else {
      if (!Array.isArray(payload) || payload.length > 4096
        || payload.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
        return { ok: false, reason: 'invalid_payload' };
      }
      body = payload.slice();
    }
    if (this.outboundMessages.length >= 20) return { ok: false, reason: 'message_batch_limit' };
    this.outboundMessages.push({
      sourceId, targetId, type: messageType, encoding, payload: body,
      commandId: String(command?.commandId || ''), nodeId: String(command?.nodeId || ''),
    });
    return { ok: true, queued: 1, pending: true, reason: 'queued' };
  }

  async step(input: any) {
    await preloadQuickJSScriptRuntime();
    if (!Number.isInteger(input.steps) || input.steps < 1 || input.steps > 20
      || input.entities.length > 36 || input.chunks.length > 196) throw new Error('hosting_request_limit');
    this.world.editPersistence = null;
    this.allowed = new Set(input.chunks.map(c => `${c.chunk_x},${c.chunk_z}`));
    this.mutations = [];
    this.outboundMessages = [];
    for (const key of this.world.chunks.keys()) {
      if (!this.allowed.has(key)) {
        const [cx, cz] = key.split(',').map(Number);
        this.world.microVoxels.clearChunk(cx, cz);
        this.world.chunks.delete(key);
        this.revisions.delete(key);
      }
    }
    for (const chunk of input.chunks) {
      const key = `${chunk.chunk_x},${chunk.chunk_z}`;
      if (this.revisions.get(key) === chunk.revision && !this.dirty.has(key)) continue;
      this.world.chunks.delete(key);
      this.world.microVoxels.clearChunk(chunk.chunk_x, chunk.chunk_z);
      const loaded = this.world.getOrCreateChunk(chunk.chunk_x, chunk.chunk_z);
      const standardEdits = chunk.standard.map(([x, y, z, block, color, material = 0]) => ({
        x, y, z, block, color, material,
      }));
      const microEdits = chunk.micro.map(([mx, my, mz, color, part, material = 0]) => ({
        mx, my, mz, color, part, material,
      }));
      for (const edit of standardEdits) {
        // Every explicit standard edit, including AIR, suppresses generated
        // micro terrain in its parent cell.
        this.world.microVoxels.clearStandardCell(edit.x, edit.y, edit.z);
        loaded.setLocalBlock(edit.x % 16, edit.y, edit.z % 16, edit.block, edit.color, edit.material);
      }
      for (const edit of microEdits) {
        if (loaded.getLocalBlock(
          Math.floor(edit.mx / MICRO_DIVISIONS) % 16,
          Math.floor(edit.my / MICRO_DIVISIONS),
          Math.floor(edit.mz / MICRO_DIVISIONS) % 16,
        ) === 0) {
          this.world.microVoxels.set(
            edit.mx, edit.my, edit.mz, edit.color, edit.part, edit.material,
          );
        }
      }
      this.revisions.set(key, chunk.revision);
    }
    this.dirty.clear();
    // Persistence hooks collect validated engine edits; Python commits them with snapshots and billing.
    this.world.editPersistence = {
      recordStandard: (x, y, z, block, color, material = 0) => this.record({ kind: 'set_standard', x: wrapX(x), y, z: wrapZ(z), block, color, material }),
      recordMicro: (mx, my, mz, color, part, material = 0) => this.record({ kind: 'set_micro', mx, my, mz, color, part, material }),
      removeMicro: (mx, my, mz) => this.record({ kind: 'remove_micro', mx, my, mz }),
      removeMicroStandardCell: (x, y, z) => this.record({ kind: 'clear_micro_cell', x: wrapX(x), y, z: wrapZ(z) }),
      canAcceptLocalMutation: () => this.mutations.length < 256,
    } as any;
    const manager = new ContraptionManager(this.scene, this.world, null, null);
    manager.setPhysics(new ContraptionPhysics(this.world));
    manager.entityPersistenceMode = 'remote';
    manager.setRuntimeContextProvider(() => ({
      messages: {
        send: (sourceId: string, targetId: string, messageType: string,
          payload: string | number[], encoding: 'utf8' | 'protobuf', command: any) => (
          this.queueEntityMessage(sourceId, targetId, messageType, payload, encoding, command)
        ),
      },
    }));
    // Entity creation/assembly and player selection are outside the hosted base tier.
    manager.scriptSelectionApi = Object.freeze({});
    manager.syncContraptionsToLoadedChunks = () => {};
    const hosted = new Map<string, any>();
    const faults: any[] = [];
    try {
      for (const item of input.entities) {
        const portable = decodeInventoryResource(Buffer.from(item.definition_base64, 'base64'), 'entity').portable;
        const slot = portableEntityToRuntime(portable);
        slot.blocks = slot.blocks.map(b => ({ ...b,
          localX: b.dx + (b.mx ?? 0) / MICRO_DIVISIONS, localY: b.dy + (b.my ?? 0) / MICRO_DIVISIONS,
          localZ: b.dz + (b.mz ?? 0) / MICRO_DIVISIONS, size: b.mx == null ? 1 : MICRO_SIZE }));
        const origin = new THREE.Vector3().fromArray(item.snapshot?.constructorOrigin || item.position);
        const c = manager.buildFromSlot(slot, origin, item.snapshot ? { ...item.snapshot, serverManaged: false } : null, false);
        if (!c) throw new Error('hosting_invalid_entity');
        c.publicId = item.id;
        if (Array.isArray(item.messages)) {
          for (const message of item.messages.slice(0, 64)) c.enqueueEntityMessage?.(message);
        }
        if (Array.isArray(item.message_results)) {
          c.pendingScriptCommandResults.push(...item.message_results.slice(0, 256));
          if (c.pendingScriptCommandResults.length > 256) {
            c.pendingScriptCommandResults.splice(0, c.pendingScriptCommandResults.length - 256);
          }
        }
        if (!item.snapshot) {
          const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), item.yaw_quarter_turns * Math.PI / 2);
          c.position.copy(origin).add(c.localCenter.clone().applyQuaternion(rotation));
          c.quaternion.copy(rotation);
          c.updateTransform();
        }
        if (item.running) {
          c.physicsSimulationEnabled = true;
          if (c.scriptStatus !== 'error') c.scriptStatus = 'running';
          const priorMessageResultIds = new Set(
            (Array.isArray(item.message_results) ? item.message_results : [])
              .map((result: any) => String(result?.commandId || ''))
              .filter(Boolean),
          );
          const runtime = { c, item, elapsed: 0, poses: [] as any[], priorMessageResultIds };
          hosted.set(item.id, runtime);
          const update = c.update.bind(c);
          c.update = (...args) => {
            this.actor = item.id;
            if (c.isPhysicsSimulationEnabled()) runtime.elapsed += 50;
            try { return update(...args); } finally { this.actor = null; }
          };
          if (!this.inBounds(c, item.anchor)) faults.push({ id: item.id, reason: 'hosting_area_limit' });
        } else {
          c.scriptStatus = 'stopped';
          c.setPhysicsSimulationEnabled(false);
        }
      }
      if (faults.length) return { faults };
      for (let step = 0; step < input.steps; step++) {
        manager.update(0.05, null);
        for (const [id, { c, item, poses }] of hosted) {
          let reason = c.scriptStatus === 'error' ? 'script_error' : null;
          const x = unwrapPeriodicNear(c.position.x, item.anchor[0], TORUS_SIZE_X);
          const z = unwrapPeriodicNear(c.position.z, item.anchor[1], TORUS_SIZE_Z);
          if (!this.inBounds(c, item.anchor) || Math.abs(x - item.anchor[0]) > 32 || Math.abs(z - item.anchor[1]) > 32
            || c.position.y < 0 || c.position.y > 255 || !manager.contraptions.includes(c)) reason = 'hosting_area_limit';
          if (c.blocks.length > 512 || c.entityNodes.size > 8) reason = 'hosting_entity_limit';
          if (reason) faults.push({ id, reason, message: String(c.scriptError || reason).slice(0, 500) });
          poses.push([...c.rigidBodies.values()].sort((a: any, b: any) =>
            Number(b.id === c.rootComponentId) - Number(a.id === c.rootComponentId)).map((body: any) => ({
            id: body.id, position: body.position.toArray(), quaternion: body.quaternion.toArray(),
            velocity: body.velocity.toArray(), angularVelocity: body.angularVelocity.toArray(),
            collisionEnabled: c.getNodeCollisionEnabled(body.id),
          })));
        }
        if (faults.length) return { faults }; // discard the entire candidate, including world edits
      }
      const results = [...hosted].map(([id, { c, elapsed, poses, priorMessageResultIds }]) => {
        const snapshot: any = manager.captureContraptionForStreaming(c, manager.getContraptionChunk(c));
        const slot = snapshot.slot;
        slot.blocks = slot.blocks.map(b => {
          const dx = Math.floor(b.localX), dy = Math.floor(b.localY), dz = Math.floor(b.localZ);
          return { ...b, dx, dy, dz, ...(b.size < 1 ? {
            mx: Math.round((b.localX - dx) * MICRO_DIVISIONS), my: Math.round((b.localY - dy) * MICRO_DIVISIONS),
            mz: Math.round((b.localZ - dz) * MICRO_DIVISIONS),
          } : {}) };
        });
        const definition = encodeInventoryResource('entity', runtimeEntityToPortable(slot));
        delete snapshot.slot;
        for (const key of Object.keys(snapshot)) if (key.startsWith('server')) delete snapshot[key];
        const messageResults = c.pendingScriptCommandResults
          .filter((receipt: any) => receipt?.scope === 'messages'
            && !priorMessageResultIds.has(String(receipt.commandId || '')));
        return { id, snapshot, definition_base64: Buffer.from(definition).toString('base64'),
          stopped: !c.isPhysicsSimulationEnabled(), elapsed_ms: elapsed, poses,
          consumed_message_count: c.consumedEntityMessageCount,
          message_results: messageResults };
      });
      return { entities: results, mutations: this.mutations, messages: this.outboundMessages, faults: [] };
    } finally {
      for (const c of [...manager.contraptions]) manager.removeContraption(c, { skipSave: true, skipRemoteDelete: true });
      this.world.dirtyChunks.clear();
      this.world.editPersistence = null;
    }
  }
}
