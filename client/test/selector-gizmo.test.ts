import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { bendPoint } from '@entropydrop/space-engine/torus/TorusWorld.ts';

function makeStubWorld(microPairs: Array<[string, number]> = []) {
  const map = new Map<string, { color: number }>();
  for (const [key, color] of microPairs) {
    map.set(key, { color });
  }
  return {
    microVoxels: { cells: map },
    getMicroBlock(mx: number, my: number, mz: number) {
      return map.get(`${mx},${my},${mz}`) || null;
    },
    getBlock() { return 0; },
    getBlockColor() { return 0; },
    hasMicroInStandardCell() { return false; },
    isAir(x: number, y: number, z: number) { return true; }
  };
}

function makeStubSceneRenderer() {
  const sr: any = Object.create(SceneRenderer.prototype);
  sr.scene = new THREE.Scene();
  sr.setupSelectionHologram();
  sr.setupSelectionAxisGizmo();
  return sr;
}

test('ContraptionManager.expandSelectionAxis expands and shrinks standard selection bounds', () => {
  const scene = new THREE.Scene();
  const world = makeStubWorld();
  const manager = new ContraptionManager(scene, world, null, null);

  manager.selectionCornerA = { x: 5, y: 10, z: 2 };
  manager.selectionCornerB = { x: 8, y: 12, z: 6 };

  // Expand +X by 2 blocks
  let res = manager.expandSelectionAxis('x', 1, 2, false);
  assert.equal(res.ok, true);
  assert.equal(res.bounds.maxX, 10);
  assert.equal(res.bounds.minX, 5);

  // Shrink +X by 1 block
  res = manager.expandSelectionAxis('x', 1, -1, false);
  assert.equal(res.ok, true);
  assert.equal(res.bounds.maxX, 9);

  // Expand -X by 2 blocks (minX decreases)
  res = manager.expandSelectionAxis('x', -1, 2, false);
  assert.equal(res.ok, true);
  assert.equal(res.bounds.minX, 3);

  // Expand +Y by 1 block
  res = manager.expandSelectionAxis('y', 1, 1, false);
  assert.equal(res.ok, true);
  assert.equal(res.bounds.maxY, 13);

  // Expand -Z by 1 block (minZ decreases)
  res = manager.expandSelectionAxis('z', -1, 1, false);
  assert.equal(res.ok, true);
  assert.equal(res.bounds.minZ, 1);

  // Clamping: cannot shrink below 1 block span (maxX cannot be less than minX)
  res = manager.expandSelectionAxis('x', 1, -20, false);
  assert.equal(res.ok, true);
  assert.equal(res.bounds.maxX, res.bounds.minX);
});

test('ContraptionManager.expandSelectionAxis expands and rematerializes micro selection', () => {
  const scene = new THREE.Scene();
  const world = makeStubWorld([
    ['19,47,20', 0x111111],
    ['20,47,20', 0x222222],
    ['21,47,20', 0x333333]
  ]);
  const manager = new ContraptionManager(scene, world, null, null);

  // Start with micro selection from 19 to 20 on X
  manager.microBounds = { minX: 19, minY: 47, minZ: 20, maxX: 20, maxY: 47, maxZ: 20 };
  manager.microSelection = manager.materializeMicroBox(19, 47, 20, 20, 47, 20);
  assert.equal(manager.microSelection.length, 2);

  // Expand +X by 1 micro step -> now covers 19..21 (should capture 3rd voxel)
  const res = manager.expandSelectionAxis('x', 1, 1, true);
  assert.equal(res.ok, true);
  assert.equal(res.bounds.maxX, 21);
  assert.equal(manager.microSelection.length, 3);

  // Shrink +X by 1 micro step -> back to 19..20 (2 voxels)
  const shrinkRes = manager.expandSelectionAxis('x', 1, -1, true);
  assert.equal(shrinkRes.ok, true);
  assert.equal(shrinkRes.bounds.maxX, 20);
  assert.equal(manager.microSelection.length, 2);
});

test('SceneRenderer creates 6 selection gizmo handles and updates face positions', () => {
  const renderer = makeStubSceneRenderer();
  assert.ok(renderer.selectionAxisGizmo);
  assert.equal(renderer.selectionGizmoHandles.size, 6);

  const keys = ['+x', '-x', '+y', '-y', '+z', '-z'];
  for (const k of keys) {
    assert.ok(renderer.selectionGizmoHandles.has(k), `Handle ${k} should exist`);
  }

  // Update with standard bounds [2, 5, 3] to [4, 7, 6]
  renderer.updateSelectionAxisGizmo({ minX: 2, minY: 5, minZ: 3, maxX: 4, maxY: 7, maxZ: 6 }, false);
  assert.equal(renderer.selectionAxisGizmo.visible, true);

  // +X face is at maxX + 1 = 5.0; handle position should be > 5.0
  const handlePosX = renderer.selectionGizmoHandles.get('+x')!.position;
  assert.ok(handlePosX.x >= 5.0, '+X handle should be at or outside +X face');

  // -X face is at minX = 2.0; handle position should be < 2.0
  const handleNegX = renderer.selectionGizmoHandles.get('-x')!.position;
  assert.ok(handleNegX.x <= 2.0, '-X handle should be at or outside -X face');

  // Test raycast against gizmo
  const raycaster = new THREE.Raycaster();
  // Aim directly at the +X handle position from outside
  raycaster.set(new THREE.Vector3(10, handlePosX.y, handlePosX.z), new THREE.Vector3(-1, 0, 0));
  const hit = renderer.raycastSelectionGizmo(raycaster);
  assert.ok(hit, 'Raycaster should intersect gizmo handle');
  assert.equal(hit.axis, 'x');
  assert.equal(hit.direction, 1);

  // Clear gizmo
  renderer.clearSelectionAxisGizmo();
  assert.equal(renderer.selectionAxisGizmo.visible, false);
});

test('PlayerController activates SelectionAxisGizmo on confirmed selection and drags to expand', () => {
  const scene = new THREE.Scene();
  const world = makeStubWorld();
  const manager = new ContraptionManager(scene, world, null, null);
  const renderer = makeStubSceneRenderer();

  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectorMicroMode = false;
  controller.contraptions = manager;
  controller.sceneRenderer = renderer;
  controller.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  controller.camera.position.set(0, 10, 20);
  controller.camera.lookAt(0, 0, 0);
  controller.physics = { getEyePosition: () => new THREE.Vector3(0, 10, 20) };
  controller.ui = { showToast() {} };
  controller.sound = { playWrenchClick() {} };
  controller.hoveredGizmoHandle = null;
  controller.activeGizmoDrag = null;

  // Before confirmation, gizmo is not shown
  controller.updateSelectionAxisGizmo();
  assert.equal(renderer.selectionAxisGizmo.visible, false);

  // Confirm standard selection
  manager.selectionCornerA = { x: 2, y: 3, z: 4 };
  manager.selectionCornerB = { x: 5, y: 6, z: 7 };
  controller.updateSelectionAxisGizmo();
  assert.equal(renderer.selectionAxisGizmo.visible, true);

  // Start gizmo drag on +X
  controller.startGizmoDrag({ handleKey: '+x', axis: 'x', direction: 1 });
  assert.ok(controller.activeGizmoDrag);
  assert.equal(controller.activeGizmoDrag.axis, 'x');

  // Trigger drag step expansion
  manager.expandSelectionAxis('x', 1, 1, false);
  const bounds = manager.getSelectionBounds();
  assert.equal(bounds.maxX, 6, 'maxX should expand from 5 to 6');

  // Release drag
  controller.releaseGizmoDrag();
  assert.equal(controller.activeGizmoDrag, null);

  // Switching tool clears the gizmo
  controller.activateTool(SpecialTool.SHOVEL);
  assert.equal(renderer.selectionAxisGizmo.visible, false);
});

test('handleLeftClick on gizmo handle starts drag without clearing selection', () => {
  const scene = new THREE.Scene();
  const world = makeStubWorld();
  const manager = new ContraptionManager(scene, world, null, null);
  const renderer = makeStubSceneRenderer();

  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectorMicroMode = false;
  controller.contraptions = manager;
  controller.sceneRenderer = renderer;
  controller.keys = {};
  controller.currentRaycast = { hit: true, hitPos: { x: 10, y: 10, z: 10 } };
  controller.sound = { playWrenchClick() {} };
  controller.ui = { showToast() {} };

  // Set up confirmed selection
  manager.selectionCornerA = { x: 10, y: 10, z: 10 };
  manager.selectionCornerB = { x: 12, y: 12, z: 12 };

  // Hovering a gizmo handle
  controller.hoveredGizmoHandle = { handleKey: '+y', axis: 'y', direction: 1 };
  controller.handleLeftClick();

  // Drag should start, selection must NOT be cleared
  assert.ok(controller.activeGizmoDrag);
  assert.equal(controller.activeGizmoDrag.axis, 'y');
  assert.notEqual(manager.selectionCornerA, null);
  assert.notEqual(manager.selectionCornerB, null);

  // Release drag
  controller.releaseGizmoDrag();

  // Clicking without hovering gizmo handle clears the selection
  controller.hoveredGizmoHandle = null;
  controller.handleLeftClick();
  assert.equal(manager.selectionCornerA, null);
  assert.equal(manager.selectionCornerB, null);
});

test('updateGizmoDrag translates mouse movement to discrete steps in micro mode', () => {
  const scene = new THREE.Scene();
  const world = makeStubWorld([
    ['10,10,10', 0x111111],
    ['11,10,10', 0x222222],
    ['12,10,10', 0x333333]
  ]);
  const manager = new ContraptionManager(scene, world, null, null);
  const renderer = makeStubSceneRenderer();

  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectorMicroMode = true;
  controller.contraptions = manager;
  controller.sceneRenderer = renderer;
  controller.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  // Looking down -Z from (0, 0, 10)
  controller.camera.position.set(0, 0, 10);
  controller.camera.lookAt(0, 0, 0);
  controller.isLocked = true;
  controller.sound = { playWrenchClick() {} };
  controller.ui = { showToast() {} };

  manager.microBounds = { minX: 10, minY: 10, minZ: 10, maxX: 11, maxY: 10, maxZ: 10 };
  manager.microSelection = manager.materializeMicroBox(10, 10, 10, 11, 10, 10);
  assert.equal(manager.microSelection.length, 2);

  controller.startGizmoDrag({ handleKey: '+x', axis: 'x', direction: 1 });
  assert.equal(controller.activeGizmoDrag.isMicro, true);

  // Simulate mouse movement in +X direction (movementX > 0)
  const event = { movementX: 30, movementY: 0 } as any;
  controller.updateGizmoDrag(event);

  // maxX should have expanded
  const mb = manager.getMicroSelectionBounds();
  assert.ok(mb.maxX > 11, `maxX should expand past 11, got ${mb.maxX}`);
  assert.equal(manager.microSelection.length, 3, 'Newly covered voxel should be captured');
});

test('expandSelectionAxis clamps to MAX_ENTITY_BOUNDS (64 blocks)', () => {
  const scene = new THREE.Scene();
  const world = makeStubWorld();
  const manager = new ContraptionManager(scene, world, null, null);

  manager.selectionCornerA = { x: 0, y: 10, z: 0 };
  manager.selectionCornerB = { x: 60, y: 10, z: 0 };

  // Try to expand by 20 blocks (would be 81 total, exceeding 64 limit)
  manager.expandSelectionAxis('x', 1, 20, false);
  const bounds = manager.getSelectionBounds();
  assert.equal(bounds.maxX - bounds.minX + 1, 64, 'Span must be clamped to 64 blocks');
});

test('SceneRenderer.updateSelectionAxisGizmo positions and rotates gizmo to entity node frame', () => {
  const renderer = makeStubSceneRenderer();
  const group = new THREE.Group();
  group.position.set(10, 20, 30);
  group.rotation.set(0, Math.PI / 2, 0);
  group.updateMatrixWorld(true);

  const pivot = new THREE.Vector3(1, 0, 1);
  const bounds = { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 };

  renderer.updateSelectionAxisGizmo(bounds, false, { object: group, pivot });
  assert.equal(renderer.selectionAxisGizmo.visible, true);

  // Local center is cx=1, cy=1, cz=1. Relative to pivot (1,0,1): (0, 1, 0).
  // In world, group is at (10, 20, 30) rotated 90 deg around Y: (0, 1, 0) transforms to (10, 21, 30).
  const gizmoPos = renderer.selectionAxisGizmo.position;
  assert.ok(Math.abs(gizmoPos.x - 10) < 1e-4);
  assert.ok(Math.abs(gizmoPos.y - 21) < 1e-4);
  assert.ok(Math.abs(gizmoPos.z - 30) < 1e-4);

  // Gizmo orientation matches group quaternion
  const gizmoQuat = renderer.selectionAxisGizmo.quaternion;
  const groupQuat = new THREE.Quaternion();
  group.getWorldQuaternion(groupQuat);
  assert.ok(Math.abs(gizmoQuat.y - groupQuat.y) < 1e-4);

  // Handles are relative to gizmo center
  const handleX = renderer.selectionGizmoHandles.get('+x')!.position;
  assert.ok(handleX.x > 0.5, 'Handle +x should be outside local positive face');
  assert.equal(handleX.y, 0, 'Handle +x local Y should be 0 relative to center');
  assert.equal(handleX.z, 0, 'Handle +x local Z should be 0 relative to center');
});

test('PlayerController activates SelectionAxisGizmo on entity block selection and expands with expandEntitySelectionAxis', () => {
  const scene = new THREE.Scene();
  const world = makeStubWorld();
  const renderer = makeStubSceneRenderer();

  const group = new THREE.Group();
  group.position.set(5, 0, 5);
  group.updateMatrixWorld(true);

  let highlightedBlocks: any[] = [];
  const stubContraption: any = {
    id: 1,
    scriptStatus: 'stopped',
    serverManaged: false,
    entityNodes: new Map([
      ['arm', { id: 'arm', group, pivotLocal: new THREE.Vector3() }]
    ]),
    blocks: [
      { localX: 0, localY: 0, localZ: 0, size: 1, entityId: 'arm' },
      { localX: 1, localY: 0, localZ: 0, size: 1, entityId: 'arm' },
      { localX: 2, localY: 0, localZ: 0, size: 1, entityId: 'arm' }
    ],
    clearSubtreeHighlight() { highlightedBlocks = []; },
    highlightBlocks(blocks: any[]) { highlightedBlocks = blocks; }
  };

  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectorMicroMode = false;
  controller.contraptions = { getSelectionBounds: () => null, getMicroSelectionBounds: () => null };
  controller.sceneRenderer = renderer;
  controller.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  controller.camera.position.set(0, 10, 20);
  controller.camera.lookAt(0, 0, 0);
  controller.sound = { playWrenchClick() {} };
  controller.ui = { showToast() {} };

  // Select first block only
  controller.selectedBlockSelection = {
    contraption: stubContraption,
    nodeId: 'arm',
    blocks: [stubContraption.blocks[0]],
    bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 }
  };

  controller.updateSelectionAxisGizmo();
  assert.equal(renderer.selectionAxisGizmo.visible, true);

  // Expand along +X by 1 step -> should now capture blocks 0 and 1
  let res = controller.expandEntitySelectionAxis('x', 1, 1, false);
  assert.equal(res.ok, true);
  assert.equal(res.count, 2);
  assert.equal(controller.selectedBlockSelection.blocks.length, 2);
  assert.equal(highlightedBlocks.length, 2);

  // Expand along +X by 1 more step -> should now capture all 3 blocks
  res = controller.expandEntitySelectionAxis('x', 1, 1, false);
  assert.equal(res.ok, true);
  assert.equal(res.count, 3);
  assert.equal(controller.selectedBlockSelection.blocks.length, 3);

  // Shrink along +X by 1 step -> back to 2 blocks
  res = controller.expandEntitySelectionAxis('x', 1, -1, false);
  assert.equal(res.ok, true);
  assert.equal(res.count, 2);
  assert.equal(controller.selectedBlockSelection.blocks.length, 2);
});

test('PlayerController activates SelectionAxisGizmo on selectedSubtree and expands via gizmo drag', () => {
  const scene = new THREE.Scene();
  const world = makeStubWorld();
  const renderer = makeStubSceneRenderer();

  const group = new THREE.Group();
  group.position.set(0, 0, 0);
  group.updateMatrixWorld(true);

  let highlightedBlocks: any[] = [];
  const stubContraption: any = {
    id: 1,
    scriptStatus: 'stopped',
    serverManaged: false,
    entityNodes: new Map([
      ['componentA', { id: 'componentA', group, pivotLocal: new THREE.Vector3() }]
    ]),
    blocks: [
      { localX: 0, localY: 0, localZ: 0, size: 1, entityId: 'componentA' },
      { localX: 1, localY: 0, localZ: 0, size: 1, entityId: 'componentA' }
    ],
    clearSubtreeHighlight() { highlightedBlocks = []; },
    highlightBlocks(blocks: any[]) { highlightedBlocks = blocks; }
  };

  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectorMicroMode = false;
  controller.contraptions = { getSelectionBounds: () => null, getMicroSelectionBounds: () => null };
  controller.sceneRenderer = renderer;
  controller.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  controller.camera.position.set(0, 0, 10);
  controller.camera.lookAt(0, 0, 0);
  controller.isLocked = true;
  controller.sound = { playWrenchClick() {} };
  controller.ui = { showToast() {} };

  controller.selectedSubtree = {
    contraption: stubContraption,
    rootId: 'componentA',
    nodeIds: new Set(['componentA'])
  };

  controller.updateSelectionAxisGizmo();
  assert.equal(renderer.selectionAxisGizmo.visible, true);

  // Start gizmo drag on +X handle
  controller.startGizmoDrag({ handleKey: '+x', axis: 'x', direction: 1 });
  assert.equal(controller.activeGizmoDrag.isEntity, true);

  // Move mouse in +X direction
  const event = { movementX: 32, movementY: 0 } as any;
  controller.updateGizmoDrag(event);

  // Selected subtree was converted to selectedBlockSelection and expanded
  assert.ok(controller.selectedBlockSelection);
  assert.equal(controller.selectedBlockSelection.bounds.maxX, 3);
});

test('PlayerController supports cylinder selection mode on sub-components with rotation and gizmo expansion', () => {
  const scene = new THREE.Scene();
  const renderer = makeStubSceneRenderer();

  const group = new THREE.Group();
  group.position.set(10, 5, 10);
  group.updateMatrixWorld(true);

  // Construct a 3x3x3 block cluster on componentB
  const blocks: any[] = [];
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 3; y++) {
      for (let z = 0; z < 3; z++) {
        blocks.push({ localX: x, localY: y, localZ: z, size: 1, entityId: 'componentB' });
      }
    }
  }

  let highlightedBlocks: any[] = [];
  const stubContraption: any = {
    id: 2,
    scriptStatus: 'stopped',
    serverManaged: false,
    entityNodes: new Map([
      ['componentB', { id: 'componentB', group, pivotLocal: new THREE.Vector3() }]
    ]),
    blocks,
    clearSubtreeHighlight() { highlightedBlocks = []; },
    highlightBlocks(b: any[]) { highlightedBlocks = b; }
  };

  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectorMicroMode = false;
  controller.selectorShape = 'cylinder';
  controller.contraptions = { getSelectionBounds: () => null, getMicroSelectionBounds: () => null };
  controller.sceneRenderer = renderer;
  controller.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  controller.camera.position.set(0, 0, 10);
  controller.camera.lookAt(0, 0, 0);
  controller.sound = { playWrenchClick() {} };
  controller.ui = { showToast() {}, setSelectorShape() {}, updateToolPanelMode() {} };

  // Set initial selectedBlockSelection (box containing all 27 blocks)
  controller.selectedBlockSelection = {
    contraption: stubContraption,
    nodeId: 'componentB',
    confirmedRange: { pointA: { x: 0, y: 0, z: 0 }, pointB: { x: 2, y: 2, z: 2 } },
    blocks: [...blocks],
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 }
  };

  // 1. Apply cylinder shape (vertical Y axis by default)
  controller.applyEntitySelectionShape('cylinder');
  assert.ok(controller.selectedBlockSelection.shapeCells);
  assert.ok(controller.selectedBlockSelection.shapeCells.length > 0);
  // Cylinder inscribed in 3x3x3 excludes outer corner columns (0,0), (0,2), (2,0), (2,2)
  // Total cylinder blocks should be less than 27 (typically 5 cells per slice * 3 slices = 15 or 21)
  assert.ok(controller.selectedBlockSelection.blocks.length < 27);
  assert.ok(controller.selectedBlockSelection.blocks.length > 0);
  assert.equal(highlightedBlocks.length, controller.selectedBlockSelection.blocks.length);

  // Verify corner blocks are excluded by cylinder shape
  const hasCorner = controller.selectedBlockSelection.blocks.some(
    (b: any) => b.localX === 0 && b.localZ === 0
  );
  assert.equal(hasCorner, false, 'Corner block (0, y, 0) should be excluded in 3x3 cylinder');

  // Verify center block is included
  const hasCenter = controller.selectedBlockSelection.blocks.some(
    (b: any) => b.localX === 1 && b.localY === 1 && b.localZ === 1
  );
  assert.equal(hasCenter, true, 'Center block (1, 1, 1) should be included in cylinder');

  // 2. Test cylinder axis rotation on entity
  controller.rotateSelection('cw', 'x');
  assert.equal(controller.selectionShapeAnchor?.cylinderAxis, 'z');
  assert.ok(controller.selectedBlockSelection.shapeCells.length > 0);

  // 3. Test expanding cylinder via expandEntitySelectionAxis
  const initialCount = controller.selectedBlockSelection.blocks.length;
  const res = controller.expandEntitySelectionAxis('x', 1, 1, false);
  assert.equal(res.ok, true);
  assert.equal(controller.selectedBlockSelection.bounds.maxX, 3);
  assert.ok(controller.selectedBlockSelection.shapeCells.length > 0);
  assert.ok(controller.selectedBlockSelection.blocks.length >= initialCount);
});

test('Alt+1..9 shortcuts switch shape in Selector and pick color in Shovel/Spoon', () => {
  const controller: any = Object.create(PlayerController.prototype);
  controller.keys = {};
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectorShape = 'box';
  controller.setSelectorShape = (shape: string) => { controller.selectorShape = shape; };
  let chosenColorIndex = -1;
  controller.ui = {
    selectPresetColor: (idx: number) => { chosenColorIndex = idx; },
    selectInventorySlot: () => {}
  };
  controller.setSelectedColor = (c: number) => { controller.selectedColor = c; };

  // 1. Selector tool: Alt+2 switches to cylinder, Alt+3 switches to sphere
  const eventAlt2 = { altKey: true, code: 'Digit2', preventDefault() {} };
  PlayerController.prototype.handleKeyDown.call(controller, eventAlt2 as any);
  assert.equal(controller.selectorShape, 'cylinder');

  const eventAlt3 = { altKey: true, code: 'Digit3', preventDefault() {} };
  PlayerController.prototype.handleKeyDown.call(controller, eventAlt3 as any);
  assert.equal(controller.selectorShape, 'sphere');

  // 2. Shovel tool: Alt+4 chooses color 3 (0-indexed)
  controller.activeTool = SpecialTool.SHOVEL;
  const eventAlt4 = { altKey: true, code: 'Digit4', preventDefault() {} };
  PlayerController.prototype.handleKeyDown.call(controller, eventAlt4 as any);
  assert.equal(chosenColorIndex, 3);

  // 3. Spoon tool: Alt+1 chooses color 0
  controller.activeTool = SpecialTool.SPOON;
  const eventAlt1 = { altKey: true, code: 'Digit1', preventDefault() {} };
  PlayerController.prototype.handleKeyDown.call(controller, eventAlt1 as any);
  assert.equal(chosenColorIndex, 0);
});

test('2-point selection validation rules between entity and world', () => {
  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectorMicroMode = false;
  controller.keys = {};
  const toasts: string[] = [];
  controller.ui = { showToast: (msg: string) => toasts.push(msg) };
  controller.sceneRenderer = makeStubSceneRenderer();

  const contraption1 = { id: 'c1', scriptStatus: 'stopped' };
  const contraption2 = { id: 'c2', scriptStatus: 'stopped' };

  // Rule A: Point 1 is world, Point 2 hits entity -> rejected
  const manager = { selectionCornerA: { x: 0, y: 0, z: 0 }, selectionCornerB: null };
  controller.contraptions = manager;
  controller.hoveredContraptionHit = { contraption: contraption1, entityId: 'root' };
  PlayerController.prototype.handleLeftClick.call(controller);
  assert.equal(manager.selectionCornerA, null, 'CornerA should be cleared');
  assert.ok(toasts.some(t => t.includes('starts in the world cannot end on an entity')));

  // Rule B: Point 1 is entity, Point 2 clicks world -> rejected
  controller.hoveredContraptionHit = null;
  controller.selectorRange = { contraption: contraption1, nodeId: 'root', pointA: { x: 0, y: 0, z: 0 }, pointB: null };
  controller.currentRaycast = { hit: true, hitPos: { x: 5, y: 5, z: 5 } };
  PlayerController.prototype.handleLeftClick.call(controller);
  assert.equal(controller.selectorRange, null, 'selectorRange should be cleared');
  assert.ok(toasts.some(t => t.includes('starts on an entity must end on that same entity')));

  // Rule C: Point 1 is entity c1, Point 2 hits entity c2 -> rejected
  controller.selectorRange = { contraption: contraption1, nodeId: 'root', pointA: { x: 0, y: 0, z: 0 }, pointB: null };
  controller.hoveredContraptionHit = { contraption: contraption2, entityId: 'root' };
  controller.selectorOnEntityClick(controller.hoveredContraptionHit, {});
  assert.ok(toasts.some(t => t.includes('start and end must belong to the same entity')));

  // Rule D: Point 1 and Point 2 on different components of c1 -> rejected
  controller.selectorRange = { contraption: contraption1, nodeId: 'compA', pointA: { x: 0, y: 0, z: 0 }, pointB: null };
  controller.hoveredContraptionHit = { contraption: contraption1, entityId: 'compB' };
  controller.selectorOnEntityClick(controller.hoveredContraptionHit, {});
  assert.ok(toasts.some(t => t.includes('same hierarchy level and share one parent component')));
});

test('2-point selection validation: child component blocks and full parent component selection', () => {
  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectorMicroMode = false;
  controller.selectorShape = 'box';
  const toasts: string[] = [];
  controller.ui = { showToast: (msg: string) => toasts.push(msg) };
  controller.sceneRenderer = makeStubSceneRenderer();

  const contraption = {
    id: 'c1',
    rootComponentId: 'root',
    scriptStatus: 'stopped',
    entityNodes: new Map([['root', { id: 'root', parentId: null }]]),
    blocks: [
      { localX: 0, localY: 0, localZ: 0, entityId: 'root' },
      { localX: 1, localY: 0, localZ: 0, entityId: 'root' },
      { localX: 2, localY: 0, localZ: 0, entityId: 'childA' } // Child component block
    ],
    clearSubtreeHighlight() {}
  };

  // Case 1: selection includes child component blocks -> rejected
  controller.performBasicAction = () => ({
    ok: true,
    selection: { blocks: contraption.blocks },
    components: ['root', 'childA']
  });
  controller.resolveBlockRangeSelection({
    contraption,
    nodeId: 'root',
    pointA: { x: 0, y: 0, z: 0 },
    pointB: { x: 2, y: 0, z: 0 }
  });
  assert.equal(controller.selectedBlockSelection, null);
  assert.ok(toasts.some(t => t.includes('cannot include blocks assigned to child components')));

  // Case 2: selection selects ALL blocks of parent component -> rejected when creating child (G)
  controller.performBasicAction = () => ({
    ok: true,
    selection: {
      blocks: [
        { localX: 0, localY: 0, localZ: 0, entityId: 'root' },
        { localX: 1, localY: 0, localZ: 0, entityId: 'root' }
      ]
    },
    components: ['root']
  });
  controller.resolveBlockRangeSelection({
    contraption,
    nodeId: 'root',
    pointA: { x: 0, y: 0, z: 0 },
    pointB: { x: 1, y: 0, z: 0 }
  });
  assert.ok(controller.selectedBlockSelection);
  const childResult = controller.createChildFromSelectedBlocks();
  assert.equal(childResult, null);
  assert.ok(toasts.some(t => t.includes('entire parent component cannot be selected')));
});

test('F key expands entity component by filling selection with blocks', () => {
  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectorMicroMode = false;
  controller.selectedColor = 0xff0000;
  controller.contraptions = { hasValidSelection: () => false };
  const toasts: string[] = [];
  controller.ui = { showToast: (msg: string) => toasts.push(msg), notifyContraptionStructureChanged() {} };
  controller.sound = { playBlockPlace() {} };
  controller.sceneRenderer = makeStubSceneRenderer();

  let rebuilt = false;
  const contraption: any = {
    id: 'c1',
    scriptStatus: 'stopped',
    rootComponentId: 'compA',
    entityNodes: new Map([['compA', { id: 'compA', parentId: null }]]),
    blocks: [
      { localX: 0, localY: 0, localZ: 0, entityId: 'compA', color: 0x111111 }
    ],
    rebuildAfterBlockChange: () => { rebuilt = true; },
    clearSubtreeHighlight: () => {}
  };

  // Selection spans 2x1x1 (x: 0..1, y: 0, z: 0)
  controller.selectedBlockSelection = {
    contraption,
    nodeId: 'compA',
    blocks: [contraption.blocks[0]],
    confirmedRange: { pointA: { x: 0, y: 0, z: 0 }, pointB: { x: 1, y: 0, z: 0 } },
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 0 }
  };

  controller.fillSelectionBlocks();

  assert.equal(rebuilt, true);
  // Total blocks should now be 2: original recolored to 0xff0000 + newly placed block at (1, 0, 0)
  assert.equal(contraption.blocks.length, 2);
  assert.equal(contraption.blocks[0].color, 0xff0000);
  assert.equal(contraption.blocks[1].localX, 1);
  assert.equal(contraption.blocks[1].color, 0xff0000);
  assert.equal(contraption.blocks[1].entityId, 'compA');
  assert.equal(controller.selectedBlockSelection, null);
});

test('Del key cascades deletion of child component and subcomponents when all blocks are removed', () => {
  const controller: any = Object.create(PlayerController.prototype);
  controller.contraptions = { removeContraption: () => {} };
  const toasts: string[] = [];
  controller.ui = { showToast: (msg: string) => toasts.push(msg), notifyContraptionStructureChanged() {} };
  controller.sound = { playBlockBreak() {} };

  let removedSubtreeId: string | null = null;
  const blockToDel = { localX: 0, localY: 0, localZ: 0, entityId: 'childComponent' };
  const contraption: any = {
    id: 'c1',
    rootComponentId: 'root',
    scriptStatus: 'stopped',
    blocks: [
      { localX: 10, localY: 10, localZ: 10, entityId: 'root' },
      blockToDel
    ],
    clearSubtreeHighlight() {},
    removeComponentSubtree: (id: string) => { removedSubtreeId = id; }
  };

  controller.selectedBlockSelection = {
    contraption,
    nodeId: 'childComponent',
    blocks: [blockToDel],
    confirmedRange: { pointA: { x: 0, y: 0, z: 0 }, pointB: { x: 0.9, y: 0.9, z: 0.9 } }
  };

  // Mock performBasicAction delete which removes blockToDel from contraption.blocks
  controller.performBasicAction = () => {
    contraption.blocks = contraption.blocks.filter((b: any) => b !== blockToDel);
    return { ok: true, removed: 1 };
  };

  controller.deleteSelectionBlocks();

  // Child component had 1 block, now 0 blocks -> removeComponentSubtree('childComponent') called!
  assert.equal(removedSubtreeId, 'childComponent');
  assert.ok(toasts.some(t => t.includes('Component [childComponent] and all its subcomponents deleted')));
});

test('the XYZ gizmo stays hidden until the entity box has both points', () => {
  const scene = new THREE.Scene();
  const renderer = makeStubSceneRenderer();
  const manager: any = new ContraptionManager(scene, {}, null, null);
  const contraption = new Contraption(
    1,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: 1, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  contraption.stopAllNodeScripts();
  manager.contraptions.push(contraption);

  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectorMicroMode = false;
  controller.selectorShape = 'box';
  controller.selectedSubtree = null;
  controller.selectedBlockSelection = null;
  controller.selectorLevel = null;
  controller.selectorRange = null;
  controller.selectionShapeAnchor = null;
  controller.bulkEditJob = null;
  controller.keys = {};
  controller.contraptions = manager;
  controller.sceneRenderer = renderer;
  controller.sound = { playBlockBreak() {}, playBlockPlace() {}, playWrenchClick() {} };
  controller.ui = { showToast() {} };

  contraption.rootGroup.updateMatrixWorld(true);
  const rootBlock = contraption.blocks[0];
  const center = contraption.getBlockWorldCenter(rootBlock);
  const hit = (offset: THREE.Vector3) => ({
    contraption,
    entityId: 'root',
    block: rootBlock,
    cell: { x: 0, y: 0, z: 0 },
    point: center.clone().add(offset)
  });

  // Point 1: the selection is not complete, so the whole-entity XYZ gizmo must stay hidden.
  controller.hoveredContraptionHit = hit(new THREE.Vector3(-0.4, 0.5, -0.4));
  controller.handleLeftClick();
  assert.ok(controller.selectorRange?.pointA, 'point 1 is set');
  assert.equal(renderer.selectionAxisGizmo.visible, false, 'no XYZ gizmo while only point 1 is set');

  // Point 2 completes the box; now the gizmo is useful.
  controller.hoveredContraptionHit = hit(new THREE.Vector3(0.4, 0.5, 0.4));
  controller.handleLeftClick();
  assert.ok(controller.selectedBlockSelection, 'the box completes on the second click');
  assert.equal(renderer.selectionAxisGizmo.visible, true, 'the XYZ gizmo appears once the box is complete');
});

test('selection gizmo handles are pickable in bent space where they are drawn', () => {
  const renderer = makeStubSceneRenderer();
  renderer.updateSelectionAxisGizmo({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }, false, null);
  assert.equal(renderer.selectionAxisGizmo.visible, true);

  const handle = renderer.selectionGizmoHandles.get('+x');
  handle.updateMatrixWorld(true);
  const pick = handle.children.find(child => String(child.name).startsWith('SelectionGizmoPick_'));
  const flatCenter = pick.getWorldPosition(new THREE.Vector3());

  // Aim a BENT ray at the handle's BENT centre, exactly like the renderer draws it.
  const originFlat = flatCenter.clone().add(new THREE.Vector3(4, 0.3, 0));
  const originBent = bendPoint(originFlat.x, originFlat.y, originFlat.z, new THREE.Vector3());
  const bentCenter = bendPoint(flatCenter.x, flatCenter.y, flatCenter.z, new THREE.Vector3());
  const directionBent = bentCenter.clone().sub(originBent).normalize();
  const hit = renderer.raycastSelectionGizmoBent(originBent, directionBent);

  assert.ok(hit, 'the bent ray must hit the handle where it is drawn');
  assert.equal(hit.handleKey, '+x');
  assert.ok(hit.distance > 3 && hit.distance < 5);

  // A ray pointing away must miss.
  assert.equal(renderer.raycastSelectionGizmoBent(originBent, new THREE.Vector3(0, 1, 0)), null);
});
