import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { voxelFaceVisibility, voxelBlockBackFacing, VOXEL_FACE_BLOCK } from '../src/render/VoxelFaceVisibility.ts';
import { bendPoint } from '../src/torus/TorusWorld.ts';

test('normal cones never reject a front-facing bent triangle, including coarse faces at seams', () => {
  let rejected = 0;
  for (const origin of [[0, 0], [15872, 1536], [7168, 512]]) for (let dir = 0; dir < 6; dir++) {
    const offset = new Uint16Array(VOXEL_FACE_BLOCK * 3), span = new Uint16Array(VOXEL_FACE_BLOCK * 2), direction = new Uint8Array(VOXEL_FACE_BLOCK).fill(dir);
    const triangles: THREE.Vector3[][] = [];
    for (let i = 0; i < VOXEL_FACE_BLOCK; i++) {
      const p = [64 + i % 4 * 8, 64 + (i >> 2) * 8, 64 + i % 4 * 8], axis = dir >> 1, size = i % 3 ? 8 : 64;
      offset.set(p.map(n => n * 8), i * 3); span.set([size * 8, size * 8], i * 2);
      const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => {
        const q = [...p]; q[(axis + 1) % 3] += ((dir & 1) ? u : 1 - u) * size; q[(axis + 2) % 3] += v * size;
        return bendPoint(q[0] + origin[0], q[1], q[2] + origin[1]);
      });
      triangles.push([corners[0], corners[1], corners[2]], [corners[0], corners[2], corners[3]]);
    }
    const generator = voxelFaceVisibility({ count: VOXEL_FACE_BLOCK, offset, span, direction }, origin[0], origin[1]);
    let output = generator.next(); while (!output.done) output = generator.next();
    const bounds = output.value, center = new THREE.Vector3(bounds[0], bounds[1], bounds[2]);
    for (const triangle of triangles) for (const p of triangle) assert.ok(p.distanceTo(center) <= bounds[3]);
    for (let i = 0; i < 100; i++) {
      const camera = center.clone().add(new THREE.Vector3(Math.sin(i * 1.9), Math.cos(i * .73), Math.cos(i * 1.9)).normalize().multiplyScalar(2000));
      if (!voxelBlockBackFacing(bounds, 0, camera.x, camera.y, camera.z, 18)) continue;
      rejected++;
      for (const [a, b, c] of triangles) {
        const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
        assert.ok(normal.dot(camera.clone().sub(a)) <= -18, 'every removed triangle remains behind its plane throughout the motion guard');
      }
    }
    assert.equal(voxelBlockBackFacing(bounds, 0, center.x, center.y, center.z), false, 'camera-local flattening always retains the block');
  }
  assert.ok(rejected > 100, 'the test exercises actual rejections');
});
