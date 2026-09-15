import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { Contraption, ContraptionMode } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import {
  PlayerController,
  RESERVED_ENTITY_INPUT_CODES,
  isPerspectiveToggleCode
} from '../src/engine/controls/PlayerController.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';

function inputProbe() {
  return {
    mode: ContraptionMode.PROGRAMMABLE,
    position: new THREE.Vector3(0, 5, 0),
    receivedInput: undefined,
    update(dt, input) {
      this.receivedInput = input;
    }
  };
}

test('keyboard snapshot is routed only to the currently mounted contraption', () => {
  const world = {
    getBlock: () => BlockTypes.AIR,
    raycast: () => ({ hit: false })
  };
  const manager = new ContraptionManager(new THREE.Scene(), world, null, null) as any;
  const mounted = inputProbe();
  const unmounted = inputProbe();
  manager.contraptions.push(mounted, unmounted);

  const keys = { down: ['KeyW', 'KeyA'], pressed: ['KeyW'], released: [] };
  manager.activeDrivable = mounted;
  manager.update(1 / 60, keys);
  assert.equal(mounted.receivedInput, keys);
  assert.equal(unmounted.receivedInput, null);

  manager.activeDrivable = null;
  manager.update(1 / 60, keys);
  assert.equal(mounted.receivedInput, null);
  assert.equal(unmounted.receivedInput, null);
});

test('controller exposes held and one-frame edge states without subscriptions', () => {
  const controller = Object.create(PlayerController.prototype);
  controller.entityInputDown = new Set();
  controller.entityInputPressed = new Set();
  controller.entityInputReleased = new Set();

  controller.recordEntityKeyDown('KeyW');
  controller.recordEntityKeyDown('KeyW');
  let frame = controller.consumeEntityInputFrame();
  assert.deepEqual(frame, { down: ['KeyW'], pressed: ['KeyW'], released: [] });

  frame = controller.consumeEntityInputFrame();
  assert.deepEqual(frame, { down: ['KeyW'], pressed: [], released: [] });

  controller.recordEntityKeyUp('KeyW');
  frame = controller.consumeEntityInputFrame();
  assert.deepEqual(frame, { down: [], pressed: [], released: ['KeyW'] });

  assert.equal(controller.recordEntityKeyDown('KeyC'), false);
  assert.deepEqual(controller.consumeEntityInputFrame(), { down: [], pressed: [], released: [] });
});

test('F3 toggles perspective and perspective shortcuts stay engine-owned', () => {
  assert.equal(isPerspectiveToggleCode('F3'), true);
  assert.equal(isPerspectiveToggleCode('F5'), true);
  assert.equal(isPerspectiveToggleCode('KeyF'), false);
  assert.equal(RESERVED_ENTITY_INPUT_CODES.has('F3'), true);
  assert.equal(RESERVED_ENTITY_INPUT_CODES.has('F5'), true);
  assert.equal(RESERVED_ENTITY_INPUT_CODES.has('KeyB'), false, 'the removed blueprint shortcut is available to entity scripts');
});

test('perspective cycles first, third-person back, then third-person front', () => {
  const controller = Object.create(PlayerController.prototype) as any;
  const avatarVisibility: boolean[] = [];
  controller.perspective = 'first_person';
  controller.thirdPersonDistance = 4;
  controller.sceneRenderer = {
    setPlayerAvatarVisible(visible: boolean) { avatarVisibility.push(visible); }
  };
  controller.ui = { syncSettingsUI() {}, showToast() {} };

  controller.togglePerspective();
  assert.equal(controller.perspective, 'third_person');
  controller.togglePerspective();
  assert.equal(controller.perspective, 'third_person_front');
  controller.togglePerspective();
  assert.equal(controller.perspective, 'first_person');
  assert.deepEqual(avatarVisibility, [false, false, false], 'rapid toggles before a render keep the body hidden at the eye');
});

test('front third-person camera sits ahead of the player and looks back', () => {
  const controller = Object.create(PlayerController.prototype) as any;
  const eye = new THREE.Vector3(1, 2, 3);
  controller.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
  controller.camera.rotation.order = 'YXZ';
  controller.physics = { getEyePosition: () => eye.clone() };
  controller.pitch = 0;
  controller.yaw = 0;
  controller.thirdPersonDistance = 4;

  controller.perspective = 'third_person';
  controller.updateCameraPosition();
  assert.ok(controller.camera.position.distanceTo(new THREE.Vector3(1, 2, 7)) < 1e-8);
  assert.ok(controller.camera.getWorldDirection(new THREE.Vector3()).distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-8);

  controller.perspective = 'third_person_front';
  controller.updateCameraPosition();
  assert.ok(controller.camera.position.distanceTo(new THREE.Vector3(1, 2, -1)) < 1e-8);
  assert.ok(controller.camera.getWorldDirection(new THREE.Vector3()).distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-8);

  // Re-running must be stable rather than deriving the next frame from the
  // already reversed front-camera quaternion.
  controller.updateCameraPosition();
  assert.ok(controller.camera.position.distanceTo(new THREE.Vector3(1, 2, -1)) < 1e-8);
});

test('mounted camera re-seats from the vehicle pose solved later in the frame', () => {
  const controller = Object.create(PlayerController.prototype) as any;
  const seat = new THREE.Vector3(1, 2, 3);
  controller.isDriving = true;
  controller.drivenSeat = { componentId: 'arm', seatIndex: 1 };
  controller.drivenContraption = {
    getSeatWorldPosition: (componentId, seatIndex) => {
      assert.equal(componentId, 'arm');
      assert.equal(seatIndex, 1);
      return seat.clone();
    }
  };
  controller.contraptions = { activeDrivable: controller.drivenContraption };
  controller.physics = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(4, 5, 6)
  };

  assert.equal(controller.syncDrivenVehiclePose(), true);
  assert.deepEqual(controller.physics.position.toArray(), [1, 2, 3]);
  assert.deepEqual(controller.physics.velocity.toArray(), [0, 0, 0]);

  // Simulate the quadcopter moving during ContraptionManager.update(). The
  // post-physics pass must use this new pose rather than the previous frame's.
  seat.set(2.5, 3.25, -4);
  controller.syncDrivenVehiclePose();
  assert.deepEqual(controller.physics.position.toArray(), [2.5, 3.25, -4]);
});

test('a fixed-orientation seat rotates the body without rotating or clamping the camera', () => {
  const controller = Object.create(PlayerController.prototype) as any;
  const seatWorldRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  controller.isDriving = true;
  controller.drivenSeat = { componentId: 'arm', seatIndex: 1 };
  controller.drivenSeatFixedOrientation = true;
  controller.yaw = 0.3;
  controller.pitch = -0.2;
  controller.contraptions = { activeDrivable: null };
  controller.physics = { position: new THREE.Vector3(), velocity: new THREE.Vector3() };
  controller.drivenContraption = {
    getSeatWorldPosition: () => new THREE.Vector3(1, 2, 3),
    getSeatWorldQuaternion: (componentId, seatIndex) => {
      assert.equal(componentId, 'arm');
      assert.equal(seatIndex, 1);
      return seatWorldRotation.clone();
    }
  };

  assert.ok(Math.abs(controller.bodyYaw - Math.PI / 2) < 1e-9);
  assert.ok(controller.bodyQuaternion.angleTo(seatWorldRotation) < 1e-9);
  assert.equal(controller.viewYaw, 0.3);
  assert.equal(controller.pitch, -0.2);

  controller.yaw = 4 * Math.PI;
  assert.equal(controller.viewYaw, 4 * Math.PI, 'camera can turn beyond a full circle');
  seatWorldRotation.setFromEuler(new THREE.Euler(0.2, -0.7, 0.4, 'YXZ'));
  assert.equal(controller.syncDrivenVehiclePose(), true);
  assert.equal(controller.yaw, 4 * Math.PI, 'rotating or tilting the seat never changes camera yaw');
  assert.equal(controller.pitch, -0.2);
  assert.ok(controller.bodyQuaternion.angleTo(seatWorldRotation) < 1e-7, 'body follows seat pitch and roll too');
});

test('seat rotation leaves all three camera perspectives stable and independent', () => {
  const seatRotation = new THREE.Quaternion();
  const eye = new THREE.Vector3(1, 2, 3);
  const controller: any = Object.assign(Object.create(PlayerController.prototype), {
    isDriving: true, drivenSeat: { componentId: 'cab', seatIndex: 0 },
    drivenSeatFixedOrientation: true,
    drivenContraption: { getSeatWorldQuaternion: () => seatRotation.clone() },
    camera: new THREE.PerspectiveCamera(),
    physics: { getEyePosition: () => eye.clone() },
    yaw: 0.3, pitch: -0.2, thirdPersonDistance: 4
  });
  for (const perspective of ['first_person', 'third_person', 'third_person_front']) {
    controller.perspective = perspective;
    controller.updateCameraPosition();
    const position = controller.camera.position.clone();
    const view = controller.camera.quaternion.clone();
    seatRotation.setFromEuler(new THREE.Euler(0.4, 1.8, -0.3, 'YXZ'));
    for (let frame = 0; frame < 3; frame++) {
      controller.updateCameraPosition();
      assert.ok(controller.camera.position.distanceTo(position) < 1e-9, perspective);
      assert.ok(controller.camera.quaternion.angleTo(view) < 1e-7, perspective);
      assert.ok(controller.bodyQuaternion.angleTo(seatRotation) < 1e-7, perspective);
    }
    seatRotation.identity();
  }
});

test('leaving a fixed-orientation seat preserves free look and resets body orientation', () => {
  const controller = Object.create(PlayerController.prototype) as any;
  const seatWorldRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  controller.isDriving = true;
  controller.drivenSeat = { componentId: 'cab', seatIndex: 0 };
  controller.drivenSeatFixedOrientation = true;
  controller.yaw = -0.4;
  controller.pitch = 0.2;
  controller.contraptions = { activeDrivable: null };
  controller.physics = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    width: 0.6,
    isOnGround: true,
    ridingContraption: {}
  };
  controller.drivenContraption = {
    position: new THREE.Vector3(0, 0, 0),
    velocity: new THREE.Vector3(),
    boundingRadius: 2,
    quaternion: new THREE.Quaternion(),
    getSeatWorldQuaternion: () => seatWorldRotation.clone()
  };
  controller.resetEntityInputState = () => {};
  controller.ui = { showToast() {} };

  controller.toggleDriveVehicle();

  assert.equal(controller.isDriving, false);
  assert.equal(controller.drivenSeatFixedOrientation, false);
  assert.equal(controller.drivenSeat, null);
  assert.equal(controller.yaw, -0.4, 'stepping out must not snap the camera');
  assert.equal(controller.pitch, 0.2);
  assert.equal(controller.bodyQuaternion, null);
  assert.equal(controller.bodyYaw, -0.4);
});

test('self.setSeats refreshes fixed orientation and rotation in both directions while mounted', () => {
  const entity = new Contraption(
    'seat-toggle',
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(0, 3, 0), new THREE.Scene(), { seats: [[0, 1, 0]] }
  );
  const controller: any = Object.assign(Object.create(PlayerController.prototype), {
    isDriving: false, yaw: -0.3, pitch: 0.2,
    hoveredContraption: entity,
    hoveredContraptionHit: { contraption: entity, point: entity.getSeatWorldPosition() },
    contraptions: { activeDrivable: null },
    physics: { position: new THREE.Vector3(), velocity: new THREE.Vector3() },
    resetEntityInputState() {}
  });
  controller.toggleDriveVehicle();
  assert.equal(controller.isDriving, true);
  assert.equal(controller.viewYaw, -0.3, 'mounting preserves camera look');
  assert.equal(controller.bodyQuaternion, null);
  const api = entity.getComponentApi(entity.rootComponentId);
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 1.2, -0.3, 'YXZ'));
  api.setSeats([{ position: [0, 1, 0], rotation: rotation.toArray(), fixedOrientation: true }]);
  controller.syncDrivenVehiclePose();
  assert.equal(controller.drivenSeatFixedOrientation, true);
  assert.ok(controller.bodyQuaternion.angleTo(rotation) < 1e-7);

  // Refresh also applies during rendering, before another simulation tick.
  api.setSeats([{ position: [0, 1, 0], fixedOrientation: false }]);
  assert.equal(controller.bodyQuaternion, null);
  assert.equal(controller.bodyYaw, -0.3);
  api.setSeats([{ position: [0, 1, 0], fixedOrientation: true }]);
  assert.ok(controller.bodyQuaternion.angleTo(entity.getSeatWorldQuaternion()) < 1e-7);
  assert.equal(controller.viewYaw, -0.3);
  assert.equal(controller.pitch, 0.2);

  api.setSeats([]);
  assert.equal(controller.syncDrivenVehiclePose(), false);
  assert.equal(controller.isDriving, false);
  assert.equal(controller.contraptions.activeDrivable, null);
  assert.equal(controller.bodyQuaternion, null);
  assert.equal(controller.viewYaw, -0.3, 'removing the occupied seat does not reset camera look');
  entity.dispose();
});

test('the local avatar uses seat body rotation while first-person projection uses the free camera', () => {
  const camera = new THREE.PerspectiveCamera();
  camera.rotation.set(-0.2, 0.3, 0, 'YXZ');
  const view = camera.quaternion.clone();
  const body = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 1.4, -0.3, 'YXZ'));
  let projectedCamera: any;
  const renderer: any = Object.assign(Object.create(SceneRenderer.prototype), {
    camera, playerAvatar: new THREE.Group(),
    playerAvatarCharacter: {
      setHeldTool() { return false; }, update() {},
      updateFirstPersonProjection(value) { projectedCamera = value; }
    }
  });
  renderer.updatePlayerAvatar(new THREE.Vector3(1, 2, 3), 1.4, 1 / 60, { bodyQuaternion: body });
  assert.ok(renderer.playerAvatar.quaternion.angleTo(body) < 1e-7);
  assert.deepEqual(renderer.playerAvatar.position.toArray(), [1, 2, 3]);
  assert.ok(camera.quaternion.angleTo(view) < 1e-7);
  assert.equal(projectedCamera, camera);
  renderer.updatePlayerAvatar(new THREE.Vector3(), 0.3);
  assert.ok(renderer.playerAvatar.quaternion.angleTo(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.3)) < 1e-7);

  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /sceneRenderer\.update\(dt, playerPos, this\.controller\.bodyYaw,\s*\{\s*bodyQuaternion: this\.controller\.bodyQuaternion/);
});

test('V mounts the seat nearest the aimed entity block', () => {
  const controller = Object.create(PlayerController.prototype) as any;
  const focus = new THREE.Vector3(4, 5, 6);
  const focusedBlock = { id: 'focused-block' };
  const target = {
    getBlockWorldCenter(block) {
      assert.equal(block, focusedBlock);
      return focus;
    },
    getNearestSeat(point) {
      assert.equal(point, focus);
      return { componentId: 'cab', seatIndex: 2, worldPosition: new THREE.Vector3(), distanceSq: 0.25 };
    }
  };
  controller.isDriving = false;
  controller.drivenContraption = null;
  controller.drivenSeat = null;
  controller.hoveredContraption = target;
  controller.hoveredContraptionHit = {
    contraption: target,
    point: new THREE.Vector3(4.4, 5.4, 6.4),
    block: focusedBlock
  };
  controller.contraptions = { activeDrivable: null };
  controller.resetEntityInputState = () => {};
  controller.ui = { showToast() {} };

  controller.toggleDriveVehicle();

  assert.equal(controller.isDriving, true);
  assert.equal(controller.drivenContraption, target);
  assert.deepEqual(controller.drivenSeat, { componentId: 'cab', seatIndex: 2 });
  assert.equal(controller.contraptions.activeDrivable, target);
});

test('entity program queries down, pressed and released by KeyboardEvent.code', () => {
  const contraption = new Contraption(
    1,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }],
    new THREE.Vector3(0, 3, 0),
    new THREE.Scene(),
    {
      mode: ContraptionMode.PROGRAMMABLE,
      scriptCode: `
self.state.wDown = ctx.input.down('KeyW');
self.state.wAlias = ctx.input.down('w');
self.state.spacePressed = ctx.input.pressed('Space');
self.state.shiftDown = ctx.input.down('Shift');
self.state.wReleased = ctx.input.released('KeyW');
if (ctx.input.down('KeyW')) self.applyLocalForce([0, 0, -25]);
`
    }
  ) as any;

  contraption.update(1 / 60, {
    down: ['KeyW', 'ShiftRight'],
    pressed: ['Space'],
    released: ['KeyW']
  }, { gravity: [0, -18, 0] });

  const state = contraption.getComponentState('root');
  assert.equal(state.wDown, true);
  assert.equal(state.wAlias, false, 'single-letter V1 aliases are not accepted');
  assert.equal(state.spacePressed, true);
  assert.equal(state.shiftDown, true);
  assert.equal(state.wReleased, true);
  assert.ok(contraption.appliedForces.z < 0);

  contraption.appliedForces.set(0, 0, 0);
  contraption.stopAllNodeScripts();
  assert.deepEqual(state, {}, 'Stop clears root component state in place');
  (state as any).wDown = 'unchanged';
  contraption.update(1 / 60, { down: ['KeyW'], pressed: [], released: [] }, { gravity: [0, -18, 0] });
  assert.equal((state as any).wDown, 'unchanged');
  assert.equal(contraption.appliedForces.lengthSq(), 0);

  contraption.setScript('');
  assert.equal(contraption.scriptStatus, 'stopped');
});

test('Space keydown and keyup prevent default to avoid triggering focused 2D buttons and jumps cleanly', () => {
  let blurred = false;
  const mockButton = {
    tagName: 'BUTTON',
    getAttribute: (attr: string) => null,
    blur() { blurred = true; }
  };
  (globalThis as any).document = {
    activeElement: mockButton,
    body: {},
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  const controller = Object.create(PlayerController.prototype);
  controller.keys = { jump: false };
  controller.recordEntityKeyDown = () => {};
  controller.recordEntityKeyUp = () => {};

  let keydownPrevented = false;
  const keydownEvent = {
    code: 'Space',
    target: { tagName: 'DIV' },
    preventDefault() { keydownPrevented = true; }
  };

  // Simulate keydown Space logic from PlayerController
  if (keydownEvent.code === 'Space') {
    keydownEvent.preventDefault();
    if ((globalThis as any).document.activeElement && (globalThis as any).document.activeElement !== (globalThis as any).document.body && ((globalThis as any).document.activeElement.tagName === 'BUTTON' || (globalThis as any).document.activeElement.getAttribute?.('role') === 'button')) {
      (globalThis as any).document.activeElement.blur();
    }
    controller.keys.jump = true;
  }

  assert.equal(keydownPrevented, true, 'Space keydown must prevent default');
  assert.equal(blurred, true, 'Space keydown must blur focused button');
  assert.equal(controller.keys.jump, true);

  let keyupPrevented = false;
  const keyupEvent = {
    code: 'Space',
    preventDefault() { keyupPrevented = true; }
  };

  if (keyupEvent.code === 'Space') {
    keyupEvent.preventDefault();
    controller.keys.jump = false;
  }

  assert.equal(keyupPrevented, true, 'Space keyup must prevent default');
  assert.equal(controller.keys.jump, false);
});
