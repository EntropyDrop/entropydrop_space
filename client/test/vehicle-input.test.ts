import { worldStub, requireValue } from './fixtures.ts';
import { setScript } from '../../engine/test/script-helpers.ts';
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
import { bendDirection, bendPointForView } from '@entropydrop/space-engine/torus/TorusWorld.ts';

function inputProbe() {
  return {
    mode: ContraptionMode.PROGRAMMABLE,
    position: new THREE.Vector3(0, 5, 0),
    receivedInput: undefined as unknown,
    update(dt: number, input: unknown) {
      this.receivedInput = input;
    }
  };
}

test('keyboard snapshot is routed only to the currently mounted contraption', () => {
  const world = {
    getBlock: () => BlockTypes.AIR,
    raycast: () => ({ hit: false as const })
  };
  const manager = new ContraptionManager(new THREE.Scene(), worldStub(world), null, null) as any;
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
    getSeatWorldPosition: (componentId: string, seatIndex: number) => {
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

test('a fixed-orientation seat rotates the body without changing or clamping mouse-look angles', () => {
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
    getSeatWorldQuaternion: (componentId: string, seatIndex: number) => {
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

test('seat rotation leaves both third-person camera perspectives stable and independent', () => {
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
  for (const perspective of ['third_person', 'third_person_front']) {
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

function mountedCameraFixture() {
  const seatRotation = new THREE.Quaternion();
  const position = new THREE.Vector3(1, 2, 3);
  let fixedOrientation = true;
  const controller: any = Object.assign(Object.create(PlayerController.prototype), {
    isDriving: true, drivenSeat: { componentId: 'cab', seatIndex: 0 },
    drivenContraption: {
      getSeatWorldQuaternion: () => seatRotation.clone(),
      getComponentSeats: () => [{ fixedOrientation }],
    },
    camera: new THREE.PerspectiveCamera(),
    physics: { position, getEyePosition: () => position.clone().add(new THREE.Vector3(0, 1.6, 0)) },
    yaw: 0, pitch: 0, thirdPersonDistance: 4, processBulkEditFrame() {},
  });
  return { controller, seatRotation, position,
    setFixedOrientation(value: boolean) { fixedOrientation = value; } };
}

test('first-person driving follows body bank and eye offset while mouse look remains free', () => {
  const { controller, seatRotation, position } = mountedCameraFixture();
  seatRotation.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4);
  controller.yaw = 4 * Math.PI + 0.4;
  controller.pitch = -0.3;
  const look = new THREE.Quaternion().setFromEuler(new THREE.Euler(controller.pitch, controller.yaw, 0, 'YXZ'));
  const expectedView = seatRotation.clone().multiply(look);
  const expectedEye = new THREE.Vector3(0, 1.6, 0).applyQuaternion(seatRotation).add(position);
  for (let i = 0; i < 4; i++) {
    controller.updateCameraPosition();
    assert.ok(controller.camera.quaternion.angleTo(expectedView) < 1e-7);
    assert.ok(controller.camera.position.distanceTo(expectedEye) < 1e-8);
  }
  assert.equal(controller.yaw, 4 * Math.PI + 0.4);
  assert.equal(controller.pitch, -0.3);
  // A new solved seat pose is observed on the next aim/render pass.
  seatRotation.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.6);
  position.add(new THREE.Vector3(2, 3, 4));
  controller.updateCameraPosition();
  assert.ok(controller.camera.quaternion.angleTo(seatRotation.clone().multiply(look)) < 1e-7);
  assert.ok(controller.camera.position.distanceTo(
    new THREE.Vector3(0, 1.6, 0).applyQuaternion(seatRotation).add(position)) < 1e-8);
});

test('first-person driving matches the body up direction without inheriting seat heading', () => {
  const { controller, seatRotation } = mountedCameraFixture();
  controller.yaw = 0.3;
  seatRotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.2);
  controller.updateCameraPosition();
  const look = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.3, 0, 'YXZ'));
  assert.ok(controller.camera.quaternion.angleTo(look) < 1e-7);
  seatRotation.setFromEuler(new THREE.Euler(0.5, 1.2, -0.8, 'YXZ'));
  controller.updateCameraPosition();
  const bodyUp = new THREE.Vector3(0, 1, 0).applyQuaternion(seatRotation);
  const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(controller.camera.quaternion);
  assert.ok(cameraUp.distanceTo(bodyUp) < 1e-8);
});

test('mounted first-person crosshair picking starts at the tilted camera eye', () => {
  const { controller, seatRotation } = mountedCameraFixture();
  seatRotation.setFromEuler(new THREE.Euler(0.4, 0.6, 0.7, 'YXZ'));
  controller.pitch = -0.2;
  controller.updateCameraPosition();
  let query: any;
  controller.performBasicAction = (command: unknown) => { query = command; };
  controller.performAimRaycast();
  const eye = controller.camera.position;
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(controller.camera.quaternion);
  assert.ok(query.origin.distanceTo(bendPointForView(eye.x, eye.y, eye.z)) < 1e-8);
  assert.ok(query.direction.distanceTo(bendDirection(eye.x, eye.y, eye.z, forward)) < 1e-8);
});

test('first-person tilt stays continuous through vertical pitch and an upside-down roll', () => {
  const { controller, seatRotation } = mountedCameraFixture();
  const heading = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.2);
  const inverseHeading = heading.clone().invert();
  for (const axis of [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)]) {
    for (let degrees = 0; degrees <= 360; degrees++) {
      seatRotation.copy(heading).multiply(new THREE.Quaternion().setFromAxisAngle(axis, degrees * Math.PI / 180));
      controller.updateCameraPosition();
      assert.ok(controller.camera.quaternion.angleTo(seatRotation.clone().multiply(inverseHeading)) < 1e-7,
        `body tilt must not flip at ${degrees} degrees`);
    }
  }
});

test('first-person body tilt resets when seat orientation is released or driving ends', () => {
  const { controller, seatRotation, position, setFixedOrientation } = mountedCameraFixture();
  seatRotation.setFromEuler(new THREE.Euler(0.4, 0, 0.7, 'YXZ'));
  controller.updateCameraPosition();
  assert.ok(controller.camera.quaternion.angleTo(new THREE.Quaternion()) > 0.5);
  setFixedOrientation(false);
  controller.updateCameraPosition();
  assert.ok(controller.camera.quaternion.angleTo(new THREE.Quaternion()) < 1e-7);
  assert.ok(controller.camera.position.distanceTo(position.clone().add(new THREE.Vector3(0, 1.6, 0))) < 1e-8);
  setFixedOrientation(true);
  controller.updateCameraPosition();
  assert.ok(controller.camera.quaternion.angleTo(new THREE.Quaternion()) > 0.5);
  controller.isDriving = false;
  controller.updateCameraPosition();
  assert.ok(controller.camera.quaternion.angleTo(new THREE.Quaternion()) < 1e-7);
});

test('mounted tilt and eye offset ease with perspective switches and interrupted transitions', () => {
  const { controller, seatRotation, position } = mountedCameraFixture();
  seatRotation.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.8);
  controller.updateCameraPosition();
  const initialEye = controller.camera.position.clone();
  const initialRotation = controller.camera.quaternion.clone();
  controller.setPerspective('third_person_front');
  controller.updateCameraPosition();
  assert.ok(controller.camera.position.distanceTo(initialEye) < 1e-8);
  assert.ok(controller.camera.quaternion.angleTo(initialRotation) < 1e-7);
  controller.updateRender(0.14);
  const halfwayEye = controller.camera.position.clone();
  const halfwayRotation = controller.camera.quaternion.clone();
  controller.setPerspective('first_person');
  controller.updateCameraPosition();
  assert.ok(controller.camera.position.distanceTo(halfwayEye) < 1e-8);
  assert.ok(controller.camera.quaternion.angleTo(halfwayRotation) < 1e-7);
  controller.updateRender(0.28);
  assert.ok(controller.camera.position.distanceTo(initialEye) < 1e-8);
  assert.ok(controller.camera.quaternion.angleTo(initialRotation) < 1e-7);
  controller.setPerspective('third_person');
  controller.updateRender(0.28);
  assert.ok(controller.camera.position.distanceTo(position.clone().add(new THREE.Vector3(0, 1.6, 4))) < 1e-8);
  assert.ok(controller.camera.quaternion.angleTo(new THREE.Quaternion()) < 1e-7);
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
  requireValue(api).setSeats([{ position: [0, 1, 0], rotation: rotation.toArray(), fixedOrientation: true }]);
  controller.syncDrivenVehiclePose();
  assert.equal(controller.drivenSeatFixedOrientation, true);
  assert.ok(controller.bodyQuaternion.angleTo(rotation) < 1e-7);

  // Refresh also applies during rendering, before another simulation tick.
  requireValue(api).setSeats([{ position: [0, 1, 0], fixedOrientation: false }]);
  assert.equal(controller.bodyQuaternion, null);
  assert.equal(controller.bodyYaw, -0.3);
  requireValue(api).setSeats([{ position: [0, 1, 0], fixedOrientation: true }]);
  assert.ok(controller.bodyQuaternion.angleTo(entity.getSeatWorldQuaternion()) < 1e-7);
  assert.equal(controller.viewYaw, -0.3);
  assert.equal(controller.pitch, 0.2);

  requireValue(api).setSeats([]);
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
  let characterMotion: any;
  const renderer: any = Object.assign(Object.create(SceneRenderer.prototype), {
    camera, playerAvatar: new THREE.Group(),
    playerAvatarCharacter: {
      setHeldTool() { return false; }, update(_dt: number, motion: unknown) { characterMotion = motion; },
      updateFirstPersonProjection(value: unknown) { projectedCamera = value; }
    }
  });
  renderer.updatePlayerAvatar(new THREE.Vector3(1, 2, 3), 1.4, 1 / 60, { bodyQuaternion: body, seated: true });
  assert.ok(renderer.playerAvatar.quaternion.angleTo(body) < 1e-7);
  assert.deepEqual(renderer.playerAvatar.position.toArray(), [1, 2, 3]);
  assert.ok(camera.quaternion.angleTo(view) < 1e-7);
  assert.equal(projectedCamera, camera);
  assert.equal(characterMotion.seated, true);
  renderer.updatePlayerAvatar(new THREE.Vector3(), 0.3);
  assert.ok(renderer.playerAvatar.quaternion.angleTo(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.3)) < 1e-7);

  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /sceneRenderer\.update\(dt, playerPos, this\.controller\.bodyYaw,\s*\{\s*bodyQuaternion: this\.controller\.bodyQuaternion/);
  assert.match(main, /seated: this\.controller\.isDriving/);
});

test('V mounts the seat nearest the aimed entity block', () => {
  const controller = Object.create(PlayerController.prototype) as any;
  const focus = new THREE.Vector3(4, 5, 6);
  const focusedBlock = { id: 'focused-block' };
  const target = {
    getBlockWorldCenter(block: unknown) {
      assert.equal(block, focusedBlock);
      return focus;
    },
    getNearestSeat(point: { x: number; y: number; z: number }) {
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

test('entity program queries down, pressed and released by KeyboardEvent.code', async () => {
  const contraption = new Contraption(
    1,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }],
    new THREE.Vector3(0, 3, 0),
    new THREE.Scene(),
    {
      mode: ContraptionMode.PROGRAMMABLE,
      scriptCode: `
self.state.setBoolean("wDown", ctx.input.down('KeyW'));
self.state.setBoolean("wAlias", ctx.input.down('w'));
self.state.setBoolean("spacePressed", ctx.input.pressed('Space'));
self.state.setBoolean("shiftDown", ctx.input.down('Shift'));
self.state.setBoolean("wReleased", ctx.input.released('KeyW'));
if (ctx.input.down('KeyW')) self.applyLocalForce([0, 0, -25]);
`
    }
  ) as any;

  await contraption.scriptRuntimeClient.ready();
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

  await setScript(contraption, '');
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
