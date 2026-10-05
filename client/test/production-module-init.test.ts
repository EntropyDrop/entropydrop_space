import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const checker = fileURLToPath(new URL('../tools/check-production-module-init.mjs', import.meta.url));

test('production gate catches order-dependent chunk TDZ and accepts independent SDK data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'space-module-init-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  const world = join(directory, 'world-simulation-test.js');
  const runtime = join(directory, 'script-runtime-test.js');
  await writeFile(world, `import { sdk } from './script-runtime-test.js'; export const signatures = sdk.length; export function step() {}`);
  await writeFile(runtime, `import { step } from './world-simulation-test.js'; export const sdk = 'typed sdk'; export const tick = () => step();`);
  const simulationFirst = spawnSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(world).href)})`], { encoding: 'utf8' });
  assert.equal(simulationFirst.status, 0, 'one successful import order does not prove startup is safe');
  const broken = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /Cannot access 'sdk' before initialization/);
  await writeFile(join(directory, 'script-sdk-test.js'), `export const sdk = 'typed sdk';`);
  await writeFile(world, `import { sdk } from './script-sdk-test.js'; export const signatures = sdk.length; export function step() {}`);
  await writeFile(runtime, `import { step } from './world-simulation-test.js'; import { sdk } from './script-sdk-test.js'; export const tick = () => step(); export { sdk };`);
  const fixed = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' });
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stdout, /3 independent import orders/);
});
