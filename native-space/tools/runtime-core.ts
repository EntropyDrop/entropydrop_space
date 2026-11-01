/** Transitional engine adapter. It owns simulation only; no browser or GPU. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  THREE, World, ContraptionManager, ContraptionPhysics,
  portableEntityToRuntime, decodeInventoryResource, preloadAssemblyScriptRuntime,
} from '../../engine/src/index.ts';
import { Chunk } from '../../engine/src/voxel/Chunk.ts';
import type { Contraption } from '../../engine/src/contraption/Contraption.ts';

type Cell = { x: number; y: number; z: number; micro: boolean };
type Entity = { id: string; bytes: number[]; position: number[]; rotation: number[]; running: boolean };
export type Request = {
  epoch: number; chunks: number[][]; edits: [Cell, number][];
  entities?: Entity[]; steps: number; down: string[]; player: number[];
  driver?: { id: string; component: string; seat: number } | null;
};
const mod = (v: number, n: number) => ((v % n) + n) % n;
const keyOf = (c: Cell) => `${c.micro ? 'm' : 's'}:${c.x}:${c.y}:${c.z}`;
const pack = (rgb: number, material = 0) => ((rgb & 0xffffff) | ((material + 1) << 24)) >>> 0;

export class NativeRuntime {
  readonly scene = new THREE.Scene();
  readonly world: World;
  readonly manager: ContraptionManager;
  private entries = new Map<string, { c: Contraption; signature: string; running: boolean; geometry: number }>();
  private edits = new Map<string, [Cell, number]>();
  private mutations: [Cell, number][] = [];
  private previousKeys = new Set<string>();
  private player = [0, 0, 0];
  private driver: Request['driver'] = null;
  readonly worldDir: string;

  constructor(worldDir: string) {
    this.worldDir = resolve(worldDir);
    const manifest = JSON.parse(readFileSync(join(worldDir, 'manifest.json'), 'utf8'));
    this.world = new World(this.scene, manifest.seed, null, manifest.generator, true);
    // Only cached, explicitly streamed terrain is available to the adapter.
    this.world.getOrCreateChunk = (cx, cz) => {
      const chunk = this.world.getChunk(mod(cx, 1024), mod(cz, 128));
      if (!chunk) throw Error('Terrain is not loaded at the requested location');
      return chunk;
    };
    this.manager = new ContraptionManager(this.scene, this.world, null, null);
    this.manager.setWorldIdentity({ id: `native:${manifest.world}`, slug: manifest.world, name: manifest.world });
    this.manager.setPhysics(new ContraptionPhysics(this.world));
    this.manager.entityPersistenceMode = 'remote';
    this.manager.syncContraptionsToLoadedChunks = () => {};
    this.manager.setRuntimeContextProvider(() => ({
      players: [{ id: 'local', isLocal: true, position: this.player, eyePosition: this.player,
        feetPosition: [this.player[0], this.player[1] - 1.65, this.player[2]],
        ridingEntityId: this.driver?.id ?? null, ridingBodyId: this.driver?.component ?? null }],
      driver: this.driver ? { entityId: this.driver.id, componentId: this.driver.component,
        seatIndex: this.driver.seat, playerId: 'local' } : null,
      messages: { send: (sourceId: string, targetId: unknown, type: unknown, payload: unknown, encoding: unknown) => {
        const target = this.entries.get(String(targetId));
        if (!target) return { ok: false, reason: 'target_not_local' };
        const ok = target.c.enqueueEntityMessage({ messageId: crypto.randomUUID(), sourceId,
          targetId: String(targetId), type: String(type), encoding, payload });
        return { ok, reason: ok ? 'delivered' : 'invalid_message' };
      } },
    }));
    this.world.editPersistence = {
      recordStandard: (x: number, y: number, z: number, block: number, rgb: number, material = 0) =>
        this.record({ x: mod(x, 16384), y, z: mod(z, 2048), micro: false }, block ? pack(rgb, material) : 0),
      recordMicro: (x: number, y: number, z: number, rgb: number, _part: unknown, material = 0) =>
        this.record({ x: mod(x, 131072), y, z: mod(z, 16384), micro: true }, pack(rgb, material)),
      removeMicro: (x: number, y: number, z: number) =>
        this.record({ x: mod(x, 131072), y, z: mod(z, 16384), micro: true }, 0),
      removeMicroStandardCell: (x: number, y: number, z: number) => {
        // Rust's standard edit clears generated micro cells and records undo.
        const cell = { x: mod(x, 16384), y, z: mod(z, 2048), micro: false };
        this.record(cell, this.world.getBlock(x, y, z)
          ? pack(this.world.getBlockColor(x, y, z), this.world.getBlockMaterial(x, y, z)) : 0);
      },
      canAcceptLocalMutation: () => this.mutations.length < 4096,
    } as any;
  }

  private record(cell: Cell, value: number) {
    if (this.mutations.length >= 4096) throw Error('Native terrain mutation budget exceeded');
    this.edits.set(keyOf(cell), [cell, value]);
    this.mutations.push([cell, value]);
  }

  private apply(cell: Cell, value: number) {
    const scale = cell.micro ? 8 : 1;
    const cx = Math.floor(cell.x / (16 * scale)), cz = Math.floor(cell.z / (16 * scale));
    const chunk = this.world.getChunk(cx, cz);
    if (!chunk) return;
    if (cell.micro) {
      if (value === 0) this.world.microVoxels.delete(cell.x, cell.y, cell.z);
      else this.world.microVoxels.set(cell.x, cell.y, cell.z, value & 0xffffff, null, (value >>> 24) - 1);
    } else {
      this.world.microVoxels.clearStandardCell(cell.x, cell.y, cell.z);
      chunk.setLocalBlock(mod(cell.x, 16), cell.y, mod(cell.z, 16), value ? 1 : 0, value & 0xffffff,
        value ? (value >>> 24) - 1 : 0);
    }
  }

  private load(cx: number, cz: number) {
    const key = `${cx},${cz}`;
    if (this.world.chunks.has(key)) return;
    const data = gunzipSync(readFileSync(join(this.worldDir, 'chunks', `${cx}_${cz}.bin.gz`)),
      { maxOutputLength: 32 * 1024 * 1024 });
    const base = 16 + 65536 * 4;
    if (data.toString('ascii', 0, 4) !== 'SPC1' || data.length < base
      || data.readUInt32LE(4) !== cx || data.readUInt32LE(8) !== cz
      || data.length !== base + data.readUInt32LE(12) * 16) throw Error('Invalid native chunk');
    const chunk = new Chunk(cx, cz, null);
    for (let i = 0; i < 65536; i++) {
      const value = data.readUInt32LE(16 + i * 4);
      if (value) chunk.setLocalBlock(i % 16, Math.floor(i / 256), Math.floor(i / 16) % 16,
        1, value & 0xffffff, (value >>> 24) - 1);
    }
    chunk.world = this.world; chunk.hasGenerated = true;
    this.world.chunks.set(key, chunk);
    for (let i = base; i < data.length; i += 16) {
      const value = data.readUInt32LE(i + 12);
      this.world.microVoxels.set(cx * 128 + data.readUInt32LE(i), data.readUInt32LE(i + 4),
        cz * 128 + data.readUInt32LE(i + 8), value & 0xffffff, null, (value >>> 24) - 1);
    }
    // Apply whole cells before micro cells, independent of edit insertion order.
    // Otherwise reloading a chunk after undo can clear a restored micro voxel.
    for (const micro of [false, true]) for (const [cell, value] of this.edits.values()) {
      const divisor = cell.micro ? 128 : 16;
      if (cell.micro === micro && Math.floor(cell.x / divisor) === cx && Math.floor(cell.z / divisor) === cz)
        this.apply(cell, value);
    }
  }

  private async synchronize(entities: Entity[]) {
    const keep = new Set(entities.map(e => e.id));
    for (const [id, entry] of this.entries) if (!keep.has(id)) {
      this.manager.removeContraption(entry.c, { skipSave: true, skipRemoteDelete: true }); this.entries.delete(id);
    }
    for (const entity of entities) {
      const signature = createHash('sha256').update(Buffer.from(entity.bytes))
        .update(JSON.stringify([entity.position, entity.rotation])).digest('hex');
      let entry = this.entries.get(entity.id);
      if (entry && entry.signature !== signature) {
        this.manager.removeContraption(entry.c, { skipSave: true, skipRemoteDelete: true });
        this.entries.delete(entity.id); entry = undefined;
      }
      if (!entry) {
        const decoded = decodeInventoryResource(Uint8Array.from(entity.bytes), 'entity');
        const slot = portableEntityToRuntime(decoded.portable);
        slot.blocks = slot.blocks.map(b => ({ ...b, localX: b.dx + (b.mx ?? 0) / 8,
          localY: b.dy + (b.my ?? 0) / 8, localZ: b.dz + (b.mz ?? 0) / 8, size: b.mx == null ? 1 : 0.125 }));
        const origin = new THREE.Vector3().fromArray(entity.position);
        const c = this.manager.buildFromSlot(slot, origin, null, false);
        if (!c) throw Error(`Cannot construct entity ${entity.id}`);
        c.publicId = entity.id;
        const rotation = new THREE.Quaternion().fromArray(entity.rotation).normalize();
        c.position.copy(origin).add(c.localCenter.clone().applyQuaternion(rotation));
        c.quaternion.copy(rotation); c.updateTransform();
        await c.scriptRuntimeClient.ready();
        c.stopAllNodeScripts();
        entry = { c, signature, running: false, geometry: -1 }; this.entries.set(entity.id, entry);
      }
      if (entry.running !== entity.running) {
        if (entity.running) { entry.c.enableAllNodeScripts(); await entry.c.scriptRuntimeClient.ready(); }
        else entry.c.stopAllNodeScripts();
        entry.running = entity.running;
      }
    }
  }

  async step(request: Request) {
    if (!Number.isInteger(request.steps) || request.steps < 0 || request.steps > 5
      || request.chunks.length > 1600 || (request.entities?.length ?? 0) > 1024)
      throw Error('Native runtime request exceeds bounds');
    await preloadAssemblyScriptRuntime();
    this.mutations = []; this.player = request.player; this.driver = request.driver;
    const keep = new Set<string>();
    for (const [x, z] of request.chunks) {
      if (!Number.isInteger(x) || !Number.isInteger(z) || x < 0 || x >= 1024 || z < 0 || z >= 128)
        throw Error('Invalid native chunk coordinate');
      keep.add(`${x},${z}`); this.load(x, z);
    }
    for (const [key, chunk] of this.world.chunks) if (!keep.has(key)) {
      this.world.microVoxels.clearChunk(chunk.cx, chunk.cz); this.world.chunks.delete(key);
    }
    for (const [cell, value] of request.edits) { this.edits.set(keyOf(cell), [cell, value]); this.apply(cell, value); }
    if (request.entities) await this.synchronize(request.entities);
    this.manager.activeDrivable = this.driver ? this.entries.get(this.driver.id)?.c ?? null : null;
    const keys = new Set(request.down);
    const pressed = [...keys].filter(k => !this.previousKeys.has(k));
    const released = [...this.previousKeys].filter(k => !keys.has(k));
    for (let i = 0; i < request.steps; i++) this.manager.update(1 / 60,
      { down: keys, pressed: i === 0 ? pressed : [], released: i === 0 ? released : [] });
    if (request.steps) this.previousKeys = keys;
    const entities = [];
    for (const [id, entry] of this.entries) {
      const c = entry.c;
      c.rootGroup.updateMatrixWorld(true);
      const nodes = [];
      for (const node of c.entityNodes.values()) {
        const model = node.group.matrixWorld.clone().multiply(new THREE.Matrix4()
          .makeTranslation(-node.pivotLocal.x, -node.pivotLocal.y, -node.pivotLocal.z));
        nodes.push({ id: node.id, model: model.toArray(),
          voxels: entry.geometry !== c.definitionVersion ? c.blocks.filter(b => b.entityId === node.id)
            .map(b => [b.localX, b.localY, b.localZ, b.size ?? 1, b.color, b.materialId ?? 0]) : null,
          decorations: c.getRuntimeComponentDecorations(node.id),
          seats: c.getComponentSeats(node.id).map((_, index) => ({ index,
            position: c.getSeatWorldPosition(node.id, index)?.toArray(),
            rotation: c.getSeatWorldQuaternion(node.id, index)?.toArray() })),
        });
      }
      entry.geometry = c.definitionVersion;
      entities.push({ id, nodes, running: c.isPhysicsSimulationEnabled(),
        status: c.scriptStatus, error: c.scriptError || [...c.nodeScriptErrors.values()].join('\n') || null,
        logs: c.scriptLogs.slice(-12), position: c.position.toArray(), velocity: c.velocity.toArray() });
    }
    this.world.dirtyChunks.clear();
    return { epoch: request.epoch, entities, mutations: this.mutations };
  }

  close() {
    for (const c of [...this.manager.contraptions])
      this.manager.removeContraption(c, { skipSave: true, skipRemoteDelete: true });
  }
}
