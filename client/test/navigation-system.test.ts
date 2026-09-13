import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { NavigationSystem } from '../src/ui/NavigationSystem.ts';

function createPhysics(initial = { x: 8192, y: 20, z: 1024 }) {
  return {
    position: new THREE.Vector3(initial.x, initial.y, initial.z),
    velocity: new THREE.Vector3(),
    isFlying: false
  } as any;
}

function createController() {
  let lockRequested = false;
  return {
    yaw: 0.5,
    get lockRequested() { return lockRequested; },
    requestLock() { lockRequested = true; return Promise.resolve(true); }
  } as any;
}

function createUi() {
  const toasts: string[] = [];
  let refreshes = 0;
  return {
    toasts,
    get refreshes() { return refreshes; },
    showToast(message: string) { toasts.push(message); },
    refresh() { refreshes++; }
  };
}

test('NavigationSystem is DOM-free and validates React form values', () => {
  const physics = createPhysics();
  const ui = createUi();
  const navigation = new NavigationSystem(physics, createController(), ui);

  assert.equal('container' in navigation, false);
  assert.equal(navigation.startFromInputValues('bad', '', '2'), false);
  assert.ok(ui.toasts.some(message => message.includes('valid coordinates')));

  assert.equal(navigation.startFromInputValues('100', '', '200'), true);
  assert.deepEqual(navigation.target, { x: 100, y: 20, z: 200 });
});

test('NavigationSystem switches to flight mode and requests pointer lock', () => {
  const physics = createPhysics();
  const controller = createController();
  const ui = createUi();
  const navigation = new NavigationSystem(physics, controller, ui);

  navigation.startNavigation(8300, 30, 1100);

  assert.equal(navigation.isNavigating, true);
  assert.deepEqual(navigation.target, { x: 8300, y: 30, z: 1100 });
  assert.equal(physics.isFlying, true);
  assert.equal(controller.lockRequested, true);
  assert.ok(ui.refreshes > 0);
  assert.ok(ui.toasts.some(message => message.includes('Navigation Engaged')));
});

test('NavigationSystem advances across the torus without changing camera yaw', () => {
  const physics = createPhysics({ x: 16380, y: 20, z: 1000 });
  const controller = createController();
  controller.yaw = 1.234;
  const navigation = new NavigationSystem(physics, controller, createUi());
  navigation.startNavigation(10, 20, 1000);

  navigation.update(0.1);

  assert.equal(navigation.isNavigating, true);
  assert.ok(physics.position.x > 16380 || physics.position.x < 100);
  assert.equal(controller.yaw, 1.234);
});

test('NavigationSystem snaps to target and publishes arrival', () => {
  const physics = createPhysics();
  const ui = createUi();
  const navigation = new NavigationSystem(physics, createController(), ui);
  navigation.startNavigation(8192.3, 20, 1024.2);

  navigation.update(0.1);

  assert.equal(navigation.isNavigating, false);
  assert.equal(navigation.target, null);
  assert.ok(Math.abs(physics.position.x - 8192.3) < 0.001);
  assert.ok(ui.toasts.some(message => message.includes('Target Reached')));
});

test('NavigationSystem can be cancelled by the React keyboard lifecycle', () => {
  const physics = createPhysics();
  const ui = createUi();
  const navigation = new NavigationSystem(physics, createController(), ui);
  navigation.startNavigation(8500, 20, 1200);
  navigation.stopNavigation('cancelled');

  assert.equal(navigation.isNavigating, false);
  assert.equal(navigation.target, null);
  assert.ok(ui.toasts.some(message => message.includes('Navigation Disengaged')));
});
