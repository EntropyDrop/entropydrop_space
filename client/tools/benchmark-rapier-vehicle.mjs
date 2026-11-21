import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:4174/space/app/' },
  runs: { type: 'string', default: '2' },
  course: { type: 'string', default: 'vertical' },
  output: { type: 'string' },
} });
const rounds = Number(values.runs);
assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 10, '--runs must be between 1 and 10');
assert.ok(['vertical', 'ramp', 'flat'].includes(values.course), '--course must be vertical, ramp, or flat');
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted[Math.ceil(sorted.length * p) - 1];
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) };
}
const waitOptions = { timeout: 45_000 };
async function waitTick(page, tick) {
  await page.waitForFunction(tick => window.spacePhysicsTrial.latest().tick >= tick, tick, waitOptions);
}

async function changeTerrain(page, fill) {
  const change = await page.evaluate(fill => {
    const trial = window.spacePhysicsTrial;
    const before = trial.counts();
    const tick = trial.latest().tick;
    return { tick, before, changed: trial.edit(fill), fill };
  }, fill);
  await page.waitForFunction(({ fill, before }) => {
    const trial = window.spacePhysicsTrial;
    if ((trial.publishedEdit() > 0) !== fill) return false;
    const after = trial.counts();
    if (!before || !after) return true;
    return after.terrainRebuilds > before.terrainRebuilds && (fill
      ? after.publishedMicroBoxes > before.publishedMicroBoxes
      : after.publishedMicroBoxes < before.publishedMicroBoxes);
  }, change, waitOptions);
  const settled = await page.evaluate(() => ({ tick: window.spacePhysicsTrial.latest().tick,
    boxes: window.spacePhysicsTrial.publishedEdit(), counts: window.spacePhysicsTrial.counts() }));
  return { ...change, settled };
}

async function verifyResidentShapes(page) {
  const checks = [];
  await page.evaluate(() => window.spacePhysicsTrial.pauseTrialScripts());
  for (const [edit, voxelRebuilds, decorationRebuilds] of [
    ['add-decoration', 0, 1],
    ['paint-decoration', 0, 0],
    ['remove-decoration', 0, 1],
    ['remove-voxel', 1, 0],
    ['restore-voxel', 1, 0],
  ]) {
    const before = await page.evaluate(edit => {
      const trial = window.spacePhysicsTrial;
      const counts = trial.counts();
      if (!trial.editResidentShapes(edit)) throw Error('Resident shape test edit failed');
      return counts;
    }, edit);
    await page.waitForFunction(steps => window.spacePhysicsTrial.counts().steps > steps, before.steps, waitOptions);
    const after = await page.evaluate(() => window.spacePhysicsTrial.counts());
    assert.equal(after.bodyCreates, before.bodyCreates, edit);
    assert.equal(after.voxelRebuilds - before.voxelRebuilds, voxelRebuilds, edit);
    assert.equal(after.decorationRebuilds - before.decorationRebuilds, decorationRebuilds, edit);
    checks.push({ edit, voxelRebuilds, decorationRebuilds });
  }
  return checks;
}

async function run(mode) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] });
  try {
    const context = await browser.newContext({ viewport: { width: 960, height: 640 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    const url = new URL(values.url);
    url.searchParams.set('dev_offline', '1');
    url.searchParams.set('dev_physics', mode);
    url.searchParams.set('dev_dpr', '0.75');
    url.searchParams.set('dev_physics_course', values.course);
    await page.goto(url.href);
    try {
      await page.waitForFunction(() => window.spacePhysicsTrial || document.querySelector('#space-entry-status')?.textContent.includes('failed'), null, waitOptions);
      const started = await page.evaluate(() => Boolean(window.spacePhysicsTrial));
      if (!started) throw Error(await page.locator('#space-entry-status').textContent());
      await page.waitForFunction(() => window.game.sceneRenderer.renderer.info.render.triangles > 0, null, waitOptions);
      await page.waitForFunction(() => window.spacePhysicsTrial.latest().tick >= 28, null, waitOptions);
    } catch (error) { throw Error(`${mode} did not start: ${error.message}\n${errors.join('\n')}`); }

    const cdp = await context.newCDPSession(page);
    const browserCdp = await browser.newBrowserCDPSession();
    let measuring = true;
    const memory = [];
    const memorySampling = (async () => {
      while (measuring) {
        const [heap, { processInfo }] = await Promise.all([
          cdp.send('Runtime.getHeapUsage'), browserCdp.send('SystemInfo.getProcessInfo'),
        ]);
        const renderers = processInfo.filter(process => process.type === 'renderer').map(process => process.id);
        const rss = renderers.length ? execFileSync('ps', ['-o', 'rss=', '-p', renderers.join(',')], { encoding: 'utf8' })
          .trim().split(/\s+/).reduce((sum, kib) => sum + Number(kib) * 1024, 0) : null;
        memory.push({ jsHeapBytes: heap.usedSize, backingStorageBytes: heap.backingStorageSize, rendererRssBytes: rss });
        await delay(600);
      }
    })();
    let samples, begin, edits, end;
    try {
      begin = await page.evaluate(() => {
        const trial = window.spacePhysicsTrial;
        window.game.uiStore.startGame(false);
        trial.mount();
        trial.startCapture();
        const initial = trial.latest();
        trial.key('KeyW', true);
        return { initial, initMs: trial.initMs, stepZ: trial.stepZ,
          counts: trial.counts(), dpr: window.game.sceneRenderer.renderer.getPixelRatio(),
          device: window.game.sceneRenderer.renderer.backend.device?.adapterInfo?.description ?? null };
      });
      assert.ok(begin.initial.isDriving, `${mode} did not mount`);
      const firstTick = begin.initial.tick;
      await waitTick(page, firstTick + 28);
      const add = await changeTerrain(page, true);
      await waitTick(page, firstTick + 129);
      const remove = await changeTerrain(page, false);
      edits = { add, remove };
      await waitTick(page, firstTick + 240);
      const beforeBrake = await page.evaluate(() => {
        const trial = window.spacePhysicsTrial;
        const state = trial.latest();
        trial.key('KeyW', false);
        trial.key('Space', true);
        return state;
      });
      await waitTick(page, beforeBrake.tick + 24);
      ({ samples, end } = await page.evaluate(() => {
        const trial = window.spacePhysicsTrial;
        trial.key('Space', false);
        const samples = trial.stopCapture();
        const seated = trial.latest();
        trial.mount();
        return { samples, end: { seated, unmounted: trial.latest() } };
      }));
    } finally {
      measuring = false;
      await memorySampling;
    }
    assert.equal(edits.add.changed, 64);
    assert.equal(edits.remove.changed, 64);
    const residentChecks = mode === 'rapier' ? await verifyResidentShapes(page) : null;
    const seatErrors = samples.readings.map(row => row.seatError).filter(value => value !== null);
    const maxZ = Math.max(...samples.readings.map(row => row.position[2]));
    const maxY = Math.max(...samples.readings.map(row => row.position[1]));
    return { mode, course: values.course, chrome: browser.version(), begin, edits, end, residentChecks, errors,
      summary: {
        entityUpdateMs: stats(samples.update), frameIntervalMs: stats(samples.frame), frameCpuMs: stats(samples.frameCpu),
        jsHeapPeakBytes: Math.max(...memory.map(row => row.jsHeapBytes)),
        backingStoragePeakBytes: Math.max(...memory.map(row => row.backingStorageBytes ?? 0)),
        rendererRssPeakBytes: Math.max(...memory.map(row => row.rendererRssBytes ?? 0)),
        maxZ, maxY, distanceZ: end.seated.position[2] - begin.initial.position[2],
        maxSeatErrorMeters: Math.max(...seatErrors), seatedSamples: seatErrors.length,
        speedAfterBrake: Math.hypot(end.seated.velocity[0], end.seated.velocity[2]),
        clearedStep: values.course === 'flat' ? null : maxZ > begin.stepZ + 7.5,
        scriptRunning: end.seated.scriptStatus === 'running' && samples.readings.every(row => !row.scriptError),
        rapierSteps: samples.rapier ? samples.rapier.steps - begin.counts.steps : null,
        terrainRebuilds: samples.rapier ? samples.rapier.terrainRebuilds - begin.counts.terrainRebuilds : null,
        hullRebuilds: samples.rapier ? samples.rapier.hullRebuilds - begin.counts.hullRebuilds : null,
        voxelRebuilds: samples.rapier ? samples.rapier.voxelRebuilds - begin.counts.voxelRebuilds : null,
        decorationRebuilds: samples.rapier ? samples.rapier.decorationRebuilds - begin.counts.decorationRebuilds : null,
        bodyCreates: samples.rapier ? samples.rapier.bodyCreates - begin.counts.bodyCreates : null,
        terrainContactReports: samples.terrainReports,
      },
      raw: { samples, memory } };
  } finally { await browser.close(); }
}
const results = [];
for (let i = 0; i < rounds; i++) {
  for (const mode of (i % 2 === 0 ? ['space', 'rapier'] : ['rapier', 'space'])) {
    const result = await run(mode);
    results.push(result);
    console.log(JSON.stringify({ mode, run: i + 1, ...result.summary, edits: result.edits, errors: result.errors }));
  }
}
if (values.output) await writeFile(values.output, JSON.stringify({ cpu: cpus()[0]?.model, results }) + '\n', { flag: 'wx' });
