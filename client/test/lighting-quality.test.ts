import { uiStub } from './fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  bendDirection,
} from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { AdaptiveResolutionController } from '../src/engine/render/AdaptiveResolution.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';
import {
  LIGHTING_QUALITY_SETTING_KEY, normalizeLightingQuality,
} from '../src/engine/render/LightingQuality.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

function lightingRenderer(maxTextureSize = 8192) {
  const renderer = Object.create(SceneRenderer.prototype) as SceneRenderer;
  renderer.scene = new THREE.Scene();
  renderer.renderer = {
    shadowMap: { enabled: true, needsUpdate: false },
    maxTextureSize,
  } as any;
  renderer.shadowsEnabled = true;
  renderer.lightingQuality = 'medium';
  renderer.skyDomeUniforms = {
    uGradientStrength: { value: 0 },
    uSunGlow: { value: 0 },
    uSkyColor: { value: new THREE.Color() },
    uCinematic: { value: 0 },
    uSurfaceUp: { value: new THREE.Vector3(0, 1, 0) },
    uEast: { value: new THREE.Vector3(1, 0, 0) },
    uNorth: { value: new THREE.Vector3(0, 0, 1) },
    uTime: { value: 0 },
  };
  renderer.setupLighting();
  renderer.setLightingQuality('medium');
  return renderer;
}

test('lighting defaults are safe for missing, invalid and prototype-key preferences', () => {
  for (const value of [undefined, null, '', 'extreme', '__proto__', 'constructor', 4096]) {
    assert.equal(normalizeLightingQuality(value), 'medium');
  }
  assert.equal(normalizeLightingQuality('ultra'), 'ultra');
});

test('quality switches resize shadow storage without invalidating WebGPU depth samplers', () => {
  const renderer = lightingRenderer();
  const shadow = renderer.sunLight.shadow;
  assert.equal(shadow.mapSize.x, 1024);
  const originalSunIntensity = renderer.sunLight.intensity;
  const originalExtent = shadow.camera.right;
  const receiverOffset = shadow.bias * (shadow.camera.far - shadow.camera.near);
  const softness = shadow.radius * originalExtent * 2 / shadow.mapSize.x;
  const map = new THREE.WebGLRenderTarget(1024, 1024);
  map.depthTexture = new THREE.DepthTexture(1024, 1024);
  let disposedMaps = 0;
  let disposedDepthTextures = 0;
  map.addEventListener('dispose', () => disposedMaps++);
  map.depthTexture.addEventListener('dispose', () => disposedDepthTextures++);
  shadow.map = map;

  renderer.setLightingQuality('high');
  assert.equal(shadow.mapSize.x, 2048);
  assert.equal(shadow.map, map);
  assert.equal(shadow.map.width, 2048);
  assert.equal(disposedMaps, 1);
  assert.equal(disposedDepthTextures, 0);
  assert.ok(renderer.sunLight.intensity > originalSunIntensity);
  assert.equal(renderer.fillLight.visible, true);
  assert.ok(renderer.skyDomeUniforms.uSunGlow.value > 0);

  renderer.setLightingQuality('ultra');
  assert.equal(shadow.mapSize.x, 4096);
  assert.ok(shadow.camera.right > originalExtent);
  assert.equal(shadow.camera.left, -shadow.camera.right);
  assert.equal(shadow.camera.top, shadow.camera.right);
  assert.equal(shadow.camera.bottom, shadow.camera.left);
  assert.ok(Math.abs(shadow.bias * (shadow.camera.far - shadow.camera.near)) >= Math.abs(receiverOffset));
  assert.ok(Math.abs(shadow.radius * shadow.camera.right * 2 / shadow.mapSize.x - softness) < 1e-9);

  renderer.setLightingQuality('low');
  assert.equal(shadow.map, map);
  assert.equal(shadow.map.width, 1);
  assert.equal(disposedDepthTextures, 0);
  assert.equal(renderer.renderer.shadowMap.enabled, false);
  assert.equal(renderer.sunLight.castShadow, true, 'preserve cached ShadowNodes across quality changes');
  assert.equal(shadow.autoUpdate, false);
  assert.equal(shadow.needsUpdate, false);
  assert.equal(renderer.fillLight.visible, false);
  assert.equal(renderer.shadowsEnabled, true, 'Low must retain the shadow preference');
  renderer.setLightingQuality('medium');
  assert.equal(renderer.renderer.shadowMap.enabled, true);
  assert.equal(renderer.sunLight.castShadow, true);
  assert.equal(shadow.autoUpdate, true);
  assert.equal(shadow.needsUpdate, true);
  assert.equal(shadow.mapSize.x, 1024);
  assert.equal(renderer.sunLight.intensity, originalSunIntensity);
});

test('shadow textures respect GPU limits and same-size changes keep their allocation', () => {
  const renderer = lightingRenderer(1024);
  const shadow = renderer.sunLight.shadow;
  const map = new THREE.WebGLRenderTarget(1024, 1024);
  shadow.map = map;
  renderer.setLightingQuality('ultra');
  assert.equal(shadow.mapSize.x, 1024);
  assert.equal(shadow.mapSize.y, 1024);
  assert.equal(shadow.map, map);
  renderer.setShadowsEnabled(false);
  assert.equal(shadow.map, map);
  assert.equal(shadow.map.width, 1);
});

test('slow frames and resolution settings preserve manual lighting, shadows and cinematic effects', t => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { devicePixelRatio: 2 } });
  t.after(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else delete (globalThis as any).window;
  });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  for (const quality of ['low', 'medium', 'high', 'ultra'] as const) {
    for (const shadows of [false, true]) {
      const renderer = lightingRenderer();
      renderer.setLightingQuality(quality);
      renderer.setShadowsEnabled(shadows);
      let pixelRatio = 2;
      renderer.renderer.getPixelRatio = () => pixelRatio;
      renderer.renderer.setPixelRatio = value => { pixelRatio = value ?? 1; };
      renderer.adaptiveResolution = new AdaptiveResolutionController();
      renderer.adaptiveResolution.setTargetFps(quality === 'ultra' ? 60 : 120);
      let hdrFrames = 0, directFrames = 0;
      const effects = { render: () => { hdrFrames++; }, dispose() { assert.fail('resolution must not dispose cinematic effects'); } };
      renderer.cinematicEffects = effects as any;
      renderer.renderer.render = () => { directFrames++; };
      const lighting = () => ({
        quality: renderer.getLightingQuality(), shadows: renderer.getShadowsEnabled(),
        shadowEnabled: renderer.renderer.shadowMap.enabled, shadowUpdates: renderer.sunLight.shadow.autoUpdate,
        shadowIntensity: renderer.sunLight.shadow.intensity, fill: renderer.fillLight.intensity,
        sun: renderer.sunLight.intensity, glow: renderer.skyDomeUniforms.uSunGlow.value,
      });
      const selected = lighting();
      renderer.setResolutionScale('auto');
      for (let frame = 0; frame < 600; frame++) {
        now += 100;
        (renderer as any).updateAdaptiveResolution();
      }
      assert.equal(renderer.getResolutionScaleState().scale, 0.5);
      assert.deepEqual(lighting(), selected, 'sustained low FPS must not change manually selected effects');
      for (const setting of [1, .67, .5, 'auto'] as const) {
        renderer.setResolutionScale(setting);
        assert.deepEqual(lighting(), selected);
        (renderer as any).renderWorld();
        assert.equal(renderer.cinematicEffects, effects);
      }
      assert.equal(hdrFrames, quality === 'ultra' ? 4 : 0);
      assert.equal(directFrames, quality === 'ultra' ? 0 : 4);
    }
  }
});

test('frame updates preserve the preset and align lighting with the torus projection', () => {
  const renderer = lightingRenderer();
  renderer.updatePlayerAvatar = () => {};
  renderer.bentLightTarget = new THREE.Vector3();
  renderer.bentLightDirection = new THREE.Vector3();
  renderer.bentSurfaceUp = new THREE.Vector3();
  renderer.bentFillDirection = new THREE.Vector3();
  renderer.skyColorDay = new THREE.Color('#74b9ff');
  renderer.scene.fog = new THREE.FogExp2(renderer.skyColorDay);
  renderer.setLightingQuality('ultra');
  const intensity = renderer.sunLight.intensity;
  const position = new THREE.Vector3(7400, 32, 1500);
  renderer.update(1 / 60, position);
  const up = new THREE.Vector3(0, 1, 0);
  bendDirection(position.x, position.y, position.z, up, up);
  assert.ok(renderer.hemiLight.position.distanceTo(up) < 1e-6);
  assert.ok(renderer.sunLight.shadow.camera.up.distanceTo(up) < 1e-6);
  assert.equal(renderer.sunLight.intensity, intensity);
  assert.ok(renderer.fillLight.position.distanceTo(renderer.fillLight.target.position) > 79);
  assert.equal(renderer.sunLight.shadow.normalBias, 0.05);
});

test('lighting preference persists, restores, and coexists with legacy disabled shadows', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map([['space_setting_shadows', 'false']]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as any).localStorage;
  });
  const applied: string[] = [];
  const bridge = {
    setLightingQuality(quality: import('../src/engine/render/LightingQuality.ts').LightingQuality) { applied.push(quality); return quality; },
    setShadowsEnabled: (value: boolean) => value,
  };
  const store = new SpaceUiStore();
  store.setSceneRenderer(uiStub('sceneRenderer', bridge));
  assert.equal(store.getSnapshot().lightingQuality, 'medium');
  assert.equal(store.getSnapshot().shadowsEnabled, false);
  store.setLightingQuality('ultra');
  assert.equal(store.getSnapshot().lightingQuality, 'ultra');
  assert.equal(values.get(LIGHTING_QUALITY_SETTING_KEY), 'ultra');
  const restored = new SpaceUiStore();
  restored.setSceneRenderer(uiStub('sceneRenderer', bridge));
  assert.equal(restored.getSnapshot().lightingQuality, 'ultra');
  assert.equal(restored.getSnapshot().shadowsEnabled, false);
  assert.deepEqual(applied, ['medium', 'ultra', 'ultra']);

  values.set(LIGHTING_QUALITY_SETTING_KEY, 'invalid');
  restored.setSceneRenderer(uiStub('sceneRenderer', bridge));
  assert.equal(restored.getSnapshot().lightingQuality, 'medium');
});

test('lighting still applies when browser storage is unavailable', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('Storage blocked'); },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as any).localStorage;
  });
  const store = new SpaceUiStore();
  store.setSceneRenderer(uiStub('sceneRenderer', { setLightingQuality: (quality: import('../src/engine/render/LightingQuality.ts').LightingQuality) => quality }));
  assert.equal(store.getSnapshot().lightingQuality, 'medium');
  store.setLightingQuality('high');
  assert.equal(store.getSnapshot().lightingQuality, 'high');
});

test('Ultra applies distance haze once and restores material fog for other render paths', () => {
  const renderer = lightingRenderer();
  const fog = new THREE.FogExp2('#74b9ff', 0.00012);
  renderer.scene.fog = fog;
  let hdrFrames = 0;
  renderer.cinematicEffects = {
    render: (_gpu: unknown, scene: import('three').Scene) => {
      assert.equal(scene.fog, fog, 'preserve the compiled material fog variant');
      assert.equal(fog.density, 0, 'postprocess haze must not stack with material fog');
      hdrFrames++;
    },
    dispose() {},
  } as any;
  renderer.setLightingQuality('ultra');
  for (let frame = 0; frame < 2; frame++) {
    (renderer as any).renderWorld();
    assert.equal(fog.density, 0.00012);
  }
  assert.equal(hdrFrames, 2);

  let directFrames = 0;
  renderer.renderer.render = () => {
    assert.equal(fog.density, 0.00012, 'non-HDR rendering keeps its original fog');
    directFrames++;
  };
  renderer.cinematicEffects!.render = () => { throw new Error('lost render'); };
  assert.throws(() => (renderer as any).renderWorld(), /lost render/);
  assert.equal(fog.density, 0.00012, 'failed HDR frames must also restore fog');
  renderer.setLightingQuality('high');
  (renderer as any).renderWorld();
  assert.equal(directFrames, 1);
});
