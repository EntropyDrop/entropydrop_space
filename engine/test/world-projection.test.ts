import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../src/voxel/World.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';
import { bendPoint, bendPointForView, bendDirection, unbendPoint, unbendDirection,
  bendFrameQuaternion, setTorusViewCorrection, setWorldProjection, getWorldProjectionRevision,
  applyCameraBend, cullChunks, computeBentBoundsSphere } from '../src/torus/TorusWorld.ts';

test('flat projection keeps camera, positions, normals, bounds and picking in the same coordinates', t => {
  t.after(() => { setWorldProjection('torus'); setTorusViewCorrection(null); });
  setTorusViewCorrection(new THREE.Vector3(8192, 40, 1024));
  setWorldProjection('flat');
  const point = new THREE.Vector3(8197, 24, 1027);
  assert.deepEqual(bendPoint(point.x, point.y, point.z).toArray(), point.toArray());
  assert.deepEqual(bendPointForView(point.x, point.y, point.z).toArray(), point.toArray());
  assert.deepEqual(unbendPoint(point.x, point.y, point.z).toArray(), point.toArray());
  const dir = new THREE.Vector3(1, 2, 3).normalize();
  assert.deepEqual(bendDirection(8192, 30, 1024, dir).toArray(), dir.toArray());
  assert.deepEqual(unbendDirection(8192, 30, 1024, dir).toArray(), dir.toArray());
  assert.deepEqual(bendFrameQuaternion(8192, 30, 1024).toArray(), [0, 0, 0, 1]);
  const camera = new THREE.PerspectiveCamera(65, 1, .1, 1000);
  camera.position.copy(point); camera.lookAt(point.x + 10, point.y - 5, point.z + 3);
  const before = camera.quaternion.clone();
  applyCameraBend(camera);
  assert.deepEqual(camera.position.toArray(), point.toArray());
  assert.ok(camera.quaternion.angleTo(before) < 1e-7);
  const sphere = computeBentBoundsSphere({ minX: 8192, maxX: 8208, minY: 16, maxY: 32, minZ: 1024, maxZ: 1040 });
  assert.deepEqual(sphere.center.toArray(), [8200, 24, 1032]);
  assert.ok(Math.abs(sphere.radius - Math.sqrt(3) * 8) < 1e-5);
  const world = new World(new THREE.Scene(), 42);
  world.setBlock(8197, 100, 1027, BlockTypes.COLOR_BLOCK, false);
  const hit = world.raycastBent(new THREE.Vector3(8197.5, 105, 1027.5), new THREE.Vector3(0, -1, 0), 10, false);
  assert.equal(hit.hit, true);
  assert.deepEqual(hit.hitPos, { x: 8197, y: 100, z: 1027 });
});

test('switching projection invalidates near and micro bounds without replacing meshes', t => {
  t.after(() => { setWorldProjection('torus'); setTorusViewCorrection(null); });
  const mesh = new THREE.Group(), micro = new THREE.Mesh();
  for (const object of [mesh, micro]) Object.assign(object.userData,
    { occupiedMinY: 16, occupiedMaxY: 32, projectionChunkCx: 512, projectionChunkCz: 64, standardChunkKey: '512,64' });
  const world = { chunks: new Map([['512,64', { cx: 512, cz: 64, mesh }]]),
    microVoxels: { meshChunks: new Map([['512,64', micro]]) } };
  const revisions: number[] = [];
  for (const mode of ['torus', 'flat', 'torus'] as const) {
    setWorldProjection(mode);
    const revision = getWorldProjectionRevision(); revisions.push(revision);
    setWorldProjection(mode); assert.equal(getWorldProjectionRevision(), revision);
    const camera = new THREE.PerspectiveCamera(75, 1, .1, 100);
    camera.position.set(8200, 25, 1060); camera.lookAt(8200, 24, 1032);
    camera.updateProjectionMatrix(); applyCameraBend(camera);
    cullChunks(camera, world, false);
    for (const object of [mesh, micro]) {
      assert.equal(object.visible, true);
      assert.equal(object.userData.bentSphereRevision, revision);
      const { cx, cy, cz } = object.userData.bentSphere;
      if (mode === 'flat') assert.deepEqual([cx, cy, cz], [8200, 24, 1032]);
      else assert.ok(Math.abs(cx - 8200) > 1000);
    }
  }
  assert.ok(revisions[0] < revisions[1] && revisions[1] < revisions[2]);
});
