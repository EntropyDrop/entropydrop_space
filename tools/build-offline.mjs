#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdir, readFile, stat, writeFile, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const client = resolve(root, 'client');
const output = resolve(root, 'dist/itchio');
const archive = resolve(root, 'dist/entropydrop-space-itchio.zip');
const requireClient = createRequire(resolve(client, 'package.json'));
const { build } = await import(pathToFileURL(requireClient.resolve('vite')).href);
const { zipSync, unzipSync } = requireClient('fflate');

// Discard previous archives first so a failed build cannot be mistaken for a new release.
await rm(archive, { force: true });
await build({ root: client, configFile: resolve(client, 'vite.config.js'), mode: 'offline' });

for (const [check, extra] of [
  ['check-no-dev-entry.mjs', ['--offline']],
  ['check-production-module-init.mjs', []],
  ['check-compiler-worker.mjs', []],
]) {
  const result = spawnSync(process.execPath, [resolve(client, 'tools', check), resolve(output, 'assets'), ...extra],
    { cwd: client, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${check} failed (exit ${result.status}).`);
}

const files = Object.create(null);
let totalBytes = 0;
async function collect(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) { await collect(path); continue; }
    if (!entry.isFile()) throw new Error(`Unexpected non-file in offline build: ${path}`);
    const name = relative(output, path).replaceAll('\\', '/');
    const { size } = await stat(path);
    if (name.length > 240) throw new Error(`itch.io path exceeds 240 characters: ${name}`);
    if (size > 200_000_000) throw new Error(`itch.io file exceeds 200 MB: ${name}`);
    files[name] = new Uint8Array(await readFile(path));
    totalBytes += size;
  }
}
await collect(output);
if (!files['index.html']) throw new Error('The ZIP must contain index.html at its root.');
if (Object.keys(files).length > 1000 || totalBytes > 500_000_000) {
  throw new Error('Offline build exceeds itch.io HTML5 limits (1000 files / 500 MB extracted).');
}
const html = new TextDecoder().decode(files['index.html']);
if (/(?:src|href)="\/(?!\/)/.test(html)) throw new Error('Offline HTML contains a root-absolute asset path.');
if (!html.includes("connect-src 'self' blob:") || html.includes('Verifying EntropyDrop account')) {
  throw new Error('Offline HTML must use the offline entry and self-contained resource policy.');
}
const compressed = zipSync(files, { level: 9 });
const unpacked = unzipSync(compressed);
for (const [name, content] of Object.entries(files)) {
  if (!Buffer.from(content).equals(Buffer.from(unpacked[name] ?? []))) {
    throw new Error(`ZIP verification failed: ${name}`);
  }
}
await writeFile(`${archive}.tmp`, compressed);
await rename(`${archive}.tmp`, archive);
console.log(`\nOffline build: ${output}`);
console.log(`itch.io upload: ${archive}`);
console.log(`${Object.keys(files).length} files, ${(totalBytes / 1048576).toFixed(1)} MiB extracted, ${(compressed.length / 1048576).toFixed(1)} MiB ZIP.`);
