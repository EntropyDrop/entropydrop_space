import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { InventoryInput } from '@entropydrop/space-engine/storage/InventoryTypes.ts';
import { getInventoryPreviewBlocks } from '../src/engine/inventory/InventoryGeometry.ts';
import { getInventoryRenderPreviewBlocks } from '../src/engine/inventory/InventoryRenderGeometry.ts';
import { getEntityPlacementShape } from '../src/engine/inventory/InventoryPlacementGeometry.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';
import { InventoryThumbnailRenderer } from '../src/engine/render/InventoryThumbnailRenderer.ts';
import { VoxelMaterialIds } from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';

function microBlocks(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    dx: (i % 8) / 8, dy: (Math.floor(i / 8) % 8) / 8, dz: Math.floor(i / 64) / 8,
    size: 0.125, color: 0xff0000, materialId: Number(VoxelMaterialIds.EMISSIVE)
  }));
}

function entityWithMicros(count: number) {
  return { kind: 'entity', rootComponentId: 'root', blocks: microBlocks(count).map(b => ({
    localX: b.dx, localY: b.dy, localZ: b.dz, entityId: 'root', size: b.size, color: b.color, materialId: b.materialId
  })) };
}

for (const count of [199, 200, 201]) {
  test(`${count} actual blocks use ${count > 200 ? '1 m summary' : 'detailed'} display geometry`, () => {
    const slot = { kind: 'blockset', blockCount: 999, blocks: microBlocks(count) };
    const original = JSON.stringify(slot);
    const preview = getInventoryRenderPreviewBlocks(slot);
    assert.equal(preview.length, count > 200 ? 1 : count);
    assert.equal(preview.every(b => b.size === (count > 200 ? 1 : 0.125)), true);
    assert.equal(preview.every(b => b.color === 0xff0000 && b.materialId === VoxelMaterialIds.EMISSIVE), true);
    if (count > 200) assert.deepEqual(preview[0].center.toArray(), [0.5, 0.5, 0.5]);
    assert.equal(getInventoryPreviewBlocks(slot).length, count, 'exact geometry must remain available');
    assert.equal(JSON.stringify(slot), original, 'rendering must not modify inventory blocks');
  });
}

test('summary retains every occupied standard cell, including cells at negative coordinates', () => {
  const slot = { kind: 'blockset', blocks: microBlocks(201).map(b => ({ ...b, dx: b.dx - 1, dy: b.dy - 1, dz: b.dz - 1 })) };
  const summary = getInventoryRenderPreviewBlocks(slot);
  assert.equal(summary.length, 1, 'grid boundaries must not create phantom cells');
  assert.deepEqual(summary[0].center.toArray(), [-0.5, -0.5, -0.5]);
  const standard = { kind: 'blockset', blocks: Array.from({ length: 201 }, (_, i) => ({ dx: i, dy: 0, dz: 0, color: 0x123456 })) };
  assert.equal(getInventoryRenderPreviewBlocks(standard).length, 201, 'summary must not truncate to the detail threshold');
});

test('summary preserves transformed child placement and exact placement bounds', () => {
  const slot = { ...entityWithMicros(201), rootPivotOverride: [0, 0, 0],
    blocks: entityWithMicros(201).blocks.map(b => ({ ...b, entityId: 'arm' })),
    childEntities: [{ id: 'arm', parentId: 'root', pivot: [0, 0, 0],
      localPosition: [4, -2, 1], localRotation: [0, 0, Math.PI / 2] }] };
  const shape = getEntityPlacementShape(slot)!;
  const summary = getInventoryRenderPreviewBlocks(slot);
  assert.equal(summary.length, 1);
  assert.deepEqual(summary[0].center.toArray(), [3.5, -1.5, 1.5]);
  assert.equal(shape.entries.length, 201);
  assert.ok(Math.abs(shape.maxZ - shape.minZ - 0.5) < 1e-8, 'support geometry keeps the actual micro-voxel height');
  assert.equal(getEntityPlacementShape(slot), shape);
});

test('the 200-block threshold counts the whole item across static blocks and entities', () => {
  const entity = entityWithMicros(100);
  const slot: any = { kind: 'item', blockCount: 1, blocks: [],
    blockSet: { kind: 'blockset', blocks: [{ dx: 0, dy: 0, dz: 0, color: 0xff0000 }] },
    entityList: [{ ...entity, itemPosition: [1, 0, 0] }, { ...entity, itemPosition: [3, 0, 0] }] };
  assert.equal(getInventoryRenderPreviewBlocks(entity).length, 100);
  const summary = getInventoryRenderPreviewBlocks(slot);
  assert.equal(summary.length, 3);
  assert.deepEqual(summary.map(b => b.center.toArray()), [[0.5, 0.5, 0.5], [1.5, 0.5, 0.5], [3.5, 0.5, 0.5]]);
  assert.equal(getInventoryPreviewBlocks(slot).length, 201);
});

test('summary represents scaled and rotated decorations with standard cubes too', () => {
  const slot: InventoryInput = { ...entityWithMicros(201), decorations: [{ id: 'trim', color: 0x00ff00,
    position: [3.5, 1, 0.5], scale: [2, 1, 1], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }] };
  const summary = getInventoryRenderPreviewBlocks(slot);
  assert.equal(summary.length, 3);
  assert.equal(summary.every(b => b.size === 1 && !b.decoration && !b.scale && !b.quaternion), true);
  assert.deepEqual(summary.filter(b => b.color === 0x00ff00).map(b => b.center.toArray()), [[3.5, 0.5, 0.5], [3.5, 1.5, 0.5]]);
});

test('summary blends covered colors and retains the dominant material', () => {
  const blocks = microBlocks(201);
  blocks[200] = { ...blocks[200], color: 0x0000ff, materialId: VoxelMaterialIds.DEFAULT };
  const [summary] = getInventoryRenderPreviewBlocks({ kind: 'blockset', blocks });
  assert.ok(((summary.color! >> 16) & 255) > (summary.color! & 255));
  assert.ok((summary.color! & 255) > 0, 'minority colors still contribute');
  assert.equal(summary.materialId, VoxelMaterialIds.EMISSIVE);
});

test('Hammer builds its ghost from standard summary cells without changing the placement pose', () => {
  const renderer: any = Object.create(SceneRenderer.prototype);
  renderer.scene = new THREE.Scene();
  renderer.setupInventoryPlacementPreview();
  const slot = { kind: 'blockset', blocks: microBlocks(201) };
  const position = new THREE.Vector3(2.125, 3.25, 4.5);
  renderer.setInventoryPlacementPreview({ slot, position });
  const geometry = renderer.inventoryPlacementFill.geometry;
  geometry.computeBoundingBox();
  assert.deepEqual(geometry.boundingBox.min.toArray(), [0, 0, 0]);
  assert.deepEqual(geometry.boundingBox.max.toArray(), [1, 1, 1]);
  assert.equal(geometry.getAttribute('position').count, 36, 'one standard cube uses six faces');
  assert.deepEqual(renderer.inventoryPlacementGroup.position.toArray(), position.toArray());
  assert.equal(slot.blocks.length, 201);
});

test('thumbnail rendering switches from micro cubes to standard summary cubes above 200', async t => {
  const thumbnails: any = new InventoryThumbnailRenderer();
  await thumbnails.ready;
  const previousDocument = globalThis.document, previousImageData = globalThis.ImageData;
  const encoded = `data:image/png;base64,${'A'.repeat(64)}`;
  globalThis.document = { createElement: () => ({ getContext: () => ({ putImageData() {} }), toDataURL: () => encoded }) } as any;
  globalThis.ImageData = class {
    constructor(data: Uint8ClampedArray, width: number, height: number) { Object.assign(this, { data, width, height }); }
  } as any;
  t.after(() => { globalThis.document = previousDocument; globalThis.ImageData = previousImageData; });
  const rendered: Array<{ count: number; size: number }> = [];
  Object.assign(thumbnails, {
    webgpuAvailable: true, canvas: { width: 16, height: 16 }, scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(38, 1, 0.1, 500),
    renderer: { setRenderTarget() {}, render(scene: THREE.Scene) {
      scene.traverse((object: any) => { if (object.isInstancedMesh) rendered.push({ count: object.count, size: object.geometry.parameters.width }); });
    }, async readRenderTargetPixelsAsync() { return new Uint8Array(16 * 16 * 4); } }
  });
  for (const count of [200, 201]) {
    assert.equal(await thumbnails.generateThumbnail({ kind: 'blockset', blocks: microBlocks(count) }, 16, `test-${count}`), encoded);
  }
  assert.deepEqual(rendered, [{ count: 200, size: 0.125 }, { count: 1, size: 1 }]);
});
