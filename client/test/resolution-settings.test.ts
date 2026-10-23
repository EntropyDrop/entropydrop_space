import { uiStub } from './fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';
import {
  DEFAULT_DISTANT_SURFACE_SETTINGS,
  normalizeDistantSurfaceSettings,
} from '@entropydrop/space-engine/render/DistantSurfaceLayer.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';
import { AdaptiveResolutionController } from '../src/engine/render/AdaptiveResolution.ts';

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
  const state = () => ({ mode: 'auto' as const, scale: 1, targetFps });
  const renderer = {
    setResolutionScale: state,
    setLightingQuality: (quality: import('../src/engine/render/LightingQuality.ts').LightingQuality) => { targetFps = quality === 'ultra' ? 60 : 120; return quality; },
    getResolutionScaleState: state,
  };
  const store = new SpaceUiStore();
  store.setSceneRenderer(uiStub('sceneRenderer', renderer));
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

  store.setSceneRenderer(uiStub('sceneRenderer', renderer));
  store.setResolutionScale('0.25', false);

  assert.deepEqual(applied, [1, 0.25]);
  assert.equal(store.getSnapshot().resolutionScaleMode, '0.25');
  assert.equal(store.getSnapshot().resolutionScale, 0.25);
  assert.equal(store.getSnapshot().resolutionPixelRatio, 0.5);

  renderer.onResolutionScaleChange({
    mode: 'auto',
    scale: 0.8,
    fixedScale: 0.25,
    averageFrameMs: 16.5,
    nativePixelRatio: 2,
    effectivePixelRatio: 1.6,
  });
  assert.equal(store.getSnapshot().resolutionScaleMode, 'auto');
  assert.equal(store.getSnapshot().resolutionScale, 0.8);
  assert.equal(store.getSnapshot().resolutionPixelRatio, 1.6);
});

test('resolution preferences restore supported scales and migrate legacy values', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  const key = 'space_setting_resolution_scale';
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value),
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as any).localStorage;
  });
  const controller = new AdaptiveResolutionController();
  const renderer = uiStub('sceneRenderer', {
    setResolutionScale(setting: 'auto' | number) {
      controller.setSetting(setting);
      return controller.getState();
    },
    getResolutionScaleState: () => controller.getState(),
  });
  const store = new SpaceUiStore();
  assert.equal(store.getSnapshot().resolutionScaleMode, '1');
  store.setSceneRenderer(renderer);
  assert.equal(controller.getState().mode, 'fixed');
  assert.equal(controller.currentScale, 1);
  for (const scale of [0.5, 0.25, 1]) {
    store.setResolutionScale(scale);
    assert.equal(values.get(key), String(scale));
    const restored = new SpaceUiStore();
    restored.setSceneRenderer(renderer);
    assert.equal(restored.getSnapshot().resolutionScaleMode, String(scale));
    assert.equal(controller.currentScale, scale);
  }
  for (const [saved, expected] of [['auto', 1], ['', 1], ['invalid', 1], ['0.8', 1], ['0.67', 0.5]] as const) {
    values.set(key, saved);
    store.setSceneRenderer(renderer);
    assert.equal(controller.getState().mode, 'fixed');
    assert.equal(controller.currentScale, expected);
    assert.equal(store.getSnapshot().resolutionScaleMode, String(expected));
  }
});

test('renderer applies all resolution scales to the drawing buffer and preserves them on resize', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const viewport = { innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1 };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: viewport });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else delete (globalThis as any).window;
  });
  const renderer = Object.create(SceneRenderer.prototype) as SceneRenderer;
  renderer.adaptiveResolution = new AdaptiveResolutionController();
  renderer.camera = { aspect: 1, updateProjectionMatrix() {} } as any;
  let pixelRatio = 1;
  renderer.renderer = {
    getPixelRatio: () => pixelRatio,
    setPixelRatio: (value: number) => { pixelRatio = value; },
    setSize() {},
  } as any;
  for (const scale of [1, 0.5, 0.25]) {
    viewport.devicePixelRatio = 1;
    renderer.setResolutionScale(scale);
    assert.equal(renderer.renderer.getPixelRatio(), scale);
    viewport.devicePixelRatio = 2;
    renderer.onWindowResize();
    assert.equal(renderer.renderer.getPixelRatio(), 2 * scale);
    assert.equal(renderer.resolutionScale, scale);
    assert.equal(renderer.getResolutionScaleState().fixedScale, scale);
  }
});

test('shadow preference is applied to the renderer independently of resolution', () => {
  const applied: boolean[] = [];
  const renderer: any = {
    setResolutionScale() {
      return { mode: 'auto', scale: 1, effectivePixelRatio: 1 };
    },
    setShadowsEnabled(enabled: boolean) {
      applied.push(enabled);
      return enabled;
    },
    getShadowsEnabled: () => applied.at(-1) ?? true,
  };
  const store = new SpaceUiStore();

  store.setSceneRenderer(uiStub('sceneRenderer', renderer));
  store.setShadowsEnabled(false, false);

  assert.deepEqual(applied, [false, false]);
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
    store.setMinimap(uiStub('minimap', minimap));
    assert.equal(store.getSnapshot().minimapEnabled, false);
    assert.deepEqual(applied, [false]);

    store.setMinimapEnabled(true);
    assert.equal(store.getSnapshot().minimapEnabled, true);
    assert.equal(values.get('space_setting_minimap'), 'true');
    assert.deepEqual(applied, [false, true]);

    const restored: boolean[] = [];
    const restoredStore = new SpaceUiStore();
    restoredStore.setMinimap(uiStub('minimap', {
      setEnabled(enabled: boolean) {
        restored.push(enabled);
        return enabled;
      },
    }));
    assert.equal(restoredStore.getSnapshot().minimapEnabled, true);
    assert.deepEqual(restored, [true]);
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete (globalThis as any).localStorage;
  }
});

test('renderer combines the manual shadow preference with the selected lighting preset', () => {
  const renderer = Object.create(SceneRenderer.prototype) as SceneRenderer;
  renderer.renderer = { shadowMap: { enabled: true } } as any;
  renderer.sunLight = { castShadow: true, shadow: { needsUpdate: false } } as any;
  renderer.lightingQuality = 'ultra';
  renderer.setShadowsEnabled(false);
  assert.equal(renderer.renderer.shadowMap.enabled, false);
  assert.equal(renderer.sunLight.shadow.intensity, 0);
  assert.equal(renderer.sunLight.shadow.autoUpdate, false);
  assert.equal(renderer.sunLight.shadow.needsUpdate, false);

  renderer.setShadowsEnabled(true);
  assert.equal(renderer.renderer.shadowMap.enabled, true);
  assert.equal(renderer.sunLight.shadow.intensity, 1);
  assert.equal(renderer.sunLight.shadow.autoUpdate, true);
  assert.equal(renderer.sunLight.shadow.needsUpdate, true);

  renderer.lightingQuality = 'low';
  renderer.setShadowsEnabled(true);
  assert.equal(renderer.shadowsEnabled, true);
  assert.equal(renderer.renderer.shadowMap.enabled, false);
  assert.equal(renderer.sunLight.shadow.autoUpdate, false);
});

test('the canonical torus distant layer stays enabled through renderer setup', () => {
  const lodEnabled: boolean[] = [];
  const store = new SpaceUiStore();
  store.setWorld(uiStub('world', {
    renderDistance: 8,
    getDistantSurfaceSettings: () => ({ ...DEFAULT_DISTANT_SURFACE_SETTINGS }),
    setDistantSurfaceEnabled(enabled: boolean) {
      lodEnabled.push(enabled);
      return enabled;
    },
  }));

  store.setSceneRenderer(uiStub('sceneRenderer', {}));

  assert.equal('worldShapeMode' in store.getSnapshot(), false);
  assert.deepEqual(lodEnabled, [true, true]);
});

test('distant terrain pixel budgets apply immediately through settings state', () => {
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
  store.setWorld(uiStub('world', world));
  store.setDistantSurfaceSetting('subdivisionSizePx2', 1, false);
  store.setDistantSurfaceSetting('renderDistanceChunks', 2048, false);
  store.setDistantSurfaceSetting('dataBudgetMiB', 32, false);
  store.setDistantSurfaceSetting('geometryBudgetMiB', 512, false);

  assert.equal(applied.length, 4);
  assert.equal(store.getSnapshot().distantSurfaceSettings.subdivisionSizePx2, 1);
  assert.equal(store.getSnapshot().distantSurfaceSettings.renderDistanceChunks, 2048);
  assert.equal(store.getSnapshot().distantSurfaceSettings.dataBudgetMiB, 32);
  assert.equal(store.getSnapshot().distantSurfaceSettings.geometryBudgetMiB, 512);
});

test('subdivision size and geometry budget persist independently of near detail and scene resolution', t => {
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
  let applied = { ...DEFAULT_DISTANT_SURFACE_SETTINGS };
  const world = { renderDistance: 8, getDistantSurfaceSettings: () => applied,
    setDistantSurfaceSettings(value: any) { return applied = normalizeDistantSurfaceSettings(value); } };
  const store = new SpaceUiStore();
  store.setWorld(uiStub('world', world));
  store.setResolutionScale('0.5', false);
  store.setDistantSurfaceSetting('geometryBudgetMiB', 512);
  assert.equal(applied.subdivisionSizePx2, 64);
  for (const area of [256, 64, 16, 4, 1, 63]) {
    store.setDistantSurfaceSetting('subdivisionSizePx2', area);
    assert.equal(applied.subdivisionSizePx2, area);
    assert.equal(store.getSnapshot().renderDistance, 8);
    assert.equal(store.getSnapshot().resolutionScaleMode, '0.5');
    const restored = new SpaceUiStore(); restored.setWorld(uiStub('world', world));
    assert.equal(restored.getSnapshot().distantSurfaceSettings.subdivisionSizePx2, area);
    assert.equal(restored.getSnapshot().distantSurfaceSettings.geometryBudgetMiB, 512);
  }
  // Old high-detail preferences and custom values must not be silently lowered.
  for (const savedArea of [16, 63]) {
    values.set('space_setting_distant_surface', JSON.stringify({ subdivisionSizePx2: savedArea,
      renderDistanceChunks: 128, dataBudgetMiB: 32 }));
    const restored = new SpaceUiStore(); restored.setWorld(uiStub('world', world));
    assert.deepEqual(restored.getSnapshot().distantSurfaceSettings,
      { subdivisionSizePx2: savedArea, renderDistanceChunks: 128, dataBudgetMiB: 32, geometryBudgetMiB: 160 });
    restored.resetDistantSurfaceSettings();
    assert.equal(applied.subdivisionSizePx2, 64);
    assert.equal(applied.dataBudgetMiB, 512);
    assert.equal(applied.geometryBudgetMiB, 160);
    assert.equal(JSON.parse(values.get('space_setting_distant_surface')!).subdivisionSizePx2, 64);
    assert.equal(JSON.parse(values.get('space_setting_distant_surface')!).dataBudgetMiB, 512);
    assert.equal(JSON.parse(values.get('space_setting_distant_surface')!).geometryBudgetMiB, 160);
  }
  values.set('space_setting_distant_surface', JSON.stringify({ subdivisionSizePx2: 1, geometryBudgetMiB: 64 }));
  const previousBudget = new SpaceUiStore(); previousBudget.setWorld(uiStub('world', world));
  assert.equal(previousBudget.getSnapshot().distantSurfaceSettings.geometryBudgetMiB, 64);
});

test('persisted near render distances cannot bypass the 16-chunk AOI cap', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => key === 'space_setting_render_dist' ? '24' : null,
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as any).localStorage;
  });
  const applied: number[] = [], store = new SpaceUiStore();
  store.setWorld(uiStub('world', { renderDistance: 8, setRenderDistance: (value: number) => applied.push(value) }));
  assert.deepEqual(applied, [16]);
  assert.equal(store.getSnapshot().renderDistance, 16);
});
