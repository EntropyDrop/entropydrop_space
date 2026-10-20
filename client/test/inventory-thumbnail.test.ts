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

test('thumbnail keys reuse item geometry until its resource version changes', () => {
  const renderer = new InventoryThumbnailRenderer() as any;
  const item = { kind: 'item', blocks: [{}], blockSet: { kind: 'blockset',
    blocks: [{ dx: 0, dy: 0, dz: 0, size: 1, color: 1 }] }, entityList: [] };
  const compute = renderer.computeItemCacheKey.bind(renderer);
  let computations = 0;
  renderer.computeItemCacheKey = (...args: unknown[]) => { computations++; return compute(...args); };
  const first = renderer.getItemCacheKey(item, 96, 1);
  for (let i = 0; i < 100; i++) assert.equal(renderer.getItemCacheKey(item, 96, 1), first);
  assert.equal(computations, 1);
  item.blockSet.blocks[0].color = 2;
  const changed = renderer.getItemCacheKey(item, 96, 2);
  assert.notEqual(changed, first);
  assert.equal(computations, 2);
  renderer.clearCache();
  assert.equal(renderer.getItemCacheKey(item, 96, 2), changed);
  assert.equal(computations, 3);
});

test('local item thumbnails encode WebGPU readback rows at hotbar and backpack sizes', async t => {
  const thumbnails = new InventoryThumbnailRenderer() as any;
  await thumbnails.ready;
  const previousDocument = globalThis.document;
  const previousImageData = globalThis.ImageData;
  t.after(() => { globalThis.document = previousDocument; globalThis.ImageData = previousImageData; });

  const encoded = `data:image/png;base64,${'A'.repeat(64)}`;
  let expectedPixels: Uint8ClampedArray;
  let images = 0, renderedBlocks = 0;
  let packedReadback = false;
  globalThis.ImageData = class {
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      assert.equal(data.length, width * height * 4, 'ImageData requires tightly packed RGBA');
      assert.deepEqual(data, expectedPixels, 'row order and pixel channels must survive removal of padding');
      images++;
    }
  } as any;
  globalThis.document = { createElement: () => ({
    getContext: () => ({ putImageData() {} }), toDataURL: () => encoded
  }) } as any;
  Object.assign(thumbnails, {
    webgpuAvailable: true,
    canvas: { width: 128, height: 128 },
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(38, 1, 0.1, 500),
    renderer: {
      setSize() {}, setRenderTarget() {},
      render(scene: THREE.Scene) {
        renderedBlocks = 0;
        scene.traverse((object: any) => { if (object.isInstancedMesh) renderedBlocks += object.count; });
      },
      async readRenderTargetPixelsAsync(target: THREE.RenderTarget, _x: number, _y: number, width: number, height: number) {
        assert.equal(target.texture.format, THREE.RGBAFormat);
        assert.equal(target.texture.type, THREE.UnsignedByteType);
        const rowBytes = width * 4;
        const rowStride = packedReadback ? rowBytes : Math.ceil(rowBytes / 256) * 256;
        // Three r183 omits padding after the last row and may return a view.
        const length = (height - 1) * rowStride + rowBytes;
        const pixels = new Uint8Array(new ArrayBuffer(length + 8), 8, length).fill(0xee);
        expectedPixels = new Uint8ClampedArray(width * height * 4);
        for (let row = 0; row < height; row++) {
          for (let byte = 0; byte < rowBytes; byte++) {
            const value = (row * 7 + byte) % 256;
            pixels[row * rowStride + byte] = value;
            expectedPixels[row * rowBytes + byte] = value;
          }
        }
        return pixels;
      }
    }
  });

  const blockSet = { kind: 'blockset', blocks: [{ dx: 0, dy: 0, dz: 0, color: 0xff0000 }] };
  const entity = { kind: 'entity', rootComponentId: 'root', itemPosition: [2, 0, 0],
    blocks: [{ entityId: 'root', localX: 0, localY: 0, localZ: 0, color: 0x00ff00 }] };
  const items = [
    { item: blockSet, count: 1 },
    { item: { kind: 'item', blocks: [], blockSet, entityList: [] }, count: 1 },
    { item: { kind: 'item', blocks: [], entityList: [entity] }, count: 1 },
    { item: { kind: 'item', blocks: [], blockSet, entityList: [entity] }, count: 2 }
  ];
  let notifications = 0;
  const unsubscribe = thumbnails.subscribe(() => { notifications++; });
  t.after(unsubscribe);
  for (const packed of [false, true]) {
    packedReadback = packed;
    thumbnails.clearCache();
    for (const { item, count } of items) {
      for (const size of [64, 96, 128, 144]) {
        const before = images, beforeNotifications = notifications;
        assert.equal(thumbnails.getThumbnail(item, size), null, 'first request queues a thumbnail');
        await thumbnails.queue;
        assert.equal(thumbnails.getThumbnail(item, size), encoded, 'completed thumbnail is cached for the UI');
        assert.equal(images, before + 1);
        assert.equal(notifications, beforeNotifications + 1, 'completion refreshes subscribed backpack and hotbar components');
        assert.equal(renderedBlocks, count);
      }
    }
  }
});
