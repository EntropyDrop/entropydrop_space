import type { World } from '../voxel/World.ts';
import type { Chunk } from '../voxel/Chunk.ts';
import type { ContraptionPhysics } from '../physics/ContraptionPhysics.ts';
import type { CollisionBounds } from '../physics/CollisionGeometry.ts';
import type { ContraptionScene, ContraptionOptions, RuntimeVoxel } from './EntityTypes.ts';
import type { InventoryInput } from '../storage/InventoryTypes.ts';
import type { ScriptInputState, ScriptRuntimeContext, ScriptPlayer } from '../scripting/ScriptProtocol.ts';

interface SelectionPoint { x: number; y: number; z: number; micro?: boolean }
interface EntityChunk { id: string; cx: number; cz: number }
interface ChildSelection { contraption: Contraption; parentId: string; mode: string; cells: Set<string> }
interface EntitySound {
  playAssemblyClack(): unknown; playDisassemblySound(): unknown; playGlueApply(): unknown;
  playSteamHiss(): unknown; playWrenchClick(): unknown;
}
interface EntityParticles { emitSteamPuff(position: THREE.Vector3, count: number): unknown }
interface EntityPersistence { save?(record: EntityStreamState, options: { definitionChanged: boolean }): unknown; remove?(publicId: string): unknown }
type RuntimeContextProvider = () => ScriptRuntimeContext;

import { createWorldScriptCapabilities } from './WorldScriptApi.ts';
import { captureEntityStreamState, restoreEntityStreamState, type EntityStreamState } from './EntityStreaming.ts';
import { readRecord } from './EntityInput.ts';
import { MICRO_DIVISIONS, MICRO_SIZE } from '../voxel/MicroGrid.ts';
import * as THREE from 'three';
import {
  BodyType,
  Contraption,
  ContraptionMode,
  MAX_ENTITY_BOUNDS,
  createEntityPublicId,
  isValidComponentId
} from './Contraption.ts';
import { BlockTypes } from '../voxel/BlockTypes.ts';
import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from '../voxel/Chunk.ts';
import {
  TORUS_SIZE_X,
  TORUS_SIZE_Z,
  unwrapPeriodicNear,
  wrapX,
  wrapZ,
  wrapChunkX,
  wrapChunkZ,
  wrapMicroX,
  wrapMicroZ
} from '../torus/TorusWorld.ts';
import { ActionDomain, executeBasicAction } from '../actions/BasicActions.ts';
import type { SpaceStorage } from '../storage/SpaceStorage.ts';

export const ENTITY_STORAGE_PREFIX = 'entropydrop_space_entities';
export const ENTITY_STORAGE_VERSION = 4;

export function worldEntitiesStorageKey(worldId: string) {
  return `${ENTITY_STORAGE_PREFIX}.${encodeURIComponent(worldId || 'default')}`;
}

export class ContraptionManager {
  declare scene: ContraptionScene;
  declare world: World | null;
  declare sound: EntitySound | null;
  declare particles: EntityParticles | null;
  declare contraptions: Contraption[];
  /** Serialized, non-running entities grouped by their wrapped chunk id. */
  declare dormantContraptions: Map<string, Map<string, EntityStreamState>>;
  declare lastEntityChunkWindow: Set<string> | null;
  declare nextId: number;
  declare selectionCornerA: SelectionPoint | null;
  declare selectionCornerB: SelectionPoint | null;
  declare selectionBoxConfirmed: boolean;
  declare gluePoints: SelectionPoint[];
  declare connectedSelection: SelectionPoint[] | null;
  declare microSelection: SelectionPoint[] | null;
  declare microBounds: CollisionBounds | null;
  declare childSelection: ChildSelection | null;
  declare activeDrivable: Contraption | null;
  declare activeProgrammingContraption: Contraption | null;
  declare physics: ContraptionPhysics | null;
  declare runtimeContextProvider: RuntimeContextProvider | null;
  declare scriptWorldApi: ReturnType<typeof createWorldScriptCapabilities>['world'];
  declare scriptSelectionApi: Partial<ReturnType<typeof createWorldScriptCapabilities>['selection']>;
  declare entitySelection: any;
  declare selectionHost: any;
  declare worldId: string;
  declare worldSlug: string;
  declare worldName: string;
  declare lastEntitySaveTime: number;
  declare persistentStorage: SpaceStorage | null;
  declare entityPersistenceMode: 'browser' | 'remote' | 'none';
  declare remoteEntityPersistence: EntityPersistence | null;

  constructor(scene: ContraptionScene, world: World | null, soundManager: EntitySound | null, particleSystem: EntityParticles | null, persistentStorage: SpaceStorage | null = null) {
    this.scene = scene;
    this.world = world;
    this.sound = soundManager;
    this.particles = particleSystem;

    this.contraptions = [];
    this.dormantContraptions = new Map();
    this.lastEntityChunkWindow = null;
    this.nextId = 1;
    this.worldId = 'default';
    this.worldSlug = '';
    this.worldName = '';
    this.lastEntitySaveTime = 0;
    this.persistentStorage = persistentStorage;
    this.entityPersistenceMode = 'browser';
    this.remoteEntityPersistence = null;

    // Selection State
    this.selectionCornerA = null;
    this.selectionCornerB = null;
    this.selectionBoxConfirmed = false;
    this.gluePoints = []; // World Super Glue box mode: three points.
    this.connectedSelection = null; // World single mode: explicit cells, or null in box mode.
    this.microSelection = null; // World micro single mode: explicit 0.125 m cells, or null in standard mode.
    this.microBounds = null; // Bounding box for confirmed micro selection.
    this.childSelection = null; // { contraption, parentId, mode, points, cells }
    this.entitySelection = null; // Shared entity subtree/block selection used by mouse and scripts.
    this.selectionHost = null; // Player-side selector state invalidated by shared runtime actions.

    // Active controlled or driven contraption
    this.activeDrivable = null;
    this.activeProgrammingContraption = null;

    // Physics Engine for Contraptions
    this.physics = null;
    this.runtimeContextProvider = null;

    const capabilities = createWorldScriptCapabilities(this);
    this.scriptWorldApi = capabilities.world;
    this.scriptSelectionApi = capabilities.selection;
  }

  normalizeChunkId(input: unknown): EntityChunk | null {
    const value = input;
    let cx;
    let cz;
    if (typeof value === 'string') {
      const match = value.trim().match(/^(-?\d+)\s*,\s*(-?\d+)$/);
      if (!match) return null;
      cx = Number(match[1]);
      cz = Number(match[2]);
    } else if (Array.isArray(value) && value.length >= 2) {
      cx = Number(value[0]);
      cz = Number(value[1]);
    } else if (value && typeof value === 'object') {
      const record = readRecord(value);
      if (record.id !== undefined && (record.cx === undefined || record.cz === undefined)) {
        return this.normalizeChunkId(record.id);
      }
      cx = Number(record.cx);
      cz = Number(record.cz);
    } else {
      return null;
    }
    if (!Number.isInteger(cx) || !Number.isInteger(cz)) return null;
    const wrappedCx = wrapChunkX(cx);
    const wrappedCz = wrapChunkZ(cz);
    return Object.freeze({ id: `${wrappedCx},${wrappedCz}`, cx: wrappedCx, cz: wrappedCz });
  }

  getContraptionChunk(contraption: Contraption) {
    if (!contraption?.position) return null;
    const worldCoords = this.world?.worldToChunkCoords?.(contraption.position.x, contraption.position.z);
    return this.normalizeChunkId(worldCoords
      ? [worldCoords.cx, worldCoords.cz]
      : [
          Math.floor(contraption.position.x / CHUNK_SIZE_X),
          Math.floor(contraption.position.z / CHUNK_SIZE_Z)
        ]);
  }

  hasEntityStreamingWindow() {
    return this.world?.activeChunkKeys instanceof Set && this.world.activeChunkKeys.size > 0;
  }

  isEntityChunkLoaded(chunkId: unknown) {
    if (!this.hasEntityStreamingWindow()) return true;
    const normalized = this.normalizeChunkId(chunkId);
    return !!normalized && !!this.world?.activeChunkKeys.has(normalized.id);
  }

  getDormantContraptionCount() {
    let count = 0;
    for (const records of this.dormantContraptions.values()) count += records.size;
    return count;
  }

  hasDormantPublicId(publicId: unknown) {
    for (const records of this.dormantContraptions.values()) {
      if (records.has(String(publicId))) return true;
    }
    return false;
  }

  findActiveContraptionByPublicId(publicId: unknown) {
    const id = String(publicId || '');
    return this.contraptions.find(contraption => String(contraption.publicId) === id) || null;
  }

  updateDormantServerEntity(publicId: unknown, metadata: EntityStreamState) {
    const id = String(publicId || '');
    for (const [chunkId, records] of this.dormantContraptions) {
      const record = records.get(id);
      if (!record) continue;
      const contentChanged = record.serverDefinitionDigest !== metadata.serverDefinitionDigest
        || record.serverSnapshotDigest !== metadata.serverSnapshotDigest;
      if (contentChanged) {
        records.delete(id);
        if (records.size === 0) this.dormantContraptions.delete(chunkId);
        return false;
      }
      const playbackChanged = Number(record.serverRevision) !== Number(metadata.serverRevision)
        || record.serverExecutesLocally !== metadata.serverExecutesLocally;
      Object.assign(record, metadata);
      if (playbackChanged) record.serverPlaybackRevision = 0;
      return true;
    }
    return false;
  }

  captureContraptionForStreaming(contraption: Contraption, chunk: { id: string }) {
    return captureEntityStreamState(contraption, chunk);
  }

  storeDormantContraption(record: EntityStreamState) {
    if (!record?.chunkId || !record?.publicId) return;
    let records = this.dormantContraptions.get(record.chunkId);
    if (!records) {
      records = new Map();
      this.dormantContraptions.set(record.chunkId, records);
    }
    records.set(String(record.publicId), record);
  }

  deleteDormantContraption(publicId: unknown) {
    const id = String(publicId || '');
    for (const [chunkId, records] of this.dormantContraptions) {
      if (!records.delete(id)) continue;
      if (records.size === 0) this.dormantContraptions.delete(chunkId);
      return true;
    }
    return false;
  }

  unloadContraption(contraption: Contraption) {
    const chunk = this.getContraptionChunk(contraption);
    if (!chunk) return false;
    const record = this.captureContraptionForStreaming(contraption, chunk);
    if (!record) return false;
    this.storeDormantContraption(record);
    this.removeContraption(contraption, { preserveDormant: true });
    return true;
  }

  restoreContraptionStreamingState(contraption: Contraption, record: EntityStreamState) {
    restoreEntityStreamState(contraption, record);
  }

  restoreDormantContraption(record: EntityStreamState) {
    const origin = new THREE.Vector3().fromArray(record.constructorOrigin || [0, 0, 0]);
    return this.buildFromSlot(record.slot, origin, record);
  }

  syncContraptionsToLoadedChunks() {
    if (!this.hasEntityStreamingWindow()) {
      this.lastEntityChunkWindow = null;
      return;
    }

    const activeWindow = this.world?.activeChunkKeys;
    if (!activeWindow) return;
    if (activeWindow !== this.lastEntityChunkWindow) {
      this.lastEntityChunkWindow = activeWindow;
      for (const chunkId of activeWindow) {
        const records = this.dormantContraptions.get(chunkId);
        if (!records) continue;
        this.dormantContraptions.delete(chunkId);
        for (const record of records.values()) {
          try {
            const restored = this.restoreDormantContraption(record);
            if (!restored) this.storeDormantContraption(record);
          } catch (error) {
            this.storeDormantContraption(record);
            console.warn('Entity chunk restore failed:', error);
          }
        }
      }
    }

    for (let index = this.contraptions.length - 1; index >= 0; index--) {
      const contraption = this.contraptions[index];
      const chunk = this.getContraptionChunk(contraption);
      if (chunk && !activeWindow.has(chunk.id)) this.unloadContraption(contraption);
    }
  }

  describeContraption(contraption: Contraption, distance: number | null = null) {
    const chunk = this.getContraptionChunk(contraption);
    const descriptor = {
      ...(distance === null ? {} : { distance }),
      id: contraption.publicId,
      runtimeId: contraption.id,
      chunkId: chunk?.id || null,
      position: Object.freeze([
        contraption.position.x,
        contraption.position.y,
        contraption.position.z
      ]),
      rotation: Object.freeze(contraption.quaternion.toArray()),
      velocity: Object.freeze(contraption.velocity.toArray()),
      angularVelocity: Object.freeze(contraption.angularVelocity.toArray()),
      mass: contraption.mass,
      bounds: Object.freeze({
        min: Object.freeze(contraption.minLocal.toArray()),
        max: Object.freeze(contraption.maxLocal.toArray()),
        size: Object.freeze(contraption.size.toArray()),
        center: Object.freeze(contraption.localCenter.toArray())
      }),
      boundingRadius: contraption.boundingRadius,
      bodyType: contraption.bodyType,
      collisionEnabled: contraption.collisionEnabled !== false,
      physicsEnabled: contraption.isPhysicsSimulationEnabled?.() !== false,
      isOnGround: contraption.isOnGround === true,
      groundDistance: contraption.groundDistance,
      scriptStatus: contraption.scriptStatus,
      componentCount: contraption.entityNodes?.size || 0
    };
    return Object.freeze(descriptor);
  }

  getNearbyEntityDescriptors(origin: unknown, radius = 16) {
    if (!Array.isArray(origin) || origin.length < 3) return Object.freeze([]);
    const ox = Number(origin[0]) || 0;
    const oy = Number(origin[1]) || 0;
    const oz = Number(origin[2]) || 0;
    const r = Math.max(0, Number(radius) || 0);
    const result = [];
    for (const contraption of this.contraptions) {
      const dx = ((contraption.position.x - ox) % TORUS_SIZE_X
        + TORUS_SIZE_X + TORUS_SIZE_X / 2) % TORUS_SIZE_X - TORUS_SIZE_X / 2;
      const dy = contraption.position.y - oy;
      const dz = ((contraption.position.z - oz) % TORUS_SIZE_Z
        + TORUS_SIZE_Z + TORUS_SIZE_Z / 2) % TORUS_SIZE_Z - TORUS_SIZE_Z / 2;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance <= r) result.push(this.describeContraption(contraption, distance));
    }
    result.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    return Object.freeze(result);
  }

  getEntityDescriptorById(entityId: unknown, chunkId: unknown = null) {
    if (entityId === undefined || entityId === null) return null;
    const contraption = this.contraptions.find(item => (
      String(item.publicId) === String(entityId) || String(item.id) === String(entityId)
    ));
    if (!contraption) return null;
    if (chunkId !== null && chunkId !== undefined) {
      const expected = this.normalizeChunkId(chunkId);
      if (!expected || this.getContraptionChunk(contraption)?.id !== expected.id) return null;
    }
    return this.describeContraption(contraption);
  }

  getEntityDescriptorsInChunk(chunkId: unknown) {
    const target = this.normalizeChunkId(chunkId);
    if (!target) return Object.freeze([]);
    const result = this.contraptions
      .filter(contraption => this.getContraptionChunk(contraption)?.id === target.id)
      .map(contraption => this.describeContraption(contraption))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return Object.freeze(result);
  }

  /** Dispatch a canonical engine action from UI, mouse input, scripts or systems. */
  performBasicAction<C extends import('../actions/ActionContracts.ts').BasicActionCommand>(command: C) {
    return executeBasicAction({ manager: this, world: this.world, selectionHost: this.selectionHost }, command);
  }

  /** Register an entity and bind its self.* API to this same command context. */
  registerContraption(contraption: Contraption) {
    if (!contraption) return null;
    const runtimeId = Number(contraption.id);
    if (Number.isFinite(runtimeId)) this.nextId = Math.max(this.nextId, runtimeId + 1);
    while (!contraption.publicId || this.contraptions.some(item => (
      item !== contraption && item.publicId === contraption.publicId
    )) || this.hasDormantPublicId(contraption.publicId)) {
      contraption.publicId = createEntityPublicId();
    }
    contraption.setActionContext?.({ manager: this, world: this.world });
    if (!this.contraptions.includes(contraption)) this.contraptions.push(contraption);
    return contraption;
  }

  setPhysics(physics: ContraptionPhysics | null) {
    this.physics = physics;
  }

  setRuntimeContextProvider(provider: RuntimeContextProvider | null) {
    this.runtimeContextProvider = typeof provider === 'function' ? provider : null;
  }

  setWorldId(worldId: string) {
    if (this.worldId !== String(worldId || 'default')) {
      this.worldSlug = '';
      this.worldName = '';
    }
    this.worldId = String(worldId || 'default');
  }

  setWorldIdentity(world: { id: string; slug?: string | null; name?: string }) {
    this.setWorldId(world.id);
    this.worldSlug = String(world.slug || '');
    this.worldName = String(world.name || '');
  }

  getWorldInfo() {
    return Object.freeze({
      id: this.worldId, slug: this.worldSlug, name: this.worldName,
      seed: this.world?.terrainGen?.seed ?? 0,
      terrainGeneratorVersion: this.world?.terrainGen?.version ?? 1,
      width: TORUS_SIZE_X, height: CHUNK_SIZE_Y, length: TORUS_SIZE_Z,
    });
  }

  /** Select browser persistence for offline worlds, backend persistence online, or none to disable persistence. */
  setEntityPersistenceMode(mode: 'browser' | 'remote' | 'none', adapter: EntityPersistence | null = null) {
    this.entityPersistenceMode = mode === 'remote' ? 'remote' : (mode === 'none' ? 'none' : 'browser');
    this.remoteEntityPersistence = this.entityPersistenceMode === 'remote' ? adapter : null;
    if (this.entityPersistenceMode === 'remote' || this.entityPersistenceMode === 'none') {
      this.purgeBrowserEntityStorage();
    }
  }

  setRemoteEntityPersistence(adapter: EntityPersistence | null) {
    this.entityPersistenceMode = 'remote';
    this.remoteEntityPersistence = adapter || null;
    this.purgeBrowserEntityStorage();
  }

  purgeBrowserEntityStorage(storage = this.entityStorage()): boolean {
    if (!storage) return false;
    try {
      storage.removeItem(worldEntitiesStorageKey(this.worldId));
      return true;
    } catch (err) {
      console.warn('Could not remove legacy browser entity storage:', err);
      return false;
    }
  }

  entityStorage(): SpaceStorage | null {
    if (this.persistentStorage) return this.persistentStorage;
    try {
      return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
    } catch {
      return null;
    }
  }

  /**
   * Persist all active and dormant entities to browser storage.
   */
  saveEntitiesToStorage(storage = this.entityStorage()): boolean {
    if (this.entityPersistenceMode === 'none') return false;
    if (this.entityPersistenceMode === 'remote') {
      const seenPublicIds = new Set<string>();
      const queue = (record: EntityStreamState) => {
        if (!record?.publicId || seenPublicIds.has(String(record.publicId))) return;
        if (record.serverManaged === true && record.serverCanEdit !== true) return;
        seenPublicIds.add(String(record.publicId));
        this.remoteEntityPersistence?.save?.(record, { definitionChanged: true });
      };
      for (const contraption of this.contraptions) {
        if (!contraption || (contraption.serverManaged === true && contraption.serverCanEdit !== true)) continue;
        const chunk = this.getContraptionChunk(contraption) || { id: '0,0', cx: 0, cz: 0 };
        queue(this.captureContraptionForStreaming(contraption, chunk));
      }
      for (const records of this.dormantContraptions.values()) {
        for (const record of records.values()) queue(record);
      }
      return true;
    }
    if (!storage) return false;
    try {
      const entityRecords: EntityStreamState[] = [];
      const seenPublicIds = new Set<string>();

      // 1. Active contraptions
      for (const c of this.contraptions) {
        if (!c || !c.publicId || c.serverManaged === true) continue;
        const chunk = this.getContraptionChunk(c) || { id: '0,0', cx: 0, cz: 0 };
        const record = this.captureContraptionForStreaming(c, chunk);
        if (record) {
          entityRecords.push(record);
          seenPublicIds.add(String(record.publicId));
        }
      }

      // 2. Dormant contraptions
      for (const records of this.dormantContraptions.values()) {
        for (const record of records.values()) {
          if (record?.publicId && record.serverManaged !== true && !seenPublicIds.has(String(record.publicId))) {
            entityRecords.push(record);
            seenPublicIds.add(String(record.publicId));
          }
        }
      }

      const payload = {
        type: 'space-entities',
        version: ENTITY_STORAGE_VERSION,
        worldId: this.worldId,
        entities: entityRecords
      };

      storage.setItem(worldEntitiesStorageKey(this.worldId), JSON.stringify(payload));
      return true;
    } catch (err) {
      console.warn('Could not save entities to storage:', err);
      return false;
    }
  }

  /**
   * Load and restore all saved entities from browser storage on world startup.
   */
  loadEntitiesFromStorage(storage = this.entityStorage()): number {
    if (this.entityPersistenceMode !== 'browser') return 0;
    if (!storage) return 0;
    try {
      const raw = storage.getItem(worldEntitiesStorageKey(this.worldId));
      if (!raw) return 0;
      const data = JSON.parse(raw);
      if (data?.type !== 'space-entities' || data?.version !== ENTITY_STORAGE_VERSION || !Array.isArray(data.entities)) {
        return 0;
      }

      while (this.contraptions.length > 0) {
        this.removeContraption(this.contraptions[0], { preserveDormant: true, skipSave: true });
      }
      this.dormantContraptions.clear();

      let loadedCount = 0;
      for (const record of data.entities) {
        if (!record?.slot) continue;
        const origin = new THREE.Vector3().fromArray(record.constructorOrigin || record.position || [0, 0, 0]);
        const contraption = this.buildFromSlot(record.slot, origin, record, false);
        if (contraption) {
          loadedCount++;
          const chunk = this.getContraptionChunk(contraption);
          if (chunk && !this.isEntityChunkLoaded(chunk.id)) {
            this.unloadContraption(contraption);
          }
        }
      }
      return loadedCount;
    } catch (err) {
      console.warn('Could not load entities from storage:', err);
      return 0;
    }
  }

  // =========================================================================
  // 1. SELECTION LOGIC
  // =========================================================================

  setCornerA(pos: SelectionPoint | null, opts: { micro?: boolean } = {}) {
    this.clearChildSelection();
    this.selectionBoxConfirmed = false;
    if (pos) {
      this.selectionCornerA = opts.micro === true
        ? this.microCellFromPoint(pos)
        : { x: wrapX(Math.floor(pos.x)), y: Math.floor(pos.y), z: wrapZ(Math.floor(pos.z)) };
    } else {
      this.selectionCornerA = null;
    }
    this.selectionCornerB = null;
    this.connectedSelection = null;
    this.microSelection = null;
    this.microBounds = null;
    this.gluePoints = [];
    if (this.sound) this.sound.playWrenchClick();
  }

  /** Convert a world point to the inclusive micro cell (0.125 m grid) under it. */
  microCellFromPoint(pos: SelectionPoint) {
    return {
      x: wrapMicroX(Math.floor(pos.x * MICRO_DIVISIONS + 1e-6)),
      y: Math.max(0, Math.min(CHUNK_SIZE_Y * MICRO_DIVISIONS - 1, Math.floor(pos.y * MICRO_DIVISIONS + 1e-6))),
      z: wrapMicroZ(Math.floor(pos.z * MICRO_DIVISIONS + 1e-6)),
      micro: true
    };
  }

  /** Clamp a raw corner against the anchor corner so the box stays within MAX_ENTITY_BOUNDS cells per axis. */
  clampSelectionCorner(raw: SelectionPoint, anchor: SelectionPoint) {
    const pos = {
      x: unwrapPeriodicNear(Math.floor(raw.x), anchor.x, TORUS_SIZE_X),
      y: Math.floor(raw.y),
      z: unwrapPeriodicNear(Math.floor(raw.z), anchor.z, TORUS_SIZE_Z)
    };
    let clamped = false;
    for (const axis of ['x', 'y', 'z'] as const) {
      if (pos[axis] - anchor[axis] > MAX_ENTITY_BOUNDS - 1) {
        pos[axis] = anchor[axis] + MAX_ENTITY_BOUNDS - 1;
        clamped = true;
      } else if (anchor[axis] - pos[axis] > MAX_ENTITY_BOUNDS - 1) {
        pos[axis] = anchor[axis] - (MAX_ENTITY_BOUNDS - 1);
        clamped = true;
      }
    }
    return { pos, clamped };
  }

  /** Clamp a raw micro corner against the anchor so the box stays within MAX_ENTITY_BOUNDS standard cells per axis. */
  clampMicroSelectionCorner(raw: SelectionPoint, anchor: SelectionPoint) {
    const pos = {
      x: unwrapPeriodicNear(raw.x, anchor.x, TORUS_SIZE_X * MICRO_DIVISIONS),
      y: raw.y,
      z: unwrapPeriodicNear(raw.z, anchor.z, TORUS_SIZE_Z * MICRO_DIVISIONS),
      micro: true
    };
    let clamped = false;
    const limit = MAX_ENTITY_BOUNDS * MICRO_DIVISIONS - 1;
    for (const axis of ['x', 'y', 'z'] as const) {
      if (pos[axis] - anchor[axis] > limit) {
        pos[axis] = anchor[axis] + limit;
        clamped = true;
      } else if (anchor[axis] - pos[axis] > limit) {
        pos[axis] = anchor[axis] - limit;
        clamped = true;
      }
    }
    const clampedY = Math.max(0, Math.min(CHUNK_SIZE_Y * MICRO_DIVISIONS - 1, pos.y));
    if (clampedY !== pos.y) {
      pos.y = clampedY;
      clamped = true;
    }
    return { pos, clamped };
  }

  /** True when the point AABB would exceed MAX_ENTITY_BOUNDS on any axis. */
  boundsExceedEntityLimit(bounds: CollisionBounds | null) {
    if (!bounds) return false;
    return (
      bounds.maxX - bounds.minX + 1 > MAX_ENTITY_BOUNDS
      || bounds.maxY - bounds.minY + 1 > MAX_ENTITY_BOUNDS
      || bounds.maxZ - bounds.minZ + 1 > MAX_ENTITY_BOUNDS
    );
  }

  setCornerB(pos: SelectionPoint | null, opts: { micro?: boolean } = {}) {
    this.clearChildSelection();
    this.selectionBoxConfirmed = !!(this.selectionCornerA && pos);
    const micro = opts.micro === true || !!this.selectionCornerA?.micro;
    if (micro && pos) {
      // A confirmed micro box materializes into the sparse set of existing
      // micro voxels, so downstream flows (G/T/Del) only touch real blocks.
      const cornerA = this.selectionCornerA?.micro
        ? this.selectionCornerA
        : this.selectionCornerA
          ? { x: this.selectionCornerA.x * MICRO_DIVISIONS, y: this.selectionCornerA.y * MICRO_DIVISIONS, z: this.selectionCornerA.z * MICRO_DIVISIONS, micro: true }
          : this.microCellFromPoint(pos);
      let cornerB = this.microCellFromPoint(pos);
      let clamped = false;
      const result = this.clampMicroSelectionCorner(cornerB, cornerA);
      cornerB = result.pos;
      clamped = result.clamped;
      const minMx = Math.min(cornerA.x, cornerB.x);
      const maxMx = Math.max(cornerA.x, cornerB.x);
      const minMy = Math.min(cornerA.y, cornerB.y);
      const maxMy = Math.max(cornerA.y, cornerB.y);
      const minMz = Math.min(cornerA.z, cornerB.z);
      const maxMz = Math.max(cornerA.z, cornerB.z);
      this.selectionCornerA = null;
      this.selectionCornerB = null;
      this.connectedSelection = null;
      this.microSelection = this.materializeMicroBox(minMx, minMy, minMz, maxMx, maxMy, maxMz);
      this.microBounds = { minX: minMx, minY: minMy, minZ: minMz, maxX: maxMx, maxY: maxMy, maxZ: maxMz };
      this.gluePoints = [];
      if (this.sound) this.sound.playWrenchClick();
      return { clamped, materialized: this.microSelection.length };
    }
    let clamped = false;
    if (pos) {
      const raw = {
        x: wrapX(Math.floor(pos.x)),
        y: Math.floor(pos.y),
        z: wrapZ(Math.floor(pos.z))
      };
      if (this.selectionCornerA) {
        const result = this.clampSelectionCorner(raw, this.selectionCornerA);
        pos = result.pos;
        clamped = result.clamped;
      } else {
        pos = raw;
      }
    }
    this.selectionCornerB = pos;
    this.connectedSelection = null;
    this.microSelection = null;
    this.microBounds = null;
    this.gluePoints = [];
    if (this.sound) this.sound.playWrenchClick();
    return { clamped };
  }

  /** Collect the existing micro voxels and non-air standard blocks inside an inclusive micro-index box. */
  materializeMicroBox(minMx: number, minMy: number, minMz: number, maxMx: number, maxMy: number, maxMz: number) {
    const found: SelectionPoint[] = [];
    const loY = Math.max(0, minMy);
    const hiY = Math.min(CHUNK_SIZE_Y * MICRO_DIVISIONS - 1, maxMy);
    if (loY > hiY) return found;

    const existingMicroKeys = new Set<string>();
    const cells = this.world?.microVoxels?.cells;
    if (cells) {
      for (const key of cells.keys()) {
        const [mx, my, mz] = key.split(',').map(Number);
        const selectionMx = unwrapPeriodicNear(mx, minMx, TORUS_SIZE_X * MICRO_DIVISIONS);
        const selectionMz = unwrapPeriodicNear(mz, minMz, TORUS_SIZE_Z * MICRO_DIVISIONS);
        if (selectionMx < minMx || selectionMx > maxMx || my < loY || my > hiY
          || selectionMz < minMz || selectionMz > maxMz) continue;
        found.push({ x: selectionMx, y: my, z: selectionMz });
        existingMicroKeys.add(`${selectionMx},${my},${selectionMz}`);
      }
    }

    if (this.world?.getBlock) {
      const minWx = Math.floor(minMx / MICRO_DIVISIONS);
      const maxWx = Math.floor(maxMx / MICRO_DIVISIONS);
      const minWy = Math.floor(loY / MICRO_DIVISIONS);
      const maxWy = Math.floor(hiY / MICRO_DIVISIONS);
      const minWz = Math.floor(minMz / MICRO_DIVISIONS);
      const maxWz = Math.floor(maxMz / MICRO_DIVISIONS);

      for (let wx = minWx; wx <= maxWx; wx++) {
        for (let wy = minWy; wy <= maxWy; wy++) {
          for (let wz = minWz; wz <= maxWz; wz++) {
            const block = this.world.getBlock(wx, wy, wz);
            if (block === BlockTypes.AIR) continue;

            const baseMx = wx * MICRO_DIVISIONS;
            const baseMy = wy * MICRO_DIVISIONS;
            const baseMz = wz * MICRO_DIVISIONS;

            const startDx = Math.max(0, minMx - baseMx);
            const endDx = Math.min(MICRO_DIVISIONS - 1, maxMx - baseMx);
            const startDy = Math.max(0, loY - baseMy);
            const endDy = Math.min(MICRO_DIVISIONS - 1, hiY - baseMy);
            const startDz = Math.max(0, minMz - baseMz);
            const endDz = Math.min(MICRO_DIVISIONS - 1, maxMz - baseMz);

            for (let dx = startDx; dx <= endDx; dx++) {
              for (let dy = startDy; dy <= endDy; dy++) {
                for (let dz = startDz; dz <= endDz; dz++) {
                  const mx = baseMx + dx;
                  const my = baseMy + dy;
                  const mz = baseMz + dz;
                  const k = `${mx},${my},${mz}`;
                  if (!existingMicroKeys.has(k)) {
                    found.push({ x: mx, y: my, z: mz });
                  }
                }
              }
            }
          }
        }
      }
    }

    return found;
  }

  setConnectedSelection(blocks: SelectionPoint[]) {
    this.clearChildSelection();
    const anchor = blocks?.[0]
      ? { x: wrapX(Math.floor(blocks[0].x)), y: Math.floor(blocks[0].y), z: wrapZ(Math.floor(blocks[0].z)) }
      : null;
    const normalizedBlocks = anchor
      ? blocks.map(block => ({
          x: unwrapPeriodicNear(Math.floor(block.x), anchor.x, TORUS_SIZE_X),
          y: Math.floor(block.y),
          z: unwrapPeriodicNear(Math.floor(block.z), anchor.z, TORUS_SIZE_Z)
        }))
      : blocks;
    if (this.boundsExceedEntityLimit(this.getBoundsFromPoints(normalizedBlocks))) {
      return false;
    }
    this.connectedSelection = normalizedBlocks;
    this.selectionBoxConfirmed = false;
    this.selectionCornerA = null;
    this.selectionCornerB = null;
    this.microSelection = null;
    this.gluePoints = [];
    if (this.sound) this.sound.playGlueApply();
    return true;
  }

  addGluePoint(pos: SelectionPoint) {
    if (!pos) return 0;
    this.clearChildSelection();
    this.selectionBoxConfirmed = false;
    // A plain click always returns from single mode to a fresh three-point
    // box. The click itself is point one, so only two more clicks are needed.
    if (this.connectedSelection !== null || this.gluePoints.length >= 3) {
      this.connectedSelection = null;
      this.gluePoints = [];
    }
    const anchor = this.gluePoints[0] || null;
    const pt = {
      x: anchor
        ? unwrapPeriodicNear(Math.floor(pos.x), anchor.x, TORUS_SIZE_X)
        : wrapX(Math.floor(pos.x)),
      y: Math.floor(pos.y),
      z: anchor
        ? unwrapPeriodicNear(Math.floor(pos.z), anchor.z, TORUS_SIZE_Z)
        : wrapZ(Math.floor(pos.z))
    };
    if (this.gluePoints.length > 0) {
      // Keep the completed three-point box within MAX_ENTITY_BOUNDS per axis.
      const bounds = this.getBoundsFromPoints(this.gluePoints)!;
      for (const axis of ['x', 'y', 'z'] as const) {
        const min = bounds[`min${({ x: 'X', y: 'Y', z: 'Z' } as const)[axis]}`];
        const max = bounds[`max${({ x: 'X', y: 'Y', z: 'Z' } as const)[axis]}`];
        if (pt[axis] - min > MAX_ENTITY_BOUNDS - 1) pt[axis] = min + MAX_ENTITY_BOUNDS - 1;
        else if (max - pt[axis] > MAX_ENTITY_BOUNDS - 1) pt[axis] = max - (MAX_ENTITY_BOUNDS - 1);
      }
    }
    this.gluePoints.push(pt);
    this.selectionCornerA = null;
    this.selectionCornerB = null;
    this.microSelection = null;
    if (this.sound) this.sound.playGlueApply();
    return this.gluePoints.length;
  }

  addSelectionPoint(pos: SelectionPoint, singleMode = false) {
    if (singleMode) {
      const info = this.toggleWorldGlueCell(pos);
      return info?.count || 0;
    }
    return this.addGluePoint(pos);
  }

  toggleWorldGlueCell(pos: SelectionPoint) {
    if (!pos) return null;
    this.clearChildSelection();
    this.selectionBoxConfirmed = false;
    const canonicalCell = { x: wrapX(Math.floor(pos.x)), y: Math.floor(pos.y), z: wrapZ(Math.floor(pos.z)) };
    const anchor = this.connectedSelection?.[0] || canonicalCell;
    const cell = {
      x: unwrapPeriodicNear(canonicalCell.x, anchor.x, TORUS_SIZE_X),
      y: canonicalCell.y,
      z: unwrapPeriodicNear(canonicalCell.z, anchor.z, TORUS_SIZE_Z)
    };
    const key = `${canonicalCell.x},${cell.y},${canonicalCell.z}`;

    // Shift always enters single mode. Any unfinished or completed box is
    // intentionally discarded so the two interaction modes never overlap.
    if (this.connectedSelection === null) {
      this.connectedSelection = [];
      this.microSelection = null;
      this.gluePoints = [];
      this.selectionCornerA = null;
      this.selectionCornerB = null;
    }

    const index = this.connectedSelection.findIndex(item => (
      `${wrapX(item.x)},${item.y},${wrapZ(item.z)}` === key
    ));
    let rejected = false;
    if (index >= 0) {
      this.connectedSelection.splice(index, 1);
    } else {
      // Adding must never push the single-cell selection past MAX_ENTITY_BOUNDS
      // on any axis; removals are always allowed.
      const bounds = this.getSelectionBounds();
      if (bounds && (
        Math.max(cell.x, bounds.maxX) - Math.min(cell.x, bounds.minX) + 1 > MAX_ENTITY_BOUNDS
        || Math.max(cell.y, bounds.maxY) - Math.min(cell.y, bounds.minY) + 1 > MAX_ENTITY_BOUNDS
        || Math.max(cell.z, bounds.maxZ) - Math.min(cell.z, bounds.minZ) + 1 > MAX_ENTITY_BOUNDS
      )) {
        rejected = true;
      } else {
        this.connectedSelection.push(cell);
      }
    }
    if (this.sound) this.sound.playGlueApply();
    const info = this.getWorldGlueSelectionInfo();
    if (rejected) info.rejected = true;
    return info;
  }

  /**
   * Toggle one 0.125 m micro cell in the world micro-selection (the Selector
   * tool's Tab-toggled micro mode). Mirrors toggleWorldGlueCell: shift always
   * enters single mode, and any unfinished or completed box is discarded.
   */
  toggleMicroCell(pos: SelectionPoint) {
    if (!pos) return null;
    this.clearChildSelection();
    this.selectionBoxConfirmed = false;
    const canonicalCell = this.microCellFromPoint(pos);
    const anchor = this.microSelection?.[0] || canonicalCell;
    const cell = {
      x: unwrapPeriodicNear(canonicalCell.x, anchor.x, TORUS_SIZE_X * MICRO_DIVISIONS),
      y: canonicalCell.y,
      z: unwrapPeriodicNear(canonicalCell.z, anchor.z, TORUS_SIZE_Z * MICRO_DIVISIONS)
    };
    const key = `${canonicalCell.x},${cell.y},${canonicalCell.z}`;

    if (this.microSelection === null) {
      this.microSelection = [];
      this.connectedSelection = null;
      this.gluePoints = [];
      this.selectionCornerA = null;
      this.selectionCornerB = null;
    }

    const index = this.microSelection.findIndex(item => (
      `${wrapMicroX(item.x)},${item.y},${wrapMicroZ(item.z)}` === key
    ));
    let rejected = false;
    if (index >= 0) {
      this.microSelection.splice(index, 1);
    } else {
      // Adding must never push the micro selection past MAX_ENTITY_BOUNDS
      // standard cells on any axis; removals are always allowed.
      const bounds = this.getMicroSelectionBounds();
      const limit = MAX_ENTITY_BOUNDS * MICRO_DIVISIONS - 1;
      if (bounds && (
        Math.max(cell.x, bounds.maxX) - Math.min(cell.x, bounds.minX) > limit
        || Math.max(cell.y, bounds.maxY) - Math.min(cell.y, bounds.minY) > limit
        || Math.max(cell.z, bounds.maxZ) - Math.min(cell.z, bounds.minZ) > limit
      )) {
        rejected = true;
      } else {
        this.microSelection.push({ x: cell.x, y: cell.y, z: cell.z });
      }
    }
    if (this.sound) this.sound.playGlueApply();
    const info = this.getWorldGlueSelectionInfo();
    if (rejected) info.rejected = true;
    return info;
  }

  /** Inclusive micro-index bounds of the sparse micro selection, or null. */
  getMicroSelectionBounds(): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null {
    if (this.microBounds) {
      return { ...this.microBounds };
    }
    if (this.microSelection === null || this.microSelection.length === 0) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const c of this.microSelection) {
      if (c.x < minX) minX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.z < minZ) minZ = c.z;
      if (c.x > maxX) maxX = c.x;
      if (c.y > maxY) maxY = c.y;
      if (c.z > maxZ) maxZ = c.z;
    }
    return { minX, minY, minZ, maxX, maxY, maxZ };
  }

  /**
   * Partition the active micro selection into:
   * 1. standardCells: regions that completely cover 8x8x8 microcells of a standard block
   *    and can be processed as full 1.0 m standard blocks to minimize voxel overhead.
   * 2. microCells: boundary / partial microcells that cannot be merged into a standard block.
   */
  partitionMicroSelection(): {
    standardCells: Array<{ x: number; y: number; z: number }>;
    microCells: Array<{ x: number; y: number; z: number }>;
    standardBounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null;
  } {
    const standardCells: Array<{ x: number; y: number; z: number }> = [];
    const microCells: Array<{ x: number; y: number; z: number }> = [];
    let standardBounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null = null;

    if (this.microBounds) {
      const { minX, minY, minZ, maxX, maxY, maxZ } = this.microBounds;
      const stdMinWx = Math.ceil(minX / MICRO_DIVISIONS);
      const stdMaxWx = Math.floor((maxX - MICRO_DIVISIONS + 1) / MICRO_DIVISIONS);
      const stdMinWy = Math.ceil(minY / MICRO_DIVISIONS);
      const stdMaxWy = Math.floor((maxY - MICRO_DIVISIONS + 1) / MICRO_DIVISIONS);
      const stdMinWz = Math.ceil(minZ / MICRO_DIVISIONS);
      const stdMaxWz = Math.floor((maxZ - MICRO_DIVISIONS + 1) / MICRO_DIVISIONS);

      const hasStandardCore = stdMinWx <= stdMaxWx && stdMinWy <= stdMaxWy && stdMinWz <= stdMaxWz;
      if (hasStandardCore) {
        standardBounds = {
          minX: stdMinWx,
          minY: stdMinWy,
          minZ: stdMinWz,
          maxX: stdMaxWx,
          maxY: stdMaxWy,
          maxZ: stdMaxWz
        };
        for (let x = stdMinWx; x <= stdMaxWx; x++) {
          for (let y = stdMinWy; y <= stdMaxWy; y++) {
            for (let z = stdMinWz; z <= stdMaxWz; z++) {
              standardCells.push({ x, y, z });
            }
          }
        }
      }

      // Collect all microcells that are outside the standard core
      for (let x = minX; x <= maxX; x++) {
        const inCoreX = hasStandardCore && x >= stdMinWx * MICRO_DIVISIONS && x <= (stdMaxWx + 1) * MICRO_DIVISIONS - 1;
        for (let y = minY; y <= maxY; y++) {
          const inCoreY = inCoreX && y >= stdMinWy * MICRO_DIVISIONS && y <= (stdMaxWy + 1) * MICRO_DIVISIONS - 1;
          for (let z = minZ; z <= maxZ; z++) {
            if (inCoreY && z >= stdMinWz * MICRO_DIVISIONS && z <= (stdMaxWz + 1) * MICRO_DIVISIONS - 1) {
              z = (stdMaxWz + 1) * MICRO_DIVISIONS - 1;
              continue;
            }
            microCells.push({ x, y, z });
          }
        }
      }

      return { standardCells, microCells, standardBounds };
    }

    if (Array.isArray(this.microSelection) && this.microSelection.length > 0) {
      // Group sparse micro cells by their standard cell parent
      const grouped = new Map<string, Array<{ x: number; y: number; z: number }>>();
      for (const cell of this.microSelection) {
        const wx = Math.floor(cell.x / MICRO_DIVISIONS);
        const wy = Math.floor(cell.y / MICRO_DIVISIONS);
        const wz = Math.floor(cell.z / MICRO_DIVISIONS);
        const key = `${wx},${wy},${wz}`;
        let list = grouped.get(key);
        if (!list) {
          list = [];
          grouped.set(key, list);
        }
        list.push(cell);
      }

      const fullCellCount = MICRO_DIVISIONS ** 3; // 512
      for (const [key, cells] of grouped) {
        const [wx, wy, wz] = key.split(',').map(Number);
        if (cells.length === fullCellCount) {
          standardCells.push({ x: wx, y: wy, z: wz });
        } else {
          microCells.push(...cells);
        }
      }
    }

    return { standardCells, microCells, standardBounds };
  }

  getWorldGlueSelectionInfo(): {
    mode: string;
    granularity: string;
    pointCount: number;
    count: number;
    ready: boolean;
    cells: SelectionPoint[] | null;
    rejected?: boolean;
  } {
    const microCells = this.microSelection;
    const microMode = microCells !== null;
    const standardCells = this.connectedSelection;
    const singleMode = standardCells !== null;
    const count = microMode ? microCells!.length : singleMode ? standardCells!.length : this.getSelectionBlockCount();
    // Prefer the two-point cornerA/B selection; retain legacy three-point gluePoints compatibility.
    const cornerA = this.selectionCornerA;
    const cornerB = this.selectionCornerB;
    const pointCount = (microMode || singleMode)
      ? 0
      : cornerA !== null
        ? (cornerB !== null ? 2 : 1)
        : this.gluePoints.length;
    // 'micro' when the Selector tool's Tab-toggled micro-block mode is active —
    // including a micro box that is still waiting for its second corner.
    const granularity = microMode || (cornerA !== null && cornerB === null && cornerA.micro === true)
      ? 'micro'
      : 'standard';
    return {
      mode: (microMode || singleMode) ? 'single' : 'box',
      granularity,
      pointCount,
      count,
      ready: (microMode || singleMode) ? count > 0 : cornerA !== null ? cornerB !== null : this.gluePoints.length === 3,
      cells: microMode
        ? microCells!.map(cell => ({ ...cell }))
        : singleMode ? standardCells!.map(cell => ({ ...cell })) : null
    };
  }

  clearSelection() {
    this.clearChildSelection();
    this.selectionBoxConfirmed = false;
    if (this.entitySelection?.contraption) {
      this.entitySelection.contraption.clearSubtreeHighlight?.();
    }
    this.entitySelection = null;
    this.selectionCornerA = null;
    this.selectionCornerB = null;
    this.connectedSelection = null;
    this.microSelection = null;
    this.microBounds = null;
    this.gluePoints = [];
    if (Array.isArray(this.contraptions)) {
      for (const contraption of this.contraptions) {
        contraption.clearSubtreeHighlight?.();
        contraption.clearGlueSelection?.();
      }
    }
  }

  clearChildSelection() {
    if (this.childSelection?.contraption) {
      this.childSelection.contraption.clearGlueSelection();
    }
    this.childSelection = null;
  }

  selectChildEntityCell(hit: NonNullable<ReturnType<ContraptionManager['raycastContraptionHit']>>, isMultiSelect = false) {
    if (!hit?.contraption || !hit.cell) return null;
    if (!hit.contraption.canEditInternalSelection?.()) {
      if (this.childSelection?.contraption === hit.contraption) this.clearChildSelection();
      return null;
    }
    const parentId = hit.entityId || hit.entityNode?.id || hit.contraption.rootComponentId;
    const key = `${hit.cell.x},${hit.cell.y},${hit.cell.z}`;
    const selectableKeys = hit.contraption.getEntityCollisionCellKeys(parentId);
    if (!selectableKeys.has(key)) return null;

    const sameParent = this.childSelection
      && this.childSelection!.contraption === hit.contraption
      && this.childSelection.parentId === parentId;

    if (!sameParent) {
      this.clearSelection();
      this.childSelection = {
        contraption: hit.contraption,
        parentId,
        mode: 'single',
        cells: new Set([key])
      };
    } else if (isMultiSelect) {
      if (this.childSelection!.cells.has(key)) {
        this.childSelection!.cells.delete(key);
      } else {
        this.childSelection!.cells.add(key);
      }
    } else {
      this.childSelection!.cells = new Set([key]);
    }

    if (this.childSelection!.cells.size === 0) {
      this.childSelection!.contraption.clearGlueSelection();
      this.childSelection!.contraption.setFocusHighlight(parentId);
    } else {
      this.childSelection!.contraption.setGlueSelection(parentId, this.childSelection!.cells);
    }

    if (this.sound) this.sound.playGlueApply();
    return this.getChildSelectionInfo();
  }

  hasChildSelection() {
    return !!this.childSelection;
  }

  hasReadyChildSelection() {
    return !!(
      this.childSelection
      && this.childSelection.contraption?.canEditInternalSelection?.()
      && this.childSelection.cells.size > 0
    );
  }

  getChildSelectionInfo() {
    if (!this.childSelection) return null;
    if (!this.childSelection.contraption?.canEditInternalSelection?.()) {
      this.clearChildSelection();
      return null;
    }
    const contraption = this.childSelection.contraption;
    const descendantCount = [...contraption.entityNodes.keys()]
      .filter(nodeId => contraption.isEntityDescendantOf(nodeId, this.childSelection!.parentId))
      .length;
    return {
      contraption,
      parentId: this.childSelection.parentId,
      mode: 'single',
      pointCount: 0,
      count: this.childSelection.cells.size,
      cells: new Set(this.childSelection.cells),
      ready: this.childSelection.cells.size > 0,
      existingChildCount: descendantCount
    };
  }

  createChildFromSelection(requestedId: string | null = null) {
    if (!this.childSelection || !this.hasReadyChildSelection()) return null;
    const { contraption, parentId, cells } = this.childSelection;
    if (!contraption.canEditInternalSelection?.()) {
      this.clearChildSelection();
      return null;
    }
    contraption.clearGlueSelection();
    const child = contraption.createChildEntity(parentId, cells, requestedId);
    this.childSelection = null;
    if (child && this.sound) this.sound.playAssemblyClack();
    return child ? { contraption, child } : null;
  }

  hasValidSelection() {
    if (this.childSelection) return this.hasReadyChildSelection();
    if (this.microBounds !== null) return true;
    if (this.microSelection && this.microSelection.length > 0) return true;
    if (this.connectedSelection && this.connectedSelection.length > 0) return true;
    if (this.gluePoints && this.gluePoints.length === 3) return true;
    return this.selectionCornerA !== null && this.selectionCornerB !== null;
  }

  getSelectionBounds() {
    if (this.childSelection) return null;
    if (this.connectedSelection !== null && this.connectedSelection.length > 0) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const b of this.connectedSelection) {
        if (b.x < minX) minX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.z < minZ) minZ = b.z;
        if (b.x > maxX) maxX = b.x;
        if (b.y > maxY) maxY = b.y;
        if (b.z > maxZ) maxZ = b.z;
      }
      return { minX, minY, minZ, maxX, maxY, maxZ };
    }

    if (this.gluePoints && this.gluePoints.length > 0) {
      const minX = Math.min(...this.gluePoints.map(p => p.x));
      const maxX = Math.max(...this.gluePoints.map(p => p.x));
      const minY = Math.min(...this.gluePoints.map(p => p.y));
      const maxY = Math.max(...this.gluePoints.map(p => p.y));
      const minZ = Math.min(...this.gluePoints.map(p => p.z));
      const maxZ = Math.max(...this.gluePoints.map(p => p.z));
      return { minX, minY, minZ, maxX, maxY, maxZ };
    }

    if (!this.selectionCornerA || !this.selectionCornerB) return null;

    const minX = Math.min(this.selectionCornerA.x, this.selectionCornerB.x);
    const maxX = Math.max(this.selectionCornerA.x, this.selectionCornerB.x);
    const minY = Math.min(this.selectionCornerA.y, this.selectionCornerB.y);
    const maxY = Math.max(this.selectionCornerA.y, this.selectionCornerB.y);
    const minZ = Math.min(this.selectionCornerA.z, this.selectionCornerB.z);
    const maxZ = Math.max(this.selectionCornerA.z, this.selectionCornerB.z);

    return { minX, minY, minZ, maxX, maxY, maxZ };
  }

  getSelectionBlockCount() {
    if (this.childSelection) return this.childSelection.cells.size;
    if (this.microSelection !== null) return this.microSelection.length;
    if (this.connectedSelection !== null) return this.connectedSelection.length;
    const bounds = this.getSelectionBounds();
    if (!bounds) return 0;
    return (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1) * (bounds.maxZ - bounds.minZ + 1);
  }

  /**
   * Expand or shrink the active selection boundary along an axis.
   * @param axis 'x' | 'y' | 'z'
   * @param direction 1 (+axis) | -1 (-axis)
   * @param deltaSteps Number of steps (positive = expand outward, negative = shrink inward)
   * @param isMicro Whether currently in micro mode
   * @returns {{ ok: boolean, bounds?: any, isMicro?: boolean, count?: number }}
   */
  expandSelectionAxis(axis: 'x' | 'y' | 'z', direction: 1 | -1, deltaSteps: number, isMicro = false) {
    if (!deltaSteps || !Number.isFinite(deltaSteps)) return { ok: false };

    if (isMicro || this.microBounds || Array.isArray(this.microSelection)) {
      const mb = this.getMicroSelectionBounds();
      if (!mb) return { ok: false };
      let { minX, minY, minZ, maxX, maxY, maxZ } = mb;

      const d = Math.round(deltaSteps);
      if (axis === 'x') {
        if (direction === 1) maxX += d;
        else minX -= d;
      } else if (axis === 'y') {
        if (direction === 1) maxY += d;
        else minY -= d;
      } else if (axis === 'z') {
        if (direction === 1) maxZ += d;
        else minZ -= d;
      }

      if (maxX < minX) {
        if (direction === 1) maxX = minX;
        else minX = maxX;
      }
      if (maxY < minY) {
        if (direction === 1) maxY = minY;
        else minY = maxY;
      }
      if (maxZ < minZ) {
        if (direction === 1) maxZ = minZ;
        else minZ = maxZ;
      }

      const maxMicroSpan = MAX_ENTITY_BOUNDS * MICRO_DIVISIONS;
      if (maxX - minX + 1 > maxMicroSpan) {
        if (direction === 1) maxX = minX + maxMicroSpan - 1;
        else minX = maxX - (maxMicroSpan - 1);
      }
      if (maxY - minY + 1 > maxMicroSpan) {
        if (direction === 1) maxY = minY + maxMicroSpan - 1;
        else minY = maxY - (maxMicroSpan - 1);
      }
      if (maxZ - minZ + 1 > maxMicroSpan) {
        if (direction === 1) maxZ = minZ + maxMicroSpan - 1;
        else minZ = maxZ - (maxMicroSpan - 1);
      }

      minY = Math.max(0, minY);
      maxY = Math.min(CHUNK_SIZE_Y * MICRO_DIVISIONS - 1, maxY);

      this.microBounds = { minX, minY, minZ, maxX, maxY, maxZ };
      this.microSelection = this.materializeMicroBox(minX, minY, minZ, maxX, maxY, maxZ);
      return {
        ok: true,
        bounds: { ...this.microBounds },
        isMicro: true,
        count: this.microSelection.length
      };
    }

    const bounds = this.getSelectionBounds();
    if (!bounds || this.selectionCornerA === null || this.selectionCornerB === null) {
      return { ok: false };
    }

    let { minX, minY, minZ, maxX, maxY, maxZ } = bounds;
    const d = Math.round(deltaSteps);

    if (axis === 'x') {
      if (direction === 1) maxX += d;
      else minX -= d;
    } else if (axis === 'y') {
      if (direction === 1) maxY += d;
      else minY -= d;
    } else if (axis === 'z') {
      if (direction === 1) maxZ += d;
      else minZ -= d;
    }

    if (maxX < minX) {
      if (direction === 1) maxX = minX;
      else minX = maxX;
    }
    if (maxY < minY) {
      if (direction === 1) maxY = minY;
      else minY = maxY;
    }
    if (maxZ < minZ) {
      if (direction === 1) maxZ = minZ;
      else minZ = maxZ;
    }

    if (maxX - minX + 1 > MAX_ENTITY_BOUNDS) {
      if (direction === 1) maxX = minX + MAX_ENTITY_BOUNDS - 1;
      else minX = maxX - (MAX_ENTITY_BOUNDS - 1);
    }
    if (maxY - minY + 1 > MAX_ENTITY_BOUNDS) {
      if (direction === 1) maxY = minY + MAX_ENTITY_BOUNDS - 1;
      else minY = maxY - (MAX_ENTITY_BOUNDS - 1);
    }
    if (maxZ - minZ + 1 > MAX_ENTITY_BOUNDS) {
      if (direction === 1) maxZ = minZ + MAX_ENTITY_BOUNDS - 1;
      else minZ = maxZ - (MAX_ENTITY_BOUNDS - 1);
    }

    minY = Math.max(0, minY);
    maxY = Math.min(CHUNK_SIZE_Y - 1, maxY);

    this.selectionCornerA = { x: minX, y: minY, z: minZ };
    this.selectionCornerB = { x: maxX, y: maxY, z: maxZ };

    return {
      ok: true,
      bounds: { minX, minY, minZ, maxX, maxY, maxZ },
      isMicro: false,
      count: this.getSelectionBlockCount()
    };
  }

  getBoundsFromPoints(points: readonly SelectionPoint[] | null) {
    if (!points || points.length === 0) return null;
    return {
      minX: Math.min(...points.map(point => point.x)),
      maxX: Math.max(...points.map(point => point.x)),
      minY: Math.min(...points.map(point => point.y)),
      maxY: Math.max(...points.map(point => point.y)),
      minZ: Math.min(...points.map(point => point.z)),
      maxZ: Math.max(...points.map(point => point.z))
    };
  }

  // =========================================================================
  // 2. CONTRAPTION ASSEMBLY (physics instantiation)
  // =========================================================================

  normalizeAssemblyMode(mode = ContraptionMode.PROGRAMMABLE) {
    if (mode === 'auto') return ContraptionMode.PROGRAMMABLE;
    return Object.values(ContraptionMode).includes(mode) ? mode : null;
  }

  assembleSelection(mode = ContraptionMode.PROGRAMMABLE, customOptions: ContraptionOptions = {}) {
    const finalMode = this.normalizeAssemblyMode(mode);
    // Validate before extracting any selected world voxels. Invalid modes must
    // never mutate the world or consume the current selection.
    if (!finalMode) return null;
    if (!this.world || !this.hasValidSelection()) return null;

    let rawBlocks: RuntimeVoxel[] = [];
    let originPos = new THREE.Vector3(0, 0, 0);

    if (this.microSelection !== null) {
      // Sparse micro selection (Selector micro mode): extract exactly the
      // existing micro voxels at the selected 0.125 m cells.
      const cells = this.microSelection;
      let minMx = Infinity, minMy = Infinity, minMz = Infinity;
      for (const c of cells) {
        if (c.x < minMx) minMx = c.x;
        if (c.y < minMy) minMy = c.y;
        if (c.z < minMz) minMz = c.z;
      }
      if (minMx === Infinity) {
        this.clearSelection();
        return null;
      }
      originPos.set(
        minMx / MICRO_DIVISIONS,
        minMy / MICRO_DIVISIONS,
        minMz / MICRO_DIVISIONS
      );

      // Subdivide any standard blocks containing selected micro cells that haven't been subdivided yet
      const subdividedStandardCells = new Set<string>();
      for (const c of cells) {
        const wx = Math.floor(c.x / MICRO_DIVISIONS);
        const wy = Math.floor(c.y / MICRO_DIVISIONS);
        const wz = Math.floor(c.z / MICRO_DIVISIONS);
        const cellKey = `${wx},${wy},${wz}`;
        if (!subdividedStandardCells.has(cellKey)) {
          if (this.world?.getBlock && this.world.getBlock(wx, wy, wz) !== BlockTypes.AIR) {
            this.world.subdivideBlock?.(wx, wy, wz);
          }
          subdividedStandardCells.add(cellKey);
        }
      }

      const affectedChunks = new Set<Chunk>();
      for (const c of cells) {
        const extracted = this.world.extractMicroCellRegion?.(c.x, c.y, c.z, c.x, c.y, c.z) || [];
        for (const micro of extracted) {
          rawBlocks.push({
            localX: micro.mx / MICRO_DIVISIONS - minMx / MICRO_DIVISIONS,
            localY: micro.my / MICRO_DIVISIONS - minMy / MICRO_DIVISIONS,
            localZ: micro.mz / MICRO_DIVISIONS - minMz / MICRO_DIVISIONS,
            size: MICRO_SIZE,
            block: BlockTypes.COLOR_BLOCK,
            color: micro.color,
            materialId: micro.materialId,
            part: micro.part
          });
          const { cx, cz } = this.world.worldToChunkCoords(
            Math.floor(micro.mx / MICRO_DIVISIONS),
            Math.floor(micro.mz / MICRO_DIVISIONS)
          );
          const chunk = this.world.getChunk(cx, cz);
          if (chunk) affectedChunks.add(chunk);
        }
      }
      for (const chunk of affectedChunks) {
        chunk.isDirty = true;
        this.world.dirtyChunks.add(chunk);
      }
    } else if (this.connectedSelection !== null) {
      const bounds = this.getSelectionBounds();
      if (!bounds) return null;
      originPos.set(bounds.minX, bounds.minY, bounds.minZ);

      const affectedChunks = new Set<Chunk>();
      for (const b of this.connectedSelection) {
        const block = this.world.getBlock(b.x, b.y, b.z);
        if (block !== BlockTypes.AIR) {
          rawBlocks.push({
            localX: b.x - bounds.minX,
            localY: b.y - bounds.minY,
            localZ: b.z - bounds.minZ,
            size: 1,
            block,
            color: this.world.getBlockColor(b.x, b.y, b.z),
            materialId: this.world.getBlockMaterial?.(b.x, b.y, b.z) ?? 0,
          });
          this.world.setBlock(b.x, b.y, b.z, BlockTypes.AIR, false);
          const { cx, cz } = this.world.worldToChunkCoords(b.x, b.z);
          const chunk = this.world.getChunk(cx, cz);
          if (chunk) affectedChunks.add(chunk);
        }

        const microBlocks = this.world.extractMicroRegion(b.x, b.y, b.z, b.x, b.y, b.z);
        for (const micro of microBlocks) {
          rawBlocks.push({
            localX: micro.mx / MICRO_DIVISIONS - bounds.minX,
            localY: micro.my / MICRO_DIVISIONS - bounds.minY,
            localZ: micro.mz / MICRO_DIVISIONS - bounds.minZ,
            size: MICRO_SIZE,
            block: BlockTypes.COLOR_BLOCK,
            color: micro.color,
            materialId: micro.materialId,
            part: micro.part
          });
        }
      }

      for (const chunk of affectedChunks) {
        chunk.isDirty = true;
        this.world.dirtyChunks.add(chunk);
      }
    } else {
      const bounds = this.getSelectionBounds();
      if (!bounds) return null;
      originPos.set(bounds.minX, bounds.minY, bounds.minZ);

      const extracted = this.world.extractRegion(
        bounds.minX, bounds.minY, bounds.minZ,
        bounds.maxX, bounds.maxY, bounds.maxZ
      );

      for (const eb of extracted) {
        rawBlocks.push({
          localX: eb.worldX - bounds.minX,
          localY: eb.worldY - bounds.minY,
          localZ: eb.worldZ - bounds.minZ,
          size: 1,
          block: eb.block,
          color: eb.color,
          materialId: eb.materialId,
        });
      }
    }

    const bounds = this.getSelectionBounds();
    if (bounds && this.connectedSelection === null) {
      const microBlocks = this.world?.extractMicroRegion?.(
        bounds.minX, bounds.minY, bounds.minZ,
        bounds.maxX, bounds.maxY, bounds.maxZ
      ) || [];
      for (const micro of microBlocks) {
        rawBlocks.push({
          localX: micro.mx / MICRO_DIVISIONS - bounds.minX,
          localY: micro.my / MICRO_DIVISIONS - bounds.minY,
          localZ: micro.mz / MICRO_DIVISIONS - bounds.minZ,
          size: MICRO_SIZE,
          block: BlockTypes.COLOR_BLOCK,
          color: micro.color,
          materialId: micro.materialId,
          part: micro.part
        });
      }
    }

    return this.commitPreparedAssembly(rawBlocks, originPos, finalMode, customOptions);
  }

  /**
   * Atomically turn already-extracted voxels into an entity. Large player edits
   * prepare/extract their blocks through BulkEditJob, then use this same commit
   * path so no partially constructed entity is ever registered.
   */
  commitPreparedAssembly(rawBlocks: RuntimeVoxel[], originPos: THREE.Vector3 | SelectionPoint, mode = ContraptionMode.PROGRAMMABLE, customOptions: ContraptionOptions = {}) {
    const finalMode = this.normalizeAssemblyMode(mode);
    if (!finalMode || !Array.isArray(rawBlocks) || rawBlocks.length === 0) {
      this.clearSelection();
      return null;
    }

    const options = {
      ...customOptions,
      mode: finalMode,
      particleSystem: this.particles
    };
    const origin = originPos instanceof THREE.Vector3
      ? originPos.clone()
      : new THREE.Vector3(Number(originPos?.x) || 0, Number(originPos?.y) || 0, Number(originPos?.z) || 0);
    const contraption = new Contraption(
      this.nextId++,
      rawBlocks,
      origin,
      this.scene,
      options
    );

    this.registerContraption(contraption);
    this.activeProgrammingContraption = contraption;
    this.sound?.playAssemblyClack?.();
    this.sound?.playSteamHiss?.();
    this.particles?.emitSteamPuff?.(contraption.position, 25);
    this.clearSelection();
    this.saveEntitiesToStorage();
    return contraption;
  }

  /**
   * Rebuild an entity from a serialized inventory slot.
   * Inventory slots already contain one explicit root and need no identity remapping.
   * @returns The registered entity, or null for an empty slot.
   */
  buildFromSlot(slot: InventoryInput | null | undefined, position: THREE.Vector3, restoreState: EntityStreamState | null = null, autoSave = true, preparedBlocks: RuntimeVoxel[] | null = null) {
    if (!slot || !Array.isArray(slot.blocks) || slot.blocks.length === 0) return null;

    const rootComponentId = String(slot.rootComponentId || '');
    if (!isValidComponentId(rootComponentId)) return null;
    const subtreeChildIds = new Set((slot.childEntities || []).map(d => d.id));
    if (subtreeChildIds.has(rootComponentId)) return null;

    const blocks = Array.isArray(preparedBlocks) ? preparedBlocks : slot.blocks.map(b => ({
      localX: Number(b.localX) || 0,
      localY: Number(b.localY) || 0,
      localZ: Number(b.localZ) || 0,
      size: b.size || 1,
      color: b.color,
      materialId: b.materialId,
      block: b.block,
      entityId: b.entityId
    }));

    if (blocks.some(block => !block.entityId)) return null;

    // Keep only the explicit single-root tree carried by the slot.
    const childEntities = (slot.childEntities || [])
      .filter(d => subtreeChildIds.has(d.id))
      .map(d => ({ ...d }));
    const constraints = (slot.constraints || [])
      .filter(constraint => (
        constraint.bodyB === rootComponentId || subtreeChildIds.has(constraint.bodyB)
      ) && (
        constraint.bodyA === null
        || constraint.bodyA === rootComponentId
        || subtreeChildIds.has(constraint.bodyA)
      ));

    const restoredId = Number(restoreState?.id);
    const entityId = Number.isFinite(restoredId) ? restoredId : this.nextId++;
    if (Number.isFinite(restoredId)) this.nextId = Math.max(this.nextId, restoredId + 1);
    const contraption = new Contraption(
      entityId,
      blocks,
      position.clone(),
      this.scene,
      {
        rootComponentId,
        rootComponentName: slot.name,
        publicId: restoreState?.publicId,
        mode: slot.mode || ContraptionMode.FREE_PHYSICS,
        bodyType: slot.bodyType || BodyType.DYNAMIC,
        mass: slot.mass,
        restitution: slot.restitution,
        friction: slot.friction,
        useGravity: slot.useGravity,
        collisionEnabled: slot.collisionEnabled,
        seats: slot.seats,
        decorations: slot.decorations,
        behaviorPrompt: restoreState?.behaviorPrompt,
        agentInterpretation: restoreState?.agentInterpretation,
        localCenter: restoreState?.localCenter,
        rootPivotOverride: Array.isArray(restoreState?.rootPivotOverride)
          ? restoreState.rootPivotOverride
          : slot.rootPivotOverride,
        anchorRotation: slot.anchorRotation,
        childEntities,
        constraints
      }
    );

    for (const entry of slot.scripts || []) {
      contraption.setNodeScript(entry.id, entry.language === 'assemblyscript' ? entry.code : '');
    }
    for (const entry of slot.enabled || []) {
      contraption.setNodeScriptEnabled(entry.id, entry.enabled);
    }

    this.registerContraption(contraption);
    if (restoreState?.serverManaged === true) {
      contraption.serverExecutionMode = restoreState.serverExecutionMode || 'browser';
      contraption.serverHostingEnabled = restoreState.serverHostingEnabled === true;
      contraption.serverManaged = true;
      contraption.serverOwnerUserId = restoreState.serverOwnerUserId || null;
      contraption.serverOwnerName = restoreState.serverOwnerName || null;
      contraption.serverExecutorName = restoreState.serverExecutorName || null;
      contraption.serverExecutionLeaseExpiresAt = restoreState.serverExecutionLeaseExpiresAt || null;
      contraption.serverCanControl = restoreState.serverCanControl === true;
      contraption.serverCanEdit = restoreState.serverCanEdit === true;
      contraption.serverExecutesLocally = restoreState.serverExecutesLocally === true;
      contraption.serverExecutionEpoch = Number(restoreState.serverExecutionEpoch) || 0;
      contraption.serverRevision = Number(restoreState.serverRevision) || 0;
      contraption.serverPlaybackRevision = Number(restoreState.serverPlaybackRevision) || 0;
      contraption.serverDesiredRunState = restoreState.serverDesiredRunState || null;
      contraption.serverDefinitionDigest = restoreState.serverDefinitionDigest || null;
      contraption.serverSnapshotDigest = restoreState.serverSnapshotDigest || null;
    }
    if (restoreState) {
      try {
        this.restoreContraptionStreamingState(contraption, restoreState);
      } catch (error) {
        this.removeContraption(contraption, { preserveDormant: true, skipSave: true });
        throw error;
      }
    }
    if (autoSave) {
      this.saveEntitiesToStorage();
    }
    return contraption;
  }

  /** Merge an inventory entity into an existing stopped entity as a component subtree. */
  installSlotAsComponent(
    contraption: Contraption,
    slot: InventoryInput | null,
    parentNodeId: string,
    placementOrigin: THREE.Vector3,
    autoSave = true,
    preparedBlocks: RuntimeVoxel[] | null = null,
    placementRotation: THREE.Quaternion | number[] | null = null
  ) {
    if (!contraption || !this.contraptions.includes(contraption)) {
      return Object.freeze({ ok: false, reason: 'target_entity_missing' });
    }
    const result = contraption.installEntitySlot?.(
      slot,
      parentNodeId,
      placementOrigin,
      preparedBlocks,
      placementRotation
    ) || Object.freeze({ ok: false, reason: 'install_unsupported' });
    if (result.ok && autoSave) this.saveEntitiesToStorage();
    return result;
  }

  // =========================================================================
  // 3. CONTRAPTION DISASSEMBLY / SOLIDIFY (restore to static voxels)
  // =========================================================================

  disassembleContraption(contraption: Contraption, options: { skipRemoteDelete?: boolean } = {}) {
    if (!contraption || !this.world) return false;

    // Ensure running entities are stopped and reset to base rest pose before converting to voxels
    if (contraption.scriptStatus !== 'stopped') {
      contraption.stopAllNodeScripts?.();
    }

    const affectedChunks = new Set<Chunk>();

    for (const b of contraption.blocks) {
      const blockSize = b.size || 1;
      const localP = contraption.getBlockWorldCenter(b);

      if (blockSize < 1) {
        const targetMx = Math.round((localP.x - blockSize / 2) * MICRO_DIVISIONS);
        const targetMy = Math.round((localP.y - blockSize / 2) * MICRO_DIVISIONS);
        const targetMz = Math.round((localP.z - blockSize / 2) * MICRO_DIVISIONS);
        // Solidifying intentionally removes recursive entity motion metadata.
        this.world.setMicroBlock(targetMx, targetMy, targetMz, b.color, null, b.materialId);
        continue;
      }

      const targetX = Math.floor(localP.x);
      const targetY = Math.floor(localP.y);
      const targetZ = Math.floor(localP.z);

      if (targetY >= 0 && targetY < CHUNK_SIZE_Y) {
        this.world.setBlock(targetX, targetY, targetZ, BlockTypes.COLOR_BLOCK, false, b.color, b.materialId);
        const { cx, cz } = this.world.worldToChunkCoords(targetX, targetZ);
        const chunk = this.world.getChunk(cx, cz);
        if (chunk) affectedChunks.add(chunk);
      }
    }

    for (const chunk of affectedChunks) {
      chunk.isDirty = true;
      this.world.dirtyChunks.add(chunk);
    }

    if (this.sound) {
      this.sound.playDisassemblySound?.();
      this.sound.playSteamHiss?.();
    }
    if (this.particles) {
      this.particles.emitSteamPuff?.(contraption.position, 35);
    }

    this.removeContraption(contraption, {
      skipRemoteDelete: options.skipRemoteDelete === true
    });
    return true;
  }

  removeContraption(contraption: Contraption, options: { preserveDormant?: boolean; skipSave?: boolean; skipRemoteDelete?: boolean } = {}) {
    if (this.childSelection?.contraption === contraption) this.clearChildSelection();
    if (this.entitySelection?.contraption === contraption) {
      this.entitySelection.contraption.clearSubtreeHighlight?.();
      this.entitySelection = null;
    }
    const idx = this.contraptions.indexOf(contraption);
    if (idx !== -1) {
      this.contraptions.splice(idx, 1);
    }
    if (this.activeDrivable === contraption) {
      this.activeDrivable = null;
    }
    if (this.activeProgrammingContraption === contraption) {
      this.activeProgrammingContraption = this.contraptions[this.contraptions.length - 1] || null;
    }
    if (!options.preserveDormant) {
      this.deleteDormantContraption(contraption.publicId);
      if (
        this.entityPersistenceMode === 'remote'
        && options.skipRemoteDelete !== true
        && (contraption.serverManaged !== true || contraption.serverCanEdit === true)
      ) {
        this.remoteEntityPersistence?.remove?.(String(contraption.publicId));
      }
    }
    contraption.setActionContext?.(null);
    contraption.dispose();
    if (!options.skipSave) {
      this.saveEntitiesToStorage();
    }
  }

  // =========================================================================
  // 4. RAYCAST CONTRAPTIONS
  // =========================================================================

  raycastContraptionHit(rayOrigin: THREE.Vector3, rayDir: THREE.Vector3, maxDistance = 30) {
    let closestHit = null;
    let closestDist = maxDistance;

    for (const c of this.contraptions) {
      const hit = c.raycastCollisionCells(rayOrigin, rayDir, closestDist);
      if (!hit || hit.distance > closestDist) continue;
      closestDist = hit.distance;
      closestHit = hit;
    }

    return closestHit;
  }

  /** Entity picking counterpart to World.raycastBent: both inputs are in the
   * visible torus space and returned distances can be compared directly. */
  raycastContraptionHitBent(rayOriginBent: THREE.Vector3, rayDirBent: THREE.Vector3, maxDistance = 30) {
    let closestHit = null;
    let closestDist = maxDistance;

    for (const c of this.contraptions) {
      const hit = c.raycastBentCollisionCells(rayOriginBent, rayDirBent, closestDist);
      if (!hit || hit.distance > closestDist) continue;
      closestDist = hit.distance;
      closestHit = hit;
    }

    return closestHit;
  }

  raycastContraption(rayOrigin: THREE.Vector3, rayDir: THREE.Vector3, maxDistance = 30) {
    return this.raycastContraptionHit(rayOrigin, rayDir, maxDistance)?.contraption || null;
  }

  beginRenderInterpolation(alpha: number) {
    for (const contraption of this.contraptions) {
      contraption.beginRenderInterpolation?.(alpha);
    }
  }

  endRenderInterpolation() {
    for (const contraption of this.contraptions) {
      contraption.endRenderInterpolation?.();
    }
  }

  // =========================================================================
  // 5. UPDATE LOOP
  // =========================================================================

  /**
   * Physics, entity proximity, editor picks, and broadphase all run in flat
   * (unwrapped) torus coordinates, but each entity keeps whichever periodic
   * representative its motion drifted into. Two entities on opposite sides of
   * a seam are a whole period apart in flat space and never become collision
   * candidates - so "the same block collides at point A but not at point B"
   * exactly where B straddles the seam relative to the other entity's frame.
   * Re-anchor every active entity into the local player's periodic window:
   * the shift is an integer multiple of the period and is invisible to bent
   * rendering, wrapped chunk ids, and wrapped terrain queries.
   */
  reanchorEntitiesToPlayer(players: ScriptPlayer[] | null | undefined = null) {
    const local = Array.isArray(players)
      ? (players.find(player => player && player.id === 'local') || players[0])
      : null;
    const anchor = local?.position;
    if (!anchor || !Number.isFinite(anchor[0]) || !Number.isFinite(anchor[2])) return;
    for (const contraption of this.contraptions) {
      if (!contraption?.position) continue;
      const dx = unwrapPeriodicNear(contraption.position.x, anchor[0], TORUS_SIZE_X) - contraption.position.x;
      const dz = unwrapPeriodicNear(contraption.position.z, anchor[2], TORUS_SIZE_Z) - contraption.position.z;
      contraption.shiftFlatCoordinates?.(dx, dz);
    }
  }

  update(dt: number, inputState: ScriptInputState | null) {
    this.syncContraptionsToLoadedChunks();
    this.physics?.beginEntityUpdate?.(this.contraptions);
    const providedContext = this.runtimeContextProvider?.() || {};
    const runtimeContext = {
      ...providedContext,
      gravity: this.physics
        ? [this.physics.gravity.x, this.physics.gravity.y, this.physics.gravity.z]
        : [0, -18, 0],
      world: this.scriptWorldApi,
      selection: this.scriptSelectionApi
    };
    // 0. Before any entity captures its previous pose or integrates, keep every
    // active entity in the local player's periodic window.
    this.reanchorEntitiesToPlayer(providedContext.players);

    // 1. Update internal kinematics or programmable script evaluation for
    // every entity first, so every controller evaluates against the same
    // update-start state and every entity's swept "previous" pose is captured
    // before any body moves.
    const supportsSubstepFrames = !!(
      this.physics?.prepareContraptionFrame
      && this.physics?.stepContraptionFrame
    );
    const frames = [];
    for (let i = this.contraptions.length - 1; i >= 0; i--) {
      const c = this.contraptions[i];
      c.setActionContext?.({ manager: this, world: this.world });

      const isDriving = (this.activeDrivable === c);
      // Live keyboard input belongs only to the currently mounted entity.
      // Autonomous scripts keep running with a neutral snapshot after dismount.
      c.update(dt, isDriving ? inputState : null, runtimeContext);

      if (!this.physics) continue;
      if (supportsSubstepFrames) {
        const frame = this.physics.prepareContraptionFrame(c, dt);
        if (frame) frames.push(frame);
      } else {
        // Body type, not behavior mode, decides whether a body is integrated.
        // Kinematic bodies still enter this step so their contact velocity and
        // constraints against dynamic children stay current.
        this.physics.update(c, dt);
      }
    }

    // 2. Interleaved physics substeps. Terrain collision resolves inside every
    // substep, and entity-vs-entity collision resolves at the same substep
    // cadence, so a body resting on another entity is caught within a
    // millimetre of sinking - exactly like terrain - instead of falling
    // through the whole entity update first and being popped back afterwards.
    if (this.physics) {
      if (supportsSubstepFrames) {
        let maxSubSteps = 0;
        for (const frame of frames) maxSubSteps = Math.max(maxSubSteps, frame.subSteps);
        const substepCount = Math.max(1, maxSubSteps);
        const broadphaseBounds = new Map<Contraption, ReturnType<ContraptionPhysics['frameBroadphaseBounds']>>();
        if (broadphaseBounds) {
          for (const c of this.contraptions) {
            if (!c?.getRigidBodies?.().length) continue;
            broadphaseBounds.set(c, this.physics.frameBroadphaseBounds(c, dt));
          }
        }
        const pairFrame = this.physics.prepareContraptionPairFrame?.(
          this.contraptions,
          broadphaseBounds || undefined
        );
        for (let step = 0; step < substepCount; step++) {
          for (const frame of frames) {
            if (step < frame.subSteps) this.physics.stepContraptionFrame(frame);
          }
          // Entity vs entity collisions (dynamic-dynamic + dynamic-static)
          if (pairFrame && this.physics.resolvePreparedContraptionPairs) {
            this.physics.resolvePreparedContraptionPairs(pairFrame, dt / substepCount);
          } else {
            this.physics.resolveContraptionPairs?.(
              this.contraptions,
              dt / substepCount,
              broadphaseBounds || undefined
            );
          }
        }
        for (const frame of frames) this.physics.finishContraptionFrame(frame);
      } else {
        this.physics.resolveContraptionPairs?.(this.contraptions, dt);
      }
    }

    // 3. Safety checks: streaming edge and falling into the void.
    // Autonomous entities can cross the streaming edge during this physics
    // step. Snapshot and destroy them instead of allowing one extra off-chunk
    // script/physics update.
    for (let i = this.contraptions.length - 1; i >= 0; i--) {
      const c = this.contraptions[i];
      const chunk = this.getContraptionChunk(c);
      if (this.hasEntityStreamingWindow() && chunk && !this.world?.activeChunkKeys.has(chunk.id)) {
        this.unloadContraption(c);
        continue;
      }
      if (c.position.y < -30) {
        this.removeContraption(c);
      }
    }

    // 4. Periodic entity persistence
    if (this.entityPersistenceMode !== 'none') {
      this.lastEntitySaveTime = (this.lastEntitySaveTime || 0) + dt;
      const persistenceInterval = this.entityPersistenceMode === 'remote' ? 6.0 : 2.0;
      if (this.lastEntitySaveTime >= persistenceInterval) {
        this.lastEntitySaveTime = 0;
        if (this.contraptions.length > 0 || this.getDormantContraptionCount() > 0) {
          this.saveEntitiesToStorage();
        }
      }
    }
  }
}
