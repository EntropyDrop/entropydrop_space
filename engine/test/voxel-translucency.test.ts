import { parseVoxelMaterialId, voxelMaterialTransparency, voxelMaterialOpacity, voxelMaterialRenderBucket } from '../src/voxel/VoxelMaterials.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Chunk } from '../src/voxel/Chunk.ts';
import { LowPolyMesher } from '../src/mesher/LowPolyMesher.ts';
import { MicroVoxelLayer } from '../src/voxel/MicroVoxelLayer.ts';
import { setTerrainKernelMode } from '../src/wasm/TerrainKernels.ts';
import { TerrainHandoff } from '../src/render/TerrainHandoff.ts';
import { createVoxelTranslucentMaterial } from '../src/render/VoxelTranslucency.ts';
import { Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { createDecorationGroup, editDecorationGroup, DecorationBatchMesh } from '../src/contraption/DecorationMeshes.ts';
import { createVoxelMesh } from '../src/contraption/EntityVoxelMeshes.ts';
import { encodeInventoryResource, decodeInventoryResource } from '../src/storage/InventoryProtobuf.ts';

for (const mode of ['js', 'wasm'] as const) {
  test(`${mode}: translucent terrain exposes solid backing and culls adjacent glass interiors`, () => {
    const previous = setTerrainKernelMode(mode);
    try {
      const chunk = new Chunk(0, 0, null), micro = new MicroVoxelLayer(), mesher = new LowPolyMesher();
      for (const [x, material] of [[2, 0], [3, 2], [4, 2]]) {
        chunk.setLocalBlock(x, 5, 2, 1, 0x88aabb, material);
        micro.set(x, 5, 2, 0x88aabb, null, material);
      }
      const data = mesher.buildChunkMeshData(chunk);
      assert.deepEqual(data.materialIndexCounts, [36, 0, 54]);
      micro.updateMesh();
      const groups = micro.mesh!.geometry.groups;
      assert.equal(groups.find(g => g.materialIndex === 0)?.count, 36, 'solid face behind glass survives greedy meshing');
      assert.equal(groups.find(g => g.materialIndex === 2)?.count, 30, 'glass merges coplanar faces');
      for (const m of [micro.mesh!, mesher.createChunkMeshFromData(chunk, data).children[0] as THREE.Mesh]) {
        const mat = (m.material as THREE.Material[])[2];
        assert.equal(mat.transparent, true); assert.equal(mat.opacity, 1); assert.ok((mat as THREE.NodeMaterial).opacityNode);
        assert.equal(mat.depthWrite, false); assert.equal(mat.forceSinglePass, true);
      }
      const neighbor = new Chunk(1, 0, null); neighbor.hasGenerated = true;
      neighbor.setLocalBlock(0, 5, 2, 1, 0x88aabb, 2);
      const edge = new Chunk(0, 0, { worldToChunkCoords: (x: number, z: number) => ({cx:Math.floor(x/16),cz:Math.floor(z/16)}),
        markChunkDirty() {}, getChunk: (cx: number, cz: number) => cx === 1 && cz === 0 ? neighbor : null } as any);
      edge.setLocalBlock(15, 5, 2, 1, 0xffffff, 0);
      assert.equal(mesher.buildChunkMeshData(edge).materialIndexCounts[0], 36, 'halo retains transparent neighbors');
      neighbor.setLocalBlock(0, 5, 2, 1, 0x88aabb, 0);
      assert.equal(mesher.buildChunkMeshData(edge).materialIndexCounts[0], 30);
    } finally { setTerrainKernelMode(previous); }
  });
}

test('WASM and JS produce identical mixed material standard and micro geometry', () => {
  const previous = setTerrainKernelMode('js');
  const chunk = new Chunk(0, 0, null);
  const buildMicro = () => {
    const micro = new MicroVoxelLayer();
    for (let i = 0; i < 120; i++) micro.set(i % 8, Math.floor(i / 8) % 4, Math.floor(i / 32), i * 137, null, i % 3);
    micro.updateMesh();
    return [...micro.meshChunks.values()].map(m => ({groups:m.geometry.groups,
      positions:Array.from(m.geometry.attributes.position.array), indices:Array.from(m.geometry.index!.array),
      colors:Array.from(m.geometry.attributes.color.array)}));
  };
  try {
    for (let i = 0; i < 120; i++) chunk.setLocalBlock(i % 8, Math.floor(i / 8) % 4, Math.floor(i / 32), 1, i * 137, i % 3);
    const mesher = new LowPolyMesher(), expected = mesher.buildChunkMeshData(chunk), micros = buildMicro();
    setTerrainKernelMode('wasm');
    assert.deepEqual(mesher.buildChunkMeshData(chunk), expected);
    assert.deepEqual(buildMicro(), micros);
  } finally { setTerrainKernelMode(previous); }
});

test('AOI handoff switches glass to opaque immediately on exit and reuses variants on reversal', () => {
  const handoff = new TerrainHandoff(); handoff.enabled.value = true;
  const glass = createVoxelTranslucentMaterial(), root = new THREE.Group();
  root.position.set(-16, 0, -16);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), glass); root.add(mesh);
  handoff.setReady(1023, 127, true, false); handoff.hook(root);
  assert.equal(mesh.material, glass);
  handoff.setReady(-1, -1, false, true, 0); handoff.hook(root);
  assert.equal(mesh.material.transparent, false); assert.equal(mesh.material.opacity, 1);
  assert.equal(mesh.material.depthWrite, true);
  assert.equal(mesh.material.opacityNode, null);
  handoff.advance(100); handoff.hook(root);
  const far = mesh.material;
  assert.ok(far.maskNode);
  handoff.setReady(-1, -1, true, true, 100); handoff.hook(root);
  const near = mesh.material;
  assert.equal(near.transparent, true); assert.equal(near.opacity, 1); assert.ok(near.opacityNode);
  handoff.setReady(-1, -1, false, true, 100); handoff.hook(root);
  assert.equal(mesh.material, far);
  handoff.setReady(-1, -1, true, true, 100); handoff.hook(root);
  assert.equal(mesh.material, near);
  handoff.texture.dispose(); glass.dispose();
});

test('entity faces include solid surfaces behind standard and micro glass', () => {
  const parent = new THREE.Group();
  const blocks = [
    {localX:0,localY:0,localZ:0,size:1,color:0xffffff,block:1,materialId:0},
    {localX:1,localY:0,localZ:0,size:1,color:0x88aabb,block:1,materialId:2},
  ];
  const mesh = createVoxelMesh(blocks, new THREE.Vector3(), parent)!;
  assert.deepEqual(mesh.geometry.groups.map(g => [g.materialIndex, g.count]), [[0,36],[2,30]]);
  blocks[1].size = .125;
  const mixed = createVoxelMesh(blocks, new THREE.Vector3(), parent)!;
  assert.equal(mixed.geometry.groups[0].count, 36, 'partial glass does not punch a hole in the backing face');
  const solid = createVoxelMesh([blocks[0]], new THREE.Vector3(), parent)!;
  assert.equal(solid.geometry.attributes.color.itemSize, 3, 'opaque entity chunks retain RGB memory usage');
  assert.equal((solid.material as THREE.Material[]).length, 2, 'ordinary chunks allocate no glass material');
  blocks[0].materialId = 2;
  assert.equal(createVoxelMesh([blocks[0]], new THREE.Vector3(), parent, null, solid), solid);
  assert.equal(solid.geometry.attributes.color.itemSize, 4);
  const glass = (solid.material as THREE.NodeMaterial[])[2];
  assert.equal(glass.transparent, true);
  assert.ok(glass.positionNode, 'painting the first glass voxel hooks torus deformation immediately');
});

test('glass decorations keep batching through edits and cached entity visuals become opaque', () => {
  const values = Array.from({length:32},(_,i)=>({id:`window_${i}`,color:0x88aabb,materialId:2,position:[i,0,0] as [number,number,number]}));
  const group = createDecorationGroup(values, new THREE.Vector3());
  const batches = group.children.filter(c => c.name.startsWith('DecorationBatch:')) as THREE.Mesh[];
  assert.equal(batches.length, 1);
  assert.equal(batches[0].material instanceof THREE.Material, true);
  assert.equal((batches[0].material as THREE.Material).transparent, true);
  editDecorationGroup(group, 'window_0', {...values[0], materialId:0}, new THREE.Vector3());
  editDecorationGroup(group, 'window_0', values[0], new THREE.Vector3());
  assert.equal(group.children.filter(c => c.userData.decorationId).length, 32);
  const scene = new THREE.Scene(), world = {activeChunkKeys:new Set(['0,0']),
    worldToChunkCoords:(x:number,z:number)=>({cx:Math.floor(x/16),cz:Math.floor(z/16)})} as any;
  const manager = new ContraptionManager(scene, world, null, null);
  const entity = new Contraption(1,[{localX:0,localY:0,localZ:0,block:1,materialId:2}],new THREE.Vector3(2,4,2),scene);
  manager.registerContraption(entity);
  const id = entity.publicId;
  manager.unloadContraption(entity,{skipSave:true});
  const inspect = (root: THREE.Object3D) => {
    const mats = new Set<THREE.Material>();
    root.traverse(o=>{const m=(o as THREE.Mesh).material;if(m)for(const v of Array.isArray(m)?m:[m]) if(v.userData.voxelTranslucent)mats.add(v);});
    return [...mats];
  };
  const far = inspect(manager.dormantRenderProxies.get(id)!);
  assert.ok(far.length); assert.ok(far.every(m=>!m.transparent && m.opacity === 1 && m.depthWrite));
  world.activeChunkKeys = new Set(['0,0']); manager.update(1/60,null);
  const near = inspect(manager.contraptions[0].meshGroup);
  assert.ok(near.length); assert.ok(near.every(m=>m.transparent && (m as THREE.NodeMaterial).opacityNode));
  manager.contraptions[0].dispose();
});

const transparencyIds = Array.from({length:100}, (_, i) => i + 2);

test('100 distinct material IDs encode 1–100% transparency with three render buckets', () => {
  for (const id of transparencyIds) {
    assert.equal(parseVoxelMaterialId(id), id);
    assert.equal(voxelMaterialTransparency(id), id - 1);
    assert.equal(voxelMaterialOpacity(id), (101 - id) / 100);
    assert.equal(voxelMaterialRenderBucket(id), 2);
  }
  assert.equal(new Set(transparencyIds.map(voxelMaterialOpacity)).size, 100);
  for (const id of [0, 1]) {
    assert.equal(voxelMaterialOpacity(id), 1);
    assert.equal(voxelMaterialRenderBucket(id), id);
  }
  for (const id of [-1, 102, 2.5, NaN, Infinity]) assert.throws(() => parseVoxelMaterialId(id), /materialId/);
});

test('all opacity levels survive JS/WASM meshing and merged micro render batches', () => {
  const previous = setTerrainKernelMode('js');
  const chunk = new Chunk(0, 0, null), mesher = new LowPolyMesher();
  for (const [i, id] of transparencyIds.entries()) chunk.setLocalBlock(i % 10, 5, Math.floor(i / 10), 1, 0xffffff, id);
  const buildMicro = () => {
    const micro = new MicroVoxelLayer();
    // Span several edit partitions inside one render batch.
    for (const [i, id] of transparencyIds.entries()) micro.set(i % 10 * 2, 5, Math.floor(i / 10) * 2, 0xffffff, null, id);
    micro.updateMesh();
    assert.ok(micro.meshChunks.size > 1);
    assert.equal(micro.renderMeshes.size, 1);
    const geometry = [...micro.renderMeshes.values()][0].geometry;
    assert.deepEqual(geometry.groups.map(g => g.materialIndex), [2]);
    return {colors:geometry.attributes.color.array, indices:geometry.index!.array};
  };
  const checkAlpha = (colors: ArrayLike<number>) => {
    const levels = new Set<number>();
    for (let i = 3; i < colors.length; i += 4) levels.add(colors[i]);
    assert.deepEqual([...levels].sort((a,b) => a-b), Array.from({length:100}, (_, i) => i));
  };
  try {
    const expected = mesher.buildChunkMeshData(chunk), expectedMicro = buildMicro();
    assert.equal(expected.materialIndexCounts[0], 0);
    assert.equal(expected.materialIndexCounts[1], 0);
    assert.ok(expected.colors);
    checkAlpha(expected.colors); checkAlpha(expectedMicro.colors);
    setTerrainKernelMode('wasm');
    assert.deepEqual(mesher.buildChunkMeshData(chunk), expected);
    assert.deepEqual(buildMicro(), expectedMicro);
  } finally { setTerrainKernelMode(previous); }
});

test('entity voxels and decorations retain all 100 opacities in a single glass draw', () => {
  const blocks = transparencyIds.map((materialId, i) => ({localX:i*2,localY:0,localZ:0,block:1,color:0xffffff,materialId}));
  const mesh = createVoxelMesh(blocks, new THREE.Vector3(), new THREE.Group())!;
  assert.deepEqual(mesh.geometry.groups.map(g => g.materialIndex), [2]);
  assert.equal((mesh.material as THREE.Material[]).length, 3);
  const color = mesh.geometry.attributes.color;
  for (const [i, id] of transparencyIds.entries()) {
    assert.ok(Math.abs(color.getW(i*36) * 255 / 100 - voxelMaterialOpacity(id)) < 1e-7);
  }
  const values = transparencyIds.map((materialId,i) => ({id:`glass_${i}`,color:0x88aabb,materialId,position:[i,0,0] as [number,number,number]}));
  const group = createDecorationGroup(values, new THREE.Vector3());
  const batch = group.children.find(c => c instanceof DecorationBatchMesh) as DecorationBatchMesh;
  assert.equal(group.children.filter(c => c instanceof DecorationBatchMesh).length, 1);
  assert.equal(batch.instanceCount, 100);
  for (const [i, id] of transparencyIds.entries()) assert.ok(Math.abs(batch.tintAttribute.getW(i) - voxelMaterialOpacity(id)) < 1e-7);
  const material = batch.material, matrices = batch.instanceMatrix.array.slice();
  editDecorationGroup(group, values[0].id, {...values[0], materialId:101}, new THREE.Vector3());
  assert.equal(group.children.find(c => c instanceof DecorationBatchMesh), batch);
  assert.equal(batch.material, material);
  assert.deepEqual(batch.instanceMatrix.array, matrices);
  assert.equal(batch.tintAttribute.getW(0), 0);
  assert.equal(batch.instanceCount, 100);
  const single = createDecorationGroup([values[0]], new THREE.Vector3());
  const singleMesh = single.children[0] as THREE.Mesh;
  assert.equal((singleMesh.material as THREE.Material).opacity, .99);
  editDecorationGroup(single, values[0].id, {...values[0], materialId:61}, new THREE.Vector3());
  assert.equal(single.children[0], singleMesh);
  assert.equal((singleMesh.material as THREE.Material).opacity, .4);
});

test('inventory round-trip preserves all transparency IDs for standard and micro voxels', () => {
  const data = {type:'space-blockset',version:8,name:'Glass',blocks:transparencyIds.flatMap((materialId,i) => [
    {dx:i*2,dy:0,dz:0,color:0x88aabb,materialId},
    {dx:i*2+1,dy:0,dz:0,mx:0,my:0,mz:0,color:0x88aabb,materialId},
  ])};
  const restored = decodeInventoryResource(encodeInventoryResource('blockset',data)).portable as any;
  assert.deepEqual(restored.blocks.map((b:any)=>b.materialId),transparencyIds.flatMap(id=>[id,id]));
});
