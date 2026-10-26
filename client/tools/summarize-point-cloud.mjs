import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const root = new URL('../src/dev/results/points-2026-10-27/', import.meta.url);
const modes = ['original', 'rect', 'points', 'surfel', 'compute'];
function stats(values) {
  if (!values.length || values.some(v => !Number.isFinite(v))) throw Error('Invalid point samples.');
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], min: sorted[0], max: sorted.at(-1) };
}
function readCapture(world, file, motions, totals) {
  const { comparison: run, pixels } = JSON.parse(gunzipSync(readFileSync(new URL(`${world}/${file}`, root))));
  if (run.rows.length !== motions.length * 20 || run.errors.length || pixels.errors.length) throw Error('Incomplete or invalid run: ' + world);
  if (run.width !== 2560 || run.height !== 1440 || run.quality !== 'medium' || run.shadows || run.samples !== 4) throw Error('Wrong environment.');
  for (const view of pixels.views) {
    if (view.rows.at(-1).max !== 0 || view.rows.filter(r => r.repeat).some(r => r.repeat.max > 1)
      || !view.identicalPicking || !view.rows.find(r => r.mode === 'omit').changedOver2) throw Error('Invalid picture controls.');
  }
  const entries = motions.flatMap(motion => modes.map(mode => {
    const blocks = run.rows.filter(r => r.motion === motion && r.role === mode);
    const raw = blocks.flatMap(r => r.raw), gpu = blocks.flatMap(r => r.gpu);
    if (blocks.length !== 4 || blocks.some(b => b.materialsCreated || b.actual !== mode)
      || raw.some(r => r.frame <= 0 || r.computePasses !== (mode === 'compute' ? 3 : 0))) throw Error('Wrong candidate or unwarmed pipeline.');
    if (mode === 'compute' && gpu.some(g => g.passes.filter(p => p.label.startsWith('point-')).length !== 3)) throw Error('GPU timeline excludes compute work.');
    const metrics = Object.fromEntries(['frame', 'cpu', 'calls', 'triangles', 'farCalls', 'farTriangles', 'submittedPoints',
      'computePasses', 'cullMs', 'uploadBytes', 'fallbackSources'].map(k => [k, stats(raw.map(r => r[k]))]));
    metrics.gpu = stats(gpu.map(r => r.spanMs));
    totals.blocks += blocks.length; totals.frames += raw.length; totals.gpuSamples += gpu.length;
    return { motion, mode, fps: 1000 / metrics.frame.mean, metrics, perBlockFps: blocks.map(b => b.fps),
      perBlockGpuMean: blocks.map(b => b.metrics.gpu.mean), pendingFrames: blocks.reduce((sum, b) => sum + b.pendingFrames, 0),
      residents: blocks.map(b => [b.residentStart, b.residentEnd]) };
  }));
  const { rows, ...environment } = run;
  console.log(world, file, JSON.stringify(entries.map(e => ({ motion: e.motion, mode: e.mode, fps: e.fps,
    gpu: e.metrics.gpu.mean, cpu: e.metrics.cpu.mean, cull: e.metrics.cullMs.mean,
    fallback: e.metrics.fallbackSources.max, blocks: e.perBlockFps }))));
  return { world, environment, pixels, entries };
}
const summary = { blocks: 0, frames: 0, gpuSamples: 0, worlds: [], repeat: { blocks: 0, frames: 0, gpuSamples: 0, worlds: [] } };
for (const world of ['aether-archipelago', 'nature', 'copper-metropolis']) {
  summary.worlds.push(readCapture(world, 'raw.json.gz', ['across', 'acrossMove'], summary));
}
summary.repeat.worlds.push(readCapture('aether-archipelago', 'repeat.json.gz', ['acrossMove'], summary.repeat));
writeFileSync(new URL('summary.json', root), JSON.stringify(summary, null, 2) + '\n');
console.log({ blocks: summary.blocks, frames: summary.frames, gpuSamples: summary.gpuSamples,
  repeatBlocks: summary.repeat.blocks, repeatFrames: summary.repeat.frames, repeatGpuSamples: summary.repeat.gpuSamples });
