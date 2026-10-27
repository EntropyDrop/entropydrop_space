import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2] ? pathToFileURL(resolve(process.argv[2]) + sep)
  : new URL('../src/dev/results/visibility-2026-10-27/', import.meta.url);
const worlds = ['aether-archipelago', 'nature', 'copper-metropolis'];
function stats(values) {
  if (!values.length || values.some(v => !Number.isFinite(v))) throw Error('Invalid visibility samples.');
  const a = [...values].sort((a, b) => a - b);
  return { count: a.length, mean: a.reduce((a, b) => a + b, 0) / a.length,
    p50: a[Math.floor(a.length * .5)], p95: a[Math.floor(a.length * .95)], min: a[0], max: a.at(-1) };
}
function capture(world, file) {
  const data = JSON.parse(gunzipSync(readFileSync(new URL(`${world}/${file}`, root))));
  const { comparison: run, pixels } = data;
  const modes = ['original', 'fast', 'wide', run.rows.some(r => r.role === 'upload') ? 'upload' : 'gpu'];
  if (run.errors.length || run.width !== 2560 || run.height !== 1440 || run.quality !== 'medium' || run.shadows || run.samples !== 4) throw Error('Invalid environment: ' + world);
  if (!pixels || pixels.width !== 2560 || pixels.height !== 1440 || pixels.rows.length !== 25) throw Error('Incomplete image checks.');
  if (pixels.errors.length || pixels.rows.some(r => r.changedOver2 || !r.identicalPicking || (r.restored && r.max !== 0)
    || r.gpuValidation?.missingBlocks || r.gpuValidation?.orderErrors || r.uploadValidation?.mismatches)) throw Error('Image or GPU map control failed.');
  if (pixels.frozenPublication && new Set(pixels.rows.map(r => r.residentFaces)).size !== 1) throw Error('Frozen geometry changed.');
  const motions = [...new Set(run.rows.map(r => r.motion))];
  if (run.rows.length !== motions.length * 16) throw Error('Incomplete blocks.');
  const entries = motions.flatMap(motion => modes.map(mode => {
    const blocks = run.rows.filter(r => r.role === mode && r.motion === motion), raw = blocks.flatMap(b => b.raw), gpu = blocks.flatMap(b => b.gpu);
    if (blocks.length !== 4 || blocks.some(b => b.actual !== (run.control ? 'original' : mode)) || raw.some(f => f.frame <= 0)) throw Error('Invalid candidate frames.');
    for (const b of blocks) for (const g of b.gpu) {
      if (g.passes.filter(p => p.label.startsWith('visibility-')).length !== b.raw[g.frame].computePasses) throw Error('GPU timeline does not match visibility work.');
    }
    if ((mode !== 'gpu' || run.control) && raw.some(f => f.computePasses || f.indirectDraws)) throw Error('Unexpected GPU culling.');
    const metrics = Object.fromEntries(['frame', 'cpu', 'calls', 'triangles', 'computePasses', 'indirectDraws', 'gpuEncodeMs',
      'gpuBytes', 'arenaMs', 'arenaCalls', 'visibilityQueries', 'mapUploadBytes', 'newGpuPages'].map(k => [k, stats(raw.map(r => r[k]))]));
    metrics.gpu = stats(gpu.map(g => g.spanMs));
    return { motion, mode, fps: 1000 / metrics.frame.mean, metrics, perBlockFps: blocks.map(b => b.fps),
      perBlockGpu: blocks.map(b => b.metrics.gpu.mean), pendingFrames: blocks.reduce((sum, b) => sum + b.pendingFrames, 0),
      residents: blocks.map(b => [b.residentStart, b.residentEnd]) };
  }));
  const { rows, ...environment } = run;
  return { world, file, environment, pixels, entries, blocks: rows.length,
    frames: rows.reduce((n, b) => n + b.raw.length, 0), gpuSamples: rows.reduce((n, b) => n + b.gpu.length, 0) };
}
const summary = { worlds: worlds.map(w => capture(w, 'raw.json.gz')), repeats: [], controls: [] };
for (const world of worlds) for (const [file, key] of [['repeat.json.gz', 'repeats'], ['control.json.gz', 'controls']]) {
  if (existsSync(new URL(`${world}/${file}`, root))) summary[key].push(capture(world, file));
}
const all = [...summary.worlds, ...summary.repeats, ...summary.controls];
summary.blocks = all.reduce((n, r) => n + r.blocks, 0); summary.frames = all.reduce((n, r) => n + r.frames, 0);
summary.gpuSamples = all.reduce((n, r) => n + r.gpuSamples, 0);
writeFileSync(new URL('summary.json', root), JSON.stringify(summary, null, 2) + '\n');
for (const r of all) console.log(r.world, r.file, JSON.stringify(r.entries.map(e => ({ mode: e.mode, motion: e.motion,
  fps: e.fps, cpu: e.metrics.cpu.mean, gpu: e.metrics.gpu.mean, arena: e.metrics.arenaMs.mean,
  gpuEncode: e.metrics.gpuEncodeMs.mean, queries: e.metrics.visibilityQueries.mean, blocks: e.perBlockFps }))));
console.log({ blocks: summary.blocks, frames: summary.frames, gpuSamples: summary.gpuSamples });
