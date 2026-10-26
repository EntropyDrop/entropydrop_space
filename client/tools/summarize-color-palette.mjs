import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const root = new URL('../src/dev/results/color-2026-10-26/', import.meta.url);
const stats = values => {
  if (!values.length || values.some(v => !Number.isFinite(v))) throw new Error('Invalid color samples.');
  const sorted = [...values].sort((a,b) => a-b);
  return { count: values.length, mean: values.reduce((a,b) => a+b,0)/values.length,
    p50: sorted[Math.floor(sorted.length*.5)], p95: sorted[Math.floor(sorted.length*.95)], min: sorted[0], max: sorted.at(-1) };
};
const summary = { frames: 0, gpuSamples: 0, worlds: [], meshing: JSON.parse(readFileSync(new URL('meshing.json',root))) };
function summarizeRun(world) {
  const { comparison: run, pixels } = JSON.parse(gunzipSync(readFileSync(new URL(`${world}/raw.json.gz`,root))));
  if (run.rows.length !== 16 || run.errors.length) throw new Error(`Incomplete run: ${world}`);
  if (pixels.rows[4].max !== 0 || pixels.rows[2].versusPalette.max !== 0) throw new Error(`Pixel control: ${world}`);
  if (!pixels.rows[3].changedOver2) throw new Error(`Far colors are invisible: ${world}`);
  if (!pixels.rows.every(r => r.calls === pixels.rows[0].calls && r.triangles === pixels.rows[0].triangles)) throw new Error('Geometry differs.');
  const entries = ['original','palette256','packed256','mono'].map(mode => {
    const blocks = run.rows.filter(r => r.role === mode), frames = blocks.flatMap(r => r.raw), gpu = blocks.flatMap(r => r.gpu);
    if (blocks.length !== 4 || blocks.some(b => b.pendingFrames || b.materialsCreated || b.residentStart !== b.residentEnd)) throw new Error('Unstable source.');
    const metrics = Object.fromEntries(['frame','cpu','calls','triangles','farCalls','farTriangles'].map(key => [key,stats(frames.map(f=>f[key]))]));
    metrics.gpu = stats(gpu.map(r=>r.spanMs)); summary.frames += frames.length; summary.gpuSamples += gpu.length;
    return { mode, fps: 1000/metrics.frame.mean, metrics, perBlockFps: blocks.map(b=>b.fps),
      perBlockGpuP50: blocks.map(b=>b.metrics.gpu.p50), perBlockGpuMean: blocks.map(b=>b.metrics.gpu.mean) };
  });
  const { rows, ...environment } = run;
  return { world, environment, entries, pixels };
}
for (const world of ['aether-archipelago','nature','copper-metropolis']) {
  const entry = summarizeRun(world); summary.worlds.push(entry);
  const entries = entry.entries;
  console.log(world, JSON.stringify(entries.map(r=>({ mode:r.mode,fps:r.fps,gpu:r.metrics.gpu.p50,gpuMean:r.metrics.gpu.mean,cpu:r.metrics.cpu.p50,blockGpu:r.perBlockGpuP50 }))));
}
summary.threeWorldFrames = summary.frames; summary.threeWorldGpuSamples = summary.gpuSamples;
summary.pressure = summarizeRun('copper-4k');
console.log('copper-4k', JSON.stringify(summary.pressure.entries.map(r=>({mode:r.mode,fps:r.fps,gpu:r.metrics.gpu.p50,gpuMean:r.metrics.gpu.mean,blockFps:r.perBlockFps,blockGpu:r.perBlockGpuP50}))));
writeFileSync(new URL('summary.json',root),JSON.stringify(summary,null,2)+'\n');
console.log({frames:summary.frames,gpuSamples:summary.gpuSamples});
