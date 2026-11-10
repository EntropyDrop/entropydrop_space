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

/** The straightforward formulation: one adjacency list per source. */
function referenceOrder<T>(sources: readonly T[], page: (source: T) => object,
  tile: (source: T) => number | undefined): T[] {
  const result: T[] = [];
  let begin = 0;
  const segment = (end: number) => {
    const length = end - begin;
    if (!length) return;
    const dependencies = new Uint16Array(length), next: number[][] = Array.from({ length }, () => []);
    const last = new Int32Array(128 * 16).fill(-1);
    const queues = new Map<object, { indices: number[]; head: number }>();
    const ready = (index: number) => {
      const key = page(sources[begin + index]); let queue = queues.get(key);
      if (!queue) { queue = { indices: [], head: 0 }; queues.set(key, queue); }
      queue.indices.push(index);
    };
    for (let i = 0; i < length; i++) {
      const cell = tile(sources[begin + i])!, x = cell >> 4, z = cell & 15;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const previous = last[((x + dx + 128) % 128) * 16 + (z + dz + 16) % 16];
        if (previous >= 0) { next[previous].push(i); dependencies[i]++; }
      }
      last[cell] = i;
      if (!dependencies[i]) ready(i);
    }
    let current: object | undefined;
    for (let remaining = length; remaining > 0; remaining--) {
      let queue = current ? queues.get(current) : undefined;
      if (!queue || queue.head === queue.indices.length) {
        let earliest = Infinity;
        for (const [key, candidate] of queues) if (candidate.head < candidate.indices.length
          && candidate.indices[candidate.head] < earliest) {
          current = key; queue = candidate; earliest = candidate.indices[candidate.head];
        }
      }
      const index = queue!.indices[queue!.head++]; result.push(sources[begin + index]);
      for (const child of next[index]) if (--dependencies[child] === 0) ready(child);
    }
  };
  for (let i = 0; i < sources.length; i++) if (tile(sources[i]) === undefined) {
    segment(i); result.push(sources[i]); begin = i + 1;
  }
  segment(sources.length); return result;
}

test('the allocation-free ordering matches the reference for any mix of pages, tiles and barriers', () => {
  let seed = 12345;
  const random = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  // Sizes shrink and grow so reused scratch storage holds stale data from larger calls.
  for (const size of [0, 1, 7, 2048, 300, 5, 900, 2048, 64]) for (let round = 0; round < 4; round++) {
    const pages = Array.from({ length: 1 + random(12) }, () => ({}));
    const spread = [1, 4, 128][random(3)];
    const sources = Array.from({ length: size }, (_, id) => ({ id, page: pages[random(pages.length)],
      tile: random(40) === 0 ? undefined : random(spread * 16) * (128 / spread) % 2048 }));
    const expected = referenceOrder(sources, s => s.page, s => s.tile).map(s => s.id);
    assert.deepEqual(orderVoxelPages(sources, s => s.page, s => s.tile).map(s => s.id), expected, `size ${size}, round ${round}`);
  }
});
