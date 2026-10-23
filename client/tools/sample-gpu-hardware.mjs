#!/usr/bin/env node
/** Local, finite hardware telemetry. Requires macmon (brew install macmon).
 * No server, account, root password, or project runtime dependency. */
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';

const [output, duration = '180'] = process.argv.slice(2), seconds = Number(duration);
if (!output || !Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
  console.error('Usage: node client/tools/sample-gpu-hardware.mjs output.jsonl [seconds: 1-3600]');
  process.exit(1);
}
let version;
try { version = execFileSync('macmon', ['--version'], { encoding: 'utf8' }).trim(); }
catch { throw new Error('Install the local sampler first: brew install macmon'); }
const file = createWriteStream(output, { flags: 'wx' });
await new Promise((resolve, reject) => { file.once('open', resolve); file.once('error', reject); });
const child = spawn('macmon', ['pipe', '-s', String(seconds), '-i', '1000', '--soc-info'], { stdio: ['ignore', 'pipe', 'inherit'] });
file.on('error', () => child.kill('SIGTERM'));
let count = 0;
try {
  const complete = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`macmon exited ${code}; check local IOKit access.`)));
  });
  // Observe rejection immediately, including while readline is still draining.
  complete.catch(() => {});
  for await (const line of createInterface({ input: child.stdout })) {
    if (!line.trim()) continue;
    const value = JSON.parse(line);
    const row = { timestamp: value.timestamp, sampler: version,
      scope: 'whole system; not per-application GPU busy time', gpuFreqMHz: value.gpu_freq_mhz,
      gpuActiveRatio: value.gpu_active_ratio, gpuPowerW: value.gpu_power,
      gpuTemperatureC: value.temp?.gpu_temp_avg, cpuTemperatureC: value.temp?.cpu_temp_avg,
      ...(count === 0 ? { soc: value.soc } : {}) };
    if (!file.write(`${JSON.stringify(row)}\n`)) await new Promise(resolve => file.once('drain', resolve));
    count++;
  }
  await complete;
  if (!count) throw new Error('No hardware samples received.');
  console.log(`Saved ${count} hardware samples to ${output}`);
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise(resolve => file.end(resolve));
}
