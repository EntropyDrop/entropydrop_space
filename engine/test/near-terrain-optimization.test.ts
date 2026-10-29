import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../src/voxel/World.ts';
import { Chunk } from '../src/voxel/Chunk.ts';
import { NearTerrainBatches } from '../src/render/NearTerrainBatches.ts';

function emptyResult(world: any, job: any) {
  const chunk = new Chunk(job.cx, job.cz, null);
  return { ok: true, type: 'generate', requestId: job.requestId, cx: job.cx, cz: job.cz,
    blocks: chunk.blocks, terrainColors: chunk.colors, terrainMaterials: chunk.materials,
    hasUserEdits: false, terrainDetails: chunk.terrainDetails, mesh: world.mesher.buildChunkMeshData(chunk) };
}

test('prefetch stays hidden and preserves far ownership until activation; cached mesh is reused', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setRenderDistance(3, 3); world.updateChunksAround(0, 0, false);
  const job = { type: 'generate', key: '4,0', cx: 4, cz: 0 };
  world.completedTerrainWorkerJobs.push({ job, result: emptyResult(world, job) });
  assert.equal(world.publishCompletedTerrainWorkerJob(), true);
  const chunk = world.getChunk(4, 0), mesh = chunk.mesh;
  assert.equal(mesh.visible, false);
  assert.equal(world.distantSurface.handoff.data[8], 0);
  world.processPendingChunkEvictions(performance.now(), Infinity);
  assert.equal(world.getNearTerrainStreamingStats().cachedChunks, 1);
  world.updateChunksAround(16, 0, false);
  assert.equal(world.getChunk(4, 0).mesh, mesh);
  assert.equal(mesh.visible, true);
  assert.equal(world.getNearTerrainStreamingStats().cacheHits, 1);
  world.updateChunksAround(1600, 0, false);
  world.distantSurface.handoff.advance(performance.now() + 1000);
  world.processPendingChunkEvictions(performance.now(), Infinity);
  assert.equal(world.getChunk(4, 0), null);
  assert.equal(world.getNearTerrainStreamingStats().cacheBytes, 0);
});

test('cache budget and authoritative window bound speculative residency at the torus seam', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setRenderDistance(3, 3);
  world.setTerrainDataWindow({ centerChunkX: 0, centerChunkZ: 0, radiusChunks: 3 });
  world.updateChunksAround(0, 0, false);
  assert.equal(world.streamCandidateKeys.size, 49);
  assert.equal(world.streamCandidateKeys.has('1023,127'), true);
  assert.equal(world.streamCandidateKeys.has('4,0'), false);
  world.setTerrainDataWindow(null); world.updateChunksAround(0, 0, false);
  world.setNearTerrainStreamingOptions({ cacheMiB: 0 });
  const job = { type: 'generate', key: '4,0', cx: 4, cz: 0 };
  world.completedTerrainWorkerJobs.push({ job, result: emptyResult(world, job) });
  world.publishCompletedTerrainWorkerJob();
  world.processPendingChunkEvictions(performance.now(), Infinity);
  assert.equal(world.getChunk(4, 0), null);
  assert.equal(world.getNearTerrainStreamingStats().cacheBytes, 0);
});

function pool(t: any) {
  const world = new World(new THREE.Scene()) as any;
  world.setRenderDistance(3); world.updateChunksAround(0, 0, false);
  const workers: any[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete (globalThis as any).window; });
  t.mock.method(globalThis, 'Worker', function () {
    const worker: any = { requests: [], postMessage(request: any) { this.requests.push(request); }, terminate() { this.terminated = true; } };
    workers.push(worker); return worker;
  } as any);
  world.setNearTerrainStreamingOptions({ workers: 2 });
  world.updateChunksAround(0, 0, false); world.dispatchTerrainWorkerJob();
  assert.equal(workers.length, 1, 'warm one worker before starting the second module load');
  const first = world.getTerrainWorkerJob(workers[0]);
  workers[0].onmessage({ data: emptyResult(world, first) });
  world.publishCompletedTerrainWorkerJob();
  for (const worker of workers) worker.requests.length = 0;
  for (const worker of workers) {
    const job = world.getTerrainWorkerJob(worker);
    if (job) worker.requests.push({ cx: job.cx, cz: job.cz });
  }
  return { world, workers };
}

test('two workers run distinct jobs, accept reverse completion and bound total queue to four', t => {
  const { world, workers } = pool(t);
  assert.equal(workers.length, 2);
  assert.equal(world.inFlightTerrainJobs.length, 2);
  for (let i = 0; i < 4; i++) {
    const worker = [...workers].reverse().find(w => world.getTerrainWorkerJob(w));
    const job = world.getTerrainWorkerJob(worker);
    worker.onmessage({ data: emptyResult(world, job) });
    assert.ok(world.inFlightTerrainJobs.length + world.completedTerrainWorkerJobs.length <= 4);
  }
  const requests = workers.flatMap(w => w.requests);
  assert.equal(requests.length, 4);
  assert.equal(new Set(requests.map(r => `${r.cx},${r.cz}`)).size, 4);
  assert.equal(world.completedTerrainWorkerJobs.length, 4);
  world.processInteractiveTerrainWork();
  assert.equal(world.chunks.size, 2);
  assert.equal(workers.flatMap(w => w.requests).length, 5);
});

test('failure retires only one worker and preserves the other in-flight result', t => {
  t.mock.method(console, 'warn', () => {});
  const { world, workers } = pool(t);
  const survivorJob = world.getTerrainWorkerJob(workers[1]);
  workers[0].onerror({ message: 'test failure' });
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[1].terminated, undefined);
  workers[1].onmessage({ data: emptyResult(world, survivorJob) });
  assert.equal(world.publishCompletedTerrainWorkerJob(), true);
  assert.ok(world.getChunk(survivorJob.cx, survivorJob.cz)?.mesh);
});

test('near command groups preserve transforms, invalidate visibility/materials and leave transparency globally sorted', () => {
  const root = new THREE.Group(), batches = new NearTerrainBatches(root), chunk = new THREE.Group();
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshBasicMaterial();
  const leaf = new THREE.Mesh(geometry, material); chunk.add(leaf); chunk.position.set(64, 0, 32);
  batches.add(chunk); root.updateMatrixWorld(true);
  const matrix = leaf.matrixWorld.clone(), region: any = chunk.parent;
  batches.sync(); const version = region.version;
  batches.sync(); assert.equal(region.version, version);
  chunk.visible = false; batches.sync(); assert.equal(region.version, version + 1);
  material.needsUpdate = true; batches.sync(); assert.equal(region.version, version + 2);
  batches.setEnabled(false); root.updateMatrixWorld(true); assert.equal(chunk.parent, root);
  assert.deepEqual(leaf.matrixWorld.elements, matrix.elements);
  batches.setEnabled(true); material.transparent = true; batches.sync(); assert.equal(chunk.parent, root);
  material.transparent = false; batches.sync(); assert.equal(chunk.parent, region);
  batches.remove(chunk); assert.equal(chunk.parent, null); assert.equal(batches.getStats().regions, 0);
});

test('second worker stays available for near demand while the first preloads', t => {
  const { world, workers } = pool(t);
  world.terrainWorkerJob = null; world.extraTerrainWorkers[0].job = null;
  for (const worker of workers) worker.requests.length = 0;
  world.activeChunkKeys = new Set(['0,0', '3,0']);
  world.streamCandidateKeys.add('4,0'); world.streamCandidateKeys.add('4,1');
  world.pendingStreamChunks = [{ cx: 4, cz: 0, distanceSq: 1e6 + 16 }, { cx: 4, cz: 1, distanceSq: 1e6 + 17 }];
  world.dispatchTerrainWorkerJob();
  assert.equal(workers[0].requests.length, 1);
  assert.equal(workers[1].requests.length, 0);
  assert.equal(world.pendingStreamChunks.length, 1);
  world.pendingStreamChunks.unshift({ cx: 3, cz: 0, distanceSq: 9 });
  world.dispatchTerrainWorkerJob();
  assert.equal(workers[1].requests.length, 1);
  assert.equal(workers[1].requests[0].cx, 3);
  assert.equal(world.pendingStreamChunks.length, 1);
});
