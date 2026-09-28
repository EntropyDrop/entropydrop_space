import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../src/voxel/World.ts';
import { Chunk } from '../src/voxel/Chunk.ts';
import { MicroVoxelLayer } from '../src/voxel/MicroVoxelLayer.ts';
import { buildMicroMeshSnapshot, type MicroMeshSnapshot } from '../src/voxel/MicroMeshSnapshot.ts';

class MicroWorker {
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  requests: MicroMeshSnapshot[] = [];
  terminated = false;
  postMessage(request: MicroMeshSnapshot, transfer: Transferable[]) {
    this.requests.push(structuredClone(request, { transfer }));
  }
  terminate() { this.terminated = true; }
  complete(index = 0) {
    const request = this.requests.splice(index, 1)[0];
    const mesh = buildMicroMeshSnapshot(request);
    this.onmessage!({ data: structuredClone({ requestId: request.requestId, mesh }, {
      transfer: [mesh.positions.buffer, mesh.normals.buffer, mesh.colors.buffer, mesh.indices.buffer],
    }) });
  }
}

function attachWorker(layer: MicroVoxelLayer) {
  const worker = new MicroWorker();
  (layer as any).attachMeshWorker(worker);
  return worker;
}

function drain(layer: MicroVoxelLayer, worker: MicroWorker) {
  for (let turn = 0; turn < 1000 && layer.dirty; turn++) {
    while (worker.requests.length) worker.complete(worker.requests.length - 1);
    layer.updateMesh();
  }
  assert.equal(layer.dirty, false);
}

function meshData(layer: MicroVoxelLayer) {
  return [...layer.meshChunks].sort(([a], [b]) => a.localeCompare(b)).map(([key, mesh]) => ({
    key, position: mesh.position.toArray(), scale: mesh.scale.toArray(), groups: mesh.geometry.groups,
    positions: mesh.geometry.getAttribute('position').array,
    normals: mesh.geometry.getAttribute('normal').array,
    colors: mesh.geometry.getAttribute('color').array,
    indices: mesh.geometry.index!.array,
  }));
}

test('worker micro meshes match local geometry, materials, vertical boundaries and torus seams', () => {
  const local = new MicroVoxelLayer(), remote = new MicroVoxelLayer();
  for (const layer of [local, remote]) {
    for (const x of [0, 1, 15, 16, 17, 127, 128, 131071]) {
      for (const z of [0, 15, 16, 16383]) for (const y of [0, 15, 16, 31, 2000]) {
        layer.set(x, y, z, (x + y) % 2 ? 0x123456 : 0, null, y % 2);
      }
    }
    // Include a solid volume, not only sparse samples.
    for (let x = 33; x < 47; x++) for (let z = 33; z < 47; z++) {
      for (let y = 1; y < 15; y++) layer.set(x, y, z, 0xff6633);
    }
  }
  local.updateMesh();
  const worker = attachWorker(remote);
  drain(remote, worker);
  assert.deepEqual(meshData(remote), meshData(local));
  assert.equal(remote.getPublishedCollisionColor(15, 15, 15), local.getPublishedCollisionColor(15, 15, 15));
});

test('micro background queue follows wrapped player distance while direct edits keep priority', () => {
  const layer = new MicroVoxelLayer();
  layer.set(800, 8, 800, 1);
  layer.set(131071, 8, 16383, 2);
  layer.set(161, 8, 1, 3);
  layer.setMeshFocus(0, 0);
  layer.updateMesh(1);
  assert.ok(layer.meshChunks.has('8191,1023,0'), 'the nearby wrapped seam precedes the old distant task');
  layer.prioritizeMeshAt(161, 1, 8);
  layer.setMeshFocus(2, 2);
  layer.updateMesh(1);
  assert.ok(layer.meshChunks.has('10,0,0'), 'movement must not displace a direct edit');
  assert.equal(layer.meshChunks.has('50,50,0'), false);
});

test('micro worker lookahead is bounded and a direct edit bypasses a full background queue', () => {
  const layer = new MicroVoxelLayer();
  for (let i = 0; i < 40; i++) layer.set(i * 16 + 1, 1, 1, 1);
  const worker = attachWorker(layer);
  layer.updateMesh();
  assert.equal(worker.requests.length, 16);
  layer.updateMesh();
  assert.equal(worker.requests.length, 16, 'a stalled worker cannot grow the buffer queue');
  layer.set(39 * 16 + 1, 1, 1, 2);
  layer.prioritizeMeshAt(39 * 16 + 1, 1, 1);
  layer.updateMesh(1);
  assert.equal(layer.getPublishedCollisionColor(39 * 16 + 1, 1, 1), 2);
  assert.equal(worker.requests.length, 16);
  drain(layer, worker);
});

test('late micro worker results cannot overwrite a newer edit or collision publication', () => {
  const layer = new MicroVoxelLayer();
  layer.set(1, 1, 1, 1); layer.updateMesh();
  const worker = attachWorker(layer);
  layer.set(1, 1, 1, 2); layer.updateMesh();
  assert.equal(worker.requests.length, 1);
  assert.equal(layer.getPublishedCollisionColor(1, 1, 1), 1);
  layer.set(1, 1, 1, 3); layer.prioritizeMeshAt(1, 1, 1); layer.updateMesh();
  const newest = layer.meshChunks.get('0,0,0');
  worker.complete(); layer.updateMesh();
  assert.equal(layer.meshChunks.get('0,0,0'), newest);
  assert.equal(layer.getPublishedCollisionColor(1, 1, 1), 3);
});

test('worker micro results respect AOI eviction, snapshot blocking and atomic publication', () => {
  const layer = new MicroVoxelLayer();
  const active = new Set(['0,0']), barrier = new Set(['0,0']);
  layer.set(1, 1, 1, 1); layer.updateMesh();
  const previous = layer.meshChunks.get('0,0,0');
  const worker = attachWorker(layer);
  layer.set(1, 1, 1, 2);
  layer.updateMesh(64, active, null, Infinity, barrier);
  assert.equal(layer.isDeferredPublicationReady('0,0', active), false);
  assert.deepEqual([...layer.getPendingStandardChunkKeys(active)], ['0,0']);
  worker.complete();
  layer.updateMesh(64, new Set(), null, Infinity, barrier);
  assert.equal(layer.meshChunks.get('0,0,0'), previous);
  layer.updateMesh(64, active, null, Infinity, barrier);
  worker.complete();
  layer.updateMesh(64, active, active, Infinity, barrier);
  assert.equal(layer.getPublishedCollisionColor(1, 1, 1), 1);
  layer.updateMesh(64, active, null, Infinity, barrier);
  worker.complete();
  layer.updateMesh(64, active, null, Infinity, barrier);
  assert.equal(layer.isDeferredPublicationReady('0,0', active), true);
  assert.equal(layer.meshChunks.get('0,0,0'), previous);
  assert.equal(layer.getPublishedCollisionColor(1, 1, 1), 1);
  layer.publishDeferredForStandardChunk('0,0', () => {});
  assert.equal(layer.getPublishedCollisionColor(1, 1, 1), 2);
});

test('micro worker failure returns unfinished jobs to the budgeted local mesher', t => {
  t.mock.method(console, 'warn', () => {});
  const layer = new MicroVoxelLayer();
  layer.set(1, 1, 1, 7);
  const worker = attachWorker(layer);
  layer.updateMesh();
  worker.onerror!({ message: 'test worker failure' });
  assert.equal(worker.terminated, true);
  layer.updateMesh();
  assert.equal(layer.getPublishedCollisionColor(1, 1, 1), 7);
  assert.equal(layer.dirty, false);
});

test('evicted empty micro partitions retire outside the AOI without loading authored detail', () => {
  const layer = new MicroVoxelLayer();
  layer.set(1, 1, 1, 1); layer.set(20, 1, 1, 1); layer.updateMesh();
  layer.clearChunk(0, 0);
  layer.set(257, 1, 1, 2);
  layer.updateMesh(64, new Set(['1,0']));
  assert.equal(layer.meshChunks.size, 0);
  assert.equal(layer.renderMeshes.size, 0);
  assert.equal(layer.getPublishedCollisionColor(1, 1, 1), null);
  assert.equal(layer.getPublishedCollisionColor(257, 1, 1), null);
  assert.equal(layer.get(257, 1, 1), 2);
  layer.updateMesh(64, new Set(['2,0']));
  assert.equal(layer.getPublishedCollisionColor(257, 1, 1), 2);
});

function emptyTerrainResult(world: any, job: any) {
  const chunk = new Chunk(job.cx, job.cz, null);
  return { ok: true, type: 'generate', requestId: job.requestId, cx: job.cx, cz: job.cz,
    blocks: chunk.blocks, terrainColors: chunk.colors, terrainMaterials: chunk.materials,
    terrainDetails: chunk.terrainDetails, mesh: world.mesher.buildChunkMeshData(chunk) };
}

test('terrain worker completion starts bounded lookahead without waiting for an idle callback', t => {
  const world = new World(new THREE.Scene()) as any;
  world.setRenderDistance(3); world.updateChunksAround(0, 0, false);
  const requests: any[] = [];
  const worker: any = { postMessage: request => requests.push(request) };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete (globalThis as any).window;
  });
  t.mock.method(globalThis, 'Worker', function () { return worker; } as any);
  world.initializeTerrainWorker();
  world.dispatchTerrainWorkerJob();
  for (let i = 0; i < 4; i++) {
    const job = world.terrainWorkerJob;
    worker.onmessage({ data: emptyTerrainResult(world, job) });
    assert.equal(requests.length, Math.min(i + 2, 4));
  }
  assert.equal(world.terrainWorkerJob, null);
  assert.equal(world.completedTerrainWorkerJobs.length, 4);
  assert.equal(new Set(requests.map(r => `${r.cx},${r.cz}`)).size, 4);
  // Rendering consumes a result and refills the worker even with no edits and
  // no browser idle time. Do not initialize a micro worker in this Node test.
  world.processInteractiveTerrainWork();
  assert.equal(world.chunks.size, 1);
  assert.equal(requests.length, 5);
});

test('one standard/micro barrier cannot block independent terrain results or generation', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setRenderDistance(3); world.updateChunksAround(0, 0, false);
  const requests: any[] = [];
  world.terrainWorker = { postMessage: request => requests.push(request) };
  const chunk = world.getOrCreateChunk(0, 0);
  world.microVoxels.set(1, 200, 1, 1);
  world.crossLayerPublicationChunks.add('0,0');
  const blocked = { job: { type: 'remesh', key: '0,0', cx: 0, cz: 0, dataVersion: chunk.dataVersion },
    result: { mesh: world.mesher.buildChunkMeshData(chunk) } };
  const job = { type: 'generate', key: '1,0', cx: 1, cz: 0 };
  world.completedTerrainWorkerJobs.push(blocked, { job, result: emptyTerrainResult(world, job) });
  assert.equal(world.dispatchTerrainWorkerJob(), true);
  assert.notEqual(`${requests[0].cx},${requests[0].cz}`, '0,0');
  assert.notEqual(`${requests[0].cx},${requests[0].cz}`, '1,0');
  assert.equal(world.publishCompletedTerrainWorkerJob(), true);
  assert.ok(world.getChunk(1,0)?.mesh);
  assert.ok(world.crossLayerPublicationChunks.has('0,0'));
  assert.ok(world.completedTerrainWorkerJobs.includes(blocked));
  assert.equal(world.microVoxels.getPublishedCollisionColor(1, 200, 1), null);
});
