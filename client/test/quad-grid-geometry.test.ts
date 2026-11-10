import test from 'node:test';
import assert from 'node:assert/strict';
import { quadPerimeterIndices } from '../src/dev/QuadGridGeometry.ts';

test('quad grid preserves packed face/corner IDs and excludes every diagonal', () => {
  const source = new Uint32Array(32 * 6);
  for (let i = 0; i < 32; i++) source.set([4*i,4*i+1,4*i+2,4*i,4*i+2,4*i+3], i*6);
  const lines = quadPerimeterIndices(source);
  assert.equal(lines.length, 32 * 8);
  for (let i = 0; i < lines.length; i += 2) {
    const a = lines[i], b = lines[i + 1];
    assert.equal(Math.floor(a / 4), Math.floor(b / 4));
    assert.ok(Math.abs(a - b) === 1 || Math.abs(a - b) === 3);
  }
  assert.deepEqual([...quadPerimeterIndices([11, 8, 9, 11, 9, 10])], [11,8,8,9,9,10,10,11]);
  assert.throws(() => quadPerimeterIndices([0,1,2]));
  assert.throws(() => quadPerimeterIndices([0,1,2,1,2,3]));
  assert.throws(() => quadPerimeterIndices([0,1,2,0,2,0]));
});
