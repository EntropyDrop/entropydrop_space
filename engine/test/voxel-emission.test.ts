import { requireValue } from './fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { NodeFrame, type Renderer } from 'three/webgpu';
import { Chunk } from '../src/voxel/Chunk.ts';
import { LowPolyMesher } from '../src/mesher/LowPolyMesher.ts';
import { MicroVoxelLayer } from '../src/voxel/MicroVoxelLayer.ts';
import { Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { createVoxelMesh } from '../src/contraption/EntityVoxelMeshes.ts';
import { createDecorationGroup, editDecorationGroup, DecorationBatchMesh } from '../src/contraption/DecorationMeshes.ts';
import { setTerrainKernelMode } from '../src/wasm/TerrainKernels.ts';
import { createVoxelEmissiveMaterial, voxelEmissionMask } from '../src/render/VoxelEmission.ts';
import {
  VoxelMaterialIds,
  isEmissiveVoxelMaterial,
  isTranslucentVoxelMaterial,
  voxelMaterialEmission,
  voxelMaterialEmissionStrength,
  emissiveVoxelMaterialId,
  migrateLegacyVoxelMaterialId,
  voxelMaterialRenderBucket,
  voxelMaterialAlphaByte,
  parseVoxelMaterialId,
} from '../src/voxel/VoxelMaterials.ts';
import {
  encodeInventoryResource,
  decodeInventoryResource,
  migrateLegacyPortableMaterialIds,
} from '../src/storage/InventoryProtobuf.ts';

function tint(mesh: THREE.Mesh, materialId: number) {
  const group = mesh.geometry.groups.find(group => group.materialIndex === materialId)!;
  assert.ok(group);
  const vertex = mesh.geometry.index?.getX(group.start) ?? group.start;
  const colors = mesh.geometry.getAttribute('color');
  return [colors.getX(vertex), colors.getY(vertex), colors.getZ(vertex)].map(v => Math.round(v * 255));
}

for (const mode of ['js', 'wasm'] as const) {
  test(`${mode} standard and micro rebuilds retain emissive tints down to the darkest color byte`, () => {
    const previous = setTerrainKernelMode(mode);
    try {
      const mesher = new LowPolyMesher();
      const chunk = new Chunk(0, 0, null);
      const micros = new MicroVoxelLayer();
      for (const color of [0xff0000, 0x00ff00, 0x0000ff, 0x010203, 0x000001, 0x888888, 0]) {
        const expected = [color >> 16, color >> 8 & 255, color & 255];
        chunk.setLocalBlock(2, 5, 2, 1, color, 1);
        micros.set(2, 5, 2, color, null, 1);
        // Repeated neighboring edits remesh already placed emissive voxels.
        for (const block of [1, 0, 1]) {
          chunk.setLocalBlock(3, 5, 2, block, 0x888888, 0);
          if (block) micros.set(3, 5, 2, 0x888888);
          else micros.delete(3, 5, 2);
          const mesh = mesher.buildChunkMesh(chunk).children[0] as THREE.Mesh;
          micros.updateMesh();
          assert.deepEqual(tint(mesh, 1), expected);
          assert.deepEqual(tint(micros.mesh!, 1), expected);
          assert.equal(chunk.getLocalMaterial(2, 5, 2), 1);
          assert.equal(micros.getMaterial(2, 5, 2), 1);
          if (block) {
            const lit = new THREE.Color(0x888888);
            assert.deepEqual(tint(mesh, 0), [lit.r, lit.g, lit.b].map(v => Math.round(v * 255)));
          }
          mesh.geometry.dispose();
        }
      }
    } finally { setTerrainKernelMode(previous); }
  });
}

test('entity and terrain meshes feed the same emissive tint and shader', () => {
  const entity = new Contraption(1000, [{ localX: 0, localY: 0, localZ: 0,
    block: 1, color: 0x010203, materialId: 1, size: 1, entityId: 'root' }],
  new THREE.Vector3(), new THREE.Scene());
  try {
    const mesh = [...requireValue(requireValue(entity.getEntityNode('root')).voxelChunks).values()][0] as THREE.Mesh;
    const chunk = new Chunk(0, 0, null);
    chunk.setLocalBlock(2, 5, 2, 1, 0x010203, 1);
    const terrain = new LowPolyMesher().buildChunkMesh(chunk).children[0] as THREE.Mesh;
    assert.deepEqual(tint(mesh, 1), tint(terrain, 1));
    const entityMaterial = (mesh.material as THREE.Material[])[1];
    const terrainMaterial = (terrain.material as THREE.Material[])[1];
    for (const material of [entityMaterial, terrainMaterial] as any[]) {
      assert.equal(material.type, "MeshBasicNodeMaterial");
      assert.ok(material.colorNode?.isNode);
      assert.ok(material.outputNode?.isNode);
    }
    terrain.geometry.dispose();
  } finally { entity.dispose(); }
});

test('emission uses scene tone mapping and only marks opted-in HDR buffers', () => {
  const material = createVoxelEmissiveMaterial();
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  let renderTarget: THREE.WebGLRenderTarget | null = null;
  const frame = new NodeFrame();
  frame.renderer = { getRenderTarget: () => renderTarget } as Renderer;
  try {
    const draw = () => {
      frame.renderId++;
      frame.updateNode(voxelEmissionMask);
      return voxelEmissionMask.value;
    };
    assert.equal(material.toneMapped, true);
    assert.equal(material.fog, false);
    assert.ok(material.colorNode?.isNode);
    assert.ok(material.outputNode?.isNode);
    assert.equal(draw(), 0, 'direct rendering remains opaque');
    renderTarget = target;
    assert.equal(draw(), 0, 'ordinary preview targets remain opaque');
    target.texture.userData.voxelEmissionMask = true;
    assert.equal(draw(), 1, 'HDR scene stores emission coverage separately from radiance');
    renderTarget = null;
    assert.equal(draw(), 0, 'switching targets clears the emission marker on shared materials');
  } finally { material.dispose(); target.dispose(); }
});

const emissiveIds = Array.from({ length: 100 }, (_, i) => i + 102);

test('100 distinct emissive material IDs encode 1–100% glow while keeping ID 1 as reserved 50%', () => {
  assert.equal(VoxelMaterialIds.LEGACY_EMISSIVE, 1);
  assert.equal(VoxelMaterialIds.EMISSIVE_MIN, 102);
  assert.equal(VoxelMaterialIds.EMISSIVE_MAX, 201);
  assert.equal(VoxelMaterialIds.EMISSIVE, 151);

  assert.equal(isEmissiveVoxelMaterial(0), false);
  assert.equal(isEmissiveVoxelMaterial(1), true);
  assert.equal(isTranslucentVoxelMaterial(1), false);
  assert.equal(voxelMaterialEmission(1), 50);
  assert.equal(voxelMaterialEmissionStrength(1), 1);
  assert.equal(voxelMaterialRenderBucket(1), 1);
  assert.equal(voxelMaterialAlphaByte(1), 50);
  assert.equal(migrateLegacyVoxelMaterialId(1), 151);
  assert.equal(emissiveVoxelMaterialId(0), 0);

  for (const id of emissiveIds) {
    const level = id - 101;
    assert.equal(parseVoxelMaterialId(id), id);
    assert.equal(isEmissiveVoxelMaterial(id), true);
    assert.equal(isTranslucentVoxelMaterial(id), false);
    assert.equal(voxelMaterialEmission(id), level);
    assert.equal(voxelMaterialEmissionStrength(id), level / 50);
    assert.equal(emissiveVoxelMaterialId(level), id);
    assert.equal(migrateLegacyVoxelMaterialId(id), id);
    assert.equal(voxelMaterialRenderBucket(id), 1);
    assert.equal(voxelMaterialAlphaByte(id), level);
  }
  assert.equal(new Set(emissiveIds.map(voxelMaterialEmissionStrength)).size, 100);
  for (const id of [-1, 202, 2.5, NaN, Infinity]) assert.throws(() => parseVoxelMaterialId(id), /materialId/);
});

test('all 100 glow levels survive JS/WASM standard and micro meshing including IDs >= 128', () => {
  const previous = setTerrainKernelMode('js');
  const chunk = new Chunk(0, 0, null), mesher = new LowPolyMesher();
  for (const [i, id] of emissiveIds.entries()) chunk.setLocalBlock(i % 10, 5, Math.floor(i / 10), 1, 0xffaa33, id);
  const buildMicro = () => {
    const micro = new MicroVoxelLayer();
    // Spread across multiple edit partitions inside one chunk render batch.
    for (const [i, id] of emissiveIds.entries()) micro.set(i % 10 * 2, 5, Math.floor(i / 10) * 2, 0xffaa33, null, id);
    micro.updateMesh();
    assert.ok(micro.meshChunks.size > 1);
    assert.equal(micro.renderMeshes.size, 1);
    const geometry = [...micro.renderMeshes.values()][0].geometry;
    assert.deepEqual(geometry.groups.map(g => g.materialIndex), [1]);
    return { colors: geometry.attributes.color.array, indices: geometry.index!.array };
  };
  const checkGlowAlpha = (colors: ArrayLike<number>) => {
    const levels = new Set<number>();
    for (let i = 3; i < colors.length; i += 4) levels.add(colors[i]);
    assert.deepEqual([...levels].sort((a, b) => a - b), Array.from({ length: 100 }, (_, i) => i + 1));
  };
  try {
    const expected = mesher.buildChunkMeshData(chunk), expectedMicro = buildMicro();
    assert.equal(expected.materialIndexCounts[0], 0);
    assert.equal(expected.materialIndexCounts[2], 0);
    assert.ok(expected.colors);
    checkGlowAlpha(expected.colors);
    checkGlowAlpha(expectedMicro.colors);
    setTerrainKernelMode('wasm');
    assert.deepEqual(mesher.buildChunkMeshData(chunk), expected);
    assert.deepEqual(buildMicro(), expectedMicro);
  } finally { setTerrainKernelMode(previous); }
});

for (const mode of ['js', 'wasm'] as const) {
  test(`${mode}: glow voxels cull opaque neighbors and stay visible behind glass`, () => {
    const previous = setTerrainKernelMode(mode);
    try {
      const chunk = new Chunk(0, 0, null), micro = new MicroVoxelLayer(), mesher = new LowPolyMesher();
      // Adjacent solid (0) + glow (151) + glass (61): solid/glow cull shared face, glass does not cull glow.
      for (const [x, material] of [[2, 0], [3, 151], [4, 61]]) {
        chunk.setLocalBlock(x, 5, 2, 1, 0x88aabb, material);
        micro.set(x, 5, 2, 0x88aabb, null, material);
      }
      const data = mesher.buildChunkMeshData(chunk);
      assert.deepEqual(data.materialIndexCounts, [30, 30, 30]);
      micro.updateMesh();
      const groups = micro.mesh!.geometry.groups;
      assert.equal(groups.find(g => g.materialIndex === 0)?.count, 30);
      assert.equal(groups.find(g => g.materialIndex === 1)?.count, 30);
      assert.equal(groups.find(g => g.materialIndex === 2)?.count, 30);
    } finally { setTerrainKernelMode(previous); }
  });
}

test('entity voxels and decorations retain all 100 glow levels in a single emissive draw', () => {
  const blocks = emissiveIds.map((materialId, i) => ({
    localX: i * 2, localY: 0, localZ: 0, block: 1, color: 0xffaa33, materialId,
  }));
  const mesh = createVoxelMesh(blocks, new THREE.Vector3(), new THREE.Group())!;
  assert.deepEqual(mesh.geometry.groups.map(g => g.materialIndex), [1]);
  const color = mesh.geometry.attributes.color;
  assert.equal(color.itemSize, 4);
  for (const [i, id] of emissiveIds.entries()) {
    assert.ok(Math.abs(color.getW(i * 36) * 255 / 50 - voxelMaterialEmissionStrength(id)) < 1e-6);
  }

  const values = emissiveIds.map((materialId, i) => ({
    id: `glow_${i}`, color: 0xffaa33, materialId, position: [i, 0, 0] as [number, number, number],
  }));
  const group = createDecorationGroup(values, new THREE.Vector3());
  const batch = group.children.find(c => c instanceof DecorationBatchMesh) as DecorationBatchMesh;
  assert.equal(group.children.filter(c => c instanceof DecorationBatchMesh).length, 1);
  assert.equal(batch.instanceCount, 100);
  for (const [i, id] of emissiveIds.entries()) {
    assert.ok(Math.abs(batch.tintAttribute.getW(i) - voxelMaterialEmissionStrength(id)) < 1e-6);
  }
  const material = batch.material, matrices = batch.instanceMatrix.array.slice();
  editDecorationGroup(group, values[0].id, { ...values[0], materialId: 201 }, new THREE.Vector3());
  assert.equal(group.children.find(c => c instanceof DecorationBatchMesh), batch);
  assert.equal(batch.material, material);
  assert.deepEqual(batch.instanceMatrix.array, matrices);
  assert.ok(Math.abs(batch.tintAttribute.getW(0) - 2) < 1e-6);

  const single = createDecorationGroup([values[0]], new THREE.Vector3());
  const singleMesh = single.children[0] as THREE.Mesh;
  assert.equal(singleMesh.geometry.attributes.color.itemSize, 4);
  assert.ok(Math.abs(singleMesh.geometry.attributes.color.getW(0) - 1 / 255) < 1e-6);
  editDecorationGroup(single, values[0].id, { ...values[0], materialId: 201 }, new THREE.Vector3());
  assert.equal(single.children[0], singleMesh);
  assert.ok(Math.abs(singleMesh.geometry.attributes.color.getW(0) - 100 / 255) < 1e-6);
});

test('inventory round-trip preserves reserved ID 1 and all 100 glow IDs, and migration helper upgrades ID 1 to 151', () => {
  const allIds = [1, ...emissiveIds];
  const blockSet = {
    type: 'space-blockset',
    version: 8,
    name: 'Glow',
    blocks: allIds.flatMap((materialId, i) => [
      { dx: i * 2, dy: 0, dz: 0, color: 0xffcc44, materialId },
      { dx: i * 2 + 1, dy: 0, dz: 0, mx: 0, my: 0, mz: 0, color: 0xffcc44, materialId },
    ]),
    decorations: [{ dx: 0, dy: 0, dz: 0, color: 0xff0000, materialId: 1 }],
  };
  const restored = decodeInventoryResource(encodeInventoryResource('blockset', blockSet)).portable as any;
  assert.deepEqual(restored.blocks.map((b: any) => b.materialId), allIds.flatMap(id => [id, id]));
  assert.equal(restored.decorations[0].materialId, 1);

  const migrated = migrateLegacyPortableMaterialIds(restored);
  assert.equal(migrated.changed, true);
  assert.equal((migrated.resource as any).blocks[0].materialId, 151);
  assert.equal((migrated.resource as any).blocks[1].materialId, 151);
  assert.equal((migrated.resource as any).blocks[2].materialId, 102);
  assert.equal((migrated.resource as any).decorations[0].materialId, 151);
  assert.equal(migrateLegacyPortableMaterialIds(migrated.resource).changed, false);

  const colorset = {
    type: 'space-colorset',
    version: 8,
    name: 'Legacy Glow Palette',
    entries: Array.from({ length: 9 }, (_, i) => ({
      stops: [{ color: '#ffaa00', position: 0 }],
      materialId: i === 0 ? 1 : i === 1 ? 61 : i === 2 ? 201 : 0,
    })),
  };
  const migratedPalette = migrateLegacyPortableMaterialIds(colorset);
  assert.equal(migratedPalette.changed, true);
  assert.deepEqual((migratedPalette.resource as any).entries.slice(0, 4).map((e: any) => e.materialId), [151, 61, 201, 0]);
});

test('ContraptionManager migrates legacy emissive ID 1 to 151 when loading entities from browser storage', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  const scene = new THREE.Scene();
  const world = {
    activeChunkKeys: new Set(['0,0']),
    worldToChunkCoords: (x: number, z: number) => ({ cx: Math.floor(x / 16), cz: Math.floor(z / 16) }),
  } as any;
  const first = new ContraptionManager(scene, world, null, null, storage as any);
  first.setWorldIdentity({ id: 'legacy-emissive-world', slug: 'legacy', name: 'Legacy' });
  const entity = new Contraption(1, [
    { localX: 0, localY: 0, localZ: 0, block: 1, color: 0xffaa00, materialId: 1 },
    { localX: 1, localY: 0, localZ: 0, block: 1, color: 0x00ffaa, materialId: 180 },
  ], new THREE.Vector3(2, 4, 2), scene);
  entity.setComponentDecorations(entity.rootComponentId, [{ id: 'lamp', color: 0xffffff, materialId: 1 }]);
  first.registerContraption(entity);
  first.saveEntitiesToStorage(storage as any);
  entity.dispose();

  const second = new ContraptionManager(new THREE.Scene(), world, null, null, storage as any);
  second.setWorldIdentity({ id: 'legacy-emissive-world', slug: 'legacy', name: 'Legacy' });
  assert.equal(second.loadEntitiesFromStorage(storage as any), 1);
  const restored = second.contraptions[0];
  assert.deepEqual(restored.blocks.map(b => b.materialId), [151, 180]);
  assert.equal(restored.getComponentDecorations(restored.rootComponentId)[0].materialId, 151);

  const persistedRaw = [...store.values()][0];
  const persisted = JSON.parse(persistedRaw);
  assert.deepEqual(persisted.entities[0].slot.blocks.map((b: any) => b.materialId), [151, 180]);
  assert.equal(persisted.entities[0].slot.decorations[0].materialId, 151);
  restored.dispose();
});
