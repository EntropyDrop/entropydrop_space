import test from 'node:test';
import assert from 'node:assert/strict';
import { orderVoxelPages } from '../src/render/VoxelDrawOrder.ts';

test('page grouping retains every neighboring dependency across both torus seams', () => {
  const pages = [{}, {}, {}, {}];
  const sources = Array.from({ length: 300 }, (_, id) => ({ id, page: pages[id % 4],
    tile: ((id * 37) % 128) * 16 + (id * 7) % 16 }));
  sources.push({ id: 300, page: pages[1], tile: 0 }, { id: 301, page: pages[0], tile: 127 * 16 + 15 },
    { id: 302, page: pages[1], tile: 15 }, { id: 303, page: pages[0], tile: 0 });
  const ordered = orderVoxelPages(sources, item => item.page, item => item.tile);
  assert.equal(new Set(ordered).size, sources.length);
  const positions = new Map(ordered.map((item, i) => [item.id, i]));
  for (let i = 0; i < sources.length; i++) for (let j = i + 1; j < sources.length; j++) {
    const a = sources[i].tile, b = sources[j].tile;
    const dx = Math.abs((a >> 4) - (b >> 4)), dz = Math.abs((a & 15) - (b & 15));
    if (Math.min(dx, 128 - dx) <= 1 && Math.min(dz, 16 - dz) <= 1) {
      assert.ok(positions.get(i)! < positions.get(j)!, `neighboring draws ${i}, ${j} retain their ordering`);
    }
  }
});

test('independent tiles share page draws while foreign draws remain barriers', () => {
  const a = {}, b = {};
  const sources: { id: number; page: object; tile?: number }[] = [
    { id: 0, page: a, tile: 0 }, { id: 1, page: b, tile: 10 * 16 }, { id: 2, page: a, tile: 20 * 16 },
    { id: 3, page: b }, { id: 4, page: a, tile: 30 * 16 },
  ];
  assert.deepEqual(orderVoxelPages(sources, s => s.page, s => s.tile).map(s => s.id), [0, 2, 1, 3, 4]);
});
