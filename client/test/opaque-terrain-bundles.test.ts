import test from 'node:test';
import assert from 'node:assert/strict';
import { installOpaqueTerrainBundles } from '../src/engine/render/OpaqueTerrainBundles.ts';

function fixture() {
  const events: string[] = [], native = {}, data: any = {}, pass: any = {
    renderBundles: [], currentSets: { pipeline: 'old' },
    currentPass: { executeBundles(items: unknown[]) { assert.equal(items.length, 1); events.push('execute'); } },
  };
  const context: any = { id: 1, width: 100, height: 100, sampleCount: 1, textures: [] };
  const group: any = { version: 0, userData: { spaceOpaqueTerrain: true }, set needsUpdate(value: boolean) { if (value) this.version++; } };
  const lights: any = { getCacheKey: () => 1, getLights: () => [] };
  const bundle: any = { bundleGroup: group, camera: {}, renderList: {
    opaque: [{}], transparent: [], transparentDoublePass: [], sort() { events.push('sort'); },
  } };
  const renderer: any = {
    _currentRenderContext: context, _currentRenderBundle: null, _bundles: { get: () => native },
    backend: { get: (key: unknown) => key === native ? data : pass, addBundle() {} },
    shadowMap: { enabled: true, type: 1 }, opaque: true, transparent: true, info: { render: { drawCalls: 0, triangles: 0 } },
    _renderBundle() {
      if (data.version !== group.version || !data.renderContexts?.has(context)) {
        events.push('record'); data.version = group.version;
        data.renderContexts ??= new Set(); data.renderContexts.add(context);
        this.info.render.drawCalls += 2; this.info.render.triangles += 20;
      } else events.push('update-uniforms');
      pass.renderBundles.push(native);
    },
    _renderObjects() { events.push('normal-opaque'); },
    _renderTransparents() { events.push('transparent'); },
  };
  assert.equal(installOpaqueTerrainBundles(renderer), true);
  function frame() {
    renderer.info.render.drawCalls = renderer.info.render.triangles = 0;
    renderer._renderBundle(bundle, {}, lights); renderer._renderTransparents();
  }
  return { renderer, frame, events, pass, context, data, bundle, lights, group };
}

test('terrain replay updates uniforms, executes before transparency and counts executed draws', () => {
  const f = fixture(); f.frame(); f.frame();
  assert.deepEqual(f.events, ['sort','record','execute','transparent','update-uniforms','execute','transparent']);
  assert.deepEqual(f.renderer.info.render, { drawCalls: 2, triangles: 20 });
  assert.deepEqual(f.group.userData.commandCacheStats, { recordings: 1, replays: 1 });
  assert.deepEqual(f.pass.currentSets, { attributes: {}, bindingGroups: [], pipeline: null, index: null });
  assert.equal(f.pass.renderBundles.length, 0, 'finishRender must not execute terrain twice');
});

test('target, shadow allocation and material generation changes re-record terrain', () => {
  const f = fixture(); f.frame(); f.frame();
  f.context.id++; f.frame();
  f.context.width++; f.frame();
  f.renderer.shadowMap.enabled = false; f.frame();
  f.lights.getLights = () => [{ shadow: { map: { texture: { id: 8 }, width: 1024, height: 1024 } } }]; f.frame();
  f.group.needsUpdate = true; f.frame();
  assert.equal(f.group.userData.commandCacheStats.recordings, 6);
  assert.equal(f.group.userData.commandCacheStats.replays, 1);
});

test('array cameras and override materials use ordinary submission without losing geometry', () => {
  const f = fixture(); f.bundle.camera.isArrayCamera = true; f.frame();
  assert.deepEqual(f.events, ['normal-opaque','transparent']);
  f.events.length = 0; f.bundle.camera.isArrayCamera = false;
  f.renderer._renderBundle(f.bundle, { overrideMaterial: {} }, f.lights);
  assert.deepEqual(f.events, ['normal-opaque']);
  assert.equal(f.group.userData.commandCacheStats, undefined);
  assert.equal(f.group.version, 0, 'shadow override passes must not invalidate the main-camera generation');
});

test('unsupported renderer contracts leave ordinary rendering available', () => {
  assert.equal(installOpaqueTerrainBundles({}), false);
});
