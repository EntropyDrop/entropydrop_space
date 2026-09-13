import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';

function createTestController(overrides: any = {}) {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const manager = new ContraptionManager(scene, world, null, null) as any;
  const controller: any = Object.create(PlayerController.prototype);
  controller._activeTool = SpecialTool.SELECTOR;
  controller.selectedSubtree = null;
  controller.selectedBlockSelection = null;
  controller.selectorLevel = null;
  controller.selectorRange = null;
  controller.boxSelectionPreview = null;
  controller.focusBlockPreview = null;
  controller.selectorMicroMode = false;
  controller.selectedColor = 0xff3b30;
  controller.inventorySlots = new Array(9).fill(null);
  controller.selectedInventoryIndex = 0;
  controller.contraptions = manager;
  controller.world = world;
  controller.keys = {};
  controller.physics = { isFlying: false, isSprinting: false };
  controller.sound = { playBlockBreak() {}, playBlockPlace() {}, playWrenchClick() {}, playAssemblyClack() {} };
  controller.particles = { emitBlockBreak() {} };
  controller.recordEntityKeyDown = () => {};
  manager.selectionHost = controller;

  const toasts: string[] = [];
  controller.ui = {
    showToast: (m: string) => toasts.push(m),
    renderInventoryBar() {},
    updateToolPanelMode() {},
    renderHotbar() {},
    notifyContraptionStructureChanged() {}
  };
  Object.assign(controller, overrides);
  return { controller, manager, world, scene, toasts };
}

test('hasActiveSelection correctly reports selection status', () => {
  const { controller, manager } = createTestController();

  // Initially nothing is selected
  assert.equal(controller.hasActiveSelection(), false);

  // Set world 2-point box selection
  manager.selectionCornerA = { x: 0, y: 0, z: 0 };
  manager.selectionCornerB = { x: 2, y: 2, z: 2 };
  assert.equal(manager.hasValidSelection(), true);
  assert.equal(controller.hasActiveSelection(), true);

  // Clear world selection
  manager.selectionCornerA = null;
  manager.selectionCornerB = null;
  assert.equal(controller.hasActiveSelection(), false);

  // Selected block selection
  controller.selectedBlockSelection = {
    contraption: {},
    nodeId: 'root',
    blocks: [{ localX: 0, localY: 0, localZ: 0, color: 0xff0000 }]
  };
  assert.equal(controller.hasActiveSelection(), true);

  controller.selectedBlockSelection = null;
  assert.equal(controller.hasActiveSelection(), false);

  // Selected subtree
  controller.selectedSubtree = { contraption: {}, rootId: 'root' };
  assert.equal(controller.hasActiveSelection(), true);
});

test('KeyF toggles flight when no selection is active', () => {
  const { controller, toasts } = createTestController();

  assert.equal(controller.physics.isFlying, false);
  assert.equal(controller.hasActiveSelection(), false);

  // Press KeyF when nothing selected
  controller.handleKeyDown({ code: 'KeyF', preventDefault() {} } as any);
  assert.equal(controller.physics.isFlying, true);
  assert.ok(toasts.includes('FLY MODE ON'));

  controller.handleKeyDown({ code: 'KeyF', preventDefault() {} } as any);
  assert.equal(controller.physics.isFlying, false);
  assert.ok(toasts.includes('FLY MODE OFF'));
});

test('KeyF in non-selector tool toggles flight even if selection exists in manager', () => {
  const { controller, manager, toasts } = createTestController();
  controller._activeTool = SpecialTool.SHOVEL;

  manager.selectionCornerA = { x: 0, y: 0, z: 0 };
  manager.selectionCornerB = { x: 1, y: 1, z: 1 };

  controller.handleKeyDown({ code: 'KeyF', preventDefault() {} } as any);
  assert.equal(controller.physics.isFlying, true);
  assert.ok(toasts.includes('FLY MODE ON'));
});

test('KeyF fills selection with selectedColor when selection is active in selector tool', () => {
  const { controller, manager, world } = createTestController();
  controller._activeTool = SpecialTool.SELECTOR;
  controller.selectedColor = 0x4488ff;

  // Box select 2x2x2 region in air (10,50,10) to (11,51,11)
  manager.selectionCornerA = { x: 10, y: 50, z: 10 };
  manager.selectionCornerB = { x: 11, y: 51, z: 11 };
  assert.equal(controller.hasActiveSelection(), true);

  // Press KeyF -> fills with 0x4488ff
  controller.handleKeyDown({ code: 'KeyF', preventDefault() {} } as any);

  // Verify all 8 blocks in (10..11, 50..51, 10..11) are filled with color 0x4488ff
  for (let x = 10; x <= 11; x++) {
    for (let y = 50; y <= 51; y++) {
      for (let z = 10; z <= 11; z++) {
        assert.equal(world.getBlock(x, y, z), BlockTypes.COLOR_BLOCK);
        assert.equal(world.getBlockColor(x, y, z), 0x4488ff);
      }
    }
  }

  // Flight mode should NOT have been toggled
  assert.equal(controller.physics.isFlying, false);
});

test('KeyP recolors existing blocks in selection to selectedColor', () => {
  const { controller, manager, world } = createTestController();
  controller._activeTool = SpecialTool.SELECTOR;

  // Place initial blocks with green color 0x00ff00 at (10, 50, 10) and (11, 50, 10)
  world.setBlock(10, 50, 10, BlockTypes.COLOR_BLOCK, false, 0x00ff00);
  world.setBlock(11, 50, 10, BlockTypes.COLOR_BLOCK, false, 0x00ff00);
  // (10, 51, 10) is left AIR
  assert.equal(world.getBlock(10, 51, 10), BlockTypes.AIR);

  // Select box (10,50,10) to (11,51,10)
  manager.selectionCornerA = { x: 10, y: 50, z: 10 };
  manager.selectionCornerB = { x: 11, y: 51, z: 10 };

  // Set new recent color: yellow 0xffff00
  controller.selectedColor = 0xffff00;

  // Press KeyP
  controller.handleKeyDown({ code: 'KeyP', preventDefault() {} } as any);

  // Existing blocks should be recolored to 0xffff00
  assert.equal(world.getBlock(10, 50, 10), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlockColor(10, 50, 10), 0xffff00);
  assert.equal(world.getBlock(11, 50, 10), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlockColor(11, 50, 10), 0xffff00);

  // Air block at (10, 51, 10) should remain AIR (recolor only colors existing blocks)
  assert.equal(world.getBlock(10, 51, 10), BlockTypes.AIR);
});

test('KeyF and KeyP work on micro selections with active color', () => {
  const { controller, manager, world } = createTestController();
  controller._activeTool = SpecialTool.SELECTOR;
  controller.selectedColor = 0xabcdef;

  // Select micro box covering 8 microblocks at y=400 (air): (80, 400, 80) to (81, 401, 81)
  manager.microBounds = { minX: 80, minY: 400, minZ: 80, maxX: 81, maxY: 401, maxZ: 81 };
  manager.microSelection = manager.materializeMicroBox(80, 400, 80, 81, 401, 81);
  assert.equal(controller.hasActiveSelection(), true);

  // Press KeyF -> fills micro blocks with 0xabcdef
  controller.handleKeyDown({ code: 'KeyF', preventDefault() {} } as any);
  assert.equal(world.getMicroBlock(80, 400, 80)?.color, 0xabcdef);
  assert.equal(world.getMicroBlock(81, 401, 81)?.color, 0xabcdef);

  // Change color to 0x123456 and press KeyP -> recolors micro blocks
  controller.selectedColor = 0x123456;
  controller.handleKeyDown({ code: 'KeyP', preventDefault() {} } as any);
  assert.equal(world.getMicroBlock(80, 400, 80)?.color, 0x123456);
  assert.equal(world.getMicroBlock(81, 401, 81)?.color, 0x123456);
});
