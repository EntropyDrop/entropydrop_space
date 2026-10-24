import test from 'node:test';
import assert from 'node:assert/strict';
import { getWorldProjection, setWorldProjection } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';
import { uiStub } from './fixtures.ts';

const WORLD_PROJECTION_SETTING_KEY = 'space_setting_world_projection';

function fixture(t: test.TestContext, stored: Record<string, string> = {}) {
  const values = new Map(Object.entries(stored));
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  t.after(() => {
    setWorldProjection('torus');
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as any).localStorage;
  });
  const store = new SpaceUiStore(), messages: string[] = [];
  t.mock.method(store, 'showToast', (message: string) => { messages.push(message); });
  const renderer = uiStub('sceneRenderer', {});
  store.setSceneRenderer(renderer);
  return { store, values, renderer, messages };
}

test('Ring is the default and manual terrain choices survive reload', t => {
  const { store, values, renderer, messages } = fixture(t);
  assert.equal(store.getSnapshot().worldProjection, 'torus');
  store.setResolutionScale('0.5', false);
  store.startGame(false);
  store.setWorldProjection('flat');
  assert.equal(getWorldProjection(), 'flat');
  assert.equal(store.getSnapshot().worldProjection, 'flat');
  assert.equal(store.getSnapshot().resolutionScaleMode, '0.5');
  assert.equal(values.get(WORLD_PROJECTION_SETTING_KEY), 'flat');
  const restoredFlat = new SpaceUiStore(); restoredFlat.setSceneRenderer(renderer);
  assert.equal(restoredFlat.getSnapshot().worldProjection, 'flat');
  store.setWorldProjection('torus');
  assert.equal(getWorldProjection(), 'torus');
  const restored = new SpaceUiStore(); restored.setSceneRenderer(renderer);
  assert.equal(restored.getSnapshot().worldProjection, 'torus');
  assert.equal(values.get(WORLD_PROJECTION_SETTING_KEY), 'torus');
  assert.deepEqual(messages, []);
});

test('invalid saved terrain shapes use Ring', t => {
  const { store } = fixture(t, { [WORLD_PROJECTION_SETTING_KEY]: 'bad' });
  assert.equal(store.getSnapshot().worldProjection, 'torus');
});
