import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { InventoryThumbnailRenderer } from '../src/engine/render/InventoryThumbnailRenderer.ts';
import { getInventoryPreviewBlocks } from '../src/engine/render/SceneRenderer.ts';

test('getInventoryPreviewBlocks converts a blockset into voxel centers and sizes', () => {
  const blockset = {
    kind: 'blockset',
    name: 'Test Blockset',
    blocks: [
      { dx: 0, dy: 0, dz: 0, size: 1, color: 0xff0000 },
      { dx: 1, dy: 2, dz: 3, size: 0.125, color: 0x00ff00 }
    ]
  };

  const blocks = getInventoryPreviewBlocks(blockset);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].center, new THREE.Vector3(0.5, 0.5, 0.5));
  assert.equal(blocks[0].size, 1);
  assert.equal(blocks[0].color, 0xff0000);

  assert.deepEqual(blocks[1].center, new THREE.Vector3(1.0625, 2.0625, 3.0625));
  assert.equal(blocks[1].size, 0.125);
  assert.equal(blocks[1].color, 0x00ff00);
});

test('getInventoryPreviewBlocks converts a resting entity hierarchy into stopped-state preview blocks', () => {
  const entitySlot = {
    kind: 'entity',
    name: 'Articulated Robot',
    rootComponentId: 'root',
    blocks: [
      { entityId: 'root', localX: 0, localY: 0, localZ: 0, size: 1, color: 0x112233 },
      { entityId: 'arm_1', localX: 5, localY: 0, localZ: 0, size: 1, color: 0x445566 }
    ],
    childEntities: [
      {
        id: 'arm_1',
        parentId: 'root',
        pivot: [2, 0, 0],
        localPosition: [3, 0, 0],
        localRotation: [0, 0, 0, 1]
      }
    ]
  };

  const blocks = getInventoryPreviewBlocks(entitySlot);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].center.isVector3);
  assert.ok(blocks[1].center.isVector3);
  assert.equal(blocks[0].color, 0x112233);
  assert.equal(blocks[1].color, 0x445566);
});

test('InventoryThumbnailRenderer returns null gracefully when canvas or WebGL is unavailable in test environment', () => {
  const renderer = new InventoryThumbnailRenderer();
  const blockset = {
    kind: 'blockset',
    name: 'Sample',
    blocks: [{ dx: 0, dy: 0, dz: 0, size: 1, color: 0xffffff }]
  };

  // In headless test runner without document/WebGL canvas, it safely returns null or fallback without crashing
  const thumb = renderer.getThumbnail(blockset, 64);
  assert.ok(thumb === null || typeof thumb === 'string');
});

test('InventoryThumbnailRenderer singleton instance can be retrieved and cleared', () => {
  const instance = InventoryThumbnailRenderer.getInstance();
  assert.ok(instance instanceof InventoryThumbnailRenderer);
  assert.doesNotThrow(() => instance.clearCache());
});
