import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { PlayerController, SpecialTool, MAX_MICRO_SELECTION_CELLS } from '../src/engine/controls/PlayerController.ts';
import { ChunkedVoxelIndex } from '@entropydrop/space-engine/physics/EntityVoxelIndex.ts';
import { bendPoint, getWorldShapeMode, setWorldShapeMode } from '@entropydrop/space-engine/torus/TorusWorld.ts';

const standard = (x: number, y = 0, z = 0) => ({
  localX: x, localY: y, localZ: z, size: 1,
  color: 0x123456, block: BlockTypes.COLOR_BLOCK, entityId: 'root', part: 'body'
});

function setup(blocks: any[]) {
  const scene = new THREE.Scene();
  const entity = new Contraption(1, blocks, new THREE.Vector3(), scene, { rootComponentId: 'root' });
  entity.stopAllNodeScripts();
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.registerContraption(entity);
  // Real edits follow a raycast/physics query, so exercise already-built indexes.
  (entity as any).queryIndexedVoxels(false, () => true);
  (entity as any).queryIndexedVoxels(true, () => true);
  const controller: any = Object.create(PlayerController.prototype);
  Object.assign(controller, {
    _activeTool: SpecialTool.SELECTOR, selectorMicroMode: true,
    contraptions: manager, world: {},
    ui: { showToast() {}, notifyContraptionStructureChanged() {}, notifyContraptionRemoved() {} },
    sound: { playBlockBreak() {} }
  });
  manager.selectionHost = controller;
  return { entity, controller, manager };
}

function select(controller: any, entity: any, contains: (x: number, y: number, z: number) => boolean, bounds: any) {
  const blocks = controller.buildEntityMicroSelection(entity, 'root', contains, bounds);
  controller.selectedBlockSelection = { contraption: entity, nodeId: 'root', blocks, micro: true, virtualMicro: true };
  return blocks;
}

test('a small micro selection visits only its overlap in a 4096-block entity', () => {
  const blocks = Array.from({ length: 4096 }, (_, i) => standard(i % 16, Math.floor(i / 16) % 16, Math.floor(i / 256)));
  const controller: any = Object.create(PlayerController.prototype);
  let visits = 0;
  const selected = controller.buildEntityMicroSelection({ blocks, rootComponentId: 'root' }, 'root', () => {
    visits++;
    return true;
  }, { minX: 60, maxX: 61, minY: 60, maxY: 61, minZ: 60, maxZ: 61 });
  assert.equal(selected.length, 8);
  assert.equal(visits, 8, 'unrelated blocks must never enumerate their 512 micro cells');
  assert.equal(blocks.length, 4096, 'selection stays read-only');
});

test('large entity micro delete publishes survivors once and preserves distant meshes and chunk materials', () => {
  const blocks = Array.from({ length: 4096 }, (_, i) => standard(i % 16, Math.floor(i / 16) % 16, Math.floor(i / 256)));
  const { entity, controller } = setup(blocks);
  const node: any = entity.entityNodes.get('root');
  const distant = node.voxelChunks.get('1,1,1');
  const touched = node.voxelChunks.get('0,0,0');
  const material = touched.material;
  let spatialRebuilds = 0;
  for (const cache of [(entity as any).pickingVoxelIndexes, (entity as any).collisionVoxelIndexes]) {
    const chunk = cache.indexes.get('root').chunks.get('0,0,0');
    let subIndex = chunk.subIndex;
    Object.defineProperty(chunk, 'subIndex', {
      get: () => subIndex,
      set: value => { spatialRebuilds++; subIndex = value; }
    });
  }
  const bounds = { minX: 0, maxX: 16, minY: 0, maxY: 7, minZ: 0, maxZ: 7 };
  const selected = select(controller, entity, () => true, bounds);
  assert.equal(selected.length, 2 * 512 + 64);
  const snapshots: number[] = [];
  const rebuild = entity.rebuildAfterBlockChange.bind(entity);
  entity.rebuildAfterBlockChange = (...args: any[]) => {
    snapshots.push(entity.blocks.length);
    return rebuild(...args);
  };
  controller.deleteSelectionBlocks();
  assert.deepEqual(snapshots, [4096 - 3 + 448], 'no subdivision-only state may reach a rebuild');
  assert.equal(entity.blocks.filter(b => (b.size || 1) < 1).length, 448);
  assert.ok(entity.blocks.filter(b => (b.size || 1) < 1).every(b => b.localX > 2 && b.part === 'body'));
  assert.equal(node.voxelChunks.get('1,1,1'), distant);
  assert.equal(node.voxelChunks.get('0,0,0'), touched);
  assert.equal(touched.material, material);
  assert.equal(spatialRebuilds, 2, 'one tree rebuild each for picking and collision, not one per micro cell');
  assert.deepEqual(new Set((entity as any).queryIndexedVoxels(false, () => true)), new Set(entity.blocks));
  assert.equal((entity as any).queryIndexedVoxels(true, () => true).length, entity.blocks.length);
  assert.equal(controller.selectedBlockSelection, null);
});

for (const survivors of [1, 2]) {
  test(`an atomic carve leaving ${survivors} cells updates collision, picking and mesh indexes`, () => {
    const { entity, controller } = setup([standard(-1)]);
    const source = entity.blocks[0];
    select(controller, entity, (x, y, z) => !((x === -1) && y === 7 && z >= 8 - survivors),
      { minX: -8, maxX: -1, minY: 0, maxY: 7, minZ: 0, maxZ: 7 });
    controller.deleteSelectionBlocks();
    const node: any = entity.entityNodes.get('root');
    assert.equal(entity.blocks.length, survivors);
    assert.equal(entity.lastBlocksSet.has(source), false);
    assert.equal(node.blocks.has(source), false);
    assert.equal(node.meshCellMap.has('-8,0,0,8'), false);
    assert.equal(entity.collisionCellMap.size, survivors);
    assert.equal(entity.voxelVolume, survivors / 512);
    assert.deepEqual(new Set((entity as any).queryIndexedVoxels(false, () => true)), new Set(entity.blocks));
    assert.equal((entity as any).queryIndexedVoxels(true, () => true).length, survivors);
    for (const block of entity.blocks) {
      const key = `${Math.round(block.localX * 8)},${Math.round(block.localY * 8)},${Math.round(block.localZ * 8)},1`;
      assert.equal(node.meshCellMap.get(key), block);
      assert.ok(entity.lastBlocksSet.has(block));
      assert.ok(node.blocks.has(block));
    }
  });
}

function interfaceArea(entity: any, x: number, normalX: number) {
  let area = 0;
  const node = entity.entityNodes.get('root');
  for (const mesh of node.voxelChunks.values()) {
    const { position, normal } = mesh.geometry.attributes;
    for (let i = 0; i < position.count; i += 3) {
      if (normal.getX(i) !== normalX) continue;
      const vertices = [0, 1, 2].map(offset => new THREE.Vector3().fromBufferAttribute(position, i + offset).add(node.pivotLocal));
      if (!vertices.every(v => Math.abs(v.x - x) < 1e-6)) continue;
      area += new THREE.Triangle(...vertices).getArea();
    }
  }
  return area;
}

test('standard/micro shared faces are culled across negative chunk boundaries and expose only a deleted cell', () => {
  const micros = Array.from({ length: 64 }, (_, i) => ({ ...standard(0, Math.floor(i / 8) / 8, (i % 8) / 8), size: 0.125 }));
  const { entity, controller } = setup([standard(-1), ...micros]);
  assert.equal(interfaceArea(entity, 0, 1), 0, 'standard face is fully covered');
  assert.equal(interfaceArea(entity, 0, -1), 0, 'micro faces are covered by the standard neighbor');
  select(controller, entity, () => true, { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 });
  controller.deleteSelectionBlocks();
  assert.equal(interfaceArea(entity, 0, 1), 1 / 64, 'only the newly exposed standard patch is rendered');
  assert.equal(interfaceArea(entity, 0, -1), 0, 'remaining shared faces stay hidden');
});

test('an oversized micro box never falls back to deleting whole standard blocks', () => {
  const { entity, controller, manager } = setup(Array.from({ length: 34 }, (_, i) => standard(i)));
  const pivot = entity.entityNodes.get('root').pivotLocal;
  controller.resolveBlockRangeSelection({
    contraption: entity, nodeId: 'root',
    pointA: new THREE.Vector3(0.01, 0.01, 0.01).sub(pivot),
    pointB: new THREE.Vector3(33.99, 0.99, 0.99).sub(pivot)
  });
  assert.ok(34 * 512 > MAX_MICRO_SELECTION_CELLS);
  assert.equal(controller.selectedBlockSelection, null);
  assert.equal(manager.entitySelection, null);
  controller.deleteSelectionBlocks();
  assert.equal(entity.blocks.length, 34);
  assert.ok(entity.blocks.every(b => b.size === 1));
});

test('batched spatial edits keep queries and bounds correct when a chunk is emptied and recreated', () => {
  const index = new ChunkedVoxelIndex();
  const original = {};
  const survivor = {};
  const distant = {};
  index.add(original, -8, 0, 0, 1);
  index.add(distant, 24, 0, 0, 1);
  index.batchUpdate(() => {
    index.remove(original);
    index.batchUpdate(() => index.add(survivor, -7, 0, 0, 0.125));
    index.remove(distant);
  });
  assert.deepEqual(index.bounds, { minX: -7, minY: 0, minZ: 0, maxX: -6.875, maxY: 0.125, maxZ: 0.125 });
  assert.deepEqual(index.query(index.bounds).map(item => item.entry), [survivor]);
  assert.throws(() => index.batchUpdate(() => {
    index.remove(survivor);
    throw new Error('aborted edit');
  }), /aborted edit/);
  assert.deepEqual(index.queryMatchingBounds(() => true), []);
  assert.equal(index.bounds.minX, Infinity);
});

test('curved-world picking hits the exact rendered micro patch exposed on a standard face', () => {
  const previous = getWorldShapeMode();
  setWorldShapeMode('torus');
  try {
    const micros = Array.from({ length: 64 }, (_, i) => ({ ...standard(0, Math.floor(i / 8) / 8, (i % 8) / 8), size: 0.125 }));
    const { entity } = setup([standard(-1), ...micros.slice(1)]);
    entity.position.set(80, 12, 120);
    entity.updateTransform();
    const node: any = entity.entityNodes.get('root');
    node.group.updateWorldMatrix(true, false);
    const flatCorners = [[0, 0.125, 0.125], [0, 0, 0.125], [0, 0, 0]].map(coords => (
      new THREE.Vector3(...coords).sub(node.pivotLocal).applyMatrix4(node.group.matrixWorld)
    ));
    const bentCorners = flatCorners.map(point => bendPoint(point.x, point.y, point.z));
    const triangle = new THREE.Triangle(...bentCorners);
    const center = triangle.getMidpoint(new THREE.Vector3());
    const normal = triangle.getNormal(new THREE.Vector3());
    const hit = entity.raycastBentCollisionCells(center.clone().addScaledVector(normal, 0.05), normal.clone().negate(), 0.1);
    assert.ok(hit);
    assert.equal(hit.block, entity.blocks.find(b => b.size === 1));
    assert.ok(Math.abs(hit.distance - 0.05) < 1e-7, 'ray and renderer must use identical bent triangles');
    const flatCenter = new THREE.Triangle(...flatCorners).getMidpoint(new THREE.Vector3());
    assert.ok(hit.point.distanceTo(flatCenter) < 1e-7);
  } finally {
    setWorldShapeMode(previous);
  }
});

test('micro cells away from an interface retain the neighboring standard face triangles', () => {
  const { entity } = setup([standard(-1), { ...standard(0.875, 0.5, 0.5), size: 0.125 }]);
  const node: any = entity.entityNodes.get('root');
  assert.equal(node.voxelChunks.get('-1,0,0').geometry.attributes.position.count, 36,
    'an untouched face must not change triangulation when a distant micro cell is added or removed');
});
