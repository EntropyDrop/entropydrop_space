import test from 'node:test';
import assert from 'node:assert/strict';
import { bendTorusPoint, torusTubeAngle, TORUS_R, TORUS_SIZE_X, TORUS_SIZE_Z } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { surfaceFacingProxy, surfaceBlockBackFacing } from '../src/dev/TorusBackfaceMath.ts';

function reject(x: number, z: number, camera: { x: number; y: number; z: number }, width = 8) {
  const p = bendTorusPoint(x, 16, z);
  const proxy = surfaceFacingProxy(x-width, x+width, z-width, z+width, p.x, p.y, p.z);
  return surfaceBlockBackFacing(proxy, 0, camera.x, camera.y, camera.z, p.distanceTo(camera as any), 20);
}
test('surface-facing keeps opposite inner wall and rejects its outer surface', () => {
  const camera = bendTorusPoint(8192, 180, 1024);
  assert.equal(reject(0, 1024, camera), false);
  assert.equal(reject(0, 0, camera), true);
  assert.equal(reject(8192, 1024, camera), false);
});
test('backface rule rotates with the camera and protects nearby geometry', () => {
  const camera = bendTorusPoint(0, 180, 0);
  assert.equal(reject(0, 0, camera), false);
  assert.equal(reject(8192, 0, camera), true);
  const proxy = surfaceFacingProxy(8184, 8200, -8, 8, -TORUS_R, 0, 0);
  assert.equal(surfaceBlockBackFacing(proxy, 0, camera.x, camera.y, camera.z, 300, 20), false);
});
test('equivalent periodic patches have the same facing classification', () => {
  const camera = bendTorusPoint(8192, 180, 1024);
  for (const x of [0, 32, 8192, 16380]) for (const z of [0, 32, 1024, 2040]) {
    assert.equal(reject(x, z, camera), reject(x+TORUS_SIZE_X, z+TORUS_SIZE_Z, camera));
    assert.equal(reject(x, z, camera), reject(x-TORUS_SIZE_X, z-TORUS_SIZE_Z, camera));
  }
});
test('rejected patches contain no camera-facing ideal-surface samples', () => {
  let rejected = 0;
  for (const camera of [bendTorusPoint(8192,180,1024), bendTorusPoint(2000,300,100), bendTorusPoint(5000,800,500)])
    for (let x=0;x<16384;x+=512) for (let z=0;z<2048;z+=128) {
      if (!reject(x,z,camera,32)) continue;
      rejected++;
      for (const dx of [-32,0,32]) for (const dz of [-32,0,32]) {
        const theta=(x+dx)*Math.PI*2/TORUS_SIZE_X, phi=torusTubeAngle(z+dz), p=bendTorusPoint(x+dx,16,z+dz);
        const facing=Math.cos(phi)*Math.cos(theta)*(camera.x-p.x)+Math.sin(phi)*(camera.y-p.y)+Math.cos(phi)*Math.sin(theta)*(camera.z-p.z);
        assert.ok(facing<0);
      }
    }
  assert.ok(rejected>100);
});
