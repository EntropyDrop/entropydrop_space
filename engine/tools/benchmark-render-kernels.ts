import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TerrainGenerator } from '../src/worldgen/TerrainGenerator.ts';
import { Chunk } from '../src/voxel/Chunk.ts';
import { MicroVoxelLayer } from '../src/voxel/MicroVoxelLayer.ts';
import { LowPolyMesher } from '../src/mesher/LowPolyMesher.ts';
import { DistantSurfaceLayer } from '../src/render/DistantSurfaceLayer.ts';
import { bendPoint } from '../src/torus/TorusWorld.ts';
import { setTerrainKernelMode } from '../src/wasm/TerrainKernels.ts';
import type { SurfaceZoneSnapshot } from '../src/voxel/SurfaceZoneSnapshot.ts';

// CPU end-to-end mesh calls, including packing, copies and Three geometry
// publication. Excludes source generation, yield waiting, GPU and draw time.
const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];
function report(name: string, js: number[], wasm: number[]) {
  const a = median(js), b = median(wasm);
  console.log(`${name}: JS ${a.toFixed(3)} ms -> WASM ${b.toFixed(3)} ms (${(a / b).toFixed(2)}x)`);
}
function digest(meshes: THREE.Mesh[]) {
  const hash = createHash('sha256');
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const count = geometry instanceof THREE.InstancedBufferGeometry ? geometry.instanceCount : Infinity;
    for (const attr of Object.values(geometry.attributes)) {
      const array = attr.array;
      const length = attr instanceof THREE.InstancedBufferAttribute ? Math.min(count * attr.itemSize, array.length) : array.length;
      hash.update(new Uint8Array(array.buffer, array.byteOffset, length * array.BYTES_PER_ELEMENT));
    }
    if (geometry.index) hash.update(new Uint8Array(geometry.index.array.buffer));
    hash.update(JSON.stringify(geometry.groups));
  }
  return hash.digest('hex');
}

for (const [cx, cz] of [[512, 64], [511, 63], [513, 65]]) {
  setTerrainKernelMode('wasm');
  const chunk = new Chunk(cx, cz, null);
  new TerrainGenerator(20260922, 2).generateChunk(chunk);
  const times = { js: [] as number[], wasm: [] as number[] };
  const standardTimes = { js: [] as number[], wasm: [] as number[] }, mesher = new LowPolyMesher();
  let standardReference: ReturnType<LowPolyMesher['buildChunkMeshData']> | undefined;
  let reference: string | undefined;
  for (let round = 0; round < 11; round++) {
    for (const mode of round % 2 ? ['wasm', 'js'] as const : ['js', 'wasm'] as const) {
      setTerrainKernelMode(mode);
      const meshStart = performance.now(), standard = mesher.buildChunkMeshData(chunk);
      const meshElapsed = performance.now() - meshStart;
      if (round >= 2) standardTimes[mode].push(meshElapsed);
      standardReference ??= standard; assert.deepEqual(standard, standardReference, 'Standard geometry changed');
      const layer = new MicroVoxelLayer();
      layer.setPackedTerrainCells(cx * 128, cz * 128, chunk.terrainDetails, () => true);
      const start = performance.now(); layer.updateMesh(); const elapsed = performance.now() - start;
      if (round >= 2) times[mode].push(elapsed);
      const actual = digest([...layer.meshChunks.values()]);
      reference ??= actual; assert.equal(actual, reference, 'Micro geometry changed');
      for (const mesh of layer.meshChunks.values()) mesh.geometry.dispose();
      for (const material of layer.renderMaterials) material.dispose();
    }
  }
  report(`Copper micro mesh ${cx},${cz}`, times.js, times.wasm);
  report(`Copper standard mesh ${cx},${cz}`, standardTimes.js, standardTimes.wasm);
}

// Generate one real Copper 512x512 source outside the timed region.
const script = fileURLToPath(new URL('../../server/space/runtime/terrain-surface.ts', import.meta.url));
const generated = spawnSync(process.execPath, [script, 'zone', '20260922', '2', '16', '2'], { maxBuffer: 4 * 1024 * 1024 });
if (generated.status !== 0) throw new Error(generated.stderr.toString());
const count = 512 ** 2, heightsMicro = new Uint16Array(count), colors = new Uint8Array(count * 3);
for (let i = 0; i < count; i++) {
  heightsMicro[i] = generated.stdout.readUInt16LE(i * 8);
  colors.set(generated.stdout.subarray(i * 8 + 4, i * 8 + 7), i * 3);
}
const snapshot: SurfaceZoneSnapshot = { sampleSize: 1, zoneX: 16, zoneZ: 2, seed: 20260922, terrainGeneratorVersion: 2,
  sourceTerrainRevision: 0, zoneSizeChunks: 32, samplesPerChunkAxis: 16, heightsMicro,
  minHeightsMicro: heightsMicro.slice(), colors, colorErrors: new Uint8Array(count) };
const layers: Record<string, any> = {};
const times = { js: { selection: [] as number[], connections: [] as number[], total: [] as number[] },
  wasm: { selection: [] as number[], connections: [] as number[], total: [] as number[] } };
let reference: string | undefined;
for (const mode of ['js', 'wasm'] as const) {
  setTerrainKernelMode(mode);
  const layer = new DistantSurfaceLayer() as any;
  layer.setNearField(512, 64, 8);
  const camera = new THREE.PerspectiveCamera(75, 1.6, 0.1, 10000);
  camera.position.copy(bendPoint(8192, 100, 1024)); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  layer.updateView(camera, 1000); layer.installZone(snapshot); await layer.finalizeConnections();
  layers[mode] = layer;
}
try {
  for (let round = 0; round < 11; round++) {
    for (const mode of round % 2 ? ['wasm', 'js'] as const : ['js', 'wasm'] as const) {
      setTerrainKernelMode(mode);
      const layer = layers[mode];
      const append = layer.appendZone.bind(layer), connect = layer.rebuildConnections.bind(layer);
      let selection = 0, connections = 0;
      layer.appendZone = (...args: unknown[]) => { const start = performance.now(); append(...args); selection += performance.now() - start; };
      layer.rebuildConnections = () => { const start = performance.now(); connect(); connections += performance.now() - start; };
      const start = performance.now(); layer.rebuild(); const total = performance.now() - start;
      layer.appendZone = append; layer.rebuildConnections = connect;
      if (round >= 2) { times[mode].selection.push(selection); times[mode].connections.push(connections); times[mode].total.push(total); }
      const actual = digest([layer.mesh, layer.sideMesh]);
      reference ??= actual; assert.equal(actual, reference, 'LOD geometry changed');
    }
  }
  console.log(`Copper LOD: ${layers.wasm.mesh.geometry.instanceCount} tops, ${layers.wasm.sideMesh.geometry.instanceCount} sides (uncached rebuild)`);
  for (const stage of ['selection', 'connections', 'total'] as const) report(`LOD ${stage}`, times.js[stage], times.wasm[stage]);
} finally {
  for (const layer of Object.values(layers)) layer.setEnabled(false);
  setTerrainKernelMode('auto');
}
