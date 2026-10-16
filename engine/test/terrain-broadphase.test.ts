import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../src/voxel/World.ts';
import { Chunk } from '../src/voxel/Chunk.ts';
import { Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { CollisionBoxIndex } from '../src/physics/CollisionGeometry.ts';
import type { PhysicsTerrain } from '../src/physics/PhysicsTerrain.ts';
import { TORUS_SIZE_X } from '../src/torus/TorusWorld.ts';

function world() {
  const world = new World(new THREE.Scene());
  for (const cx of [0, 1, TORUS_SIZE_X / 16 - 1]) for (const cz of [0, 1]) {
    const chunk = new Chunk(cx, cz, null);
    chunk.mesh = new THREE.Group();
    world.chunks.set(`${cx},${cz}`, chunk);
  }
  return world;
}
function cell(world: World, x: number, y: number, z: number, solid = 1) {
  const { cx, cz, lx, lz } = world.worldToChunkCoords(x, z);
  world.getChunk(cx, cz)!.setLocalBlock(lx, y, lz, solid);
}
function legacy(world: World): PhysicsTerrain {
  return { getBlock: world.getBlock.bind(world), raycast: world.raycast.bind(world),
    terrainVersion: world.terrainVersion, activeChunkKeys: world.activeChunkKeys,
    getTerrainCollisionStamp: world.getTerrainCollisionStamp.bind(world),
    raycastMicro: world.raycastMicro.bind(world), raycastMicroCollision: world.raycastMicroCollision.bind(world),
    getMicroCollisionBlock: world.getMicroCollisionBlock.bind(world),
    getMicroCollisionBoxesInAABB: world.getMicroCollisionBoxesInAABB.bind(world) };
}
function body(blocks = [{ localX: 0, localY: 0, localZ: 0, block: 1 }]) {
  return new Contraption('test', structuredClone(blocks), new THREE.Vector3(3, 102, 3), new THREE.Scene());
}

test('chunk batch queries equal unit cell queries across boundaries, wrapping and edits', () => {
  const w = world(), old = new ContraptionPhysics(legacy(w));
  for (let x = -2; x <= 18; x++) for (let z = 0; z < 18; z++) for (let y = 99; y < 104; y++) {
    if ((x * x + z * 7 + y) % 5 === 0) cell(w, x, y, z);
  }
  for (const bounds of [
    { minX: -2, maxX: 18, minY: 98, maxY: 105, minZ: 0, maxZ: 18 },
    { minX: -0.5, maxX: 0, minY: 100, maxY: 101, minZ: 1, maxZ: 2 },
    { minX: 15.9, maxX: 16.1, minY: -10, maxY: 300, minZ: 15.9, maxZ: 16.1 },
  ]) {
    assert.deepEqual(w.getStandardCollisionBoxesInAABB(bounds), old.terrainBoxesOverlapping(bounds));
  }
  const edited = { minX: 3, maxX: 4, minY: 200, maxY: 201, minZ: 3, maxZ: 4 };
  assert.equal(w.hasTerrainCollisionInAABB(edited), false);
  cell(w, 3, 200, 3);
  assert.equal(w.hasTerrainCollisionInAABB(edited), true);
  cell(w, 3, 200, 3, 0);
  assert.equal(w.hasTerrainCollisionInAABB(edited), false);
});

test('large moving and rotating bodies skip all per-cell work in certified empty air', () => {
  const w = world(), p = new ContraptionPhysics(w);
  const c = body([{ localX: -40, localY: 0, localZ: -40, block: 1 },
    { localX: 40, localY: 0, localZ: 40, block: 1 }]);
  const previous = { position: c.position.clone(), quaternion: c.quaternion.clone() };
  c.position.x += 2; c.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.2); c.syncAllBodyTransforms();
  p.getBodyCollisionWorldOBBs = () => { throw Error('empty envelope must prune before OBB construction'); };
  c.getCollisionSamplePoints = () => { throw Error('empty envelope must not allocate point probes'); };
  p.resolveTerrainCollisionBody(c, c.getRigidBodies()[0], 1 / 60, previous);
  c.dispose();
});

test('regional broadphase tracks floating micro walls and their published removal', () => {
  const w = world();
  const bounds = { minX: 0, maxX: 4, minY: 100, maxY: 102, minZ: 0, maxZ: 4 };
  w.microVoxels.set(8, 808, 8, 1);
  assert.equal(w.prepareTerrainCollisionQuery(bounds)!.regions.length, 0);
  w.microVoxels.updateMesh();
  assert.equal(w.prepareTerrainCollisionQuery(bounds)!.microBoxes.length, 1);
  w.microVoxels.delete(8, 808, 8);
  assert.equal(w.prepareTerrainCollisionQuery(bounds)!.microBoxes.length, 1);
  w.microVoxels.updateMesh();
  assert.equal(w.prepareTerrainCollisionQuery(bounds)!.regions.length, 0);
  w.microVoxels.set(TORUS_SIZE_X * 8 - 1, 808, 8, 1);
  w.microVoxels.updateMesh();
  assert.equal(w.prepareTerrainCollisionQuery({ ...bounds, minX: -0.125, maxX: 0 })!.microBoxes[0].minX, -0.125);
});

test('local shape bounds update after voxel edits and prune only distant boxes', () => {
  const w = world(), p = new ContraptionPhysics(w), c = body();
  const b = c.getRigidBodies()[0];
  const original = p.getBodyCollisionWorldOBBs(c, b)[0];
  c.blocks.push({ ...c.blocks[0], localX: 20 }); c.rebuildAfterBlockChange();
  const all = p.getBodyCollisionWorldOBBs(c, b);
  assert.equal(all.length, 2);
  const selected = p.getBodyCollisionWorldOBBs(c, b, new CollisionBoxIndex([original]));
  assert.equal(selected.length, 1);
  c.dispose();
});

test('filtered point templates match full probes for live pivots and rotated poses', () => {
  const c = body(Array.from({ length: 20 }, (_, y) => ({ localX: y % 2, localY: y, localZ: 0, block: 1 })));
  for (const angle of [0, 0.3, 1.5]) {
    c.quaternion.setFromEuler(new THREE.Euler(angle, 0.4, -0.2)); c.syncAllBodyTransforms();
    const range = { min: 100, max: 106 };
    const filtered = c.getCollisionSamplePoints(c.rootComponentId, true, range);
    const full = c.getCollisionSamplePoints(c.rootComponentId, true).filter(p => p.y >= range.min && p.y <= range.max);
    assert.equal(filtered.length, full.length);
    filtered.forEach((point, i) => assert.ok(point.distanceTo(full[i]) < 1e-10));
  }
  c.dispose();
});

for (const micro of [false, true]) test(`fast sweep through ${micro ? 'micro' : 'standard'} wall retains CCD with no endpoint overlap`, () => {
  const w = world();
  for (let z = 0; z < 8; z++) for (let y = 100; y < 106; y++) {
    if (micro) for (let my = y * 8; my < (y + 1) * 8; my++) for (let mz = z * 8; mz < (z + 1) * 8; mz++) w.microVoxels.set(5 * 8, my, mz, 1);
    else cell(w, 5, y, z);
  }
  if (micro) w.microVoxels.updateMesh();
  const a = body(), b = body();
  for (const [c, p] of [[a, new ContraptionPhysics(w)], [b, new ContraptionPhysics(legacy(w))]] as const) {
    const previous = { position: c.position.clone(), quaternion: c.quaternion.clone() };
    c.position.x += 6; c.velocity.set(360, 0, 0); c.syncAllBodyTransforms();
    p.resolveTerrainCollisionBody(c, c.getRigidBodies()[0], 1 / 60, previous);
    assert.ok(c.position.x < 5, 'wall must stop the body before the far endpoint');
  }
  assert.ok(a.position.distanceTo(b.position) < 1e-8);
  a.dispose(); b.dispose();
});

test('floor and wall motion preserve legacy collision response over multiple rotated steps', () => {
  const w = world();
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) cell(w, x, 100, z);
  for (let y = 101; y < 108; y++) for (let z = 0; z < 16; z++) cell(w, 8, y, z);
  const a = body(), b = body();
  const fast = new ContraptionPhysics(w), old = new ContraptionPhysics(legacy(w));
  for (const c of [a, b]) { c.quaternion.setFromEuler(new THREE.Euler(0.15, 0.3, 0.25)); c.velocity.set(4, -2, 1); c.syncAllBodyTransforms(); }
  for (let i = 0; i < 60; i++) {
    fast.update(a, 0.05); old.update(b, 0.05);
    assert.ok(a.position.distanceTo(b.position) < 1e-7, `step ${i}: position mismatch`);
    assert.ok(a.velocity.distanceTo(b.velocity) < 1e-7, `step ${i}: velocity mismatch`);
    assert.ok(a.quaternion.toArray().every((v, j) => Math.abs(v - b.quaternion.toArray()[j]) < 1e-8), `step ${i}: orientation mismatch ${JSON.stringify({a:a.quaternion.toArray(),b:b.quaternion.toArray(),pa:a.position.toArray(),pb:b.position.toArray(),sleep:[fast.isSleeping(a),old.isSleeping(b)]})}`);
  }
  a.dispose(); b.dispose();
});

test('rotation-only CCD keeps a thin obstacle between both endpoint poses', () => {
  const w = world(), c = body([{ localX: 0, localY: 0, localZ: 0, block: 1 },
    { localX: 10, localY: 0, localZ: 0, size: 0.125, block: 1 }] as any);
  const p = new ContraptionPhysics(w);
  const previous = { position: c.position.clone(), quaternion: c.quaternion.clone() };
  const start = c.getCollisionSamplePoints(c.rootComponentId, true).map(v => v.clone());
  c.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2); c.syncAllBodyTransforms();
  const end = c.getCollisionSamplePoints(c.rootComponentId, true);
  const tip = start.reduce((best, point, i) => point.distanceTo(previous.position) > start[best].distanceTo(previous.position) ? i : best, 0);
  const middle = start[tip].clone().lerp(end[tip], 0.5);
  const mx = Math.floor(middle.x * 8), my = Math.floor(middle.y * 8), mz = Math.floor(middle.z * 8);
  w.microVoxels.set(mx, my, mz, 1); w.microVoxels.updateMesh();
  let probes = 0;
  const sweep = p.sweepTerrainContact.bind(p);
  p.sweepTerrainContact = (...args) => { probes++; return sweep(...args); };
  const position = c.position.clone();
  p.resolveTerrainCollisionBody(c, c.getRigidBodies()[0], 1 / 60, previous);
  assert.ok(probes > 0, 'rotation path must not be classified as empty');
  assert.ok(c.position.distanceTo(position) > 0.001, 'the swept micro obstacle must resolve contact');
  c.dispose();
});

test('micro model sample pruning preserves the contact trajectory and child enable changes', () => {
  const w = world();
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) cell(w, x, 100, z);
  const blocks = Array.from({ length: 8 }, (_, x) => ({ localX: x, localY: x % 2, localZ: 0, size: 1, block: 1 }));
  blocks.push({ localX: 0, localY: -0.125, localZ: 0, size: 0.125, block: 1 });
  const a = body(blocks), b = body(blocks);
  const fast = new ContraptionPhysics(w), old = new ContraptionPhysics(legacy(w));
  for (const c of [a, b]) {
    assert.ok(c.createChildEntity(c.rootComponentId, new Set(['0,0,0']), 'child'));
    c.quaternion.setFromEuler(new THREE.Euler(0.1, 0.2, 0.3)); c.velocity.set(1, -3, 0); c.syncAllBodyTransforms();
  }
  for (let i = 0; i < 80; i++) {
    if (i === 20 || i === 40) for (const c of [a, b]) c.setNodeCollisionEnabled('child', i === 40);
    fast.update(a, 0.05); old.update(b, 0.05);
    assert.ok(a.position.distanceTo(b.position) < 1e-7, `micro trajectory step ${i}`);
    assert.ok(a.velocity.distanceTo(b.velocity) < 1e-7, `micro velocity step ${i}`);
  }
  a.dispose(); b.dispose();
});
