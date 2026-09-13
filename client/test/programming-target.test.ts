import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import {
  calculateEntityPreviewCameraPose,
  calculatePreviewDragForce,
  ENTITY_PREVIEW_FORCE_LIMIT_RATIO,
  ENTITY_PREVIEW_LAYER,
  ENTITY_PREVIEW_MAX_FPS,
  SceneRenderer
} from '../src/engine/render/SceneRenderer.ts';
import {
  bendPoint,
  bendFrameQuaternion,
  unbendDirection,
  TORUS_GREF,
  TORUS_SPAWN_X,
  TORUS_SPAWN_Z
} from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

test('React editor state exposes the entity random id', t => {
  const originalAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (() => 0) as any;
  t.after(() => { globalThis.requestAnimationFrame = originalAnimationFrame; });

  const entity = new Contraption(
    7,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(),
    new THREE.Scene()
  ) as any;
  const ui = new SpaceUiStore();
  const previewTargets: any[] = [];
  ui.setSceneRenderer({
    setEntityPreviewTarget(target) { previewTargets.push(target); },
    renderEntityPreview() {}
  });

  ui.openCodeEditor(entity);

  assert.equal(ui.getSnapshot().editingContraption.publicId, entity.publicId);
  assert.match(ui.getSnapshot().editingContraption.publicId, /^ent_[0-9a-f-]{36}$/);
  assert.equal(ui.getSnapshot().activeModal, 'code');
  ui.toggleApiDocs(true);
  ui.toggleApiDocs(false);
  assert.deepEqual(previewTargets, [entity, null, entity], 'covered previews suspend and resume their WebGL work');
});

test('programming terminal opens under any tool when pointed at contraption', () => {
  const target = { id: 3 };
  const opened = [];
  const messages = [];
  const controller = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SHOVEL;
  controller.hoveredContraption = null;
  controller.drivenContraption = target;
  controller.contraptions = {
    contraptions: [target],
    activeProgrammingContraption: target
  };
  controller.ui = {
    openCodeEditor: contraption => opened.push(contraption),
    showToast: message => messages.push(message)
  };

  // 1. Not pointing at a contraption -> returns false
  assert.equal(controller.openCodeEditorForTarget(), false);
  assert.equal(opened.length, 0);

  // 2. Pointing at a contraption under SHOVEL -> returns true and opens
  controller.hoveredContraption = target;
  assert.equal(controller.openCodeEditorForTarget(), true);
  assert.deepEqual(opened, [target]);
  assert.equal(controller.contraptions.activeProgrammingContraption, target);

  // 3. Pointing at a contraption under SPOON / BRUSH / WRENCH / HAMMER -> also opens
  controller.activeTool = SpecialTool.BRUSH;
  assert.equal(controller.openCodeEditorForTarget(), true);
  assert.equal(opened.length, 2);
});

test('pointer lock state follows the browser and ignores a stale relock after modal escape', async t => {
  const originalDocument = globalThis.document;
  let pointerLockElement = null;
  let finishRequest;
  let exitCalls = 0;
  const body = {
    requestPointerLock: () => new Promise<void>(resolve => {
      finishRequest = () => {
        pointerLockElement = body;
        resolve();
      };
    })
  };
  globalThis.document = {
    body,
    get pointerLockElement() { return pointerLockElement; },
    exitPointerLock: () => {
      exitCalls++;
      pointerLockElement = null;
    }
  } as any;
  t.after(() => { globalThis.document = originalDocument; });

  const states = [];
  const controller = Object.create(PlayerController.prototype);
  controller.isLocked = false;
  controller.pointerLockDesired = false;
  controller.ui = { setPointerLocked: locked => states.push(locked) };
  controller.sound = { init() {} };

  const pending = controller.requestLock();
  assert.equal(controller.isLocked, false, 'requesting lock must not optimistically hide the cursor');
  controller.unlock(); // Programming modal is closed with Escape before the request finishes.
  finishRequest();

  assert.equal(await pending, false);
  assert.equal(controller.pointerLockDesired, false);
  assert.equal(controller.isLocked, false);
  assert.equal(pointerLockElement, null);
  assert.equal(exitCalls, 1, 'a late successful request is immediately released');
  assert.deepEqual(states, [false]);
});

test('contraption pointing ray must hit an occupied cell, not empty bounds', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null) as any;
  const contraption = new Contraption(
    4,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: 4, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }
    ],
    new THREE.Vector3(),
    scene
  );
  manager.contraptions.push(contraption);

  const direction = new THREE.Vector3(0, 0, 1);
  const gapHit = manager.raycastContraptionHit(
    new THREE.Vector3(2.5, 0.5, -5),
    direction,
    12
  );
  assert.equal(gapHit, null);

  const blockHit = manager.raycastContraptionHit(
    new THREE.Vector3(0.5, 0.5, -5),
    direction,
    12
  );
  assert.equal(blockHit.contraption, contraption);
  assert.deepEqual(blockHit.cell, { x: 0, y: 0, z: 0 });
  assert.ok(Math.abs(blockHit.distance - 5) < 1e-9);
});

test('contraption pointing follows the rendered torus deformation instead of a flat tangent approximation', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null) as any;
  const blockOrigin = new THREE.Vector3(TORUS_SPAWN_X, 18, TORUS_SPAWN_Z + 7.5);
  const contraption = new Contraption(
    5,
    [{ localX: 0, localY: 0, localZ: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK }],
    blockOrigin,
    scene
  );
  manager.contraptions.push(contraption);

  // Aim close to the lower edge of the rendered front face. Across 7.5 m of
  // tube curvature, converting this ray only once at the eye drifts below the
  // 0.125 m voxel even though the bent-space screen ray visibly crosses it.
  const eyeFlat = new THREE.Vector3(TORUS_SPAWN_X + 0.1, 18.01, TORUS_SPAWN_Z);
  const visibleTargetFlat = new THREE.Vector3(blockOrigin.x + 0.1, blockOrigin.y + 0.01, blockOrigin.z);
  const eyeBent = bendPoint(eyeFlat.x, eyeFlat.y, eyeFlat.z);
  const targetBent = bendPoint(visibleTargetFlat.x, visibleTargetFlat.y, visibleTargetFlat.z);
  const directionBent = targetBent.clone().sub(eyeBent).normalize();

  const hit = manager.raycastContraptionHitBent(eyeBent, directionBent, 8);
  assert.equal(hit?.contraption, contraption);
  assert.deepEqual(hit?.cell, { x: 0, y: 0, z: 0 });
  assert.deepEqual(hit?.normal.toArray(), [0, 0, -1]);
  assert.ok(hit.point.distanceTo(visibleTargetFlat) < 1e-4, 'flat interaction point should map back from the rendered face');

  const tangentDirection = unbendDirection(
    eyeFlat.x, eyeFlat.y, eyeFlat.z, directionBent, new THREE.Vector3()
  ).normalize();
  assert.equal(
    manager.raycastContraptionHit(eyeFlat, tangentDirection, 8),
    null,
    'the former one-time tangent approximation exhibits the regression by missing this visible micro voxel'
  );
});

test('aim refresh uses the latest entity transform rather than a previous-frame hit', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null) as any;
  const contraption = new Contraption(
    6,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }],
    new THREE.Vector3(TORUS_SPAWN_X, 18, TORUS_SPAWN_Z - 5),
    scene
  );
  manager.contraptions.push(contraption);

  const eye = new THREE.Vector3(TORUS_SPAWN_X + 0.5, 18.5, TORUS_SPAWN_Z);
  const controller = Object.create(PlayerController.prototype);
  Object.assign(controller, {
    physics: { getEyePosition: () => eye.clone() },
    camera: new THREE.PerspectiveCamera(),
    world: {
      raycastBent: () => ({ hit: false }),
      raycastMicroBent: () => ({ hit: false })
    },
    contraptions: manager,
    hoveredContraption: null,
    hoveredContraptionHit: null,
    activeTool: SpecialTool.SHOVEL,
    selectorRange: null,
    selectedSubtree: null,
    selectedBlockSelection: null
  });

  controller.updateAimRaycast();
  assert.equal(controller.hoveredContraptionHit?.contraption, contraption);

  // Simulate programmable/physics motion after the prior frame's pick. A
  // post-kinematics refresh must immediately discard that stale hit.
  contraption.position.x += 2;
  contraption.updateTransform();
  controller.updateAimRaycast();
  assert.equal(controller.hoveredContraptionHit, null);
});

test('wrench keeps entity picking active without showing hover wireframes', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null) as any;
  const contraption = new Contraption(
    8,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }],
    new THREE.Vector3(TORUS_SPAWN_X, 18, TORUS_SPAWN_Z - 5),
    scene
  );
  manager.contraptions.push(contraption);

  const eye = new THREE.Vector3(TORUS_SPAWN_X + 0.5, 18.5, TORUS_SPAWN_Z);
  const controller = Object.create(PlayerController.prototype);
  Object.assign(controller, {
    physics: { getEyePosition: () => eye.clone() },
    camera: new THREE.PerspectiveCamera(),
    world: {
      raycastBent: () => ({ hit: false }),
      raycastMicroBent: () => ({ hit: false })
    },
    contraptions: manager,
    hoveredContraption: null,
    hoveredContraptionHit: null,
    activeTool: SpecialTool.WRENCH,
    selectorRange: null,
    selectedSubtree: null,
    selectedBlockSelection: null
  });

  controller.updateAimRaycast();
  assert.equal(controller.hoveredContraptionHit?.contraption, contraption, 'wrench interactions still receive the exact entity hit');
  assert.equal(contraption.isHighlighted, false);
  assert.equal(contraption.highlightBox.material.opacity, 0);
  assert.equal(contraption.focusedHighlightNodeId, null);
  assert.equal(contraption.focusHighlightEntries.length, 0);

  controller.activeTool = SpecialTool.SHOVEL;
  controller.updateAimRaycast();
  assert.equal(contraption.isHighlighted, true, 'switching away from wrench restores normal hover feedback');
  assert.equal(contraption.highlightBox.material.opacity, 0.9);
  assert.equal(contraption.focusedHighlightNodeId, 'root');
});

test('programming preview camera is fitted behind the entity bounding box', () => {
  const contraption = {
    position: new THREE.Vector3(10, 4, -2),
    quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.15, Math.PI / 2, -0.1)),
    boundingRadius: 3.5
  };
  const pose = calculateEntityPreviewCameraPose(contraption, 16 / 9, 42);
  const worldOffset = pose.position.clone().sub(contraption.position);
  const entityRear = new THREE.Vector3(0, 0, 1).applyQuaternion(contraption.quaternion);
  const framingLift = worldOffset.clone().addScaledVector(entityRear, -pose.distance);

  assert.ok(worldOffset.dot(entityRear) > contraption.boundingRadius);
  assert.ok(framingLift.distanceTo(new THREE.Vector3(0, pose.radius * 0.28, 0)) < 1e-9);
  assert.deepEqual(pose.center.toArray(), contraption.position.toArray());
  assert.deepEqual(pose.up.toArray(), [0, 1, 0]);
});

test('programming preview isolates the selected entity on its own render layer', () => {
  const renderer: any = Object.create(SceneRenderer.prototype);
  renderer.previewTarget = null;
  renderer.previewForceArrow = null;
  renderer.previewCanvas = { classList: { remove() {} } };
  renderer.previewOrbit = renderer.createDefaultPreviewOrbit();
  renderer.previewInteraction = null;
  renderer.previewArrowHoldUntil = 0;
  renderer.previewLastRenderedAt = 99;
  const firstRoot = new THREE.Group();
  const firstMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  firstRoot.add(firstMesh);
  const secondRoot = new THREE.Group();
  const previewLayer = new THREE.Layers();
  previewLayer.set(ENTITY_PREVIEW_LAYER);

  renderer.setEntityPreviewTarget({ rootGroup: firstRoot });
  assert.equal(firstRoot.layers.test(previewLayer), true);
  assert.equal(firstMesh.layers.test(previewLayer), true);
  assert.equal(renderer.previewLastRenderedAt, 0);

  renderer.setEntityPreviewTarget({ rootGroup: secondRoot });
  assert.equal(firstRoot.layers.test(previewLayer), false, 'the previous target leaves the preview layer');
  assert.equal(firstMesh.layers.test(previewLayer), false);
  assert.equal(secondRoot.layers.test(previewLayer), true);
});

test('programming preview refresh is capped independently of the React HUD', () => {
  const renderer: any = Object.create(SceneRenderer.prototype);
  renderer.previewTarget = {};
  renderer.previewRenderer = {};
  renderer.previewCamera = {};
  renderer.previewCanvas = {};
  renderer.previewLastRenderedAt = 100;
  let renders = 0;
  renderer.renderEntityPreview = () => { renders += 1; };

  assert.equal(renderer.renderEntityPreviewIfDue(120), false);
  assert.equal(renderer.renderEntityPreviewIfDue(134), true);
  assert.equal(renderer.renderEntityPreviewIfDue(150), false);
  assert.equal(renderer.renderEntityPreviewIfDue(168), true);
  assert.equal(renders, 2);
  assert.equal(ENTITY_PREVIEW_MAX_FPS, 30);
});

test('programming preview drag maps camera-plane motion to a bounded world force', () => {
  const cameraOrientation = new THREE.Quaternion();
  const maxForce = 1000;
  const right = calculatePreviewDragForce(cameraOrientation, 70, 0, maxForce);
  const upward = calculatePreviewDragForce(cameraOrientation, 0, -70, maxForce);
  const clamped = calculatePreviewDragForce(cameraOrientation, 10000, 0, maxForce);

  assert.ok(right.x > 0 && Math.abs(right.y) < 1e-9 && Math.abs(right.z) < 1e-9);
  assert.ok(upward.y > 0 && Math.abs(upward.x) < 1e-9 && Math.abs(upward.z) < 1e-9);
  assert.ok(Math.abs(clamped.length() - maxForce * ENTITY_PREVIEW_FORCE_LIMIT_RATIO) < 1e-9);
});

test('programming preview drag converts bent camera axes back to flat physics space', () => {
  const flatPoint = new THREE.Vector3(TORUS_SPAWN_X, TORUS_GREF, TORUS_SPAWN_Z);
  const bentCameraOrientation = bendFrameQuaternion(
    flatPoint.x,
    flatPoint.y,
    flatPoint.z,
    new THREE.Quaternion()
  ).clone();
  const maxForce = 1000;
  const right = calculatePreviewDragForce(
    bentCameraOrientation,
    70,
    0,
    maxForce,
    flatPoint
  );
  const upward = calculatePreviewDragForce(
    bentCameraOrientation,
    0,
    -70,
    maxForce,
    flatPoint
  );

  assert.ok(right.x > 0 && Math.abs(right.y) < 1e-9 && Math.abs(right.z) < 1e-9);
  assert.ok(upward.y > 0 && Math.abs(upward.x) < 1e-9 && Math.abs(upward.z) < 1e-9);
});
