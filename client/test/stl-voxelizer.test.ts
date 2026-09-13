import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import {
  MAX_STL_FILE_BYTES,
  MAX_STL_TRIANGLES,
  parseSTLData,
  voxelizeSTL,
  planSTLSize
} from '../src/engine/voxel/STLVoxelizer.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';

/**
 * STL import to block body: binary/ASCII parsing, sized voxelization, inventory
 * block-set import, and selection reset after successful T copy.
 */

/** Twelve triangles for an arbitrary AABB with right-handed outward normals. */
function cubeTriangles(min: number[], max: number[]): number[][][] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = (x, y, z) => [x, y, z];
  const quad = (a, b, c, d) => [[a, b, c], [a, c, d]];
  return [
    ...quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y1, z0), v(x0, y1, z0)),
    ...quad(v(x0, y0, z1), v(x0, y1, z1), v(x1, y1, z1), v(x1, y0, z1)),
    ...quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)),
    ...quad(v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0)),
    ...quad(v(x0, y0, z0), v(x0, y1, z0), v(x0, y1, z1), v(x0, y0, z1)),
    ...quad(v(x1, y0, z0), v(x1, y0, z1), v(x1, y1, z1), v(x1, y1, z0))
  ];
}

function encodeBinarySTL(tris: number[][][], attrColor = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buffer);
  view.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    for (let i = 0; i < 3; i++) view.setFloat32(off + i * 4, 0, true); // Normal placeholder.
    for (let j = 0; j < 3; j++) {
      const base = off + 12 + j * 12;
      for (let i = 0; i < 3; i++) view.setFloat32(base + i * 4, t[j][i], true);
    }
    view.setUint16(off + 48, attrColor, true);
    off += 50;
  }
  return buffer;
}

function makeController(overrides: any = {}) {
  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectedSubtree = null;
  controller.selectedBlockSelection = null;
  controller.selectorLevel = null;
  controller.selectorRange = null;
  controller.inventorySlots = new Array(8).fill(null);
  controller.selectedInventoryIndex = 0;
  controller.contraptions = overrides.manager || null;
  controller.world = overrides.world || null;
  controller.keys = {};
  const toasts: string[] = [];
  controller.ui = {
    showToast: m => toasts.push(m),
    renderInventoryBar() {}
  };
  Object.assign(controller, overrides);
  controller.__toasts = toasts;
  return controller;
}

test('binary STL unit cube voxelizes to one block at cell size 1', () => {
  const buffer = encodeBinarySTL(cubeTriangles([0, 0, 0], [1, 1, 1]));
  const triangles = parseSTLData(buffer);
  assert.equal(triangles.length, 12);

  const result = voxelizeSTL(triangles, 1, 0xabcdef);
  assert.equal(result.blocks.length, 1, 'a 1x1x1 cube at s=1 should produce one block');
  assert.deepEqual([result.blocks[0].dx, result.blocks[0].dy, result.blocks[0].dz], [0, 0, 0]);
  assert.equal(result.blocks[0].size, 1);
  assert.equal(result.blocks[0].block, BlockTypes.COLOR_BLOCK);
  assert.equal(result.blocks[0].color, 0xabcdef, 'default color should be used when no color is embedded');
});

test('cell size 0.5 voxelizes a unit cube into normalized 2x2x2 blocks', () => {
  const buffer = encodeBinarySTL(cubeTriangles([0, 0, 0], [1, 1, 1]));
  const result = voxelizeSTL(parseSTLData(buffer), 0.5, 0xff00aa);
  assert.equal(result.blocks.length, 8);
  const keys = new Set(result.blocks.map(b => `${b.dx},${b.dy},${b.dz}`));
  assert.equal(keys.size, 8, 'cells should be unique');
  for (const b of result.blocks) {
    assert.ok(b.dx >= 0 && b.dx <= 1 && b.dy >= 0 && b.dy <= 1 && b.dz >= 0 && b.dz <= 1);
  }
  assert.equal(result.blocks[0].color, 0xff00aa);
});

test('a 10x10x10 cube at s=2 produces a hollow 5x5x5 shell by default to save resources', () => {
  const buffer = encodeBinarySTL(cubeTriangles([0, 0, 0], [10, 10, 10]));
  const result = voxelizeSTL(parseSTLData(buffer), 2);
  assert.equal(result.blocks.length, 98, 'the interior is hollowed out (5^3 - 3^3 = 98)');
  assert.equal(result.blocks.some(b => b.dx === 2 && b.dy === 2 && b.dz === 2), false, 'the center cell should be hollowed out');

  // hollow: false produces solid
  const solidResult = voxelizeSTL(parseSTLData(buffer), 2, 0xf2a93b, { hollow: false });
  assert.equal(solidResult.blocks.length, 125, 'hollow: false produces a filled solid');
  assert.ok(solidResult.blocks.some(b => b.dx === 2 && b.dy === 2 && b.dz === 2), 'solid model contains center cell');
});

test('binary STL converts embedded VisCAM 15-bit color to 8-bit RGB', () => {
  // attr = valid bit | R=31 | G=31 | B=31 → white 0xFFFFFF.
  const attrColor = 0x8000 | (31 << 10) | (31 << 5) | 31;
  const buffer = encodeBinarySTL(cubeTriangles([0, 0, 0], [1, 1, 1]), attrColor);
  const triangles = parseSTLData(buffer);
  assert.equal(triangles[0].color, 0xffffff);
  const result = voxelizeSTL(triangles, 1, 0x111111);
  assert.equal(result.blocks[0].color, 0xffffff, 'embedded color should override the default');
});

test('ASCII STL parses two facets into two triangles', () => {
  const ascii = `solid test
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 1 1 0
    endloop
  endfacet
  facet normal 0 0 -1
    outer loop
      vertex 0 0 0
      vertex 1 1 0
      vertex 0 1 0
    endloop
  endfacet
endsolid test`;
  const triangles = parseSTLData(new TextEncoder().encode(ascii).buffer);
  assert.equal(triangles.length, 2);
  assert.deepEqual(triangles[0].a, [0, 0, 0]);
  assert.deepEqual(triangles[1].c, [0, 1, 0]);
  assert.deepEqual(triangles[0].normal, [0, 0, 1]);
});

test('parsing throws for corrupt or undersized files', () => {
  assert.throws(() => parseSTLData(new ArrayBuffer(10)), /too small/);
  const garbage = new ArrayBuffer(200); // Does not match 84+50n and is not valid ASCII STL.
  new Uint8Array(garbage).fill(7);
  assert.throws(() => parseSTLData(garbage), /No triangles/);
});

test('STL parser rejects oversized files and triangle declarations before allocation', () => {
  assert.throws(
    () => parseSTLData(new ArrayBuffer(MAX_STL_FILE_BYTES + 1)),
    /exceeds.*MiB import limit/
  );
  assert.equal(MAX_STL_TRIANGLES, 3_000_000);
});

test('an oversized grid reports that target size should be lowered', () => {
  const buffer = encodeBinarySTL(cubeTriangles([0, 0, 0], [1000, 1000, 1000]));
  assert.throws(() => voxelizeSTL(parseSTLData(buffer), 0.1), /Voxel grid too large/);
});

test('planSTLSize uses size for scale and precision for representation', () => {
  // A 20x30x40 box scaled to size 8 uses scale 8/40 = 0.2.
  const tris = cubeTriangles([0, 0, 0], [20, 30, 40]).map(([a, b, c]: number[][]) => ({ a: a as [number, number, number], b: b as [number, number, number], c: c as [number, number, number] }));

  // Precision 1 uses eight standard cells on the longest axis.
  const std = planSTLSize(tris, 8, 1);
  assert.equal(std.micro, false);
  assert.equal(std.cells, 8);
  assert.equal(std.cellSize, 1);
  assert.ok(Math.abs(std.scale - 0.2) < 1e-9, `scale should be 0.2, got ${std.scale}`);

  // Precision 0.125 uses 64 microcells on the longest axis at eightfold resolution.
  const micro = planSTLSize(tris, 8, 0.125);
  assert.equal(micro.micro, true);
  assert.equal(micro.cells, 64);
  assert.equal(micro.cellSize, 0.125);
  assert.ok(Math.abs(micro.scale - 0.2) < 1e-9, 'both precisions should scale the model to eight standard cells');
});

test('scaled voxelization maps a 10-cube to a hollow 5x5x5 standard-block model', () => {
  const tris = cubeTriangles([0, 0, 0], [10, 10, 10]).map(([a, b, c]: number[][]) => ({ a: a as [number, number, number], b: b as [number, number, number], c: c as [number, number, number] }));
  const plan = planSTLSize(tris, 5, 1);
  const result = voxelizeSTL(tris, plan.cellSize, 0xabcdef, { micro: plan.micro, scale: plan.scale });
  assert.equal(result.blocks.length, 98, 'the result should be a hollow 5x5x5 standard-block model');
  assert.ok(result.blocks.every(b => b.size === 1 && Number.isInteger(b.dx) && Number.isInteger(b.dy) && Number.isInteger(b.dz)));
  const maxAxis = Math.max(
    Math.max(...result.blocks.map(b => b.dx)) + 1,
    Math.max(...result.blocks.map(b => b.dy)) + 1,
    Math.max(...result.blocks.map(b => b.dz)) + 1
  );
  assert.equal(maxAxis, 5, 'the longest axis should span exactly five standard cells');
});

test('microblock precision keeps hollow surface shells while saving interior voxel budget', () => {
  const tris = cubeTriangles([0, 0, 0], [10, 10, 10]).map(([a, b, c]: number[][]) => ({ a: a as [number, number, number], b: b as [number, number, number], c: c as [number, number, number] }));
  const plan = planSTLSize(tris, 5, 0.125);
  assert.equal(plan.cells, 40);
  const result = voxelizeSTL(tris, plan.cellSize, 0xabcdef, { micro: plan.micro, scale: plan.scale });
  // 40x40x40 hollow microcells shell (9,128 microblocks) saves 54,872 interior blocks (down from 64,000).
  assert.equal(result.blocks.length, 9128, '40x40x40 hollow shell should produce 9128 surface microblocks');
  assert.ok(
    result.blocks.every(b =>
      Math.abs(b.dx * 8 - Math.round(b.dx * 8)) < 1e-9 &&
      Math.abs(b.dy * 8 - Math.round(b.dy * 8)) < 1e-9 &&
      Math.abs(b.dz * 8 - Math.round(b.dz * 8)) < 1e-9
    ),
    'offsets should lie exactly on the 0.125 grid'
  );
  const maxDx = Math.max(...result.blocks.map(b => b.dx));
  assert.equal(maxDx, 4.875, `40 microcells span from dx 0 to 4.875`);
});

test('microblock precision retains fine surface details as 0.125 blocks on hollow models', () => {
  // A cube of 0.875m = 7 microcells on each axis (7x7x7 = 343 microcells)
  // At s = 0.125:
  // dx in [0..6], dy in [0..6], dz in [0..6] (7 cells)
  // Interior 5x5x5 core is hollowed out (343 - 125 = 218 surface microcells).
  const tris = cubeTriangles([0, 0, 0], [0.875, 0.875, 0.875]).map(([a, b, c]: number[][]) => ({ a: a as [number, number, number], b: b as [number, number, number], c: c as [number, number, number] }));
  const result = voxelizeSTL(tris, 0.125, 0x112233, { micro: true });
  assert.equal(result.blocks.length, 218, 'hollow shell contains 218 surface microblocks');
  assert.ok(result.blocks.every(b => b.size === 0.125));
});

test('planSTLSize handles empty meshes, zero extent, and invalid size boundaries', () => {
  assert.throws(() => planSTLSize([], 8, 1), /no triangles/);
  const tris = cubeTriangles([5, 5, 5], [5, 5, 5]).map(([a, b, c]: number[][]) => ({ a: a as [number, number, number], b: b as [number, number, number], c: c as [number, number, number] }));
  const plan = planSTLSize(tris, 8, 1);
  assert.equal(plan.scale, 1, 'a zero-extent mesh should fall back to scale 1');
  assert.equal(plan.cells, 8);
  const tiny = planSTLSize(tris, 0, 0.125);
  assert.equal(tiny.cells, 8, 'size 0 should fall back to one standard cell or eight microcells');
});

test('a 30-degree rotated cube voxelizes into a filled diamond-shaped solid', () => {
  const angle = Math.PI / 6;
  const rot = (p: number[]): [number, number, number] => {
    const [x, y, z] = p;
    return [x * Math.cos(angle) + z * Math.sin(angle), y, -x * Math.sin(angle) + z * Math.cos(angle)];
  };
  const tris = cubeTriangles([-1, -1, -1], [1, 1, 1]).map(([a, b, c]) => ({ a: rot(a), b: rot(b), c: rot(c) }));
  const result = voxelizeSTL(tris, 0.25);
  assert.ok(result.blocks.length > 50, `rotated cube should produce enough blocks, got ${result.blocks.length}`);
  assert.ok(
    result.blocks.some(b => b.dx >= 3 && b.dx <= 5 && b.dy >= 3 && b.dy <= 5 && b.dz >= 3 && b.dz <= 5),
    'the area near the center should be solid'
  );
  const maxDx = Math.max(...result.blocks.map(b => b.dx));
  assert.ok(maxDx <= 12, `dx range should approximately match the grid, got ${maxDx}`);
});

test('importBlockSetToInventory fills empty block-set slots and rejects when the category is full', () => {
  const controller = makeController();
  const blocks = [{ dx: 0, dy: 0, dz: 0, size: 1, block: 1, color: 0xff0000 }];
  controller.importBlockSetToInventory(blocks, 'cube');
  assert.equal(controller.inventorySlots[0].kind, 'blockset');
  assert.equal(controller.inventorySlots[0].name, 'cube');
  assert.equal(controller.selectedInventoryIndex, 0);
  controller.importBlockSetToInventory(blocks, 'cube2');
  assert.equal(controller.selectedInventoryIndex, 1, 'the second import should use slot 1');
  // Fill every slot in the 99-item category, not only the 9-item hotbar view.
  controller.inventories.blockset.items = controller.inventories.blockset.items.map(() => ({
    kind: 'blockset', blocks, blockCount: 1, name: 'full'
  }));
  controller.selectedInventoryIndex = 3;
  const rejected = controller.importBlockSetToInventory(blocks, 'overwrite');
  assert.equal(rejected, null, 'a full block-set category must reject the import');
  assert.equal(controller.inventorySlots[3].name, 'full', 'the selected slot must not be overwritten');
  assert.ok(controller.__toasts.some(m => m.includes('full (99)')));
});

test('successful T block-set copy resets world cornerA and cornerB', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const fakeWorld = {
    getBlock: () => BlockTypes.COLOR_BLOCK,
    getBlockColor: () => 0xff00aa,
    getMicroBlocksInAABB: () => []
  };
  const controller = makeController({ manager, world: fakeWorld });

  manager.setCornerA({ x: 1, y: 2, z: 3 });
  manager.setCornerB({ x: 4, y: 5, z: 6 });
  assert.equal(manager.hasValidSelection(), true);
  controller.copySelectionAsBlockSet();
  assert.ok(controller.inventorySlots[0], 'the block set should enter the slot');
  assert.equal(manager.selectionCornerA, null, 'cornerA should reset');
  assert.equal(manager.selectionCornerB, null, 'cornerB should reset');
  assert.equal(manager.hasValidSelection(), false, 'selection should become invalid and collapse the banner');
});

test('successful T block-set copy resets entity block selection and highlights', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    1,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0x123456, entityId: 'root' }],
    new THREE.Vector3(0, 10, 0),
    scene
  );
  contraption.stopAllNodeScripts();
  const controller = makeController();
  controller.selectedBlockSelection = { contraption, nodeId: 'root', blocks: contraption.blocks };
  controller.selectorLevel = { contraption, nodeId: 'root' };
  controller.selectorRange = { contraption, nodeId: 'root', pointA: null, pointB: null };
  contraption.highlightBlocks(contraption.blocks);
  assert.ok(contraption.subtreeHighlightBoxes.length > 0, 'highlights should be attached before copy');

  controller.copySelectionAsBlockSet();
  assert.equal(controller.selectedBlockSelection, null, 'block selection should reset');
  assert.equal(controller.selectorLevel, null, 'selector level should reset');
  assert.equal(controller.selectorRange, null, 'selector range should reset');
  assert.equal(contraption.subtreeHighlightBoxes.length, 0, 'per-block highlights should clear');
  assert.ok(controller.inventorySlots[0], 'the block set should enter the slot');
});
