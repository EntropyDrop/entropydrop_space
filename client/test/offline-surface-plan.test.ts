import test from 'node:test';
import assert from 'node:assert/strict';
import { offlineSurfacePlan } from '../src/dev/OfflineSurfacePlan.ts';

test('full offline terrain generates every real torus district without template repetition', () => {
  const plan = offlineSurfacePlan('full');
  assert.equal(plan.total, 128);
  assert.equal(plan.repeatWorld, false);
  const keys = new Set(plan.zones.map(([x, z]) => `${x},${z}`));
  assert.equal(keys.size, 128);
  for (let x = 0; x < 32; x++) for (let z = 0; z < 4; z++) assert.ok(keys.has(`${x},${z}`));
  assert.deepEqual(plan.zones[0], [16, 2]);
});

test('bounded and repeated benchmark fixtures remain explicit', () => {
  assert.equal(offlineSurfacePlan('bounded').total, 8);
  const repeated = offlineSurfacePlan('repeat');
  assert.equal(repeated.total, 128);
  assert.equal(repeated.repeatWorld, true);
  assert.equal(repeated.zones.length, 1);
  assert.equal(offlineSurfacePlan('repeat', true).repeatWorld, false);
});
