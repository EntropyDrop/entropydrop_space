import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Chunk } from '../src/voxel/Chunk.ts';
import { LowPolyMesher } from '../src/mesher/LowPolyMesher.ts';
import { BodyType, Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { createCollisionSampleTemplate } from '../src/physics/CollisionSamples.ts';
import { setTerrainKernelMode } from '../src/wasm/TerrainKernels.ts';

for (const colorManagement of [true, false]) test(`standard WASM mesh preserves every byte and streaming cut face (color management ${colorManagement})`, () => {
  const previous = setTerrainKernelMode('js'), enabled = THREE.ColorManagement.enabled;
  try {
    THREE.ColorManagement.enabled = colorManagement;
    const chunk = new Chunk(1023, 127, null), mesher = new LowPolyMesher();
    for (let y = 0; y < 20; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      if ((x * 13 + y * 3 + z * 11) % 7) chunk.setLocalBlock(x, y, z, 1, [0, 0xffffff, 0x88ab23][x % 3], z % 2);
    }
    chunk.setLocalBlock(0, 255, 0, 1, 0xff00aa, 1);
    const neighbor = new Chunk(0, 0, null); neighbor.blocks.fill(1);
    const world = { worldToChunkCoords: (x: number, z: number) => ({ cx: ((Math.floor(x / 16) % 1024) + 1024) % 1024,
      cz: ((Math.floor(z / 16) % 128) + 128) % 128 }), getChunk: () => neighbor };
    for (const state of ['isolated', 'predicted', 'generated', 'missing']) {
      chunk.world = state === 'isolated' ? null : state === 'missing' ? { ...world, getChunk: () => null } : world;
      neighbor.hasGenerated = state === 'generated';
      setTerrainKernelMode('js'); const expected = mesher.buildChunkMeshData(chunk);
      setTerrainKernelMode('wasm'); assert.deepEqual(mesher.buildChunkMeshData(chunk), expected, state);
    }
    const empty = new Chunk(0, 0, null);
    setTerrainKernelMode('js'); const expected = mesher.buildChunkMeshData(empty);
    setTerrainKernelMode('wasm'); assert.deepEqual(mesher.buildChunkMeshData(empty), expected);
  } finally { setTerrainKernelMode(previous); THREE.ColorManagement.enabled = enabled; }
});

test('standard WASM mesh supports worst-case height, scratch budget and Uint32 indices', () => {
  const previous = setTerrainKernelMode('js');
  try {
    const chunk = new Chunk(0, 0, null), mesher = new LowPolyMesher();
    for (let y = 0; y < 256; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      if ((x + y + z) % 2 === 0) chunk.setLocalBlock(x, y, z, 1, 0xffffff, y % 2);
    }
    const expected = mesher.buildChunkMeshData(chunk);
    assert.ok(expected.indices instanceof Uint32Array);
    setTerrainKernelMode('wasm'); assert.deepEqual(mesher.buildChunkMeshData(chunk), expected);
    assert.equal(expected.indices.length, 32768 * 6 * 6);
  } finally { setTerrainKernelMode(previous); }
});

function entity(micro = false) {
  const blocks = [];
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) blocks.push({
    localX: x, localY: 0, localZ: z, size: 1, block: 1, entityId: 'root',
  });
  if (micro) for (let x = 0; x < 24; x++) for (let y = 8; y < 20; y++) blocks.push({
    localX: x / 8, localY: y / 8, localZ: 0, size: 0.125, block: 1, entityId: 'root',
  });
  return new Contraption('sampling', blocks, new THREE.Vector3(16383, 3, -1), new THREE.Scene(), { bodyType: BodyType.DYNAMIC });
}

function assertSampleParity(c: Contraption) {
  for (const id of [null, ...c.entityNodes.keys()]) for (const attached of [false, true]) {
    setTerrainKernelMode('js'); c.invalidateCollisionPoseCache();
    const expected = c.getCollisionSamplePoints(id, attached).map(p => p.toArray());
    setTerrainKernelMode('wasm'); c.invalidateCollisionPoseCache();
    assert.deepEqual(c.getCollisionSamplePoints(id, attached).map(p => p.toArray()), expected);
  }
}

test('cached WASM collision probes preserve order across poses, components, enable flags and edits', () => {
  const previous = setTerrainKernelMode('wasm');
  for (const micro of [false, true]) {
    const c = entity(micro);
    try {
      assertSampleParity(c);
      const template = (c as any).collisionSampleTemplate.data;
      const oldPoints = c.getCollisionSamplePoints().map(p => p.toArray());
      c.position.add(new THREE.Vector3(2, 3, -1)); c.quaternion.setFromEuler(new THREE.Euler(.3, .7, -.2)); c.updateTransform();
      assertSampleParity(c);
      assert.equal((c as any).collisionSampleTemplate.data, template, 'pose updates reuse local probes');
      assert.notDeepEqual(c.getCollisionSamplePoints().map(p => p.toArray()), oldPoints);
      assert.ok(c.createChildEntity('root', new Set(['0,0,0', '1,0,0']), 'base'));
      assertSampleParity(c);
      c.setNodeCollisionEnabled('base', false); assertSampleParity(c);
      c.setNodeCollisionEnabled('base', true); c.setNodeBodyType('base', BodyType.DYNAMIC); assertSampleParity(c);
      c.blocks.splice(3, 1); c.rebuildAfterBlockChange(); assertSampleParity(c);
    } finally { c.dispose(); setTerrainKernelMode(previous); }
  }
});

test('oversized probe templates retain the reference fallback', () => {
  assert.equal(createCollisionSampleTemplate([{ x: 0, y: 0, z: 0, span: 100000, entityId: 'root' }], true), null);
});

test('WASM collision probes and empty broadphase preserve full falling-body trajectories', () => {
  const previous = setTerrainKernelMode('js');
  const run = (wasm: boolean) => {
    setTerrainKernelMode(wasm ? 'wasm' : 'js');
    const c = entity(true), history = [];
    const physics = new ContraptionPhysics({ getBlock: (_x: number, y: number) => y < 1 ? 1 : 0,
      getMicroCollisionBoxesInAABB: () => [], getMicroCollisionBlock: () => null,
      raycast: () => ({ hit: false }), raycastMicro: () => ({ hit: false }) } as any);
    if (!wasm) (physics as any).canSkipEmptyTerrainSamples = () => false;
    c.quaternion.setFromEuler(new THREE.Euler(.2, .1, .3)); c.updateTransform();
    try {
      for (let frame = 0; frame < 100; frame++) {
        physics.update(c, .05);
        history.push([...c.position.toArray(), ...c.quaternion.toArray(), ...c.velocity.toArray(), ...c.angularVelocity.toArray(), c.isOnGround]);
      }
      return history;
    } finally { c.dispose(); }
  };
  try { assert.deepEqual(run(true), run(false)); }
  finally { setTerrainKernelMode(previous); }
});

test('empty terrain shortcut cannot bypass fast sweeps, scaled geometry or point-only micro hosts', () => {
  const physics = new ContraptionPhysics({ getBlock: () => 0, microVoxels: { get: () => 0 } } as any) as any;
  assert.equal(physics.canSkipEmptyTerrainSamples([{ coversSamples: true }], false, false), false);
  physics.world = { getBlock: () => 0, getMicroCollisionBoxesInAABB: () => [] };
  assert.equal(physics.canSkipEmptyTerrainSamples([{ coversSamples: true }], true, true), false);
  assert.equal(physics.canSkipEmptyTerrainSamples([{ coversSamples: false }], false, true), false);
  assert.equal(physics.canSkipEmptyTerrainSamples([], false, true), false);
  assert.equal(physics.canSkipEmptyTerrainSamples([{ coversSamples: true }], false, true), true);
  const bounds = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }, coverage = { complete: false };
  physics.terrainBoxesOverlapping(bounds, coverage); assert.equal(coverage.complete, true);
  physics.world = { getBlock: () => 0, getMicroCollisionBoxesInAABB: () => undefined,
    getMicroBlocksInAABB: () => undefined, getMicroCollisionBlock: () => 0 };
  physics.terrainBoxesOverlapping(bounds, coverage); assert.equal(coverage.complete, false);
});
