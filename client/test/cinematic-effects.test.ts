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
  assert.equal(effects.sceneTarget.texture.userData.voxelEmissionMask, true);
  assert.ok(effects.bloom.inputNode.isNode);
  assert.ok(effects.sceneTarget.depthTexture);
  assert.equal(effects.atmosphereTarget.depthBuffer, false);
  assert.equal(effects.secondaryTarget.width, 1280);
  assert.equal(effects.secondaryTarget.height, 720);
  effects.setSize(960, 540);
  for (const target of [effects.sceneTarget, effects.atmosphereTarget, effects.displayTarget]) {
    assert.equal(target.width, 960);
    assert.equal(target.height, 540);
  }
  assert.equal(effects.resolution.value.x,960);
  assert.equal(effects.resolution.value.y,540);
  assert.equal(effects.secondaryTarget.width * effects.secondaryTarget.height, 960 * 540 / 4);
  effects.setSecondaryResolutionScale(1);
  assert.equal(effects.secondaryTarget.width, 960);
  assert.equal(effects.secondaryTarget.height, 540);
  effects.setSecondaryResolutionScale(0.5);
  effects.setSize(961, 541);
  assert.equal(effects.secondaryTarget.width, 481);
  assert.equal(effects.secondaryTarget.height, 271);
  effects.dispose();
});

test('leaving cinematic quality disposes all render targets, shaders and bloom buffers once', () => {
  const effects = new CinematicEffects();
  const resources = [effects.sceneTarget, effects.atmosphereTarget, effects.secondaryTarget, effects.displayTarget,
    effects.sceneTarget.depthTexture!, effects.atmosphere, effects.secondary, effects.output,
    (effects.bloom as any)._renderTargetBright, ...(effects.bloom as any)._renderTargetsHorizontal, ...(effects.bloom as any)._renderTargetsVertical];
  const counts = resources.map(() => 0);
  resources.forEach((resource, i) => resource.addEventListener('dispose', () => counts[i]++));
  effects.dispose();
  effects.dispose();
  assert.deepEqual(counts, resources.map(() => 1));
});

test('all HDR stages render in order at every resolution and restore renderer state', () => {
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
    render: (object: THREE.Object3D) => { stages.push(object === scene ? 'scene'
      : currentTarget === effects.secondaryTarget ? 'secondary' : currentTarget === effects.atmosphereTarget ? 'atmosphere' : 'tone-map'); },
  };
  (effects as any).pipeline = { render: () => stages.push('fxaa'), dispose() {} };
  effects.render(renderer, scene, camera, sun, up);
  assert.deepEqual(stages, ['scene', 'secondary', 'atmosphere', 'tone-map', 'fxaa']);
  assert.equal(currentTarget, previousTarget);
  assert.equal(renderer.autoClear, false);
  assert.equal(effects.sunVisibility.value, 1);

  stages.length = 0;
  // Sun parallel to the view plane must never send infinities into the shader.
  effects.render(renderer, scene, camera, new THREE.Vector3(1, 0, 0), up);
  assert.deepEqual(stages, ['scene', 'secondary', 'atmosphere', 'tone-map', 'fxaa']);
  assert.equal(effects.sunVisibility.value, 0);
  assert.ok(Number.isFinite(effects.sunUv.value.x));

  stages.length = 0;
  renderer.getDrawingBufferSize = (size: THREE.Vector2) => size.set(640, 360);
  effects.render(renderer, scene, camera, sun, up);
  assert.deepEqual(stages, ['scene', 'secondary', 'atmosphere', 'tone-map', 'fxaa'],
    'lower resolution must retain all selected effects');
  assert.equal(effects.sceneTarget.width, 640);

  renderer.render = () => { throw new Error('lost render'); };
  assert.throws(() => effects.render(renderer, scene, camera, sun, up), /lost render/);
  assert.equal(currentTarget, previousTarget);
  assert.equal(renderer.autoClear, false);
  effects.dispose();
  previousTarget.dispose();
});
