import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../src/voxel/World.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';
import { bendPoint, setTorusViewCorrection, getTorusViewCorrectionRevision } from '../src/torus/TorusWorld.ts';
import { executeQueryAction } from '../src/actions/QueryActions.ts';

test('cached exact terrain hits invalidate on new occluders, removals, metadata and policy changes', () => {
  const world = new World(new THREE.Scene());
  const origin = bendPoint(10.5, 210, 10.5), direction = bendPoint(10.5, 200, 10.5).sub(origin).normalize();
  const query = (published = true) => world.raycastBent(origin, direction, 16, published);
  assert.equal(query().hit, false); query(); query();
  assert.ok(world.getAimRaycastCacheStats().standard.hits > 0);
  world.setBlock(10, 200, 10, BlockTypes.COLOR_BLOCK, false, 0x123456);
  const hit = query(); assert.equal(hit.hit, true);
  if (!hit.hit) return;
  const reference = structuredClone(hit); Object.assign(hit.normal, { y: 999 }); Object.assign(hit.entry, { y: 999 });
  assert.deepEqual(query(), reference, 'callers cannot corrupt the cached result');
  world.setBlock(10, 203, 10, BlockTypes.COLOR_BLOCK, false, 0xabcdef);
  assert.equal(query().hitPos?.y, 203, 'a new cell in previously empty space occludes the old hit');
  world.setBlock(10, 203, 10, BlockTypes.AIR, false);
  assert.equal(query().hitPos?.y, 200);
  world.setBlock(10, 200, 10, BlockTypes.COLOR_BLOCK, false, 0x334455);
  assert.equal(query().color, 0x334455, 'metadata is read fresh even if intersection geometry is cached');
  const misses = world.getAimRaycastCacheStats().standard.misses;
  query(false); assert.equal(world.getAimRaycastCacheStats().standard.misses, misses + 1);
  world.aimRaycastCachingEnabled = false;
  assert.deepEqual(query(), { ...reference, color: 0x334455 });
});

test('micro cache follows publication, paint and live-query policy without tunnelling', () => {
  const world = new World(new THREE.Scene());
  const origin = bendPoint(10.0625, 210, 10.0625), direction = bendPoint(10.0625, 200, 10.0625).sub(origin).normalize();
  const query = (published = true) => world.raycastMicroBent(origin, direction, 16, published);
  assert.equal(query().hit, false); query();
  world.setMicroBlock(80, 1600, 80, 0xff0000); world.microVoxels.updateMesh();
  assert.equal(query().color, 0xff0000); query();
  world.setMicroBlock(80, 1600, 80, 0x00ff00);
  assert.equal(query().color, 0xff0000, 'pending edits retain the visible value');
  assert.equal(query(false).color, 0x00ff00);
  world.microVoxels.updateMesh(); assert.equal(query().color, 0x00ff00);
  world.removeMicroBlock(80, 1600, 80);
  assert.equal(query().hit, true);
  world.microVoxels.updateMesh(); assert.equal(query().hit, false);
});

test('ray changes and camera-local projection changes invalidate the cached intersection', () => {
  const world = new World(new THREE.Scene());
  const origin = bendPoint(10.5, 210, 10.5), direction = bendPoint(10.5, 200, 10.5).sub(origin).normalize();
  const query = () => world.raycastBent(origin, direction, 16);
  try {
    setTorusViewCorrection(null); query(); query(); query();
    const hits = world.getAimRaycastCacheStats().standard.hits;
    origin.x += .01; query(); assert.equal(world.getAimRaycastCacheStats().standard.hits, hits);
    direction.z += .01; query(); assert.equal(world.getAimRaycastCacheStats().standard.hits, hits);
    setTorusViewCorrection(new THREE.Vector3(10.5, 210, 10.5));
    const revision = getTorusViewCorrectionRevision();
    query(); assert.equal(world.getAimRaycastCacheStats().standard.hits, hits);
    setTorusViewCorrection(new THREE.Vector3(10.5, 210, 10.5));
    assert.equal(getTorusViewCorrectionRevision(), revision);
    query(); query(); assert.equal(world.getAimRaycastCacheStats().standard.hits, hits + 1);
    world.aimRaycastCachingEnabled = false;
    const reference = query(); world.aimRaycastCachingEnabled = true; assert.deepEqual(query(), reference);
  } finally { setTorusViewCorrection(null); }
});

test('entity movement remains freshly queried when the terrain result is reused', () => {
  const world = new World(new THREE.Scene());
  world.setBlock(10, 200, 10, BlockTypes.COLOR_BLOCK, false, 0xff0000);
  const origin = bendPoint(10.5, 210, 10.5), direction = bendPoint(10.5, 200, 10.5).sub(origin).normalize();
  let calls = 0, entityPresent = false;
  const context = { world, manager: { raycastContraptionHitBent() {
    calls++; return entityPresent ? { distance: 1, entityId: 'moving' } : null;
  } } } as any;
  const query = () => {
    const result = executeQueryAction(context, { action: 'raycast', origin, direction, space: 'bent', include: 'all', maxDistance: 16 });
    assert.ok('kind' in result); return result;
  };
  assert.equal(query().kind, 'world'); entityPresent = true;
  assert.equal(query().kind, 'entity'); entityPresent = false;
  assert.equal(query().kind, 'world'); assert.equal(calls, 3);
  assert.ok(world.getAimRaycastCacheStats().standard.hits >= 1);
});
