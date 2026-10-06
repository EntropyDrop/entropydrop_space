import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import { TORUS_SIZE_X, wrapX, wrapZ } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { decodeInventoryResource } from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { getInventoryPreviewBlocks, SceneRenderer } from '../src/engine/render/SceneRenderer.ts';

function fixture() {
  const terrain = new Map<string, number>();
  const micros = new Map<string, any>();
  const key = (x, y, z) => `${wrapX(x)},${y},${wrapZ(z)}`;
  const world = {
    microVoxels: { cells: micros },
    getBlock: (x, y, z) => terrain.has(key(x, y, z)) ? BlockTypes.COLOR_BLOCK : BlockTypes.AIR,
    getBlockColor: (x, y, z) => terrain.get(key(x, y, z)),
    getBlockMaterial: () => 1,
    getMicroBlock: (x, y, z) => micros.get(`${x},${y},${z}`),
    getMicroBlocksInAABB: () => [],
  };
  const manager = new ContraptionManager(new THREE.Scene(), world as any, null, null);
  const controller: any = Object.create(PlayerController.prototype);
  Object.assign(controller, {
    activeTool: SpecialTool.SELECTOR, world, contraptions: manager, keys: {},
    sound: { playBlockPlace() {} },
  });
  controller.inventoryCategory();
  const toasts: string[] = [];
  controller.ui = { showToast: message => toasts.push(message), renderInventoryBar() {} };
  const select = (a, b, micro = false) => {
    manager.setCornerA(a, { micro });
    manager.setCornerB(b, { micro });
  };
  const entity = (origin, options: any = {}) => {
    const source = manager.buildFromSlot({
      rootComponentId: 'root', name: 'Motor',
      blocks: [{ localX: 0, localY: 0, localZ: 0, size: options.size || 1,
        entityId: 'root', block: BlockTypes.COLOR_BLOCK, color: 0x12ab34, materialId: 1 },
      ...(options.child ? [{ localX: 1, localY: 0, localZ: 0, size: 1,
        entityId: 'arm', block: BlockTypes.COLOR_BLOCK, color: 0x334455 }] : [])],
      childEntities: options.child ? [{ id: 'arm', parentId: 'root', pivot: [1.5, 0.5, 0.5] }] : [],
      scripts: [{ id: 'root', code: 'export function update(): void {}', language: 'assemblyscript' }],
      enabled: [{ id: 'root', enabled: true }],
    }, new THREE.Vector3(...origin), null, false);
    if (options.rotation) {
      source.quaternion.copy(options.rotation);
      source.position.copy(new THREE.Vector3(...origin))
        .add(source.localCenter.clone().applyQuaternion(options.rotation));
      source.updateTransform();
    }
    return source;
  };
  const dispose = () => manager.contraptions.forEach(source => source.dispose());
  return { controller, manager, terrain, micros, key, select, entity, toasts, dispose };
}

test('default Copy combines sparse orange terrain and complete cyan-box entities in one frame', () => {
  const f = fixture();
  try {
    f.select({ x: 10, y: 20, z: 30 }, { x: 16, y: 22, z: 33 });
    // Orange shape cells occupy only the corners; entities use the entire cyan guide box.
    f.manager.connectedSelection = [{ x: 10, y: 20, z: 30 }, { x: 16, y: 22, z: 33 }];
    f.terrain.set(f.key(10, 20, 30), 0xff0000);
    f.terrain.set(f.key(16, 22, 33), 0x00ff00);
    f.terrain.set(f.key(12, 20, 30), 0x0000ff);
    const first = f.entity([13, 21, 30], { child: true });
    first.constraintDefinitions.set('world_joint', {
      id: 'world_joint', type: 'point', bodyA: null, bodyB: 'root',
      anchorA: [13.5, 21.5, 30.5], anchorB: [0, 0, 0], stiffness: 0.9,
    });
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    f.entity([15, 21, 32], { rotation });
    f.entity([16.5, 21, 30]); // Crosses the right boundary.
    f.entity([20, 21, 30]);
    const before = first.serializeSubtree();
    const item = f.controller.copySelectionSmart();
    assert.ok(item, f.toasts.join('\n'));
    assert.equal(item.kind, 'item');
    assert.equal(item.blockSet.blocks.length, 2);
    assert.deepEqual(item.blockSet.blocks.map(block => [block.dx, block.dy, block.dz]), [[0, 0, 0], [6, 2, 3]]);
    assert.equal(item.entityList.length, 2);
    assert.deepEqual(item.entityList[0].itemPosition, [3, 1, 0]);
    assert.ok(new THREE.Quaternion().fromArray(item.entityList[1].itemRotation).angleTo(rotation) < 1e-7);
    assert.equal(item.entityList[0].childEntities.length, 1);
    assert.equal(item.entityList[0].scripts[0].code, 'export function update(): void {}');
    assert.deepEqual(item.entityList[0].constraints[0].anchorA, [3.5, 1.5, 0.5]);
    assert.deepEqual(first.serializeSubtree(), before);
    assert.equal(f.terrain.size, 3);
    assert.equal(f.manager.contraptions.length, 4);
    assert.equal(f.controller.activeTool, SpecialTool.HAMMER);
    const portable = decodeInventoryResource(f.controller.encodeInventoryItem('item', item)).portable;
    assert.deepEqual(portable.entityList[0].root.localPosition, [3, 1, 0]);
    assert.ok(getInventoryPreviewBlocks(item).some(block => block.center.distanceTo(new THREE.Vector3(3.5, 1.5, 0.5)) < 1e-9));
  } finally { f.dispose(); }
});

test('an empty terrain region can copy entities, while T remains geometry-only', () => {
  const f = fixture();
  try {
    f.select({ x: 10, y: 20, z: 30 }, { x: 12, y: 22, z: 32 });
    f.entity([11, 21, 31]);
    f.controller.copySelectionAsBlockSet();
    assert.equal(f.controller.inventories.item.items.filter(Boolean).length, 0);
    const item = f.controller.copySelectionSmart();
    assert.ok(item, f.toasts.join('\n'));
    assert.equal(item.blockSet, undefined);
    assert.deepEqual(item.entityList[0].itemPosition, [1, 1, 1]);
  } finally { f.dispose(); }
});

test('copied terrain and entity world anchors follow the same rotated placement frame', () => {
  const f = fixture();
  try {
    f.select({ x: 10, y: 20, z: 30 }, { x: 14, y: 22, z: 32 });
    f.terrain.set(f.key(10, 20, 30), 0xff0000);
    const source = f.entity([13, 21, 31]);
    source.constraintDefinitions.set('world_joint', {
      id: 'world_joint', type: 'point', bodyA: null, bodyB: 'root', anchorA: [13.5, 21.5, 31.5],
    });
    assert.ok(f.controller.copySelectionSmart(), f.toasts.join('\n'));
    const origin = new THREE.Vector3(100, 50, 100);
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    f.controller.getInventoryPlacementPose = () => ({ position: origin.clone(), quaternion: rotation.clone() });
    const cells: any[] = [];
    f.controller.performBasicAction = action => {
      if (action.action === 'place-standard') cells.push(action.cell);
      return { placed: 1 };
    };
    assert.equal(f.controller.pasteInventorySlot(), true);
    assert.deepEqual(cells, [{ x: 100, y: 50, z: 99 }]);
    assert.equal(f.manager.contraptions.length, 2);
    const copied = f.manager.contraptions[1];
    const expected = new THREE.Vector3(3, 1, 1).applyQuaternion(rotation).add(origin);
    assert.ok(copied.originWorldPos.distanceTo(expected) < 1e-9);
    const anchor = new THREE.Vector3(3.5, 1.5, 1.5).applyQuaternion(rotation).add(origin);
    assert.ok(new THREE.Vector3().fromArray(copied.constraintDefinitions.get('world_joint').anchorA).distanceTo(anchor) < 1e-9);
    assert.notEqual(copied.publicId, source.publicId);
  } finally { f.dispose(); }
});

test('cyan micro box remains visible across empty and sparsely occupied regions', () => {
  const renderer: any = Object.create(SceneRenderer.prototype);
  renderer.selectionGroup = new THREE.Group();
  renderer.selectionCellsGroup = new THREE.Group();
  renderer.selectionMicroCellsGroup = new THREE.Group();
  renderer.selectionFill = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  renderer.selectionWireframe = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry()), new THREE.LineBasicMaterial());
  const bounds = { minX: 80, minY: 160, minZ: 240, maxX: 87, maxY: 167, maxZ: 247 };
  for (const orange of [[], [{ x: 80, y: 160, z: 240 }]]) {
    renderer.updateSelectionHologram(bounds, null, orange);
    assert.equal(renderer.selectionGroup.visible, true);
    assert.deepEqual(renderer.selectionGroup.scale.toArray(), [1, 1, 1]);
    assert.deepEqual(renderer.selectionGroup.position.toArray(), [10.5, 20.5, 30.5]);
  }
  renderer.updateSelectionHologram(null, null, []);
  assert.equal(renderer.selectionGroup.visible, false);
  renderer.selectionFill.geometry.dispose();
  renderer.selectionWireframe.geometry.dispose();
  renderer.selectionFill.material.dispose();
  renderer.selectionWireframe.material.dispose();
});

test('micro Copy uses the cyan micro bounds and preserves static/entity offsets and materials', () => {
  const f = fixture();
  try {
    f.micros.set('80,160,240', { color: 0xff0000, materialId: 1 });
    f.select({ x: 10, y: 20, z: 30 }, { x: 10.875, y: 20.875, z: 30.875 }, true);
    f.entity([10.25, 20.5, 30.25], { size: MICRO_SIZE });
    f.entity([10.9375, 20.5, 30.25], { size: MICRO_SIZE });
    assert.ok(f.controller.copySelectionSmart(), f.toasts.join('\n'));
    while (f.controller.bulkEditJob) f.controller.processBulkEditFrame(128, Infinity);
    const item = f.controller.inventories.item.items[0];
    assert.ok(item, f.toasts.join('\n'));
    assert.equal(item.blockSet.blocks[0].size, MICRO_SIZE);
    assert.equal(item.blockSet.blocks[0].materialId, 1);
    assert.equal(item.entityList.length, 1);
    assert.deepEqual(item.entityList[0].itemPosition, [0.25, 0.5, 0.25]);
  } finally { f.dispose(); }
});

test('large world Copy retains its region and snapshots entities through bounded scan frames', () => {
  const f = fixture();
  try {
    f.select({ x: 10, y: 20, z: 30 }, { x: 16, y: 26, z: 36 });
    f.terrain.set(f.key(10, 20, 30), 0xff0000);
    const source = f.entity([13, 21, 31]);
    assert.equal(f.controller.copySelectionSmart(), true);
    assert.equal(f.manager.selectionBoxConfirmed, true);
    f.controller.processBulkEditFrame(16, Infinity);
    assert.ok(f.controller.bulkEditJob);
    source.position.x += 1;
    source.updateTransform();
    while (f.controller.bulkEditJob) f.controller.processBulkEditFrame(16, Infinity);
    const item = f.controller.inventories.item.items[0];
    assert.ok(item, f.toasts.join('\n'));
    assert.deepEqual(item.entityList[0].itemPosition, [3, 1, 1]);
    assert.equal(item.blockSet.blocks[0].dx, 0);
    assert.equal(f.manager.selectionBoxConfirmed, false);
  } finally { f.dispose(); }
});

test('world Copy unwraps enclosed entities and their world anchors across the torus seam', () => {
  const f = fixture();
  try {
    f.select({ x: TORUS_SIZE_X - 2, y: 20, z: 30 }, { x: 2, y: 22, z: 32 });
    const source = f.entity([0, 21, 31]);
    source.constraintDefinitions.set('world_joint', {
      id: 'world_joint', type: 'point', bodyA: null, bodyB: 'root', anchorA: [0.5, 21.5, 31.5],
    });
    const item = f.controller.copySelectionSmart();
    assert.ok(item, f.toasts.join('\n'));
    assert.deepEqual(item.entityList[0].itemPosition, [2, 1, 1]);
    assert.deepEqual(item.entityList[0].constraints[0].anchorA, [2.5, 1.5, 1.5]);
  } finally { f.dispose(); }
});

test('world Copy preserves an arbitrary Entity position through export, preview and placement', () => {
  const f = fixture();
  try {
    f.select({ x: 10, y: 20, z: 30 }, { x: 14, y: 24, z: 34 });
    f.terrain.set(f.key(10, 20, 30), 0xff0000);
    const source = f.entity([11.1, 21.03, 31.02], { child: true });
    const worldAnchor = new THREE.Vector3(11.6, 21.53, 31.52);
    source.constraintDefinitions.set('world_joint', {
      id: 'world_joint', type: 'point', bodyA: null, bodyB: 'root', anchorA: worldAnchor.toArray(),
    });
    const before = source.serializeSubtree();
    const selectionOrigin = new THREE.Vector3(10, 20, 30);
    const relativePosition = new THREE.Vector3().fromArray(before.sourcePosition).sub(selectionOrigin);
    const item = f.controller.copySelectionSmart();
    assert.ok(item, f.toasts.join('\n'));
    assert.deepEqual(item.entityList[0].itemPosition, relativePosition.toArray());
    assert.deepEqual(source.serializeSubtree(), before);
    const encoded = f.controller.encodeInventoryItem('item', item);
    assert.deepEqual(decodeInventoryResource(encoded).portable.entityList[0].root.localPosition, relativePosition.toArray());
    assert.equal(f.controller.parseInventoryImport(encoded, 'item').ok, true);
    const preview = getInventoryPreviewBlocks(item).find(block => block.color === 0x12ab34);
    assert.ok(preview.center.distanceTo(relativePosition.clone().addScalar(0.5)) < 1e-9);

    const origin = new THREE.Vector3(100, 50, 100);
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    f.controller.getInventoryPlacementPose = () => ({ position: origin.clone(), quaternion: rotation.clone() });
    f.controller.performBasicAction = () => ({ placed: 1 });
    assert.equal(f.controller.pasteInventorySlot(), true);
    const copied = f.manager.contraptions[1];
    assert.ok(copied.originWorldPos.distanceTo(relativePosition.applyQuaternion(rotation).add(origin)) < 1e-9);
    const expectedAnchor = worldAnchor.sub(selectionOrigin).applyQuaternion(rotation).add(origin);
    assert.ok(new THREE.Vector3().fromArray(copied.constraintDefinitions.get('world_joint').anchorA).distanceTo(expectedAnchor) < 1e-9);
    assert.notEqual(copied.publicId, source.publicId);
  } finally { f.dispose(); }
});

test('full Item copies leave sources, selection and backpack contents intact', () => {
  const f = fixture();
  try {
    f.select({ x: 10, y: 20, z: 30 }, { x: 12, y: 22, z: 32 });
    const source = f.entity([11.1, 21, 31]);
    const before = source.serializeSubtree();
    f.controller.inventories.item.items.fill({ kind: 'item', name: 'Existing' });
    assert.equal(f.controller.copySelectionSmart(), null);
    assert.match(f.toasts.at(-1), /inventory is full/);
    assert.equal(f.manager.selectionBoxConfirmed, true);
    assert.equal(f.controller.activeTool, SpecialTool.SELECTOR);
    assert.ok(f.controller.inventories.item.items.every(item => item.name === 'Existing'));
    assert.deepEqual(source.serializeSubtree(), before);
  } finally { f.dispose(); }
});
