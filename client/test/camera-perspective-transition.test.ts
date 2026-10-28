import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { CameraPerspectiveTransition, CAMERA_PERSPECTIVE_TRANSITION_SECONDS as duration } from '../src/engine/controls/CameraPerspectiveTransition.ts';
import { PlayerController, type PlayerPerspective } from '../src/engine/controls/PlayerController.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

function close(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
}

function fixture(perspective: PlayerPerspective = 'first_person') {
  const eye = new THREE.Vector3(1, 2, 3);
  const camera = new THREE.PerspectiveCamera();
  const renderer: any = Object.assign(Object.create(SceneRenderer.prototype), {
    playerAvatar: new THREE.Group(), playerFirstPersonHand: new THREE.Group()
  });
  const controller: any = Object.assign(Object.create(PlayerController.prototype), {
    camera, perspective, yaw: 0, pitch: 0, thirdPersonDistance: 4,
    physics: { getEyePosition: () => eye.clone() }, sceneRenderer: renderer,
    processBulkEditFrame() {}
  });
  controller.updateCameraPosition();
  return { controller, camera, eye, renderer };
}

test('perspective offsets ease in and out over 280 ms and finish at exact targets', () => {
  const transition = new CameraPerspectiveTransition('first_person');
  transition.setPerspective('third_person');
  assert.deepEqual(transition.pose, { distance: 0, angle: 0 });
  transition.advance(duration / 4);
  close(transition.pose.distance, 0.15625);
  transition.advance(duration / 4);
  close(transition.pose.distance, 0.5);
  transition.advance(duration / 4);
  close(transition.pose.distance, 0.84375);
  transition.advance(duration / 4);
  assert.deepEqual(transition.pose, { distance: 1, angle: 0 });
  transition.advance(5);
  assert.deepEqual(transition.pose, { distance: 1, angle: 0 });
});

test('front/back switches orbit at full radius instead of crossing the body', () => {
  const { controller, camera, eye } = fixture('third_person');
  controller.setPerspective('third_person_front');
  controller.updateRender(duration / 2);
  close(camera.position.distanceTo(eye), 4);
  close(camera.position.x - eye.x, 4);
  close(camera.position.z, eye.z);
  assert.ok(camera.getWorldDirection(new THREE.Vector3()).distanceTo(eye.clone().sub(camera.position).normalize()) < 1e-8);
  controller.updateRender(duration / 2);
  assert.ok(camera.position.distanceTo(new THREE.Vector3(1, 2, -1)) < 1e-8);
  controller.updateCameraPosition();
  assert.ok(camera.position.distanceTo(new THREE.Vector3(1, 2, -1)) < 1e-8, 'front camera stays stable on later passes');
});

test('interrupted transitions resume at the current camera pose without snapping', () => {
  const { controller, camera } = fixture();
  controller.setPerspective('third_person');
  controller.updateRender(duration / 3);
  const position = camera.position.clone();
  const rotation = camera.quaternion.clone();
  controller.setPerspective('third_person_front');
  controller.updateCameraPosition();
  assert.ok(camera.position.distanceTo(position) < 1e-8);
  assert.ok(camera.quaternion.angleTo(rotation) < 1e-7);
  controller.updateRender(duration / 3);
  const orbitPosition = camera.position.clone();
  const orbitRotation = camera.quaternion.clone();
  controller.setPerspective('first_person');
  controller.updateCameraPosition();
  assert.ok(camera.position.distanceTo(orbitPosition) < 1e-8);
  assert.ok(camera.quaternion.angleTo(orbitRotation) < 1e-7);
  controller.updateRender(duration);
  assert.deepEqual(camera.position.toArray(), [1, 2, 3]);
  assert.ok(camera.quaternion.angleTo(new THREE.Quaternion()) < 1e-7);
});

test('only the render delta advances easing, not repeated aim/physics camera passes', () => {
  const { controller, camera } = fixture();
  controller.setPerspective('third_person');
  controller.updateRender(duration / 2);
  const position = camera.position.clone();
  for (let pass = 0; pass < 10; pass++) controller.updateCameraPosition();
  assert.ok(camera.position.distanceTo(position) < 1e-8);
  controller.updateRender(0);
  assert.ok(camera.position.distanceTo(position) < 1e-8);
  controller.updateRender(duration / 2);
  close(camera.position.z, 7);
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /controller\.updateRender\(dt\)/);
});

test('easing is frame-rate independent and ignores invalid clock deltas', () => {
  const slow = new CameraPerspectiveTransition('first_person');
  const fast = new CameraPerspectiveTransition('first_person');
  slow.setPerspective('third_person_front'); fast.setPerspective('third_person_front');
  for (let i = 0; i < 4; i++) slow.advance(duration / 8);
  for (let i = 0; i < 16; i++) fast.advance(duration / 32);
  close(slow.pose.distance, fast.pose.distance); close(slow.pose.angle, fast.pose.angle);
  const pose = fast.pose;
  for (const dt of [NaN, Infinity, -1, 0]) fast.advance(dt);
  assert.deepEqual(fast.pose, pose);
  fast.advance(2);
  assert.deepEqual(fast.pose, { distance: 1, angle: Math.PI });
});

test('free mouse look and moving seat eye position remain immediate during transitions', () => {
  const { controller, camera, eye } = fixture();
  controller.isDriving = true;
  controller.drivenSeatFixedOrientation = true;
  controller.setPerspective('third_person');
  controller.updateRender(duration / 2);
  controller.yaw = Math.PI / 2;
  controller.pitch = 0.2;
  const before = camera.position.clone();
  controller.updateCameraPosition();
  assert.ok(camera.position.distanceTo(before) > 1);
  close(controller.viewYaw, Math.PI / 2); close(controller.pitch, 0.2);
  const offset = camera.position.clone().sub(eye);
  eye.add(new THREE.Vector3(6, 4, -3));
  controller.updateCameraPosition();
  assert.ok(camera.position.clone().sub(eye).distanceTo(offset) < 1e-8, 'player/seat motion is never eased or left behind');
  close(camera.position.distanceTo(eye), 2);
});

test('front/back orbit respects free pitch at endpoints and never accumulates roll', () => {
  const { controller, camera, eye } = fixture('third_person');
  controller.pitch = 0.7; controller.yaw = -1.3;
  controller.updateCameraPosition();
  const back = camera.position.clone().sub(eye);
  controller.setPerspective('third_person_front');
  for (let i = 0; i < 16; i++) {
    controller.updateRender(duration / 16);
    close(camera.position.distanceTo(eye), 4);
    close(camera.rotation.z, 0);
    assert.ok(camera.getWorldDirection(new THREE.Vector3()).distanceTo(eye.clone().sub(camera.position).normalize()) < 1e-8);
  }
  assert.ok(camera.position.clone().sub(eye).distanceTo(back.negate()) < 1e-8);
  close(controller.pitch, 0.7); close(controller.viewYaw, -1.3);
});

test('body and first-person hand visibility avoid clipping through the head during zoom', () => {
  const { controller, renderer } = fixture();
  assert.equal(renderer.playerAvatar.visible, false);
  assert.equal(renderer.playerFirstPersonHand.visible, true);
  controller.setPerspective('third_person');
  assert.equal(renderer.playerAvatar.visible, false);
  assert.equal(renderer.playerFirstPersonHand.visible, false);
  controller.updateRender(duration / 2);
  assert.equal(renderer.playerAvatar.visible, true);
  assert.equal(renderer.playerFirstPersonHand.visible, false);
  controller.updateRender(duration / 2);
  controller.setPerspective('first_person');
  assert.equal(renderer.playerAvatar.visible, true, 'body remains until camera nears the head');
  controller.updateRender(duration * 0.8);
  assert.equal(renderer.playerAvatar.visible, false);
  assert.equal(renderer.playerFirstPersonHand.visible, false);
  controller.updateRender(duration * 0.2);
  assert.equal(renderer.playerAvatar.visible, false);
  assert.equal(renderer.playerFirstPersonHand.visible, true);
});

test('saved perspective restores instantly while normal settings changes animate', () => {
  const { controller, camera } = fixture();
  const store = new SpaceUiStore();
  (store as any).snapshot.controller = controller;
  store.setPerspective('third_person_front', false);
  controller.updateCameraPosition();
  close(camera.position.z, -1);
  store.setPerspective('third_person');
  controller.updateCameraPosition();
  close(camera.position.z, -1);
  controller.updateRender(duration);
  close(camera.position.z, 7);
});

test('setting the same perspective again does not restart an in-progress transition', () => {
  const transition = new CameraPerspectiveTransition('first_person');
  transition.setPerspective('third_person'); transition.advance(duration / 2);
  transition.setPerspective('third_person'); transition.advance(duration / 2);
  assert.deepEqual(transition.pose, { distance: 1, angle: 0 });
});
