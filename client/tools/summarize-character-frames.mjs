import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/dev/results/', import.meta.url));
const run = JSON.parse(gunzipSync(readFileSync(`${root}character-2026-10-26.json.gz`))).comparison;
const roles = ['reference', 'hidden', 'disabled'];
function stats(values) {
  if (!values.length || values.some(x => !Number.isFinite(x))) throw new Error('Invalid samples.');
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], min: sorted[0], max: sorted.at(-1) };
}
if (run.rows.length !== 54 || run.errors.length) throw new Error('Incomplete run or GPU errors.');
const { rows, ...environment } = run;
const frozen = JSON.parse(readFileSync(`${root}character-2026-10-26-frozen.json`));
const [original, hidden, restored] = frozen.rows;
if (restored.max !== 0 || original.calls !== restored.calls || original.triangles !== restored.triangles
  || original.farTriangles !== hidden.farTriangles || hidden.calls >= original.calls)
  throw new Error('Frozen character isolation or restoration failed.');
const summary = { environment, frozen, cases: [], frames: 0, gpuSamples: 0 };
for (const [perspective, motion] of [['first_person','fixed'], ['first_person','move'], ['third_person','move']]) {
  const entries = roles.map(role => {
    const blocks = rows.filter(r => r.role === role && r.perspective === perspective && r.motion === motion);
    if (blocks.length !== 6) throw new Error('Missing repetitions.');
    const raw = blocks.flatMap(r => r.raw), gpu = blocks.flatMap(r => r.gpu);
    if (raw.some(r => r.avatarCalls !== (role === 'disabled' ? 0 : 1))) throw new Error('Avatar update isolation failed.');
    const metrics = Object.fromEntries(['frame','cpu','avatarMs','calls','triangles','farTriangles']
      .map(key => [key, stats(raw.map(r => r[key]))]));
    metrics.gpu = stats(gpu.map(r => r.spanMs));
    summary.frames += raw.length; summary.gpuSamples += gpu.length;
    return { role, fps: 1000 / metrics.frame.mean, metrics, blockFps: stats(blocks.map(r => r.fps)),
      perBlockFps: blocks.map(r => r.fps), pendingFrames: blocks.reduce((sum, r) => sum + r.pendingFrames, 0),
      residentFaces: [...new Set(blocks.flatMap(r => [r.residentStart, r.residentEnd]))] };
  });
  for (const r of entries) r.fpsChangePercent = (r.fps / entries[0].fps - 1) * 100;
  summary.cases.push({ perspective, motion, entries });
}
writeFileSync(`${root}character-2026-10-26-summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
for (const c of summary.cases) {
  console.log(c.perspective, c.motion);
  for (const r of c.entries) console.log(r.role, JSON.stringify({ fps:r.fps, change:r.fpsChangePercent,
    cpu:r.metrics.cpu.p50, cpuMean:r.metrics.cpu.mean, gpu:r.metrics.gpu.p50, avatarMean:r.metrics.avatarMs.mean,
    calls:r.metrics.calls.p50, tri:r.metrics.triangles.p50, far:r.metrics.farTriangles.p50,
    frameP95:r.metrics.frame.p95, blockFps:r.perBlockFps, pending:r.pendingFrames }));
}
console.log({frames:summary.frames,gpuSamples:summary.gpuSamples,inventory:environment.inventory});
