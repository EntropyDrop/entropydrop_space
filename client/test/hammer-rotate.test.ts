import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';

function makeTestController() {
  const controller: any = Object.create(PlayerController.prototype);
  const items = [
    {
      id: 'test_bs_1',
      name: 'Line 3x1',
      kind: 'blockset',
      blocks: [
        { dx: 0, dy: 0, dz: 0, size: 1, color: '#f2a93b' },
        { dx: 1, dy: 0, dz: 0, size: 1, color: '#f2a93b' },
        { dx: 2, dy: 0, dz: 0, size: 1, color: '#f2a93b' }
      ],
      blockCount: 3
    }
  ];
  controller.inventories = {
    blockset: { selected: 0, items },
    entity: { selected: 0, items: [] },
    colorset: { selected: 0, items: [] }
  };
  controller.activeInventoryCategory = 'blockset';
  controller.selectedInventoryIndex = 0;
  controller.activeTool = SpecialTool.HAMMER;
  controller.sound = { playWrenchClick() {} };
  controller.ui = { showToast() {}, syncInventoryState() {} };
  controller.updateInventoryPlacementPreview = () => {};
  return controller;
}

test('rotateBlocksY90 rotates standard blocks by 90 degrees and preserves integer grid and shape', () => {
  const controller = makeTestController();
  const blocks = [
    { dx: 0, dy: 0, dz: 0, size: 1, color: '#fff' },
    { dx: 1, dy: 0, dz: 0, size: 1, color: '#fff' },
    { dx: 2, dy: 0, dz: 0, size: 1, color: '#fff' }
  ];

  // 1st 90° rotation: from X-aligned (0..2, 0) to Z-aligned (1, -1..1)
  const rot1 = controller.rotateBlocksY90(blocks, 1);
  assert.equal(rot1.length, 3);
  rot1.forEach((b: any) => {
    assert.equal(Number.isInteger(b.dx), true);
    assert.equal(Number.isInteger(b.dz), true);
    assert.equal(b.dy, 0);
  });
  // Span along X is 0, span along Z is 2
  const zVals1 = rot1.map((b: any) => b.dz).sort((a: number, b: number) => a - b);
  assert.deepEqual(zVals1, [-1, 0, 1]);

  // 4 full rotations should return to original positions
  const rot2 = controller.rotateBlocksY90(rot1, 1);
  const rot3 = controller.rotateBlocksY90(rot2, 1);
  const rot4 = controller.rotateBlocksY90(rot3, 1);

  const origX = blocks.map(b => b.dx).sort();
  const finalX = rot4.map((b: any) => b.dx).sort();
  const origZ = blocks.map(b => b.dz).sort();
  const finalZ = rot4.map((b: any) => b.dz).sort();

  assert.deepEqual(finalX, origX);
  assert.deepEqual(finalZ, origZ);
});

test('rotateBlocksY90 rotates micro blocks and keeps exact 0.125 scale alignment', () => {
  const controller = makeTestController();
  const microBlocks = [
    { dx: 0, dy: 0, dz: 0, size: 0.125, color: '#fff' },
    { dx: 0.125, dy: 0, dz: 0, size: 0.125, color: '#fff' },
    { dx: 0.25, dy: 0, dz: 0, size: 0.125, color: '#fff' }
  ];

  const rot1 = controller.rotateBlocksY90(microBlocks, 1);
  rot1.forEach((b: any) => {
    // Must be exact multiple of 0.125
    assert.equal(Math.abs(Math.round(b.dx * 8) - b.dx * 8) < 1e-6, true);
    assert.equal(Math.abs(Math.round(b.dz * 8) - b.dz * 8) < 1e-6, true);
  });
});

test('Hammer right-click rotates a temporary placement view without mutating the inventory item', () => {
  const controller = makeTestController();
  const slot = controller.inventories.blockset.items[0];
  const originalBlocks = slot.blocks.map((block: any) => ({ ...block }));
  assert.equal(slot.blocks[0].dx, 0);
  assert.equal(slot.blocks[2].dx, 2);

  // Right click with Hammer
  controller.handleRightClick(null);

  // The canonical backpack item stays untouched; only the placement view rotates.
  assert.deepEqual(slot.blocks, originalBlocks);
  const rotatedSlot = controller.getActiveHammerInventoryItem();
  const zVals = rotatedSlot.blocks.map((b: any) => b.dz).sort((a: number, b: number) => a - b);
  assert.deepEqual(zVals, [-1, 0, 1]);
});

test('Hammer right-click rotates entity placement with a temporary quaternion, not voxel rewrites', () => {
  const controller = makeTestController();
  const slot = {
    name: 'Rotor',
    kind: 'entity',
    anchorRotation: [0, 0, 0, 1],
    blocks: [
      { localX: 0, localY: 0, localZ: 0, size: 1, color: '#fff', entityId: 'root' },
      { localX: 2, localY: 0, localZ: 0, size: 1, color: '#fff', entityId: 'root' }
    ],
    childEntities: []
  };
  controller.inventories.entity.items[0] = slot;
  controller.activeInventoryCategory = 'entity';
  const originalBlocks = slot.blocks.map(block => ({ ...block }));

  controller.handleRightClick(null);
  const rotated = controller.getActiveHammerInventoryItem();

  assert.deepEqual(slot.blocks, originalBlocks);
  assert.deepEqual(rotated.blocks, originalBlocks);
  assert.deepEqual(slot.anchorRotation, [0, 0, 0, 1]);
  assert.ok(new THREE.Quaternion().fromArray(rotated.anchorRotation).angleTo(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2)
  ) < 1e-9);
  const rotation = new THREE.Quaternion().fromArray(rotated.placementRotation);
  const direction = new THREE.Vector3(1, 0, 0).applyQuaternion(rotation);
  assert.ok(direction.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-9);
});

test('consecutive Hammer rotations are always derived from the original item and four clicks are exact', () => {
  const controller = makeTestController();
  const slot = controller.inventories.blockset.items[0];
  const originalBlocks = slot.blocks.map((block: any) => ({ ...block }));

  for (let turns = 1; turns <= 4; turns++) {
    controller.handleRightClick(null);
    const expected = controller.rotateBlocksY90(originalBlocks, turns);
    assert.deepEqual(controller.getActiveHammerInventoryItem().blocks, expected);
    assert.deepEqual(slot.blocks, originalBlocks, `click ${turns} must not change the source item`);
  }

  assert.equal(controller.hammerRotationTurns, 0);
  assert.equal(controller.getActiveHammerInventoryItem(), slot, 'four clicks must use the exact original item again');
});

test('switching Hammer item or tool clears the temporary rotation', () => {
  const controller = makeTestController();
  const firstSlot = controller.inventories.blockset.items[0];
  controller.inventories.blockset.items.push({
    id: 'test_bs_2',
    name: 'Single',
    kind: 'blockset',
    blocks: [{ dx: 4, dy: 0, dz: 2, size: 1, color: '#fff' }],
    blockCount: 1
  });

  controller.handleRightClick(null);
  assert.equal(controller.hammerRotationTurns, 1);
  controller.selectedInventoryIndex = 1;
  assert.equal(controller.hammerRotationTurns, 0, 'selecting another item clears rotation');
  controller.selectedInventoryIndex = 0;
  assert.equal(controller.getActiveHammerInventoryItem(), firstSlot, 'reselecting uses the original pose');

  controller.handleRightClick(null);
  assert.equal(controller.hammerRotationTurns, 1);
  controller.activeTool = SpecialTool.SHOVEL;
  assert.equal(controller.hammerRotationTurns, 0, 'switching tools clears rotation');
  controller.activeTool = SpecialTool.HAMMER;
  assert.equal(controller.getActiveHammerInventoryItem(), firstSlot, 'returning to Hammer uses the original pose');
});
