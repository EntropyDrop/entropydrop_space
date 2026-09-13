import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { MicroVoxelLayer } from '@entropydrop/space-engine/voxel/MicroVoxelLayer.ts';
import { TORUS_SIZE_X, TORUS_SIZE_Z } from '@entropydrop/space-engine/torus/TorusWorld.ts';

const MICRO_DIVISIONS = 8;

test('two-point selector uses the shortest box across both torus seams', () => {
  const manager = new ContraptionManager(new THREE.Scene(), {}, null, null);

  manager.setCornerA({ x: TORUS_SIZE_X - 1, y: 10, z: TORUS_SIZE_Z - 1 });
  const result = manager.setCornerB({ x: 1, y: 11, z: 1 });

  assert.equal(result.clamped, false, 'a small seam-crossing box must not hit the 64-cell clamp');
  assert.deepEqual(manager.selectionCornerB, {
    x: TORUS_SIZE_X + 1,
    y: 11,
    z: TORUS_SIZE_Z + 1
  });
  assert.deepEqual(manager.getSelectionBounds(), {
    minX: TORUS_SIZE_X - 1,
    minY: 10,
    minZ: TORUS_SIZE_Z - 1,
    maxX: TORUS_SIZE_X + 1,
    maxY: 11,
    maxZ: TORUS_SIZE_Z + 1
  });
  assert.equal(manager.getSelectionBlockCount(), 3 * 2 * 3);
});

test('reverse seam selection stays adjacent on the negative unwrapped side', () => {
  const manager = new ContraptionManager(new THREE.Scene(), {}, null, null);

  manager.setCornerA({ x: 0, y: 4, z: 0 });
  manager.setCornerB({ x: TORUS_SIZE_X - 1, y: 4, z: TORUS_SIZE_Z - 1 });

  assert.deepEqual(manager.getSelectionBounds(), {
    minX: -1,
    minY: 4,
    minZ: -1,
    maxX: 0,
    maxY: 4,
    maxZ: 0
  });
  assert.equal(manager.getSelectionBlockCount(), 4);
});

test('single-cell selector toggles canonical seam cells inside one compact range', () => {
  const manager = new ContraptionManager(new THREE.Scene(), {}, null, null);

  manager.toggleWorldGlueCell({ x: TORUS_SIZE_X - 1, y: 7, z: TORUS_SIZE_Z - 1 });
  const added = manager.toggleWorldGlueCell({ x: 0, y: 7, z: 0 });

  assert.equal(added.rejected, undefined);
  assert.deepEqual(manager.connectedSelection, [
    { x: TORUS_SIZE_X - 1, y: 7, z: TORUS_SIZE_Z - 1 },
    { x: TORUS_SIZE_X, y: 7, z: TORUS_SIZE_Z }
  ]);
  assert.deepEqual(manager.getSelectionBounds(), {
    minX: TORUS_SIZE_X - 1,
    minY: 7,
    minZ: TORUS_SIZE_Z - 1,
    maxX: TORUS_SIZE_X,
    maxY: 7,
    maxZ: TORUS_SIZE_Z
  });

  manager.toggleWorldGlueCell({ x: 0, y: 7, z: 0 });
  assert.equal(manager.connectedSelection.length, 1, 'the canonical cell should toggle off its unwrapped equivalent');
});

test('micro selector materializes existing voxels across the torus seams', () => {
  const periodMx = TORUS_SIZE_X * MICRO_DIVISIONS;
  const periodMz = TORUS_SIZE_Z * MICRO_DIVISIONS;
  const world: any = {
    microVoxels: {
      cells: new Map([
        [`${periodMx - 1},40,${periodMz - 1}`, 0xff0000],
        ['0,40,0', 0x00ff00],
        ['1,40,1', 0x0000ff]
      ])
    },
    getBlock: () => BlockTypes.AIR
  };
  const manager = new ContraptionManager(new THREE.Scene(), world, null, null);

  manager.setCornerA({ x: TORUS_SIZE_X - 0.125, y: 5, z: TORUS_SIZE_Z - 0.125 }, { micro: true });
  const result = manager.setCornerB({ x: 0.125, y: 5, z: 0.125 }, { micro: true });

  assert.equal(result.clamped, false);
  assert.deepEqual(manager.microSelection, [
    { x: periodMx - 1, y: 40, z: periodMz - 1 },
    { x: periodMx, y: 40, z: periodMz },
    { x: periodMx + 1, y: 40, z: periodMz + 1 }
  ]);
  assert.deepEqual(manager.getMicroSelectionBounds(), {
    minX: periodMx - 1,
    minY: 40,
    minZ: periodMz - 1,
    maxX: periodMx + 1,
    maxY: 40,
    maxZ: periodMz + 1
  });
});

test('selection preview renders seam-crossing standard and micro boxes at compact size', () => {
  const renderer: any = Object.create(SceneRenderer.prototype);
  renderer.scene = { add() {} };
  renderer.setupBoxSelectionPreview();

  renderer.setBoxSelectionPreview(
    { x: TORUS_SIZE_X - 1, y: 3, z: TORUS_SIZE_Z - 1 },
    { x: 1, y: 3, z: 1 }
  );
  assert.deepEqual(renderer.boxSelectionFill.scale.toArray(), [3, 1, 3]);
  assert.deepEqual(renderer.boxSelectionGroup.position.toArray(), [
    TORUS_SIZE_X + 0.5,
    3.5,
    TORUS_SIZE_Z + 0.5
  ]);

  renderer.setBoxSelectionPreview(
    { x: TORUS_SIZE_X - 0.125, y: 5, z: TORUS_SIZE_Z - 0.125 },
    { x: 0.125, y: 5, z: 0.125 },
    true
  );
  assert.ok(Math.abs(renderer.boxSelectionFill.scale.x - 0.375) < 1e-9);
  assert.ok(Math.abs(renderer.boxSelectionFill.scale.z - 0.375) < 1e-9);
  assert.ok(Math.abs(renderer.boxSelectionGroup.position.x - (TORUS_SIZE_X + 0.0625)) < 1e-9);
  assert.ok(Math.abs(renderer.boxSelectionGroup.position.z - (TORUS_SIZE_Z + 0.0625)) < 1e-9);
});

test('micro extraction returns continuous coordinates for a region crossing the seam', () => {
  const periodMx = TORUS_SIZE_X * MICRO_DIVISIONS;
  const periodMz = TORUS_SIZE_Z * MICRO_DIVISIONS;
  const layer = new MicroVoxelLayer();
  layer.set(periodMx - 1, 40, periodMz - 1, 0xff0000);
  layer.set(0, 40, 0, 0x00ff00);

  const extracted = layer.extractCellsInBox(
    periodMx - 1,
    40,
    periodMz - 1,
    periodMx,
    40,
    periodMz
  );

  assert.deepEqual(extracted.map(cell => [cell.mx, cell.my, cell.mz]), [
    [periodMx - 1, 40, periodMz - 1],
    [periodMx, 40, periodMz]
  ]);
  assert.equal(layer.cells.size, 0);
});
