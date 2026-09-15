import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption, ContraptionMode } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';

/**
 * Two-point selector boxes, entity-subtree selection, and child-component range selection.
 */

function makeEntityWithChildren() {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    1,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: 1, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: 0, localY: 1, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: 0, localY: 2, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: 2, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    {
      childEntities: [
        { id: 'arm', parentId: 'root', kind: 'child', pivot: [0.5, 0.5, 0.5], blockKeys: [['0', '1', '0']] },
        { id: 'hand', parentId: 'arm', kind: 'child', pivot: [0.5, 1.5, 0.5], blockKeys: [['0', '2', '0']] },
        { id: 'wing', parentId: 'root', kind: 'child', pivot: [1.5, 0.5, 0.5], blockKeys: [['2', '0', '0']] }
      ]
    }
  );
  contraption.stopAllNodeScripts();
  return { contraption, scene };
}

function makeSelectorController(overrides: any = {}) {
  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectedSubtree = null;
  controller.selectorRange = null;
  controller.inventorySlots = new Array(8).fill(null);
  controller.selectedInventoryIndex = 0;
  controller.contraptions = overrides.manager || null;
  controller.ui = { showToast() {}, renderInventoryBar() {} };
  controller.keys = {};
  Object.assign(controller, overrides);
  return controller;
}

/** Convert world coordinates to target-node local coordinates, matching rangePointToLocal. */
function toNodeLocal(contraption, nodeId, worldPoint) {
  const node = contraption.entityNodes.get(nodeId);
  return node.group.worldToLocal(worldPoint.clone());
}

test('first selector click selects a component and descendants without its parent', () => {
  const { contraption } = makeEntityWithChildren();
  const controller = makeSelectorController();
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'arm',
    cell: { x: 0, y: 1, z: 0 },
    point: new THREE.Vector3(0.5, 11.5, 0.5)
  };
  controller.handleLeftClick();
  assert.equal(controller.selectedSubtree.rootId, 'arm');
  assert.deepEqual([...controller.selectedSubtree.nodeIds].sort(), ['arm', 'hand'], 'selection should include arm and hand, not root or wing');
});

test('first selector click on root selects every component', () => {
  const { contraption } = makeEntityWithChildren();
  const controller = makeSelectorController();
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'root',
    cell: { x: 0, y: 0, z: 0 },
    point: new THREE.Vector3(0.5, 10.5, 0.5)
  };
  controller.handleLeftClick();
  assert.deepEqual([...controller.selectedSubtree.nodeIds].sort(), ['arm', 'hand', 'root', 'wing']);
});

test('repeat clicks reject point 2 on a different component than point 1', () => {
  const { contraption } = makeEntityWithChildren();
  const toasts: string[] = [];
  const controller = makeSelectorController();
  controller.ui = { showToast: m => toasts.push(m), renderInventoryBar() {} };

  // Point 1 on root.
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'root',
    cell: { x: 0, y: 0, z: 0 },
    point: new THREE.Vector3(-1, 10.5, -1)
  };
  controller.handleLeftClick();
  assert.ok(controller.selectorRange, 'component-level box mode should activate');
  assert.ok(controller.selectorRange.pointA, 'point 1 should be recorded');
  assert.equal(controller.selectorRange.nodeId, 'root', 'point 1 should target root');

  // Point 2 hits another node (wing), which must be rejected immediately.
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'wing',
    cell: { x: 2, y: 0, z: 0 },
    point: new THREE.Vector3(3, 13, 3)
  };
  controller.handleLeftClick();
  assert.equal(controller.selectedBlockSelection, null, 'selection across different components must be rejected');
  assert.equal(controller.selectorRange, null, 'box mode should exit after rejection');
  assert.ok(toasts.some(m => m.includes('same hierarchy level and share one parent component')), 'toast should warn about different component levels');
});

test('Shift-click switches component level without entering box mode', () => {
  const { contraption } = makeEntityWithChildren();
  const controller = makeSelectorController();

  // Select the arm subtree.
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'arm',
    cell: { x: 0, y: 1, z: 0 },
    point: new THREE.Vector3(0.5, 11.5, 0.5)
  };
  controller.handleLeftClick();

  // Shift-click hand to switch levels without entering box mode.
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'hand',
    cell: { x: 0, y: 2, z: 0 },
    point: new THREE.Vector3(0.5, 12.5, 0.5)
  };
  controller.handleLeftClick({ shiftKey: true });
  assert.equal(controller.selectedSubtree.rootId, 'hand');
  assert.deepEqual([...controller.selectedSubtree.nodeIds].sort(), ['hand']);
  assert.equal(controller.selectorRange.pointA, null, 'Shift-click should not set a box point');
});

test('ordinary clicks advance the current-level box without switching components', () => {
  const { contraption } = makeEntityWithChildren();
  const controller = makeSelectorController();

  // Click arm sets point 1 on arm.
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'arm',
    cell: { x: 0, y: 1, z: 0 },
    point: new THREE.Vector3(0.5, 11.5, 0.5)
  };
  controller.handleLeftClick();
  assert.equal(controller.selectedSubtree.rootId, 'arm');
  assert.ok(controller.selectorRange.pointA, 'the click should become box point 1');
});

test('R copies a block selection and pastes it as an independent entity', () => {
  const { contraption } = makeEntityWithChildren();
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.contraptions.push(contraption);
  const controller = makeSelectorController({ manager });

  // Select one block directly owned by arm.
  controller.selectedBlockSelection = {
    contraption,
    nodeId: 'arm',
    blocks: contraption.blocks.filter(b => (b.entityId || 'root') === 'arm'),
    confirmedRange: { pointA: { x: 0, y: 1, z: 0 }, pointB: { x: 0, y: 1, z: 0 } }
  };
  controller.copySelectionToInventory();
  const slot = controller.inventorySlots[0];
  assert.ok(slot);
  assert.equal(slot.blockCount, 1, 'the slot should contain only the arm block');

  const pasted = manager.buildFromSlot(slot, new THREE.Vector3(20, 0, 20));
  assert.ok(pasted);
  assert.equal(pasted.blocks.length, 1);
  assert.equal(pasted.rootComponentId, 'arm');
  assert.equal(pasted.blocks[0].entityId, 'arm', 'the selected component keeps its ID as the independent root');
});

test('world two-point selection builds a box from cornerA and cornerB', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const controller = makeSelectorController({ manager });
  controller.currentRaycast = { hit: true, hitPos: { x: 2, y: 3, z: 4 } };

  controller.handleLeftClick();
  assert.ok(manager.selectionCornerA, 'the first click should set cornerA');
  assert.equal(manager.selectionCornerB, null);
  assert.equal(manager.hasValidSelection(), false, 'one point should not complete the selection');

  controller.currentRaycast = { hit: true, hitPos: { x: 5, y: 6, z: 7 } };
  controller.handleLeftClick();
  assert.ok(manager.selectionCornerB, 'the second click should set cornerB');
  assert.equal(manager.hasValidSelection(), true, 'two points should form a valid selection');
  const bounds = manager.getSelectionBounds();
  assert.deepEqual(
    [bounds.minX, bounds.minY, bounds.minZ, bounds.maxX, bounds.maxY, bounds.maxZ],
    [2, 3, 4, 5, 6, 7]
  );

  const info = manager.getWorldGlueSelectionInfo();
  assert.equal(info.pointCount, 2);
  assert.equal(info.ready, true);
});

test('selector copy reports no selection and copies when a selection exists', () => {
  const { contraption } = makeEntityWithChildren();
  const toasts = [];
  const controller = makeSelectorController();
  controller.ui = { showToast: m => toasts.push(m), renderInventoryBar() {} };

  // Report no selection.
  controller.copySelectedSubtreeToInventory();
  assert.ok(toasts.some(m => m.includes('Nothing selected')));
  assert.equal(controller.inventorySlots[0], null);

  // Copy after selecting.
  controller.selectedSubtree = { contraption, rootId: 'wing', nodeIds: new Set(['wing']) };
  controller.copySelectedSubtreeToInventory();
  assert.equal(controller.inventorySlots[0], null, 'subtree alone is not confirmed');
  assert.equal(controller.selectAllSelectionBlocks(), true);
  controller.copySelectionToInventory();
  assert.ok(controller.inventorySlots[0]);
  assert.equal(controller.inventorySlots[0].blockCount, 1);
});

test('two points on one entity face select direct blocks through AABB intersection', () => {
  const { contraption } = makeEntityWithChildren();
  const controller = makeSelectorController();
  const rootBlock = contraption.blocks.find(b => (b.entityId || 'root') === 'root');
  const center = contraption.getBlockWorldCenter(rootBlock);
  const top = center.y + 0.5; // Root-block top face.

  // Both points lie on the same top face, creating a zero-thickness Y range.
  // Point 1:
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'root',
    cell: { x: 0, y: 0, z: 0 },
    point: new THREE.Vector3(center.x - 0.5, top, center.z)
  };
  controller.handleLeftClick();
  assert.ok(controller.selectorRange.pointA);

  // Point 2:
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'root',
    cell: { x: 0, y: 0, z: 0 },
    point: new THREE.Vector3(center.x + 0.5, top, center.z)
  };
  controller.handleLeftClick();
  assert.ok(controller.selectedBlockSelection, 'a thin range must still select level blocks');
  assert.equal(controller.selectedBlockSelection.nodeId, 'root');
  assert.ok(controller.selectedBlockSelection.blocks.length >= 1, 'a root-owned block should be selected');
});

test('G creates a child component from a boxed block selection', () => {
  const { contraption } = makeEntityWithChildren();
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.contraptions.push(contraption);
  const controller = makeSelectorController({ manager });
  controller.sound = { playAssemblyClack() {} };

  const rootBlock = contraption.blocks.find(b => (b.entityId || 'root') === 'root');
  const before = contraption.blocks.filter(b => (b.entityId || 'root') === 'root').length;
  controller.selectedBlockSelection = {
    contraption,
    nodeId: 'root',
    blocks: [rootBlock],
    confirmedRange: { pointA: { x: 0, y: 0, z: 0 }, pointB: { x: 0, y: 0, z: 0 } }
  };
  controller.createChildFromSelectedBlocks();

  assert.equal(contraption.blocks.filter(b => (b.entityId || 'root') === 'root').length, before - 1, 'the block should leave root ownership');
  const childBlocks = contraption.blocks.filter(b => b.entityId !== 'root' && b !== rootBlock && b.localX === 0 && b.localY === 0 && b.localZ === 0);
  assert.equal(childBlocks.length, 0, 'the block should belong to the new child component');
  const newChild = [...contraption.entityNodes.keys()].find(id => id !== 'root' && id !== 'arm' && id !== 'hand' && id !== 'wing');
  assert.ok(newChild, 'a new child component should be created');
  assert.equal(contraption.getEntityNode(newChild).parentId, 'root', 'the child should attach to root');
  assert.equal(contraption.blocks.find(b => b.localX === 0 && b.localY === 0 && b.localZ === 0).entityId, newChild, 'the selected block should belong to the new component');
});

test('clicking after box completion starts re-boxing at the same level', () => {
  const { contraption } = makeEntityWithChildren();
  const controller = makeSelectorController();
  const rootBlock = contraption.blocks.find(b => (b.entityId || 'root') === 'root');
  const center = contraption.getBlockWorldCenter(rootBlock);
  const top = center.y + 0.5;

  // 1. Set points 1 and 2 to complete a box.
  controller.hoveredContraptionHit = {
    contraption, entityId: 'root', cell: { x: 0, y: 0, z: 0 },
    point: new THREE.Vector3(center.x - 0.5, top, center.z)
  };
  controller.handleLeftClick();
  controller.hoveredContraptionHit = {
    contraption, entityId: 'root', cell: { x: 0, y: 0, z: 0 },
    point: new THREE.Vector3(center.x + 0.5, top, center.z)
  };
  controller.handleLeftClick();
  assert.ok(controller.selectedBlockSelection, 'the first box should complete');
  assert.equal(controller.selectorRange, null, 'box mode should exit after completion');

  // 2. Click any block in preselected state -> returns to unselected.
  controller.hoveredContraptionHit = {
    contraption, entityId: 'root', cell: { x: 0, y: 0, z: 0 },
    point: new THREE.Vector3(center.x - 0.5, top, center.z)
  };
  controller.handleLeftClick();
  assert.equal(controller.selectedBlockSelection, null, 'preselection should clear and return to unselected');
  assert.equal(controller.selectorRange, null, 'should be in unselected state');

  // 3. Click again from unselected state -> starts new box point 1.
  controller.handleLeftClick();
  assert.ok(controller.selectorRange, 'new box selection should activate');
  assert.equal(controller.selectorRange.nodeId, 'root', 'root level should remain');
  assert.ok(controller.selectorRange.pointA, 'new box should set point 1 immediately');
});

test('clicking an entity after box completion waits for a new point 1', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const { contraption } = makeEntityWithChildren();
  manager.contraptions.push(contraption);
  const controller = makeSelectorController({ manager });
  const rootBlock = contraption.blocks.find(b => (b.entityId || 'root') === 'root');
  controller.selectedBlockSelection = {
    contraption,
    nodeId: 'root',
    blocks: [rootBlock]
  };
  controller.selectorLevel = { contraption, nodeId: 'root' };
  controller.selectedSubtree = null;

  // 1. Clicking any component block when preselected clears selection and returns to unselected.
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'wing',
    cell: { x: 2, y: 0, z: 0 },
    point: new THREE.Vector3(2.5, 10.5, 0.5)
  };
  controller.handleLeftClick();
  assert.equal(controller.selectedBlockSelection, null, 'the old selection should clear');
  assert.equal(controller.selectorRange, null, 'should return to unselected');

  // 2. Next click starts a new box and sets point 1 directly on wing.
  controller.handleLeftClick();
  assert.ok(controller.selectorRange, 'new box mode should activate');
  assert.equal(controller.selectorRange.nodeId, 'wing', 'level should switch to clicked component');
  assert.ok(controller.selectorRange.pointA, 'mode should set point 1 immediately');
});

test('world clicks after entity selection clear entity state and start a new world box', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const { contraption } = makeEntityWithChildren();
  manager.contraptions.push(contraption);
  const controller = makeSelectorController({ manager });
  const rootBlock = contraption.blocks.find(b => (b.entityId || 'root') === 'root');
  controller.selectedBlockSelection = { contraption, nodeId: 'root', blocks: [rootBlock],
    confirmedRange: { pointA: { x: 0, y: 0, z: 0 }, pointB: { x: 0, y: 0, z: 0 } } };
  controller.selectorLevel = { contraption, nodeId: 'root' };

  // World click 1: preselected entity selection is dismissed, returning to unselected.
  const c = contraption.getBlockWorldCenter(rootBlock);
  controller.currentRaycast = { hit: true, hitPos: { x: c.x - 0.4, y: c.y - 0.4, z: c.z - 0.4 } };
  controller.handleLeftClick();
  assert.equal(controller.selectedBlockSelection, null, 'entity selection should be cleared');
  assert.equal(controller.selectorRange, null, 'entity selection range should be cleared');

  // World click 2: starts world box (corner A).
  controller.handleLeftClick();
  assert.ok(manager.selectionCornerA, 'a world click should set world corner A');

  // World click 3: completes the world box (corner B).
  controller.currentRaycast = { hit: true, hitPos: { x: c.x + 0.4, y: c.y + 0.4, z: c.z + 0.4 } };
  controller.handleLeftClick();
  assert.ok(manager.selectionCornerB, 'the new world box should complete');
  assert.equal(manager.hasValidSelection(), true, 'world selection should be valid');
});

test('a click outside a completed world box clears selection', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const controller = makeSelectorController({ manager });
  controller.currentRaycast = { hit: true, hitPos: { x: 2, y: 3, z: 4 } };
  controller.handleLeftClick(); // Point a.
  controller.currentRaycast = { hit: true, hitPos: { x: 5, y: 6, z: 7 } };
  controller.handleLeftClick(); // Point b completes the box.
  assert.ok(manager.selectionCornerB, 'a and b should complete the box');
  assert.equal(manager.hasValidSelection(), true);

  // Point c lies outside, so clear selection without starting another box.
  controller.currentRaycast = { hit: true, hitPos: { x: 20, y: 21, z: 22 } };
  controller.handleLeftClick();
  assert.equal(manager.selectionCornerA, null, 'cornerA should clear');
  assert.equal(manager.selectionCornerB, null, 'cornerB should clear');
  assert.equal(manager.hasValidSelection(), false, 'state should return to unselected');
  const info = manager.getWorldGlueSelectionInfo();
  assert.equal(info.pointCount, 0, 'no box should remain in progress');
});

test('a second world click completes the in-progress a-c box', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const controller = makeSelectorController({ manager });
  controller.currentRaycast = { hit: true, hitPos: { x: 1, y: 1, z: 1 } };
  controller.handleLeftClick(); // Point a.
  assert.equal(manager.selectionCornerA.x, 1);

  controller.currentRaycast = { hit: true, hitPos: { x: 9, y: 9, z: 9 } };
  controller.handleLeftClick(); // Second click completes the box.
  assert.equal(manager.selectionCornerB.x, 9);
  assert.equal(manager.hasValidSelection(), true);
});

test('a root-level box over a child region is rejected with child component warning', () => {
  const { contraption } = makeEntityWithChildren();
  const toasts: string[] = [];
  const controller = makeSelectorController();
  controller.ui = { showToast: m => toasts.push(m), renderInventoryBar() {} };
  controller.selectedSubtree = { contraption, rootId: 'root', nodeIds: new Set(['root', 'arm', 'hand', 'wing']) };
  controller.selectorRange = { contraption, nodeId: 'root', pointA: null, pointB: null };

  // Cover only the hand block, excluding root-owned and arm blocks.
  const handBlock = contraption.blocks.find(b => (b.entityId || 'root') === 'hand');
  const center = contraption.getBlockWorldCenter(handBlock);
  controller.selectorRange.pointA = toNodeLocal(contraption, 'root', center.clone().add(new THREE.Vector3(-0.4, -0.4, -0.4)));
  controller.selectorRange.pointB = toNodeLocal(contraption, 'root', center.clone().add(new THREE.Vector3(0.4, 0.4, 0.4)));
  controller.resolveBlockRangeSelection(controller.selectorRange);

  assert.equal(controller.selectedBlockSelection, null, 'box covering child component should be rejected');
  assert.ok(toasts.some(m => m.includes('cannot include blocks assigned to child components')), 'toast should warn about child component');
});

test('rotated component box recognizes and selects the visible edge of a rotated component', () => {
  const { contraption } = makeEntityWithChildren();
  const controller = makeSelectorController();
  const handBlock = contraption.blocks.find(b => (b.entityId || 'root') === 'hand');

  // Rotation expands the world AABB beyond size/2.
  contraption.getChildScriptApi('hand').setLocalEuler([0, Math.PI / 4, 0]);
  contraption.rootGroup.updateMatrixWorld(true);
  const center = contraption.getBlockWorldCenter(handBlock);

  controller.selectedSubtree = {
    contraption,
    rootId: 'hand',
    nodeIds: new Set(['hand'])
  };
  controller.selectorLevel = { contraption, nodeId: 'hand' };
  controller.selectorRange = {
    contraption,
    nodeId: 'hand',
    pointA: toNodeLocal(contraption, 'hand', center.clone().add(new THREE.Vector3(0.62, -0.04, -0.04))),
    pointB: toNodeLocal(contraption, 'hand', center.clone().add(new THREE.Vector3(0.68, 0.04, 0.04)))
  };

  controller.resolveBlockRangeSelection(controller.selectorRange);

  assert.ok(controller.selectedBlockSelection, 'the rotated component block should be selected');
  assert.equal(controller.selectedBlockSelection.nodeId, 'hand');
  assert.equal(controller.selectedBlockSelection.blocks.length, 1);
});

test('a rotated child microblock uses its true 0.125 world AABB for selection', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    2,
    [
      { localX: 4, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, entityId: 'root' },
      { localX: 0, localY: 2, localZ: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK, entityId: 'tip' }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    { childEntities: [{ id: 'tip', parentId: 'root', pivot: [0.0625, 2.0625, 0.0625] }] }
  );
  contraption.stopAllNodeScripts();
  contraption.getChildScriptApi('tip').setLocalEuler([0, Math.PI / 4, 0]);
  contraption.rootGroup.updateMatrixWorld(true);

  const micro = contraption.blocks.find(b => (b.entityId || 'root') === 'tip');
  const center = contraption.getBlockWorldCenter(micro);
  const bounds = contraption.getBlockWorldBounds(micro);
  assert.ok(bounds.max.x - center.x > 0.08, 'the rotated X edge should exceed the old 0.0625 approximation');

  const controller = makeSelectorController();
  controller.selectedSubtree = { contraption, rootId: 'tip', nodeIds: new Set(['tip']) };
  controller.selectorLevel = { contraption, nodeId: 'tip' };
  controller.selectorRange = {
    contraption,
    nodeId: 'tip',
    pointA: toNodeLocal(contraption, 'tip', center.clone().add(new THREE.Vector3(0.078125, -0.02, -0.02))),
    pointB: toNodeLocal(contraption, 'tip', center.clone().add(new THREE.Vector3(0.0875, 0.02, 0.02)))
  };
  controller.resolveBlockRangeSelection(controller.selectorRange);

  assert.ok(controller.selectedBlockSelection, 'tip microblock should be selected');
  assert.equal(controller.selectedBlockSelection.nodeId, 'tip');
  assert.equal(controller.selectedBlockSelection.blocks.length, 1);
});
test('a box covering multiple direct children is rejected immediately', () => {
  const { contraption } = makeEntityWithChildren();
  const toasts: string[] = [];
  const controller = makeSelectorController();
  controller.ui = { showToast: m => toasts.push(m), renderInventoryBar() {} };
  controller.selectedSubtree = { contraption, rootId: 'root', nodeIds: new Set(['root', 'arm', 'hand', 'wing']) };
  controller.selectorRange = { contraption, nodeId: 'root', pointA: null, pointB: null };

  // Large range covers arm and hand.
  const armBlock = contraption.blocks.find(b => (b.entityId || 'root') === 'arm');
  const handBlock = contraption.blocks.find(b => (b.entityId || 'root') === 'hand');
  const c1 = contraption.getBlockWorldCenter(armBlock);
  const c2 = contraption.getBlockWorldCenter(handBlock);
  controller.selectorRange.pointA = toNodeLocal(contraption, 'root',
    new THREE.Vector3(Math.min(c1.x, c2.x) - 0.5, Math.min(c1.y, c2.y) - 0.3, -0.5)); // Avoid the root-block boundary at y=11.2.
  controller.selectorRange.pointB = toNodeLocal(contraption, 'root',
    new THREE.Vector3(Math.max(c1.x, c2.x) + 0.5, Math.max(c1.y, c2.y) + 0.5, 0.5));
  controller.resolveBlockRangeSelection(controller.selectorRange);

  assert.equal(controller.selectedBlockSelection, null, 'box selection across multiple components should be rejected');
  assert.ok(toasts.some(m => m.includes('cannot include blocks assigned to child components')), 'toast should report child component blocks error');
});

test('after G creates a child, a world click clears entity state and starts a world box', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const { contraption } = makeEntityWithChildren();
  manager.contraptions.push(contraption);
  const controller = makeSelectorController({ manager });
  controller.sound = { playAssemblyClack() {} };
  const rootBlock = contraption.blocks.find(b => (b.entityId || 'root') === 'root');

  // Box-select a root-owned block.
  controller.selectedBlockSelection = { contraption, nodeId: 'root', blocks: [rootBlock],
    confirmedRange: { pointA: { x: 0, y: 0, z: 0 }, pointB: { x: 0, y: 0, z: 0 } } };
  controller.selectorLevel = { contraption, nodeId: 'root' };
  // Create a child with G.
  controller.createChildFromSelectedBlocks();
  assert.equal(controller.selectedBlockSelection, null, 'block selection should clear after child creation');
  assert.ok(controller.selectorLevel, 'the component level should remain');

  // A world click clears entity state and starts a world box rather than getting stuck in re-boxing.
  controller.currentRaycast = { hit: true, hitPos: { x: 50, y: 60, z: 70 } };
  controller.handleLeftClick();
  assert.equal(controller.selectorLevel, null, 'entity-level state should clear');
  assert.equal(controller.selectorRange, null, 'no entity-box flow should remain');
  assert.deepEqual(manager.selectionCornerA, { x: 50, y: 60, z: 70 }, 'world-box point 1 should be set');

  // The second world click completes the box.
  controller.currentRaycast = { hit: true, hitPos: { x: 55, y: 65, z: 75 } };
  controller.handleLeftClick();
  assert.deepEqual(manager.selectionCornerB, { x: 55, y: 65, z: 75 }, 'world-box point 2 should be set');
  assert.equal(manager.hasValidSelection(), true, 'world selection should be valid for G assembly');
});

test('an entity click during an in-progress world box is rejected with toast and exits selection', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const { contraption } = makeEntityWithChildren();
  manager.contraptions.push(contraption);
  const toasts: string[] = [];
  const controller = makeSelectorController({ manager });
  controller.ui = { showToast: m => toasts.push(m), renderInventoryBar() {} };

  // First world click sets cornerA.
  controller.hoveredContraptionHit = null;
  controller.currentRaycast = { hit: true, hitPos: { x: 0, y: 10, z: 0 } };
  controller.handleLeftClick();
  assert.ok(manager.selectionCornerA, 'point 1 should be set');

  // Second click on an entity is rejected.
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'root',
    cell: { x: 2, y: 0, z: 0 },
    point: new THREE.Vector3(2.8, 12.8, 0.7)
  };
  controller.handleLeftClick();
  assert.equal(manager.selectionCornerA, null, 'selection should be cleared on invalid entity endpoint');
  assert.equal(manager.selectionCornerB, null, 'point 2 should not be set');
  assert.ok(toasts.some(m => m.includes('starts in the world cannot end on an entity')), 'toast should warn about invalid endpoint');
});

test('re-boxing anchors range points in node-local space while the component rotates', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    3,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, entityId: 'root' },
      { localX: 3, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, entityId: 'arm' },
      { localX: 3, localY: 0, localZ: 1, block: BlockTypes.COLOR_BLOCK, entityId: 'arm' }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    {
      childEntities: [
        { id: 'arm', parentId: 'root', kind: 'child', pivot: [3.5, 0.5, 1], blockKeys: [['3', '0', '0'], ['3', '0', '1']] }
      ]
    }
  );
  contraption.stopAllNodeScripts();
  const toasts: string[] = [];
  const controller = makeSelectorController({ manager: { contraptions: [contraption] } });
  controller.ui = { showToast: m => toasts.push(m), renderInventoryBar() {} };
  const click = (entityId, cell, point) => {
    controller.hoveredContraptionHit = { contraption, entityId, cell, point };
    controller.handleLeftClick();
  };
  // Arm blocks are offset from the pivot, so a Y rotation moves them visibly.
  const armBlock = contraption.blocks.find(b => (b.entityId || 'root') === 'arm' && b.localZ === 0);
  const rootBlock = contraption.blocks.find(b => (b.entityId || 'root') === 'root');
  const armCenter = contraption.getBlockWorldCenter(armBlock);
  const rootCenter = contraption.getBlockWorldCenter(rootBlock);

  // 1. Box-select an arm-owned block with 2 clicks directly.
  click('arm', { x: 3, y: 0, z: 0 }, armCenter.clone().add(new THREE.Vector3(-0.4, -0.4, -0.4)));
  click('arm', { x: 3, y: 0, z: 0 }, armCenter.clone().add(new THREE.Vector3(0.4, 0.4, 0.4)));
  assert.ok(controller.selectedBlockSelection, 'the first box should complete');
  assert.equal(controller.selectedBlockSelection.nodeId, 'arm');
  assert.equal(controller.selectorRange, null, 'box mode should exit after completion');

  // Dismiss preselection to return to unselected:
  click('arm', { x: 3, y: 0, z: 0 }, armCenter);
  assert.equal(controller.selectedBlockSelection, null);

  // 2. Set A' on the arm block before rotation.
  const p1 = contraption.getBlockWorldCenter(armBlock);
  click('arm', { x: 3, y: 0, z: 0 }, p1.clone().add(new THREE.Vector3(-0.4, -0.4, -0.4)));
  assert.ok(controller.selectorRange?.pointA, "point A' should be set");

  // 3. Rotate arm 90 degrees between the two clicks, as a script-driven arm might.
  contraption.getChildScriptApi('arm').setLocalEuler([0, Math.PI / 2, 0]);
  contraption.rootGroup.updateMatrixWorld(true);
  const rotatedCenter = contraption.getBlockWorldCenter(armBlock);
  assert.ok(
    Math.abs(rotatedCenter.x - p1.x) > 0.3 || Math.abs(rotatedCenter.z - p1.z) > 0.3,
    'the block position should move after rotation'
  );

  // 4. Set B' on the arm block to complete the box.
  click('arm', { x: 3, y: 0, z: 0 }, rotatedCenter.clone().add(new THREE.Vector3(0.4, 0.4, 0.4)));

  assert.equal(toasts.filter(t => t.includes('No blocks of')).length, 0,
    'node-local anchors should prevent a false No-blocks result after rotation');
  assert.ok(controller.selectedBlockSelection, 'the arm block should be selected again');
  assert.equal(controller.selectedBlockSelection.nodeId, 'arm');
});

test('re-boxing over a sibling component selects its blocks directly without false No-blocks', () => {
  const { contraption } = makeEntityWithChildren();
  const toasts: string[] = [];
  const controller = makeSelectorController();
  controller.ui = { showToast: m => toasts.push(m), renderInventoryBar() {} };
  const armBlock = contraption.blocks.find(b => (b.entityId || 'root') === 'arm');
  const wingBlock = contraption.blocks.find(b => (b.entityId || 'root') === 'wing');
  const armCenter = contraption.getBlockWorldCenter(armBlock);
  const wingCenter = contraption.getBlockWorldCenter(wingBlock);
  const click = (entityId, cell, point) => {
    controller.hoveredContraptionHit = { contraption, entityId, cell, point };
    controller.handleLeftClick();
  };

  // 1. First 2 clicks box-select an arm-owned block.
  click('arm', { x: 0, y: 1, z: 0 }, armCenter.clone().add(new THREE.Vector3(-0.4, -0.4, -0.4)));
  click('arm', { x: 0, y: 1, z: 0 }, armCenter.clone().add(new THREE.Vector3(0.4, 0.4, 0.4)));
  assert.ok(controller.selectedBlockSelection, 'the first box should complete');
  assert.equal(controller.selectedBlockSelection.nodeId, 'arm');

  // Dismiss preselection on clicking wing:
  click('wing', { x: 2, y: 0, z: 0 }, wingCenter);
  assert.equal(controller.selectedBlockSelection, null, 'preselection should clear');

  // 2. A new range over sibling wing selects wing blocks directly in 2 clicks.
  click('wing', { x: 2, y: 0, z: 0 }, wingCenter.clone().add(new THREE.Vector3(-0.4, -0.4, -0.4)));
  click('wing', { x: 2, y: 0, z: 0 }, wingCenter.clone().add(new THREE.Vector3(0.4, 0.4, 0.4)));
  assert.equal(toasts.filter(t => t.includes('No blocks of')).length, 0, 'no false No blocks of [arm] message should appear');
  assert.ok(controller.selectedBlockSelection, 'wing blocks should be selected');
  assert.equal(controller.selectedBlockSelection.nodeId, 'wing');
  assert.equal(controller.selectedBlockSelection.blocks.length, 1);
});

test('switching entity selection clears the previous entity block highlights', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const { contraption: a } = makeEntityWithChildren();
  const b = new Contraption(
    99,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(10, 10, 10),
    scene
  );
  // Construction mode, like a hammer-placed entity: selector clicks edit it
  // directly instead of first stopping it.
  b.stopAllNodeScripts();
  manager.contraptions.push(a, b);
  const controller = makeSelectorController({ manager });

  // 1. Complete a block selection on entity a (2 clicks) and attach per-block highlights.
  const rootBlock = a.blocks.find(x => (x.entityId || 'root') === 'root');
  const center = a.getBlockWorldCenter(rootBlock);
  controller.hoveredContraptionHit = { contraption: a, entityId: 'root', cell: { x: 0, y: 0, z: 0 }, point: center.clone().add(new THREE.Vector3(-0.4, -0.4, -0.4)) };
  controller.handleLeftClick(); // Box point 1.
  controller.hoveredContraptionHit = { contraption: a, entityId: 'root', cell: { x: 0, y: 0, z: 0 }, point: center.clone().add(new THREE.Vector3(0.4, 0.4, 0.4)) };
  controller.handleLeftClick(); // Box point 2 completes.
  assert.ok(controller.selectedBlockSelection, 'entity a should have a completed block selection');
  assert.ok(a.subtreeHighlightBoxes.length > 0, 'entity a should have block highlights');

  // 2. Click entity b; selection is dismissed returning to unselected, and a's highlights must clear.
  controller.hoveredContraptionHit = {
    contraption: b,
    entityId: 'root',
    cell: { x: 0, y: 0, z: 0 },
    point: new THREE.Vector3(10.5, 10.5, 10.5)
  };
  controller.handleLeftClick();
  assert.equal(controller.selectedBlockSelection, null, 'block selection should clear');
  assert.equal(a.subtreeHighlightBoxes.length, 0, 'a should retain no stale highlights');

  // 3. Next click selects entity b:
  controller.handleLeftClick();
  assert.equal(controller.selectedSubtree.contraption, b, 'selection should switch to b');
});

test('inventory copy prunes empty ghost children and scripts from a block selection', () => {
  const { contraption } = makeEntityWithChildren();
  const controller = makeSelectorController();
  const armBlocks = contraption.blocks.filter(b => (b.entityId || 'root') === 'arm');
  assert.equal(armBlocks.length, 1);
  // Attach scripts to arm and hand to verify pruning during copy.
  contraption.setNodeScript('arm', '// arm code');
  contraption.setNodeScript('hand', '// hand code');
  contraption.stopAllNodeScripts();
  controller.selectedBlockSelection = { contraption, nodeId: 'arm', blocks: armBlocks,
    confirmedRange: { pointA: { x: 0, y: 1, z: 0 }, pointB: { x: 0, y: 1, z: 0 } } };
  controller.copySelectionToInventory();
  const slot = controller.inventorySlots[0];
  assert.ok(slot);
  assert.equal(slot.blockCount, 1);
  assert.equal(slot.rootComponentId, 'arm');
  assert.deepEqual([...new Set(slot.blocks.map(b => b.entityId))], ['arm']);
  assert.equal(slot.childEntities.length, 0, 'hand definition should be pruned because its blocks are not selected');
  assert.deepEqual(slot.scripts.map(s => s.id), ['arm'], 'the copied level script stays attached to the selected component ID');
  assert.deepEqual(slot.enabled.map(e => e.id), ['arm']);

  // Pasting should not create ghost children.
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const pasted = manager.buildFromSlot(slot, new THREE.Vector3(30, 0, 30));
  assert.equal(pasted.blocks.length, 1);
  const ghost = [...pasted.entityNodes.keys()].filter(id => id !== pasted.rootComponentId);
  assert.equal(ghost.length, 0, 'pasted entity should contain no ghost components');
});

test('clicking the sky preserves an in-progress entity box after point 1', () => {
  const { contraption } = makeEntityWithChildren();
  const controller = makeSelectorController();
  const rootBlock = contraption.blocks.find(b => (b.entityId || 'root') === 'root');
  const center = contraption.getBlockWorldCenter(rootBlock);

  // Click 1 sets pointA directly on root.
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'root',
    cell: { x: 0, y: 0, z: 0 },
    point: center.clone().add(new THREE.Vector3(-0.4, 0.5, -0.4))
  };
  controller.handleLeftClick();
  assert.ok(controller.selectorRange?.pointA, 'pointA should be set');

  // Click 2 misses into the sky: hoveredContraptionHit and currentRaycast are both null.
  controller.hoveredContraptionHit = null;
  controller.currentRaycast = null;
  controller.handleLeftClick();
  assert.ok(controller.selectorRange?.pointA, 'an empty sky click must preserve the in-progress entity box');
});

test('selector box on entity A shows no spoon preview while hovering entity B', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const { contraption: a } = makeEntityWithChildren();
  const b = new Contraption(
    99,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(10, 10, 10),
    scene
  );
  manager.contraptions.push(a, b);
  const controller = makeSelectorController({ manager });

  // Start entity selection on entity a.
  controller.hoveredContraptionHit = {
    contraption: a,
    entityId: 'root',
    cell: { x: 0, y: 0, z: 0 },
    point: new THREE.Vector3(0.5, 10.5, 0.5)
  };
  controller.handleLeftClick();

  // Hover over entity b with the crosshair.
  controller.hoveredContraptionHit = {
    contraption: b,
    entityId: 'root',
    cell: { x: 0, y: 0, z: 0 },
    point: new THREE.Vector3(10.5, 10.5, 10.5)
  };
  controller.currentRaycast = { hit: true, hitPos: { x: 10.5, y: 10.5, z: 10.5 } };
  controller.updateMicroCarvePreview();
  assert.equal(controller.microCarvePreview, null, 'selector must not produce a spoon grid');
  assert.equal(controller.focusBlockPreview, null, 'the unselected entity should show no focus wireframe');
});

test('entering entity selection clears world cornerA and cornerB state', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const { contraption } = makeEntityWithChildren();
  manager.contraptions.push(contraption);
  const controller = makeSelectorController({ manager });
  controller.ui = { showToast() {}, renderInventoryBar() {} };

  // Complete a two-point world box.
  controller.currentRaycast = { hit: true, hitPos: { x: 0, y: 10, z: 0 } };
  controller.handleLeftClick(); // a
  controller.currentRaycast = { hit: true, hitPos: { x: 5, y: 13, z: 5 } };
  controller.handleLeftClick(); // b completes the box.
  assert.ok(manager.selectionCornerA && manager.selectionCornerB, 'world box should complete');

  // Clicking an entity in preselected state clears world state and returns to unselected.
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'arm',
    cell: { x: 0, y: 1, z: 0 },
    point: new THREE.Vector3(0.5, 11.5, 0.5)
  };
  controller.handleLeftClick();
  assert.equal(manager.selectionCornerA, null, 'world cornerA should clear');
  assert.equal(manager.selectionCornerB, null, 'world cornerB should clear');

  // Next click from unselected state selects the entity and starts point 1 on arm.
  controller.handleLeftClick();
  assert.ok(controller.selectorRange?.pointA, 'entity box point 1 should be active');
  assert.equal(controller.selectorRange?.nodeId, 'arm');
});

test('Shift-picked blocks cannot create children until A/B are confirmed', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const { contraption } = makeEntityWithChildren();
  manager.contraptions.push(contraption);
  const toasts: string[] = [];
  const controller = makeSelectorController({ manager });
  controller.ui = { showToast: m => toasts.push(m), renderInventoryBar() {} };
  controller.sound = { playAssemblyClack() {} };

  const rootBlock = contraption.blocks.find(b => (b.entityId || 'root') === 'root');
  const armBlock = contraption.blocks.find(b => (b.entityId || 'root') === 'arm');

  // Shift-click root block
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'root',
    block: rootBlock,
    cell: { x: 0, y: 0, z: 0 },
    point: new THREE.Vector3(0.5, 10.5, 0.5)
  };
  controller.handleLeftClick({ shiftKey: true });
  assert.equal(controller.selectedBlockSelection.blocks.length, 1);

  // Shift-click arm block (different component)
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'arm',
    block: armBlock,
    cell: { x: 0, y: 1, z: 0 },
    point: new THREE.Vector3(0.5, 11.5, 0.5)
  };
  controller.handleLeftClick({ shiftKey: true });
  assert.equal(controller.selectedBlockSelection.blocks.length, 2, 'both blocks should be selected');

  // Pressing G rejects because blocks span multiple components
  const failResult = controller.createChildFromSelectedBlocks();
  assert.equal(failResult, null, 'child creation should fail validation');
  assert.ok(toasts.some(m => m.includes('A and B')));

  // Shift-click to deselect the arm block
  controller.handleLeftClick({ shiftKey: true });
  assert.equal(controller.selectedBlockSelection.blocks.length, 1, 'arm block deselected');

  // Even one component still requires A/B.
  assert.equal(controller.createChildFromSelectedBlocks(), null);
  controller.clearSelection();
  controller.hoveredContraptionHit = { contraption, entityId: 'root', block: rootBlock,
    cell: { x: 0, y: 0, z: 0 }, point: contraption.getBlockWorldCenter(rootBlock) };
  controller.handleLeftClick();
  controller.handleLeftClick();
  assert.equal(controller.canUseSelectionActions(), true);
  const successResult = controller.createChildFromSelectedBlocks();
  assert.ok(successResult, 'child creation should succeed');
});

test('selector box preview and range on entity surface normal does not spill into neighbor block', () => {
  const { contraption } = makeEntityWithChildren();
  const controller = makeSelectorController();

  // 1. Click point 1 on top face of block (0, 0, 0): world Y is 11.0 (entity at Y=10, block height 1)
  // Face normal is +Y: (0, 1, 0)
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'root',
    block: contraption.blocks[0],
    cell: { x: 0, y: 0, z: 0 },
    point: new THREE.Vector3(0.5, 11.0, 0.5),
    worldNormal: new THREE.Vector3(0, 1, 0),
    normal: new THREE.Vector3(0, 1, 0)
  };
  controller.handleLeftClick();
  assert.ok(controller.selectorRange, 'selector range initialized');
  assert.ok(controller.selectorRange.pointA, 'pointA should be set');

  // 2. Hover the same face: preview cursor should remain on cell 0 in Y, NOT jump to cell 1 (empty air / block in normal dir)
  controller.updateMicroCarvePreview();
  assert.ok(controller.boxSelectionPreview, 'boxSelectionPreview should exist');
  // cursor Y must be < 1.0 (e.g. 0.98), which floors to cell 0 instead of cell 1
  assert.ok(controller.boxSelectionPreview.cursor.y < 1.0, 'cursor Y must be within cell 0 bounds');
  assert.equal(Math.floor(controller.boxSelectionPreview.cursor.y), 0, 'floored cursor Y must be 0');
  assert.equal(Math.floor(controller.boxSelectionPreview.pointA.y), 0, 'floored pointA Y must be 0');

  // 3. Hover +X face of block (0, 0, 0): point X is 1.0, worldNormal is (1, 0, 0)
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'root',
    block: contraption.blocks[0],
    cell: { x: 0, y: 0, z: 0 },
    point: new THREE.Vector3(1.0, 10.5, 0.5),
    worldNormal: new THREE.Vector3(1, 0, 0),
    normal: new THREE.Vector3(1, 0, 0)
  };
  controller.updateMicroCarvePreview();
  assert.ok(controller.boxSelectionPreview.cursor.x < 1.0, 'cursor X must be within cell 0 bounds');
  assert.equal(Math.floor(controller.boxSelectionPreview.cursor.x), 0, 'floored cursor X must be 0');

  // 4. Complete selection by clicking the top face again: only the single aimed block should be selected
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'root',
    block: contraption.blocks[0],
    cell: { x: 0, y: 0, z: 0 },
    point: new THREE.Vector3(0.5, 11.0, 0.5),
    worldNormal: new THREE.Vector3(0, 1, 0),
    normal: new THREE.Vector3(0, 1, 0)
  };
  controller.handleLeftClick();
  assert.ok(controller.selectedBlockSelection, 'block selection created');
  assert.equal(controller.selectedBlockSelection.blocks.length, 1, 'only the single targeted block should be selected');
  assert.equal(controller.selectedBlockSelection.blocks[0], contraption.blocks[0], 'selected block must be the aimed block');
});
