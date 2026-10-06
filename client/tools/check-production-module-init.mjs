import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const assets = process.argv[2]
  ? resolve(process.argv[2]) : fileURLToPath(new URL('../dist/assets/', import.meta.url));
const files = (await readdir(assets)).filter(file => /^(?:world-simulation|script-runtime|script-sdk|entity-data)-.*\.js$/.test(file)).sort();
for (const prefix of ['world-simulation-', 'script-runtime-']) {
  if (!files.some(file => file.startsWith(prefix))) throw new Error(`Missing production chunk: ${prefix}`);
}

// A fresh process for each import also exercises the reverse evaluation order.
// Importing only simulation first can hide a runtime -> simulation -> runtime TDZ.
for (const file of files) {
  const url = pathToFileURL(resolve(assets, file)).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(url)})`],
    { encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || `exit ${result.status}`).slice(-3000)
      .split('\n').filter(line => line.trim()).join('\n');
    throw new Error(`Production module initialization failed: ${file}\n${detail}`);
  }
}
console.log(`Production module initialization passed in ${files.length} independent import orders.`);
