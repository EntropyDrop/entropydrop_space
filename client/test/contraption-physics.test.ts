import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BodyType, Contraption, ContraptionMode } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionPhysics } from '@entropydrop/space-engine/physics/ContraptionPhysics.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { compileBehaviorPrompt } from '../src/engine/contraption/BehaviorAgent.ts';
import { SPACE_SCRIPT_API_V2 } from '@entropydrop/space-engine/contraption/ScriptApiContract.ts';

function makeContraption() {
  return new Contraption(
    1,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: 1, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }
    ],
    new THREE.Vector3(0, 8, 0),
    new THREE.Scene(),
    { mode: ContraptionMode.PROGRAMMABLE, rootComponentId: 'root' }
  ) as any;
}

test('unified self API: every component exposes the same surface (root/child)', () => {
  const contraption = makeContraption();
  // Unified self surface exposes common, kinematic, and rigid-body methods on one object.
  const keys = Object.keys(contraption.scriptApi).sort();
  assert.deepEqual(keys, [...SPACE_SCRIPT_API_V2.runtimeSurfaces.self].sort());
  for (const namespace of ['body', 'constraints', 'voxels', 'microVoxels']) {
    assert.deepEqual(
      Object.keys(contraption.scriptApi[namespace]).sort(),
      [...SPACE_SCRIPT_API_V2.runtimeSurfaces[`self.${namespace}`]].sort(),
      `${namespace} runtime surface must match the canonical API contract`
    );
  }

  // Root rigid-body methods work; kinematic methods are no-ops while physics-driven.
  contraption.scriptApi.applyForce([0, 100, 0]);
  assert.ok(contraption.appliedForces.y > 0, 'applyForce should work on root');
  contraption.scriptApi.setLocalSpin([0, 1, 0], 60);
  assert.equal(contraption.getEntityNode('root').localAngularVelocity.length(), 0, 'setLocalSpin should be a no-op on a dynamic root');

  // Root applyThrust is a root-local force at COM, equivalent to applyLocalForce.
  contraption.appliedForces.set(0, 0, 0);
  contraption.scriptApi.applyThrust([0, 50, 0]);
  assert.ok(contraption.appliedForces.y > 0, 'applyThrust should work on root');
  assert.equal(contraption.appliedTorques.lengthSq(), 0, 'force at COM should produce no torque');

  // Legacy child force APIs act on the root body; the body namespace targets the child body.
  contraption.appliedForces.set(0, 0, 0);
  contraption.appliedTorques.set(0, 0, 0);
  contraption.createChildEntity('root', new Set(['1,0,0']), 'arm');
  const armApi = contraption.getChildScriptApi('arm');
  armApi.applyTorque([0, 9, 0]);
  assert.ok(contraption.appliedTorques.y > 0, 'child applyTorque should act on the entity');
  armApi.applyForce([0, 9, 0]);
  assert.ok(contraption.appliedForces.y > 0, 'child applyForce should act on the entity');
  assert.equal(armApi.body.getType(), BodyType.KINEMATIC);
  armApi.setLocalSpin([0, 1, 0], 60);
  assert.ok(contraption.getEntityNode('arm').localAngularVelocity.length() > 0, 'child setLocalSpin should work');

  // Direct component lookup also accepts the root's ordinary ID.
  assert.equal(contraption.getChildScriptApi('root'), contraption.scriptApi);
});

test('script API exposes only the self/ctx contract', () => {
  const contraption = makeContraption();
  contraption.createChildEntity('root', new Set(['1,0,0']), 'arm');

  assert.equal(contraption.scriptApi.setBlock, undefined);
  assert.equal(contraption.scriptApi.clearBlock, undefined);
  assert.equal(contraption.scriptApi.extend, undefined);

  contraption.setScript('self.applyForce([0, 100, 0]);');
  assert.equal(contraption.compiledScript.length, 2, 'compiled controllers receive only self and ctx');
  contraption.update(1 / 60, null, {});
  assert.ok(contraption.appliedForces.y > 0);
});

test('off-center force creates torque and respects output budgets', () => {
  const contraption = makeContraption();
  contraption.applyForceAt([0, 1e9, 0], [0, 0, 0]);
  assert.ok(contraption.appliedTorques.length() > 0);
  assert.ok(contraption.appliedForces.length() <= contraption.maxForce + 1e-8);
  assert.ok(contraption.appliedTorques.length() <= contraption.maxTorque + 1e-8);
});

test('ctx.limits clamps only the legacy root force surface', () => {
  const contraption = makeContraption();

  contraption.scriptApi.applyForce([0, 1e9, 0]);
  assert.ok(contraption.appliedForces.length() <= contraption.maxForce + 1e-8);

  contraption.appliedForces.set(0, 0, 0);
  assert.equal(contraption.scriptApi.body.applyForce([0, 1e9, 0]), true);
  assert.equal(contraption.appliedForces.length(), 1e9, 'root self.body force bypasses the legacy clamp');

  contraption.createChildEntity('root', new Set(['1,0,0']), 'arm');
  const armApi = contraption.getChildScriptApi('arm');
  assert.equal(armApi.body.setType(BodyType.DYNAMIC).ok, true);
  assert.equal(armApi.body.applyForce([0, 1e9, 0]), true);
  assert.equal(
    contraption.getRigidBody('arm').appliedForces.length(),
    1e9,
    'child self.body force bypasses the legacy clamp'
  );
});

test('controller force is integrated across every physics sub-step', () => {
  const contraption = makeContraption();
  const hover = compileBehaviorPrompt('hover 5 meters above the ground');
  assert.equal(contraption.setScript(hover.code), true);
  contraption.groundDistance = 5;

  contraption.update(1 / 60, {}, { gravity: [0, -18, 0], world: null });
  const physics = new ContraptionPhysics({
    getBlock: () => BlockTypes.AIR,
    raycast: () => ({ hit: true, distance: 5 }),
    raycastMicro: () => ({ hit: false })
  });
  physics.update(contraption, 1 / 60);

  assert.ok(Math.abs(contraption.velocity.y) < 1e-4);
  assert.equal(contraption.appliedForces.lengthSq(), 0);
});

test('kinematic root uses direct control while a dynamic root rejects pose writes', () => {
  const contraption = makeContraption();
  const rootNode = contraption.getEntityNode('root');

  // Kinematic methods are no-ops on a dynamic root.
  contraption.scriptApi.setLocalSpin([0, 1, 0], 60);
  contraption.update(1 / 60, null, {});
  const quatBefore = contraption.quaternion.clone();
  contraption.update(1 / 60, null, {});
  assert.ok(contraption.quaternion.equals(quatBefore), 'setLocalSpin should not affect a dynamic root');
  assert.equal(rootNode.localAngularVelocity.length(), 0, 'a dynamic root should not accumulate local angular velocity');

  // After changing type, kinematic spin integrates every frame.
  contraption.setBodyType(BodyType.KINEMATIC);
  contraption.scriptApi.setLocalSpin([0, 1, 0], 60); // Per-frame command.
  contraption.update(1 / 60, null, {});
  contraption.update(1 / 60, null, {});
  const spinQuat = contraption.quaternion.clone();
  assert.ok(!spinQuat.equals(new THREE.Quaternion()), 'kinematic spin should affect a kinematic root');
  assert.ok(Math.abs(new THREE.Euler().setFromQuaternion(spinQuat, 'YXZ').y) > 0.05, 'Y spin should be about 0.1 rad');

  // Global Stop disables scripts and therefore stops the kinematic command.
  contraption.scriptApi.stop();
  contraption.update(1 / 60, null, {});
  const stoppedQuat = contraption.quaternion.clone();
  contraption.update(1 / 60, null, {});
  assert.ok(contraption.quaternion.equals(stoppedQuat), 'a kinematic root should stop spinning when not commanded');

  // setLocalEuler directly sets kinematic-root orientation.
  contraption.scriptApi.setLocalEuler([0.3, 0, 0]);
  const euler = new THREE.Euler().setFromQuaternion(contraption.quaternion, 'YXZ');
  assert.ok(Math.abs(euler.x - 0.3) < 1e-6, 'setLocalEuler should directly set kinematic orientation');

  // setLocalPosition places the root kinematically.
  contraption.scriptApi.setLocalPosition([5, 7, 9]);
  assert.deepEqual(contraption.position.toArray(), [5, 7, 9], 'a kinematic entity should support positioning');

  // A root has identity local position; getWorldPosition exposes its world position.
  assert.deepEqual(contraption.scriptApi.getLocalPosition(), [0, 0, 0], 'root local position should be identity');
  assert.deepEqual(contraption.scriptApi.getWorldPosition(), [5, 7, 9], 'world position should match');
  assert.deepEqual(contraption.scriptApi.getLocalRotation(), contraption.quaternion.toArray());

  // Returning to dynamic makes pose setters no-ops.
  contraption.setBodyType(BodyType.DYNAMIC);
  contraption.scriptApi.setLocalPosition([1, 1, 1]);
  assert.deepEqual(contraption.position.toArray(), [5, 7, 9], 'kinematic positioning should not affect a dynamic root');
});

test('kinematic root structural API: setPivot moves the rotation center, blocks stay in place', () => {
  const contraption = makeContraption(); // Blocks at (0,0,0) and (1,0,0).
  const blockA = contraption.blocks[0];

  // setPivot is a no-op while dynamic.
  contraption.scriptApi.setPivot([2, 2, 2]);
  assert.equal(contraption.rootPivotOverride, null, 'a dynamic root should reject setPivot');

  // After changing to kinematic, place the rotation center outside the blocks.
  contraption.setBodyType(BodyType.KINEMATIC);
  const blockWorldBefore = contraption.getBlockWorldCenter(blockA).clone();
  contraption.scriptApi.setPivot([2, 0.5, 0.5]);
  assert.deepEqual(contraption.rootPivotOverride.toArray(), [2, 0.5, 0.5], 'kinematic-root pivot should be set');
  const blockWorldAfter = contraption.getBlockWorldCenter(blockA);
  assert.ok(
    Math.abs(blockWorldBefore.x - blockWorldAfter.x) < 1e-6 &&
    Math.abs(blockWorldBefore.y - blockWorldAfter.y) < 1e-6,
    `setPivot should preserve block world position: before=(${blockWorldBefore.x.toFixed(2)},${blockWorldBefore.y.toFixed(2)}) after=(${blockWorldAfter.x.toFixed(2)},${blockWorldAfter.y.toFixed(2)})`
  );

  // Kinematic spin should now move blocks around the new pivot.
  const pivotWorld = contraption.entityLocalToWorld('root', new THREE.Vector3(2, 0.5, 0.5));
  const beforeSpin = contraption.getBlockWorldCenter(blockA).clone();
  contraption.scriptApi.setLocalSpin([0, 0, 1], 60);
  contraption.update(1 / 60, null, {});
  contraption.update(1 / 60, null, {});
  const afterSpin = contraption.getBlockWorldCenter(blockA);
  assert.ok(beforeSpin.distanceTo(afterSpin) > 1e-3, 'the block should move around the new pivot');
  assert.ok(Math.abs(afterSpin.distanceTo(pivotWorld) - beforeSpin.distanceTo(pivotWorld)) < 1e-6,
    'distance from the block to the pivot should remain constant');

  // getBounds remains fully functional on a kinematic root.
  const bounds = contraption.scriptApi.getBounds();
  assert.deepEqual(bounds.size, [2, 1, 1], 'root bounds should span two blocks on X');
});

test('child force API converts local frames to the entity: local force/direction and point', () => {
  const contraption = makeContraption();
  contraption.createChildEntity('root', new Set(['1,0,0']), 'arm');
  const armApi = contraption.getChildScriptApi('arm');

  // applyForce is world-space and independent of the calling component.
  contraption.appliedForces.set(0, 0, 0);
  armApi.applyForce([10, 0, 0]);
  assert.ok(contraption.appliedForces.x > 9 && contraption.appliedForces.y === 0, 'world-space force should apply directly');

  // applyTorque is world-space torque.
  contraption.appliedTorques.set(0, 0, 0);
  armApi.applyTorque([0, 5, 0]);
  assert.ok(contraption.appliedTorques.y > 4, 'world-space torque should apply directly');

  // After a 90-degree component rotation, component +Z maps to entity +X.
  contraption.getChildScriptApi('arm').setLocalEuler([0, Math.PI / 2, 0]);
  contraption.updateTransform();
  contraption.appliedForces.set(0, 0, 0);
  armApi.applyLocalForce([0, 0, 20]);
  assert.ok(contraption.appliedForces.x > 19, `component +Z force should map to entity +X: F=(${contraption.appliedForces.x.toFixed(1)},${contraption.appliedForces.y.toFixed(1)},${contraption.appliedForces.z.toFixed(1)})`);
  assert.ok(Math.abs(contraption.appliedForces.z) < 1e-9, 'no unconverted component should remain');

  // applyForceAt uses a component-local point and produces torque around COM.
  contraption.appliedForces.set(0, 0, 0);
  contraption.appliedTorques.set(0, 0, 0);
  const armNode = contraption.getEntityNode('arm');
  const localPoint = new THREE.Vector3(1, 0, 0);
  const componentPoint = localPoint.clone().add(armNode.pivotLocal);
  const expectedRootPoint = contraption.worldToLocal(
    contraption.entityLocalToWorld('arm', componentPoint)
  );
  const expectedLever = expectedRootPoint.clone().sub(contraption.localCenter);
  const expectedTorque = expectedLever.cross(new THREE.Vector3(0, 100, 0));
  if (expectedTorque.length() > contraption.maxTorque) {
    expectedTorque.multiplyScalar(contraption.maxTorque / expectedTorque.length());
  }
  armApi.applyForceAt([0, 100, 0], localPoint.toArray());
  assert.ok(contraption.appliedForces.y > 70, 'force should apply to the entity within its body budget');
  assert.ok(contraption.appliedTorques.distanceTo(expectedTorque) < 1e-6,
    'application point should include component rotation and hierarchy transforms');

  // Root applyForceAt retains entity-local semantics.
  contraption.appliedForces.set(0, 0, 0);
  contraption.appliedTorques.set(0, 0, 0);
  contraption.scriptApi.applyForceAt([0, 100, 0], [0, 0, 0]);
  assert.ok(contraption.appliedTorques.lengthSq() > 0, 'root application point should remain entity-local');
});
