import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../src/dev/results/lighting-2026-10-26/', import.meta.url));
const worlds = ['aether-archipelago', 'nature', 'copper-metropolis'];
const modes = ['pbr', 'lambert', 'face'];
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
    pendingFrames: rows.reduce((sum, row) => sum + row.pendingFrames, 0), materialsCreated: rows.reduce((sum, row) => sum + row.materialsCreated, 0) };
}
const summary = { date: '2026-10-26', baseRevision: '3eda06e7fc0651d982dc24fe387a0280d656d6cf', worlds: [] };
for (const world of worlds) {
  const read = name => JSON.parse(gunzipSync(readFileSync(path.join(root, world, `${name}.json.gz`))));
  const comparison = read('comparison');
  if (comparison.rows.length !== 54 || comparison.errors.length) throw new Error(`Invalid run: ${world}`);
  const { rows, ...environment } = comparison;
  const controls = ['control-before', 'control-after'].map(tag => {
    const run = read(tag);
    if (run.errors.length || run.rows.some(row => row.actual !== 'pbr')) throw new Error(`Invalid control: ${world}`);
    return { tag, ...aggregate(run.rows), perRole: Object.fromEntries(modes.map(mode => [mode, aggregate(run.rows.filter(row => row.role === mode))])) };
  });
  const samples = [];
  for (const motion of ['fixed', 'sweep', 'move']) {
    const entries = modes.map(mode => ({ motion, mode, ...aggregate(rows.filter(row => row.motion === motion && row.role === mode)) }));
    for (const entry of entries) {
      entry.fpsChangePercent = (entry.fps / entries[0].fps - 1) * 100;
      entry.gpuReductionPercent = (1 - entry.metrics.gpu.p50 / entries[0].metrics.gpu.p50) * 100;
    }
    samples.push(...entries);
  }
  const images = JSON.parse(readFileSync(path.join(root, world, 'images.json')));
  for (const image of images) {
    if (!image.identicalPicking || image.captures[3].max !== 0 || !image.captures.every(c => c.calls === image.captures[0].calls && c.triangles === image.captures[0].triangles))
      throw new Error(`Image consistency failed: ${world}/${image.name}`);
  }
  summary.worlds.push({ world, environment, samples, controls, images });
}
writeFileSync(path.join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log('| World / motion | PBR FPS | Lambert FPS | Face FPS | PBR GPU ms | Lambert GPU ms | Face GPU ms |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const world of summary.worlds) for (const motion of ['fixed', 'sweep', 'move']) {
  const rows = world.samples.filter(row => row.motion === motion);
  console.log(`| ${world.world} / ${motion} | ${rows.map(row => row.fps.toFixed(1)).join(' | ')} | ${rows.map(row => row.metrics.gpu.p50.toFixed(3)).join(' | ')} |`);
}
console.log(`Validated ${summary.worlds.length * 54} comparison blocks and ${summary.worlds.length * 12} control blocks.`);
