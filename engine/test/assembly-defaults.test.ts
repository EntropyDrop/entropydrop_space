import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BodyType, ContraptionMode } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import type { ContraptionOptions } from '../src/contraption/EntityTypes.ts';

const blocks = [{ localX: 0, localY: 0, localZ: 0, size: 1, block: 1, color: 0x123456 }];

test('new assemblies default to stopped and kinematic while explicit body and gravity options are respected', t => {
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null);
  manager.setEntityPersistenceMode('none');
  t.after(() => { for (const entity of manager.contraptions) entity.dispose(); });
  const cases: [ContraptionOptions, string, boolean][] = [
    [{}, BodyType.KINEMATIC, false],
    [{ bodyType: undefined }, BodyType.KINEMATIC, false],
    [{ bodyType: BodyType.DYNAMIC }, BodyType.DYNAMIC, true],
    [{ bodyType: BodyType.DYNAMIC, useGravity: false }, BodyType.DYNAMIC, false],
    [{ bodyType: BodyType.KINEMATIC, useGravity: true }, BodyType.KINEMATIC, true],
  ];
  for (const [options, bodyType, useGravity] of cases) {
    const entity = manager.commitPreparedAssembly(blocks.map(block => ({ ...block })),
      new THREE.Vector3(0, 20, 0), ContraptionMode.PROGRAMMABLE, options)!;
    assert.equal(entity.bodyType, bodyType);
    assert.equal(entity.useGravity, useGravity);
    assert.equal(entity.scriptStatus, 'stopped');
    assert.equal(entity.isPhysicsSimulationEnabled(), false);
    assert.equal(entity.isNodeScriptEnabled(), false);
    assert.equal(entity.canEditInternalSelection(), true);
    assert.equal(entity.collisionSimulationEnabled, true);
    assert.ok([...entity.rigidBodies.values()].every(body => !body.simulationEnabled));
    assert.equal(entity.serializeSubtree(entity.rootComponentId)!.bodyType, bodyType);
  }
});

test('assembly with code starts stopped unless explicitly opted into running, and streaming preserves that state', async t => {
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null);
  const restoredManager = new ContraptionManager(new THREE.Scene(), null, null, null);
  manager.setEntityPersistenceMode('none');
  restoredManager.setEntityPersistenceMode('none');
  t.after(() => { for (const entity of [...manager.contraptions, ...restoredManager.contraptions]) entity.dispose(); });
  for (const physicsSimulationEnabled of [undefined, false, true]) {
    const entity = manager.commitPreparedAssembly(blocks.map(block => ({ ...block })),
      new THREE.Vector3(0, 20, 0), ContraptionMode.PROGRAMMABLE,
      { physicsSimulationEnabled, scriptCode: 'self.setSpinYAxisRPM(30);' })!;
    await entity.scriptRuntimeClient.ready();
    const running = physicsSimulationEnabled === true;
    assert.equal(entity.scriptStatus, running ? 'running' : 'stopped');
    assert.equal(entity.isPhysicsSimulationEnabled(), running);
    assert.equal(entity.isNodeScriptEnabled(), running);
    const record = manager.captureContraptionForStreaming(entity, { id: '0,0' });
    const restored = restoredManager.buildFromSlot(record.slot,
      new THREE.Vector3(...record.constructorOrigin), record, false)!;
    await restored.scriptRuntimeClient.ready();
    assert.equal(restored.scriptStatus, running ? 'running' : 'stopped');
    assert.equal(restored.isPhysicsSimulationEnabled(), running);
    assert.equal(restored.isNodeScriptEnabled(), running);
    const initialRotation = restored.quaternion.clone();
    if (!running) {
      restored.update(.05, null, {});
      assert.deepEqual(restored.quaternion.toArray(), initialRotation.toArray());
    }
    restored.enableAllNodeScripts();
    restored.update(.05, null, {});
    assert.equal(restored.isPhysicsSimulationEnabled(), true);
    assert.equal(restored.scriptStatus, 'running');
    assert.ok(restored.quaternion.angleTo(initialRotation) > .01, 'Start runs the assembled script');
  }
});

test('restoring existing entities preserves body and gravity settings, including legacy defaults', t => {
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null);
  const restoredManager = new ContraptionManager(new THREE.Scene(), null, null, null);
  manager.setEntityPersistenceMode('none');
  restoredManager.setEntityPersistenceMode('none');
  t.after(() => { for (const entity of [...manager.contraptions, ...restoredManager.contraptions]) entity.dispose(); });
  for (const bodyType of [undefined, BodyType.DYNAMIC, BodyType.KINEMATIC]) {
    for (const useGravity of [undefined, false, true]) {
      const entity = manager.buildFromSlot({ rootComponentId: 'base', blocks: [
        { ...blocks[0], entityId: 'base' }, { ...blocks[0], localX: 1, entityId: 'arm' },
      ],
        bodyType, useGravity, childEntities: [{ id: 'arm', parentId: 'base', bodyType: BodyType.DYNAMIC,
          useGravity: false }] }, new THREE.Vector3(), null, false)!;
      const expectedType = bodyType ?? BodyType.DYNAMIC;
      const expectedGravity = useGravity ?? expectedType === BodyType.DYNAMIC;
      assert.equal(entity.bodyType, expectedType);
      assert.equal(entity.useGravity, expectedGravity);
      assert.equal(entity.isPhysicsSimulationEnabled(), true, 'legacy playback default is unchanged');
      assert.equal(entity.getNodeGravityEnabled('arm'), false);
      const record = manager.captureContraptionForStreaming(entity, { id: '0,0' });
      const restored = restoredManager.buildFromSlot(record.slot, new THREE.Vector3(...record.constructorOrigin), record, false)!;
      assert.equal(restored.bodyType, expectedType);
      assert.equal(restored.useGravity, expectedGravity);
      assert.equal(restored.isPhysicsSimulationEnabled(), true);
      assert.equal(restored.getNodeBodyType('arm'), BodyType.DYNAMIC);
      assert.equal(restored.getNodeGravityEnabled('arm'), false);
    }
  }
});
