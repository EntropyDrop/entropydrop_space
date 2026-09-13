import test from 'node:test';
import assert from 'node:assert/strict';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';
import {
  DEFAULT_DISTANT_SURFACE_SETTINGS,
  normalizeDistantSurfaceSettings,
} from '@entropydrop/space-engine/render/DistantSurfaceLayer.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';
import {
  DEFAULT_ENTITY_IMPOSTOR_SETTINGS, ENTITY_IMPOSTOR_SETTING_KEY, normalizeEntityImpostorSettings,
} from '../src/engine/render/EntityImpostorSettings.ts';

test('restoring Ultra publishes the final 60 FPS target after initial resolution setup', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => key === 'space_setting_lighting_quality' ? 'ultra' : null,
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as any).localStorage;
  });
  let targetFps = 120;
  const state = () => ({ mode: 'auto', scale: 1, effectsQuality: 'full', targetFps });
  const renderer = {
    setResolutionScale: state,
    setLightingQuality: (quality: string) => { targetFps = quality === 'ultra' ? 60 : 120; return quality; },
    getResolutionScaleState: state,
  };
  const store = new SpaceUiStore();
  store.setSceneRenderer(renderer);
  assert.equal(store.getSnapshot().lightingQuality, 'ultra');
  assert.equal(store.getSnapshot().resolutionTargetFps, 60);
});

test('resolution setting is applied to the renderer and follows automatic updates', () => {
  const applied: Array<'auto' | number> = [];
  const renderer: any = {
    setResolutionScale(setting: 'auto' | number) {
      applied.push(setting);
      const scale = setting === 'auto' ? 1 : setting;
      return {
        mode: setting === 'auto' ? 'auto' : 'fixed',
        scale,
        fixedScale: scale,
        averageFrameMs: 1000 / 60,
        nativePixelRatio: 2,
        effectivePixelRatio: 2 * scale,
      };
    },
  };
  const store = new SpaceUiStore();

  store.setSceneRenderer(renderer);
  store.setResolutionScale('0.67', false);

  assert.deepEqual(applied, ['auto', 0.67]);
  assert.equal(store.getSnapshot().resolutionScaleMode, '0.67');
  assert.equal(store.getSnapshot().resolutionScale, 0.67);
  assert.equal(store.getSnapshot().resolutionPixelRatio, 1.34);

  renderer.onResolutionScaleChange({
    mode: 'auto',
    scale: 0.8,
    fixedScale: 0.67,
    averageFrameMs: 16.5,
    effectsQuality: 'reduced',
    nativePixelRatio: 2,
    effectivePixelRatio: 1.6,
  });
  assert.equal(store.getSnapshot().resolutionScaleMode, 'auto');
  assert.equal(store.getSnapshot().resolutionScale, 0.8);
  assert.equal(store.getSnapshot().resolutionPixelRatio, 1.6);
  assert.equal(store.getSnapshot().resolutionEffectsQuality, 'reduced');
});

test('shadow preference is applied to the renderer independently of adaptive quality', () => {
  const applied: boolean[] = [];
  const renderer: any = {
    setResolutionScale() {
      return { mode: 'auto', scale: 1, effectivePixelRatio: 1, effectsQuality: 'full' };
    },
    setShadowsEnabled(enabled: boolean) {
      applied.push(enabled);
      return enabled;
    },
    getShadowsEnabled: () => applied.at(-1) ?? true,
  };
  const store = new SpaceUiStore();

  store.setSceneRenderer(renderer);
  store.setShadowsEnabled(false, false);

  assert.deepEqual(applied, [true, false]);
  assert.equal(store.getSnapshot().shadowsEnabled, false);
});

test('minimap preference is restored, applied immediately, and persisted', () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
    },
  });
  try {
    const applied: boolean[] = [];
    const minimap = {
      enabled: true,
      setEnabled(enabled: boolean) {
        this.enabled = enabled;
        applied.push(enabled);
        return enabled;
      },
      isEnabled() {
        return this.enabled;
      },
    };
    const store = new SpaceUiStore();

    assert.equal(store.getSnapshot().minimapEnabled, false, 'minimap should default to off');
    store.setMinimap(minimap);
    assert.equal(store.getSnapshot().minimapEnabled, false);
    assert.deepEqual(applied, [false]);

    store.setMinimapEnabled(true);
    assert.equal(store.getSnapshot().minimapEnabled, true);
    assert.equal(values.get('space_setting_minimap'), 'true');
    assert.deepEqual(applied, [false, true]);

    const restored: boolean[] = [];
    const restoredStore = new SpaceUiStore();
    restoredStore.setMinimap({
      setEnabled(enabled: boolean) {
        restored.push(enabled);
        return enabled;
      },
    });
    assert.equal(restoredStore.getSnapshot().minimapEnabled, true);
    assert.deepEqual(restored, [true]);
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete (globalThis as any).localStorage;
  }
});

test('renderer combines the shadow preference with adaptive effects quality', () => {
  const renderer = Object.create(SceneRenderer.prototype) as SceneRenderer;
  const internal = renderer as any;
  internal.renderer = { shadowMap: { enabled: true, needsUpdate: false } };
  internal.shadowsEnabled = true;
  internal.adaptiveEffectsQuality = 'full';

  renderer.setShadowsEnabled(false);
  assert.equal(internal.renderer.shadowMap.enabled, false);
  assert.equal(internal.renderer.shadowMap.needsUpdate, true);

  internal.renderer.shadowMap.needsUpdate = false;
  internal.adaptiveEffectsQuality = 'reduced';
  renderer.setShadowsEnabled(true);
  assert.equal(internal.renderer.shadowMap.enabled, false);
  assert.equal(internal.renderer.shadowMap.needsUpdate, false);

  internal.adaptiveEffectsQuality = 'full';
  renderer.setShadowsEnabled(true);
  assert.equal(internal.renderer.shadowMap.enabled, true);
});

test('world shape setting is applied immediately through the renderer bridge', () => {
  const applied: string[] = [];
  const lodEnabled: boolean[] = [];
  const renderer = {
    setWorldShapeMode(mode: string) {
      applied.push(mode);
      return mode;
    },
    getWorldShapeMode: () => applied.at(-1) || 'earth',
  };
  const store = new SpaceUiStore();
  store.setWorld({
    renderDistance: 8,
    getDistantSurfaceSettings: () => ({ ...DEFAULT_DISTANT_SURFACE_SETTINGS }),
    setDistantSurfaceEnabled(enabled: boolean) {
      lodEnabled.push(enabled);
      return enabled;
    },
  });

  store.setSceneRenderer(renderer);
  store.setWorldShapeMode('earth', false);
  store.setWorldShapeMode('torus', false);

  assert.equal(store.getSnapshot().worldShapeMode, 'torus');
  assert.deepEqual(applied, ['earth', 'earth', 'torus']);
  assert.deepEqual(lodEnabled, [false, false, false, true]);
});

test('distant terrain thresholds apply immediately through settings state', () => {
  const applied: any[] = [];
  const world = {
    renderDistance: 8,
    getDistantSurfaceSettings: () => ({ ...DEFAULT_DISTANT_SURFACE_SETTINGS }),
    setDistantSurfaceSettings(value: any) {
      const normalized = normalizeDistantSurfaceSettings(value);
      applied.push(normalized);
      return normalized;
    },
  };
  const store = new SpaceUiStore();
  store.setWorld(world);
  store.setDistantSurfaceSetting('lod32Distance', 3000, false);
  store.setDistantSurfaceSetting('connectionDistance', 0, false);
  store.setDistantSurfaceSetting('lod16Enabled', false, false);

  assert.equal(applied.length, 3);
  assert.equal(store.getSnapshot().distantSurfaceSettings.lod32Distance, 3000);
  assert.equal(store.getSnapshot().distantSurfaceSettings.connectionDistance, 0);
  assert.equal(store.getSnapshot().distantSurfaceSettings.lod16Enabled, false);
});

test('entity plane settings persist and stay independent of terrain, AOI and world shape', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as any).localStorage;
  });
  const renderer = Object.create(SceneRenderer.prototype) as SceneRenderer;
  const bridge = {
    getEntityImpostorSettings: () => renderer.getEntityImpostorSettings(),
    setEntityImpostorSettings: value => renderer.setEntityImpostorSettings(value),
  };
  const store = new SpaceUiStore();
  store.setSceneRenderer(bridge);
  store.setEntityImpostorSetting('startDistance', 120);
  store.setEntityImpostorSetting('maxDistance', 3400);
  assert.deepEqual(renderer.getEntityImpostorSettings(), { startDistance: 120, maxDistance: 3400 });
  assert.deepEqual(JSON.parse(values.get(ENTITY_IMPOSTOR_SETTING_KEY)), renderer.getEntityImpostorSettings());
  store.setWorld({ renderDistance: 4, getDistantSurfaceSettings: () => ({ maxDistance: 750 }) });
  store.setDistantSurfaceSetting('maxDistance', 8500, false);
  store.setRenderDistance(20, false);
  store.setWorldShapeMode('earth', false);
  assert.deepEqual(store.getSnapshot().entityImpostorSettings, { startDistance: 120, maxDistance: 3400 });
  const restored = new SpaceUiStore();
  restored.setSceneRenderer(bridge);
  assert.deepEqual(restored.getSnapshot().entityImpostorSettings, { startDistance: 120, maxDistance: 3400 });
  restored.resetEntityImpostorSettings();
  assert.deepEqual(renderer.getEntityImpostorSettings(), DEFAULT_ENTITY_IMPOSTOR_SETTINGS);
  assert.deepEqual(normalizeEntityImpostorSettings({ startDistance: Infinity, maxDistance: NaN }), DEFAULT_ENTITY_IMPOSTOR_SETTINGS);
  assert.deepEqual(normalizeEntityImpostorSettings({ startDistance: 99999, maxDistance: -1 }), { startDistance: 1000, maxDistance: 1100 });
});
