import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';

/**
 * Regression tests for selector fixes:
 *  - geometric shapes must apply to a component that shares an entity with others
 *  - a new selection must not reuse shape corners from a previous region
 *  - clicking a whole-entity selection returns to unselected ('未选')
 *  - F expands a whole-component selection instead of only recoloring it
 *  - the cuboid guide box stays visible while the axis gizmo expands a selection
 */

function makeStubSceneRenderer() {
  const renderer: any = Object.create(SceneRenderer.prototype);
  renderer.scene = new THREE.Scene();
  renderer.setupSelectionHologram();
  renderer.setupSelectionAxisGizmo();
  return renderer;
}

function makeDefaultManagerStub() {
  return {
    selectionCornerA: null,
    selectionCornerB: null,
    connectedSelection: null,
    microSelection: null,
    microBounds: null,
    contraptions: [],
    hasValidSelection: () => false,
    getSelectionBounds: () => null,
    getMicroSelectionBounds: () => null,
    clearSelection() {}
  };
}

function makeController(overrides: any = {}) {
  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectedSubtree = null;
  controller.selectedBlockSelection = null;
  controller.selectorLevel = null;
  controller.selectorRange = null;
  controller.selectionShapeAnchor = null;
  controller.selectorMicroMode = false;
  controller.selectorShape = 'box';
  controller.bulkEditJob = null;
  controller.hoveredContraptionHit = null;
  controller.hoveredGizmoHandle = null;
  controller.activeGizmoDrag = null;
  controller.boxSelectionPreview = null;
  controller.focusBlockPreview = null;
  controller.selectedColor = 0xff0000;
  controller.inventorySlots = new Array(8).fill(null);
  controller.selectedInventoryIndex = 0;
  controller.keys = {};
  controller.contraptions = makeDefaultManagerStub();
  controller.world = null;
  const toasts: string[] = [];
  controller.ui = {
    showToast: (message: string) => toasts.push(message),
    renderInventoryBar() {},
    updateToolPanelMode() {},
    setSelectorShape() {},
    notifyContraptionStructureChanged() {}
  };
  controller.sound = {
    playBlockPlace() {},
    playBlockBreak() {},
    playWrenchClick() {},
    playAssemblyClack() {}
  };
  controller.particles = { emitBlockBreak() {} };
  Object.assign(controller, overrides);
  controller.__toasts = toasts;
  return controller;
}

/** Stub entity: root owns one block, child `arm` owns a 3x3x3 cluster at x=10..12. */
function makeStubEntityWithChild() {
  const rootGroup = new THREE.Group();
  const armGroup = new THREE.Group();
  armGroup.position.set(10, 0, 0);
  const blocks: any[] = [
    { localX: 0, localY: 0, localZ: 0, size: 1, entityId: 'root', color: 0x111111 }
  ];
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 3; y++) {
      for (let z = 0; z < 3; z++) {
        blocks.push({ localX: 10 + x, localY: y, localZ: z, size: 1, entityId: 'arm', color: 0x222222 });
      }
    }
  }
  return {
    id: 2,
    rootComponentId: 'root',
    scriptStatus: 'stopped',
    serverManaged: false,
    entityNodes: new Map([
      ['root', { id: 'root', parentId: null, group: rootGroup, pivotLocal: new THREE.Vector3() }],
      ['arm', { id: 'arm', parentId: 'root', group: armGroup, pivotLocal: new THREE.Vector3(10, 0, 0) }]
    ]),
    blocks,
    clearSubtreeHighlight() {},
    highlightBlocks() {}
  };
}

test('cylinder shape applies to a child component that shares an entity with other components', () => {
  const controller = makeController({ sceneRenderer: makeStubSceneRenderer() });
  const contraption = makeStubEntityWithChild();
  const armBlocks = contraption.blocks.filter((b: any) => b.entityId === 'arm');

  controller.selectedBlockSelection = {
    contraption,
    nodeId: 'arm',
    blocks: [...armBlocks],
    bounds: { minX: 10, minY: 0, minZ: 0, maxX: 12, maxY: 2, maxZ: 2 }
  };
  controller.selectorLevel = { contraption, nodeId: 'arm' };

  controller.setSelectorShape('cylinder');

  assert.ok(controller.selectedBlockSelection, 'selection must stay active');
  assert.ok(
    Array.isArray(controller.selectedBlockSelection.shapeCells),
    'cylinder must compute shape cells even when the entity has a parent/root component'
  );
  assert.ok(controller.selectedBlockSelection.shapeCells.length > 0);
  assert.ok(
    controller.selectedBlockSelection.blocks.length < 27,
    'cylinder must trim the 3x3x3 corner columns'
  );
  assert.ok(controller.selectedBlockSelection.blocks.length > 0);
  const hasCorner = controller.selectedBlockSelection.blocks.some(
    (b: any) => b.entityId === 'arm' && b.localX === 10 && b.localZ === 0
  );
  assert.equal(hasCorner, false, 'corner column (0,0) must be excluded by the cylinder');
  assert.equal(
    controller.selectedBlockSelection.blocks.some((b: any) => b.entityId !== 'arm'),
    false,
    'blocks owned by other components must never be selected'
  );
});

test('cylinder shape applies to the root of an entity that has child components', () => {
  const controller = makeController({ sceneRenderer: makeStubSceneRenderer() });
  const rootGroup = new THREE.Group();
  const wingGroup = new THREE.Group();
  wingGroup.position.set(10, 0, 0);
  const blocks: any[] = [];
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 3; y++) {
      for (let z = 0; z < 3; z++) {
        blocks.push({ localX: x, localY: y, localZ: z, size: 1, entityId: 'root', color: 0x111111 });
      }
    }
  }
  blocks.push({ localX: 10, localY: 0, localZ: 0, size: 1, entityId: 'wing', color: 0x333333 });
  const contraption: any = {
    id: 3,
    rootComponentId: 'root',
    scriptStatus: 'stopped',
    serverManaged: false,
    entityNodes: new Map([
      ['root', { id: 'root', parentId: null, group: rootGroup, pivotLocal: new THREE.Vector3() }],
      ['wing', { id: 'wing', parentId: 'root', group: wingGroup, pivotLocal: new THREE.Vector3(10, 0, 0) }]
    ]),
    blocks,
    clearSubtreeHighlight() {},
    highlightBlocks() {}
  };
  const rootBlocks = blocks.filter(b => b.entityId === 'root');

  controller.selectedBlockSelection = {
    contraption,
    nodeId: 'root',
    blocks: [...rootBlocks],
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 }
  };
  controller.selectorLevel = { contraption, nodeId: 'root' };

  controller.setSelectorShape('cylinder');

  assert.ok(Array.isArray(controller.selectedBlockSelection.shapeCells), 'root cylinder must compute shape cells');
  assert.ok(controller.selectedBlockSelection.shapeCells.length > 0);
  assert.ok(controller.selectedBlockSelection.blocks.length < 27);
  assert.equal(
    controller.selectedBlockSelection.blocks.some((b: any) => b.entityId === 'wing'),
    false,
    'the child component block must not be selected'
  );
});

test('re-boxing a new region does not reuse shape corners from the previous region', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const blocks = [
    { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK },
    { localX: 0, localY: 1, localZ: 0, block: BlockTypes.COLOR_BLOCK },
    { localX: 0, localY: 2, localZ: 0, block: BlockTypes.COLOR_BLOCK },
    { localX: 20, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK },
    { localX: 20, localY: 1, localZ: 0, block: BlockTypes.COLOR_BLOCK },
    { localX: 20, localY: 2, localZ: 0, block: BlockTypes.COLOR_BLOCK }
  ];
  const contraption = new Contraption(1, blocks, new THREE.Vector3(0, 10, 0), scene);
  contraption.stopAllNodeScripts();
  manager.contraptions.push(contraption);
  const controller = makeController({ manager, sceneRenderer: makeStubSceneRenderer() });
  const nodeId = contraption.rootComponentId;

  const clickBlock = (block: any) => {
    const center = contraption.getBlockWorldCenter(block);
    controller.hoveredContraptionHit = {
      contraption,
      entityId: nodeId,
      block,
      cell: { x: block.localX, y: block.localY, z: block.localZ },
      point: center.clone().add(new THREE.Vector3(-0.4, -0.4, -0.4)),
      worldNormal: new THREE.Vector3(0, 1, 0),
      normal: new THREE.Vector3(0, 1, 0)
    };
    controller.handleLeftClick();
  };

  const region1 = contraption.blocks.filter(b => b.localX === 0);
  const region2 = contraption.blocks.filter(b => b.localX === 20);

  // 1. Box-select region 1 and apply a non-box shape so an anchor is cached.
  clickBlock(region1[0]);
  clickBlock(region1[2]);
  assert.ok(controller.selectedBlockSelection, 'region 1 should be selected');
  assert.deepEqual(controller.selectedBlockSelection.bounds, { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 2, maxZ: 0 });
  controller.setSelectorShape('cylinder');
  assert.equal(controller.selectionShapeAnchor.cornerA.x, 0, 'cylinder anchors at region 1');

  // 2. Consume the selection (as G/F/P would) and switch back to the box shape.
  controller.setSelectorShape('box');
  controller.selectedBlockSelection = null;

  // 3. Box-select a different region, then switch shape again.
  clickBlock(region2[0]);
  clickBlock(region2[2]);
  assert.ok(controller.selectedBlockSelection, 'region 2 should be selected');
  assert.deepEqual(controller.selectedBlockSelection.bounds, { minX: 20, minY: 0, minZ: 0, maxX: 20, maxY: 2, maxZ: 0 });

  controller.setSelectorShape('sphere');
  assert.equal(
    controller.selectionShapeAnchor.cornerA.x,
    20,
    'the new shape must anchor at the current selection, not the stale region'
  );
});

test('a plain click dismisses an editable subtree-only selection', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const contraption = new Contraption(
    5,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: 1, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }
    ],
    new THREE.Vector3(0, 10, 0),
    scene
  );
  contraption.stopAllNodeScripts();
  manager.contraptions.push(contraption);
  const controller = makeController({ manager });
  const rootId = contraption.rootComponentId;

  // Shift+click on a stopped level can leave a subtree selection without a box point.
  controller.selectedSubtree = { contraption, rootId, nodeIds: new Set([rootId]) };
  controller.selectorRange = { contraption, nodeId: rootId, pointA: null, pointB: null };
  controller.hoveredContraptionHit = {
    contraption,
    entityId: rootId,
    block: contraption.blocks[0],
    cell: { x: 0, y: 0, z: 0 },
    point: new THREE.Vector3(0.5, 10.5, 0.5)
  };

  controller.handleLeftClick();

  assert.equal(controller.selectedSubtree, null, 'the editable subtree selection should be dismissed');
  assert.equal(controller.selectedBlockSelection, null);
  assert.equal(controller.selectorRange, null, 'no in-progress box should remain');
});

test('F expands a whole-component subtree selection instead of only recoloring it', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const contraption = new Contraption(
    7,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: 2, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }
    ],
    new THREE.Vector3(0, 10, 0),
    scene
  );
  contraption.stopAllNodeScripts();
  manager.contraptions.push(contraption);
  const controller = makeController({ manager });
  const rootId = contraption.rootComponentId;

  controller.selectedSubtree = { contraption, rootId, nodeIds: new Set([rootId]) };
  controller.fillSelectionBlocks(0x00ff00);

  assert.equal(contraption.blocks.length, 3, 'the hole between the two blocks should be filled');
  const filled = contraption.blocks.find((b: any) => Math.abs(b.localX - 1) < 1e-6 && b.localY === 0 && b.localZ === 0);
  assert.ok(filled, 'a new block must be created inside the component bounds');
  assert.equal(filled.entityId, rootId, 'the new block must belong to the expanded component');
  assert.equal(filled.color, 0x00ff00);
  assert.equal(controller.selectedSubtree, null, 'the subtree selection is consumed by the expand');
  assert.equal(controller.selectedBlockSelection, null);
});

test('axis gizmo expansion keeps the cuboid selection hologram visible', () => {
  const renderer = makeStubSceneRenderer();
  const calls: any[] = [];
  const original = renderer.updateSelectionHologram.bind(renderer);
  renderer.updateSelectionHologram = (bounds: any, connected: any, micro: any, isMicro: boolean, frame: any) => {
    calls.push({ bounds, connected, micro, isMicro });
    return original(bounds, connected, micro, isMicro, frame);
  };
  const controller = makeController({ sceneRenderer: renderer });
  const contraption = makeStubEntityWithChild();
  const rootBlocks = contraption.blocks.filter((b: any) => b.entityId === 'root');

  controller.selectedBlockSelection = {
    contraption,
    nodeId: 'root',
    blocks: [...rootBlocks],
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }
  };
  controller.selectorLevel = { contraption, nodeId: 'root' };
  calls.length = 0;

  const result = controller.expandEntitySelectionAxis('x', 1, 1, false);

  assert.equal(result.ok, true);
  const last = calls[calls.length - 1];
  assert.ok(last, 'the hologram must be refreshed after the expansion');
  assert.notEqual(last.bounds, null, 'the outer cuboid guide box must stay visible');
  assert.equal(last.bounds.maxX, 1, 'the guide box must follow the expanded bounds');
});

test('whole-entity subtree highlight is depth-independent so it cannot z-fight the model', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    21,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: 1, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  contraption.stopAllNodeScripts();

  // The running-entity whole selection is drawn by highlightSubtree.
  contraption.highlightSubtree(['root']);
  assert.ok(contraption.subtreeHighlightBoxes.length > 0, 'subtree highlight boxes should be created');
  const { materials } = contraption.subtreeHighlightBoxes[0];
  // The box faces sit exactly on the outermost voxel planes; depth testing would
  // z-fight with the entity surface and read as the highlight clipping through.
  assert.equal(materials.lineMat.depthTest, false, 'subtree outline must be a depth-independent overlay');
  assert.equal(materials.lineMat.depthWrite, false);
  assert.equal(materials.fillMat.depthTest, false, 'subtree fill must be a depth-independent overlay');
  assert.equal(materials.fillMat.depthWrite, false);
});

test('focus highlight encloses blocks and keeps its fill occluded by the model', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    22,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  contraption.stopAllNodeScripts();

  contraption.setFocusHighlight('root');
  const materials = contraption.focusHighlightMaterials;
  // Outline stays visible through parent geometry...
  assert.equal(materials.focusedLine.depthTest, false, 'the focused outline must remain an X-ray overlay');
  assert.equal(materials.childLine.depthTest, false, 'descendant outlines must remain X-ray overlays');
  // ...but the translucent fill must be occluded, otherwise it blends through the
  // component and reads as the highlight clipping into the model.
  assert.equal(materials.focusedFill.depthTest, true, 'the focused fill must be occluded by the model');
  assert.equal(materials.childFill.depthTest, true, 'the descendant fill must be occluded by the model');
  assert.equal(materials.focusedFill.depthWrite, false);
  // The box matches the blocks exactly (no inflation) and uses a polygon offset
  // so the coincident faces do not z-fight the voxels.
  assert.equal(materials.focusedFill.polygonOffset, true, 'the fill needs a polygon offset to avoid z-fighting');
  assert.ok(materials.focusedFill.polygonOffsetFactor > 0);

  const boxGeo: any = contraption.focusHighlightGeometries[0];
  assert.ok(boxGeo?.parameters, 'the focused box geometry is registered');
  assert.equal(boxGeo.parameters.width, 1, 'the guide must hug the 1 m block without inflating it');
});
