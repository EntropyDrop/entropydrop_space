import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurfaceDiskCache, surfaceDiskBudget } from '../src/bootstrap/SurfaceDiskCache.ts';

test('disk cache has a large but quota-aware bound', () => {
  const MiB = 1024 * 1024;
  assert.equal(surfaceDiskBudget(), 512 * MiB);
  assert.equal(surfaceDiskBudget(50_000 * MiB), 2048 * MiB);
  assert.equal(surfaceDiskBudget(1000 * MiB), 200 * MiB);
  assert.equal(surfaceDiskBudget(0), 0);
  assert.equal(surfaceDiskBudget(-1), 0);
  assert.equal(surfaceDiskBudget(NaN), 512 * MiB);
});

test('unavailable browser storage is a non-blocking cache miss', async () => {
  const cache = createSurfaceDiskCache();
  assert.equal(await cache.get('a'.repeat(64)), undefined);
  await cache.put('a'.repeat(64), new Uint8Array([1, 2, 3]));
  await cache.remove('a'.repeat(64));
});
