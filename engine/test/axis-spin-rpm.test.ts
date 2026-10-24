import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '../src/contraption/Contraption.ts';
import { setNodeScript } from './script-helpers.ts';

const axes = [
  ['setSpinXAxisRPM', new THREE.Vector3(1, 0, 0)],
  ['setSpinYAxisRPM', new THREE.Vector3(0, 1, 0)],
  ['setSpinZAxisRPM', new THREE.Vector3(0, 0, 1)],
] as const;

function fixture() {
  const entity = new Contraption(1, [0, 1].map(localX => ({ localX, localY: 0, localZ: 0, block: 1 })),
    new THREE.Vector3(), new THREE.Scene(), { rootComponentId: 'root' });
  entity.createChildEntity('root', [entity.blocks[1]], 'wheel');
  entity.stopAllNodeScripts();
  entity.setNodeBodyType('root', 'kinematic');
  entity.setNodeBodyType('wheel', 'kinematic');
  return entity;
}

for (const [method, axis] of axes) {
  test(`${method} rotates root and mounted child in their local frame through compiled code`, async t => {
    const entity = fixture();
    t.after(() => entity.dispose());
    assert.equal(await setNodeScript(entity, 'root', `self.${method}(30)`), true);
    assert.equal(await setNodeScript(entity, 'wheel', `self.${method}(60)`), true);
    entity.enableAllNodeScripts();
    await entity.scriptRuntimeClient.ready();
    for (let i = 0; i < 5; i++) entity.update(.05, null, {});
    assert.equal(entity.nodeScriptErrors.size, 0);
    assert.ok(entity.quaternion.angleTo(new THREE.Quaternion().setFromAxisAngle(axis, Math.PI * .25)) < 1e-6);
    assert.ok(entity.getEntityNode('wheel')!.localQuaternion.angleTo(
      new THREE.Quaternion().setFromAxisAngle(axis, Math.PI * .5)) < 1e-6);
    const rootPose = entity.quaternion.clone();
    entity.stopAllNodeScripts();
    assert.ok(entity.quaternion.angleTo(rootPose) < 1e-6, 'Stop preserves the root world pose');
    assert.ok(entity.getEntityNode('wheel')!.localQuaternion.angleTo(new THREE.Quaternion()) < 1e-6);
  });
}

test('axis helpers preserve zero, invalid RPM, dynamic-body guards and last-command semantics', t => {
  const entity = fixture();
  t.after(() => entity.dispose());
  for (const id of ['root', 'wheel']) {
    const node = entity.getEntityNode(id)!;
    const api = entity.getComponentApi(id);
    assert.ok(api);
    for (const [method, axis] of axes) {
      api[method](-30);
      assert.ok(node.localAngularVelocity.distanceTo(axis.clone().multiplyScalar(-Math.PI)) < 1e-9);
      for (const rpm of [0, NaN, Infinity, -Infinity]) {
        api[method](rpm);
        assert.equal(node.localAngularVelocity.lengthSq(), 0);
      }
    }
    api.setLocalSpin([1, 0, 0], 60);
    api.setSpinYAxisRPM(30);
    assert.ok(node.localAngularVelocity.distanceTo(new THREE.Vector3(0, Math.PI, 0)) < 1e-9);
    entity.setNodeBodyType(id, 'dynamic');
    node.localAngularVelocity.set(0, 0, 0);
    node.commandedThisFrame = false;
    for (const [method] of axes) api[method](60);
    assert.equal(node.localAngularVelocity.lengthSq(), 0);
    assert.equal(node.commandedThisFrame, false);
  }
});
