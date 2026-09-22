import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TerrainGenerator } from '../src/worldgen/TerrainGenerator.ts';
import { generateVoxelSurfaceZone } from '../src/worldgen/VoxelSurfaceGenerator.ts';
import { DistantVoxelLayer, MAX_VOXEL_LOD_FACES } from '../src/render/DistantVoxelLayer.ts';
import { DEFAULT_DISTANT_SURFACE_SETTINGS } from '../src/render/DistantSurfaceLayer.ts';
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
const area = DEFAULT_DISTANT_SURFACE_SETTINGS.subdivisionSizePx2;
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
for (let x = 0; x < 32; x++) for (let z = 0; z < 4; z++) layer.removeZone(x, z);
assert.equal(layer.group.children.length, 0);
console.log(JSON.stringify({ ...stats, packedMiB: bytes / 1048576, selectionMs,
  totalSeconds: (performance.now() - started) / 1000 }, null, 2));
