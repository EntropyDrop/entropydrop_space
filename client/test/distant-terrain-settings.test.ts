import test from 'node:test';
import assert from 'node:assert/strict';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';
import { uiStub } from './fixtures.ts';

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

test('the master switch saves the far layer choice without changing near distance or resolution', t => {
  const { store, world, values, calls, toasts } = settingsFixture(t);
  store.setResolutionScale('0.5', false);
  store.setDistantSurfaceEnabled(false);
  assert.equal(world.distantSurface.isEnabled(), false);
  assert.equal(store.getSnapshot().distantSurfaceEnabled, false);
  assert.equal(values.get('space_setting_distant_surface_enabled'), 'false');
  assert.equal(store.getSnapshot().renderDistance, 8);
  assert.equal(store.getSnapshot().resolutionScaleMode, '0.5');
  assert.deepEqual(calls, [true, false]);
  assert.equal(toasts.length, 0);

  store.setDistantSurfaceEnabled(true);
  assert.equal(world.distantSurface.isEnabled(), true);
  assert.equal(store.getSnapshot().distantSurfaceEnabled, true);
  assert.equal(values.get('space_setting_distant_surface_enabled'), 'true');
  assert.deepEqual(calls, [true, false, true]);
  assert.equal(toasts.length, 0);
});

test('resetting recommended settings restores the master switch', t => {
  const { store, values } = settingsFixture(t);
  store.setDistantSurfaceEnabled(false);
  store.resetDistantSurfaceSettings();
  assert.equal(store.getSnapshot().distantSurfaceEnabled, true);
  assert.equal(values.get('space_setting_distant_surface_enabled'), 'true');
});
