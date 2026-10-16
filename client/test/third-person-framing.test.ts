import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

function fixture() {
  const eye = new THREE.Vector3(0, 2, 0);
  const controller = Object.assign(Object.create(PlayerController.prototype), {
    camera: new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 10000),
    physics: { getEyePosition: () => eye.clone() },
    isLocked: true, perspective: 'third_person', thirdPersonDistance: 4,
    activeTool: SpecialTool.SHOVEL, processBulkEditFrame() {},
  }) as PlayerController;
  controller.updateCameraPosition();
  return { controller, eye, camera: controller.camera };
}

function makeVehicle() {
  const vehicle = new Contraption(1, [
    { localX: -8, localY: 0, localZ: -12, block: BlockTypes.COLOR_BLOCK, entityId: 'hull' },
    { localX: 7, localY: 3, localZ: 11, block: BlockTypes.COLOR_BLOCK, entityId: 'hull' },
    { localX: 12, localY: 1, localZ: 0, block: BlockTypes.COLOR_BLOCK, entityId: 'wing' },
  ], new THREE.Vector3(), new THREE.Scene(), {
    rootComponentId: 'hull',
    childEntities: [{ id: 'wing', parentId: 'hull', pivot: [8, 1, 0] }],
    decorations: [{ id: 'rotor', position: [0, 5, 0], scale: [35, 0.1, 1], color: 0xffffff }],
  });
  return vehicle;
}

function boxCorners(box: THREE.Box3) {
  const points: THREE.Vector3[] = [];
  const { min, max } = box;
  for (let i = 0; i < 8; i++) {
    points.push(new THREE.Vector3(i & 1 ? max.x : min.x,
      i & 2 ? max.y : min.y, i & 4 ? max.z : min.z));
  }
  return points;
}

function assertBoxFits(box: THREE.Box3, camera: THREE.PerspectiveCamera) {
  camera.updateMatrixWorld(true);
  const projected = boxCorners(box).map(point => point.project(camera));
  for (const p of projected) {
    assert.ok(Math.abs(p.x) <= 0.800001, `horizontal framing: ${p.x}`);
    assert.ok(Math.abs(p.y) <= 0.800001, `vertical framing: ${p.y}`);
    assert.ok(p.z >= -1 && p.z < 1, 'all bounding-box corners are within the depth range');
  }
  return projected;
}

function assertFits(vehicle: Contraption, camera: THREE.PerspectiveCamera) {
  return assertBoxFits(vehicle.getVisualWorldBounds(), camera);
}

test('the entire vehicle bounding box fits across view angles, aspect ratios, FOVs and off-center seats', () => {
  const { controller, eye, camera } = fixture();
  const vehicle = makeVehicle();
  controller.isDriving = true;
  controller.drivenContraption = vehicle;
  eye.set(6, 2, 9);
  vehicle.quaternion.setFromEuler(new THREE.Euler(0.2, 0.6, 0.4));
  let maximumDistance = 0;
  for (const perspective of ['third_person', 'third_person_front'] as const) {
    controller.setPerspective(perspective, false);
    for (const aspect of [0.5, 1, 16 / 9, 3]) {
      camera.aspect = aspect;
      for (const fov of [40, 75, 110]) {
        controller.setFov(fov);
        camera.updateProjectionMatrix();
        for (const [yaw, pitch] of [[0, 0], [1.2, 0.5], [-2, -0.7]]) {
          controller.yaw = yaw;
          controller.pitch = pitch;
          controller.updateRender(5);
          assertFits(vehicle, camera);
          maximumDistance = Math.max(maximumDistance, camera.position.distanceTo(eye));
        }
      }
    }
  }
  assert.ok(maximumDistance > 12, 'automatic fit is not capped by the on-foot slider');
});

test('wide, tall and deep bounding boxes fit in both perspectives, including rotated empty corners', () => {
  for (const [width, height, depth] of [[40, 1, 1], [1, 40, 1], [1, 1, 80], [30, 24, 55]]) {
    const { controller, eye, camera } = fixture();
    const vehicle = new Contraption(2, [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: width - 1, localY: height - 1, localZ: depth - 1, block: BlockTypes.COLOR_BLOCK },
    ], new THREE.Vector3(), new THREE.Scene());
    controller.isDriving = true;
    controller.drivenContraption = vehicle;
    vehicle.getVisualWorldBounds().getCenter(eye);
    for (const perspective of ['third_person', 'third_person_front'] as const) {
      controller.setPerspective(perspective, false);
      controller.updateRender(5);
      const projected = assertFits(vehicle, camera);
      if (width === 40) {
        const screenWidth = (Math.max(...projected.map(p => p.x)) - Math.min(...projected.map(p => p.x))) / 2;
        assert.ok(screenWidth > 0.7, 'wide boxes use the available viewport instead of a one-third width cap');
      }
      vehicle.quaternion.setFromEuler(new THREE.Euler(0.4, 0.9, 0.7));
      controller.yaw = -0.8;
      controller.pitch = 0.6;
      controller.updateRender(5);
      assertFits(vehicle, camera);
      vehicle.quaternion.identity();
      controller.yaw = controller.pitch = 0;
    }
  }
});

test('moving child components and resizing decorations update the fit on the next camera pass', () => {
  const { controller, camera, eye } = fixture();
  const vehicle = makeVehicle();
  controller.isDriving = true;
  controller.drivenContraption = vehicle;
  controller.updateCameraPosition();
  const initial = camera.position.distanceTo(eye);
  vehicle.entityNodes.get('wing')!.group.position.x += 80;
  controller.updateCameraPosition();
  assertFits(vehicle, camera);
  assert.ok(camera.position.distanceTo(eye) > initial);
  const rotor = vehicle.decorationGroups.get('hull')!.children[0];
  rotor.scale.x *= 10;
  controller.updateCameraPosition();
  assertFits(vehicle, camera);
});

test('wheel zoom persists on foot, preserves vehicle fit and restores walking distance after dismount', () => {
  const { controller, camera, eye } = fixture();
  const store = new SpaceUiStore();
  (store as any).snapshot.controller = controller;
  controller.ui = store;
  controller.handleWheel({ deltaY: 100 });
  const walkingDistance = controller.thirdPersonDistance;
  assert.ok(walkingDistance > 4);
  assert.equal((store as any).snapshot.cameraDistance, walkingDistance);
  controller.updateRender(2);
  const vehicle = makeVehicle();
  controller.isDriving = true;
  controller.drivenContraption = vehicle;
  controller.updateCameraPosition();
  const fittedDistance = camera.position.distanceTo(eye);
  controller.handleWheel({ deltaY: 200 });
  controller.updateRender(2);
  const zoomedDistance = camera.position.distanceTo(eye);
  assert.ok(zoomedDistance > fittedDistance * 1.4);
  for (let i = 0; i < 10; i++) controller.updateCameraPosition();
  assert.equal(camera.position.distanceTo(eye), zoomedDistance, 'aim passes do not advance easing');
  controller.yaw = 0.5;
  controller.updateRender(2);
  assertFits(vehicle, camera);
  for (let i = 0; i < 20; i++) controller.handleWheel({ deltaY: -250 });
  controller.updateRender(2);
  assertFits(vehicle, camera);
  assert.ok(camera.position.distanceTo(eye) < zoomedDistance);
  assert.equal(controller.thirdPersonDistance, walkingDistance, 'driving zoom keeps walking preference');
  controller.isDriving = false;
  controller.drivenContraption = null;
  const beforeDismount = camera.position.distanceTo(eye);
  controller.updateRender(1 / 60);
  assert.ok(camera.position.distanceTo(eye) < beforeDismount);
  assert.ok(camera.position.distanceTo(eye) > walkingDistance);
  controller.updateRender(3);
  assert.ok(Math.abs(camera.position.distanceTo(eye) - walkingDistance) < 1e-7);
  controller.isDriving = true;
  controller.drivenContraption = vehicle;
  controller.yaw = 0;
  controller.updateRender(3);
  assert.ok(Math.abs(camera.position.distanceTo(eye) - fittedDistance) < 1e-7);
});

test('plain wheel zoom wins over all tools; Shift+wheel keeps tool operations', () => {
  const { controller } = fixture();
  let toolCalls = 0;
  let prevented = 0;
  controller.cycleInventorySlot = () => { toolCalls++; };
  controller.ui = { cycleColor() { toolCalls++; } } as unknown as SpaceUiStore;
  controller.modeling = { creationWheel() { toolCalls++; return true; }, deactivate() {} } as any;
  controller.wrenchGrab = { active: true, targetDistance: 5 } as any;
  for (const tool of [SpecialTool.HAMMER, SpecialTool.BRUSH, SpecialTool.MODELING, SpecialTool.WRENCH]) {
    controller.activeTool = tool;
    controller.setThirdPersonDistance(4);
    controller.handleWheel({ deltaY: 100, preventDefault() { prevented++; } });
    assert.ok(controller.thirdPersonDistance > 4);
    assert.equal(toolCalls, 0);
  }
  assert.equal(prevented, 4);
  assert.equal(controller.wrenchGrab!.targetDistance, 5);
  controller.handleWheel({ deltaY: 100, shiftKey: true });
  assert.equal(controller.wrenchGrab!.targetDistance, 6);
  for (const tool of [SpecialTool.HAMMER, SpecialTool.BRUSH, SpecialTool.MODELING]) {
    controller.activeTool = tool;
    controller.handleWheel({ deltaY: 100, shiftKey: true });
  }
  assert.equal(toolCalls, 3);
});

test('wheel units match, zoom is bounded and inactive or invalid input cannot move the camera', () => {
  const pixels = fixture().controller;
  const lines = fixture().controller;
  const pages = fixture().controller;
  pixels.handleWheel({ deltaY: 32 });
  lines.handleWheel({ deltaY: 2, deltaMode: 1 });
  pages.handleWheel({ deltaY: 0.04, deltaMode: 2 });
  assert.equal(pixels.thirdPersonDistance, lines.thirdPersonDistance);
  assert.equal(pixels.thirdPersonDistance, pages.thirdPersonDistance);
  for (const deltaY of [NaN, Infinity, -Infinity, 0]) pixels.handleWheel({ deltaY });
  assert.equal(pixels.thirdPersonDistance, lines.thirdPersonDistance);
  pixels.isLocked = false;
  pixels.handleWheel({ deltaY: 100 });
  pixels.isLocked = true;
  pixels.worldPickingSuspended = true;
  pixels.handleWheel({ deltaY: 100 });
  pixels.worldPickingSuspended = false;
  pixels.setPerspective('first_person', false);
  pixels.handleWheel({ deltaY: 100 });
  assert.equal(pixels.thirdPersonDistance, lines.thirdPersonDistance);
  pixels.setPerspective('third_person_front', false);
  for (let i = 0; i < 100; i++) pixels.handleWheel({ deltaY: 250 });
  assert.equal(pixels.thirdPersonDistance, 12);
  for (let i = 0; i < 100; i++) pixels.handleWheel({ deltaY: -250 });
  assert.equal(pixels.thirdPersonDistance, 1.5);
});

test('walking also adapts to character size and narrow viewports without changing the saved distance', () => {
  const { controller, camera, eye } = fixture();
  camera.aspect = 0.3;
  camera.updateProjectionMatrix();
  controller.physics.getAABB = () => ({ minX: -1, maxX: 1, minY: 0, maxY: 3, minZ: -1, maxZ: 1 });
  controller.updateCameraPosition();
  assert.ok(camera.position.distanceTo(eye) > 4);
  assertBoxFits(new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 3, 1)), camera);
  assert.equal(controller.thirdPersonDistance, 4);
  controller.setPerspective('first_person', false);
  controller.updateCameraPosition();
  assert.ok(camera.position.distanceTo(eye) < 1e-8, 'automatic framing does not move first-person eyes');
});
