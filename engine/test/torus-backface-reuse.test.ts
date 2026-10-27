import test from 'node:test';
import assert from 'node:assert/strict';
import { surfaceFacingProxy, surfaceBlockBackFacing } from '../src/render/TorusBackfaceMath.ts';
import { bendTorusPoint, torusTubeAngle, TORUS_SIZE_X } from '../src/torus/TorusWorld.ts';

test('wider cached surface rejection keeps every front-facing sample after accepted translation', () => {
  let rejected = 0;
  for (const camera of [bendTorusPoint(8192, 180, 1024), bendTorusPoint(2000, 300, 100)]) {
    for (let x = 0; x < 16384; x += 512) for (let z = 0; z < 2048; z += 128) {
      const center = bendTorusPoint(x, 16, z);
      const proxy = surfaceFacingProxy(x - 32, x + 32, z - 32, z + 32, center.x, center.y, center.z);
      if (!surfaceBlockBackFacing(proxy, 0, camera.x, camera.y, camera.z, center.distanceTo(camera), 20, 34)) continue;
      rejected++;
      for (const dx of [-32, 0, 32]) for (const dz of [-32, 0, 32]) {
        const theta = (x + dx) * Math.PI * 2 / TORUS_SIZE_X, phi = torusTubeAngle(z + dz);
        const nx = Math.cos(phi) * Math.cos(theta), ny = Math.sin(phi), nz = Math.cos(phi) * Math.sin(theta);
        const p = bendTorusPoint(x + dx, 16, z + dz);
        // Moving along the true surface normal maximizes its facing dot product.
        const facing = nx * (camera.x + nx * 31.999 - p.x) + ny * (camera.y + ny * 31.999 - p.y)
          + nz * (camera.z + nz * 31.999 - p.z);
        assert.ok(facing < 0, 'a rejected surface sample stays back-facing throughout reuse');
      }
    }
  }
  assert.ok(rejected > 100);
});
