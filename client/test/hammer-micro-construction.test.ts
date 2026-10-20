import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MAX_INVENTORY_BLOCKS } from '@entropydrop/space-engine/constants/SpaceConstants.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import type { InventoryInput, InventoryVoxel } from '@entropydrop/space-engine/storage/InventoryTypes.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { getInventoryPreviewBlocks } from '../src/engine/inventory/InventoryGeometry.ts';
import { toMicroPlacementItem } from '../src/engine/inventory/InventoryMicroPlacement.ts';

function standardBlockSet(): InventoryInput {
  return { kind: 'blockset', name: 'Standard cube', blockCount: 1,
    blocks: [{ dx: 0, dy: 0, dz: 0, size: 1, color: 0x48dbfb, materialId: 1 }] };
}

function entitySlot(): InventoryInput {
  return { kind: 'entity', name: 'Module', rootComponentId: 'root', blockCount: 2,
    blocks: [
      { localX: 0, localY: 0, localZ: 0, size: 1, entityId: 'root', color: 0x48dbfb, materialId: 1, block: BlockTypes.COLOR_BLOCK },
      { localX: 1, localY: 0, localZ: 0, size: 1, entityId: 'root', color: 0x123456, block: BlockTypes.COLOR_BLOCK },
    ],
    childEntities: [{ id: 'arm', parentId: 'root', pivot: [1.5, 0.5, 0.5], blockKeys: ['1,0,0'] }],
    scripts: [{ id: 'root', code: 'export function update(): void {}', language: 'assemblyscript' }],
    constraints: [], enabled: [{ id: 'root', enabled: false }],
  };
}

function makeController(slot: InventoryInput) {
  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.HAMMER;
  controller.inventorySlots = [slot];
  controller.selectedInventoryIndex = 0;
  controller.hammerMicroMode = true;
  controller.world = {};
  controller.currentRaycast = { hit: true, kind: 'standard', hitPos: { x: 4, y: 5, z: -3 },
    entry: { x: 4.46, y: 6, z: -2.27 }, normal: { x: 0, y: 1, z: 0 } };
  controller.hoveredContraptionHit = null;
  controller.activateTool = () => {};
  const toasts: string[] = [];
  controller.ui = { showToast(message: string) { toasts.push(message); } };
  return { controller, toasts };
}

function finishBulkJob(controller: any) {
  let frames = 0;
  while (controller.bulkEditJob) {
    assert.ok(frames++ < 100, 'construction must finish within its bounded frame slices');
    controller.processBulkEditFrame(128, Infinity);
  }
}

function bounds(slot: InventoryInput) {
  const blocks = getInventoryPreviewBlocks(slot);
  return (['x', 'y', 'z'] as const).flatMap(axis => [
    Math.min(...blocks.map(block => block.center[axis] - block.size / 2)),
    Math.max(...blocks.map(block => block.center[axis] + block.size / 2)),
  ]);
}

test('micro construction subdivides a standard cube into 512 cells without changing bounds or appearance', () => {
  const slot = standardBlockSet();
  slot.blocks![0].dx = -2;
  slot.blocks![0].part = 'stone';
  const original = structuredClone(slot);
  const converted = toMicroPlacementItem(slot);
  assert.equal(converted.blocks?.length, 512);
  assert.equal(new Set(converted.blocks!.map(block => `${block.dx},${block.dy},${block.dz}`)).size, 512);
  assert.deepEqual(bounds(converted), bounds(slot));
  for (const block of converted.blocks!) {
    assert.equal(block.size, 0.125);
    assert.equal(block.color, 0x48dbfb);
    assert.equal(block.materialId, 1);
    assert.equal(block.part, 'stone');
  }
  assert.deepEqual(slot, original);
  assert.equal(toMicroPlacementItem(converted), converted, 'converted micro cells must not be subdivided twice');
});

test('mixed Items convert their static and Entity voxels while preserving component transforms and scripts', () => {
  const blockSet = standardBlockSet();
  const entity = { ...entitySlot(), itemPosition: [3, 0, 0], itemRotation: [0, 0, 0, 1] };
  const item: InventoryInput = { kind: 'item', name: 'Mixed', blockSet: blockSet as any, entityList: [entity as any],
    blocks: [...blockSet.blocks!, ...entity.blocks!] };
  const original = structuredClone(item);
  const converted = toMicroPlacementItem(item);
  assert.equal(converted.blocks?.length, 1536);
  assert.equal(converted.blockSet?.blocks.length, 512);
  const module = converted.entityList![0];
  assert.equal(module.blocks.length, 1024);
  assert.equal(module.blocks.filter(block => block.entityId === 'arm').length, 512, 'legacy ownership applies to every subdivided cell');
  assert.deepEqual(module.scripts, entity.scripts);
  assert.deepEqual(module.childEntities[0].pivot, entity.childEntities![0].pivot);
  assert.deepEqual(module.itemPosition, entity.itemPosition);
  assert.deepEqual(bounds(converted), bounds(item));
  assert.deepEqual(item, original);
});

test('micro construction uses a cached temporary item, then restores the original standard item and rotation', () => {
  const slot = standardBlockSet();
  const { controller } = makeController(slot);
  controller.hammerRotationTurnsY = 1;
  const converted = controller.getActiveHammerInventoryItem();
  assert.equal(converted.blocks.length, 512);
  assert.equal(controller.getActiveHammerInventoryItem(), converted, 'hover updates reuse conversion and rotation');
  controller.updateInventoryPlacementPreview();
  assert.equal(controller.inventoryPlacementPreview.slot, converted);
  assert.deepEqual(controller.inventoryPlacementPreview.position.toArray(), [4.375, 6, -2.375]);
  controller.toggleHammerMicroMode();
  const standard = controller.getActiveHammerInventoryItem();
  assert.equal(standard.blocks.length, 1);
  assert.equal(standard.blocks[0].size, 1);
  assert.equal(controller.hammerRotationTurnsY, 1);
  assert.deepEqual(controller.inventorySlots[0], slot);
});

test('all 512 terrain writes match the rotated micro ghost and remain fixed if Tab changes during a bulk job', () => {
  const { controller } = makeController(standardBlockSet());
  controller.hammerRotationTurnsX = 1;
  controller.hammerRotationTurnsY = 1;
  controller.updateInventoryPlacementPreview();
  const pose = controller.inventoryPlacementPreview;
  const expected = new Set(pose.slot.blocks.map((block: InventoryVoxel) => [
    Math.round((pose.position.x + block.dx) * 8),
    Math.round((pose.position.y + block.dy) * 8),
    Math.round((pose.position.z + block.dz) * 8),
  ].join(',')));
  const actual: string[] = [];
  controller.performBasicAction = (action: any) => {
    assert.equal(action.action, 'place-micro');
    actual.push(action.micro.join(','));
    return { placed: 1 };
  };
  assert.equal(controller.pasteInventorySlot(), true);
  assert.ok(controller.bulkEditJob, 'subdivision uses existing frame-sliced construction');
  controller.processBulkEditFrame(128, Infinity);
  assert.equal(actual.length, 128);
  controller.toggleHammerMicroMode();
  finishBulkJob(controller);
  assert.equal(actual.length, 512);
  assert.deepEqual(new Set(actual), expected);
});

test('mixed Item construction writes micro terrain and builds Entity trees with converted voxels', () => {
  const blockSet = standardBlockSet();
  const entity = { ...entitySlot(), itemPosition: [3, 0, 0], itemRotation: [0, 0, 0, 1] };
  const item: InventoryInput = { kind: 'item', name: 'Mixed', blockSet: blockSet as any, entityList: [entity as any],
    blocks: [...blockSet.blocks!, ...entity.blocks!] };
  const { controller } = makeController(item);
  controller.updateInventoryPlacementPreview();
  const preview = controller.inventoryPlacementPreview;
  let writes = 0;
  let built: InventoryInput | null = null;
  controller.performBasicAction = (action: any) => {
    if (action.action === 'place-micro') writes++;
    else assert.equal(action.action, 'start-scripts');
    return { placed: 1 };
  };
  controller.finishEntitySlotBuild = (slot: InventoryInput, pose: any) => {
    built = slot;
    assert.ok(pose.position.distanceTo(preview.position.clone().add(new THREE.Vector3(3, 0, 0))) < 1e-8);
    return {};
  };
  controller.contraptions = {};
  assert.equal(controller.pasteInventorySlot(), true);
  finishBulkJob(controller);
  assert.equal(writes, 512);
  assert.equal((built as InventoryInput | null)?.blocks?.length, 1024);
  assert.equal((built as InventoryInput | null)?.blocks?.every(block => block.size === 0.125), true);
  assert.equal(item.blockSet!.blocks.length, 1);
  assert.equal(item.entityList![0].blocks.length, 2);
});

test('converted standard terrain is stored as real micro voxels at fractional placement coordinates', () => {
  const { controller } = makeController(standardBlockSet());
  const world = new World(new THREE.Scene());
  controller.world = world;
  controller.currentRaycast = { hit: true, kind: 'standard', hitPos: { x: 10, y: 79, z: 20 },
    entry: { x: 10.46, y: 80, z: 20.73 }, normal: { x: 0, y: 1, z: 0 } };
  // Explicitly empty every parent cell touched by the shifted one-metre cube.
  for (const x of [10, 11]) for (const z of [20, 21]) world.setBlock(x, 80, z, BlockTypes.AIR);
  controller.updateInventoryPlacementPreview();
  const origin = controller.inventoryPlacementPreview.position;
  assert.deepEqual(origin.toArray(), [10.375, 80, 20.625]);
  assert.equal(controller.pasteInventorySlot(), true);
  finishBulkJob(controller);
  for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) for (let z = 0; z < 8; z++) {
    const voxel = world.getMicroBlock(origin.x * 8 + x, origin.y * 8 + y, origin.z * 8 + z);
    assert.equal(voxel?.color, 0x48dbfb);
    assert.equal(voxel?.materialId, 1);
  }
  assert.equal(world.getMicroBlock(origin.x * 8 - 1, origin.y * 8, origin.z * 8), null);
  for (const x of [10, 11]) for (const z of [20, 21]) assert.equal(world.getBlock(x, 80, z), BlockTypes.AIR);
});

test('installing a converted Entity keeps its hierarchy, authored size and exact micro preview pose', () => {
  const { controller } = makeController(entitySlot());
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null);
  const target = manager.buildFromSlot({ ...entitySlot(), blocks: [entitySlot().blocks![0]], childEntities: [], scripts: [] },
    new THREE.Vector3(10, 3, 4), null, false)!;
  target.stopAllNodeScripts();
  controller.contraptions = manager;
  controller.hoveredContraptionHit = {
    contraption: target, entityId: 'root', point: new THREE.Vector3(10.5, 4, 4.5),
    normal: new THREE.Vector3(0, 1, 0), worldNormal: new THREE.Vector3(0, 1, 0),
  };
  controller.updateInventoryPlacementPreview();
  const pose = controller.inventoryPlacementPreview;
  try {
    assert.equal(controller.pasteInventorySlot(), true);
    finishBulkJob(controller);
    const installed = target.blocks.filter(block => block.entityId !== 'root');
    assert.equal(installed.length, 1024);
    assert.equal(installed.every(block => block.size === 0.125), true);
    assert.ok(target.getEntityNode('root_2'));
    assert.ok(target.getEntityNode('arm'));
    const actual = new THREE.Box3().setFromPoints(installed.flatMap(block => {
      const center = target.getBlockWorldCenter(block);
      return [center.clone().addScalar(-0.0625), center.clone().addScalar(0.0625)];
    }));
    const expected = new THREE.Box3().setFromPoints(getInventoryPreviewBlocks(pose.slot).flatMap(block => {
      const center = block.center.clone().applyQuaternion(pose.quaternion).add(pose.position);
      return [center.clone().addScalar(-0.0625), center.clone().addScalar(0.0625)];
    }));
    assert.ok(actual.min.distanceTo(expected.min) < 1e-8);
    assert.ok(actual.max.distanceTo(expected.max) < 1e-8);
    assert.equal(target.isPhysicsSimulationEnabled(), false);
  } finally { target.dispose(); }
});

test('oversized conversion is rejected before allocating voxels or mutating terrain', () => {
  const slot = standardBlockSet();
  slot.blocks = Array.from({ length: MAX_INVENTORY_BLOCKS / 512 + 1 }, (_, index) => ({ dx: index, dy: 0, dz: 0, size: 1 }));
  assert.throws(() => toMicroPlacementItem(slot), /65,536 voxel limit/);
  const { controller, toasts } = makeController(slot);
  controller.performBasicAction = () => assert.fail('oversized conversion must not edit the world');
  controller.updateInventoryPlacementPreview();
  assert.equal(controller.inventoryPlacementPreview, null);
  assert.equal(controller.pasteInventorySlot(), false);
  assert.match(toasts.at(-1)!, /65,536 voxel limit/);
  assert.equal(controller.bulkEditJob, undefined);
  controller.toggleHammerMicroMode();
  assert.ok(controller.getActiveHammerInventoryItem(), 'the original Item remains usable in standard mode');
});
