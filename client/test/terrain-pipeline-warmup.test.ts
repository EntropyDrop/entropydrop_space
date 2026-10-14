import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { warmTerrainPipelines } from '../src/engine/render/TerrainPipelineWarmup.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';

for (const fail of [false, true]) test(`hidden terrain and bundle pipelines compile with state restored${fail ? ' on failure' : ''}`, async () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const group = new THREE.BundleGroup(), hidden = new THREE.Mesh(new THREE.BufferGeometry());
  const retired = new THREE.Mesh(new THREE.BufferGeometry()); retired.userData.voxelArenaCompatible = true;
  group.add(hidden, retired); scene.add(group); group.visible = hidden.visible = retired.visible = false;
  const hdr = new THREE.RenderTarget(), original = new THREE.RenderTarget();
  let target: THREE.RenderTarget | null = original, completed = false;
  const renderer = {
    getRenderTarget: () => target,
    setRenderTarget: (next: THREE.RenderTarget | null) => { target = next; },
    async compileAsync(s: THREE.Object3D, c: THREE.Camera) {
      assert.equal(s, scene); assert.equal(c, camera); assert.equal(target, hdr);
      assert.equal(group.visible, true); assert.equal(group.isBundleGroup, false);
      assert.equal(hidden.visible, true); assert.equal(hidden.frustumCulled, false);
      assert.equal(retired.visible, false, 'retired source buffers must not be recreated');
      await Promise.resolve();
      if (fail) throw new Error('compilation failed');
      completed = true;
    },
  };
  const version = group.version;
  const warmup = warmTerrainPipelines(renderer, scene, camera, [group, hidden], hdr);
  if (fail) await assert.rejects(warmup, /compilation failed/); else await warmup;
  assert.equal(completed, !fail); assert.equal(target, original);
  assert.equal(group.visible, false); assert.equal(group.isBundleGroup, true);
  assert.equal(hidden.visible, false); assert.equal(hidden.frustumCulled, true);
  assert.equal(retired.visible, false); assert.equal(group.version, version + 1);
  hdr.dispose(); original.dispose();
});

test('entry waits for the avatar and compiles hidden body and hand variants into the active HDR target', async () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const body = new THREE.Group(), hand = new THREE.Group();
  const hiddenTool = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial());
  hiddenTool.visible = false;
  body.add(hiddenTool);
  body.visible = false;
  hand.visible = true;
  camera.add(hand);
  scene.add(body, camera);
  const hdr = new THREE.RenderTarget();
  let finishSkin!: () => void;
  let prepared = false, compiled = false;
  let drewHiddenBody = false;
  let target: THREE.RenderTarget | null = null;
  const view = Object.assign(Object.create(SceneRenderer.prototype), {
    ready: Promise.resolve(),
    playerAvatarReady: new Promise<void>(resolve => { finishSkin = resolve; }),
    playerAvatar: body, playerFirstPersonHand: hand,
    playerAvatarCharacter: { object3d: body, prepareHeldTools() { prepared = true; } },
    scene, camera, lightingQuality: 'ultra', cinematicEffects: { sceneTarget: hdr },
    render() { if (compiled && body.visible) drewHiddenBody = true; },
    renderer: {
      backend: { device: { queue: { async onSubmittedWorkDone() {} } } },
      getRenderTarget: () => target,
      setRenderTarget(next: THREE.RenderTarget | null) { target = next; },
      async compileAsync() {
        assert.equal(prepared, true);
        assert.equal(body.visible, true);
        assert.equal(hand.visible, true);
        assert.equal(hiddenTool.visible, true);
        assert.equal(target, hdr);
        compiled = true;
      }
    }
  });
  const loading = view.preparePlayerPipelines();
  await Promise.resolve();
  assert.equal(compiled, false, 'an unfinished skin load must not escape the entry gate');
  finishSkin();
  await loading;
  assert.equal(compiled, true);
  assert.equal(drewHiddenBody, true, 'compilation alone must not leave first-draw work for F3');
  assert.equal(body.visible, false);
  assert.equal(hand.visible, true);
  assert.equal(hiddenTool.visible, false);
  assert.equal(target, null);
  hiddenTool.geometry.dispose(); hiddenTool.material.dispose(); hdr.dispose();
});
