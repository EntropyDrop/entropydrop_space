import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../src/voxel/World.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { TerrainDecorationLayer } from '../src/voxel/TerrainDecorationLayer.ts';
import { TORUS_SIZE_X } from '../src/torus/TorusWorld.ts';
import { WorldEditPersistence, type TerrainMutation, type WorldEditStorage } from '../src/voxel/WorldEditPersistence.ts';
import { decodeInventoryResource, encodeInventoryResource } from '../src/storage/InventoryProtobuf.ts';

class MemoryStorage implements WorldEditStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const trim = (fields: Record<string, unknown> = {}) => ({ id: 'd_trim', x: 3, y: 40, z: 3, color: 0x123456, ...fields });

test('the layer indexes decorations by anchor chunk and wraps anchors onto the torus', () => {
  const layer = new TerrainDecorationLayer();
  const changes: string[] = [];
  layer.onChange(key => changes.push(key));
  const stored = layer.upsert(trim({ x: TORUS_SIZE_X + 3, position: [0, 0.5, 0] }));
  assert.equal(stored.x, 3);
  assert.equal(layer.get(3, 3, 'd_trim'), stored);
  assert.equal(layer.upsert(trim({ x: 3, position: [0, 0.5, 0] })), stored, 'equal values are not re-published');
  layer.upsert(trim({ id: 'd_other' }));
  layer.upsert(trim({ id: 'd_far', x: 40 }));
  assert.deepEqual(changes, ['0,0', '0,0', '2,0']);
  assert.deepEqual(layer.removeAtAnchor(3, 40, 3).map(value => value.id).sort(), ['d_other', 'd_trim']);
  assert.equal(layer.size, 1);
  assert.throws(() => layer.upsert(trim({ position: [0, 17, 0] })), /within ±16/);
  assert.throws(() => layer.upsert(trim({ scale: [17, 1, 1] })), /at most 16/);
  assert.equal(layer.replaceChunk('2,0', []), true);
  assert.equal(layer.size, 0);
});

test('world decorations require a standard anchor and are removed with it, including subdivision', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setBlock(3, 40, 3, BlockTypes.AIR, false);
  assert.throws(() => world.setTerrainDecoration(trim()), /standard terrain blocks/);
  world.setBlock(3, 40, 3, BlockTypes.COLOR_BLOCK, false, 0x48dbfb);
  world.setTerrainDecoration(trim());
  world.setTerrainDecoration(trim({ id: 'd_two' }));
  assert.equal(world.terrainDecorations.atAnchor(3, 40, 3).length, 2);
  world.setBlockColor(3, 40, 3, 0xff0000, false);
  assert.equal(world.terrainDecorations.atAnchor(3, 40, 3).length, 2, 'painting keeps decorations');
  world.subdivideBlock(3, 40, 3);
  assert.equal(world.terrainDecorations.size, 0, 'subdividing removes the standard voxel');
  world.setBlock(4, 40, 3, BlockTypes.COLOR_BLOCK, false);
  world.setTerrainDecoration(trim({ x: 4 }));
  world.setBlock(4, 40, 3, BlockTypes.AIR, false);
  assert.equal(world.terrainDecorations.size, 0);
});

test('decoration edits enter the outbox and survive a refresh in local mode', () => {
  const storage = new MemoryStorage();
  const persistence = { worldId: 'decorated-world', storage };
  const first = new World(new THREE.Scene(), 1337, persistence) as any;
  first.setBlock(3, 40, 3, BlockTypes.COLOR_BLOCK, false);
  first.setTerrainDecoration(trim({ materialId: 1, rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] }));
  first.setBlock(5, 40, 3, BlockTypes.COLOR_BLOCK, false);
  first.setTerrainDecoration(trim({ id: 'd_gone', x: 5 }));
  first.setBlock(5, 40, 3, BlockTypes.AIR, false);
  first.flushPersistedEdits();
  const second = new World(new THREE.Scene(), 1337, persistence) as any;
  assert.deepEqual([...second.terrainDecorations.all()].map((value: any) => [value.id, value.materialId]), [['d_trim', 1]]);
});

test('remote snapshots replace decorations, then replay the unacknowledged outbox', async () => {
  const sent: TerrainMutation[][] = [];
  const layer = new TerrainDecorationLayer();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const persistence = new WorldEditPersistence({
    worldId: 'remote-decorations', storage: new MemoryStorage(), decorations: layer, saveDelayMs: 0,
    remote: {
      chunks: [{ chunk_x: 0, chunk_z: 0, revision: 1, standard: [[3, 40, 3, 1, 1]], micro: [],
        decorations: [{ id: 'd_remote', x: 3, y: 40, z: 3, color: 9, material: 1 }] }],
      async sendBatch(_id, mutations) { sent.push(mutations); await pending; return { chunks: [] }; },
    },
  });
  assert.equal(layer.get(3, 3, 'd_remote')?.materialId, 1);
  const local = layer.upsert(trim({ id: 'd_local' }));
  persistence.recordDecoration(local);
  persistence.replaceRemoteChunk({ chunk_x: 0, chunk_z: 0, revision: 2, standard: [[3, 40, 3, 1, 1]], micro: [],
    decorations: [{ id: 'd_other', x: 3, y: 40, z: 3, color: 2 }] });
  assert.deepEqual([...layer.forChunk(0, 0)].map(value => value.id).sort(), ['d_local', 'd_other'],
    'the authoritative snapshot wins, with the local pending edit replayed');
  persistence.recordStandard(3, 40, 3, BlockTypes.AIR, 0);
  persistence.replaceRemoteChunk({ chunk_x: 0, chunk_z: 0, revision: 3, standard: [[3, 40, 3, 1, 1]], micro: [],
    decorations: [{ id: 'd_other', x: 3, y: 40, z: 3, color: 2 }] });
  assert.equal(layer.size, 0, 'a pending AIR edit removes snapshot decorations on its anchor');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(sent[0]?.map(mutation => mutation.kind), ['set_decoration', 'set_standard']);
  release();
});

test('BlockSet decorations round-trip through Protobuf and must sit on standard voxels', () => {
  const portable = {
    type: 'space-blockset', version: 8, name: 'Sign',
    blocks: [{ dx: 0, dy: 0, dz: 0, color: 1 }, { dx: 1, dy: 0, dz: 0, mx: 1, my: 2, mz: 3, color: 2 }],
    decorations: [
      { dx: 0, dy: 0, dz: 0, color: 5, position: [0, 0.5, 0], materialId: 1 },
      { dx: 0, dy: 0, dz: 0, color: 3, rotation: [0, 0, 0, -1] },
    ],
  };
  const decoded = decodeInventoryResource(encodeInventoryResource('blockset', portable));
  assert.deepEqual((decoded.portable as any).decorations, [
    { dx: 0, dy: 0, dz: 0, color: 3 },
    { dx: 0, dy: 0, dz: 0, color: 5, materialId: 1, position: [0, 0.5, 0] },
  ]);
  assert.deepEqual(encodeInventoryResource('blockset', decoded.portable), encodeInventoryResource('blockset', portable));
  assert.throws(() => encodeInventoryResource('blockset', { ...portable, decorations: [{ dx: 1, dy: 0, dz: 0, color: 1 }] }),
    /anchored to one of its standard voxels/);
});

test('disassembly binds each decoration to the nearest written standard voxel, preserving its world pose', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const manager = new ContraptionManager(scene, world, null, null);
  for (const x of [3, 4]) world.setBlock(x, 40, 3, BlockTypes.COLOR_BLOCK, false, 0x48dbfb);
  manager.setCornerA({ x: 3, y: 40, z: 3 });
  manager.setCornerB({ x: 4, y: 40, z: 3 });
  const entity = manager.assembleSelection() as any;
  const local = entity.worldToEntityLocal(entity.rootComponentId, new THREE.Vector3(5.2, 40.5, 3.5));
  entity.setComponentDecorations(entity.rootComponentId, [
    { id: 'near', color: 7, position: local.toArray(), scale: [0.4, 1, 1] },
    { id: 'huge', color: 8, scale: [40, 1, 1] },
  ]);
  assert.equal(manager.disassembleContraption(entity), true);
  assert.deepEqual(manager.lastDisassemblyDecorations, { placed: 1, skipped: 1 });
  const [bound] = world.terrainDecorations.atAnchor(4, 40, 3);
  assert.equal(bound.color, 7);
  assert.ok(Math.abs(bound.position[0] - 0.7) < 1e-6 && Math.abs(bound.position[1]) < 1e-6);
});

test('assembly carries terrain decorations onto the entity and disassembly puts them back', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const manager = new ContraptionManager(scene, world, null, null);
  // x = 15 and 16 sit in different chunks, so the shared id must not collide on the entity.
  for (const x of [15, 16]) world.setBlock(x, 40, 3, BlockTypes.COLOR_BLOCK, false, 0x48dbfb);
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 6);
  world.setTerrainDecoration({
    id: 'd_wing', x: 16, y: 40, z: 3, color: 7, materialId: 1,
    position: [0.7, 0.25, 0], rotation: tilt.toArray(), scale: [0.4, 1, 2],
  });
  world.setTerrainDecoration({ id: 'd_wing', x: 15, y: 40, z: 3, color: 9 });
  manager.setCornerA({ x: 15, y: 40, z: 3 });
  manager.setCornerB({ x: 16, y: 40, z: 3 });

  const entity = manager.assembleSelection() as any;
  assert.ok(entity);
  assert.deepEqual(manager.lastAssemblyDecorations, { placed: 2, skipped: 0 });
  assert.equal(world.terrainDecorations.size, 0, 'the terrain no longer holds them');
  const decorations = entity.getComponentDecorations(entity.rootComponentId);
  assert.equal(decorations.length, 2);
  assert.equal(new Set(decorations.map((value: any) => value.id)).size, 2, 'ids stay unique within the component');
  const wing = decorations.find((value: any) => value.color === 7);
  assert.equal(wing.materialId, 1);
  assert.deepEqual(wing.scale, [0.4, 1, 2]);
  const center = entity.entityLocalToWorld(entity.rootComponentId, new THREE.Vector3().fromArray(wing.position));
  assert.ok(center.distanceTo(new THREE.Vector3(17.2, 40.75, 3.5)) < 1e-6, 'world position is kept');
  const worldRotation = entity.getEntityNodeWorldQuaternion(entity.rootComponentId)
    .multiply(new THREE.Quaternion().fromArray(wing.rotation));
  assert.ok(worldRotation.angleTo(tilt) < 1e-6, 'world rotation is kept');

  assert.equal(manager.disassembleContraption(entity), true);
  assert.deepEqual(manager.lastDisassemblyDecorations, { placed: 2, skipped: 0 });
  const [back] = world.terrainDecorations.atAnchor(16, 40, 3);
  assert.equal(back.color, 7);
  assert.ok(back.position.every((value: number, axis: number) => Math.abs(value - [0.7, 0.25, 0][axis]) < 1e-6));
  assert.ok(new THREE.Quaternion().fromArray(back.rotation).angleTo(tilt) < 1e-6);
  assert.equal(world.terrainDecorations.atAnchor(15, 40, 3)[0].color, 9);
});

test('connected-cell assembly carries only the decorations of the selected voxels', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const manager = new ContraptionManager(scene, world, null, null);
  for (const x of [3, 4, 5]) world.setBlock(x, 40, 3, BlockTypes.COLOR_BLOCK, false, 0x48dbfb);
  world.setTerrainDecoration(trim({ id: 'd_in', x: 4 }));
  world.setTerrainDecoration(trim({ id: 'd_out', x: 5 }));
  manager.setConnectedSelection([{ x: 3, y: 40, z: 3 }, { x: 4, y: 40, z: 3 }]);

  const entity = manager.assembleSelection() as any;
  assert.ok(entity);
  assert.deepEqual(entity.getComponentDecorations(entity.rootComponentId).map((value: any) => value.id), ['d_in']);
  assert.deepEqual(world.terrainDecorations.atAnchor(5, 40, 3).map((value: any) => value.id), ['d_out'],
    'unselected voxels keep their decorations');
});

test('assembly skips decorations beyond the entity limit and reports them', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const manager = new ContraptionManager(scene, world, null, null);
  // Five chunks of 256 decorations: 1,280 in all, against an entity limit of 1,024.
  for (const x of [0, 16, 32, 48, 64]) {
    world.setBlock(x, 40, 3, BlockTypes.COLOR_BLOCK, false, 0x48dbfb);
    for (let index = 0; index < 256; index++) world.setTerrainDecoration(trim({ id: `d_${index}`, x }));
  }
  manager.setCornerA({ x: 0, y: 40, z: 3 });
  manager.setCornerB({ x: 64, y: 40, z: 3 });

  const entity = manager.assembleSelection() as any;
  assert.ok(entity);
  assert.deepEqual(manager.lastAssemblyDecorations, { placed: 1024, skipped: 256 });
  assert.equal(entity.getDecorationCount(), 1024);
  assert.equal(world.terrainDecorations.size, 0);
});
