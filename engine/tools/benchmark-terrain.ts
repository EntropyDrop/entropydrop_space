import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TerrainGenerator } from '../src/worldgen/TerrainGenerator.ts';
import { Chunk } from '../src/voxel/Chunk.ts';
import { buildMipPyramid } from '../src/render/DistantSurfaceLayer.ts';
import { getTerrainKernels, setTerrainKernelMode } from '../src/wasm/TerrainKernels.ts';
import type { SurfaceZoneSnapshot } from '../src/voxel/SurfaceZoneSnapshot.ts';

// End-to-end CPU calls, including arena input/output copies. Not GPU frame time.
const started = performance.now();
setTerrainKernelMode('wasm');
getTerrainKernels();
console.log(`WASM cold initialization: ${(performance.now() - started).toFixed(3)} ms`);

function benchmark(name: string, run: () => void, iterations: number) {
  const times = { js: [] as number[], wasm: [] as number[] };
  for (let round = 0; round < 11; round++) {
    for (const mode of round % 2 ? ['wasm', 'js'] as const : ['js', 'wasm'] as const) {
      setTerrainKernelMode(mode);
      const start = performance.now();
      for (let i = 0; i < iterations; i++) run();
      if (round > 1) times[mode].push((performance.now() - start) / iterations);
    }
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1];
  const js = median(times.js), wasm = median(times.wasm);
  console.log(`${name}: JS ${js.toFixed(3)} ms -> WASM ${wasm.toFixed(3)} ms (${(js / wasm).toFixed(2)}x)`);
}

for (const [name, version, details] of [
  ['Nature chunk', 1, false], ['Copper chunk + world micro', 2, true], ['Copper surface chunk', 2, false],
] as const) {
  const generator = new TerrainGenerator(20260922, version);
  const chunks = Array.from({ length: 16 }, (_, i) => new Chunk(510 + i % 4, 62 + (i >> 2), null));
  let index = 0;
  benchmark(name, () => { generator.generateChunk(chunks[index++ % chunks.length], details); }, 100);
}
const count = 512 ** 2;
const zone: SurfaceZoneSnapshot = {
  sampleSize: 1, zoneX: 16, zoneZ: 2, seed: 42, terrainGeneratorVersion: 2,
  sourceTerrainRevision: 0, zoneSizeChunks: 32, samplesPerChunkAxis: 16,
  heightsMicro: Uint16Array.from({ length: count }, (_, i) => 100 + i % 800),
  colors: Uint8Array.from({ length: count * 3 }, (_, i) => i * 11 % 256),
  minHeightsMicro: Uint16Array.from({ length: count }, (_, i) => 80 + i % 800),
  colorErrors: Uint8Array.from({ length: count }, (_, i) => i % 64),
};
benchmark('512x512 surface LOD pyramid', () => { buildMipPyramid(zone); }, 10);
setTerrainKernelMode('auto');

if (process.argv.includes('--server-zone')) {
  const script = fileURLToPath(new URL('../../server/space/runtime/dist/terrain-surface.mjs', import.meta.url));
  const times = { js: [] as number[], wasm: [] as number[] };
  let reference: Buffer | undefined;
  for (let round = 0; round < 5; round++) for (const mode of ['js', 'wasm'] as const) {
    const start = performance.now();
    const result = spawnSync(process.execPath, [script, 'zone', '20260922', '2', '16', '2'], {
      env: { ...process.env, SPACE_TERRAIN_BACKEND: mode }, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(result.stderr.toString());
    times[mode].push(performance.now() - start);
    reference ??= result.stdout;
    if (!reference.equals(result.stdout)) throw new Error('Copper zone output mismatch');
  }
  const js = times.js.sort((a, b) => a - b)[2], wasm = times.wasm.sort((a, b) => a - b)[2];
  console.log(`Server Copper 512x512 zone (including Node startup): JS ${js.toFixed(3)} ms -> WASM ${wasm.toFixed(3)} ms (${(js / wasm).toFixed(2)}x)`);
}
