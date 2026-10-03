/**
 * CPU-only far-view diagnosis using one repeated Aether district (128 zones).
 * No WebGL context, network, physics or FPS measurement. Source generation and
 * fade settling are outside the timed operations. Run from the workspace root:
 * node --import ./engine/test/setup.ts engine/tools/benchmark-voxel-view.ts
 * Optional positional arguments: subdivision area (default 64), MiB (default 160).
 * Add --worker to exercise the browser worker, transfer pacing and publication.
 * Worker completion latency is reported separately from main-thread CPU work.
 */
import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import * as THREE from 'three';
import { TerrainGenerator } from '../src/worldgen/TerrainGenerator.ts';
import { generateVoxelSurfaceZone } from '../src/worldgen/VoxelSurfaceGenerator.ts';
import { DistantVoxelLayer, voxelFaceBudget } from '../src/render/DistantVoxelLayer.ts';
import { SurfaceBatch } from '../src/render/SurfaceBatch.ts';
import { TerrainHandoff, TERRAIN_FADE_MS } from '../src/render/TerrainHandoff.ts';
import { bendPoint } from '../src/torus/TorusWorld.ts';
import { NodeVoxelLodWorker } from '../test/helpers/voxel-lod-worker.ts';

const useWorker = process.argv.includes('--worker');
const parameters = process.argv.slice(2).filter(value => value !== '--worker');
const area = Number(parameters[0] ?? 64), budgetMiB = Number(parameters[1] ?? 160);
assert.ok(Number.isFinite(area) && area >= 1 && area <= 256);
assert.ok(Number.isFinite(budgetMiB) && budgetMiB >= 16 && budgetMiB <= 512);
const volume = generateVoxelSurfaceZone(new TerrainGenerator(42, 3), 16, 2);
const handoff = new TerrainHandoff();
const layer = new DistantVoxelLayer(handoff.texture, useWorker ? { workerFactory: () => new NodeVoxelLodWorker() } : {});
const camera = new THREE.PerspectiveCamera(75, 16 / 9, .1, 32768);
const frustum = new THREE.Frustum(), matrix = new THREE.Matrix4();
const focal = 720 * camera.projectionMatrix.elements[5] / 2;
const zones = Array.from({ length: 128 }, (_, index) => ({
  zoneX: Math.floor(index / 4), zoneZ: index % 4, seed: 42, terrainGeneratorVersion: 3,
  sourceTerrainRevision: 0, zoneSizeChunks: 32, samplesPerChunkAxis: 16, sampleSize: 1,
  heightsMicro: new Uint16Array(0), colors: new Uint8Array(0), voxelMips: volume.levels,
}));
const view = (x: number, yaw = 0) => {
  camera.position.copy(bendPoint(x, 180, 1024));
  camera.lookAt(bendPoint(x + Math.cos(yaw) * 64, 130, 1024 + Math.sin(yaw) * 64));
  camera.updateMatrixWorld();
  frustum.setFromProjectionMatrix(matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
};
let frameWork: number[] = [];
const update = () => {
  const started = performance.now();
  layer.updateView(frustum, camera.position, focal, area, 32768, voxelFaceBudget(budgetMiB));
  frameWork.push(performance.now() - started);
};
async function drain() {
  const deadline = performance.now() + 120000;
  while (layer.hasPendingWork) {
    assert.ok(performance.now() < deadline, 'worker must publish all requested geometry');
    await delay(1000 / 60); update();
  }
}
const summary = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: samples.length, p50Ms: +sorted[Math.floor(sorted.length * .5)].toFixed(3),
    p95Ms: +sorted[Math.floor(sorted.length * .95)].toFixed(3), maxMs: +sorted.at(-1)!.toFixed(3) };
};
let submissions = 0, changedSubmissions = 0, submittedFaces = 0;
const originalSubmit = SurfaceBatch.prototype.submit;
const originalPrepared = SurfaceBatch.prototype.submitPrepared;
SurfaceBatch.prototype.submit = function (...args) {
  submissions++;
  submittedFaces += args[2] + args[5];
  const changed = originalSubmit.apply(this, args);
  if (changed) changedSubmissions++;
  return changed;
};
SurfaceBatch.prototype.submitPrepared = function (...args) {
  submissions++; submittedFaces += args[1];
  const changed = originalPrepared.apply(this, args);
  if (changed) changedSubmissions++;
  return changed;
};
const measure = async (name: string, count: number, prepare: (i: number) => void,
  operation: () => void, settle = false) => {
  submissions = changedSubmissions = submittedFaces = 0;
  const times: number[] = [], latencies: number[] = []; frameWork = [];
  for (let i = 0; i < count; i++) {
    prepare(i);
    const started = performance.now();
    operation();
    times.push(performance.now() - started);
    await drain();
    latencies.push(performance.now() - started);
    if (settle) { await delay(TERRAIN_FADE_MS + 20); update(); }
  }
  console.log(JSON.stringify({ name, ...summary(times), submissions, changedSubmissions,
    submittedFaces, frameWork: frameWork.length ? summary(frameWork) : null,
    completionLatency: summary(latencies), ...layer.group.userData.voxelLodStats }));
};
try {
  console.log(JSON.stringify({ node: process.version, cpu: cpus()[0]?.model,
    backend: useWorker ? 'worker' : 'synchronous',
    logicalSourceMiB: volume.levels.reduce((n, mip) => n + mip.faces.length, 0) * 128 / 1048576,
    uniqueSourceMiB: volume.levels.reduce((n, mip) => n + mip.faces.length, 0) / 1048576,
    areaPx2: area, budgetMiB, zones: zones.length, fixture: 'Repeated Aether district; CPU only' }));
  for (const zone of zones) layer.install(zone);
  view(8192);
  await measure('initial view selection', 1, () => {}, update, true);
  for (let i = 0; i < 200; i++) update();
  await measure('stationary', 240, () => {}, update);
  assert.equal(submissions, 0, 'Stationary view must not repack geometry');
  await measure('rotation only', 120, i => view(8192, i * Math.PI / 60), update);
  assert.equal(submissions, 0, 'Rotation must preserve geometry residency');
  await measure('move 16m', 24, i => view(8192 + (i + 1) * 16), update, true);
  const replacement = zones.find(zone => zone.zoneX === 16 && zone.zoneZ === 2)!;
  await measure('reinstall identical nearby source', 5, () => {}, () => layer.install(replacement), true);
  await measure('stationary after motion', 240, () => {}, update);
  assert.equal(submissions, 0);
} finally {
  SurfaceBatch.prototype.submit = originalSubmit;
  SurfaceBatch.prototype.submitPrepared = originalPrepared;
  for (const zone of zones) layer.removeZone(zone.zoneX, zone.zoneZ);
  handoff.texture.dispose();
  layer.dispose();
}
