import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption, MAX_ENTITY_BOUNDS } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { ActionDomain, executeBasicAction } from '../src/actions/BasicActions.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';

/**
 * Entity and selection bounding boxes are capped at 256×256×256:
 * - world box corners clamp to the cap (result reports `clamped`);
 * - single-cell toggles and `cells` batches that would exceed the cap fail with `bounds_exceeded`;
 * - entity placements (shovel RMB / script self.voxels) that would extend the entity AABB
 *   past the cap fail with `bounds_exceeded`.
 */

assert.equal(MAX_ENTITY_BOUNDS, 256, 'the cap is 256 standard cells per axis');

function makeEntity(id) {
  const scene = new THREE.Scene();
  const entity = new Contraption(
    id,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }],
    new THREE.Vector3(),
    scene
  ) as any;
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.registerContraption(entity);
  return { entity, manager };
}

function placeStandard(entity, manager, cell) {
  return executeBasicAction({ manager }, {
    domain: ActionDomain.ENTITY,
    action: 'place-standard',
    target: { contraption: entity },
    nodeId: 'root',
    cell
  });
}

function placeMicro(entity, manager, micro) {
  return executeBasicAction({ manager }, {
    domain: ActionDomain.ENTITY,
    action: 'place-micro',
    target: { contraption: entity },
    nodeId: 'root',
    micro
  });
}

test('entity standard placements stay within the 256×256×256 AABB', () => {
  const { entity, manager } = makeEntity(1);

  assert.equal(placeStandard(entity, manager, { x: 255, y: 0, z: 0 }).reason, 'placed', 'a span of exactly 256 is the cap');
  assert.equal(entity.blocks.length, 2);

  assert.equal(placeStandard(entity, manager, { x: 256, y: 0, z: 0 }).reason, 'bounds_exceeded', 'the 257th cell along +X must be rejected');
  assert.equal(placeStandard(entity, manager, { x: -1, y: 0, z: 0 }).reason, 'bounds_exceeded', 'the 257th cell along -X must be rejected');
  assert.equal(entity.blocks.length, 2, 'rejected placements must not grow the entity');

  assert.equal(placeStandard(entity, manager, { x: 0, y: 255, z: 0 }).reason, 'placed');
  assert.equal(placeStandard(entity, manager, { x: 0, y: 256, z: 0 }).reason, 'bounds_exceeded');
});

test('entity micro placements respect the cap through their parent cell', () => {
  const { entity, manager } = makeEntity(2);

  // Micro index 2047 -> local 255.875 -> parent cell 255: span 256, allowed.
  assert.equal(placeMicro(entity, manager, [2047, 0, 0]).reason, 'placed');
  // Micro index 2049 -> local 256.125 -> parent cell 256: span 257, rejected.
  assert.equal(placeMicro(entity, manager, [2049, 0, 0]).reason, 'bounds_exceeded');
  assert.equal(entity.blocks.length, 2);
});

test('world box corners clamp to the 256×256×256 selection limit', () => {
  const manager = new ContraptionManager(new THREE.Scene(), {}, null, null);

  manager.setCornerA({ x: 100, y: 0, z: 0 });
  const result = manager.setCornerB({ x: 400, y: 70, z: 5 });
  assert.deepEqual(manager.selectionCornerB, { x: 355, y: 70, z: 5 });
  assert.equal(result.clamped, true);
  const bounds = manager.getSelectionBounds();
  assert.equal(bounds.maxX - bounds.minX + 1, 256);

  // Negative direction clamps the same way.
  manager.setCornerA({ x: 400, y: 0, z: 0 });
  assert.deepEqual(manager.setCornerB({ x: 100, y: 0, z: 0 }).clamped, true);
  assert.equal(manager.selectionCornerB.x, 145);
  assert.equal(manager.setCornerB({ x: 399, y: 0, z: 0 }).clamped, false, 'within the cap no clamp is reported');
});

test('single-cell selection rejects cells that would exceed the limit', () => {
  const manager = new ContraptionManager(new THREE.Scene(), {}, null, null);
  const toggle = (x, y, z) => manager.toggleWorldGlueCell({ x, y, z });

  assert.equal(toggle(0, 0, 0).count, 1);
  assert.equal(toggle(255, 0, 0).count, 2);
  const rejected = toggle(256, 0, 0);
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.count, 2, 'the out-of-limit cell must not be added');
  assert.equal(toggle(0, 0, 0).count, 1, 'removal stays allowed and un-rejected');
});

test('setConnectedSelection rejects out-of-limit batches without touching state', () => {
  const manager = new ContraptionManager(new THREE.Scene(), {}, null, null);

  const tooWide = [];
  for (let x = 0; x <= 256; x++) tooWide.push({ x, y: 0, z: 0 }); // 257 cells
  assert.equal(manager.setConnectedSelection(tooWide), false);
  assert.equal(manager.connectedSelection, null, 'a rejected batch must not replace the selection');

  const fits = [];
  for (let x = 0; x < 256; x++) fits.push({ x, y: 0, z: 0 }); // exactly 256 cells
  assert.equal(manager.setConnectedSelection(fits), true);
  assert.equal(manager.connectedSelection.length, 256);
});

test('the script selection API reports bounds_exceeded and clamped', () => {
  const manager = new ContraptionManager(new THREE.Scene(), {}, null, null);
  const api = manager.scriptSelectionApi;

  const cells: any[] = [];
  for (let x = 0; x <= 256; x++) cells.push([x, 0, 0]);
  const batch = api.cells(cells);
  assert.equal(batch.ok, false);
  assert.equal(batch.reason, 'bounds_exceeded');

  assert.deepEqual(api.toggle([0, 0, 0]), { ok: true, selected: 1, reason: 'selected' });
  assert.deepEqual(api.toggle([256, 0, 0]), { ok: false, selected: 1, reason: 'bounds_exceeded' }, 'a 257-cell span must be rejected');
  assert.equal(manager.connectedSelection.length, 1, 'a rejected toggle must not grow the selection');

  const unanchored = api.cornerB({ x: 100, y: 0, z: 0 });
  assert.equal(unanchored.clamped, false, 'cornerB without cornerA is not clamped');
  api.cornerA({ x: 0, y: 0, z: 0 });
  const pulled = api.cornerB({ x: 300, y: 0, z: 0 });
  assert.equal(pulled.clamped, true);
  assert.equal(manager.getSelectionBlockCount(), 256, 'the x axis clamps to exactly 256 cells');

  const box = api.box([0, 0, 0], [300, 0, 0]);
  assert.equal(box.clamped, true);
  assert.equal(box.selected, 256);
});
