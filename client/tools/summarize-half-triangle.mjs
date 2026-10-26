import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const root = new URL('../src/dev/results/half-triangle-2026-10-26/', import.meta.url);
const stats = values => {
  if (!values.length || values.some(v => !Number.isFinite(v))) throw new Error('Invalid triangle samples.');
  const sorted = [...values].sort((a,b) => a-b);
  return { count: values.length, mean: values.reduce((a,b) => a+b,0)/values.length,
    p50: sorted[Math.floor(sorted.length*.5)], p95: sorted[Math.floor(sorted.length*.95)], min: sorted[0], max: sorted.at(-1) };
};
const summary = { frames: 0, gpuSamples: 0, worlds: [] };
for (const world of ['aether-archipelago','nature','copper-metropolis']) {
  const { comparison: run, pixels, replay, control } = JSON.parse(gunzipSync(readFileSync(new URL(`${world}/raw.json.gz`,root))));
  if (run.rows.length !== 16 || run.errors.length) throw new Error(`Incomplete run: ${world}`);
  if (pixels.rows[3].max !== 0 || pixels.rows[2].versusRepeat.max !== 0 || !pixels.rows[1].changedOver2) throw new Error(`Pixel control: ${world}`);
  if (pixels.rows[0].farTriangles !== 2*pixels.rows[1].farTriangles || !pixels.rows.every(r => r.calls === pixels.rows[0].calls && !r.fallbackDraws)) throw new Error('Geometry check failed.');
  const entries = ['sweep','move'].flatMap(motion => ['original','half'].map(mode => {
    const blocks = run.rows.filter(r => r.role === mode && r.motion === motion), frames = blocks.flatMap(r=>r.raw), gpu = blocks.flatMap(r=>r.gpu);
    if (blocks.length !== 4 || blocks.some(b=>b.materialsCreated) || frames.some(f=>f.fallbackDraws)) throw new Error('Unwarmed or fallback draws.');
    const metrics = Object.fromEntries(['frame','cpu','calls','triangles','farCalls','farTriangles'].map(key=>[key,stats(frames.map(f=>f[key]))]));
    metrics.gpu = stats(gpu.map(r=>r.spanMs)); summary.frames += frames.length; summary.gpuSamples += gpu.length;
    return { motion, mode, fps:1000/metrics.frame.mean, metrics, perBlockFps:blocks.map(b=>b.fps),
      perBlockGpuP50:blocks.map(b=>b.metrics.gpu.p50), perBlockGpuMean:blocks.map(b=>b.metrics.gpu.mean),
      pendingFrames:blocks.reduce((s,b)=>s+b.pendingFrames,0), residents:blocks.map(b=>[b.residentStart,b.residentEnd]) };
  }));
  const { rows, ...environment } = run;
  summary.worlds.push({world,environment,entries,pixels,replay,control});
  console.log(world,JSON.stringify(entries.map(e=>({motion:e.motion,mode:e.mode,fps:e.fps,gpu:e.metrics.gpu.p50,gpuMean:e.metrics.gpu.mean,cpu:e.metrics.cpu.mean,blockFps:e.perBlockFps,blockGpu:e.perBlockGpuMean,pending:e.pendingFrames}))));
}
writeFileSync(new URL('summary.json',root),JSON.stringify(summary,null,2)+'\n');
console.log({frames:summary.frames,gpuSamples:summary.gpuSamples});
