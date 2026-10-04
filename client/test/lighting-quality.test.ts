import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  bendDirection,
} from '@entropydrop/space-engine/torus/TorusWorld.ts';
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
  renderer.adaptiveEffectsQuality = 'full';
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

test('adaptive fallback restores the selected quality without overriding disabled shadows', () => {
  const renderer = lightingRenderer();
  renderer.setLightingQuality('ultra');
  // Isolate the lighting transition from window/DPR notification plumbing.
  (renderer as any).notifyResolutionScaleChange = () => {};
  (renderer as any).applyAdaptiveEffects('reduced');
  assert.equal(renderer.getLightingQuality(), 'ultra');
  assert.equal(renderer.renderer.shadowMap.enabled, true, 'retain the compiled shadow variant');
  assert.equal(renderer.sunLight.shadow.intensity, 0);
  assert.equal(renderer.sunLight.shadow.autoUpdate, false);
  assert.equal(renderer.sunLight.shadow.needsUpdate, false);
  assert.equal(renderer.fillLight.visible, true, 'preserve the compiled light list during fallback');
  assert.equal(renderer.fillLight.intensity, 0);
  assert.equal(renderer.skyDomeUniforms.uSunGlow.value, 0);
  assert.equal(renderer.skyDomeUniforms.uCinematic.value, 1, 'fallback must preserve the cinematic sky');

  renderer.setLightingQuality('high');
  assert.equal(renderer.renderer.shadowMap.enabled, true);
  assert.equal(renderer.sunLight.shadow.intensity, 0);
  assert.equal(renderer.fillLight.visible, true);
  assert.equal(renderer.fillLight.intensity, 0);
  (renderer as any).applyAdaptiveEffects('full');
  assert.equal(renderer.getLightingQuality(), 'high');
  assert.equal(renderer.sunLight.shadow.mapSize.x, 2048);
  assert.equal(renderer.renderer.shadowMap.enabled, true);
  assert.equal(renderer.sunLight.shadow.intensity, 1);
  assert.equal(renderer.sunLight.shadow.autoUpdate, true);
  assert.equal(renderer.fillLight.visible, true);
  assert.ok(renderer.fillLight.intensity > 0);

  renderer.setShadowsEnabled(false);
  renderer.setLightingQuality('low');
  renderer.setLightingQuality('ultra');
  (renderer as any).applyAdaptiveEffects('reduced');
  (renderer as any).applyAdaptiveEffects('full');
  assert.equal(renderer.shadowsEnabled, false);
  assert.equal(renderer.renderer.shadowMap.enabled, false);
  assert.equal(renderer.fillLight.visible, true);
});

test('automatic lighting transitions preserve the warmed light and shadow pipeline keys', () => {
  for (const quality of ['medium', 'high', 'ultra'] as const) {
    for (const shadows of [false, true]) {
      const renderer = lightingRenderer();
      (renderer as any).notifyResolutionScaleChange = () => {};
      renderer.setLightingQuality(quality);
      renderer.setShadowsEnabled(shadows);
      const shadow = renderer.sunLight.shadow;
      const map = new THREE.WebGLRenderTarget(shadow.mapSize.x, shadow.mapSize.y);
      map.depthTexture = new THREE.DepthTexture(shadow.mapSize.x, shadow.mapSize.y);
      shadow.map = map;
      const depth = map.depthTexture;
      const key = () => [renderer.renderer.shadowMap.enabled, ...renderer.scene.children
        .filter((object: any) => object.isLight && object.visible)
        .map((object: any) => `${object.id}:${object.castShadow}`)];
      const originalKey = key(), intensity = renderer.fillLight.intensity;
      for (let i = 0; i < 3; i++) {
        (renderer as any).applyAdaptiveEffects('reduced');
        assert.deepEqual(key(), originalKey);
        assert.equal(shadow.intensity, 0);
        assert.equal(shadow.autoUpdate || shadow.needsUpdate, false);
        assert.equal(map.width, 1, 'release the expensive shadow allocation');
        assert.equal(map.depthTexture, depth, 'keep cached comparison sampler references valid');
        assert.equal(renderer.fillLight.intensity, 0);
        (renderer as any).applyAdaptiveEffects('full');
        assert.deepEqual(key(), originalKey);
        assert.equal(shadow.intensity, shadows ? 1 : 0);
        assert.equal(shadow.autoUpdate, shadows);
        assert.equal(shadow.needsUpdate, shadows, 'the next active shadow pass must refresh the map');
        assert.equal(renderer.fillLight.intensity, intensity);
      }
      depth.dispose(); map.dispose();
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
    setLightingQuality(quality: string) { applied.push(quality); return quality; },
    setShadowsEnabled: (value: boolean) => value,
  };
  const store = new SpaceUiStore();
  store.setSceneRenderer(bridge);
  assert.equal(store.getSnapshot().lightingQuality, 'medium');
  assert.equal(store.getSnapshot().shadowsEnabled, false);
  store.setLightingQuality('ultra');
  assert.equal(store.getSnapshot().lightingQuality, 'ultra');
  assert.equal(values.get(LIGHTING_QUALITY_SETTING_KEY), 'ultra');
  const restored = new SpaceUiStore();
  restored.setSceneRenderer(bridge);
  assert.equal(restored.getSnapshot().lightingQuality, 'ultra');
  assert.equal(restored.getSnapshot().shadowsEnabled, false);
  assert.deepEqual(applied, ['medium', 'ultra', 'ultra']);

  values.set(LIGHTING_QUALITY_SETTING_KEY, 'invalid');
  restored.setSceneRenderer(bridge);
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
  store.setSceneRenderer({ setLightingQuality: (quality: string) => quality });
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
    render: (_gpu, scene, _camera, _sun, _up, fullEffects) => {
      assert.equal(scene.fog, fog, 'preserve the compiled material fog variant');
      assert.equal(fog.density, 0, 'postprocess haze must not stack with material fog');
      assert.equal(fullEffects, renderer.adaptiveEffectsQuality === 'full');
      hdrFrames++;
    },
    dispose() {},
  } as any;
  renderer.setLightingQuality('ultra');
  for (const quality of ['full', 'reduced'] as const) {
    renderer.adaptiveEffectsQuality = quality;
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
