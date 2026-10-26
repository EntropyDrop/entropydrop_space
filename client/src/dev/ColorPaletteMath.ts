/** Deterministic palette builder shared by offline rendering and meshing probes. */
const channels = (word: number) => [word & 255, word >>> 8 & 255, word >>> 16 & 255];

/** Weighted median cut in the renderer's existing byte color representation. */
export function makePalette(histogram: Map<number, number>) {
  type Entry = { word: number; weight: number; rgb: number[] };
  const entries: Entry[] = [...histogram].map(([word, weight]) => ({ word, weight, rgb: channels(word) }));
  const boxes: Entry[][] = [entries];
  const score = (box: Entry[]) => {
    const ranges = [0, 1, 2].map(c => { let lo = 255, hi = 0; for (const e of box) { lo = Math.min(lo, e.rgb[c]); hi = Math.max(hi, e.rgb[c]); } return hi - lo; });
    return { axis: ranges.indexOf(Math.max(...ranges)), score: Math.max(...ranges) * Math.sqrt(box.reduce((sum, e) => sum + e.weight, 0)) };
  };
  while (boxes.length < 256) {
    let best = -1, maximum = -1, axis = 0;
    boxes.forEach((box, i) => { if (box.length > 1) { const s = score(box); if (s.score > maximum) { best = i; maximum = s.score; axis = s.axis; } } });
    if (best < 0) break;
    const box = boxes.splice(best, 1)[0].sort((a, b) => a.rgb[axis] - b.rgb[axis] || a.word - b.word);
    const half = box.reduce((sum, e) => sum + e.weight, 0) / 2;
    let at = 0, sum = 0;
    while (at < box.length - 1 && sum < half) sum += box[at++].weight;
    boxes.push(box.slice(0, at), box.slice(at));
  }
  const words = new Uint32Array(256);
  boxes.forEach((box, i) => {
    const weight = box.reduce((sum, e) => sum + e.weight, 0);
    const rgb = [0, 1, 2].map(c => Math.round(box.reduce((sum, e) => sum + e.rgb[c] * e.weight, 0) / weight));
    words[i] = (rgb[0] | rgb[1] << 8 | rgb[2] << 16 | 0xff000000) >>> 0;
  });
  const indices = new Map<number, number>();
  let squaredError = 0, total = 0;
  for (const entry of entries) {
    let nearest = 0, error = Infinity;
    for (let i = 0; i < boxes.length; i++) {
      const rgb = channels(words[i]), distance = rgb.reduce((sum, value, c) => sum + (value - entry.rgb[c]) ** 2, 0);
      if (distance < error) { nearest = i; error = distance; }
    }
    indices.set(entry.word, nearest); squaredError += error * entry.weight; total += entry.weight;
  }
  return { words, indices, count: boxes.length, unique: entries.length, rmsByteChannel: Math.sqrt(squaredError / (3 * total)) };
}
