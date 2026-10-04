import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as yieldTask, setTimeout as delay } from 'node:timers/promises';
import { preloadInitialDistantTerrain } from '../src/bootstrap/InitialDistantTerrain.ts';
import type { SpaceSurfaceSnapshotRemote } from '../src/bootstrap/SpaceSurfaceSnapshot.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(t: any) {
  const frames: FrameRequestCallback[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true,
    value: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'requestAnimationFrame', previous);
    else delete (globalThis as any).requestAnimationFrame;
  });
  const world: any = {
    distantSurface: {
      hasPendingWork: true, preparationError: null,
      getZoneDemand: () => ({ sampleSize: 2, priority: 0 }),
    },
    getDistantSurfaceSettings: () => ({ dataBudgetMiB: 256 }),
    installSurfaceZone() {}, removeSurfaceZone() {},
    async finalizeSurfaceConnections() {},
  };
  return { world, async frame() {
    const callback = frames.shift();
    assert.ok(callback, 'preparation must keep scheduling loading frames');
    callback(performance.now());
    await yieldTask();
  } };
}

test('entry waits for distant downloads, refinement, publication and completed GPU work', async t => {
  const { world, frame } = fixture(t);
  const downloads = deferred<{ loaded: number; complete: boolean }>();
  const connections = deferred(), pipelines = deferred(), gpu = deferred();
  let calls = 0, drawings = 0, installed = 0, finalizing = false, gpuWaits = 0, entered = false;
  const progress: string[] = [];
  const remote: SpaceSurfaceSnapshotRemote = {
    async loadAll(onZone, _remove, options) {
      assert.ok(drawings > 0, 'the spawn camera must be ready before selecting detail');
      assert.equal(options!.getDataBudgetBytes!(), 256 * 1024 * 1024);
      calls++;
      if (calls === 1) {
        const result = await downloads.promise;
        onZone({ zoneX: 0, zoneZ: 0 } as any);
        options!.onProgress!({ loadedZones: 128, totalZones: 128 });
        return result;
      }
      return { loaded: 0, complete: true };
    },
  };
  world.installSurfaceZone = () => { installed++; };
  world.finalizeSurfaceConnections = () => { finalizing = true; return connections.promise; };
  const entering = preloadInitialDistantTerrain({ remote, world,
    drawFrame: () => { drawings++; },
    preparePipelines: () => pipelines.promise,
    waitForGpu: () => { gpuWaits++; return gpu.promise; },
    reportProgress: (_value, message) => progress.push(message),
  }).then(() => { entered = true; });
  await frame();
  assert.equal(entered, false);
  assert.equal(gpuWaits, 0);
  downloads.resolve({ loaded: 128, complete: true });
  await frame();
  assert.equal(calls, 2, 'completion also verifies that refinement has settled');
  assert.equal(installed, 1);
  assert.equal(finalizing, true);
  assert.equal(entered, false, 'download completion alone cannot open gameplay');
  connections.resolve();
  await frame();
  assert.equal(gpuWaits, 0, 'queued mesh publication must finish first');
  world.distantSurface.hasPendingWork = false;
  await frame(); await frame();
  assert.equal(gpuWaits, 0, 'pipeline compilation must complete before the final GPU fence');
  assert.equal(entered, false, 'hidden terrain shaders must be prepared before gameplay');
  pipelines.resolve(); await yieldTask();
  assert.equal(gpuWaits, 1);
  assert.equal(entered, false, 'a submitted frame is not completed GPU work');
  gpu.resolve(); await entering;
  assert.equal(entered, true);
  assert.ok(progress.some(message => message.includes('128/128')));
});

test('a partial manifest holds entry even when every currently available zone is downloaded', async t => {
  const { world, frame } = fixture(t);
  let complete = false, calls = 0, finalized = false, entered = false;
  const remote: SpaceSurfaceSnapshotRemote = { async loadAll(_install, _remove, options) {
    calls++;
    options!.onProgress!({ loadedZones: 127, totalZones: 128 });
    return { loaded: 0, complete };
  } };
  world.distantSurface.hasPendingWork = false;
  world.finalizeSurfaceConnections = async () => { finalized = true; };
  const entering = preloadInitialDistantTerrain({ remote, world, drawFrame() {}, async preparePipelines() {}, async waitForGpu() {} })
    .then(() => { entered = true; });
  await frame();
  assert.equal(finalized, false);
  assert.equal(entered, false);
  complete = true;
  await delay(1050);
  await frame(); await frame();
  await entering;
  assert.equal(calls, 2);
  assert.equal(finalized, true);
});

for (const stage of ['download', 'connections', 'worker', 'pipelines', 'gpu'] as const) {
  test(`a distant ${stage} failure keeps entry blocked and reaches the entry error handler`, async t => {
    const { world, frame } = fixture(t);
    world.distantSurface.hasPendingWork = false;
    const remote: SpaceSurfaceSnapshotRemote = { async loadAll() {
      if (stage === 'download') throw new Error('download failed');
      return { loaded: 0, complete: true };
    } };
    world.finalizeSurfaceConnections = async () => {
      if (stage === 'connections') throw new Error('connections failed');
    };
    if (stage === 'worker') world.distantSurface.preparationError = 'worker failed';
    const entering = preloadInitialDistantTerrain({ remote, world, drawFrame() {}, async preparePipelines() {
      if (stage === 'pipelines') throw new Error('pipelines failed');
    }, async waitForGpu() {
      if (stage === 'gpu') throw new Error('gpu failed');
    } });
    let finished = false;
    const rejected = assert.rejects(entering, new RegExp(`${stage} failed`))
      .finally(() => { finished = true; });
    for (let i = 0; i < 6 && !finished; i++) await frame();
    assert.equal(finished, true, 'failed preparation must stop its frame loop');
    await rejected;
  });
}

test('hidden tabs continue preparing distant terrain without animation callbacks', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'hidden' } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete (globalThis as any).document;
  });
  const { world } = fixture(t);
  world.distantSurface.hasPendingWork = false;
  let frames = 0, gpuWaits = 0;
  await preloadInitialDistantTerrain({
    remote: { async loadAll() { return { loaded: 0, complete: true }; } }, world,
    drawFrame() { frames++; }, async preparePipelines() {}, async waitForGpu() { gpuWaits++; },
  });
  assert.ok(frames >= 3);
  assert.equal(gpuWaits, 1);
});
