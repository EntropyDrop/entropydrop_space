import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MicroVoxelLayer } from '../src/voxel/MicroVoxelLayer.ts';
import { World, terrainRenderDistanceZ } from '../src/voxel/World.ts';
import { Chunk } from '../src/voxel/Chunk.ts';
import { TerrainGenerator } from '../src/worldgen/TerrainGenerator.ts';

function triangles(meshes: Iterable<THREE.Mesh>) {
  const result: string[] = [];
  for (const mesh of meshes) {
    const geometry = mesh.geometry, indices = geometry.index!.array;
    const p = geometry.getAttribute('position').array;
    const n = geometry.getAttribute('normal').array, c = geometry.getAttribute('color').array;
    for (const group of geometry.groups) {
      for (let i = group.start; i < group.start + group.count; i += 3) {
        const values = [group.materialIndex];
        for (let corner = 0; corner < 3; corner++) {
          const j = indices[i + corner] * 3;
          values.push(p[j] * mesh.scale.x + mesh.position.x,
            p[j + 1] * mesh.scale.y + mesh.position.y, p[j + 2] * mesh.scale.z + mesh.position.z,
            n[j], n[j + 1], n[j + 2], c[j], c[j + 1], c[j + 2]);
        }
        result.push(JSON.stringify(values));
      }
    }
  }
  return result.sort();
}

test('render batches preserve every published triangle, color, normal and material across seams', () => {
  const layer = new MicroVoxelLayer();
  for (const x of [0, 15, 16, 63, 127, 128, 131071]) {
    for (const z of [0, 15, 16, 127, 128, 16383]) {
      for (const y of [7, 17, 2000]) layer.set(x, y, z, 0x79b4de, null, y % 2);
    }
  }
  layer.updateMesh();
  assert.deepEqual(triangles(layer.renderMeshes.values()), triangles(layer.meshChunks.values()));
  assert.ok(layer.renderMeshes.size < layer.meshChunks.size / 2);
  assert.equal(layer.group.children.length, layer.renderMeshes.size);
  for (const mesh of layer.renderMeshes.values()) assert.ok(mesh.geometry.groups.length <= 2);
});

test('batch publication keeps deferred conversion geometry and collision atomic', () => {
  const layer = new MicroVoxelLayer();
  layer.set(1, 1, 1, 0x123456); layer.set(20, 1, 1, 0x654321);
  layer.updateMesh();
  const batch = layer.renderMeshes.get('0,0')!;
  let disposed = 0;
  batch.geometry.addEventListener('dispose', () => disposed++);
  layer.delete(1, 1, 1);
  layer.updateMesh(Infinity, new Set(['0,0']), null, Infinity, new Set(['0,0']));
  assert.equal(layer.renderMeshes.get('0,0'), batch);
  assert.equal(layer.getPublishedCollisionColor(1, 1, 1), 0x123456);
  layer.publishDeferredForStandardChunk('0,0', () => {});
  assert.equal(disposed, 1);
  assert.equal(layer.getPublishedCollisionColor(1, 1, 1), null);
  assert.deepEqual(triangles(layer.renderMeshes.values()), triangles(layer.meshChunks.values()));
});

test('local edits replace only their chunk batch and fully empty batches are removed', () => {
  const layer = new MicroVoxelLayer();
  for (const x of [1, 20, 129, 148]) layer.set(x, 1, 1, 0xabcdef);
  layer.updateMesh();
  const far = layer.renderMeshes.get('1,0');
  layer.delete(1, 1, 1); layer.delete(20, 1, 1);
  layer.updateMesh();
  assert.equal(layer.renderMeshes.get('1,0'), far);
  assert.equal(layer.renderMeshes.size, 1);
  assert.equal(layer.group.children.length, 1);
});

test('dense authored geometry falls back to bounded partitions and can return to batching', () => {
  const layer = new MicroVoxelLayer();
  for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) {
    if ((x + y + z) % 2 === 0) layer.set(x, y, z, 0xabcdef);
  }
  layer.set(20, 1, 1, 0x123456);
  layer.updateMesh();
  assert.equal(layer.renderMeshes.size, 2);
  for (const [key, mesh] of layer.renderMeshes) assert.equal(mesh, layer.meshChunks.get(key));
  layer.clearChunk(0, 0); layer.updateMesh();
  assert.equal(layer.renderMeshes.size, 0);
  layer.set(1, 1, 1, 0xffffff); layer.set(20, 1, 1, 0xffffff); layer.updateMesh();
  assert.equal(layer.renderMeshes.size, 1);
  layer.setRenderBatchingEnabled(false);
  assert.equal(layer.renderMeshes.size, 2);
  layer.setRenderBatchingEnabled(true);
  assert.equal(layer.renderMeshes.size, 1);
});

test('real Copper detail uses one draw mesh per standard chunk without removing triangles', () => {
  const layer = new MicroVoxelLayer(), chunk = new Chunk(512, 64, null);
  new TerrainGenerator(20260922, 2).generateChunk(chunk);
  layer.setPackedTerrainCells(512 * 128, 64 * 128, chunk.terrainDetails, () => true);
  layer.updateMesh();
  assert.ok(layer.meshChunks.size >= 50);
  assert.equal(layer.renderMeshes.size, 1);
  assert.deepEqual(triangles(layer.renderMeshes.values()), triangles(layer.meshChunks.values()));
});

test('rectangular detail window preserves wrapped Z/X neighbors with a six-chunk Z cap', () => {
  const world = new World(new THREE.Scene());
  world.updateChunksAround(0, 0, false);
  assert.equal(world.activeChunkKeys.size, 17 * 9);
  for (const key of ['0,0', '0,127', '1023,0', '1023,127', '8,4', '1016,124']) {
    assert.ok(world.activeChunkKeys.has(key), key);
  }
  assert.equal(world.activeChunkKeys.has('0,5'), false);
  assert.equal(world.activeChunkKeys.has('0,123'), false);
  assert.equal(terrainRenderDistanceZ(3), 3);
  assert.equal(terrainRenderDistanceZ(24), 6);
  world.setRenderDistance(24); world.updateChunksAround(0, 0, false);
  assert.equal(world.renderDistance, 16);
  assert.equal(world.activeChunkKeys.size, 33 * 13);
  world.setRenderDistance(8, 8); world.updateChunksAround(0, 0, false);
  assert.equal(world.activeChunkKeys.size, 17 * 17, 'development comparison can restore the square window');
});

test('near AOI never publishes unsynchronized edge chunks, including torus seams', () => {
  const world = new World(new THREE.Scene());
  world.setRenderDistance(1000);
  world.setTerrainDataWindow({ centerChunkX: 1020, centerChunkZ: 124, radiusChunks: 16, radiusChunksZ: 12 });
  world.updateChunksAround(1, 1, false);
  assert.equal(world.renderDistance, 16);
  assert.ok(world.activeChunkKeys.has('12,0'));
  assert.equal(world.activeChunkKeys.has('13,0'), false);
  assert.ok(world.activeChunkKeys.has('1008,127'));
  world.setTerrainDataWindow({ centerChunkX: 4, centerChunkZ: 4, radiusChunks: 16, radiusChunksZ: 12 });
  world.updateChunksAround(1, 1, false);
  assert.ok(world.activeChunkKeys.has('13,0'), 'newly synchronized fringe becomes eligible');
  assert.equal(world.activeChunkKeys.has('1008,127'), false);
  world.setTerrainDataWindow(null);
  world.updateChunksAround(1, 1, false);
  assert.equal(world.activeChunkKeys.size, 33 * 13);
});
