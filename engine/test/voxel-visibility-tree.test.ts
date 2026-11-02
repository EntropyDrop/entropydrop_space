import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VoxelVisibilityTree } from '../src/render/VoxelVisibilityTree.ts';

function reference(data: Float32Array, camera: THREE.Vector3, frustum: THREE.Frustum, padding: number, angular: number, flattening: boolean) {
  return Uint8Array.from({ length: data.length / 12 }, (_, i) => {
    const at = i * 12, x = camera.x - data[at], y = camera.y - data[at + 1], z = camera.z - data[at + 2];
    const d = Math.sqrt(x*x + y*y + z*z), r = data[at + 3];
    if (flattening && d - r <= 256 + padding) return 0;
    if (data[at+4]*x + data[at+5]*y + data[at+6]*z + d*data[at+7] + r + padding < 0) return 1;
    for (const p of frustum.planes) if (p.normal.x*data[at] + p.normal.y*data[at+1] + p.normal.z*data[at+2] + p.constant < -r-padding-d*angular) return 2;
    return 0;
  });
}

test('hierarchy matches ordered linear visibility through motion, nonunit planes, flattening and projection changes', () => {
  let seed = 4181;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2**32; };
  const data = new Float32Array(8197 * 12);
  for (let i = 0; i < data.length / 12; i++) {
    const coherent = i > 4096;
    data.set([coherent ? i % 64 * 4 - 128 : rand()*4000-2000,
      coherent ? Math.floor(i/64)*2-128 : rand()*400-200, coherent ? -600 : rand()*4000-2000,
      coherent ? 2.5 : rand()*80, coherent ? 0 : rand()*2-1, coherent ? 0 : rand()*2-1,
      coherent ? 1 : rand()*2-1, coherent ? .01 : rand()*2, 0, 0, 0, 0], i*12);
  }
  const tree = new VoxelVisibilityTree(data), distances = new Float64Array(data.length/12), facing = new Uint8Array(distances.length);
  const camera = new THREE.PerspectiveCamera(), frustum = new THREE.Frustum();
  for (let frame = 0; frame < 240; frame++) {
    const position = Math.floor(frame/3);
    if (frame % 3 === 0) camera.position.set(rand()*2000-1000, rand()*400-200, rand()*2000-1000);
    camera.rotation.set(rand()*2-1, rand()*6, 0);
    camera.fov = 30 + rand()*100; camera.aspect = .5+rand()*2; camera.far = frame%11 ? 10000 : 600;
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    if (frame%7 === 0) { frustum.planes[0].normal.multiplyScalar(3); frustum.planes[0].constant *= 3; }
    if (frame%13 === 0) frustum.planes[1].setComponents(0,0,0,-.2);
    // Keep position-dependent parameters stable within each rotation group.
    const flattening = position%2 === 0, padding = position%3 ? 34 : .01, angular = position%3 ? .121 : .000002;
    assert.deepEqual(tree.select(camera.position, frustum, padding, angular, flattening, position, distances, facing).map(reason => Number(reason !== 0)),
      reference(data, camera.position, frustum, padding, angular, flattening).map(reason => Number(reason !== 0)), `frame ${frame}`);
    const prefix = new Uint32Array(distances.length + 1);
    for (let i = 0; i < distances.length; i++) prefix[i + 1] = prefix[i] + Number((i + frame) % 7 === 0);
    tree.select(camera.position, frustum, padding, angular, flattening, position, distances, facing, prefix);
    const expected = Array.from(reference(data, camera.position, frustum, padding, angular, flattening), (reason, i) => ({reason, i}))
      .filter(({reason, i}) => reason === 0 && prefix[i + 1] === prefix[i]).map(({i}) => i);
    assert.deepEqual(Array.from(tree.selected.subarray(0, tree.count)), expected, `ordered covered selection ${frame}`);
    assert.equal(tree.back + tree.outside + tree.count, distances.length - prefix[distances.length]);
  }
});
