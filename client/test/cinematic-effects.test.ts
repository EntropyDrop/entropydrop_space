import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CinematicEffects } from '../src/engine/render/CinematicEffects.ts';

test('cinematic buffers follow render resolution and cap HDR allocation while retaining aspect ratio', () => {
  const effects = new CinematicEffects();
  effects.setSize(7680, 4320);
  assert.equal(effects.sceneTarget.width, 2560);
  assert.equal(effects.sceneTarget.height, 1440);
  assert.equal(effects.sceneTarget.texture.type, THREE.HalfFloatType);
  assert.ok(effects.sceneTarget.depthTexture);
  assert.equal(effects.atmosphereTarget.depthBuffer, false);
  effects.setSize(960, 540);
  for (const target of [effects.sceneTarget, effects.atmosphereTarget, effects.displayTarget]) {
    assert.equal(target.width, 960);
    assert.equal(target.height, 540);
  }
  assert.equal(effects.antialias.material.uniforms.resolution.value.x, 1 / 960);
  assert.equal(effects.antialias.material.uniforms.resolution.value.y, 1 / 540);
  effects.dispose();
});

test('leaving cinematic quality disposes all render targets, shaders and bloom buffers once', () => {
  const effects = new CinematicEffects();
  const resources = [effects.sceneTarget, effects.atmosphereTarget, effects.displayTarget,
    effects.sceneTarget.depthTexture!, effects.atmosphere, effects.output.material, effects.antialias.material,
    effects.bloom.renderTargetBright, ...effects.bloom.renderTargetsHorizontal, ...effects.bloom.renderTargetsVertical];
  const counts = resources.map(() => 0);
  resources.forEach((resource, i) => resource.addEventListener('dispose', () => counts[i]++));
  effects.dispose();
  effects.dispose();
  assert.deepEqual(counts, resources.map(() => 1));
});

test('HDR stages render in order, restore renderer state and retain atmosphere during fallback', () => {
  const effects = new CinematicEffects();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 10000);
  camera.updateMatrixWorld();
  const sun = new THREE.Vector3(0, 0, -1);
  const up = new THREE.Vector3(0, 1, 0);
  const previousTarget = new THREE.WebGLRenderTarget(1, 1);
  let currentTarget = previousTarget;
  const stages: string[] = [];
  const renderer: any = {
    autoClear: false,
    getDrawingBufferSize: (size: THREE.Vector2) => size.set(1280, 720),
    getRenderTarget: () => currentTarget,
    setRenderTarget: (target: THREE.WebGLRenderTarget) => { currentTarget = target; },
    resetState: () => { stages.push('reset'); currentTarget = null; },
    render: (object: THREE.Object3D) => { stages.push(object === scene ? 'scene' : 'atmosphere'); },
  };
  effects.bloom.render = () => { stages.push('bloom'); };
  effects.output.render = () => { stages.push('tone-map'); };
  effects.antialias.render = () => { stages.push('fxaa'); };
  effects.render(renderer, scene, camera, sun, up, true);
  assert.deepEqual(stages, ['reset', 'scene', 'atmosphere', 'bloom', 'tone-map', 'fxaa']);
  assert.equal(currentTarget, previousTarget);
  assert.equal(renderer.autoClear, false);
  assert.equal(effects.atmosphere.uniforms.sunVisibility.value, 1);

  stages.length = 0;
  // Sun parallel to the view plane must never send infinities into the shader.
  effects.render(renderer, scene, camera, new THREE.Vector3(1, 0, 0), up, false);
  assert.deepEqual(stages, ['reset', 'scene', 'atmosphere', 'tone-map', 'fxaa']);
  assert.equal(effects.atmosphere.uniforms.secondaryEffects.value, 0);
  assert.equal(effects.atmosphere.uniforms.sunVisibility.value, 0);
  assert.ok(Number.isFinite(effects.atmosphere.uniforms.sunUv.value.x));

  renderer.render = () => { throw new Error('lost render'); };
  assert.throws(() => effects.render(renderer, scene, camera, sun, up, true), /lost render/);
  assert.equal(currentTarget, previousTarget);
  assert.equal(renderer.autoClear, false);
  effects.dispose();
  previousTarget.dispose();
});
