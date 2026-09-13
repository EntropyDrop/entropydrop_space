import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { ActionDomain, executeBasicAction } from '@entropydrop/space-engine/actions/BasicActions.ts';

test('disabled or mixed component switches never create a third entity state', () => {
  const store: any = new SpaceUiStore();
  let physics = true;
  store.snapshot.editingContraption = {
    entityNodes: new Map([['root', {}], ['wheel', {}]]),
    isNodeScriptEnabled: () => false,
    isPhysicsSimulationEnabled: () => physics,
  };
  assert.equal(store.getGlobalPlayback(), 'play');
  physics = false;
  assert.equal(store.getGlobalPlayback(), 'stop');
});

test('editor start/stop waits for the server and does not apply a local-only change', async () => {
  const store: any = new SpaceUiStore();
  const target = { serverManaged: true, serverDesiredRunState: 'stopped', serverExecutesLocally: false };
  store.snapshot.editingContraption = target;
  const requests: string[] = [];
  store.snapshot.controller = { async requestServerEntityRunState(entity, state) {
    assert.equal(entity, target);
    requests.push(state);
    target.serverDesiredRunState = state;
    return true;
  } };
  store.snapshot.contraptions = { performBasicAction() { assert.fail('must use the server'); } };
  await store.setGlobalPlayback('play');
  assert.equal(store.getGlobalPlayback(), 'play');
  await store.setGlobalPlayback('stop');
  assert.equal(store.getGlobalPlayback(), 'stop');
  assert.deepEqual(requests, ['running', 'stopped']);
});

test('removed pause action leaves physics and scripts unchanged', () => {
  const entity: any = { blocks: [], scriptStatus: 'running', disableAllNodeScripts() { assert.fail('pause removed'); } };
  const result = executeBasicAction({ contraption: entity }, {
    domain: ActionDomain.ENTITY, action: 'pause-scripts', target: { contraption: entity },
  });
  assert.equal(result.reason, 'unsupported_action');
  assert.equal(entity.scriptStatus, 'running');
});

test('spaceAPI reset snapshot restores child construction poses and defaults at the saved root pose', () => {
  const entity: any = new Contraption(987,
    [{ localX: 0, localY: 0, localZ: 0, block: 1 }, { localX: 0, localY: 2, localZ: 0, block: 1 }],
    new THREE.Vector3(5, 30, 8), new THREE.Scene(), {
      childEntities: [{ id: 'wheel', parentId: 'root', kind: 'child', pivot: [0, 2, 0], blockKeys: [['0', '2', '0']] }],
    });
  entity.setNodeScript('root', 'self.state.old = true;');
  const mass = entity.getNodeBodyMass('root');
  entity.setNodeBodyMass('root', 999, { runtimeOnly: true });
  const position = [10, 40, 20];
  const quaternion = [0, 0.6, 0, 0.8];
  const snapshot = {
    position, quaternion, constructorOrigin: [9.5, 39.5, 19.5],
    bodies: [{ id: 'root', position, quaternion }], nodes: [], states: {},
    scriptStatus: 'stopped', physicsSimulationEnabled: false, resetRuntime: true,
  };
  ContraptionManager.prototype.restoreContraptionStreamingState.call({}, entity, snapshot);
  assert.deepEqual(entity.position.toArray(), position);
  assert.deepEqual(entity.quaternion.toArray(), quaternion);
  assert.equal(entity.getNodeBodyMass('root'), mass);
  assert.equal(entity.isPhysicsSimulationEnabled(), false);
  assert.equal(entity.isNodeScriptEnabled('root'), false);
  assert.deepEqual(entity.getComponentState('root'), {});
  assert.equal(entity.scriptRuntime, 0);
  const wheel = entity.getEntityNode('wheel');
  const body = entity.getRigidBody('wheel');
  assert.ok(body.position.distanceTo(wheel.group.localToWorld(body.centerOfMassLocal.clone())) < 1e-8);
  entity.enableAllNodeScripts();
  entity.update(0.05, null, {});
  assert.equal(entity.getComponentState('root').old, true);
});
