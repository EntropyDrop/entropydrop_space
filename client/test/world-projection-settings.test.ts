import test from 'node:test';
import assert from 'node:assert/strict';
import { getWorldProjection, setWorldProjection } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { WorldProjectionFallback, WORLD_PROJECTION_SETTING_KEY, WORLD_PROJECTION_AUTO_SETTING_KEY } from '../src/engine/render/WorldProjectionFallback.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';
import { uiStub } from './fixtures.ts';

function windowFrames(sample: (now: number) => void, start: number, fps: number) {
  for (let i = 1; i <= fps * 5; i++) sample(start + i * 1000 / fps);
}

test('two complete low windows are required; 60 FPS and healthy windows break the streak', () => {
  const policy = new WorldProjectionFallback();
  const triggers: number[] = [];
  const frame = (now: number) => { if (policy.sampleFrame(now, true)) triggers.push(now); };
  frame(0);
  windowFrames(frame, 0, 50);
  assert.deepEqual(triggers, []);
  windowFrames(frame, 5000, 60);
  windowFrames(frame, 10000, 50);
  assert.deepEqual(triggers, []);
  windowFrames(frame, 15000, 50);
  assert.deepEqual(triggers, [20000]);
});

test('foreground sampling restarts after suspension and does not count a long gap as two samples', () => {
  const policy = new WorldProjectionFallback();
  const triggers: number[] = [];
  const frame = (now: number) => { if (policy.sampleFrame(now, true)) triggers.push(now); };
  frame(0); windowFrames(frame, 0, 40);
  policy.sampleFrame(5001, false);
  frame(60000); windowFrames(frame, 60000, 40);
  assert.deepEqual(triggers, []);
  windowFrames(frame, 65000, 40);
  assert.deepEqual(triggers, [70000]);
  policy.reset(); frame(100000); frame(130000);
  assert.equal(triggers.length, 1, 'one stalled foreground frame is only one sample');
});

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

test('defaults, manual choices, auto preference and triggered choice survive reload', t => {
  const { store, values, renderer, messages } = fixture(t);
  assert.equal(store.getSnapshot().worldProjection, 'torus');
  assert.equal(store.getSnapshot().worldProjectionAuto, true);
  store.setResolutionScale('0.5', false);
  store.startGame(false);
  const frame = (now: number) => store.sampleWorldProjectionFrame(now, true);
  frame(0); windowFrames(frame, 0, 50);
  assert.equal(getWorldProjection(), 'torus');
  windowFrames(frame, 5000, 50);
  assert.equal(getWorldProjection(), 'flat');
  assert.equal(store.getSnapshot().worldProjection, 'flat');
  assert.equal(store.getSnapshot().resolutionScaleMode, '0.5');
  assert.equal(values.get(WORLD_PROJECTION_SETTING_KEY), 'flat');
  assert.equal(messages.length, 1);
  windowFrames(frame, 10000, 120);
  assert.equal(getWorldProjection(), 'flat', 'recovery never switches back automatically');
  store.setWorldProjectionAuto(false);
  store.setWorldProjection('torus');
  frame(20000); windowFrames(frame, 20000, 20); windowFrames(frame, 25000, 20);
  assert.equal(getWorldProjection(), 'torus');
  const restored = new SpaceUiStore(); restored.setSceneRenderer(renderer);
  assert.equal(restored.getSnapshot().worldProjection, 'torus');
  assert.equal(restored.getSnapshot().worldProjectionAuto, false);
  assert.equal(values.get(WORLD_PROJECTION_AUTO_SETTING_KEY), 'false');
});

test('manual changes reset a partial streak and sampling waits until the game starts', t => {
  const { store, messages } = fixture(t);
  const frame = (now: number) => store.sampleWorldProjectionFrame(now, true);
  frame(0); windowFrames(frame, 0, 30); windowFrames(frame, 5000, 30);
  assert.equal(getWorldProjection(), 'torus');
  store.startGame(false);
  frame(10000); windowFrames(frame, 10000, 50);
  store.setWorldProjection('torus');
  frame(15000); windowFrames(frame, 15000, 50);
  assert.equal(getWorldProjection(), 'torus');
  store.setWorldProjectionAuto(false); store.setWorldProjectionAuto(true);
  frame(20000); windowFrames(frame, 20000, 50);
  assert.equal(getWorldProjection(), 'torus');
  windowFrames(frame, 25000, 50);
  assert.equal(getWorldProjection(), 'flat');
  assert.equal(messages.length, 1);
});

test('invalid saved values use Ring and enabled defaults', t => {
  const { store } = fixture(t, { [WORLD_PROJECTION_SETTING_KEY]: 'bad', [WORLD_PROJECTION_AUTO_SETTING_KEY]: 'bad' });
  assert.equal(store.getSnapshot().worldProjection, 'torus');
  assert.equal(store.getSnapshot().worldProjectionAuto, true);
});
