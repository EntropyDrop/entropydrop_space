import test from 'node:test';
import assert from 'node:assert/strict';
import { DistantTerrainFpsGuard } from '../src/engine/render/DistantTerrainFpsGuard.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';
import { uiStub } from './fixtures.ts';

function sampleWindow(sample: (now: number) => unknown, start: number, frames = 100) {
  const results: unknown[] = [];
  for (let frame = 1; frame <= frames; frame++) {
    results.push(sample(start + Math.round(frame * 2000 / frames)));
  }
  return results;
}

test('50 FPS requires three complete two-second samples before disabling distant terrain', () => {
  const guard = new DistantTerrainFpsGuard();
  const sample = (now: number) => guard.sampleFrame(now);
  assert.equal(sample(0), false);
  assert.ok(sampleWindow(sample, 0).every(value => value === false));
  assert.ok(sampleWindow(sample, 2000).every(value => value === false));
  const lastWindow = sampleWindow(sample, 4000);
  assert.ok(lastWindow.slice(0, -1).every(value => value === false));
  assert.equal(lastWindow.at(-1), true);
});

for (const fps of [60, 120]) {
  test(`${fps} FPS resets the low-FPS streak`, () => {
    const guard = new DistantTerrainFpsGuard();
    const sample = (now: number) => guard.sampleFrame(now);
    sample(0);
    sampleWindow(sample, 0);
    sampleWindow(sample, 2000);
    assert.ok(sampleWindow(sample, 4000, fps * 2).every(value => value === false));
    assert.ok(sampleWindow(sample, 6000).every(value => value === false));
    assert.ok(sampleWindow(sample, 8000).every(value => value === false));
    assert.equal(sampleWindow(sample, 10000).at(-1), true);
  });
}

test('foreground samples measure the full window and a single stall cannot supply three samples', () => {
  const guard = new DistantTerrainFpsGuard();
  guard.sampleFrame(0);
  assert.equal(guard.sampleFrame(10000), false);
  // Even a very long stall contributes only one observation.
  assert.equal(sampleWindow(now => guard.sampleFrame(now), 10000).at(-1), false);
  assert.equal(sampleWindow(now => guard.sampleFrame(now), 12000).at(-1), true);
});

test('visibility changes discard partial windows, prior low samples and suspended RAF time', () => {
  const guard = new DistantTerrainFpsGuard();
  const sample = (now: number) => guard.sampleFrame(now);
  sample(0);
  sampleWindow(sample, 0);
  sampleWindow(sample, 2000);
  sample(4500);
  assert.equal(guard.sampleFrame(4500, false), false);
  assert.equal(sample(60000), false, 'resuming starts a new window');
  assert.ok(sampleWindow(sample, 60000).every(value => value === false));
  assert.ok(sampleWindow(sample, 62000).every(value => value === false));
  assert.equal(sampleWindow(sample, 64000).at(-1), true);
});

function settingsFixture(t: test.TestContext) {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as any).localStorage;
  });
  let enabled = true;
  const calls: boolean[] = [];
  const world = uiStub('world', {
    renderDistance: 8,
    distantSurface: { isEnabled: () => enabled },
    setDistantSurfaceEnabled(value: boolean) { calls.push(value); return enabled = value; },
  });
  const store = new SpaceUiStore();
  const toasts: string[] = [];
  t.mock.method(store, 'showToast', (message: string) => { toasts.push(message); });
  store.setWorld(world);
  return { store, world, values, calls, toasts };
}

test('the master switch applies immediately, persists and survives renderer setup and reload', t => {
  const { store, world, values } = settingsFixture(t);
  assert.equal(store.getSnapshot().distantSurfaceEnabled, true);
  store.setDistantSurfaceEnabled(false);
  assert.equal(world.distantSurface.isEnabled(), false);
  assert.equal(values.get('space_setting_distant_surface_enabled'), 'false');
  store.setSceneRenderer(uiStub('sceneRenderer', {}));
  assert.equal(store.getSnapshot().distantSurfaceEnabled, false);
  assert.equal(world.distantSurface.isEnabled(), false);

  const restored = new SpaceUiStore();
  restored.setWorld(world);
  restored.setSceneRenderer(uiStub('sceneRenderer', {}));
  assert.equal(restored.getSnapshot().distantSurfaceEnabled, false);
  assert.equal(world.distantSurface.isEnabled(), false);
  restored.setDistantSurfaceEnabled(true);
  assert.equal(world.distantSurface.isEnabled(), true);
  assert.equal(values.get('space_setting_distant_surface_enabled'), 'true');
});

test('low FPS disables and saves the far layer once without changing near distance or resolution', t => {
  const { store, world, values, calls, toasts } = settingsFixture(t);
  store.setResolutionScale('0.5', false);
  const sample = (now: number) => store.sampleDistantTerrainFrame(now);
  sample(0);
  sampleWindow(sample, 0);
  sampleWindow(sample, 2000);
  assert.equal(world.distantSurface.isEnabled(), true);
  sampleWindow(sample, 4000);
  assert.equal(world.distantSurface.isEnabled(), false);
  assert.equal(store.getSnapshot().distantSurfaceEnabled, false);
  assert.equal(values.get('space_setting_distant_surface_enabled'), 'false');
  assert.equal(store.getSnapshot().renderDistance, 8);
  assert.equal(store.getSnapshot().resolutionScaleMode, '0.5');
  sampleWindow(sample, 6000, 240);
  sampleWindow(sample, 8000);
  assert.deepEqual(calls, [true, false]);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /below 60/);

  store.setDistantSurfaceEnabled(true);
  sample(10000);
  sampleWindow(sample, 10000);
  sampleWindow(sample, 12000);
  assert.equal(world.distantSurface.isEnabled(), true, 'manual enabling starts a fresh observation');
  sampleWindow(sample, 14000);
  assert.equal(world.distantSurface.isEnabled(), false);
  assert.equal(toasts.length, 2);
});

test('resetting recommended settings restores the master switch and clears previous samples', t => {
  const { store, values } = settingsFixture(t);
  store.setDistantSurfaceEnabled(false);
  store.resetDistantSurfaceSettings();
  assert.equal(store.getSnapshot().distantSurfaceEnabled, true);
  assert.equal(values.get('space_setting_distant_surface_enabled'), 'true');
  const sample = (now: number) => store.sampleDistantTerrainFrame(now);
  sample(0);
  sampleWindow(sample, 0);
  sampleWindow(sample, 2000);
  store.resetDistantSurfaceSettings();
  sample(4000);
  sampleWindow(sample, 4000);
  sampleWindow(sample, 6000);
  assert.equal(store.getSnapshot().distantSurfaceEnabled, true);
  sampleWindow(sample, 8000);
  assert.equal(store.getSnapshot().distantSurfaceEnabled, false);
});
