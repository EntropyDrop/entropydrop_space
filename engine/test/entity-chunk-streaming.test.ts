import { setScript } from './script-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';

function streamingWorld(active = ['0,0']) {
  return {
    activeChunkKeys: new Set(active),
    worldToChunkCoords(x: number, z: number) {
      return { cx: Math.floor(Number(x) / 16), cz: Math.floor(Number(z) / 16) };
    }
  } as any;
}

test('entities retain static visuals outside loaded chunks and resume from cached state', async () => {
  const scene = new THREE.Scene();
  const world = streamingWorld();
  const manager = new ContraptionManager(scene, world, null, null) as any;
  const original = new Contraption(
    41,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(2, 4, 2),
    scene,
    { rootComponentId: 'root' }
  ) as any;
  original.velocity.set(1, 2, 3);
  original.angularVelocity.set(0.1, 0.2, 0.3);
  original.quaternion.setFromEuler(new THREE.Euler(0.2, 0.4, -0.1));
  await setScript(original, 'self.state.setNumber("runs", (self.state.getNumber("runs") || 0) + 1);');
  manager.registerContraption(original);

  manager.update(1 / 60, null);
  assert.equal(original.getComponentState('root').runs, 1);
  const publicId = original.publicId;
  const oldRuntime = original.scriptRuntimeClient;
  const savedPosition = original.position.toArray();
  const savedVelocity = original.velocity.toArray();
  const savedAngularVelocity = original.angularVelocity.toArray();
  const savedQuaternion = original.quaternion.clone();

  world.activeChunkKeys = new Set(['1,0']);
  manager.update(1 / 60, null);
  assert.equal(manager.contraptions.length, 0, 'the off-window entity must leave every active system');
  assert.equal(manager.getDormantContraptionCount(), 1);
  assert.equal(oldRuntime.disposed, true, 'unloading must dispose the old AssemblyScript Runtime client');
  assert.equal(scene.children.includes(original.rootGroup), false, 'unloading must dispose the old scene object');
  const proxy = manager.dormantRenderProxies.get(publicId);
  assert.ok(scene.children.includes(proxy), 'the static structure remains visible');
  assert.ok(proxy.children.includes(original.meshGroup), 'render resources transfer without copying or disposing geometry');
  assert.deepEqual(proxy.position.toArray(), savedPosition);
  assert.equal(manager.raycastContraption(new THREE.Vector3(2, 10, 2), new THREE.Vector3(0, -1, 0)), null);
  assert.deepEqual(new THREE.Raycaster(new THREE.Vector3(2, 10, 2), new THREE.Vector3(0, -1, 0))
    .intersectObject(proxy, true), [], 'scene raycasts cannot select cached visuals');

  manager.update(1 / 60, null);
  const dormant = manager.dormantContraptions.get('0,0').get(publicId);
  assert.equal(dormant.states.root.runs, 1, 'scripts must not run while the entity chunk is unloaded');
  assert.equal(dormant.tickCount, 1, 'script ticks must remain frozen while dormant');
  assert.deepEqual(proxy.position.toArray(), savedPosition);

  world.activeChunkKeys = new Set(['0,0']);
  manager.update(1 / 60, null);
  assert.equal(manager.getDormantContraptionCount(), 0);
  assert.equal(manager.contraptions.length, 1);
  assert.equal(manager.dormantRenderProxies.size, 0);
  assert.equal(scene.children.includes(proxy), false, 'restoration removes the old visual');

  const restored = manager.contraptions[0];
  assert.notEqual(restored, original, 'loading must construct a fresh Entity instance');
  assert.equal(restored.id, 41);
  assert.equal(restored.publicId, publicId);
  assert.notEqual(restored.scriptRuntimeClient, oldRuntime, 'loading must create a fresh Runtime client');
  assert.deepEqual(restored.position.toArray(), savedPosition);
  assert.deepEqual(restored.velocity.toArray(), savedVelocity);
  assert.deepEqual(restored.angularVelocity.toArray(), savedAngularVelocity);
  assert.ok(Math.abs(restored.quaternion.dot(savedQuaternion)) > 1 - 1e-12);
  assert.equal(restored.getComponentState('root').runs, 2, 'restored state resumes on the first loaded frame');
  assert.equal(restored.tickCount, 2);
});

test('server caches require fresh metadata before restoring even when terrain reloads', () => {
  const scene = new THREE.Scene();
  const world = streamingWorld();
  const manager = new ContraptionManager(scene, world, null, null);
  const entity = new Contraption(1,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(2, 4, 2), scene, { rootComponentId: 'root' });
  Object.assign(entity, { serverManaged: true, serverCanEdit: true, serverCanControl: true,
    serverExecutesLocally: true, serverDefinitionDigest: 'definition', serverSnapshotDigest: 'snapshot', serverRevision: 1 });
  manager.registerContraption(entity);
  const saves: unknown[] = [];
  manager.entityPersistenceMode = 'remote';
  manager.setRemoteEntityPersistence({ save: record => { saves.push(record); } });
  const id = entity.publicId;
  world.activeChunkKeys = new Set(['1,0']);
  manager.update(1 / 60, null);
  assert.equal(saves.length, 1, 'leaving the terrain window checkpoints once');
  const cached = manager.dormantContraptions.get('0,0')!.get(id)!;
  assert.equal(cached.serverExecutesLocally, false);
  assert.equal(cached.serverCanControl, false);
  assert.equal(cached.physicsSimulationEnabled, false);
  manager.saveEntitiesToStorage();
  assert.equal(saves.length, 1, 'static caches never overwrite newer server state');
  world.activeChunkKeys = new Set(['0,0']);
  manager.update(1 / 60, null);
  assert.equal(manager.contraptions.length, 0, 'terrain alone cannot restore unvalidated server state');
  assert.equal(manager.dormantRenderProxies.size, 1);
  assert.equal(manager.updateDormantServerEntity(id, { serverDefinitionDigest: 'changed', serverSnapshotDigest: 'snapshot' }), false);
  assert.equal(manager.dormantRenderProxies.size, 1, 'keep the visual while a changed definition downloads');
  assert.equal(manager.hasDormantPublicId(id), true);
  manager.updateDormantServerEntity(id, { serverDefinitionDigest: 'definition', serverSnapshotDigest: 'snapshot' });
  assert.equal(manager.contraptions.length, 0, 'a delayed save acknowledgement cannot restore a cache');
  assert.equal(manager.updateDormantServerEntity(id, { serverDefinitionDigest: 'definition', serverSnapshotDigest: 'snapshot',
    serverCanControl: true, serverCanEdit: true, serverExecutesLocally: false, physicsSimulationEnabled: false,
    scriptStatus: 'stopped', serverRevision: 2 }, { restore: true }), true);
  assert.equal(manager.contraptions.length, 1);
  assert.equal(manager.contraptions[0].publicId, id);
  assert.equal(manager.contraptions[0].serverCanControl, true);
  assert.equal(manager.getDormantContraptionCount(), 0);
  assert.equal(manager.dormantRenderProxies.size, 0);
});

test('discarding a cached entity releases its render resources exactly once', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, streamingWorld(), null, null);
  const entity = new Contraption(1,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(2, 4, 2), scene);
  manager.registerContraption(entity);
  let disposals = 0;
  entity.meshGroup.traverse(object => {
    if (object instanceof THREE.Mesh) object.geometry.addEventListener('dispose', () => { disposals++; });
  });
  manager.unloadContraption(entity, { skipSave: true });
  assert.equal(disposals, 0);
  assert.equal(manager.deleteDormantContraption(entity.publicId), true);
  assert.ok(disposals > 0);
  const afterRemoval = disposals;
  assert.equal(manager.deleteDormantContraption(entity.publicId), false);
  assert.equal(disposals, afterRemoval);
  assert.equal(scene.children.length, 0);
});
