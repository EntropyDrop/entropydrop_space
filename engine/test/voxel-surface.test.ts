import test from 'node:test';
import assert from 'node:assert/strict';
import { meshVoxelBrick, reduceVoxelBrick } from '../src/worldgen/VoxelSurfaceGenerator.ts';

const solid = 0x80123456;
test('3D greedy meshing preserves the underside and air below floating slabs', () => {
  const n = 16, data = new Uint32Array(n ** 3);
  for (let z = 2; z < 6; z++) for (let y = 10; y < 12; y++) for (let x = 2; x < 6; x++) data[x + y*n + z*n*n] = solid;
  const faces: number[][] = [];
  meshVoxelBrick(data, n, 1, [0,0,0], (...face) => faces.push(face));
  assert.equal(faces.length, 6, 'greedily merge each planar face');
  assert.deepEqual(faces.filter(f => f[5] === 2)[0].slice(0,6), [2,10,2,4,4,2]);
  assert.deepEqual(faces.filter(f => f[5] === 3)[0].slice(0,6), [2,12,2,4,4,3]);
  assert.ok(faces.every(face => face[1] >= 10), 'never extrude toward ground');
  assert.deepEqual(new Set(faces.map(f => f[5])), new Set([0,1,2,3,4,5]));
});

test('3D reduction retains an air gap and reduces X, Y and Z together', () => {
  const n = 16, data = new Uint32Array(n ** 3);
  for (const y of [4,12]) data[4 + y*n + 4*n*n] = solid;
  const half = reduceVoxelBrick(data, n);
  assert.equal(half.length, 8**3);
  assert.equal(half[2 + 2*8 + 2*64], solid);
  assert.equal(half[2 + 6*8 + 2*64], solid);
  assert.equal(half[2 + 4*8 + 2*64], 0, 'air between disconnected surfaces remains air');
  assert.equal(half[2 + 0*8 + 2*64], 0, 'no pillar under floating geometry');
  assert.equal(half.filter(Boolean).length, 2);
});

test('face merging preserves colour and emission and culls occupied neighbours', () => {
  const data = new Uint32Array(8);
  data[0] = 0x80123456; data[1] = 0x81123456;
  const faces: number[][] = [];
  meshVoxelBrick(data, 2, 1, [0,0,0], (...face) => faces.push(face));
  assert.equal(faces.length, 10);
  assert.ok(!faces.some(f => f[0] === 1 && f[5] < 2), 'internal face omitted');
  assert.equal(reduceVoxelBrick(data, 2)[0], 0x81123456);
});
