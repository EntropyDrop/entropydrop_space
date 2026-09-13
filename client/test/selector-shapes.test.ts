import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { computeSelectionCells, bresenham3D } from '../src/engine/controls/SelectorShapes.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';

function createController(overrides: any = {}) {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const manager = new ContraptionManager(scene, world, null, null) as any;
  const controller: any = Object.create(PlayerController.prototype);
  controller._activeTool = SpecialTool.SELECTOR;
  Object.defineProperty(controller, 'activeTool', {
    get() { return this._activeTool; },
    set(v) { this._activeTool = v; }
  });
  controller.selectedSubtree = null;
  controller.selectedBlockSelection = null;
  controller.selectorLevel = null;
  controller.selectorRange = null;
  controller.boxSelectionPreview = null;
  controller.focusBlockPreview = null;
  controller.selectorMicroMode = false;
  controller.selectorShape = 'box';
  controller.selectionShapeAnchor = null;
  controller.selectedColor = 0xff3b30;
  controller.inventorySlots = new Array(9).fill(null);
  controller.selectedInventoryIndex = 0;
  controller.contraptions = manager;
  controller.world = world;
  controller.keys = {};
  controller.entityInputDown = new Set();
  controller.entityInputPressed = new Set();
  controller.entityInputReleased = new Set();
  controller.physics = { isSprinting: false };
  controller.sound = { playBlockBreak() {}, playBlockPlace() {}, playWrenchClick() {}, playAssemblyClack() {} };
  controller.particles = { emitBlockBreak() {} };
  manager.selectionHost = controller;

  const toasts: string[] = [];
  controller.ui = {
    showToast: (m: string) => toasts.push(m),
    renderInventoryBar() {},
    updateToolPanelMode() {},
    renderHotbar() {},
    selectPresetColor() {},
    selectInventorySlot() {},
    notifyContraptionStructureChanged() {}
  };
  Object.assign(controller, overrides);
  return { controller, manager, world, scene, toasts };
}

test('computeSelectionCells: box generates exact 3D AABB grid', () => {
  const cells = computeSelectionCells('box', { x: 0, y: 0, z: 0 }, { x: 2, y: 1, z: 2 });
  assert.equal(cells.length, 3 * 2 * 3); // 18 voxels
  const keys = new Set(cells.map(c => `${c.x},${c.y},${c.z}`));
  assert.equal(keys.has('0,0,0'), true);
  assert.equal(keys.has('2,1,2'), true);
  assert.equal(keys.has('1,1,1'), true);
});

test('computeSelectionCells: cylinder excludes corners and includes center', () => {
  // 5x3x5 box: center is at (2, y, 2)
  const cells = computeSelectionCells('cylinder', { x: 0, y: 0, z: 0 }, { x: 4, y: 2, z: 4 });
  const keys = new Set(cells.map(c => `${c.x},${c.y},${c.z}`));

  // Center column must be included
  assert.equal(keys.has('2,0,2'), true);
  assert.equal(keys.has('2,1,2'), true);
  assert.equal(keys.has('2,2,2'), true);

  // Outer corners of the 5x5 bounding box must be excluded
  assert.equal(keys.has('0,0,0'), false);
  assert.equal(keys.has('4,0,0'), false);
  assert.equal(keys.has('0,0,4'), false);
  assert.equal(keys.has('4,0,4'), false);

  // Mid-edges must be included
  assert.equal(keys.has('2,0,0'), true);
  assert.equal(keys.has('2,0,4'), true);
  assert.equal(keys.has('0,0,2'), true);
  assert.equal(keys.has('4,0,2'), true);
});

test('computeSelectionCells: sphere excludes corners and cap edges', () => {
  // 5x5x5 box: center is at (2, 2, 2)
  const cells = computeSelectionCells('sphere', { x: 0, y: 0, z: 0 }, { x: 4, y: 4, z: 4 });
  const keys = new Set(cells.map(c => `${c.x},${c.y},${c.z}`));

  // Center must be included
  assert.equal(keys.has('2,2,2'), true);

  // Extreme corners must be excluded
  assert.equal(keys.has('0,0,0'), false);
  assert.equal(keys.has('4,4,4'), false);

  // Mid-faces must be included
  assert.equal(keys.has('2,2,0'), true);
  assert.equal(keys.has('2,2,4'), true);
  assert.equal(keys.has('2,0,2'), true);
  assert.equal(keys.has('2,4,2'), true);
});

test('computeSelectionCells: stairs ascend along dominant horizontal axis', () => {
  // X-dominant stairs from (0, 0, 0) to (3, 3, 1): W=4, H=4, D=2
  const cellsX = computeSelectionCells('stairs', { x: 0, y: 0, z: 0 }, { x: 3, y: 3, z: 1 });
  const keysX = new Set(cellsX.map(c => `${c.x},${c.y},${c.z}`));

  // Step at x=0 has height 1 (y=0 only)
  assert.equal(keysX.has('0,0,0'), true);
  assert.equal(keysX.has('0,1,0'), false);

  // Step at x=3 has height 4 (y=0, 1, 2, 3)
  assert.equal(keysX.has('3,0,0'), true);
  assert.equal(keysX.has('3,1,0'), true);
  assert.equal(keysX.has('3,2,0'), true);
  assert.equal(keysX.has('3,3,0'), true);

  // Z-dominant stairs from (0, 0, 0) to (1, 3, 3): D=4, H=4, W=2
  const cellsZ = computeSelectionCells('stairs', { x: 0, y: 0, z: 0 }, { x: 1, y: 3, z: 3 });
  const keysZ = new Set(cellsZ.map(c => `${c.x},${c.y},${c.z}`));

  // Step at z=0 has height 1
  assert.equal(keysZ.has('0,0,0'), true);
  assert.equal(keysZ.has('0,1,0'), false);

  // Step at z=3 has height 4
  assert.equal(keysZ.has('0,3,3'), true);
});

test('computeSelectionCells: line uses 3D Bresenham algorithm', () => {
  const line = computeSelectionCells('line', { x: 0, y: 0, z: 0 }, { x: 3, y: 3, z: 0 });
  assert.equal(line.length, 4);
  assert.deepEqual(line, [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 1, z: 0 },
    { x: 2, y: 2, z: 0 },
    { x: 3, y: 3, z: 0 }
  ]);
});

test('PlayerController: Shift + 1~5 switches selector shapes', () => {
  const { controller } = createController();
  assert.equal(controller.selectorShape, 'box');

  // Shift + Digit2 -> cylinder
  controller.handleKeyDown({ code: 'Digit2', shiftKey: true, preventDefault() {} });
  assert.equal(controller.selectorShape, 'cylinder');

  // Shift + Digit3 -> sphere
  controller.handleKeyDown({ code: 'Digit3', shiftKey: true, preventDefault() {} });
  assert.equal(controller.selectorShape, 'sphere');

  // Shift + Digit4 -> stairs
  controller.handleKeyDown({ code: 'Digit4', shiftKey: true, preventDefault() {} });
  assert.equal(controller.selectorShape, 'stairs');

  // Shift + Digit5 -> line
  controller.handleKeyDown({ code: 'Digit5', shiftKey: true, preventDefault() {} });
  assert.equal(controller.selectorShape, 'line');

  // Shift + Digit1 -> box
  controller.handleKeyDown({ code: 'Digit1', shiftKey: true, preventDefault() {} });
  assert.equal(controller.selectorShape, 'box');
});

test('PlayerController: switching shapes updates connectedSelection and preserves box anchor', () => {
  const { controller, manager } = createController();

  // Set up a 5x3x5 selection box from (0, 0, 0) to (4, 2, 4)
  manager.setCornerA({ x: 0, y: 0, z: 0 });
  manager.setCornerB({ x: 4, y: 2, z: 4 });
  controller.selectionShapeAnchor = {
    cornerA: { x: 0, y: 0, z: 0 },
    cornerB: { x: 4, y: 2, z: 4 },
    micro: false
  };

  assert.equal(manager.connectedSelection, null, 'box shape has null connectedSelection');
  assert.deepEqual(manager.getSelectionBounds(), { minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 2, maxZ: 4 });

  // Switch to cylinder
  controller.setSelectorShape('cylinder');
  assert.notEqual(manager.connectedSelection, null, 'cylinder populates connectedSelection');
  assert.ok(manager.connectedSelection.length < 5 * 3 * 5, 'cylinder has fewer cells than full AABB');

  // Corners must NOT be present in cylinder
  const cylKeys = new Set(manager.connectedSelection.map((c: any) => `${c.x},${c.y},${c.z}`));
  assert.equal(cylKeys.has('0,0,0'), false);
  assert.equal(cylKeys.has('2,1,2'), true);

  // Switch to sphere
  controller.setSelectorShape('sphere');
  assert.notEqual(manager.connectedSelection, null);
  const sphereKeys = new Set(manager.connectedSelection.map((c: any) => `${c.x},${c.y},${c.z}`));
  assert.equal(sphereKeys.has('0,0,0'), false);
  assert.equal(sphereKeys.has('2,1,2'), true);

  // Switch back to box
  controller.setSelectorShape('box');
  assert.equal(manager.connectedSelection, null, 'reverting to box restores connectedSelection = null');
  assert.deepEqual(manager.getSelectionBounds(), { minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 2, maxZ: 4 });
});

test('PlayerController: fillSelectionBlocks and paintSelectionBlocks respect active shape', () => {
  const { controller, manager, world } = createController();

  // Selection from (0, 30, 0) to (4, 30, 4) (5x1x5 in air)
  manager.setCornerA({ x: 0, y: 30, z: 0 });
  manager.setCornerB({ x: 4, y: 30, z: 4 });
  controller.selectionShapeAnchor = {
    cornerA: { x: 0, y: 30, z: 0 },
    cornerB: { x: 4, y: 30, z: 4 },
    micro: false
  };

  // Switch to cylinder
  controller.setSelectorShape('cylinder');

  // Fill with 0x48dbfb
  controller.fillSelectionBlocks(0x48dbfb);

  // Center (2, 30, 2) must be filled
  assert.equal(world.getBlock(2, 30, 2), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlockColor(2, 30, 2), 0x48dbfb);

  // Corner (0, 30, 0) must remain AIR because cylinder excludes corners!
  assert.equal(world.getBlock(0, 30, 0), BlockTypes.AIR);
  assert.equal(world.getBlock(4, 30, 4), BlockTypes.AIR);

  // Now recolor/paint with 0xff5500
  controller.paintSelectionBlocks(0xff5500);

  // Center should be recolored
  assert.equal(world.getBlockColor(2, 30, 2), 0xff5500);
  // Corner remains AIR
  assert.equal(world.getBlock(0, 30, 0), BlockTypes.AIR);

  // Now delete selection
  controller.deleteSelectionBlocks();
  assert.equal(world.getBlock(2, 30, 2), BlockTypes.AIR);
});

test('PlayerController: micro mode shape switching sets microSelection and clears microBounds', () => {
  const { controller, manager } = createController({ selectorMicroMode: true });

  // Anchor micro selection: 5x3x5 microcells from (10, 40, 10) to (14, 42, 14)
  controller.selectionShapeAnchor = {
    cornerA: { x: 10, y: 40, z: 10 },
    cornerB: { x: 14, y: 42, z: 14 },
    micro: true
  };
  manager.microBounds = { minX: 10, minY: 40, minZ: 10, maxX: 14, maxY: 42, maxZ: 14 };

  // Switch to cylinder in micro mode
  controller.setSelectorShape('cylinder');
  assert.equal(manager.microBounds, null, 'non-box micro shape must clear microBounds');
  assert.ok(Array.isArray(manager.microSelection), 'microSelection must be an array');
  assert.ok(manager.microSelection.length < 5 * 3 * 5, 'cylinder has fewer microcells than full AABB');

  // Verify cylinder geometry in microcells
  const cylKeys = new Set(manager.microSelection.map((c: any) => `${c.x},${c.y},${c.z}`));
  assert.equal(cylKeys.has('12,41,12'), true, 'center microcell is inside cylinder');
  assert.equal(cylKeys.has('10,40,10'), false, 'corner microcell is excluded from cylinder');
  assert.equal(cylKeys.has('14,40,14'), false, 'corner microcell is excluded from cylinder');

  // getMicroSelectionBounds still resolves the outer extent
  const bounds = manager.getMicroSelectionBounds();
  assert.deepEqual(bounds, { minX: 10, minY: 40, minZ: 10, maxX: 14, maxY: 42, maxZ: 14 });

  // Switch to sphere in micro mode
  controller.setSelectorShape('sphere');
  assert.equal(manager.microBounds, null);
  const sphereKeys = new Set(manager.microSelection.map((c: any) => `${c.x},${c.y},${c.z}`));
  assert.equal(sphereKeys.has('12,41,12'), true);
  assert.equal(sphereKeys.has('10,40,10'), false);

  // Switch to stairs in micro mode
  controller.setSelectorShape('stairs');
  assert.equal(manager.microBounds, null);
  assert.ok(manager.microSelection.length > 0);

  // Switch to line in micro mode
  controller.setSelectorShape('line');
  assert.equal(manager.microBounds, null);
  assert.ok(manager.microSelection.length > 0);

  // Switch back to box in micro mode restores microBounds
  controller.setSelectorShape('box');
  assert.notEqual(manager.microBounds, null, 'box in micro mode restores microBounds');
  assert.deepEqual(manager.microBounds, { minX: 10, minY: 40, minZ: 10, maxX: 14, maxY: 42, maxZ: 14 });
});

test('PlayerController: micro mode fill, paint, delete respect active shape', () => {
  const { controller, manager, world } = createController({ selectorMicroMode: true });

  // 5x1x5 microcells at y=80: (10, 80, 10) to (14, 80, 14)
  controller.selectionShapeAnchor = {
    cornerA: { x: 10, y: 80, z: 10 },
    cornerB: { x: 14, y: 80, z: 14 },
    micro: true
  };

  // Switch to cylinder in micro mode
  controller.setSelectorShape('cylinder');
  assert.equal(manager.microBounds, null);

  // Fill with color 0x48dbfb
  controller.fillSelectionBlocks(0x48dbfb);

  // Center microcell (12, 80, 12) must exist and have color 0x48dbfb
  const centerMicro = world.getMicroBlock(12, 80, 12);
  assert.notEqual(centerMicro, null, 'center microcell should be placed');
  assert.equal(centerMicro.color, 0x48dbfb);

  // Corner microcell (10, 80, 10) must NOT exist because cylinder excludes corners
  assert.equal(world.getMicroBlock(10, 80, 10), null, 'corner microcell should not be placed');
  assert.equal(world.getMicroBlock(14, 80, 14), null, 'corner microcell should not be placed');

  // Recolor with 0xff9f43
  controller.paintSelectionBlocks(0xff9f43);
  const recoloredMicro = world.getMicroBlock(12, 80, 12);
  assert.notEqual(recoloredMicro, null);
  assert.equal(recoloredMicro.color, 0xff9f43);
  assert.equal(world.getMicroBlock(10, 80, 10), null);

  // Delete micro selection
  controller.deleteSelectionBlocks();
  assert.equal(world.getMicroBlock(12, 80, 12), null, 'center microcell should be deleted');
});

test('PlayerController: ArrowLeft and ArrowRight rotate selection horizontally (yaw)', () => {
  const { controller, manager } = createController();

  // Set up a 5x2x3 selection box from (0, 0, 0) to (4, 1, 2)
  manager.setCornerA({ x: 0, y: 0, z: 0 });
  manager.setCornerB({ x: 4, y: 1, z: 2 });
  controller.selectionShapeAnchor = {
    cornerA: { x: 0, y: 0, z: 0 },
    cornerB: { x: 4, y: 1, z: 2 },
    micro: false
  };

  assert.deepEqual(manager.getSelectionBounds(), { minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 1, maxZ: 2 });

  // ArrowRight: rotate 90° clockwise around Y -> size 5x2x3 becomes 3x2x5
  controller.handleKeyDown({ code: 'ArrowRight', preventDefault() {} });
  let b = manager.getSelectionBounds();
  assert.equal(b.maxX - b.minX + 1, 3, 'width is now 3');
  assert.equal(b.maxY - b.minY + 1, 2, 'height remains 2');
  assert.equal(b.maxZ - b.minZ + 1, 5, 'depth is now 5');

  // Rotate 3 more times with ArrowRight -> completes 360° back to original dimensions
  controller.handleKeyDown({ code: 'ArrowRight', preventDefault() {} });
  controller.handleKeyDown({ code: 'ArrowRight', preventDefault() {} });
  controller.handleKeyDown({ code: 'ArrowRight', preventDefault() {} });
  b = manager.getSelectionBounds();
  assert.deepEqual(b, { minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 1, maxZ: 2 }, 'four 90° rotations return to original bounds');

  // ArrowLeft: rotate 90° counter-clockwise around Y
  controller.handleKeyDown({ code: 'ArrowLeft', preventDefault() {} });
  b = manager.getSelectionBounds();
  assert.equal(b.maxX - b.minX + 1, 3);
  assert.equal(b.maxZ - b.minZ + 1, 5);
});

test('PlayerController: ArrowUp and ArrowDown rotate selection vertically (pitch)', () => {
  const { controller, manager } = createController();

  // 4x2x3 box from (0, 5, 0) to (3, 6, 2)
  manager.setCornerA({ x: 0, y: 5, z: 0 });
  manager.setCornerB({ x: 3, y: 6, z: 2 });
  controller.selectionShapeAnchor = {
    cornerA: { x: 0, y: 5, z: 0 },
    cornerB: { x: 3, y: 6, z: 2 },
    micro: false
  };

  // ArrowUp: rotate around X -> H (2) and D (3) swap -> size becomes 4x3x2
  controller.handleKeyDown({ code: 'ArrowUp', preventDefault() {} });
  let b = manager.getSelectionBounds();
  assert.equal(b.maxX - b.minX + 1, 4, 'width remains 4');
  assert.equal(b.maxY - b.minY + 1, 3, 'height is now 3');
  assert.equal(b.maxZ - b.minZ + 1, 2, 'depth is now 2');

  // ArrowDown: rotate back
  controller.handleKeyDown({ code: 'ArrowDown', preventDefault() {} });
  b = manager.getSelectionBounds();
  assert.equal(b.maxY - b.minY + 1, 2);
  assert.equal(b.maxZ - b.minZ + 1, 3);
});

test('PlayerController: Arrow keys rotate stairs orientation and update cells', () => {
  const { controller, manager } = createController();

  // 4x3x4 stairs footprint: climbing +X from (0, 0, 0) to (3, 2, 3)
  manager.setCornerA({ x: 0, y: 0, z: 0 });
  manager.setCornerB({ x: 3, y: 2, z: 3 });
  controller.setSelectorShape('stairs');

  // Initial stairs: climbing +X, so at x=0 height is 1, at x=3 height is 3
  let keys = new Set(manager.connectedSelection.map((c: any) => `${c.x},${c.y},${c.z}`));
  assert.equal(keys.has('0,0,0'), true);
  assert.equal(keys.has('0,2,0'), false, 'step 0 is low');
  assert.equal(keys.has('3,2,0'), true, 'step 3 is high');

  // ArrowRight: rotate 90° -> now climbs along +Z
  controller.handleKeyDown({ code: 'ArrowRight', preventDefault() {} });
  keys = new Set(manager.connectedSelection.map((c: any) => `${c.x},${c.y},${c.z}`));
  assert.equal(keys.has('0,2,3'), true, 'step at z=3 is high');
  assert.equal(keys.has('0,2,0'), false, 'step at z=0 is low');
});

test('PlayerController: micro mode selection rotation preserves 0.125m grid', () => {
  const { controller, manager } = createController({ selectorMicroMode: true });

  // 5x2x3 micro selection: (10, 40, 10) to (14, 41, 12)
  controller.selectionShapeAnchor = {
    cornerA: { x: 10, y: 40, z: 10 },
    cornerB: { x: 14, y: 41, z: 12 },
    micro: true
  };
  manager.microBounds = { minX: 10, minY: 40, minZ: 10, maxX: 14, maxY: 41, maxZ: 12 };
  manager.microSelection = manager.materializeMicroBox(10, 40, 10, 14, 41, 12);

  // ArrowRight: rotates 90° horizontally -> size 5x2x3 becomes 3x2x5
  controller.handleKeyDown({ code: 'ArrowRight', preventDefault() {} });
  const b = manager.getMicroSelectionBounds();
  assert.equal(b.maxX - b.minX + 1, 3);
  assert.equal(b.maxY - b.minY + 1, 2);
  assert.equal(b.maxZ - b.minZ + 1, 5);
});

test('PlayerController: cylinder rotates between Y and horizontal axes on pitch', () => {
  const { controller, manager } = createController();

  // 5x5x3 cylinder from (0, 0, 0) to (4, 4, 2)
  manager.setCornerA({ x: 0, y: 0, z: 0 });
  manager.setCornerB({ x: 4, y: 4, z: 2 });
  controller.setSelectorShape('cylinder');
  assert.equal(controller.selectionShapeAnchor.cylinderAxis, 'y');

  // Pitch Up: rotates around X axis -> Y axis cylinder becomes Z axis cylinder
  controller.handleKeyDown({ code: 'ArrowUp', preventDefault() {} });
  assert.equal(controller.selectionShapeAnchor.cylinderAxis, 'z');

  // Yaw Right: rotates around Y axis -> Z axis cylinder becomes X axis cylinder
  controller.handleKeyDown({ code: 'ArrowRight', preventDefault() {} });
  assert.equal(controller.selectionShapeAnchor.cylinderAxis, 'x');
});

test('PlayerController: stairs pitch vertically to form inverted ceiling stairs', () => {
  const { controller, manager } = createController();

  // 4x3x2 stairs from (0, 0, 0) to (3, 2, 1)
  manager.setCornerA({ x: 0, y: 0, z: 0 });
  manager.setCornerB({ x: 3, y: 2, z: 1 });
  controller.setSelectorShape('stairs');

  // Initially: at x=0, height is 1 at bottom (y=0)
  let keys = new Set(manager.connectedSelection.map((c: any) => `${c.x},${c.y},${c.z}`));
  assert.equal(keys.has('0,0,0'), true);
  assert.equal(keys.has('0,2,0'), false);

  // Pitch Up: rotates around X -> inverted ceiling stairs
  controller.handleKeyDown({ code: 'ArrowUp', preventDefault() {} });
  keys = new Set(manager.connectedSelection.map((c: any) => `${c.x},${c.y},${c.z}`));
  // Step at ceiling: y=maxY is filled
  assert.ok(keys.has('0,1,0') || keys.has('0,2,0') || keys.has('3,1,0'));
});

test('PlayerController: Super Glue tool also rotates selection with arrow keys', () => {
  const { controller, manager } = createController({ activeTool: SpecialTool.SUPER_GLUE });

  manager.setCornerA({ x: 0, y: 0, z: 0 });
  manager.setCornerB({ x: 4, y: 1, z: 2 });
  controller.selectionShapeAnchor = {
    cornerA: { x: 0, y: 0, z: 0 },
    cornerB: { x: 4, y: 1, z: 2 },
    micro: false
  };

  controller.handleKeyDown({ code: 'ArrowRight', preventDefault() {} });
  const b = manager.getSelectionBounds();
  assert.equal(b.maxX - b.minX + 1, 3);
  assert.equal(b.maxZ - b.minZ + 1, 5);
});
