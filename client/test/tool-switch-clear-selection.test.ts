import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

function createMockRenderer() {
  let hologramCleared = false;
  let boxPreviewCleared = false;
  let focusGuideCleared = false;
  return {
    updateSelectionHologram: (bounds: any, connected: any, micro: any) => {
      if (bounds === null && connected === null && micro === null) {
        hologramCleared = true;
      }
    },
    clearBoxSelectionPreview: () => {
      boxPreviewCleared = true;
    },
    clearFocusBlockGuide: () => {
      focusGuideCleared = true;
    },
    get hologramCleared() { return hologramCleared; },
    get boxPreviewCleared() { return boxPreviewCleared; },
    get focusGuideCleared() { return focusGuideCleared; }
  };
}

function makeControllerWithWorld(overrides: any = {}) {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const manager = new ContraptionManager(scene, {}, null, null) as any;
  const renderer = createMockRenderer();
  const controller: any = Object.create(PlayerController.prototype);
  controller._activeTool = SpecialTool.SELECTOR;
  controller.selectedSubtree = null;
  controller.selectedBlockSelection = null;
  controller.selectorLevel = null;
  controller.selectorRange = null;
  controller.boxSelectionPreview = null;
  controller.focusBlockPreview = null;
  controller.selectorMicroMode = false;
  controller.inventorySlots = new Array(9).fill(null);
  controller.selectedInventoryIndex = 0;
  controller.contraptions = manager;
  controller.world = world;
  controller.sceneRenderer = renderer;
  controller.keys = {};
  controller.sound = { playBlockPlace() {} };
  manager.selectionHost = controller;

  const toasts: string[] = [];
  controller.ui = {
    showToast: (m: string) => toasts.push(m),
    renderInventoryBar() {},
    updateToolPanelMode() {},
    renderHotbar() {}
  };
  Object.assign(controller, overrides);
  return { controller, manager, world, scene, renderer, toasts };
}

test('switching activeTool from SELECTOR to SHOVEL clears world 2-point box selection', () => {
  const { controller, manager, renderer } = makeControllerWithWorld();
  manager.setCornerA({ x: 1, y: 2, z: 3 });
  manager.setCornerB({ x: 4, y: 5, z: 6 });
  controller.boxSelectionPreview = { pointA: new THREE.Vector3(1, 2, 3), cursor: new THREE.Vector3(4, 5, 6) };
  controller.focusBlockPreview = { center: new THREE.Vector3(1, 2, 3), active: true };

  assert.equal(manager.hasValidSelection(), true);
  assert.notEqual(manager.selectionCornerA, null);
  assert.notEqual(manager.selectionCornerB, null);

  // Switch tool to SHOVEL
  controller.activeTool = SpecialTool.SHOVEL;

  assert.equal(controller.activeTool, SpecialTool.SHOVEL);
  assert.equal(manager.selectionCornerA, null);
  assert.equal(manager.selectionCornerB, null);
  assert.equal(manager.hasValidSelection(), false);
  assert.equal(controller.boxSelectionPreview, null);
  assert.equal(controller.focusBlockPreview, null);
  assert.equal(renderer.hologramCleared, true);
  assert.equal(renderer.boxPreviewCleared, true);
  assert.equal(renderer.focusGuideCleared, true);
});

test('switching activeTool from SELECTOR to WRENCH clears single-cell and micro selections', () => {
  const { controller, manager } = makeControllerWithWorld();
  manager.toggleWorldGlueCell({ x: 10, y: 20, z: 30 });
  assert.equal(manager.connectedSelection?.length, 1);

  // Switch tool to WRENCH
  controller.activeTool = SpecialTool.WRENCH;
  assert.equal(controller.activeTool, SpecialTool.WRENCH);
  assert.equal(manager.connectedSelection, null);
  assert.equal(manager.hasValidSelection(), false);

  // Switch back to SELECTOR and toggle micro-cell
  controller.activeTool = SpecialTool.SELECTOR;
  manager.toggleMicroCell({ x: 10, y: 20, z: 30 });
  assert.equal(manager.microSelection?.length, 1);

  // Switch tool to SPOON
  controller.activeTool = SpecialTool.SPOON;
  assert.equal(controller.activeTool, SpecialTool.SPOON);
  assert.equal(manager.microSelection, null);
  assert.equal(manager.hasValidSelection(), false);
});

test('switching activeTool from SELECTOR to HAMMER clears entity subtree and block selections with highlights', () => {
  const { controller, manager, scene } = makeControllerWithWorld();
  const contraption = new Contraption(
    1,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: 0, localY: 1, localZ: 0, block: BlockTypes.COLOR_BLOCK }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    {
      childEntities: [
        { id: 'arm', parentId: 'root', kind: 'child', pivot: [0.5, 0.5, 0.5], blockKeys: [['0', '1', '0']] }
      ]
    }
  );
  manager.contraptions.push(contraption);

  // Setup subtree selection and highlight
  controller.selectedSubtree = { contraption, rootId: 'arm', nodeIds: new Set(['arm']) };
  contraption.highlightSubtree(['arm']);
  assert.equal(contraption.subtreeHighlightBoxes.length, 1);

  // Setup entity block selection and range
  controller.selectedBlockSelection = { contraption, nodeId: 'arm', blocks: [contraption.blocks[1]] };
  controller.selectorLevel = { contraption, nodeId: 'arm' };
  controller.selectorRange = { contraption, nodeId: 'arm', pointA: new THREE.Vector3(0, 1, 0) };

  // Switch tool to HAMMER
  controller.activeTool = SpecialTool.HAMMER;

  assert.equal(controller.activeTool, SpecialTool.HAMMER);
  assert.equal(controller.selectedSubtree, null);
  assert.equal(controller.selectedBlockSelection, null);
  assert.equal(controller.selectorLevel, null);
  assert.equal(controller.selectorRange, null);
  assert.equal(contraption.subtreeHighlightBoxes.length, 0);
});

test('activateTool switches tool and clears selection state', () => {
  const { controller, manager } = makeControllerWithWorld();
  manager.setCornerA({ x: 5, y: 5, z: 5 });
  manager.setCornerB({ x: 6, y: 6, z: 6 });
  assert.equal(manager.hasValidSelection(), true);

  controller.activateTool(SpecialTool.BRUSH);

  assert.equal(controller.activeTool, SpecialTool.BRUSH);
  assert.equal(manager.hasValidSelection(), false);
  assert.equal(manager.selectionCornerA, null);
  assert.equal(manager.selectionCornerB, null);
});

test('switching between SELECTOR and SUPER_GLUE alias does not clear selection', () => {
  const { controller, manager } = makeControllerWithWorld();
  manager.setCornerA({ x: 1, y: 1, z: 1 });
  manager.setCornerB({ x: 2, y: 2, z: 2 });

  controller.activeTool = SpecialTool.SUPER_GLUE;
  assert.equal(manager.hasValidSelection(), true);
  assert.notEqual(manager.selectionCornerA, null);

  controller.activeTool = SpecialTool.SELECTOR;
  assert.equal(manager.hasValidSelection(), true);
  assert.notEqual(manager.selectionCornerA, null);
});

test('React UI store applyActiveSlot clears selection when switching from Selector', () => {
  const { controller, manager } = makeControllerWithWorld();
  const ui = new SpaceUiStore();
  ui.setController(controller);
  controller.activeTool = SpecialTool.SELECTOR;
  manager.setCornerA({ x: 3, y: 3, z: 3 });
  manager.setCornerB({ x: 4, y: 4, z: 4 });
  assert.equal(manager.hasValidSelection(), true);

  ui.applyActiveSlot();

  assert.equal(controller.activeTool, SpecialTool.SHOVEL);
  assert.equal(manager.hasValidSelection(), false);
  assert.equal(manager.selectionCornerA, null);
  assert.equal(manager.selectionCornerB, null);
});
