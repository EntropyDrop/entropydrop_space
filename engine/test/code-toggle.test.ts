import { setNodeScript } from './script-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BodyType, Contraption } from '../src/contraption/Contraption.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';

/**
 * setNodeScriptEnabled contract: disabled component code does not execute, and any
 * motion previously driven by that script must stop.
 */

function makeContraption() {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    9001,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: 0, localY: 1, localZ: 0, block: BlockTypes.COLOR_BLOCK }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    {
      childEntities: [
        { id: 'arm', parentId: 'root', kind: 'child', pivot: [0, 0.5, 0], blockKeys: [['0', '1', '0']] },
        { id: 'blade', parentId: 'root', kind: 'child', pivot: [0, 1, 0] }
      ]
    }
  ) as any;
  return { contraption, scene };
}

// Simulate physics consuming per-frame forces, matching ContraptionPhysics.update.
function consumeForces(contraption: import('../src/contraption/Contraption.ts').Contraption) {
  contraption.appliedForces.set(0, 0, 0);
  contraption.appliedTorques.set(0, 0, 0);
}

test('disabling the root script stops execution and force application', async () => {
  const { contraption } = makeContraption();
  await setNodeScript(contraption, 'root', 'self.applyForce([0, 100, 0]);');
  assert.equal(contraption.isNodeScriptEnabled('root'), true, 'scripts should be enabled by default');

  contraption.update(1 / 60, null, {});
  assert.ok(contraption.appliedForces.y > 0, 'enabled script should apply force each frame');
  consumeForces(contraption);

  // Disable root.
  contraption.setNodeScriptEnabled('root', false);
  assert.equal(contraption.isNodeScriptEnabled('root'), false);

  contraption.update(1 / 60, null, {});
  assert.equal(contraption.appliedForces.y, 0, 'disabled root script must not run or apply force');
  consumeForces(contraption);

  // Re-enabling resumes execution.
  contraption.setNodeScriptEnabled('root', true);
  contraption.update(1 / 60, null, {});
  assert.ok(contraption.appliedForces.y > 0, 're-enabling should resume execution');
});

test('disabling a child script stops that script and its spin', async () => {
  const { contraption } = makeContraption();
  await setNodeScript(contraption, 'arm', 'self.setLocalSpin([0, 1, 0], 60);');
  contraption.update(1 / 60, null, {});
  const node = contraption.getEntityNode('arm');
  assert.ok(node.localAngularVelocity.length() > 0, 'an enabled component should receive spin velocity');
  const quatBefore = node.localQuaternion.clone();
  contraption.update(1 / 60, null, {});
  const rotated = !node.localQuaternion.equals(quatBefore);
  assert.ok(rotated, 'an enabled component should keep rotating');

  // Disable arm.
  contraption.setNodeScriptEnabled('arm', false);
  contraption.update(1 / 60, null, {});
  assert.equal(node.localAngularVelocity.length(), 0, 'disabling should immediately clear angular velocity');
  const frozen = node.localQuaternion.clone();
  contraption.update(1 / 60, null, {});
  assert.ok(node.localQuaternion.equals(frozen), 'the disabled component must stop rotating');

  // Re-enabling resumes rotation.
  contraption.setNodeScriptEnabled('arm', true);
  contraption.update(1 / 60, null, {});
  assert.ok(node.localAngularVelocity.length() > 0, 're-enabling should resume spin');
});

test('disabling a component thrust script removes spin and thrust', async () => {
  const { contraption } = makeContraption();
  // Blade script combines spin and component thrust in an independently controlled direction.
  await setNodeScript(contraption, 'blade', 'self.setLocalSpin([0, 1, 0], 240); self.applyThrust([0, 300, 0]);');
  contraption.update(1 / 60, null, {});
  const bladeNode = contraption.getEntityNode('blade');
  assert.ok(bladeNode.localAngularVelocity.length() > 0, 'enabled component should spin');
  assert.ok(contraption.appliedForces.y > 0, 'enabled component thrust should apply');
  consumeForces(contraption);

  // Disabling blade stops both script-driven spin and thrust.
  contraption.setNodeScriptEnabled('blade', false);
  contraption.update(1 / 60, null, {});
  assert.equal(bladeNode.localAngularVelocity.length(), 0, 'disabled component should stop spinning');
  assert.equal(contraption.appliedForces.y, 0, 'disabled component must produce no thrust');
  contraption.update(1 / 60, null, {});
  assert.equal(bladeNode.localAngularVelocity.length(), 0, 'component must remain still');
  assert.equal(contraption.appliedForces.y, 0, 'component must remain thrust-free');

  // Re-enable and resume.
  contraption.setNodeScriptEnabled('blade', true);
  contraption.update(1 / 60, null, {});
  assert.ok(bladeNode.localAngularVelocity.length() > 0, 're-enabled component should resume rotation');
  assert.ok(contraption.appliedForces.y > 0, 're-enabled component should resume thrust');
});

test('root and child script toggles are independent', async () => {
  const { contraption } = makeContraption();
  await setNodeScript(contraption, 'root', 'self.applyForce([0, 100, 0]);');
  await setNodeScript(contraption, 'arm', 'self.setLocalSpin([0, 1, 0], 60);');
  const node = contraption.getEntityNode('arm');

  // Disable root while the child keeps running.
  contraption.setNodeScriptEnabled('root', false);
  contraption.update(1 / 60, null, {});
  assert.equal(contraption.appliedForces.y, 0, 'disabled root must not apply force');
  assert.ok(node.localAngularVelocity.length() > 0, 'disabling root should not affect child scripts');
  consumeForces(contraption);

  // Disable arm while root keeps running.
  contraption.setNodeScriptEnabled('root', true);
  contraption.setNodeScriptEnabled('arm', false);
  contraption.update(1 / 60, null, {});
  assert.ok(contraption.appliedForces.y > 0, 'disabling arm should not affect root script');
  assert.equal(node.localAngularVelocity.length(), 0, 'disabled arm script must not run');
});

test('component angular velocity clears whenever driving code stops', async () => {
  const { contraption } = makeContraption();
  const node = contraption.getEntityNode('arm');

  // A: a root-driven child must stop when the root toggle turns off.
  await setNodeScript(contraption, 'root', 'const b = self.child("arm"); if (b) b.setLocalSpin([0, 1, 0], 60);');
  contraption.update(1 / 60, null, {});
  assert.ok(node.localAngularVelocity.length() > 0, 'child should spin while root code runs');
  contraption.setNodeScriptEnabled('root', false);
  contraption.update(1 / 60, null, {});
  assert.equal(node.localAngularVelocity.length(), 0, 'root toggle off should stop its driven child');
  contraption.update(1 / 60, null, {});
  assert.equal(node.localAngularVelocity.length(), 0, 'child must remain still');

  // B: clearing root code must stop motion.
  contraption.setNodeScriptEnabled('root', true);
  contraption.update(1 / 60, null, {});
  assert.ok(node.localAngularVelocity.length() > 0, 'restored code should resume rotation');
  await setNodeScript(contraption, 'root', '');
  contraption.update(1 / 60, null, {});
  assert.equal(node.localAngularVelocity.length(), 0, 'clearing root code must stop child rotation');

  // C: clearing the component's own code must stop motion.
  await setNodeScript(contraption, 'arm', 'self.setLocalSpin([0, 1, 0], 60);');
  contraption.update(1 / 60, null, {});
  assert.ok(node.localAngularVelocity.length() > 0, 'component should spin while its own code runs');
  await setNodeScript(contraption, 'arm', '');
  contraption.update(1 / 60, null, {});
  assert.equal(node.localAngularVelocity.length(), 0, 'clearing component code must stop rotation');

  // C2: compile failure must stop motion instead of retaining the old program.
  await setNodeScript(contraption, 'arm', 'self.setLocalSpin([0, 1, 0], 60);');
  contraption.update(1 / 60, null, {});
  assert.ok(node.localAngularVelocity.length() > 0, 'old code should be running before the failure');
  await setNodeScript(contraption, 'arm', 'this is !!! invalid js');
  contraption.update(1 / 60, null, {});
  assert.equal(node.localAngularVelocity.length(), 0, 'compile failure must stop rotation');
  contraption.update(1 / 60, null, {});
  assert.equal(node.localAngularVelocity.length(), 0, 'component must remain still');
  const compiled = await setNodeScript(contraption, 'arm', 'self.setLocalSpin([0, 1, 0], 60);');
  assert.equal(compiled, true, 'updated code should compile successfully');
  contraption.update(1 / 60, null, {});
  assert.ok(node.localAngularVelocity.length() > 0, 'updated code should restore rotation');

  // D: per-frame code sustains rotation.
  await setNodeScript(contraption, 'arm', 'self.setLocalSpin([0, 1, 0], 60);');
  for (let i = 0; i < 5; i++) {
    contraption.update(1 / 60, null, {});
    assert.ok(node.localAngularVelocity.length() > 0, 'component should keep rotating while code runs every frame');
  }
});

test('reset all clears motion and forces while preserving code and toggles', async () => {
  const { contraption } = makeContraption();
  const arm = contraption.getEntityNode('arm');
  const initialPos = arm.localPosition.clone();
  const initialQuat = arm.localQuaternion.clone();

  // Run code that drives force, component thrust, spin, and position.
  await setNodeScript(contraption, 'root', `
    self.state.setNumber("runs", (self.state.getNumber("runs") || 0) + 1);
    self.applyForce([0, 100, 0]);
    const b = self.child('arm');
    if (b) { b.setLocalSpin([0, 1, 0], 60); b.setLocalPosition([0, 2, 0]); }
    const blade = self.child('blade');
    if (blade) blade.applyThrust([0, 300, 0]);
  `);
  contraption.update(1 / 60, null, {});
  assert.ok(contraption.appliedForces.y > 0, 'force should exist before reset');
  assert.ok(arm.localAngularVelocity.length() > 0, 'component should spin before reset');
  assert.ok(!arm.localPosition.equals(initialPos), 'component should move before reset');

  // Reset all.
  assert.equal(contraption.resetAllComponentState(), true);

  assert.equal(arm.localAngularVelocity.length(), 0, 'component spin should stop after reset');
  assert.ok(arm.localPosition.equals(initialPos), 'component position should reset');
  assert.ok(arm.localQuaternion.equals(initialQuat), 'component orientation should reset');
  assert.equal(contraption.appliedForces.y, 0, 'forces should clear');
  assert.equal(contraption.appliedTorques.length(), 0, 'torques should clear');
  assert.deepEqual(contraption.getComponentState('root'), {}, 'persistent state should clear in place');

  // Code and toggle state remain unchanged.
  assert.equal(contraption.isNodeScriptEnabled('root'), true);
  assert.ok(contraption.getNodeScript('root').includes('applyForce'));

  // Reset clears state but does not stop code, so the next frame can drive again.
  contraption.update(1 / 60, null, {});
  assert.ok(arm.localAngularVelocity.length() > 0, 'running code should drive again on the next frame');

  // Disable all code before reset to keep the component still.
  contraption.disableAllNodeScripts();
  contraption.resetAllComponentState();
  contraption.update(1 / 60, null, {});
  assert.equal(arm.localAngularVelocity.length(), 0, 'disabled code plus reset must remain still');
});

test('enable-all and disable-all semantics are correct', async () => {
  const { contraption } = makeContraption();
  await setNodeScript(contraption, 'root', 'self.applyForce([0, 100, 0]);');
  await setNodeScript(contraption, 'arm', 'self.setLocalSpin([0, 1, 0], 60);');

  contraption.disableAllNodeScripts();
  assert.equal(contraption.isNodeScriptEnabled('root'), false);
  assert.equal(contraption.isNodeScriptEnabled('arm'), false);
  contraption.update(1 / 60, null, {});
  assert.equal(contraption.appliedForces.y, 0, 'disable-all must stop every script');
  assert.equal(contraption.getEntityNode('arm').localAngularVelocity.length(), 0);
  consumeForces(contraption);

  contraption.enableAllNodeScripts();
  assert.equal(contraption.isNodeScriptEnabled('root'), true);
  assert.equal(contraption.isNodeScriptEnabled('arm'), true);
  contraption.update(1 / 60, null, {});
  assert.ok(contraption.appliedForces.y > 0, 'enable-all should resume execution');
  assert.ok(contraption.getEntityNode('arm').localAngularVelocity.length() > 0);
});

test('root self.stop is the global Stop action and ends the current invocation', async () => {
  const { contraption } = makeContraption();
  contraption.setBodyType(BodyType.KINEMATIC);
  const arm = contraption.getEntityNode('arm');
  const initialPosition = arm.initialLocalPosition.clone();
  await setNodeScript(contraption, 'arm', 'self.setLocalPosition([0, 3, 0]); self.state.setBoolean("ran", true);');
  await setNodeScript(contraption, 'root', 'self.state.setBoolean("before", true); self.setLocalSpin([0, 1, 0], 60); self.stop(); self.state.setBoolean("after", true);');

  contraption.update(0.25, null, {});

  assert.equal(contraption.scriptStatus, 'stopped');
  assert.equal(contraption.isNodeScriptEnabled('root'), false);
  assert.equal(contraption.isNodeScriptEnabled('arm'), false);
  assert.deepEqual(contraption.getComponentState('root'), {}, 'Stop clears root state and does not execute later statements');
  assert.deepEqual(contraption.getComponentState('arm'), {}, 'Stop clears child state');
  assert.ok(arm.localPosition.equals(initialPosition), 'Stop restores child transforms');
  assert.ok(contraption.quaternion.equals(new THREE.Quaternion()), 'Stop cancels a root spin commanded earlier in the same frame');
  assert.equal(contraption.scriptRuntime, 0);
  assert.equal(contraption.tickCount, 0);
  assert.equal(contraption.scriptError, null, 'Stop is control flow, not a runtime error');
});

test('self.stop is root-only; child code can stop through ctx.root', async () => {
  const { contraption } = makeContraption();
  await setNodeScript(contraption, 'arm', 'self.stop(); self.state.setBoolean("afterNoop", true);');
  contraption.update(1 / 60, null, {});
  assert.equal(contraption.getComponentState('arm').afterNoop, true, 'direct child stop is a no-op');

  await setNodeScript(contraption, 'arm', 'ctx.root.stop(); self.state.setBoolean("afterStop", true);');
  contraption.update(1 / 60, null, {});
  assert.equal(contraption.scriptStatus, 'stopped');
  assert.deepEqual(contraption.getComponentState('arm'), {}, 'root Stop clears state and ends child invocation');
});

test('script time counts enabled execution, does not advance with all component code disabled, and resets on Stop', async () => {
  const { contraption } = makeContraption();
  await setNodeScript(contraption, 'root', 'self.state.setNumber("time", ctx.time); self.state.setNumber("tick", ctx.tick);');
  contraption.update(0.25, null, {});
  assert.equal(contraption.scriptRuntime, 0.25);
  assert.equal(contraption.tickCount, 1);

  contraption.disableAllNodeScripts();
  contraption.update(0.5, null, {});
  assert.equal(contraption.scriptRuntime, 0.25);
  assert.equal(contraption.tickCount, 1);

  contraption.enableAllNodeScripts();
  contraption.update(0.25, null, {});
  assert.equal(contraption.scriptRuntime, 0.5);
  assert.equal(contraption.tickCount, 2);

  contraption.stopAllNodeScripts();
  assert.equal(contraption.scriptRuntime, 0);
  assert.equal(contraption.tickCount, 0);
});

test('a component runtime error automatically stops the whole entity', async () => {
  const { contraption } = makeContraption();
  await setNodeScript(contraption, 'root', 'throw new Error("root failed");');
  await setNodeScript(contraption, 'arm', 'self.state.setNumber("runs", (self.state.getNumber("runs") || 0) + 1); self.applyThrust([0, 100, 0]);');

  contraption.update(1 / 60, null, {});
  assert.equal(contraption.scriptStatus, 'stopped');
  assert.equal(contraption.isPhysicsSimulationEnabled(), false);
  assert.equal(contraption.isNodeScriptEnabled('root'), false);
  assert.equal(contraption.isNodeScriptEnabled('arm'), false);
  assert.deepEqual(contraption.getComponentState('arm'), {}, 'the interrupted tick state is discarded');
  assert.equal(contraption.appliedForces.length(), 0, 'commands from the interrupted tick are discarded');
  assert.match(contraption.nodeScriptErrors.get('root'), /root failed/);

  contraption.update(1 / 60, null, {});
  assert.deepEqual(contraption.getComponentState('arm'), {}, 'the entity remains stopped');
});

test('a fatal time or fuel budget result automatically stops the whole entity', async () => {
  const { contraption } = makeContraption();
  await setNodeScript(contraption, 'root', 'self.state.setBoolean("runs", true);');
  await setNodeScript(contraption, 'arm', 'self.state.setBoolean("runs", true);');
  contraption.getComponentState('root').old = true;

  contraption.applyScriptRuntimeResult({
    fatal: true,
    error: 'Entity exceeded its WASM execution fuel budget',
    states: { root: { partial: true } },
    commands: [{ scope: 'component', nodeId: 'root', path: 'applyForce', args: [[0, 100, 0]] }]
  }, {});

  assert.equal(contraption.scriptStatus, 'stopped');
  assert.equal(contraption.isPhysicsSimulationEnabled(), false);
  assert.equal(contraption.isNodeScriptEnabled('root'), false);
  assert.equal(contraption.isNodeScriptEnabled('arm'), false);
  assert.deepEqual(contraption.getComponentState('root'), {});
  assert.equal(contraption.appliedForces.length(), 0);
  assert.match(contraption.scriptError, /fuel budget/);
});

test('three consecutive returned slow frames automatically stop the whole entity', async () => {
  const { contraption } = makeContraption();
  await setNodeScript(contraption, 'root', 'self.state.setBoolean("runs", true);');
  await setNodeScript(contraption, 'arm', 'self.state.setBoolean("runs", true);');

  assert.equal(contraption.recordScriptExecutionTime('arm', 50.1), false);
  assert.equal(contraption.recordScriptExecutionTime('arm', 70), false);
  assert.equal(contraption.recordScriptExecutionTime('arm', 60), true);
  assert.equal(contraption.scriptStatus, 'stopped');
  assert.equal(contraption.isPhysicsSimulationEnabled(), false);
  assert.equal(contraption.isNodeScriptEnabled('arm'), false);
  assert.equal(contraption.isNodeScriptEnabled('root'), false);
  assert.match(contraption.nodeScriptErrors.get('arm'), /exceeded 50 ms/);
});
