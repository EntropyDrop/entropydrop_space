import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';

/**
 * Copy as block set with T: copy raw selected blocks and paste them as ordinary
 * world blocks. R still copies an entity with component hierarchy and scripts.
 */

function makeController(overrides: any = {}) {
  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectedSubtree = null;
  controller.selectedBlockSelection = null;
  controller.selectorRange = null;
  controller.inventorySlots = new Array(8).fill(null);
  controller.selectedInventoryIndex = 0;
  controller.contraptions = overrides.manager || null;
  controller.world = overrides.world || null;
  controller.keys = {};
  controller.sound = { playBlockPlace() {} };
  const toasts: string[] = [];
  controller.ui = {
    showToast: m => toasts.push(m),
    renderInventoryBar() {}
  };
  Object.assign(controller, overrides);
  controller.__toasts = toasts;
  return controller;
}

/** Clear an area to AIR so lazy terrain generation cannot affect the test. */
function clearRegion(world: any, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) {
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        world.setBlock(x, y, z, BlockTypes.AIR, false);
      }
    }
  }
}

test('two-point world selection copied with T stores a normalized block set', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  clearRegion(world, 2, 3, 4, 5, 6, 7);
  world.setBlock(2, 3, 4, BlockTypes.COLOR_BLOCK, false, 0xff0000);
  world.setBlock(5, 3, 4, BlockTypes.COLOR_BLOCK, false, 0x00ff00);
  world.setBlock(5, 6, 7, BlockTypes.COLOR_BLOCK, false, 0x0000ff);
  const manager = new ContraptionManager(scene, {}, null, null);
  const controller = makeController({ manager, world });

  manager.setCornerA({ x: 2, y: 3, z: 4 });
  manager.setCornerB({ x: 5, y: 6, z: 7 });
  assert.equal(manager.hasValidSelection(), true);

  controller.copySelectionAsBlockSet();
  const slot = controller.inventorySlots[0];
  assert.ok(slot, 'the slot should be written');
  assert.equal(controller.activeTool, SpecialTool.HAMMER, 'successful copy should switch to Hammer');
  assert.equal(slot.kind, 'blockset');
  assert.equal(slot.blockCount, 3);
  assert.ok(slot.name.includes('world selection'));

  const offsets = slot.blocks.map(b => [b.dx, b.dy, b.dz]);
  assert.ok(offsets.some(([x, y, z]) => x === 0 && y === 0 && z === 0), 'the minimum-corner offset should be (0,0,0)');
  assert.ok(offsets.some(([x, y, z]) => x === 3 && y === 0 && z === 0));
  assert.ok(offsets.some(([x, y, z]) => x === 3 && y === 3 && z === 3));
  assert.ok(slot.blocks.every(b => b.size === 1 && b.block === BlockTypes.COLOR_BLOCK));

  // Copy is read-only; only assembly with G removes source blocks.
  assert.equal(world.getBlock(2, 3, 4), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlock(5, 6, 7), BlockTypes.COLOR_BLOCK);
  assert.ok(controller.__toasts.some(m => m.includes('block set')));
});

test('pasting a block set creates ordinary world blocks and no entity', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  clearRegion(world, 0, 0, 0, 1, 1, 1);
  world.setBlock(0, 0, 0, BlockTypes.COLOR_BLOCK, false, 0xff0000);
  world.setBlock(1, 0, 0, BlockTypes.COLOR_BLOCK, false, 0x00ff00);
  world.setBlock(1, 1, 1, BlockTypes.COLOR_BLOCK, false, 0x0000ff);
  const manager = new ContraptionManager(scene, {}, null, null);
  const controller = makeController({ manager, world });

  manager.setCornerA({ x: 0, y: 0, z: 0 });
  manager.setCornerB({ x: 1, y: 1, z: 1 });
  controller.copySelectionAsBlockSet();
  const before = manager.contraptions.length;

  // Paste on the top face at (10,20,30), so the target cell is y=21.
  clearRegion(world, 10, 21, 30, 11, 22, 31);
  controller.currentRaycast = {
    hit: true,
    hitPos: { x: 10.2, y: 20.0, z: 30.1 },
    normal: { x: 0, y: 1, z: 0 }
  };
  controller.pasteInventorySlot();

  assert.equal(world.getBlock(10, 21, 30), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlock(11, 21, 30), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlock(11, 22, 31), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlockColor(10, 21, 30), 0xff0000);
  assert.equal(world.getBlockColor(11, 21, 30), 0x00ff00);
  assert.equal(manager.contraptions.length, before, 'block-set paste should not create an entity');
  assert.ok(controller.__toasts.some(m => m.includes('Built block set')));
});

test('block-set copy preserves 0.125 microblock offsets during paste', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  clearRegion(world, 4, 10, 4, 4, 10, 5);
  world.setBlock(4, 10, 4, BlockTypes.COLOR_BLOCK, false, 0xaaaaaa);
  // Put a microblock in adjacent cell (4,10,5): microcell (34,80,42).
  assert.equal(world.setMicroBlock(34, 80, 42, 0x123456), true);
  const manager = new ContraptionManager(scene, {}, null, null);
  const controller = makeController({ manager, world });

  manager.setCornerA({ x: 4, y: 10, z: 4 });
  manager.setCornerB({ x: 4, y: 10, z: 5 });
  controller.copySelectionAsBlockSet();
  const slot = controller.inventorySlots[0];
  assert.equal(slot.blockCount, 2, 'one standard block plus one microblock');

  const micro = slot.blocks.find(b => (b.size || 1) < 1);
  assert.ok(micro, 'the block set should contain the microblock');
  assert.ok(Math.abs(micro.dx - 0.25) < 1e-6, `expected microblock dx=0.25, got ${micro.dx}`);
  assert.ok(Math.abs(micro.dz - 1.25) < 1e-6, `expected microblock dz=1.25, got ${micro.dz}`);
  assert.equal(micro.color, 0x123456);

  // Paste on top of (20,30,40); the microblock lands at microcell (162,248,330).
  clearRegion(world, 20, 31, 40, 20, 31, 41);
  controller.currentRaycast = {
    hit: true,
    hitPos: { x: 20.0, y: 30.0, z: 40.0 },
    normal: { x: 0, y: 1, z: 0 }
  };
  controller.pasteInventorySlot();
  const placed = world.getMicroBlock(162, 248, 330);
  assert.ok(placed, 'the microblock should land in the expected cell');
  assert.equal(placed.color, 0x123456);
});

test('T copies an entity block selection using selected block-local coordinates', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    1,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0x111111, entityId: 'root' },
      { localX: 0, localY: 2, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0x222222, entityId: 'root' },
      { localX: 3, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0x333333, entityId: 'arm' }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    { childEntities: [{ id: 'arm', parentId: 'root', pivot: [3.5, 0.5, 0.5], blockKeys: [['3', '0', '0']] }] }
  );
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.contraptions.push(contraption);
  contraption.stopAllNodeScripts();
  const controller = makeController({ manager });

  controller.selectedBlockSelection = {
    contraption,
    nodeId: 'root',
    blocks: contraption.blocks.filter(b => (b.entityId || 'root') === 'root')
  };
  controller.copySelectionAsBlockSet();
  const slot = controller.inventorySlots[0];
  assert.equal(slot.kind, 'blockset');
  assert.equal(slot.blockCount, 2);
  assert.ok(slot.name.includes('[root]'));
  const offsets = slot.blocks.map(b => [b.dx, b.dy, b.dz]).sort((a, b) => a[1] - b[1]);
  assert.deepEqual(offsets[0], [0, 0, 0]);
  assert.deepEqual(offsets[1], [0, 2, 0]);
});

test('T copies every block in a selected entity subtree as a block set', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    1,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, entityId: 'root' },
      { localX: 2, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, entityId: 'arm' },
      { localX: 2, localY: 0, localZ: 2, block: BlockTypes.COLOR_BLOCK, entityId: 'hand' }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    {
      childEntities: [
        { id: 'arm', parentId: 'root', pivot: [2.5, 0.5, 0.5], blockKeys: [['2', '0', '0']] },
        { id: 'hand', parentId: 'arm', pivot: [2.5, 0.5, 2.5], blockKeys: [['2', '0', '2']] }
      ]
    }
  );
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.contraptions.push(contraption);
  contraption.stopAllNodeScripts();
  const controller = makeController({ manager });

  controller.selectedSubtree = {
    contraption,
    rootId: 'arm',
    nodeIds: new Set(['arm', 'hand'])
  };
  controller.copySelectionAsBlockSet();
  const slot = controller.inventorySlots[0];
  assert.equal(slot.kind, 'blockset');
  assert.equal(slot.blockCount, 2, 'arm and hand contribute two blocks; root is excluded');
  assert.ok(slot.name.includes('[arm]'));
});

test('R still copies an entity slot and paste creates an entity', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    1,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }],
    new THREE.Vector3(0, 10, 0),
    scene
  );
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.contraptions.push(contraption);
  const controller = makeController({ manager });

  controller.selectedSubtree = { contraption, rootId: 'root', nodeIds: new Set(['root']) };
  controller.copySelectionToInventory(); // R path.
  const slot = controller.inventorySlots[0];
  assert.ok(slot);
  assert.notEqual(slot.kind, 'blockset', 'an entity slot must not carry the blockset marker');

  controller.currentRaycast = {
    hit: true,
    hitPos: { x: 50.0, y: 40.0, z: 30.0 },
    normal: { x: 0, y: 1, z: 0 }
  };
  const before = manager.contraptions.length;
  controller.pasteInventorySlot();
  assert.equal(manager.contraptions.length, before + 1, 'entity paste should create an independent entity');
  const pasted = manager.contraptions[manager.contraptions.length - 1];
  assert.equal(pasted.blocks.length, 1);
});

test('Hammer LMB builds block sets into empty cells only, skipping occupied cells; RMB rotates the block set 90°', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  clearRegion(world, 10, 20, 30, 12, 23, 32);
  world.setBlock(11, 21, 30, BlockTypes.COLOR_BLOCK, false, 0x00ff00); // occupied cell
  const manager = new ContraptionManager(scene, {}, null, null);
  const controller = makeController({ manager, world });
  controller.activeTool = SpecialTool.HAMMER;
  controller.inventorySlots[0] = {
    kind: 'blockset',
    blockCount: 2,
    blocks: [
      { dx: 0, dy: 0, dz: 0, size: 1, block: BlockTypes.COLOR_BLOCK, color: 0xff0000 },
      { dx: 1, dy: 0, dz: 0, size: 1, block: BlockTypes.COLOR_BLOCK, color: 0x123456 }
    ]
  };
  controller.currentRaycast = {
    hit: true,
    hitPos: { x: 10.2, y: 20.0, z: 30.1 },
    normal: { x: 0, y: 1, z: 0 }
  };

  // LMB: the occupied cell keeps its existing block.
  controller.handleLeftClick();
  assert.equal(world.getBlock(10, 21, 30), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlockColor(10, 21, 30), 0xff0000);
  assert.equal(world.getBlockColor(11, 21, 30), 0x00ff00, 'LMB must not overwrite occupied cells');
  assert.ok(controller.__toasts.some(m => m.includes('occupied cell(s) skipped')));

  // RMB: rotates the active block set 90 degrees.
  controller.handleRightClick();
  assert.ok(controller.__toasts.some(m => m.includes('Rotated')));
  const rotatedSlot = controller.getActiveHammerInventoryItem();
  assert.equal(rotatedSlot.blocks[0].dz !== 0 || rotatedSlot.blocks[1].dz !== 0, true);
  assert.deepEqual(controller.inventorySlots[0].blocks.map(block => [block.dx, block.dz]), [[0, 0], [1, 0]],
    'RMB rotation must remain temporary and leave the backpack item unchanged');

  const rotatedBlueBlock = rotatedSlot.blocks.find(block => block.color === 0x123456);
  controller.handleLeftClick();
  assert.equal(world.getBlockColor(10 + rotatedBlueBlock.dx, 21, 30 + rotatedBlueBlock.dz), 0x123456,
    'Hammer placement must build from the temporary rotated view');
});

test('pasteBlockSet in replace mode clears standard blocks before placing micro voxels', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  clearRegion(world, 10, 20, 30, 10, 22, 30);
  world.setBlock(10, 21, 30, BlockTypes.COLOR_BLOCK, false, 0x00ff00);
  const manager = new ContraptionManager(scene, {}, null, null);
  const controller = makeController({ manager, world });
  controller.activeTool = SpecialTool.HAMMER;
  const slot = {
    kind: 'blockset',
    blockCount: 1,
    blocks: [{ dx: 0.125, dy: 0, dz: 0, size: 0.125, color: 0xabcd12 }]
  };
  controller.inventorySlots[0] = slot;
  controller.currentRaycast = {
    hit: true,
    hitPos: { x: 10.2, y: 20.0, z: 30.1 },
    normal: { x: 0, y: 1, z: 0 }
  };

  // Calling pasteBlockSet with replace = true clears standard block and writes micro voxel
  controller.pasteBlockSet(slot, true);
  assert.equal(world.getBlock(10, 21, 30), BlockTypes.AIR, 'replace removes the blocking standard cell');
  const micro = world.getMicroBlock(81, 168, 240);
  assert.ok(micro, 'the micro voxel must land in the cleared cell');
  assert.equal(micro.color, 0xabcd12);
});

test('Hammer refuses to build when the crosshair is on open sky', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  clearRegion(world, 0, 0, 0, 6, 6, 6);
  const manager = new ContraptionManager(scene, {}, null, null);
  const controller = makeController({ manager, world });
  controller.activeTool = SpecialTool.HAMMER;
  controller.inventorySlots[0] = {
    kind: 'blockset',
    blockCount: 1,
    blocks: [{ dx: 0, dy: 0, dz: 0, size: 1, color: 0xff0000 }]
  };
  // High altitude: terrain raycast misses and nothing is hovered.
  controller.currentRaycast = { hit: false };
  controller.hoveredContraptionHit = null;

  assert.equal(controller.getInventoryPlacementPose(controller.inventorySlots[0]), null,
    'no surface, no pose');
  assert.equal(controller.pasteInventorySlot(), false, 'LMB must not build in open air');
  assert.ok(controller.__toasts.some(m => m.includes('No surface under the crosshair')));
  for (let x = 0; x <= 6; x++) {
    for (let y = 0; y <= 6; y++) {
      for (let z = 0; z <= 6; z++) {
        assert.equal(world.getBlock(x, y, z), BlockTypes.AIR, `cell [${x},${y},${z}] must stay air`);
      }
    }
  }
  assert.equal(manager.contraptions.length, 0, 'no entity may spawn in open air');

  // An entity slot refuses the same way without ever reaching buildFromSlot.
  controller.activeInventoryCategory = 'entity';
  controller.inventorySlots[0] = {
    rootComponentId: 'root',
    blockCount: 1,
    blocks: [{ localX: 0, localY: 0, localZ: 0, size: 1, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }]
  };
  assert.equal(controller.pasteInventorySlot(), false, 'entity LMB must not build in open air');
  assert.ok(controller.__toasts.some(m => m.includes('No surface under the crosshair')),
    'the entity refusal explains the missing surface');
  assert.equal(manager.contraptions.length, 0);
});

test('T with no selection reports a message and leaves the slot unchanged', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const controller = makeController({ manager });
  controller.copySelectionAsBlockSet();
  assert.equal(controller.inventorySlots[0], null, 'no selection should leave the slot empty');
  assert.ok(controller.__toasts.some(m => m.includes('Nothing selected')));
});

test('T copies only explicitly selected cells in Shift single-cell mode', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  clearRegion(world, 1, 1, 1, 1, 1, 1);
  clearRegion(world, 9, 9, 9, 9, 9, 9);
  world.setBlock(1, 1, 1, BlockTypes.COLOR_BLOCK, false, 0xabcdef);
  world.setBlock(9, 9, 9, BlockTypes.COLOR_BLOCK, false, 0x111111); // Unselected cell.
  const manager = new ContraptionManager(scene, {}, null, null);
  const controller = makeController({ manager, world });

  manager.toggleWorldGlueCell({ x: 1, y: 1, z: 1 });
  assert.equal(manager.hasValidSelection(), true);

  controller.copySelectionAsBlockSet();
  const slot = controller.inventorySlots[0];
  assert.equal(slot.blockCount, 1, 'only the selected cell should be copied');
  assert.deepEqual([slot.blocks[0].dx, slot.blocks[0].dy, slot.blocks[0].dz], [0, 0, 0]);
  assert.equal(world.getBlock(9, 9, 9), BlockTypes.COLOR_BLOCK, 'the unselected cell should remain unchanged');
});
