import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerController } from '../src/engine/controls/PlayerController.ts';
import { PlayerPhysics } from '@entropydrop/space-engine/physics/PlayerPhysics.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';

function createController() {
  const controller = Object.create(PlayerController.prototype) as PlayerController;
  controller.keys = { forward: false, backward: false, left: false, right: false,
    jump: false, jumpPressed: false, crouch: false, sprint: false };
  controller.physics = new PlayerPhysics({
    getBlock: () => BlockTypes.AIR,
    getMicroBlocksInAABB: () => []
  });
  controller.physics.setInitialPosition(0, 0, 0);
  controller.physics.update(0.05, {}, 0);
  controller.recordEntityKeyDown = () => true;
  controller.recordEntityKeyUp = () => true;
  controller.syncDrivenVehiclePose = () => false;
  controller.camera = new THREE.PerspectiveCamera();
  return controller;
}

function key(controller: PlayerController, code: string, timeStamp: number, down = true, repeat = false, target: unknown = null) {
  const event = { code, timeStamp, repeat, target, preventDefault() {} } as KeyboardEvent;
  if (down) controller.handleKeyDown(event);
  else controller.handleKeyUp(event);
}

function tapSpace(controller: PlayerController, time: number) {
  key(controller, 'Space', time);
  key(controller, 'Space', time + 10, false);
}

test('a single brief Space press is buffered until the next physics tick', () => {
  const controller = createController();
  tapSpace(controller, 100);
  controller.updateSimulation(0.05);
  assert.equal(controller.physics.velocity.y, controller.physics.jumpForce);
  assert.equal(controller.keys.jumpPressed, false);
  assert.equal(controller.physics.isFlying, false);
});

test('double Space toggles flight even when both taps precede the next physics tick', () => {
  const controller = createController();
  tapSpace(controller, 100);
  key(controller, 'Space', 250);
  assert.equal(controller.physics.isFlying, true);
  assert.equal(controller.keys.jumpPressed, false);
  controller.updateSimulation(0.05);
  assert.equal(controller.physics.velocity.y, controller.physics.flySpeed);
  key(controller, 'Space', 300, false);
  controller.updateSimulation(0.05);
  assert.equal(controller.physics.velocity.length(), 0);
  tapSpace(controller, 500);
  key(controller, 'Space', 650);
  assert.equal(controller.physics.isFlying, false);
  controller.updateSimulation(0.05);
  assert.equal(controller.physics.velocity.y, controller.physics.gravity * 0.05);
});

test('two quick released taps enter flight and hover without starting an airborne burst', () => {
  const controller = createController();
  controller.physics.position.y = 10;
  tapSpace(controller, 100);
  tapSpace(controller, 200);
  controller.updateSimulation(0.05);
  assert.equal(controller.physics.isFlying, true);
  assert.deepEqual(controller.physics.position.toArray(), [0, 10, 0]);
  assert.equal(controller.physics.velocity.length(), 0);
});

test('Space presses outside the double-tap interval do not fly or dash', () => {
  const controller = createController();
  tapSpace(controller, 100);
  controller.updateSimulation(0.05);
  const previousY = controller.physics.velocity.y;
  key(controller, 'Space', 451);
  controller.updateSimulation(0.05);
  assert.equal(controller.physics.isFlying, false);
  assert.equal(controller.physics.velocity.y, previousY + controller.physics.gravity * 0.05);
  assert.equal(controller.physics.velocity.z, 0);
});

test('holding Space and repeated keydowns cannot synthesize a double-tap or extend its deadline', () => {
  const controller = createController();
  key(controller, 'Space', 100);
  controller.updateSimulation(0.05);
  for (const time of [120, 200, 400]) key(controller, 'Space', time, true, true);
  key(controller, 'Space', 410); // Duplicate keydown without keyup.
  assert.equal(controller.keys.jumpPressed, false);
  assert.equal(controller.physics.isFlying, false);
  key(controller, 'Space', 420, false);
  key(controller, 'Space', 500);
  assert.equal(controller.physics.isFlying, false);
});

test('triple Space consumes the completed pair instead of immediately toggling flight off', () => {
  const controller = createController();
  tapSpace(controller, 100);
  tapSpace(controller, 200);
  tapSpace(controller, 300);
  assert.equal(controller.physics.isFlying, true);
});

test('Shift sneaks or descends while Ctrl independently accelerates horizontal flight', () => {
  const controller = createController();
  key(controller, 'ShiftLeft', 100);
  assert.equal(controller.keys.crouch, true);
  assert.equal(controller.keys.sprint, false);
  assert.equal(controller.physics.isSprinting, false);
  controller.updateSimulation(0.05);
  assert.equal(controller.physics.isCrouching, true);
  controller.physics.position.y = 10;
  controller.physics.isFlying = true;
  key(controller, 'ControlLeft', 150);
  key(controller, 'KeyW', 160);
  controller.updateSimulation(0.05);
  assert.equal(controller.physics.isCrouching, false);
  assert.equal(controller.physics.velocity.y, -controller.physics.flySpeed);
  assert.equal(controller.physics.velocity.z, -controller.physics.flySpeed * 1.8);
  key(controller, 'ControlLeft', 170, false);
  assert.equal(controller.keys.crouch, true);
  assert.equal(controller.physics.isSprinting, false);
  key(controller, 'ShiftLeft', 180, false);
  controller.updateSimulation(0.05);
  assert.equal(controller.physics.velocity.y, 0);
});

for (const [left, right, state] of [
  ['ShiftLeft', 'ShiftRight', 'crouch'], ['ControlLeft', 'ControlRight', 'sprint']
] as const) {
  test(`releasing ${left} preserves ${right} and keyup works after editor focus changes`, () => {
    const controller = createController();
    key(controller, left, 100);
    key(controller, right, 110);
    key(controller, left, 120, false, false, { tagName: 'INPUT' });
    assert.equal(controller.keys[state], true);
    key(controller, right, 130, false, false, { tagName: 'INPUT' });
    assert.equal(controller.keys[state], false);
  });
}

test('losing input clears movement, pending jumps and double-tap history', () => {
  const controller = createController();
  key(controller, 'Space', 100);
  key(controller, 'KeyW', 110);
  key(controller, 'ShiftLeft', 120);
  key(controller, 'ControlLeft', 130);
  controller.resetEntityInputState();
  assert.ok(Object.values(controller.keys).every(value => value === false));
  assert.equal(controller.physics.isSprinting, false);
  controller.updateSimulation(0.05);
  assert.equal(controller.physics.isOnGround, true);
  key(controller, 'Space', 200);
  assert.equal(controller.physics.isFlying, false);
});

for (const mode of ['driving', 'navigating'] as const) {
  test(`Space cannot toggle flight while ${mode}`, () => {
    const controller = createController();
    if (mode === 'driving') controller.isDriving = true;
    else controller.navigationSystem = { isNavigating: true } as any;
    tapSpace(controller, 100);
    tapSpace(controller, 200);
    assert.equal(controller.physics.isFlying, false);
    controller.isDriving = false;
    controller.navigationSystem = null;
    key(controller, 'Space', 300);
    assert.equal(controller.physics.isFlying, false);
  });
}

test('Space in a text input does not count toward a flight gesture', () => {
  const controller = createController();
  key(controller, 'Space', 100, true, false, { tagName: 'TEXTAREA' });
  key(controller, 'Space', 110, false);
  key(controller, 'Space', 200);
  assert.equal(controller.physics.isFlying, false);
});

test('holding F3 cycles the perspective once per physical press', () => {
  const controller = createController();
  let changes = 0;
  controller.togglePerspective = () => { changes++; };
  for (const repeat of [false, true, true, true]) key(controller, 'F3', 100, true, repeat);
  assert.equal(changes, 1);
});
