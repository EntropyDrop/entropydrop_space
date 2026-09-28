import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TerrainGenerator } from '../src/worldgen/TerrainGenerator.ts';
import { generateVoxelSurfaceZone } from '../src/worldgen/VoxelSurfaceGenerator.ts';
import { DistantVoxelLayer, MAX_VOXEL_LOD_FACES, voxelFaceBudget } from '../src/render/DistantVoxelLayer.ts';
import { TerrainHandoff } from '../src/render/TerrainHandoff.ts';
import { bendPoint } from '../src/torus/TorusWorld.ts';

// Repeat one actual Aether district across the entire torus. Shared immutable
// sources keep the test bounded while exercising all 128 zones in the renderer.
// This tests global quality/memory pressure, not seed-exact world generation.
const started = performance.now();
const volume = generateVoxelSurfaceZone(new TerrainGenerator(42, 3), 16, 2);
const layer = new DistantVoxelLayer(new TerrainHandoff().texture);
const camera = new THREE.PerspectiveCamera(75, 16 / 9, .1, 32768);
camera.position.copy(bendPoint(8192, 180, 1024));
camera.lookAt(bendPoint(8256, 130, 1050));
camera.updateMatrixWorld();
const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4()
  .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
for (let x = 0; x < 32; x++) for (let z = 0; z < 4; z++) {
  layer.install({ zoneX: x, zoneZ: z, seed: 42, terrainGeneratorVersion: 3,
    sourceTerrainRevision: 0, zoneSizeChunks: 32, samplesPerChunkAxis: 16, sampleSize: 1,
    heightsMicro: new Uint16Array(0), colors: new Uint8Array(0), voxelMips: volume.levels });
}
const focal = 720 * camera.projectionMatrix.elements[5] / 2;
// Keep the original 16 px^2 quality regression as a stable reference.
const area = 16;
const selectionStarted = performance.now();
layer.updateView(frustum, camera.position, focal, area, 32768);
const stats = { ...layer.group.userData.voxelLodStats };
assert.ok(stats.faces <= MAX_VOXEL_LOD_FACES);
assert.ok(stats.effectiveAreaPx2 <= 24, `Whole-world quality regressed: ${JSON.stringify(stats)}`);
let bytes = 0;
layer.group.traverse(object => {
  if (!object.name.endsWith(':tops')) return; // Exclude the fading overview.
  const geometry = (object as THREE.Mesh).geometry as THREE.InstancedBufferGeometry | undefined;
  if (!geometry?.instanceCount) return;
  for (const attribute of Object.values(geometry.attributes)) {
    if (attribute instanceof THREE.InstancedBufferAttribute) {
      bytes += geometry.instanceCount * attribute.itemSize * attribute.array.BYTES_PER_ELEMENT;
    }
  }
});
assert.equal(bytes, stats.faces * 15, 'Packed geometry must stay at 15 bytes per face');
const selectionMs = performance.now() - selectionStarted;
layer.updateView(new THREE.Frustum(), camera.position, focal, area, 32768);
assert.deepEqual(layer.group.userData.voxelLodStats, stats, 'Turning must not reduce resident quality');
layer.updateView(frustum, camera.position, focal * 4, area, 32768);
assert.ok(layer.group.userData.voxelLodStats.faces <= MAX_VOXEL_LOD_FACES, 'Zoom respects the geometry budget');
layer.updateView(frustum, camera.position, focal, area, 32768);
assert.ok(layer.group.userData.voxelLodStats.effectiveAreaPx2 <= 24 / .65,
  'Quality recovers within the coarsening hysteresis band after pressure ends');
const detailThresholds = [{ areaPx2: area, ...stats }];
for (const areaPx2 of [64, 256]) {
  layer.updateView(frustum, camera.position, focal, areaPx2, 32768);
  const selected = { ...layer.group.userData.voxelLodStats };
  assert.ok(selected.faces < detailThresholds.at(-1)!.faces, `${areaPx2} px^2 must reduce resident geometry`);
  detailThresholds.push({ areaPx2, ...selected });
}
let highDetailBudget;
if (process.argv.includes('--high-detail')) {
  // Opt-in: this publishes hundreds of MiB of geometry. Confirm that changing
  // only the budget restores the requested quality at the same camera pose.
  layer.updateView(frustum, camera.position, focal, 1, 32768);
  const constrained = { ...layer.group.userData.voxelLodStats };
  assert.ok(constrained.effectiveAreaPx2 > 1);
  layer.updateView(frustum, camera.position, focal, 1, 32768, voxelFaceBudget(512));
  const expanded = { ...layer.group.userData.voxelLodStats };
  assert.equal(expanded.effectiveAreaPx2, 1);
  assert.ok(expanded.faces > constrained.faces);
  assert.ok(expanded.faces <= voxelFaceBudget(512));
  highDetailBudget = { constrained, expanded, packedMiB: expanded.faces * 15 / 1048576 };
}
for (let x = 0; x < 32; x++) for (let z = 0; z < 4; z++) layer.removeZone(x, z);
assert.equal(layer.group.children.length, 0);
console.log(JSON.stringify({ ...stats, packedMiB: bytes / 1048576, selectionMs, detailThresholds,
  highDetailBudget, totalSeconds: (performance.now() - started) / 1000 }, null, 2));
