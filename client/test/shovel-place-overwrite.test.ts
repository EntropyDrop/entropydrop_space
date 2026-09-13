import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';

/**
 * Shovel destruction reports successful standard-cell removals to the sound layer.
 * Placement never overwrites a subdivided cell and still targets the adjacent cell.
 */

function makeShovelController(overrides = {}) {
  const controller = Object.create(PlayerController.prototype);
  const breakSounds = [];
  controller.activeTool = SpecialTool.SHOVEL;
  controller.hoveredContraptionHit = null;
  controller.currentRaycast = { hit: false };
  controller.canPlaceStandardAt = () => true;
  controller.selectedColor = 0xff0000;
  controller.particles = { emitBlockBreak() {} };
  controller.sound = {
    playBlockPlace() {},
    playBlockBreak(options) { breakSounds.push(options); }
  };
  controller.ui = { showToast() {}, notifyContraptionStructureChanged() {} };
  Object.assign(controller, overrides);
  controller.__breakSounds = breakSounds;
  return controller;
}

test('world shovel break plays one standard fracture only after a successful removal', () => {
  const writes = [];
  const controller = makeShovelController({
    currentRaycast: {
      hit: true,
      kind: 'standard',
      hitPos: { x: 2, y: 3, z: 4 },
      color: 0x123456
    },
    world: {
      getBlock: () => BlockTypes.COLOR_BLOCK,
      setBlock: (...args) => {
        writes.push(args);
        return true;
      }
    }
  });

  controller.handleLeftClick();

  assert.equal(writes.length, 1);
  assert.equal(writes[0][3], BlockTypes.AIR);
  assert.deepEqual(controller.__breakSounds, [{ kind: 'standard', count: 1 }]);
});

test('world shovel break stays silent when a stale hit removes nothing', () => {
  const controller = makeShovelController({
    currentRaycast: {
      hit: true,
      kind: 'standard',
      hitPos: { x: 2, y: 3, z: 4 },
      color: 0x123456
    },
    world: {
      getBlock: () => BlockTypes.AIR,
      setBlock: () => {
        assert.fail('an empty target must not be written');
      }
    }
  });

  controller.handleLeftClick();

  assert.deepEqual(controller.__breakSounds, []);
});

test('world shovel micro-cell clear reports its debris count as one standard fracture', () => {
  const cleared = [];
  const controller = makeShovelController({
    currentRaycast: {
      hit: true,
      kind: 'micro',
      microPos: { x: 18, y: 25, z: 36 },
      color: 0x123456
    },
    world: {
      clearMicroStandardCell: (...args) => {
        cleared.push(args);
        return 3;
      }
    }
  });

  controller.handleLeftClick();

  assert.deepEqual(cleared, [[2, 3, 4]]);
  assert.deepEqual(controller.__breakSounds, [{ kind: 'standard', count: 3 }]);
});

test('entity shovel break sounds once for a removed block and not for a stale hit', () => {
  const standardBlock = {
    localX: 1,
    localY: 2,
    localZ: 3,
    size: 1,
    block: BlockTypes.COLOR_BLOCK,
    color: 0x123456,
    entityId: 'root'
  };
  const contraption = {
    id: 7,
    blocks: [standardBlock],
    rebuildAfterBlockChange() {}
  };
  const controller = makeShovelController({
    hoveredContraptionHit: {
      contraption,
      entityId: 'root',
      kind: 'standard',
      cell: { x: 1, y: 2, z: 3 },
      point: { x: 1, y: 2, z: 3 },
      color: 0x123456
    }
  });

  controller.handleLeftClick();
  assert.equal(contraption.blocks.length, 0);
  assert.deepEqual(controller.__breakSounds, [{ kind: 'standard', count: 1 }]);

  controller.handleLeftClick();
  assert.deepEqual(
    controller.__breakSounds,
    [{ kind: 'standard', count: 1 }],
    'a stale entity hit must not add another sound'
  );
});

test('entity shovel micro-cell clear reports all removed debris in one sound', () => {
  const contraption = {
    id: 8,
    blocks: [
      { localX: 0, localY: 0, localZ: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK, entityId: 'root' },
      { localX: 0.2, localY: 0, localZ: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK, entityId: 'root' },
      { localX: 2, localY: 0, localZ: 0, size: 1, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }
    ],
    rebuildAfterBlockChange() {}
  };
  const controller = makeShovelController({
    hoveredContraptionHit: {
      contraption,
      entityId: 'root',
      kind: 'micro',
      cell: { x: 0, y: 0, z: 0 },
      point: { x: 0, y: 0, z: 0 },
      color: 0x123456
    }
  });

  controller.handleLeftClick();

  assert.equal(contraption.blocks.length, 1);
  assert.deepEqual(controller.__breakSounds, [{ kind: 'standard', count: 2 }]);
});

test('world placement beside a focused microblock targets the adjacent standard cell', () => {
  let placed = null;
  const controller = makeShovelController({
    // Focused microcell (18,3,10) belongs to standard cell (2,0,1), hit on +X.
    currentRaycast: {
      hit: true,
      kind: 'micro',
      microPos: { x: 18, y: 3, z: 10 },
      normal: { x: 1, y: 0, z: 0 }
    },
    world: {
      hasMicroInStandardCell: () => false,
      setBlock: (wx, wy, wz, blockType, updateMesh, color) => {
        placed = { wx, wy, wz, blockType, color };
      }
    }
  });
  controller.handleRightClick(null);
  assert.ok(placed, 'placement should occur in the adjacent cell');
  assert.deepEqual([placed.wx, placed.wy, placed.wz], [3, 0, 1], 'target should be the +X neighbor of (2,0,1)');
  assert.equal(placed.blockType, BlockTypes.COLOR_BLOCK);
  assert.equal(placed.color, 0xff0000);
});

test('world placement rejects a subdivided target cell', () => {
  let placed = false;
  const controller = makeShovelController({
    currentRaycast: {
      hit: true,
      kind: 'micro',
      microPos: { x: 18, y: 3, z: 10 },
      normal: { x: 0, y: 1, z: 0 }
    },
    world: {
      hasMicroInStandardCell: () => true,
      setBlock: () => { placed = true; }
    }
  });
  controller.handleRightClick(null);
  assert.equal(placed, false, 'placement must not overwrite a subdivided target');
});

test('world placement beside a standard block still targets the adjacent cell', () => {
  let placed = null;
  const controller = makeShovelController({
    currentRaycast: { hit: true, kind: 'standard', placePos: { x: 5, y: 6, z: 7 } },
    world: {
      hasMicroInStandardCell: () => false,
      setBlock: (wx, wy, wz) => { placed = { wx, wy, wz }; }
    }
  });
  controller.handleRightClick(null);
  assert.deepEqual([placed.wx, placed.wy, placed.wz], [5, 6, 7]);
});

test('entity placement beside a focused microblock preserves the subdivided cell', () => {
  const microBlock = { localX: 0.4, localY: 0.2, localZ: 0.2, size: 0.125, block: BlockTypes.COLOR_BLOCK };
  const contraption = { blocks: [microBlock], rebuildAfterBlockChange() {} };
  let rebuilt = 0;
  contraption.rebuildAfterBlockChange = () => { rebuilt++; };
  const controller = makeShovelController({
    hoveredContraptionHit: {
      contraption,
      entityId: 'root',
      // Focused microblock (0.4,0.2,0.2) is in standard cell (0,0,0), hit on +X.
      cell: { x: 0, y: 0, z: 0 },
      normal: { x: 1, y: 0, z: 0 },
      kind: 'micro'
    }
  });
  controller.handleRightClick(null);
  assert.ok(contraption.blocks.includes(microBlock), 'the source microblock must remain unchanged');
  const placed = contraption.blocks.find(b => b.size === 1 && b.localX === 1 && b.localY === 0 && b.localZ === 0) as any;
  assert.ok(placed, 'a standard block should be placed in the +X neighbor (1,0,0)');
  assert.equal(placed.color, 0xff0000);
  assert.equal(rebuilt, 1, 'placement should trigger one rebuild');
});

test('entity placement rejects a subdivided target cell', () => {
  const microBlock = { localX: 0.4, localY: 0.2, localZ: 0.2, size: 0.125, block: BlockTypes.COLOR_BLOCK };
  const microInTarget = { localX: 1.4, localY: 0.2, localZ: 0.2, size: 0.125, block: BlockTypes.COLOR_BLOCK };
  const contraption = { blocks: [microBlock, microInTarget], rebuildAfterBlockChange() {} };
  let rebuilt = 0;
  contraption.rebuildAfterBlockChange = () => { rebuilt++; };
  const controller = makeShovelController({
    hoveredContraptionHit: {
      contraption,
      entityId: 'root',
      cell: { x: 0, y: 0, z: 0 },
      normal: { x: 1, y: 0, z: 0 }, // Adjacent cell (1,0,0) is also subdivided.
      kind: 'micro'
    }
  });
  controller.handleRightClick(null);
  assert.equal(rebuilt, 0, 'rejected placement must not rebuild');
  assert.equal(contraption.blocks.length, 2, 'both subdivided cells must remain unchanged');
  assert.ok(contraption.blocks.includes(microBlock));
  assert.ok(contraption.blocks.includes(microInTarget));
});

test('entity placement beside a standard block still targets the adjacent cell', () => {
  const contraption = { blocks: [], rebuildAfterBlockChange() {} };
  const controller = makeShovelController({
    hoveredContraptionHit: {
      contraption,
      entityId: 'root',
      kind: 'standard',
      placeCell: { x: 3, y: 0, z: 0 }
    }
  });
  controller.handleRightClick(null);
  assert.equal(contraption.blocks.length, 1);
  assert.equal(contraption.blocks[0].size, 1);
  assert.deepEqual(
    [contraption.blocks[0].localX, contraption.blocks[0].localY, contraption.blocks[0].localZ],
    [3, 0, 0]
  );
});

test('World.hasMicroInStandardCell detects microblocks in a standard cell', () => {
  const world = new World(new THREE.Scene());
  assert.equal(world.hasMicroInStandardCell(1, 2, 3), false);
  assert.equal(world.setMicroBlock(10, 17, 25), true); // Belongs to standard cell (1,2,3).
  assert.equal(world.hasMicroInStandardCell(1, 2, 3), true);
  assert.equal(world.hasMicroInStandardCell(0, 2, 3), false);
});
