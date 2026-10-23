import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuTrialTreatment } from '../src/dev/GpuTrialOrder.ts';

test('interleaved GPU trials cancel linear drift and balance positions in both orders', () => {
  const positions = [0, 0, 0, 0];
  for (let quartet = 0; quartet < 40; quartet++) {
    const rows = Array.from({ length: 4 }, (_, position) => {
      const treatment = gpuTrialTreatment(quartet * 4 + position);
      if (treatment.role === 'candidate') positions[position]++;
      return { ...treatment, ms: 10 + 0.5 * (quartet * 4 + position) };
    });
    const mean = (role: string) => rows.filter(r => r.role === role).reduce((n, r) => n + r.ms, 0) / 2;
    assert.equal(mean('candidate'), mean('reference'));
  }
  assert.deepEqual(positions, [20, 20, 20, 20]);
  for (const index of [-1, 0.5, NaN, Infinity]) assert.throws(() => gpuTrialTreatment(index));
});

test('seeded ordering breaks fixed order alignment while balancing every eight samples', () => {
  const firstOrders = new Set<string>();
  for (let pair = 0; pair < 40; pair++) {
    const positions = [0, 0, 0, 0];
    for (let i = 0; i < 8; i++) {
      const r = gpuTrialTreatment(pair * 8 + i, 12345);
      if (i === 0) firstOrders.add(r.order);
      if (r.role === 'candidate') positions[r.position]++;
      assert.deepEqual(r, gpuTrialTreatment(pair * 8 + i, 12345));
    }
    assert.deepEqual(positions, [1, 1, 1, 1]);
  }
  assert.equal(firstOrders.size, 2);
  assert.throws(() => gpuTrialTreatment(0, -1));
});
