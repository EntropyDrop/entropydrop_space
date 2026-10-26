import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../src/dev/results/backface-2026-10-26/', import.meta.url));
const worlds = ['aether-archipelago', 'nature', 'copper-metropolis'];
const modes = ['reference', 'culled'];
const motions = ['fixed', 'sweep', 'move', 'across'];
function stats(values) {
  if (!values.length || values.some(value => !Number.isFinite(value))) throw new Error('Invalid samples.');
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)],
    min: sorted[0], max: sorted.at(-1) };
}
function aggregate(rows) {
  const raw = rows.flatMap(row => row.raw), gpu = rows.flatMap(row => row.gpu);
  const metrics = Object.fromEntries(['frame', 'cpu', 'calls', 'triangles', 'farCalls', 'farTriangles'].map(key => [key, stats(raw.map(row => row[key]))]));
  metrics.gpu = stats(gpu.map(row => row.spanMs));
  return { fps: 1000 / metrics.frame.mean, metrics, blocks: rows.length, blockFps: stats(rows.map(row => row.fps)),
    pendingFrames: rows.reduce((sum, row) => sum + row.pendingFrames, 0),
    proxiesCreated: rows.reduce((sum, row) => sum + row.proxiesCreated, 0),
    classifiedBlocks: rows.reduce((sum, row) => sum + row.classifiedBlocks, 0),
    residentFaces: { start: rows.map(row => row.residentStart), end: rows.map(row => row.residentEnd) } };
}
function pairs(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += 2) {
    const a = rows.slice(i, i + 2).find(row => row.role === 'reference');
    const b = rows.slice(i, i + 2).find(row => row.role === 'culled');
    if (!a || !b) throw new Error('Invalid adjacent pair.');
    out.push({ referenceFps: a.fps, culledFps: b.fps, fpsChangePercent: (b.fps / a.fps - 1) * 100,
      gpuReductionPercent: (1 - b.metrics.gpu.p50 / a.metrics.gpu.p50) * 100 });
  }
  return out;
}
const summary = { date: '2026-10-26', baseRevision: '3eda06e7fc0651d982dc24fe387a0280d656d6cf', worlds: [] };
for (const world of worlds) {
  const read = name => JSON.parse(gunzipSync(readFileSync(path.join(root, world, `${name}.json.gz`))));
  const comparison = read('comparison');
  if (comparison.rows.length !== 32 || comparison.errors.length || comparison.control
    || comparison.rows.some(row => row.role !== row.actual)) throw new Error(`Invalid run: ${world}`);
  const { rows, ...environment } = comparison;
  const controls = ['control-before', 'control-after'].map(tag => {
    const run = read(tag);
    if (run.errors.length || run.rows.length !== 4 || !run.control || run.rows.some(row => row.actual !== 'reference'))
      throw new Error(`Invalid control: ${world}/${tag}`);
    return { tag, ...aggregate(run.rows), pairs: pairs(run.rows),
      perRole: Object.fromEntries(modes.map(mode => [mode, aggregate(run.rows.filter(row => row.role === mode))])) };
  });
  const samples = [];
  for (const motion of motions) {
    const entries = modes.map(mode => ({ motion, mode, ...aggregate(rows.filter(row => row.motion === motion && row.role === mode)) }));
    if (entries.some(entry => entry.blocks !== 4)) throw new Error(`Missing blocks: ${world}/${motion}`);
    for (const entry of entries) {
      entry.fpsChangePercent = (entry.fps / entries[0].fps - 1) * 100;
      entry.gpuReductionPercent = (1 - entry.metrics.gpu.p50 / entries[0].metrics.gpu.p50) * 100;
      entry.triangleReductionPercent = (1 - entry.metrics.triangles.p50 / entries[0].metrics.triangles.p50) * 100;
    }
    entries[1].pairs = pairs(rows.filter(row => row.motion === motion));
    samples.push(...entries);
  }
  const images = JSON.parse(readFileSync(path.join(root, world, 'images.json')));
  if (images.length !== 3) throw new Error(`Missing images: ${world}`);
  for (const image of images) {
    const [reference, culled, restored] = image.captures;
    if (!image.identicalPicking || restored.max !== 0 || !restored.restored
      || culled.triangles > reference.triangles || restored.triangles !== reference.triangles || restored.calls !== reference.calls)
      throw new Error(`Image consistency failed: ${world}/${image.name}`);
    image.changedPixelsPercent = 100 * culled.changedOver2 / (image.width * image.height);
  }
  summary.worlds.push({ world, environment, samples, controls, images });
}
writeFileSync(path.join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log('| World / motion | Original FPS | Filtered FPS | FPS change | GPU ms original / filtered | Triangles removed | Pair FPS changes |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | --- |');
for (const world of summary.worlds) for (const motion of motions) {
  const [a, b] = world.samples.filter(row => row.motion === motion);
  console.log(`| ${world.world} / ${motion} | ${a.fps.toFixed(1)} | ${b.fps.toFixed(1)} | ${b.fpsChangePercent.toFixed(2)}% | ${a.metrics.gpu.p50.toFixed(3)} / ${b.metrics.gpu.p50.toFixed(3)} | ${b.triangleReductionPercent.toFixed(1)}% | ${b.pairs.map(p => p.fpsChangePercent.toFixed(1)).join(', ')} |`);
}
console.log(`Validated ${summary.worlds.length * 32} comparison blocks and ${summary.worlds.length * 8} control blocks.`);
