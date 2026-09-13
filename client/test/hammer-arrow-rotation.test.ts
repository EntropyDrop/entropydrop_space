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
        { dx: 0, dy: 1, dz: 0, size: 1, color: '#f2a93b' },
        { dx: 0, dy: 2, dz: 0, size: 1, color: '#f2a93b' }
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
  controller.hammerRotationTurnsY = 0;
  controller.hammerRotationTurnsX = 0;
  controller.hammerRotatedSlotSource = null;
  controller.hammerRotatedSlotTurnsKey = null;
  controller.hammerRotatedSlotCache = null;
  controller.sound = { playWrenchClick() {} };
  controller.ui = { showToast() {}, syncInventoryState() {} };
  controller.updateInventoryPlacementPreview = () => {};
  controller.entityInputDown = new Set();
  controller.entityInputPressed = new Set();
  controller.entityInputReleased = new Set();
  controller.keys = { forward: false, backward: false, left: false, right: false, jump: false, crouch: false, sprint: false };
  return controller;
}

test('rotateBlocksX90 rotates standard blocks by 90 degrees around X axis and preserves integer grid and shape', () => {
  const controller = makeTestController();
  const blocks = [
    { dx: 0, dy: 0, dz: 0, size: 1, color: '#fff' },
    { dx: 0, dy: 1, dz: 0, size: 1, color: '#fff' },
    { dx: 0, dy: 2, dz: 0, size: 1, color: '#fff' }
  ];

  // 1st 90° rotation around X: from Y-aligned (0, 0..2, 0) to Z-aligned
  const rot1 = controller.rotateBlocksX90(blocks, 1);
  assert.equal(rot1.length, 3);
  rot1.forEach((b: any) => {
    assert.equal(b.dx, 0);
    assert.equal(Number.isInteger(b.dy), true);
    assert.equal(Number.isInteger(b.dz), true);
  });
  // Span along Y is 0 (constant), span along Z is 2
  const zVals1 = rot1.map((b: any) => b.dz).sort((a: number, b: number) => a - b);
  assert.deepEqual(zVals1, [-1, 0, 1]);

  // 4 full rotations should return to original positions
  const rot2 = controller.rotateBlocksX90(rot1, 1);
  const rot3 = controller.rotateBlocksX90(rot2, 1);
  const rot4 = controller.rotateBlocksX90(rot3, 1);

  const origY = blocks.map(b => b.dy).sort();
  const finalY = rot4.map((b: any) => b.dy).sort();
  const origZ = blocks.map(b => b.dz).sort();
  const finalZ = rot4.map((b: any) => b.dz).sort();

  assert.deepEqual(finalY, origY);
  assert.deepEqual(finalZ, origZ);
});

test('rotateBlocksX90 rotates micro blocks and keeps exact 0.125 scale alignment', () => {
  const controller = makeTestController();
  const microBlocks = [
    { dx: 0, dy: 0, dz: 0, size: 0.125, color: '#fff' },
    { dx: 0, dy: 0.125, dz: 0, size: 0.125, color: '#fff' },
    { dx: 0, dy: 0.25, dz: 0, size: 0.125, color: '#fff' }
  ];

  const rot1 = controller.rotateBlocksX90(microBlocks, 1);
  rot1.forEach((b: any) => {
    assert.equal(Math.abs(Math.round(b.dy * 8) - b.dy * 8) < 1e-6, true);
    assert.equal(Math.abs(Math.round(b.dz * 8) - b.dz * 8) < 1e-6, true);
  });
});

test('ArrowLeft and ArrowRight rotate Y axis (yaw)', () => {
  const controller = makeTestController();
  assert.equal(controller.hammerRotationTurnsY, 0);

  // ArrowRight: +90° Y
  let prevented = false;
  controller.handleKeyDown({ code: 'ArrowRight', preventDefault: () => { prevented = true; } } as any);
  assert.equal(prevented, true);
  assert.equal(controller.hammerRotationTurnsY, 1);
  assert.equal(controller.hammerRotationTurns, 1, 'getter backward-compatibility');

  // ArrowLeft: -90° Y
  controller.handleKeyDown({ code: 'ArrowLeft', preventDefault: () => {} } as any);
  assert.equal(controller.hammerRotationTurnsY, 0);

  // ArrowLeft again: 270° Y (turns = 3)
  controller.handleKeyDown({ code: 'ArrowLeft', preventDefault: () => {} } as any);
  assert.equal(controller.hammerRotationTurnsY, 3);
});

test('ArrowUp and ArrowDown rotate X axis (pitch)', () => {
  const controller = makeTestController();
  assert.equal(controller.hammerRotationTurnsX, 0);

  // ArrowUp: +90° X
  let prevented = false;
  controller.handleKeyDown({ code: 'ArrowUp', preventDefault: () => { prevented = true; } } as any);
  assert.equal(prevented, true);
  assert.equal(controller.hammerRotationTurnsX, 1);

  // ArrowUp again: 180° X
  controller.handleKeyDown({ code: 'ArrowUp', preventDefault: () => {} } as any);
  assert.equal(controller.hammerRotationTurnsX, 2);

  // ArrowDown: back to 90° X
  controller.handleKeyDown({ code: 'ArrowDown', preventDefault: () => {} } as any);
  assert.equal(controller.hammerRotationTurnsX, 1);

  // ArrowDown again: back to 0° X
  controller.handleKeyDown({ code: 'ArrowDown', preventDefault: () => {} } as any);
  assert.equal(controller.hammerRotationTurnsX, 0);
});

test('Arrow keys do not rotate if activeTool is not Hammer', () => {
  const controller = makeTestController();
  controller.activeTool = SpecialTool.SHOVEL;

  controller.handleKeyDown({ code: 'ArrowRight', preventDefault: () => {} } as any);
  assert.equal(controller.hammerRotationTurnsY, 0);

  controller.handleKeyDown({ code: 'ArrowUp', preventDefault: () => {} } as any);
  assert.equal(controller.hammerRotationTurnsX, 0);
});

test('combined X and Y rotation derives correct orientation for blocks and entities', () => {
  const controller = makeTestController();
  const slot = controller.inventories.blockset.items[0];
  const originalBlocks = slot.blocks.map((b: any) => ({ ...b }));

  // Rotate X by 1 (pitch) and Y by 1 (yaw)
  controller.rotateActiveInventoryItem(1, 'x');
  controller.rotateActiveInventoryItem(1, 'y');

  assert.equal(controller.hammerRotationTurnsX, 1);
  assert.equal(controller.hammerRotationTurnsY, 1);

  const rotatedSlot = controller.getActiveHammerInventoryItem();
  assert.notEqual(rotatedSlot, slot);
  assert.deepEqual(slot.blocks, originalBlocks, 'original item must remain untouched');

  // Verify caching: calling again returns the cached object
  assert.equal(controller.getActiveHammerInventoryItem(), rotatedSlot);

  // Rotate entity slot with both axes
  const entitySlot = {
    name: 'Sensor',
    kind: 'entity',
    anchorRotation: [0, 0, 0, 1],
    blocks: [{ localX: 0, localY: 0, localZ: 0, size: 1, color: '#fff' }],
    childEntities: []
  };
  controller.inventories.entity.items[0] = entitySlot;
  controller.activeInventoryCategory = 'entity';
  controller.clearHammerRotation();

  controller.rotateActiveInventoryItem(1, 'y');
  controller.rotateActiveInventoryItem(1, 'x');

  const rotatedEntity = controller.getActiveHammerInventoryItem();
  const qY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const expectedPlacement = qY.multiply(qX);

  const actualPlacement = new THREE.Quaternion().fromArray(rotatedEntity.placementRotation);
  assert.ok(actualPlacement.angleTo(expectedPlacement) < 1e-6);
});

test('clearHammerRotation resets both X and Y turns', () => {
  const controller = makeTestController();
  controller.rotateActiveInventoryItem(1, 'x');
  controller.rotateActiveInventoryItem(1, 'y');
  assert.equal(controller.hammerRotationTurnsX, 1);
  assert.equal(controller.hammerRotationTurnsY, 1);

  controller.clearHammerRotation();
  assert.equal(controller.hammerRotationTurnsX, 0);
  assert.equal(controller.hammerRotationTurnsY, 0);
  assert.equal(controller.getActiveHammerInventoryItem(), controller.inventories.blockset.items[0]);
});
