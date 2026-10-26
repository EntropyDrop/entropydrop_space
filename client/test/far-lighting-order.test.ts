import test from 'node:test';
import assert from 'node:assert/strict';
import { LIGHTING_ORDER } from '../src/dev/FarLightingOrder.ts';

test('three-way lighting order balances position and cancels linear device drift', () => {
  const means: number[] = [];
  for (const mode of ['pbr', 'lambert', 'face']) {
    const positions = [0, 0, 0], samples: number[] = [];
    LIGHTING_ORDER.forEach((value, index) => {
      if (value !== mode) return;
      positions[index % 3]++;
      samples.push(10 + .5 * index);
    });
    assert.deepEqual(positions, [2, 2, 2]);
    means.push(samples.reduce((a, b) => a + b, 0) / samples.length);
  }
  assert.equal(means[0], means[1]); assert.equal(means[1], means[2]);
  const permutations = new Set(Array.from({ length: 6 }, (_, i) => LIGHTING_ORDER.slice(i * 3, i * 3 + 3).join(',')));
  assert.equal(permutations.size, 6);
});
