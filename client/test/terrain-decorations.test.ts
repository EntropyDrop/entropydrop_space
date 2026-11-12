import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { getWorldProjection, setWorldProjection } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { ModelingTool } from '../src/engine/controls/ModelingTool.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { rotateAnchoredDecorations, rotateBlocksX90, rotateBlocksY90 } from '../src/engine/inventory/InventoryRotation.ts';

const near = (actual: ArrayLike<number>, expected: ArrayLike<number>, label = '') => {
  for (let index = 0; index < expected.length; index++) {
    assert.ok(Math.abs(actual[index] - expected[index]) < 1e-6, `${label} ${Array.from(actual)} ≈ ${Array.from(expected)}`);
  }
};

function modelingFixture() {
  const world = new World(new THREE.Scene()) as any;
  world.setBlock(3, 40, 3, BlockTypes.COLOR_BLOCK, false);
  const toasts: string[] = [];
  const controller: any = { contraptions: { contraptions: [] }, world, selectedColor: 0x112233, selectedMaterialId: 0,
    ui: { showToast: (message: string) => toasts.push(message) }, canEditEntityInternals: () => true,
    handleRunningEntityInteraction: () => false };
  const tool = new ModelingTool(controller);
  const aim = (kind: 'standard' | 'micro' = 'standard') => (tool as any).updateTarget({ kind: 'world', worldHit: {
    kind, hitPos: { x: 3, y: 40, z: 3 }, normal: { x: 0, y: 1, z: 0 }, entry: { x: 3.5, y: 41, z: 3.5 }, distance: 2,
  } }, new THREE.Vector3(3.5, 43, 3.5), new THREE.Vector3(0, -1, 0));
  return { world, tool, toasts, aim };
}

test('modeling on a standard terrain block binds the decoration to that block', () => {
  const f = modelingFixture();
  try {
    f.aim();
    assert.deepEqual(f.tool.placement?.target, { terrain: { x: 3, y: 40, z: 3 } });
    near(f.tool.placement!.value.position!, [0, 0.75, 0], 'centre above the top face');
    assert.equal(f.tool.create(), true);
    const [stored] = f.world.terrainDecorations.atAnchor(3, 40, 3);
    assert.equal(stored.color, 0x112233);
    assert.deepEqual(f.tool.getSelection()?.terrain, { x: 3, y: 40, z: 3 });
    assert.equal(f.tool.change({ scale: [2, 0.25, 1] }), true);
    assert.equal(f.tool.change({ position: [0, 17, 0] }), false, 'terrain offsets stay within 16 m');
    assert.ok(f.toasts.some(message => /within ±16/.test(message)));
    assert.equal(f.tool.duplicate(), true);
    assert.equal(f.world.terrainDecorations.atAnchor(3, 40, 3).length, 2);
    assert.equal(f.tool.remove(), true);
    assert.equal(f.tool.undo(), true);
    assert.equal(f.world.terrainDecorations.atAnchor(3, 40, 3).length, 2);
    assert.equal(f.tool.undo(true), true);
    assert.equal(f.world.terrainDecorations.atAnchor(3, 40, 3).length, 1);
    f.world.setBlock(3, 40, 3, BlockTypes.AIR, false);
    assert.equal(f.world.terrainDecorations.size, 0, 'removing the block removes its decorations');
    assert.equal(f.tool.getSelection(), null);
    assert.equal(f.tool.undo(), false, 'an edit whose block is gone cannot be undone');
  } finally { f.tool.deactivate(); }
});

test('micro voxels cannot carry decorations', () => {
  const f = modelingFixture();
  f.aim('micro');
  assert.equal(f.tool.placement, null);
  assert.equal(f.tool.create(), false);
  assert.ok(f.toasts.some(message => /standard terrain block/.test(message)));
});

test('terrain decorations are picked in the near view and selected with LMB', () => {
  const previous = getWorldProjection();
  setWorldProjection('flat');
  const f = modelingFixture();
  try {
    f.world.setTerrainDecoration({ id: 'd_sign', x: 3, y: 40, z: 3, color: 1, position: [0, 0.75, 0], scale: [0.5, 0.5, 0.5] });
    f.world.terrainDecorationMeshes.sync(null);
    f.aim();
    assert.deepEqual(f.tool.hovered?.terrain, { x: 3, y: 40, z: 3 });
    assert.equal(f.tool.hovered?.decorationId, 'd_sign');
    assert.equal(f.tool.selectHovered(), true);
    assert.equal(f.tool.getSelection()?.decorationId, 'd_sign');
    f.world.terrainDecorationMeshes.sync(new Set(['9,9']));
    f.aim();
    assert.equal(f.tool.hovered, null, 'chunks outside the near window are not pickable');
  } finally { f.tool.deactivate(); setWorldProjection(previous); }
});

test('rotated block sets keep each decoration on its voxel with a rigidly rotated pose', () => {
  const blocks = [{ dx: 0, dy: 0, dz: 0, size: 1 }, { dx: 2, dy: 1, dz: 0, size: 1 }, { dx: 1, dy: 0, dz: 3, size: 1 }];
  const decorations = [{ dx: 2, dy: 1, dz: 0, color: 1, position: [0.6, 0, 0.2] as [number, number, number] }];
  const center = (block: { dx?: number; dy?: number; dz?: number }, offset = [0, 0, 0]) =>
    new THREE.Vector3(Number(block.dx) + 0.5 + offset[0], Number(block.dy) + 0.5 + offset[1], Number(block.dz) + 0.5 + offset[2]);
  for (const [turnsX, turnsY] of [[0, 1], [0, 2], [1, 0], [1, 3], [2, 1], [3, 3]]) {
    let rotated: any[] = blocks;
    if (turnsX) rotated = rotateBlocksX90(rotated, turnsX);
    if (turnsY) rotated = rotateBlocksY90(rotated, turnsY);
    const [value] = rotateAnchoredDecorations(blocks, decorations, turnsX, turnsY)!;
    assert.deepEqual([value.dx, value.dy, value.dz], [rotated[1].dx, rotated[1].dy, rotated[1].dz]);
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -turnsY * Math.PI / 2)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), turnsX * Math.PI / 2));
    const before = center(decorations[0], decorations[0].position).sub(center(blocks[0])).applyQuaternion(rotation);
    const after = center(value, value.position).sub(center(rotated[0]));
    near(after.toArray(), before.toArray(), `turns ${turnsX},${turnsY}`);
  }
});

function copyFixture() {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const manager = new ContraptionManager(scene, world, null, null);
  const toasts: string[] = [];
  const controller: any = Object.assign(Object.create(PlayerController.prototype), {
    _activeTool: SpecialTool.SELECTOR, world, contraptions: manager, keys: {},
    sound: { playBlockBreak() {}, playWrenchClick() {} },
    ui: { showToast: (message: string) => toasts.push(message), renderInventoryBar() {}, notifyContraptionStructureChanged() {} },
  });
  manager.selectionHost = controller;
  controller.inventoryCategory();
  return { controller, world, manager, toasts };
}

test('cutting world blocks carries their decorations, and pasting the Item rebinds them rotated', () => {
  const f = copyFixture();
  for (const x of [10, 11, 13]) f.world.setBlock(x, 80, 10, BlockTypes.COLOR_BLOCK, false, 0xff0000);
  f.world.setTerrainDecoration({ id: 'd_in', x: 11, y: 80, z: 10, color: 7, position: [0.6, 0, 0], scale: [0.2, 1, 1] });
  f.world.setTerrainDecoration({ id: 'd_out', x: 13, y: 80, z: 10, color: 8 });
  f.manager.setCornerA({ x: 10, y: 80, z: 10 });
  f.manager.setCornerB({ x: 13, y: 80, z: 10 });
  f.manager.connectedSelection = [{ x: 10, y: 80, z: 10 }, { x: 11, y: 80, z: 10 }];
  f.controller.handleKeyDown({ code: 'KeyX', preventDefault() {} });
  const copied = f.controller.inventories.item.items[0];
  assert.deepEqual(copied.blockSet.anchoredDecorations, [
    { dx: 1, dy: 0, dz: 0, color: 7, position: [0.6, 0, 0], scale: [0.2, 1, 1] },
  ]);
  assert.deepEqual([...f.world.terrainDecorations.all()].map((value: any) => value.id), ['d_out'],
    'cutting removes the voxel and its decoration, leaving unselected ones');

  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  assert.equal(f.controller.pasteCompositeItem(copied, false, { position: new THREE.Vector3(20, 80, 10), quaternion: rotation }), true);
  const [placed] = f.world.terrainDecorations.atAnchor(20, 80, 8);
  assert.ok(placed, 'the decoration binds to the rotated copy of its block');
  assert.equal(f.world.getBlock(20, 80, 8), BlockTypes.COLOR_BLOCK);
  near(placed.position, [0, 0, -0.6]);
  near(placed.rotation, rotation.toArray());
});
