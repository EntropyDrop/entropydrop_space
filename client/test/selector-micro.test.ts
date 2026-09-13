import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { ActionDomain, executeBasicAction } from '@entropydrop/space-engine/actions/BasicActions.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

/**
 * Selector tool micro-block selection mode:
 * - Tab toggles between standard 1 m block selection (the default) and
 *   0.125 m micro-block selection while the Selector tool is active.
 * - Micro single-cell toggles target the surface micro cell under the crosshair.
 * - Micro 2-point boxes materialize into the existing micro voxels they contain.
 * - G/T/Del operate on the sparse micro selection.
 */

function makeMicroController(overrides: any = {}) {
  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectedSubtree = null;
  controller.selectedBlockSelection = null;
  controller.selectorLevel = null;
  controller.selectorRange = null;
  controller.selectorMicroMode = false;
  controller.hoveredContraptionHit = null;
  controller.currentRaycast = { hit: false };
  controller.inventorySlots = new Array(9).fill(null);
  controller.selectedInventoryIndex = 0;
  controller.inventories = null;
  controller.keys = {};
  controller.contraptions = overrides.manager || null;
  controller.world = overrides.world || null;
  controller.particles = { emitBlockBreak() {} };
  controller.sound = { playBlockBreak() {}, playWrenchClick() {} };
  const toasts: string[] = [];
  controller.ui = {
    showToast: m => toasts.push(m),
    renderInventoryBar() {},
    notifyContraptionStructureChanged() {}
  };
  Object.assign(controller, overrides);
  controller.__toasts = toasts;
  return controller;
}

/** Lightweight world stub exposing just the surface the selection flows use. */
function makeStubWorld(keys: Array<[string, number]>) {
  const world: any = {
    microVoxels: { cells: new Map(keys.map(([key, color]) => [key, color])) },
    getBlock: () => BlockTypes.AIR,
    getBlockColor: () => 0,
    getMicroBlock(mx, my, mz) {
      const color = world.microVoxels.cells.get(`${mx},${my},${mz}`);
      return color === undefined ? null : { block: BlockTypes.COLOR_BLOCK, color };
    },
    removeMicroBlock(mx, my, mz) {
      const key = `${mx},${my},${mz}`;
      const removed = world.microVoxels.cells.delete(key);
      return removed;
    },
    extractMicroCellRegion(minX, minY, minZ, maxX, maxY, maxZ) {
      const found = [];
      for (const key of [...world.microVoxels.cells.keys()]) {
        const [mx, my, mz] = key.split(',').map(Number);
        if (mx >= minX && mx <= maxX && my >= minY && my <= maxY && mz >= minZ && mz <= maxZ) {
          found.push({ mx, my, mz, color: world.microVoxels.cells.get(key), part: null });
          world.microVoxels.cells.delete(key);
        }
      }
      return found;
    },
    worldToChunkCoords: () => ({ cx: 0, cz: 0 }),
    getChunk: () => null
  };
  return world;
}

test('Selector defaults to standard block selection and Tab toggles micro mode', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const controller = makeMicroController({ manager });
  assert.equal(controller.selectorMicroMode, false, 'default must be standard blocks');

  // An in-progress standard single-cell selection must be discarded on switch.
  manager.toggleWorldGlueCell({ x: 1.5, y: 5, z: 1.5 });
  assert.notEqual(manager.connectedSelection, null);

  controller.toggleSelectorMicroMode();
  assert.equal(controller.selectorMicroMode, true);
  assert.equal(manager.connectedSelection, null, 'standard single selection cleared on mode switch');
  assert.equal(controller.selectorLevel, null);
  assert.equal(controller.selectorRange, null);
  assert.ok(controller.__toasts.some(m => m.includes('MICRO')));

  controller.toggleSelectorMicroMode();
  assert.equal(controller.selectorMicroMode, false);
  assert.ok(controller.__toasts.some(m => m.includes('STANDARD')));
});

test('selector micro cell resolves the surface micro cell under the crosshair', () => {
  const controller = makeMicroController();

  // Top face of standard cell (2,5,7); crosshair near (2.375, 6.0, 7.125).
  controller.currentRaycast = {
    hit: true, kind: 'standard', hitPos: { x: 2, y: 5, z: 7 },
    normal: { x: 0, y: 1, z: 0 }, entry: { x: 2.375, y: 6.0, z: 7.125 }
  };
  assert.deepEqual(controller.selectorMicroCellFromRaycast(), { x: 19, y: 47, z: 57 });

  // Left face of the same cell: entry x=2.0 pushed against normal -x.
  controller.currentRaycast = {
    hit: true, kind: 'standard', hitPos: { x: 2, y: 5, z: 7 },
    normal: { x: -1, y: 0, z: 0 }, entry: { x: 2.0, y: 5.25, z: 7.375 }
  };
  assert.deepEqual(controller.selectorMicroCellFromRaycast(), { x: 16, y: 42, z: 59 });

  // Bottom face with no entry point: falls back to the cell origin.
  controller.currentRaycast = {
    hit: true, kind: 'standard', hitPos: { x: 2, y: 5, z: 7 },
    normal: { x: 0, y: -1, z: 0 }
  };
  assert.deepEqual(controller.selectorMicroCellFromRaycast(), { x: 16, y: 40, z: 56 });

  // A micro hit selects the hit micro cell directly.
  controller.currentRaycast = {
    hit: true, kind: 'micro', hitPos: { x: 0.25, y: 5, z: 7 },
    microPos: { x: 2, y: 40, z: 56 }, normal: { x: 0, y: 1, z: 0 }
  };
  assert.deepEqual(controller.selectorMicroCellFromRaycast(), { x: 2, y: 40, z: 56 });

  // No hit → null.
  controller.currentRaycast = { hit: false };
  assert.equal(controller.selectorMicroCellFromRaycast(), null);
});

test('toggleMicroCell toggles sparse 0.125 m cells and is exclusive of standard single mode', () => {
  const manager = new ContraptionManager(new THREE.Scene(), {}, null, null);
  const info1 = manager.toggleMicroCell({ x: 2.375, y: 5.075, z: 2.5 });
  assert.equal(info1.granularity, 'micro');
  assert.equal(info1.count, 1);
  assert.equal(info1.ready, true);
  assert.deepEqual(manager.microSelection, [{ x: 19, y: 40, z: 20 }]);

  const info2 = manager.toggleMicroCell({ x: 2.375, y: 5.075, z: 2.5 });
  assert.equal(info2.count, 0);
  assert.equal(info2.ready, false);

  // Entering standard single mode clears the micro set and vice versa.
  manager.toggleWorldGlueCell({ x: 1.5, y: 5, z: 1.5 });
  assert.equal(manager.microSelection, null);
  assert.equal(manager.toggleMicroCell({ x: 1.0625, y: 5.1, z: 1.0625 }).granularity, 'micro');
  assert.equal(manager.connectedSelection, null);

  assert.equal(manager.hasValidSelection(), true);
  assert.equal(manager.getSelectionBlockCount(), 1);
  assert.equal(manager.getSelectionBounds(), null, 'sparse micro selection has no standard bounds');
  manager.clearSelection();
  assert.equal(manager.microSelection, null);
  assert.equal(manager.hasValidSelection(), false);
});

test('micro box corners clamp to the 64 standard-cell entity limit', () => {
  const world = makeStubWorld([[ '0,0,0', 0x111111 ], [ '511,0,0', 0x222222 ], [ '640,0,0', 0x333333 ]]);
  const manager = new ContraptionManager(new THREE.Scene(), world, null, null);
  const result = executeBasicAction({ manager, world, selectionHost: null }, {
    domain: ActionDomain.SELECTION,
    action: 'box',
    a: { x: 0, y: 0, z: 0 },
    b: { x: 80, y: 0, z: 0 },
    micro: true
  });
  assert.equal(result.clamped, true, 'an 80 m span exceeds the 64×64×64 limit');
  const xs = manager.microSelection.map(c => c.x).sort((a, b) => a - b);
  assert.deepEqual(xs, [0, 511], 'materialization keeps only micro cells inside the clamped span');
});

test('shared corner actions materialize a micro box into existing micro voxels', () => {
  const scene = new THREE.Scene();
  const world = makeStubWorld([
    [ '19,40,20', 0x111111 ],
    [ '20,40,20', 0x222222 ],
    [ '48,40,48', 0x333333 ] // outside the box
  ]);
  const manager = new ContraptionManager(scene, world, null, null);
  const ctx = { manager, world, selectionHost: null };

  executeBasicAction(ctx, {
    domain: ActionDomain.SELECTION,
    action: 'corner-a',
    point: { x: 2.375, y: 5.0, z: 2.5 },
    micro: true
  });
  assert.deepEqual(manager.selectionCornerA, { x: 19, y: 40, z: 20, micro: true });
  assert.equal(manager.microSelection, null, 'materialization happens only on the second corner');

  const result = executeBasicAction(ctx, {
    domain: ActionDomain.SELECTION,
    action: 'corner-b',
    point: { x: 2.5, y: 5.125, z: 2.5 },
    micro: true
  });
  assert.equal(result.materialized, 2);
  assert.equal(manager.selectionCornerA, null);
  assert.equal(manager.selectionCornerB, null);
  assert.deepEqual(manager.microSelection, [{ x: 19, y: 40, z: 20 }, { x: 20, y: 40, z: 20 }]);
  assert.equal(manager.hasValidSelection(), true);

  const info = manager.getWorldGlueSelectionInfo();
  assert.equal(info.mode, 'single');
  assert.equal(info.granularity, 'micro');
  assert.equal(info.count, 2);
  assert.ok(info.ready);
  assert.equal(info.pointCount, 0);
});

test('shared toggle-cell with the micro flag toggles 0.125 m cells', () => {
  const manager = new ContraptionManager(new THREE.Scene(), {}, null, null);
  const ctx = { manager, world: {}, selectionHost: null };
  let result = executeBasicAction(ctx, {
    domain: ActionDomain.SELECTION,
    action: 'toggle-cell',
    point: { x: 3.1875, y: 4.0625, z: 3.5625 },
    micro: true
  });
  assert.deepEqual(result.selection.cells, [{ x: 25, y: 32, z: 28 }]);
  assert.equal(result.selection.granularity, 'micro');

  result = executeBasicAction(ctx, {
    domain: ActionDomain.SELECTION,
    action: 'toggle-cell',
    point: { x: 3.1875, y: 4.0625, z: 3.5625 },
    micro: true
  });
  assert.equal(result.selection.count, 0);
  assert.equal(result.selection.ready, false);
});

test('selector click flow: two plain clicks build a materialized micro box, third clears it', () => {
  const scene = new THREE.Scene();
  const world = makeStubWorld([
    [ '19,47,20', 0x111111 ],
    [ '20,47,20', 0x222222 ]
  ]);
  const manager = new ContraptionManager(scene, world, null, null);
  const controller = makeMicroController({ manager, world });
  controller.selectorMicroMode = true;

  // Corner 1: top face of cell (2,5,2), crosshair at (2.375, 6.0, 2.125).
  controller.currentRaycast = {
    hit: true, kind: 'standard', hitPos: { x: 2, y: 5, z: 2 },
    normal: { x: 0, y: 1, z: 0 }, entry: { x: 2.375, y: 6.0, z: 2.125 }
  };
  controller.handleLeftClick();
  assert.deepEqual(manager.selectionCornerA, { x: 19, y: 47, z: 17, micro: true });
  assert.equal(manager.microSelection, null);

  // Corner 2: top face hit at (2.5, 6.0, 2.5) → micro (20, 47, 20).
  controller.currentRaycast = {
    hit: true, kind: 'standard', hitPos: { x: 2, y: 5, z: 2 },
    normal: { x: 0, y: 1, z: 0 }, entry: { x: 2.5, y: 6.0, z: 2.5 }
  };
  controller.handleLeftClick();
  assert.equal(manager.selectionCornerA, null, 'confirmed micro box is materialized, not kept as a box');
  assert.equal(manager.selectionCornerB, null);
  assert.deepEqual(manager.microSelection, [{ x: 19, y: 47, z: 20 }, { x: 20, y: 47, z: 20 }]);

  // Third plain click clears the completed micro selection.
  controller.handleLeftClick();
  assert.equal(manager.microSelection, null);
  assert.equal(manager.selectionCornerA, null);
});

test('selector Shift+click toggles micro cells while in micro mode', () => {
  const scene = new THREE.Scene();
  const world = makeStubWorld([]);
  const manager = new ContraptionManager(scene, world, null, null);
  const controller = makeMicroController({ manager, world });
  controller.selectorMicroMode = true;

  controller.currentRaycast = {
    hit: true, kind: 'standard', hitPos: { x: 2, y: 5, z: 2 },
    normal: { x: 0, y: 1, z: 0 }, entry: { x: 2.375, y: 6.0, z: 2.125 }
  };
  controller.handleLeftClick({ shiftKey: true });
  assert.deepEqual(manager.microSelection, [{ x: 19, y: 47, z: 17 }]);

  controller.handleLeftClick({ shiftKey: true });
  assert.equal(manager.microSelection.length, 0, 'toggling the same micro cell removes it');
  assert.equal(manager.getSelectionBlockCount(), 0);
});

test('Del removes exactly the selected micro voxels and nothing else', () => {
  const scene = new THREE.Scene();
  const world = makeStubWorld([
    [ '19,47,20', 0x111111 ],
    [ '20,47,20', 0x222222 ],
    [ '32,32,32', 0x333333 ] // untouched
  ]);
  const manager = new ContraptionManager(scene, world, null, null);
  const controller = makeMicroController({ manager, world });

  manager.toggleMicroCell({ x: 2.375, y: 5.875, z: 2.5 }); // (19, 47, 20)
  manager.toggleMicroCell({ x: 2.5, y: 5.875, z: 2.5 }); // (20, 47, 20)
  controller.deleteSelectionBlocks();

  assert.equal(world.microVoxels.cells.has('19,47,20'), false, 'selected micro voxel removed');
  assert.equal(world.microVoxels.cells.has('20,47,20'), false, 'selected micro voxel removed');
  assert.equal(world.microVoxels.cells.has('32,32,32'), true, 'outside micro voxel kept');
  assert.equal(manager.microSelection, null, 'selection reset after delete');
  assert.ok(controller.__toasts.some(m => m.includes('Deleted 2 micro voxels')));
});

test('G assembles a sparse micro selection into 0.125 m entity blocks', () => {
  const scene = new THREE.Scene();
  const world = makeStubWorld([
    [ '19,40,20', 0x111111 ],
    [ '20,41,20', 0x222222 ]
  ]);
  const manager = new ContraptionManager(scene, world, null, null);
  manager.toggleMicroCell({ x: 2.375, y: 5.075, z: 2.5 });
  manager.toggleMicroCell({ x: 2.5, y: 5.2, z: 2.5 });

  const result = executeBasicAction({ manager, world, selectionHost: null }, {
    domain: ActionDomain.SELECTION,
    action: 'assemble'
  });
  const entity = result.entity;
  assert.ok(entity, `assembly should succeed (reason: ${result.reason})`);
  assert.equal(entity.blocks.length, 2);
  assert.deepEqual(entity.blocks.map(b => b.size), [0.125, 0.125]);
  // The entity origin anchors the sparse min corner; the block offsets stay
  // relative to that origin even though the root pivot is the AABB center.
  const origin = { x: 19 / 8, y: 40 / 8, z: 20 / 8 };
  assert.equal(entity.originWorldPos.x, origin.x);
  assert.equal(entity.originWorldPos.y, origin.y);
  assert.equal(entity.originWorldPos.z, origin.z);
  const locals = entity.blocks
    .map(b => [Math.round(b.localX * 8) / 8, Math.round(b.localY * 8) / 8, Math.round(b.localZ * 8) / 8])
    .sort();
  assert.deepEqual(locals, [[0, 0, 0], [0.125, 0.125, 0]], 'relative offsets follow the sparse min corner');
  assert.equal(world.microVoxels.cells.size, 0, 'extracted micro voxels leave the world');
  assert.equal(manager.microSelection, null, 'selection cleared after assembly');
  assert.ok(manager.contraptions.includes(entity));
});

test('T samples a micro selection into a block set without removing world voxels', () => {
  const scene = new THREE.Scene();
  const world = makeStubWorld([
    [ '19,40,20', 0x111111 ],
    [ '20,40,20', 0x222222 ]
  ]);
  const manager = new ContraptionManager(scene, world, null, null);
  const controller = makeMicroController({ manager, world });
  controller.selectorMicroMode = true;
  manager.toggleMicroCell({ x: 2.375, y: 5.075, z: 2.5 }); // has a voxel
  manager.toggleMicroCell({ x: 3.0, y: 5.0, z: 3.0 }); // (15,40,15): empty

  const raw = controller.sampleWorldSelectionAsBlockSet();
  assert.equal(raw.length, 1, 'empty selected cells are skipped');
  assert.equal(raw[0].size, 0.125);
  assert.equal(raw[0].color, 0x111111);
  assert.deepEqual(raw[0], { dx: 0, dy: 0, dz: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK, color: 0x111111 });
  assert.equal(world.microVoxels.cells.size, 2, 'T is read-only');
});

test('entity 2-point box in micro mode keeps only 0.125 m blocks', () => {
  const scene = new THREE.Scene();
  // Three blocks in distinct cells: two standard (1 m) and one micro (0.125 m).
  const contraption = new Contraption(
    1,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0x0000ff },
      { localX: 4, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0xff0000 },
      { localX: 1.125, localY: 0.25, localZ: 0.25, size: 0.125, block: BlockTypes.COLOR_BLOCK, color: 0x00ff00 }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.registerContraption(contraption);
  contraption.stopAllNodeScripts();
  const ctx = { manager, world: {}, selectionHost: null };
  // A wide box covering the whole entity in node-local space.
  const a = { x: -3, y: -1, z: -1 };
  const b = { x: 3, y: 1, z: 1 };

  const standard = executeBasicAction(ctx, {
    domain: ActionDomain.SELECTION, action: 'entity-box', target: { contraption }, nodeId: 'root', a, b, space: 'node-local'
  });
  assert.equal(standard.selection.blocks.length, 3, 'standard mode keeps standard + micro blocks');

  const micro = executeBasicAction(ctx, {
    domain: ActionDomain.SELECTION, action: 'entity-box', target: { contraption }, nodeId: 'root', a, b, space: 'node-local', micro: true
  });
  assert.equal(micro.selection.blocks.length, 1, 'micro mode keeps only 0.125 m blocks');
  assert.equal(micro.selection.blocks[0].size, 0.125);
  assert.equal(micro.selection.blocks[0].color, 0x00ff00);
});

test('copying an entity micro selection removes empty layers below its lowest voxel', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    1,
    [
      { localX: 0, localY: 0, localZ: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK, color: 0x111111 },
      { localX: 0, localY: 0.5, localZ: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK, color: 0x222222 },
      { localX: 0.125, localY: 0.5, localZ: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK, color: 0x333333 }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.registerContraption(contraption);
  contraption.stopAllNodeScripts();
  const controller = makeMicroController({ manager });
  controller.selectorMicroMode = true;
  controller.selectedBlockSelection = {
    contraption,
    nodeId: 'root',
    blocks: contraption.blocks.filter(block => block.localY === 0.5)
  };

  const slot = controller.copySelectionToInventory();

  assert.ok(slot);
  assert.deepEqual(slot.blocks.map(block => block.localY), [0, 0],
    'the copied top layer should move down four micro cells to y=0');
  assert.deepEqual(contraption.blocks.map(block => block.localY), [0, 0.5, 0.5],
    'copying must not move the source entity voxels');
});

test('pending micro box preview carries meter coordinates and the micro flag', () => {
  const scene = new THREE.Scene();
  const world = makeStubWorld([]);
  const manager = new ContraptionManager(scene, world, null, null);
  const controller = makeMicroController({ manager, world });
  controller.selectorMicroMode = true;

  // Corner 1 is stored as the micro cell under (2.375, 5.0, 2.125) → (19, 40, 17).
  manager.setCornerA({ x: 2.375, y: 5.0, z: 2.125 }, { micro: true });
  assert.deepEqual(manager.selectionCornerA, { x: 19, y: 40, z: 17, micro: true });

  // Crosshair on the top face of cell (2,5,2) at entry (2.5, 6.0, 2.5) → cursor cell (20, 47, 20).
  controller.currentRaycast = {
    hit: true, kind: 'standard', hitPos: { x: 2, y: 5, z: 2 },
    normal: { x: 0, y: 1, z: 0 }, entry: { x: 2.5, y: 6.0, z: 2.5 }
  };
  controller.updateMicroCarvePreview();
  const preview = controller.boxSelectionPreview;
  assert.ok(preview, 'a pending micro box should show a live preview');
  assert.equal(preview.micro, true, 'the renderer must be told this preview is micro-granular');
  assert.deepEqual(preview.pointA, { x: 19 / 8, y: 40 / 8, z: 17 / 8 }, 'pointA must be corner 1 in meters');
  assert.deepEqual(preview.cursor, { x: 20 / 8, y: 47 / 8, z: 20 / 8 }, 'cursor must be the target micro cell origin in meters');
});

test('box selection preview quantizes micro coordinates to 0.125 m cells, not meters', () => {
  const renderer: any = Object.create(SceneRenderer.prototype);
  renderer.scene = { add() {} };
  renderer.setupBoxSelectionPreview();

  // Micro: corner cell (19,40,17) → meters 2.375,5.0,2.125; cursor cell (20,47,20) → 2.5,5.875,2.8.
  // The span is 2×5×4 micro cells = 0.25×1.0×0.5 m, anchored at the corner origin.
  renderer.setBoxSelectionPreview({ x: 2.375, y: 5.0, z: 2.125 }, { x: 2.5, y: 5.875, z: 2.5 }, true);
  assert.ok(renderer.boxSelectionGroup.visible);
  assert.ok(Math.abs(renderer.boxSelectionFill.scale.x - 0.25) < 1e-9, 'x span = 2 micro cells');
  assert.ok(Math.abs(renderer.boxSelectionFill.scale.y - 1.0) < 1e-9, 'y span = 5 micro cells');
  assert.ok(Math.abs(renderer.boxSelectionFill.scale.z - 0.5) < 1e-9, 'z span = 4 micro cells');
  assert.ok(Math.abs(renderer.boxSelectionGroup.position.x - 2.5) < 1e-9, 'center x = min + half span');
  assert.ok(Math.abs(renderer.boxSelectionGroup.position.y - 5.5) < 1e-9, 'center y');
  assert.ok(Math.abs(renderer.boxSelectionGroup.position.z - 2.375) < 1e-9, 'center z');

  // The same meter values in standard mode still floor to whole meter cells.
  renderer.setBoxSelectionPreview({ x: 2.375, y: 5.0, z: 2.125 }, { x: 2.5, y: 5.875, z: 2.5 });
  assert.deepEqual(renderer.boxSelectionFill.scale.toArray(), [1, 1, 1], 'standard preview spans whole meter cells');
  assert.deepEqual(renderer.boxSelectionGroup.position.toArray(), [2.5, 5.5, 2.5], 'standard preview centers on meter cells');

  renderer.setBoxSelectionPreview(null, null);
  assert.equal(renderer.boxSelectionGroup.visible, false);
});

test('entity focus guide hugs 0.125 m blocks in micro mode instead of their 1 m cell', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    1,
    [
      { localX: 0, localY: 0, localZ: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK, color: 0x00ff00 },
      { localX: 4, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  const controller = makeMicroController();
  controller.selectorRange = { contraption, nodeId: 'root', pointA: null, pointB: null };

  // Standard mode over a 1 m block: full-size guide at the cell center.
  controller.hoveredContraptionHit = {
    contraption, entityId: 'root', cell: { x: 4, y: 0, z: 0 },
    block: contraption.blocks[1], point: new THREE.Vector3(4.5, 10.5, 0.5)
  };
  controller.updateMicroCarvePreview();
  assert.ok(controller.focusBlockPreview, 'hover shows the aim guide');
  assert.equal(controller.focusBlockPreview.cellSize, 1);
  assert.equal(controller.focusBlockPreview.center.x, 4.5);

  // Micro mode over the 0.125 m block: the guide shrinks onto the block itself.
  controller.selectorMicroMode = true;
  controller.hoveredContraptionHit = {
    contraption, entityId: 'root', cell: { x: 0, y: 0, z: 0 },
    block: contraption.blocks[0], point: new THREE.Vector3(0.0625, 10.0625, 0.0625)
  };
  controller.updateMicroCarvePreview();
  assert.equal(controller.focusBlockPreview.cellSize, 0.125, 'micro target must shrink the guide');
  const center = controller.focusBlockPreview.center.toArray();
  assert.ok(center.every((v, i) => Math.abs(v - [0.0625, 10.0625, 0.0625][i]) < 1e-9), 'guide centers on the micro block');
});

/**
 * Build the scenario used by the entity-range corner tests: an entity at
 * world (0,10,0) with two stacked 1 m blocks plus one 0.125 m block sitting in
 * the upper part of the third standard cell (origin-local y 2.6..2.8).
 */
function makeEntityWithTopMicroLayer(scene) {
  const contraption = new Contraption(
    1,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0x0000ff },
      { localX: 0, localY: 1, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0x0000ff },
      { localX: 0, localY: 2.625, localZ: 0.25, size: 0.125, block: BlockTypes.COLOR_BLOCK, color: 0x00ff00 }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.registerContraption(contraption);
  contraption.stopAllNodeScripts();
  return { contraption, manager };
}

test('entity 2-point box rejects world click as corner 2 with toast warning', () => {
  const scene = new THREE.Scene();
  const { contraption, manager } = makeEntityWithTopMicroLayer(scene);
  const controller = makeMicroController({ manager, world: {} });
  controller.selectorMicroMode = true;

  const node = contraption.entityNodes.get('root');
  controller.selectorLevel = { contraption, nodeId: 'root' };
  controller.selectorRange = { contraption, nodeId: 'root', pointA: null, pointB: null };

  // Corner 1: entity click at origin-local (0.25, 2.4, 0.5).
  const pointAWorld = node.group.localToWorld(new THREE.Vector3(
    0.25 - node.pivotLocal.x, 2.4 - node.pivotLocal.y, 0.5 - node.pivotLocal.z
  ));
  controller.hoveredContraptionHit = {
    contraption, entityId: 'root', cell: { x: 0, y: 2, z: 0 },
    block: contraption.blocks[2], point: pointAWorld
  };
  controller.handleLeftClick();
  assert.ok(controller.selectorRange?.pointA, 'corner 1 anchored in node-local space');

  // Corner 2: world click is rejected because point 1 was on an entity.
  controller.hoveredContraptionHit = null;
  controller.currentRaycast = {
    hit: true, kind: 'standard', hitPos: { x: 0, y: 12, z: 0 },
    normal: { x: 0, y: 1, z: 0 }, entry: { x: 0.1875, y: 13.0, z: 0.375 }
  };
  controller.handleLeftClick();

  assert.equal(controller.selectorRange, null, 'entity selection range must be cleared on invalid world endpoint');
  assert.ok(
    controller.__toasts.some(m => m.includes('起点是实体，结束点也必须是该实体的一部分')),
    'toast should warn about invalid endpoint'
  );
});

test('entity 2-point box in standard mode also rejects world click as corner 2', () => {
  const scene = new THREE.Scene();
  const { contraption, manager } = makeEntityWithTopMicroLayer(scene);
  const controller = makeMicroController({ manager, world: {} });
  controller.selectorMicroMode = false;

  const node = contraption.entityNodes.get('root');
  controller.selectorLevel = { contraption, nodeId: 'root' };
  controller.selectorRange = { contraption, nodeId: 'root', pointA: null, pointB: null };

  const pointAWorld = node.group.localToWorld(new THREE.Vector3(
    0.25 - node.pivotLocal.x, 2.4 - node.pivotLocal.y, 0.5 - node.pivotLocal.z
  ));
  controller.hoveredContraptionHit = {
    contraption, entityId: 'root', cell: { x: 0, y: 2, z: 0 },
    block: contraption.blocks[2], point: pointAWorld
  };
  controller.handleLeftClick();
  assert.ok(controller.selectorRange?.pointA, 'corner 1 anchored in node-local space');

  controller.hoveredContraptionHit = null;
  controller.currentRaycast = {
    hit: true, kind: 'standard', hitPos: { x: 0, y: 12, z: 0 },
    normal: { x: 0, y: 1, z: 0 }, entry: { x: 0.1875, y: 13.0, z: 0.375 }
  };
  controller.handleLeftClick();

  assert.equal(controller.selectorRange, null, 'entity selection range must be cleared');
  assert.ok(
    controller.__toasts.some(m => m.includes('起点是实体，结束点也必须是该实体的一部分')),
    'toast should warn about invalid endpoint'
  );
});

test('entity-range world hover preview quantizes the cursor to the surface micro cell in micro mode', () => {
  const scene = new THREE.Scene();
  const { contraption, manager } = makeEntityWithTopMicroLayer(scene);
  const controller = makeMicroController({ manager, world: {} });
  controller.selectorMicroMode = true;

  const node = contraption.entityNodes.get('root');
  controller.selectorRange = { contraption, nodeId: 'root', pointA: null, pointB: null };
  const pointAWorld = node.group.localToWorld(new THREE.Vector3(
    0.25 - node.pivotLocal.x, 2.4 - node.pivotLocal.y, 0.5 - node.pivotLocal.z
  ));
  controller.hoveredContraptionHit = {
    contraption, entityId: 'root', cell: { x: 0, y: 2, z: 0 },
    block: contraption.blocks[2], point: pointAWorld
  };
  controller.handleLeftClick();

  // Hover the terrain (top face of cell (0,12,0), entry (0.1875, 13.0, 0.375)).
  // The preview cursor must match what the click will store, expressed in the
  // entity's oriented voxel grid: the surface micro cell origin
  // (0.125, 2.5, 0.375), not the standard cell corner (0,2,0).
  controller.hoveredContraptionHit = null;
  controller.currentRaycast = {
    hit: true, kind: 'standard', hitPos: { x: 0, y: 12, z: 0 },
    normal: { x: 0, y: 1, z: 0 }, entry: { x: 0.1875, y: 13.0, z: 0.375 }
  };
  controller.updateMicroCarvePreview();
  const preview = controller.boxSelectionPreview;
  assert.ok(preview, 'entity-range hover shows the live box preview');
  assert.equal(preview.micro, true);
  assert.ok(preview.cursor.distanceTo(new THREE.Vector3(1 / 8, 23 / 8, 3 / 8)) < 1e-12);
  assert.equal(preview.frame.object, node.group, 'preview should inherit the entity node transform');

  // In standard mode the cursor stays the whole hit cell in the same grid.
  controller.selectorMicroMode = false;
  controller.updateMicroCarvePreview();
  assert.ok(controller.boxSelectionPreview.cursor.distanceTo(new THREE.Vector3(0, 2, 0)) < 1e-12);
});

test('standard selection is unaffected: micro flag defaults to off', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.setCornerA({ x: 1.25, y: 5.125, z: 1.9 });
  manager.setCornerB({ x: 3.5625, y: 6.8, z: 4.0625 });
  assert.equal(manager.microSelection, null, 'standard box never materializes a micro set');
  assert.deepEqual(manager.selectionCornerA, { x: 1, y: 5, z: 1 });
  assert.deepEqual(manager.selectionCornerB, { x: 3, y: 6, z: 4 });
  const info = manager.getWorldGlueSelectionInfo();
  assert.equal(info.granularity, 'standard');
  assert.equal(info.mode, 'box');

  // A standard toggle-cell still returns the standard snapshot shape.
  const toggle = manager.toggleWorldGlueCell({ x: 2.5, y: 5.5, z: 2.5 });
  assert.equal(toggle.granularity, 'standard');
  assert.equal(manager.microSelection, null);
});

test('create-child from microblock selection isolates selected microblocks and calculates accurate pivot', () => {
  const scene = new THREE.Scene();
  // 5 stacked microblocks inside the same 1 m cell (0, 2, 0)
  const contraption = new Contraption(
    1,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0x0000ff },
      { localX: 0, localY: 2.0, localZ: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK, color: 0x111111 },
      { localX: 0, localY: 2.125, localZ: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK, color: 0x222222 },
      { localX: 0, localY: 2.25, localZ: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK, color: 0x333333 },
      { localX: 0, localY: 2.375, localZ: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK, color: 0x444444 },
      { localX: 0, localY: 2.5, localZ: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK, color: 0x555555 }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.registerContraption(contraption);
  contraption.stopAllNodeScripts();
  const controller = makeMicroController({ manager, world: {} });
  controller.selectorMicroMode = true;

  // Box-select only the top two microblocks (localY 2.375 and 2.5)
  const node = contraption.entityNodes.get('root');
  const a = { x: -1, y: 2.4 - node.pivotLocal.y, z: -1 };
  const b = { x: 1, y: 2.6 - node.pivotLocal.y, z: 1 };
  const result = executeBasicAction({ manager, world: {}, selectionHost: null }, {
    domain: ActionDomain.SELECTION,
    action: 'entity-box',
    target: { contraption },
    nodeId: 'root',
    a,
    b,
    space: 'node-local',
    micro: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.selection.blocks.length, 2, 'only the 2 top micro blocks selected');

  // G creates child component from the selected blocks
  controller.selectedBlockSelection = {
    contraption,
    nodeId: 'root',
    blocks: result.selection.blocks
  };
  controller.createChildFromSelectedBlocks();

  // Verify child entity
  const childDef = [...contraption.childDefinitions.values()][0];
  assert.ok(childDef, 'child component created');
  const childBlocks = contraption.blocks.filter(b => b.entityId === childDef.id);
  const rootBlocks = contraption.blocks.filter(b => (b.entityId || 'root') === 'root');
  assert.equal(childBlocks.length, 2, 'child must contain exactly the 2 selected microblocks');
  assert.equal(rootBlocks.length, 4, 'root must retain the standard block + 3 unselected microblocks');

  // Pivot should accurately center the two microblocks:
  // x: [0, 0.125] -> 0.0625, y: [2.375, 2.625] -> 2.5, z: [0, 0.125] -> 0.0625
  assert.ok(Math.abs(childDef.pivot[0] - 0.0625) < 1e-6, `pivot X = 0.0625, got ${childDef.pivot[0]}`);
  assert.ok(Math.abs(childDef.pivot[1] - 2.5) < 1e-6, `pivot Y = 2.5, got ${childDef.pivot[1]}`);
  assert.ok(Math.abs(childDef.pivot[2] - 0.0625) < 1e-6, `pivot Z = 0.0625, got ${childDef.pivot[2]}`);
});

test('assembleSelection extracts both standard blocks and microblocks from standard 2-point box', () => {
  const scene = new THREE.Scene();
  const world = {
    extractRegion(minX, minY, minZ, maxX, maxY, maxZ) {
      return [{ worldX: 0, worldY: 0, worldZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0x0000ff }];
    },
    extractMicroRegion(minX, minY, minZ, maxX, maxY, maxZ) {
      return [{ mx: 1, my: 1, mz: 1, color: 0x00ff00, part: null }];
    },
    worldToChunkCoords: () => ({ cx: 0, cz: 0 }),
    getChunk: () => null
  };
  const manager = new ContraptionManager(scene, world, null, null);
  manager.setCornerA({ x: 0, y: 0, z: 0 });
  manager.setCornerB({ x: 1, y: 1, z: 1 });

  const result = executeBasicAction({ manager, world, selectionHost: null }, {
    domain: ActionDomain.SELECTION,
    action: 'assemble'
  });

  assert.ok(result.entity, 'entity assembled');
  assert.equal(result.entity.blocks.length, 2, 'must contain both standard block and carved microblock');
  const sizes = result.entity.blocks.map(b => b.size || 1).sort();
  assert.deepEqual(sizes, [0.125, 1]);
});

test('mixed-mode setCornerB scales standard cornerA to micro coordinates', () => {
  const scene = new THREE.Scene();
  const world = makeStubWorld([
    ['16,40,16', 0x111111],
    ['19,42,19', 0x222222]
  ]);
  const manager = new ContraptionManager(scene, world, null, null);

  // Corner A set in standard mode at cell (2, 5, 2)
  manager.setCornerA({ x: 2, y: 5, z: 2 });
  assert.equal(manager.selectionCornerA.micro, undefined);
  assert.deepEqual(manager.selectionCornerA, { x: 2, y: 5, z: 2 });

  // Corner B set with micro: true at meter (2.5, 5.875, 2.5) -> micro cell (20, 47, 20)
  const result = manager.setCornerB({ x: 2.5, y: 5.875, z: 2.5 }, { micro: true });
  assert.equal(result.materialized, 2, 'should materialize both microblocks within span');
  assert.equal(manager.microSelection.length, 2);
  assert.deepEqual(manager.microSelection, [{ x: 16, y: 40, z: 16 }, { x: 19, y: 42, z: 19 }]);
});

test('T blockset copy quantizes micro coordinates cleanly without float artifacts', () => {
  const scene = new THREE.Scene();
  const world = makeStubWorld([
    ['19,40,20', 0x111111],
    ['20,40,20', 0x222222]
  ]);
  const manager = new ContraptionManager(scene, world, null, null);
  const controller = makeMicroController({ manager, world });
  controller.selectorMicroMode = true;
  manager.toggleMicroCell({ x: 2.375, y: 5.0, z: 2.5 }); // (19, 40, 20)
  manager.toggleMicroCell({ x: 2.5, y: 5.0, z: 2.5 }); // (20, 40, 20)

  const raw = controller.sampleWorldSelectionAsBlockSet();
  assert.equal(raw.length, 2);
  assert.equal(raw[0].dx, 0);
  assert.equal(raw[1].dx, 0.125);
  assert.equal(typeof raw[1].dx, 'number');
  assert.equal(raw[1].dx.toString(), '0.125', 'dx must be exactly 0.125 without float precision noise');
});

test('default mass uses block volume: 10 kg/m³, 0.01953125 kg per 0.125m microblock', () => {
  const scene = new THREE.Scene();

  // 1 standard block: volume = 1.0, mass = 10 kg
  const c1 = new Contraption(1, [{ localX: 0, localY: 0, localZ: 0, size: 1, block: BlockTypes.COLOR_BLOCK }], new THREE.Vector3(), scene);
  assert.equal(c1.mass, 10);

  // 1 micro block: volume = 0.001953125, mass = 0.01953125 kg -> clamped to MIN_BODY_MASS_KG (0.1 kg)
  const c2 = new Contraption(2, [{ localX: 0, localY: 0, localZ: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK }], new THREE.Vector3(), scene);
  assert.equal(c2.mass, 0.1);

  // 10 micro blocks: volume = 0.01953125, mass = 0.1953125 kg
  const microBlocks10 = Array.from({ length: 10 }, (_, i) => ({
    localX: i * 0.125, localY: 0, localZ: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK
  }));
  const c3 = new Contraption(3, microBlocks10, new THREE.Vector3(), scene);
  assert.equal(c3.mass, 0.195);

  // 512 micro blocks (1 subdivided standard cell): volume = 1.0, mass = 10 kg
  const microBlocks512 = [];
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      for (let z = 0; z < 8; z++) {
        microBlocks512.push({ localX: x * 0.125, localY: y * 0.125, localZ: z * 0.125, size: 0.125, block: BlockTypes.COLOR_BLOCK });
      }
    }
  }
  const c4 = new Contraption(4, microBlocks512, new THREE.Vector3(), scene);
  assert.equal(c4.mass, 10);
});

test('React UI store exposes palette, selector, and backpack tool modes', () => {
  const controller = makeMicroController();
  controller.inventories = {
    entity: { items: Array(9).fill(null) },
    blockset: { items: Array(9).fill(null) },
    colorset: { items: Array(9).fill(null) }
  };
  const ui = new SpaceUiStore();
  ui.setController(controller);

  ui.selectHotbarSlot(0);
  assert.equal(ui.getSnapshot().hotbarSlots[ui.getSnapshot().selectedHotbarIndex].value, SpecialTool.SHOVEL);

  ui.selectHotbarSlot(2);
  assert.equal(ui.getSnapshot().hotbarSlots[ui.getSnapshot().selectedHotbarIndex].value, SpecialTool.SELECTOR);

  ui.selectHotbarSlot(3);
  assert.equal(ui.getSnapshot().hotbarSlots[ui.getSnapshot().selectedHotbarIndex].value, SpecialTool.HAMMER);
});

test('toggleSelectorMicroMode toggles between standard (1m) and micro (0.125m) mode with UI sync', () => {
  const controller = makeMicroController();
  const uiCalls: string[] = [];
  controller.ui = {
    updateToolPanelMode: () => uiCalls.push('updateToolPanelMode'),
    renderHotbar: () => uiCalls.push('renderHotbar'),
    showToast: (msg) => uiCalls.push(`toast:${msg}`)
  } as any;

  assert.equal(controller.selectorMicroMode, false, 'default is standard mode');
  controller.toggleSelectorMicroMode();
  assert.equal(controller.selectorMicroMode, true, 'toggles to micro mode');
  assert.ok(uiCalls.includes('updateToolPanelMode'));
  assert.ok(uiCalls.some(c => c.includes('MICRO mode')));

  controller.toggleSelectorMicroMode();
  assert.equal(controller.selectorMicroMode, false, 'toggles back to standard mode');
  assert.ok(uiCalls.some(c => c.includes('STANDARD mode')));
});

test('micro selector can select child component region and switch levels', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    1,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0x0000ff },
      { localX: 1, localY: 0, localZ: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK, color: 0x00ff00 },
      { localX: 1.125, localY: 0, localZ: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK, color: 0x00ff00 }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  // Create child component 'arm' containing the micro blocks
  const child = contraption.createChildEntity('root', [contraption.blocks[1], contraption.blocks[2]], 'arm');
  assert.ok(child, 'child created');

  const manager = new ContraptionManager(scene, {}, null, null);
  manager.registerContraption(contraption);
  contraption.stopAllNodeScripts();

  const toasts: string[] = [];
  const controller = makeMicroController({
    manager,
    selectorMicroMode: true,
    hoveredContraption: contraption,
    ui: {
      showToast: (m: string) => toasts.push(m),
      renderInventoryBar() {},
      notifyContraptionStructureChanged() {}
    }
  });

  const armNode = contraption.entityNodes.get('arm');
  const armBlock = contraption.blocks.find(b => b.entityId === 'arm');

  // 1. First click sets pointA on child component level
  const point1 = armNode.group.localToWorld(new THREE.Vector3(0, 0, 0));
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'arm',
    block: armBlock,
    point: point1
  };
  controller.handleLeftClick();
  assert.equal(controller.selectorLevel?.nodeId, 'arm', 'switched to arm component level');
  assert.ok(controller.selectorRange?.pointA, 'pointA set on arm');

  // 2. Second click sets pointB and resolves block selection
  // Deliberately extend box slightly toward root to verify ancestor blocks don't falsely reject with child component warning
  const point2 = armNode.group.localToWorld(new THREE.Vector3(0.2, 0.2, 0.2));
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'arm',
    block: armBlock,
    point: point2
  };
  controller.handleLeftClick();

  assert.ok(controller.selectedBlockSelection, 'block selection created on child component');
  assert.equal(controller.selectedBlockSelection.nodeId, 'arm');
  assert.equal(controller.selectedBlockSelection.blocks.length, 2);
  assert.ok(!toasts.includes('选区不能包含已分配的子组件方块'), 'ancestor root should not trigger child component rejection');
});

test('micro selector hologram bounding box is scaled by MICRO_SIZE', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  const renderer: any = Object.create(SceneRenderer.prototype);
  renderer.scene = scene;
  renderer.camera = camera;
  renderer.setupSelectionHologram();

  // 8 micro cells across (0..7) = exactly 1.0 meter physical span
  renderer.updateSelectionHologram({ minX: 0, maxX: 7, minY: 0, maxY: 7, minZ: 0, maxZ: 7 }, null, null, true);
  assert.ok(renderer.selectionGroup.visible);
  assert.equal(Math.round(renderer.selectionGroup.scale.x * 1000) / 1000, 1.0, 'scale.x should be 1.0m (8 * 0.125)');
  assert.equal(Math.round(renderer.selectionGroup.scale.y * 1000) / 1000, 1.0, 'scale.y should be 1.0m (8 * 0.125)');
  assert.equal(Math.round(renderer.selectionGroup.scale.z * 1000) / 1000, 1.0, 'scale.z should be 1.0m (8 * 0.125)');
});

test('micro box selection stays virtual and only Del subdivides the entity', () => {
  const scene = new THREE.Scene();
  // Entity with only standard 1m blocks.
  const contraption = new Contraption(
    10,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0xff0000 },
      { localX: 1, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0x00ff00 },
      { localX: 2, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0x0000ff }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.registerContraption(contraption);
  contraption.stopAllNodeScripts();
  const controller = makeMicroController({ manager });
  controller.selectorMicroMode = true;

  contraption.rootGroup.updateMatrixWorld(true);
  const node = contraption.entityNodes.get('root');
  const pivot = node.pivotLocal;
  /** Authored (block-local) point -> world, so the stored range corners are exact. */
  const toWorld = (ax: number, ay: number, az: number) => node.group.localToWorld(
    new THREE.Vector3(ax - pivot.x, ay - pivot.y, az - pivot.z)
  );
  const clickAuthored = (ax: number, ay: number, az: number) => {
    controller.hoveredContraptionHit = {
      contraption,
      entityId: 'root',
      block: contraption.blocks.find((b: any) => (b.size || 1) >= 1 && Math.floor(b.localX + 1e-6) === 0),
      cell: { x: 0, y: 0, z: 0 },
      point: toWorld(ax, ay, az),
      worldNormal: new THREE.Vector3(0, 0, 0),
      normal: new THREE.Vector3(0, 0, 0)
    };
    controller.handleLeftClick();
  };

  const standardBefore = contraption.blocks.filter((b: any) => (b.size || 1) >= 1).length;

  // A 0.15 m box inside the first standard block = 2x2x2 micro cells.
  clickAuthored(0.05, 0.05, 0.05);
  assert.ok(controller.selectorRange?.pointA, 'point 1 set');
  clickAuthored(0.2, 0.2, 0.2);

  const selection = controller.selectedBlockSelection;
  assert.ok(selection, 'preselected state reached in micro mode');
  assert.equal(selection.micro, true, 'the selection is a micro selection');
  assert.equal(selection.virtualMicro, true, 'the selection is still virtual (nothing subdivided yet)');
  assert.equal(selection.blocks.length, 8, 'a 2x2x2 micro box selects exactly eight 0.125 m voxels');
  assert.ok(
    selection.blocks.every((b: any) => (b.size || 1) < 1 && b.virtualMicro === true),
    'the selected state must be 0.125 m voxels, never the nearest standard block'
  );

  // Selecting is non-destructive: the entity still has its standard blocks only.
  assert.equal(
    contraption.blocks.filter((b: any) => (b.size || 1) >= 1).length,
    standardBefore,
    'selecting must not subdivide any standard block'
  );
  assert.equal(
    contraption.blocks.filter((b: any) => (b.size || 1) < 1).length,
    0,
    'selecting must not create micro geometry'
  );
  assert.equal(controller.__toasts.filter((t: string) => t.includes('No blocks inside')).length, 0, 'no No blocks error toast');

  // Del is the moment the geometry is subdivided.
  controller.deleteSelectionBlocks();
  assert.equal(
    contraption.blocks.filter((b: any) => (b.size || 1) >= 1).length,
    standardBefore - 1,
    'Del subdivided the covered standard block on demand'
  );
  assert.equal(
    contraption.blocks.filter((b: any) => (b.size || 1) < 1).length,
    512 - 8,
    'only the selected cells were removed from the newly subdivided micro geometry'
  );
  assert.equal(controller.selectedBlockSelection, null, 'Del consumes the selection');
});

test('F subdivides a virtual micro selection on demand before expanding it', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    12,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0xff0000 }],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.registerContraption(contraption);
  contraption.stopAllNodeScripts();
  const controller = makeMicroController({ manager });
  controller.selectorMicroMode = true;

  contraption.rootGroup.updateMatrixWorld(true);
  const node = contraption.entityNodes.get('root');
  const pivot = node.pivotLocal;
  const clickAuthored = (ax: number, ay: number, az: number) => {
    controller.hoveredContraptionHit = {
      contraption,
      entityId: 'root',
      block: contraption.blocks.find((b: any) => (b.size || 1) >= 1),
      cell: { x: 0, y: 0, z: 0 },
      point: node.group.localToWorld(new THREE.Vector3(ax - pivot.x, ay - pivot.y, az - pivot.z)),
      worldNormal: new THREE.Vector3(0, 0, 0),
      normal: new THREE.Vector3(0, 0, 0)
    };
    controller.handleLeftClick();
  };
  clickAuthored(0.05, 0.05, 0.05);
  clickAuthored(0.2, 0.2, 0.2);
  assert.equal(contraption.blocks.length, 1, 'selection alone leaves the entity untouched');

  controller.fillSelectionBlocks(0x00ff00);

  assert.equal(
    contraption.blocks.filter((b: any) => (b.size || 1) >= 1).length,
    0,
    'F subdivided the covered standard block'
  );
  const filled = contraption.blocks.filter((b: any) => (b.size || 1) < 1 && b.color === 0x00ff00);
  assert.equal(filled.length, 8, 'the 2x2x2 virtual box was filled with the active color');
});

test('Shift+click in micro mode toggles a virtual 0.125 m cell; P subdivides and recolors it', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    11,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0xff0000 }],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.registerContraption(contraption);
  contraption.stopAllNodeScripts();
  const controller = makeMicroController({ manager });
  controller.selectorMicroMode = true;

  // Aim at the +Y (top) face of the 1 m block; placeMicroPos is the neighboring
  // micro cell along the normal.
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'root',
    block: contraption.blocks[0],
    cell: { x: 0, y: 0, z: 0 },
    point: new THREE.Vector3(0.5, 11.0, 0.5),
    placeMicroPos: { localX: 0.5, localY: 1.0, localZ: 0.5 },
    normal: { x: 0, y: 1, z: 0 }
  };
  controller.handleLeftClick({ shiftKey: true });

  assert.ok(controller.selectedBlockSelection, 'micro shift selection should be created');
  const selected = controller.selectedBlockSelection.blocks;
  assert.equal(selected.length, 1);
  assert.ok((selected[0].size || 1) < 1, 'the toggled block must be a 0.125 m voxel');
  assert.equal(selected[0].virtualMicro, true, 'the toggled cell is virtual until an operation runs');
  // (1.0 - 1 * 0.125 / 2) * 8 = 7.5 -> cell 7 -> localY = 0.875
  assert.equal(Math.round(selected[0].localY * 1000) / 1000, 0.875, 'the aimed surface micro cell is toggled');
  assert.equal(contraption.blocks.length, 1, 'toggling alone must not subdivide the standard block');

  // P is the moment the geometry is subdivided.
  controller.selectedColor = 0x00ff00;
  controller.paintSelectionBlocks();

  assert.equal(
    contraption.blocks.filter((b: any) => (b.size || 1) < 1).length,
    512,
    'P subdivided the standard block into its 512 micro voxels'
  );
  const painted = contraption.blocks.filter((b: any) => (b.size || 1) < 1 && b.color === 0x00ff00);
  assert.equal(painted.length, 1, 'only the selected cell was recolored');
  assert.equal(Math.round(painted[0].localY * 1000) / 1000, 0.875);
  assert.equal(
    contraption.blocks.filter((b: any) => (b.size || 1) < 1 && b.color === 0xff0000).length,
    511,
    'the remaining micro voxels keep the original color'
  );
});

test('micro Del carves every covered block with one atomic rebuild', () => {
  const scene = new THREE.Scene();
  // Four standard blocks: a per-block subdivision would rebuild the entity five
  // times (4 subdivisions + 1 delete); the atomic path must rebuild once.
  const contraption = new Contraption(
    13,
    [0, 1, 2, 3].map(x => ({ localX: x, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0xff0000 })),
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.registerContraption(contraption);
  contraption.stopAllNodeScripts();
  const controller = makeMicroController({ manager });
  controller.selectorMicroMode = true;

  contraption.rootGroup.updateMatrixWorld(true);
  const node = contraption.entityNodes.get('root');
  const pivot = node.pivotLocal;
  const click = (ax: number, ay: number, az: number) => {
    controller.hoveredContraptionHit = {
      contraption,
      entityId: 'root',
      block: contraption.blocks.find((b: any) => (b.size || 1) >= 1),
      cell: { x: 0, y: 0, z: 0 },
      point: node.group.localToWorld(new THREE.Vector3(ax - pivot.x, ay - pivot.y, az - pivot.z)),
      worldNormal: new THREE.Vector3(0, 0, 0),
      normal: new THREE.Vector3(0, 0, 0)
    };
    controller.handleLeftClick();
  };
  // A thin box covering a sliver of all four blocks.
  click(0.05, 0.05, 0.05);
  click(3.05, 0.2, 0.2);
  const sources = new Set(
    controller.selectedBlockSelection.blocks
      .filter((b: any) => b.virtualMicro)
      .map((b: any) => b.sourceBlock)
  );
  assert.equal(sources.size, 4, 'the range covers all four standard blocks');

  let rebuilds = 0;
  const original = contraption.rebuildAfterBlockChange.bind(contraption);
  contraption.rebuildAfterBlockChange = (...args: any[]) => {
    rebuilds++;
    return original(...args);
  };

  controller.deleteSelectionBlocks();

  assert.equal(rebuilds, 1, 'only the final carved geometry should be rebuilt');
  assert.ok(contraption.blocks.length > 1, 'the entity keeps its remaining micro geometry');
});

test('micro selection over a standard block stays anchored after another block was carved', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    14,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0xff0000 },
      { localX: 1, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0x00ff00 }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.registerContraption(contraption);
  contraption.stopAllNodeScripts();
  const controller = makeMicroController({ manager });
  controller.selectorMicroMode = true;

  contraption.rootGroup.updateMatrixWorld(true);
  const node = contraption.entityNodes.get('root');
  const pivot = node.pivotLocal;
  const clickAuthored = (ax: number, ay: number, az: number) => {
    controller.hoveredContraptionHit = {
      contraption,
      entityId: 'root',
      block: contraption.blocks.find((b: any) => (b.size || 1) >= 1),
      cell: { x: 0, y: 0, z: 0 },
      point: node.group.localToWorld(new THREE.Vector3(ax - pivot.x, ay - pivot.y, az - pivot.z)),
      worldNormal: new THREE.Vector3(0, 0, 0),
      normal: new THREE.Vector3(0, 0, 0)
    };
    controller.handleLeftClick();
  };

  // 1. Carve a micro hole in block 0.
  clickAuthored(0.05, 0.05, 0.05);
  clickAuthored(0.2, 0.2, 0.2);
  controller.deleteSelectionBlocks();
  assert.equal(contraption.blocks.filter((b: any) => (b.size || 1) >= 1).length, 1, 'block 1 stays standard');
  const carvedMicro = contraption.blocks.filter((b: any) => (b.size || 1) < 1).length;
  assert.equal(carvedMicro, 504, 'block 0 is now micro geometry with a hole');

  // 2. Start a micro box on the still-standard block 1.
  clickAuthored(1.05, 0.05, 0.05);
  assert.ok(controller.selectorRange?.pointA, 'point 1 set on block 1');

  // The live preview must clamp to the whole component, not to block 0's carved
  // micro geometry (which is the only micro geometry that exists so far).
  const frame = controller.rangePreviewFrame(controller.selectorRange);
  assert.ok(frame?.bounds, 'preview frame exists');
  assert.ok(frame.bounds.max.x >= 2 - 1e-6, 'preview frame must reach the selected standard block');

  // The focus guide must target the 0.125 m cell, not the whole 1 m block.
  controller.updateMicroCarvePreview();
  assert.equal(controller.focusBlockPreview?.cellSize, 0.125, 'micro mode must guide a 0.125 m cell');

  // 3. Complete the selection and delete: block 0's carved geometry must survive.
  clickAuthored(1.2, 0.2, 0.2);
  const selection = controller.selectedBlockSelection;
  assert.ok(selection, 'selection completed over block 1');
  assert.ok(
    selection.blocks.every((b: any) => b.localX >= 1 - 1e-6),
    'the selection must not leak onto block 0'
  );
  assert.equal(selection.bounds.minX, 8, 'selection bounds are anchored to block 1');

  controller.deleteSelectionBlocks();
  const block0Micro = contraption.blocks.filter((b: any) => (b.size || 1) < 1 && b.localX < 1 - 1e-6);
  const block1Micro = contraption.blocks.filter((b: any) => (b.size || 1) < 1 && b.localX >= 1 - 1e-6);
  assert.equal(block0Micro.length, 504, "block 0's carved geometry is untouched");
  assert.equal(block1Micro.length, 512 - 8, 'only the selected cells of block 1 were removed');
});
