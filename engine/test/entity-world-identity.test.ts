import { worldStub } from './fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';

test('world identity reaches entity worker snapshots and resets when the world changes', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, worldStub({ terrainGen: { seed: 20260922, version: 2 } }), null, null);
  manager.setWorldIdentity({ id: 'copper-world', slug: 'copper-metropolis', name: 'Copper Metropolis' });
  const entity = new Contraption(1, [], new THREE.Vector3(), scene);
  const snapshot = entity.buildScriptRuntimeSnapshot(0.05, null, { world: manager.scriptWorldApi }, 0, 0);
  assert.deepEqual(snapshot.world.info, {
    id: 'copper-world', slug: 'copper-metropolis', name: 'Copper Metropolis', seed: 20260922,
    terrainGeneratorVersion: 2, width: 16384, height: 256, length: 2048,
  });
  assert.ok(Object.isFrozen(manager.scriptWorldApi.getInfo()));
  manager.setWorldId('custom-world');
  assert.equal(manager.scriptWorldApi.getInfo().id, 'custom-world');
  assert.equal(manager.scriptWorldApi.getInfo().slug, '');
  assert.equal(manager.scriptWorldApi.getInfo().name, '');
});
