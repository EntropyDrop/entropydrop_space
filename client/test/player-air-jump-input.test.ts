import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerController } from '../src/engine/controls/PlayerController.ts';
import { PlayerPhysics, PLAYER_AIR_DASH_EXIT_SPEED } from '@entropydrop/space-engine/physics/PlayerPhysics.ts';
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
  controller.syncDrivenVehiclePose = () => false;
  controller.camera = new THREE.PerspectiveCamera();
  return controller;
}

function pressSpace(controller: PlayerController, repeat = false) {
  let prevented = false;
  controller.handleKeyDown({ code: 'Space', repeat, target: null,
    preventDefault() { prevented = true; }
  } as unknown as KeyboardEvent);
  assert.equal(prevented, true);
}

test('controller buffers brief Space presses for one physics tick and ignores keyboard repeats', () => {
  const controller = createController();
  pressSpace(controller);
  controller.keys.jump = false; // Released before the 20 Hz simulation tick.
  controller.updateSimulation(0.05);
  assert.equal(controller.physics.velocity.y, controller.physics.jumpForce);
  assert.equal(controller.keys.jumpPressed, false);
  pressSpace(controller);
  controller.updateSimulation(0.05);
  assert.equal(controller.physics.isDashing, true);
  const previousSpeed = controller.physics.velocity.length();
  pressSpace(controller, true);
  assert.equal(controller.keys.jumpPressed, false);
  controller.updateSimulation(0.05);
  assert.ok(controller.physics.velocity.length() > previousSpeed);
});

test('second Space uses the current crosshair direction in every perspective', () => {
  for (const perspective of ['first_person', 'third_person', 'third_person_front'] as const) {
    for (const pitch of [-0.7, 0, 0.7]) {
      const controller = createController();
      pressSpace(controller);
      controller.updateSimulation(0.05);
      controller.physics.position.y += 10;
      controller.setPerspective(perspective, false);
      controller.yaw = 0.8;
      controller.pitch = pitch;
      const start = controller.physics.position.clone();
      // The simulation must read fresh mouse look even before the render pass.
      pressSpace(controller);
      controller.updateSimulation(0.05);
      const gaze = controller.camera.getWorldDirection(new THREE.Vector3());
      controller.keys.jump = false; // A short tap keeps its original direction.
      const expected = new THREE.Vector3(0, 0, perspective === 'third_person_front' ? 1 : -1)
        .applyEuler(new THREE.Euler(pitch, 0.8, 0, 'YXZ'));
      assert.ok(gaze.distanceTo(expected) < 1e-8);
      controller.yaw += 1;
      controller.pitch = -pitch;
      controller.updateCameraPosition();
      for (let frame = 1; frame < 8; frame++) controller.updateSimulation(0.05);
      const displacement = controller.physics.position.clone().sub(start);
      assert.ok(displacement.distanceTo(gaze.multiplyScalar(5)) < 1e-8);
    }
  }
});

test('releasing controls discards an unconsumed jump press', () => {
  const controller = createController();
  pressSpace(controller);
  controller.resetEntityInputState();
  controller.updateSimulation(0.05);
  assert.equal(controller.physics.isOnGround, true);
  assert.equal(controller.keys.jumpPressed, false);
});

test('holding the second Space keeps dashing and supplies live camera aim without repeat events', () => {
  const controller = createController();
  pressSpace(controller);
  controller.updateSimulation(0.05);
  controller.physics.position.y += 20;
  pressSpace(controller);
  for (let frame = 0; frame < 20; frame++) controller.updateSimulation(0.05);
  assert.equal(controller.physics.isDashing, true);
  assert.ok(controller.physics.position.z < -10);
  assert.equal(controller.physics.dashIntensity, 1);
  controller.pitch = 0.6;
  controller.yaw = -Math.PI / 2;
  for (let frame = 0; frame < 20; frame++) {
    pressSpace(controller, true);
    controller.updateSimulation(0.05);
  }
  const gaze = controller.camera.getWorldDirection(new THREE.Vector3());
  assert.ok(controller.physics.velocity.clone().normalize().dot(gaze) > 0.99999);
  assert.equal(controller.physics.isDashing, true);
  controller.keys.jump = false;
  for (let frame = 0; frame < 4; frame++) controller.updateSimulation(0.05);
  assert.equal(controller.physics.isDashing, false);
  assert.ok(Math.abs(controller.physics.velocity.length() - PLAYER_AIR_DASH_EXIT_SPEED) < 1e-8);
  assert.ok(controller.physics.velocity.clone().normalize().dot(gaze) > 0.99999);
  const previous = controller.physics.position.clone();
  controller.updateSimulation(0.05);
  assert.ok(controller.physics.position.x > previous.x, 'releasing Space preserves momentum along the final aim');
});

test('losing control input ends a sustained dash instead of leaving Space stuck', () => {
  const controller = createController();
  pressSpace(controller);
  controller.updateSimulation(0.05);
  pressSpace(controller);
  for (let frame = 0; frame < 20; frame++) controller.updateSimulation(0.05);
  assert.equal(controller.physics.isDashing, true);
  controller.resetEntityInputState();
  assert.equal(controller.keys.jump, false);
  for (let frame = 0; frame < 4; frame++) controller.updateSimulation(0.05);
  assert.equal(controller.physics.isDashing, false);
});

test('mounting during a dash cancels it and consumes seat input', () => {
  const controller = createController();
  pressSpace(controller);
  controller.updateSimulation(0.05);
  pressSpace(controller);
  controller.updateSimulation(0.05);
  assert.equal(controller.physics.isDashing, true);
  controller.isDriving = true;
  controller.syncDrivenVehiclePose = () => true;
  pressSpace(controller);
  controller.updateSimulation(0.05);
  assert.equal(controller.physics.isDashing, false);
  assert.equal(controller.keys.jumpPressed, false);
});

test('holding F3 cycles the perspective once per physical press', () => {
  const controller = createController();
  let changes = 0;
  controller.togglePerspective = () => { changes++; };
  for (const repeat of [false, true, true, true]) {
    controller.handleKeyDown({ code: 'F3', repeat, target: null, preventDefault() {} } as unknown as KeyboardEvent);
  }
  assert.equal(changes, 1);
});
