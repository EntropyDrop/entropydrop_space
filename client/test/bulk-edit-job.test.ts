import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import {
  BULK_EDIT_MAX_OPERATIONS_PER_FRAME,
  BULK_EDIT_THRESHOLD,
  PlayerController,
  SpecialTool
} from '../src/engine/controls/PlayerController.ts';

function makeController(manager: any, world: any = {}) {
  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectedSubtree = null;
  controller.selectedBlockSelection = null;
  controller.selectorLevel = null;
  controller.selectorRange = null;
  controller.selectorMicroMode = false;
  controller.bulkEditJob = null;
  controller.contraptions = manager;
  controller.world = world;
  controller.inventories = null;
  controller.selectedInventoryIndex = 0;
  controller.sound = {
    playBlockPlace() {},
    playAssemblyClack() {},
    playSteamHiss() {}
  };
  controller.particles = { emitSteamPuff() {} };
  controller.keys = {};
  controller.hoveredContraption = null;
  controller.openCodeEditorForTarget = () => false;
  const toasts: string[] = [];
  const progress: any[] = [];
  controller.ui = {
    showToast: message => toasts.push(message),
    setBulkEditProgress: value => progress.push(value),
    renderInventoryBar() {},
    selectTool() {},
    renderComponentTree() {},
    renderCodeTabs() {},
    updateInspectorProperties() {}
  };
  controller.inventoryCategory();
  controller.__toasts = toasts;
  controller.__progress = progress;
  manager.selectionHost = controller;
  return controller;
}

function clearRegion(world: any, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) {
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) world.setBlock(x, y, z, BlockTypes.AIR, false);
    }
  }
}

function entityBlocks(total: number) {
  return Array.from({ length: total }, (_, index) => ({
    localX: index % 10,
    localY: Math.floor(index / 10) % 10,
    localZ: Math.floor(index / 100),
    size: 1,
    block: BlockTypes.COLOR_BLOCK,
    color: 0x123456,
    entityId: 'root'
  }));
}

test('large world block-set copy uses BulkEditJob and remains read-only', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const manager = new ContraptionManager(scene, world, null, null);
  const controller = makeController(manager, world);
  clearRegion(world, 20, 80, 20, 27, 87, 24);
  world.setBlock(20, 80, 20, BlockTypes.COLOR_BLOCK, false, 0xff0000);
  world.setBlock(27, 87, 24, BlockTypes.COLOR_BLOCK, false, 0x00ff00);
  manager.setCornerA({ x: 20, y: 80, z: 20 });
  manager.setCornerB({ x: 27, y: 87, z: 24 });
  assert.ok(manager.getSelectionBlockCount() > BULK_EDIT_THRESHOLD);

  assert.equal(controller.copySelectionAsBlockSet(), true);
  assert.equal(controller.inventories.blockset.items.filter(Boolean).length, 0, 'copy starts on the next frame');
  controller.processBulkEditFrame(128, Infinity);
  assert.ok(controller.bulkEditJob, 'the scan is sliced across frames');
  while (controller.bulkEditJob) controller.processBulkEditFrame(128, Infinity);

  const slot = controller.inventories.blockset.items.find(Boolean);
  assert.equal(slot.blockCount, 2);
  assert.equal(world.getBlock(20, 80, 20), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlock(27, 87, 24), BlockTypes.COLOR_BLOCK);
  assert.equal(controller.__progress.at(-1).phase, 'complete');
});

test('large entity Hammer placement prepares blocks in BulkEditJob before atomic registration', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const controller = makeController(manager);
  const total = BULK_EDIT_THRESHOLD + 44;
  const slot = {
    rootComponentId: 'root',
    blockCount: total,
    blocks: entityBlocks(total)
  };
  controller.activeTool = SpecialTool.HAMMER;
  controller.setActiveInventoryCategory('entity');
  controller.inventories.entity.items[0] = slot;
  controller.inventories.entity.selected = 0;
  controller.getInventoryPlacementPose = () => ({ position: new THREE.Vector3(30, 40, 30) });

  assert.equal(controller.pasteInventorySlot(), true);
  assert.equal(manager.contraptions.length, 0, 'no partial entity is registered');
  controller.processBulkEditFrame(128, Infinity);
  assert.equal(manager.contraptions.length, 0);
  while (controller.bulkEditJob) controller.processBulkEditFrame(128, Infinity);

  assert.equal(manager.contraptions.length, 1);
  assert.equal(manager.contraptions[0].blocks.length, total);
  assert.equal(controller.__progress.at(-1).phase, 'complete');
});

test('large Hammer component installation prepares blocks before one atomic tree merge', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null) as any;
  const target = manager.buildFromSlot({
    name: 'Target',
    rootComponentId: 'root',
    blockCount: 1,
    blocks: entityBlocks(1),
    childEntities: [],
    scripts: [],
    enabled: [],
    constraints: []
  }, new THREE.Vector3(), null, false);
  target.stopAllNodeScripts();
  const controller = makeController(manager);
  const total = BULK_EDIT_THRESHOLD + 44;
  const slot = {
    name: 'Cargo',
    kind: 'entity',
    rootComponentId: 'root',
    blockCount: total,
    blocks: entityBlocks(total),
    childEntities: [],
    scripts: [],
    enabled: [],
    constraints: []
  };
  controller.activeTool = SpecialTool.HAMMER;
  controller.setActiveInventoryCategory('entity');
  controller.inventories.entity.items[0] = slot;
  controller.inventories.entity.selected = 0;
  controller.getInventoryPlacementPose = () => ({
    position: new THREE.Vector3(12, 0, 0),
    targetContraption: target,
    targetNodeId: 'root'
  });

  assert.equal(controller.pasteInventorySlot(true), true);
  assert.equal(manager.contraptions.length, 1);
  assert.equal(target.blocks.length, 1, 'the target is unchanged while preparation is incomplete');
  controller.processBulkEditFrame(128, Infinity);
  assert.equal(target.blocks.length, 1);
  while (controller.bulkEditJob) controller.processBulkEditFrame(128, Infinity);

  assert.equal(manager.contraptions.length, 1);
  assert.equal(target.blocks.length, total + 1);
  assert.ok(target.getEntityNode('root_2'));
  assert.equal(target.getComponentName('root_2'), 'Cargo');
  assert.equal(controller.__progress.at(-1).phase, 'complete');
});

test('large world assembly extracts through BulkEditJob and commits one complete entity', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const manager = new ContraptionManager(scene, world, null, null);
  const controller = makeController(manager, world);
  clearRegion(world, 20, 80, 20, 27, 87, 24);
  world.setBlock(20, 80, 20, BlockTypes.COLOR_BLOCK, false, 0xff0000);
  world.setBlock(27, 87, 24, BlockTypes.COLOR_BLOCK, false, 0x00ff00);
  manager.setCornerA({ x: 20, y: 80, z: 20 });
  manager.setCornerB({ x: 27, y: 87, z: 24 });

  assert.equal(controller.assembleSelection(), true);
  assert.equal(manager.contraptions.length, 0);
  controller.processBulkEditFrame(128, Infinity);
  assert.equal(manager.contraptions.length, 0, 'entity registration waits for all extraction slices');
  while (controller.bulkEditJob) controller.processBulkEditFrame(128, Infinity);

  assert.equal(manager.contraptions.length, 1);
  assert.equal(manager.contraptions[0].blocks.length, 2);
  assert.equal(world.getBlock(20, 80, 20), BlockTypes.AIR);
  assert.equal(world.getBlock(27, 87, 24), BlockTypes.AIR);
  assert.equal(controller.__progress.at(-1).phase, 'complete');
});

test('large entity block selection creates its child through BulkEditJob', () => {
  const scene = new THREE.Scene();
  const total = BULK_EDIT_THRESHOLD + 44;
  const contraption = new Contraption(1, entityBlocks(total + 10), new THREE.Vector3(), scene);
  contraption.stopAllNodeScripts();
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.registerContraption(contraption);
  const controller = makeController(manager);
  controller.selectedBlockSelection = {
    contraption,
    nodeId: 'root',
    blocks: contraption.blocks.slice(0, total)
  };

  assert.equal(controller.createChildFromSelectedBlocks(), true);
  assert.equal(contraption.childDefinitions.size, 0, 'hierarchy is unchanged until preparation finishes');
  controller.processBulkEditFrame(128, Infinity);
  assert.equal(contraption.childDefinitions.size, 0);
  while (controller.bulkEditJob) controller.processBulkEditFrame(128, Infinity);

  assert.equal(contraption.childDefinitions.size, 1);
  const childId = [...contraption.childDefinitions.keys()][0];
  assert.equal(contraption.blocks.filter(block => block.entityId === childId).length, total);
  assert.equal(controller.__progress.at(-1).phase, 'complete');
});

test('processBulkEditFrame default batch size is 1024 operations per frame', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const controller = makeController(manager);
  const total = 2000;
  const slot = {
    rootComponentId: 'root',
    blockCount: total,
    blocks: entityBlocks(total)
  };
  controller.activeTool = SpecialTool.HAMMER;
  controller.setActiveInventoryCategory('entity');
  controller.inventories.entity.items[0] = slot;
  controller.inventories.entity.selected = 0;
  controller.getInventoryPlacementPose = () => ({ position: new THREE.Vector3(30, 40, 30) });

  assert.equal(BULK_EDIT_MAX_OPERATIONS_PER_FRAME, 1024);
  assert.equal(controller.pasteInventorySlot(), true);
  assert.ok(controller.bulkEditJob);
  // Default call with no maxOperations argument uses BULK_EDIT_MAX_OPERATIONS_PER_FRAME (1024)
  controller.processBulkEditFrame(undefined, Infinity);
  assert.equal(controller.bulkEditJob.processed, 1024);
  controller.processBulkEditFrame(undefined, Infinity);
  assert.equal(controller.bulkEditJob, null, 'finished processing in 2 frames (1024 + 976)');
  assert.equal(manager.contraptions.length, 1);
  assert.equal(manager.contraptions[0].blocks.length, total);
});
