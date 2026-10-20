import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

function makeController(tool: string = SpecialTool.SELECTOR) {
  const scene = new THREE.Scene();
  const world = new World(scene);
  const manager = new ContraptionManager(scene, world, null, null);
  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = tool;
  controller.world = world;
  controller.contraptions = manager;
  controller.keys = {};
  controller.hoveredContraptionHit = null;
  controller.currentRaycast = { hit: false };
  const ui = new SpaceUiStore();
  (ui as any).patch({ controller, contraptions: manager });
  controller.ui = ui;
  return { controller, manager, world, scene, ui };
}

function focusWorldMicro(controller: any, x: number) {
  controller.currentRaycast = { hit: true, kind: 'micro',
    hitPos: { x: x / 8, y: 80, z: 2 }, microPos: { x, y: 640, z: 16 },
    normal: { x: 0, y: 1, z: 0 } };
}

for (const tool of new Set([SpecialTool.SELECTOR, SpecialTool.SUPER_GLUE])) {
  test(`${tool} automatically selects a focused terrain micro voxel on the micro grid`, () => {
    const { controller, world, manager, ui } = makeController(tool);
    world.setBlock(1, 80, 2, BlockTypes.AIR);
    for (const x of [10, 11, 12]) world.setMicroBlock(x, 640, 16, 0x48dbfb);
    focusWorldMicro(controller, 10);
    controller.handleLeftClick();
    assert.equal(controller.selectorMicroMode, true);
    assert.equal(ui.getSnapshot().selector.micro, true);
    assert.deepEqual(manager.selectionCornerA, { x: 10, y: 640, z: 16, micro: true });
    focusWorldMicro(controller, 11);
    controller.handleLeftClick();
    assert.deepEqual(manager.microSelection, [{ x: 10, y: 640, z: 16 }, { x: 11, y: 640, z: 16 }]);
    assert.equal(manager.hasValidSelection(), true);
    assert.equal(world.getMicroBlock(12, 640, 16)?.color, 0x48dbfb, 'selection leaves the adjacent micro voxel untouched');
  });
}

test('a micro second corner promotes the existing world box and shape anchor without restarting it', () => {
  const { controller, manager, world } = makeController();
  world.setBlock(1, 80, 2, BlockTypes.AIR);
  world.setMicroBlock(10, 640, 16, 0x48dbfb);
  controller.currentRaycast = { hit: true, kind: 'standard',
    hitPos: { x: 1, y: 80, z: 2 }, normal: { x: 0, y: 1, z: 0 } };
  controller.handleLeftClick();
  assert.equal(controller.selectorMicroMode, false);
  assert.deepEqual(manager.selectionCornerA, { x: 1, y: 80, z: 2 });
  focusWorldMicro(controller, 10);
  controller.handleLeftClick();
  assert.equal(controller.selectorMicroMode, true);
  assert.deepEqual(controller.selectionShapeAnchor, {
    cornerA: { x: 8, y: 640, z: 16 }, cornerB: { x: 10, y: 640, z: 16 }, micro: true,
  });
  assert.deepEqual(manager.getMicroSelectionBounds(), {
    minX: 8, maxX: 10, minY: 640, maxY: 640, minZ: 16, maxZ: 16,
  });
  assert.equal(manager.hasValidSelection(), true, 'the second click must complete the original box');
});

function makeEntity(scene: THREE.Scene) {
  const entity = new Contraption(1, [
    { localX: 4, localY: 0, localZ: 0, size: 1, entityId: 'root', block: BlockTypes.COLOR_BLOCK },
    { localX: 0.25, localY: 0, localZ: 0, size: 0.125, entityId: 'root', block: BlockTypes.COLOR_BLOCK },
    { localX: 0.375, localY: 0, localZ: 0, size: 0.125, entityId: 'root', block: BlockTypes.COLOR_BLOCK },
  ], new THREE.Vector3(0, 10, 0), scene);
  entity.stopAllNodeScripts();
  return entity;
}

function focusEntityBlock(controller: any, entity: Contraption, index: number, kind?: string) {
  controller.hoveredContraptionHit = { contraption: entity, entityId: 'root', block: entity.blocks[index],
    point: entity.getBlockWorldCenter(entity.blocks[index]), ...(kind ? { kind } : {}) };
}

test('an Entity micro voxel enables MICRO even when the hit only identifies its voxel size', () => {
  const { controller, scene, ui } = makeController();
  const entity = makeEntity(scene);
  try {
    focusEntityBlock(controller, entity, 1);
    controller.handleLeftClick();
    assert.equal(controller.selectorMicroMode, true);
    assert.equal(ui.getSnapshot().selector.micro, true);
    assert.ok(controller.selectorRange?.pointA);
    focusEntityBlock(controller, entity, 2);
    controller.handleLeftClick();
    assert.equal(controller.selectedBlockSelection.micro, true);
    assert.equal(controller.selectedBlockSelection.blocks.length, 2);
    assert.equal(controller.selectedBlockSelection.blocks.every((block: { size: number }) => block.size === 0.125), true);
    assert.equal(controller.canUseSelectionActions(), true);
  } finally { entity.dispose(); }
});

test('a micro second Entity corner preserves the first point and selects virtual micro cells of standard geometry', () => {
  const { controller, scene } = makeController();
  const entity = makeEntity(scene);
  try {
    focusEntityBlock(controller, entity, 0, 'standard');
    controller.handleLeftClick();
    const pointA = controller.selectorRange.pointA;
    assert.equal(controller.selectorMicroMode, false);
    focusEntityBlock(controller, entity, 1, 'micro');
    controller.handleLeftClick();
    assert.equal(controller.selectorMicroMode, true);
    assert.deepEqual(controller.selectedBlockSelection.confirmedRange.pointA, { ...pointA });
    assert.equal(controller.selectedBlockSelection.micro, true);
    assert.ok(controller.selectedBlockSelection.blocks.some((block: { virtualMicro?: boolean }) => block.virtualMicro));
    assert.equal(entity.blocks[0].size, 1, 'automatic selection must not subdivide source geometry');
  } finally { entity.dispose(); }
});

test('running Entities and rejected cross-domain corners do not change the selection mode', () => {
  const { controller, scene, manager } = makeController();
  const entity = makeEntity(scene);
  try {
    entity.setPhysicsSimulationEnabled(true);
    focusEntityBlock(controller, entity, 1, 'micro');
    controller.handleLeftClick();
    assert.equal(controller.selectorMicroMode, false);
    assert.equal(controller.selectorRange, null);
    entity.stopAllNodeScripts();
    manager.selectionCornerA = { x: 1, y: 80, z: 2 };
    controller.handleLeftClick();
    assert.equal(controller.selectorMicroMode, false);
    assert.equal(manager.selectionCornerA, null, 'cross-domain boxes still reject the second corner');
  } finally { entity.dispose(); }
});

test('focusing a standard block keeps standard mode and does not switch an existing micro box back', () => {
  const { controller } = makeController();
  controller.currentRaycast = { hit: true, kind: 'standard',
    hitPos: { x: 1, y: 80, z: 2 }, entry: { x: 1.5, y: 81, z: 2.5 }, normal: { x: 0, y: 1, z: 0 } };
  controller.handleLeftClick();
  assert.equal(controller.selectorMicroMode, false);
  controller.clearSelection();
  focusWorldMicro(controller, 10);
  controller.handleLeftClick();
  controller.currentRaycast = { hit: true, kind: 'standard',
    hitPos: { x: 1, y: 80, z: 2 }, entry: { x: 1.5, y: 81, z: 2.5 }, normal: { x: 0, y: 1, z: 0 } };
  controller.handleLeftClick();
  assert.equal(controller.selectorMicroMode, true);
});
