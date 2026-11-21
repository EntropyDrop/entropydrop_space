import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:4174/space/app/' },
  count: { type: 'string', multiple: true },
  layout: { type: 'string', multiple: true },
  runs: { type: 'string', default: '2' },
  output: { type: 'string' },
} });
const counts = (values.count || ['32', '128']).map(Number);
const layouts = values.layout || ['spread', 'stack', 'stack-agitated'];
const rounds = Number(values.runs);
assert.ok(counts.every(count => [32, 128].includes(count)), '--count must be 32 or 128');
assert.ok(layouts.every(layout => ['spread', 'stack', 'stack-agitated'].includes(layout)), 'Unsupported --layout');
assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 10, '--runs must be between 1 and 10');

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = p => sorted[Math.ceil(sorted.length * p) - 1];
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) };
}

async function run(mode, layout, count) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    const url = new URL(values.url);
    url.searchParams.set('dev_offline', '1');
    url.searchParams.set('dev_physics', mode);
    url.searchParams.set('dev_physics_load', layout);
    url.searchParams.set('dev_physics_count', String(count));
    url.searchParams.set('dev_dpr', '0.75');
    await page.goto(url.href);
    try {
      await page.waitForFunction(() => window.spaceRigidBodyLoad
        || document.querySelector('#space-entry-status')?.textContent.includes('failed'), null, { timeout: 60_000 });
      if (!await page.evaluate(() => Boolean(window.spaceRigidBodyLoad))) {
        throw Error(await page.locator('#space-entry-status').textContent());
      }
      await page.waitForFunction(() => window.game.sceneRenderer.renderer.info.render.triangles > 0
        && window.game.world.getTerrainAoiLoadProgress().ready, null, { timeout: 60_000 });
    } catch (error) {
      throw Error(`${mode} ${layout}/${count} failed during setup: ${error.message}\n${errors.join('\n')}`);
    }
    const browserCdp = await browser.newBrowserCDPSession();
    const rss = [];
    let sampling = true;
    const memory = (async () => {
      while (sampling) {
        const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
        const pids = processInfo.filter(process => process.type === 'renderer').map(process => process.id);
        if (pids.length > 0) {
          const kib = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
          rss.push(kib.trim().split(/\s+/).reduce((sum, value) => sum + Number(value), 0) * 1024);
        }
        await delay(500);
      }
    })();
    let raw;
    try {
      await page.evaluate(() => {
        window.game.uiStore.startGame(false);
        window.spaceRigidBodyLoad.start();
      });
      await page.waitForFunction(() => window.spaceRigidBodyLoad.done(), null, { timeout: 120_000 });
      raw = await page.evaluate(() => window.spaceRigidBodyLoad.result());
    } finally {
      sampling = false;
      await memory;
    }

    assert.deepEqual(errors, [], `${mode} ${layout}/${count} browser errors`);
    assert.equal(raw.active, count, 'No rigid body may disappear');
    assert.equal(raw.updateMs.length, raw.sampleTicks);
    const invalid = raw.readings.find(row => !row.finite || row.sleeping > 0);
    assert.equal(invalid, undefined, `${mode} ${layout}/${count} must keep finite, awake bodies`);
    if (mode === 'rapier') {
      assert.equal(raw.rapier?.steps, (raw.sampleTicks + raw.warmupTicks) * 3, 'All substeps must run through Rapier');
      assert.equal(raw.rapier.bodyCreates, count);
      assert.equal(raw.rapier.voxelRebuilds, count, 'Every voxel shape should be created just once');
      assert.ok(raw.rapier.terrainRebuilds > 0, 'The resident terrain tiles should be published');
    }

    return {
      mode, layout, count, chrome: browser.version(), raw, rss,
      summary: {
        updateMs: stats(raw.updateMs),
        frameCpuMs: stats(raw.frameCpuMs),
        frameIntervalMs: stats(raw.frameIntervalsMs),
        longFrames: raw.longFrames.length,
        peakRendererRssMiB: Math.round(Math.max(...rss) / 1048576),
        movingP50: stats(raw.readings.map(row => row.moving)).p50,
        movingMin: Math.min(...raw.readings.map(row => row.moving)),
        entityContactBodiesP50: stats(raw.readings.map(row => row.contacts)).p50,
        maxFloorPenetrationMeters: Math.max(0, raw.floorTop - Math.min(...raw.readings.map(row => row.minBottom))),
        maxBodyY: Math.max(...raw.readings.map(row => row.maxY)),
        elapsedMs: raw.elapsedMs,
      },
    };
  } finally { await browser.close(); }
}

const results = [];
for (const count of counts) {
  for (const layout of layouts) {
    for (let round = 0; round < rounds; round++) {
      for (const mode of round % 2 === 0 ? ['space', 'rapier'] : ['rapier', 'space']) {
        const result = await run(mode, layout, count);
        results.push(result);
        console.log(JSON.stringify({ count, layout, mode, run: round + 1, ...result.summary }));
      }
    }
  }
}
if (values.output) await writeFile(values.output, JSON.stringify({ cpu: cpus()[0]?.model, results }) + '\n', { flag: 'wx' });
