import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { TerrainGenerator } from '../src/worldgen/TerrainGenerator.ts';
import type { Chunk } from '../src/voxel/Chunk.ts';
import { encodeVoxelLevels, generateVoxelSurfaceZone } from '../src/worldgen/VoxelSurfaceGenerator.ts';
import { getTerrainKernels, setTerrainKernelMode } from '../src/wasm/TerrainKernels.ts';

// Both paths use the same terrain generator backend. Only voxel LOD preparation
// switches JS/WASM. Includes packing, copies and wire output; excludes IPC/GPU.
class MeasuredGenerator extends TerrainGenerator {
  generationMs = 0;
  generateChunk(chunk: Chunk, includeDetails = true) {
    const previous = setTerrainKernelMode('wasm'), start = performance.now();
    try { return super.generateChunk(chunk, includeDetails); }
    finally {
      this.generationMs += performance.now() - start;
      setTerrainKernelMode(previous);
    }
  }
}

const versions = (process.argv.find(arg => arg.startsWith('--versions='))?.slice(11) ?? '2,3').split(',').map(Number);
const rounds = Number(process.argv.find(arg => arg.startsWith('--rounds='))?.slice(9) ?? 3);
assert.ok(versions.length && versions.every(v => Number.isInteger(v) && v >= 1 && v <= 8), 'versions must be 1..8');
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 9, 'rounds must be 1..9');
const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];
const names = ['', 'Nature', 'Copper', 'Aether', 'Colossus', 'Titan', 'Astral', 'Brutalist', 'Mixed'];
const previous = setTerrainKernelMode('wasm');
getTerrainKernels();
try {
  for (const version of versions) {
    const times = { js: { total: [] as number[], lod: [] as number[] }, wasm: { total: [] as number[], lod: [] as number[] } };
    let reference: string | undefined, faces = 0;
    for (let round = 0; round <= rounds; round++) {
      for (const mode of round % 2 ? ['wasm', 'js'] as const : ['js', 'wasm'] as const) {
        const generator = new MeasuredGenerator(42, version);
        setTerrainKernelMode(mode);
        const start = performance.now();
        const volume = generateVoxelSurfaceZone(generator, 16, 2);
        const total = performance.now() - start;
        if (round > 0) { times[mode].total.push(total); times[mode].lod.push(total - generator.generationMs); }
        const digest = createHash('sha256').update(volume.records).update(encodeVoxelLevels(volume.levels)).digest('hex');
        reference ??= digest;
        assert.equal(digest, reference, `${names[version]} voxel surface bytes changed (${mode}, round ${round})`);
        faces = volume.levels.reduce((n, level) => n + level.faces.length / 16, 0);
      }
    }
    const jsTotal = median(times.js.total), wasmTotal = median(times.wasm.total);
    const jsLod = median(times.js.lod), wasmLod = median(times.wasm.lod);
    console.log(JSON.stringify({ terrain: names[version], zone: [16, 2], seed: 42, samples: rounds, faces,
      totalMs: { js: +jsTotal.toFixed(2), wasm: +wasmTotal.toFixed(2), speedup: +(jsTotal / wasmTotal).toFixed(2) },
      lodPreparationMs: { js: +jsLod.toFixed(2), wasm: +wasmLod.toFixed(2), speedup: +(jsLod / wasmLod).toFixed(2) },
      sha256: reference }));
  }
} finally { setTerrainKernelMode(previous); }
