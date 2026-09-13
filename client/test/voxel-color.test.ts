import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { BlockTypes, normalizeColor, colorToHex, DEFAULT_BLOCK_COLOR, PRESET_COLORS } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { SpecialTool } from '../src/engine/controls/PlayerController.ts';

test('normalizeColor handles hex strings and integer colors correctly', () => {
  assert.equal(normalizeColor('#f2a93b'), 0xf2a93b);
  assert.equal(normalizeColor('f2a93b'), 0xf2a93b);
  assert.equal(normalizeColor(0x48dbfb), 0x48dbfb);
  assert.equal(normalizeColor('#000000'), 0x000000);
  assert.equal(normalizeColor(0), 0);
  assert.equal(normalizeColor(null, DEFAULT_BLOCK_COLOR), DEFAULT_BLOCK_COLOR);
  assert.equal(normalizeColor('invalid', 0x123456), 0x123456);
});

test('colorToHex formats hex colors properly', () => {
  assert.equal(colorToHex(0xf2a93b), '#f2a93b');
  assert.equal(colorToHex('#48dbfb'), '#48dbfb');
  assert.equal(colorToHex(0), '#000000');
  assert.equal(colorToHex(0xff), '#0000ff');
});

test('world.setBlockColor recolors an existing standard voxel without destroying it', () => {
  const world = new World(new THREE.Scene());
  world.setBlock(5, 10, 5, BlockTypes.COLOR_BLOCK, false, '#f2a93b' as any);
  assert.equal(world.getBlock(5, 10, 5), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlockColor(5, 10, 5), 0xf2a93b);

  // Recolor to Cyan
  const success = world.setBlockColor(5, 10, 5, '#48dbfb', false);
  assert.equal(success, true);
  assert.equal(world.getBlock(5, 10, 5), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlockColor(5, 10, 5), 0x48dbfb);
});

test('world.setMicroBlock recolors an existing micro voxel', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setMicroBlock(25, 50, 25, '#2ed573' as any);
  assert.equal(world.microVoxels.get(25, 50, 25), 0x2ed573);

  // Recolor micro voxel to Red
  const recolored = world.setMicroBlock(25, 50, 25, '#eb4d4b' as any);
  assert.equal(recolored, true);
  assert.equal(world.microVoxels.get(25, 50, 25), 0xeb4d4b);
});

test('PRESET_COLORS is the fixed 9-slot keyboard palette', () => {
  assert.equal(PRESET_COLORS.length, 9);
  for (const preset of PRESET_COLORS) {
    assert.ok(preset.hex.startsWith('#'));
    assert.equal(preset.hex.length, 7);
    assert.ok(preset.name.length > 0);
  }
});

test('SpecialTool has BRUSH, legacy PIPETTE, SELECTOR, WRENCH and HAMMER and omits PHYSICS_GUN', () => {
  assert.equal(SpecialTool.BRUSH, 'brush');
  assert.equal(SpecialTool.PIPETTE, 'pipette');
  assert.equal((SpecialTool as any).PHYSICS_GUN, undefined);
  assert.equal(SpecialTool.SELECTOR, 'selector');
  assert.equal(SpecialTool.WRENCH, 'wrench');
  assert.equal(SpecialTool.HAMMER, 'hammer');
});

test('ContraptionManager 3-point selection with Super Glue determines correct bounding box', async () => {
  const { ContraptionManager } = await import('@entropydrop/space-engine/contraption/ContraptionManager.ts');
  const world = new World(new THREE.Scene());
  const manager = new ContraptionManager(new THREE.Scene(), world, null, null);

  assert.equal(manager.hasValidSelection(), false);

  // Point 1
  const count1 = manager.addGluePoint({ x: 2, y: 3, z: 4 });
  assert.equal(count1, 1);
  assert.equal(manager.hasValidSelection(), false);
  assert.deepEqual(manager.getSelectionBounds(), { minX: 2, maxX: 2, minY: 3, maxY: 3, minZ: 4, maxZ: 4 });

  // Point 2
  const count2 = manager.addGluePoint({ x: 8, y: 3, z: 10 });
  assert.equal(count2, 2);
  assert.equal(manager.hasValidSelection(), false);
  assert.deepEqual(manager.getSelectionBounds(), { minX: 2, maxX: 8, minY: 3, maxY: 3, minZ: 4, maxZ: 10 });

  // Point 3 (defining height & volume)
  const count3 = manager.addGluePoint({ x: 5, y: 12, z: 7 });
  assert.equal(count3, 3);
  assert.equal(manager.hasValidSelection(), true);
  assert.deepEqual(manager.getSelectionBounds(), { minX: 2, maxX: 8, minY: 3, maxY: 12, minZ: 4, maxZ: 10 });
  assert.equal(manager.getSelectionBlockCount(), (8 - 2 + 1) * (12 - 3 + 1) * (10 - 4 + 1));

  // Clear selection
  manager.clearSelection();
  assert.equal(manager.hasValidSelection(), false);
  assert.equal(manager.getSelectionBounds(), null);
});
