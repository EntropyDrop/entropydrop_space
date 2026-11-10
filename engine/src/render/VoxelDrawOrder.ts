// Scratch storage reused across calls: ordering runs whenever a far tile is
// published or retired, for a couple of thousand sources at a time.
let tiles = new Int32Array(0), dependencies = new Uint16Array(0), parents = new Int32Array(0);
let offsets = new Int32Array(0), children = new Int32Array(0);
const last = new Int32Array(128 * 16);

/** Group storage pages while retaining the original order of neighboring tiles.
 * Coarse bent faces can meet/overlap at a tile boundary, so those dependencies
 * must survive batching. Unknown/foreign draws act as ordering barriers. */
export function orderVoxelPages<T>(sources: readonly T[], page: (source: T) => object,
  tile: (source: T) => number | undefined): T[] {
  const total = sources.length, result: T[] = [];
  if (tiles.length < total) {
    tiles = new Int32Array(total); dependencies = new Uint16Array(total);
    parents = new Int32Array(total * 9); offsets = new Int32Array(total + 1); children = new Int32Array(total * 9);
  }
  for (let i = 0; i < total; i++) tiles[i] = tile(sources[i]) ?? -1;
  let begin = 0;
  const segment = (end: number) => {
    const length = end - begin;
    if (!length) return;
    // An earlier source in the same or a neighboring tile must stay earlier.
    // Each source has at most nine such parents (one per cell); record them,
    // then lay the reverse edges out contiguously, in source order.
    last.fill(-1); offsets.fill(0, 0, length + 1);
    for (let i = 0; i < length; i++) {
      const cell = tiles[begin + i], x = cell >> 4, z = cell & 15;
      let count = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const previous = last[((x + dx + 128) % 128) * 16 + (z + dz + 16) % 16];
        if (previous >= 0) { parents[i * 9 + count++] = previous; offsets[previous + 1]++; }
      }
      dependencies[i] = count; last[cell] = i;
    }
    for (let i = 0; i < length; i++) offsets[i + 1] += offsets[i];
    for (let i = 0; i < length; i++) for (let k = 0; k < dependencies[i]; k++) children[offsets[parents[i * 9 + k]]++] = i;
    // The fill advanced every offset to its range's end: range p is [offsets[p - 1], offsets[p]).
    const queues = new Map<object, { indices: number[]; head: number }>();
    const ready = (index: number) => {
      const key = page(sources[begin + index]); let queue = queues.get(key);
      if (!queue) { queue = { indices: [], head: 0 }; queues.set(key, queue); }
      queue.indices.push(index);
    };
    for (let i = 0; i < length; i++) if (!dependencies[i]) ready(i);
    // Stay on one page while it has ready draws, then move to the page
    // holding the earliest ready draw.
    let queue: { indices: number[]; head: number } | undefined;
    for (let remaining = length; remaining > 0; remaining--) {
      if (!queue || queue.head === queue.indices.length) {
        let earliest = Infinity;
        for (const candidate of queues.values()) if (candidate.head < candidate.indices.length
          && candidate.indices[candidate.head] < earliest) {
          queue = candidate; earliest = candidate.indices[candidate.head];
        }
      }
      const index = queue!.indices[queue!.head++]; result.push(sources[begin + index]);
      for (let at = index ? offsets[index - 1] : 0; at < offsets[index]; at++) {
        const child = children[at];
        if (--dependencies[child] === 0) ready(child);
      }
    }
  };
  for (let i = 0; i < total; i++) if (tiles[i] < 0) {
    segment(i); result.push(sources[i]); begin = i + 1;
  }
  segment(total); return result;
}
