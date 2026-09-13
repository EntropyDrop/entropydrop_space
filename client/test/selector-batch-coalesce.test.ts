import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';

function createController(overrides: any = {}) {
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
  controller.selectorMicroMode = true;
  controller.selectedColor = 0xff3b30;
  controller.inventorySlots = new Array(9).fill(null);
  controller.selectedInventoryIndex = 0;
  controller.contraptions = manager;
  controller.world = world;
  controller.keys = {};
  controller.sound = { playBlockBreak() {}, playBlockPlace() {}, playWrenchClick() {}, playAssemblyClack() {} };
  controller.particles = { emitBlockBreak() {} };
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

test('partitionMicroSelection separates fully-covered standard blocks from boundary microcells', () => {
  const { manager } = createController();

  // 1. Exactly 1 standard block: micro (0, 0, 0) to (7, 7, 7) -> covers standard (0, 0, 0)
  manager.microBounds = { minX: 0, minY: 0, minZ: 0, maxX: 7, maxY: 7, maxZ: 7 };
  let partition = manager.partitionMicroSelection();
  assert.equal(partition.standardCells.length, 1);
  assert.deepEqual(partition.standardCells[0], { x: 0, y: 0, z: 0 });
  assert.equal(partition.microCells.length, 0);

  // 2. 1 standard block + 1 slice on +X: micro (0, 0, 0) to (8, 7, 7)
  // Standard block (0, 0, 0) is fully covered. Micro slice at x = 8 (8*8 = 64 microcells) is partial.
  manager.microBounds = { minX: 0, minY: 0, minZ: 0, maxX: 8, maxY: 7, maxZ: 7 };
  partition = manager.partitionMicroSelection();
  assert.equal(partition.standardCells.length, 1);
  assert.deepEqual(partition.standardCells[0], { x: 0, y: 0, z: 0 });
  assert.equal(partition.microCells.length, 64);
  assert.ok(partition.microCells.every((c: any) => c.x === 8));

  // 3. Small micro box smaller than 1 standard block: (1, 1, 1) to (6, 6, 6)
  manager.microBounds = { minX: 1, minY: 1, minZ: 1, maxX: 6, maxY: 6, maxZ: 6 };
  partition = manager.partitionMicroSelection();
  assert.equal(partition.standardCells.length, 0);
  assert.equal(partition.microCells.length, 6 * 6 * 6);
});

test('micro selection delete coalesces fully-covered standard blocks without subdivision', () => {
  const { controller, manager, world } = createController();
  // Place standard block at (2, 5, 2)
  world.setBlock(2, 5, 2, BlockTypes.COLOR_BLOCK, false, 0xff0000);
  assert.equal(world.getBlock(2, 5, 2), BlockTypes.COLOR_BLOCK);
  assert.equal(world.microVoxels.cells.size, 0);

  // Select micro box exactly covering standard block (2, 5, 2): (16, 40, 16) to (23, 47, 23)
  manager.microBounds = { minX: 16, minY: 40, minZ: 16, maxX: 23, maxY: 47, maxZ: 23 };
  manager.microSelection = manager.materializeMicroBox(16, 40, 16, 23, 47, 23);

  // Delete selection
  controller.deleteSelectionBlocks();

  // Verify: block is deleted directly
  assert.equal(world.getBlock(2, 5, 2), BlockTypes.AIR);
  // Crucial: NO microblocks were created or left behind! Subdivision was completely avoided.
  assert.equal(world.microVoxels.cells.size, 0, 'no micro voxels should be created when deleting full standard block');
});

test('micro selection delete preserves non-selected boundary microcells while deleting full core blocks', () => {
  const { controller, manager, world } = createController();
  // Place two adjacent standard blocks at (2, 5, 2) and (3, 5, 2)
  world.setBlock(2, 5, 2, BlockTypes.COLOR_BLOCK, false, 0xff0000);
  world.setBlock(3, 5, 2, BlockTypes.COLOR_BLOCK, false, 0x00ff00);

  // Select all of block (2, 5, 2) (16..23) plus only 1 layer of block (3, 5, 2) (x = 24)
  // minX = 16, maxX = 24; Y: 40..47; Z: 16..23
  manager.microBounds = { minX: 16, minY: 40, minZ: 16, maxX: 24, maxY: 47, maxZ: 23 };
  manager.microSelection = manager.materializeMicroBox(16, 40, 16, 24, 47, 23);

  controller.deleteSelectionBlocks();

  // Block (2, 5, 2) is deleted as standard block directly
  assert.equal(world.getBlock(2, 5, 2), BlockTypes.AIR);
  assert.equal(world.hasMicroInStandardCell(2, 5, 2), false);

  // Block (3, 5, 2) was subdivided because only layer 0 (x=24) was deleted
  // 512 - 64 = 448 micro voxels must remain in block (3, 5, 2)!
  assert.equal(world.getBlock(3, 5, 2), BlockTypes.AIR);
  assert.equal(world.microVoxels.cells.size, 448);
  // Layer x=24 should be deleted
  assert.equal(world.getMicroBlock(24, 40, 16), null);
  // Layer x=25 should remain
  assert.notEqual(world.getMicroBlock(25, 40, 16), null);
});

test('micro selection fill places standard block for full core and micro blocks for boundary', () => {
  const { controller, manager, world } = createController();

  // Select all of block (4, 20, 4) (micro 32..39, Y 160..167) plus 1 layer on x=40 (inside block 5, 20, 4)
  manager.microBounds = { minX: 32, minY: 160, minZ: 32, maxX: 40, maxY: 167, maxZ: 39 };

  // Fill with color 0x123456
  controller.fillSelectionBlocks(0x123456);

  // Block (4, 20, 4) should be a solid standard block!
  assert.equal(world.getBlock(4, 20, 4), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlockColor(4, 20, 4), 0x123456);
  assert.equal(world.hasMicroInStandardCell(4, 20, 4), false, 'solid standard cell should have no micro voxels');

  // Boundary layer x=40 should have 64 micro voxels placed
  assert.equal(world.microVoxels.cells.size, 64);
  assert.equal(world.getMicroBlock(40, 160, 32)?.color, 0x123456);
});

test('micro selection paint recolors standard block directly without subdivision', () => {
  const { controller, manager, world } = createController();
  // Place standard block at (2, 5, 2) with green 0x00ff00
  world.setBlock(2, 5, 2, BlockTypes.COLOR_BLOCK, false, 0x00ff00);

  // Select entire block (2, 5, 2) in micro mode
  manager.microBounds = { minX: 16, minY: 40, minZ: 16, maxX: 23, maxY: 47, maxZ: 23 };
  manager.microSelection = manager.materializeMicroBox(16, 40, 16, 23, 47, 23);

  // Paint to yellow 0xffff00
  controller.paintSelectionBlocks(0xffff00);

  // Should recolor standard block directly
  assert.equal(world.getBlock(2, 5, 2), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlockColor(2, 5, 2), 0xffff00);
  assert.equal(world.microVoxels.cells.size, 0, 'should remain a standard block without subdivision');
});

test('micro selection paint coalesces 512 microblocks into a single standard block', () => {
  const { controller, manager, world } = createController();
  // Subdivide standard block at (2, 5, 2) so it has 512 microblocks
  world.setBlock(2, 5, 2, BlockTypes.COLOR_BLOCK, false, 0x00ff00);
  world.subdivideBlock(2, 5, 2);
  assert.equal(world.microVoxels.cells.size, 512);

  // Select entire cell in micro mode and paint
  manager.microBounds = { minX: 16, minY: 40, minZ: 16, maxX: 23, maxY: 47, maxZ: 23 };
  manager.microSelection = manager.materializeMicroBox(16, 40, 16, 23, 47, 23);

  controller.paintSelectionBlocks(0x0000ff);

  // Should coalesce into solid standard block of blue 0x0000ff
  assert.equal(world.getBlock(2, 5, 2), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlockColor(2, 5, 2), 0x0000ff);
  assert.equal(world.microVoxels.cells.size, 0, '512 microblocks should coalesce into 0 microblocks and 1 standard block');
});
