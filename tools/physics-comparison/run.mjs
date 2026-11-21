import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { arch, cpus, platform } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { benchmark, fixtures, summarize } from './benchmark.ts';

const { values } = parseArgs({ options: {
  rapier: { type: 'string' },
  browser: { type: 'string' },
  native: { type: 'string' },
  bridge: { type: 'boolean' },
  output: { type: 'string' },
  'browser-only': { type: 'boolean' },
} });
if (values['browser-only'] && !values.browser) throw Error('--browser-only requires --browser');
const rapierUrl = values.rapier ? pathToFileURL(resolve(values.rapier)).href
  : import.meta.resolve('@dimforge/rapier3d-compat');
const report = {
  machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? null },
  node: values['browser-only'] ? null : {
    version: process.version, ...await benchmark(await import(rapierUrl)),
  },
};
if (values.native) {
  const input = fixtures();
  const run = spawnSync(resolve(values.native), [], {
    input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) throw run.error ?? Error(run.stderr);
  const raw = JSON.parse(run.stdout);
  report.native = input.map((fixture, index) => ({
    name: fixture.name, rapier: summarize(fixture, raw[index]), raw: raw[index],
  }));
}

if (values.bridge) {
  const { measureDesktopBridge } = await import('./bridge.mjs');
  report.desktopBridge = await measureDesktopBridge(fixtures().find(fixture => fixture.name === 'stacks'));
}

if (values.browser) {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright');
  const bundle = await build({
    stdin: {
      contents: [
        'import * as rapier from ' + JSON.stringify(fileURLToPath(rapierUrl)),
        'import { benchmark } from "./benchmark.ts"',
        'globalThis.runSpacePhysicsComparison = () => benchmark(rapier)',
      ].join('\n'),
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
    },
    platform: 'browser', format: 'esm', bundle: true, write: false, target: 'es2022',
  });
  const browser = await chromium.launch({ executablePath: resolve(values.browser), headless: true });
  try {
    const page = await browser.newPage();
    const url = 'http://localhost/space-physics-comparison';
    await page.route(url, route => route.fulfill({
      status: 200, contentType: 'text/html', body: '<!doctype html><title>Space physics comparison</title>',
      headers: { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' },
    }));
    await page.goto(url);
    if (!await page.evaluate(() => crossOriginIsolated)) throw Error('Browser timing requires a cross-origin isolated page');
    await page.addScriptTag({ type: 'module', content: bundle.outputFiles[0].text });
    await page.waitForFunction(() => typeof globalThis.runSpacePhysicsComparison === 'function');
    const result = await page.evaluate(() => globalThis.runSpacePhysicsComparison());
    report.browser = { version: browser.version(), crossOriginIsolated: true, ...result };
  } finally {
    await browser.close();
  }
}

if (values.output) await writeFile(values.output, JSON.stringify(report) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, (name, value) => name === 'raw' ? undefined : value, 2));
