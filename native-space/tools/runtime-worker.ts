import { createInterface } from 'node:readline';
import { NativeRuntime } from './runtime-core.ts';

// stdout is an IPC channel, including when an upstream engine logs diagnostics.
console.log = console.error;
console.info = console.error;
const worldDir = process.argv.find(a => a.startsWith('--world-dir='))?.slice(12);
if (!worldDir) throw Error('--world-dir is required');
const runtime = new NativeRuntime(worldDir);
const input = createInterface({ input: process.stdin });
try {
  for await (const line of input) {
    try {
      if (line.length > 128 * 1024 * 1024) throw Error('Native request too large');
      process.stdout.write(JSON.stringify({ ok: true, ...(await runtime.step(JSON.parse(line))) }) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: String(error) }) + '\n');
    }
  }
} finally { runtime.close(); }
