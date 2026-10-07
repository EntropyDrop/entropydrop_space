/** Group storage pages while retaining the original order of neighboring tiles.
 * Coarse bent faces can meet/overlap at a tile boundary, so those dependencies
 * must survive batching. Unknown/foreign draws act as ordering barriers. */
export function orderVoxelPages<T>(sources: readonly T[], page: (source: T) => object,
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
