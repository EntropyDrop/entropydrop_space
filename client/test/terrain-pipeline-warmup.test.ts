import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { warmTerrainPipelines } from '../src/engine/render/TerrainPipelineWarmup.ts';

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
