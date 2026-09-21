import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { TerrainGenerator } from '../src/worldgen/TerrainGenerator.ts';
import { Chunk } from '../src/voxel/Chunk.ts';
import { buildMipPyramid } from '../src/render/DistantSurfaceLayer.ts';
import { getTerrainKernels, setTerrainKernelMode } from '../src/wasm/TerrainKernels.ts';
import { TERRAIN_KERNEL_BASE64 } from '../src/wasm/TerrainKernelBinary.ts';
import type { SurfaceZoneSnapshot } from '../src/voxel/SurfaceZoneSnapshot.ts';

test('browser and Python ship identical, import-free WASM with the expected ABI', () => {
  const bytes = Buffer.from(TERRAIN_KERNEL_BASE64, 'base64');
  assert.deepEqual(bytes, readFileSync(new URL('../../server/space/terrain-kernels.wasm', import.meta.url)));
  const module = new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal((new WebAssembly.Instance(module).exports.abiVersion as () => number)(), 1);
});

test('WASM initialization failure falls back without preventing terrain generation', () => {
  const module = new URL('../src/wasm/TerrainKernels.ts', import.meta.url).href;
  const generator = new URL('../src/worldgen/TerrainGenerator.ts', import.meta.url).href;
  const chunk = new URL('../src/voxel/Chunk.ts', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { getTerrainKernels, setTerrainKernelMode } = await import(${JSON.stringify(module)});
    const { TerrainGenerator } = await import(${JSON.stringify(generator)});
    const { Chunk } = await import(${JSON.stringify(chunk)});
    // Load Node's own TS stripper (also WASM) before disabling the host feature.
    globalThis.WebAssembly = undefined;
    setTerrainKernelMode('auto');
    assert.equal(getTerrainKernels(), null);
    assert.equal(getTerrainKernels(), null);
    const result = new Chunk(512, 64, null);
    new TerrainGenerator(20260922, 2).generateChunk(result);
    assert.ok(result.terrainDetails.length > 0);
    setTerrainKernelMode('wasm');
    assert.throws(getTerrainKernels);
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.split('Terrain WASM unavailable').length - 1, 1);
});

for (const version of [1, 2]) test(`WASM terrain v${version} exactly matches JS solids, colors, bounds and world micro cells`, () => {
  const previous = setTerrainKernelMode('wasm');
  try {
    const coordinates = [[0, 0], [1023, 127], [0, 127], [1023, 0], [512, 64], [511, 63],
      [510, 65], [515, 61], [507, 62], [450, 100], [256, 32], [517, 70]];
    for (const seed of [0, 42, 1337, 71293, 20260922, 2147483647]) {
      const generator = new TerrainGenerator(seed, version);
      for (const [cx, cz] of coordinates) for (const details of version === 2 ? [true, false] : [false]) {
        const reference = new Chunk(cx, cz, null), actual = new Chunk(cx, cz, null);
        setTerrainKernelMode('js'); generator.generateChunk(reference, details);
        setTerrainKernelMode('wasm'); generator.generateChunk(actual, details);
        const identity = `seed=${seed} chunk=${cx},${cz} details=${details}`;
        assert.deepEqual(actual.blocks, reference.blocks, identity);
        assert.deepEqual(actual.colors, reference.colors, identity);
        assert.deepEqual(actual.materials, reference.materials, identity);
        assert.deepEqual(actual.terrainDetails, reference.terrainDetails, identity);
        assert.deepEqual(actual.getOccupiedYRange(), reference.getOccupiedYRange(), identity);
        // Reusing chunk arrays must clear earlier paint and micro cells as well.
        generator.generateChunk(actual, false);
        assert.equal(actual.terrainDetails.length, 0);
        assert.deepEqual(actual.blocks, reference.blocks, identity);
      }
    }
  } finally { setTerrainKernelMode(previous); }
});

for (const sampleSize of [undefined, 1, 2, 4, 8, 16, 32, 64]) {
  test(`WASM LOD matches JS including linear color/errors, residuals and legacy order (${sampleSize})`, () => {
    const count = (512 / (sampleSize ?? 2)) ** 2;
    const heightsMicro = new Uint16Array(count), colors = new Uint8Array(count * 3);
    const minHeightsMicro = new Uint16Array(count), colorErrors = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      heightsMicro[i] = i % 5 ? (i * 173 % 2049) : 0;
      minHeightsMicro[i] = Math.max(0, heightsMicro[i] - (i * 37 % 100));
      colorErrors[i] = i * 13 % 256;
      colors.set([i * 11 % 256, i * 3 % 256, i * 17 % 256], i * 3);
    }
    const zone: SurfaceZoneSnapshot = { sampleSize, zoneX: 31, zoneZ: 3, seed: 42,
      terrainGeneratorVersion: 2, sourceTerrainRevision: 89, zoneSizeChunks: 32,
      samplesPerChunkAxis: 16, heightsMicro, colors,
      ...(sampleSize === undefined ? {} : { minHeightsMicro, colorErrors }),
    };
    const previous = setTerrainKernelMode('js');
    try {
      const expected = buildMipPyramid(zone);
      setTerrainKernelMode('wasm');
      const actual = buildMipPyramid(zone);
      assert.deepEqual(actual, expected);
      buildMipPyramid({ ...zone, heightsMicro: new Uint16Array(count) });
      assert.deepEqual(actual, expected, 'later arena calls cannot overwrite installed mips');
    } finally { setTerrainKernelMode(previous); }
  });
}

test('packed surface reduction preserves first peak, minima and saturated conservative error', () => {
  const previous = setTerrainKernelMode('wasm');
  try {
    const bytes = Uint8Array.from([
      136, 0, 120, 0, 10, 20, 30, 2, 136, 0, 100, 0, 255, 20, 30, 20,
      100, 0, 80, 0, 10, 20, 30, 1, 120, 0, 96, 0, 10, 20, 30, 0,
    ]);
    assert.deepEqual(getTerrainKernels()!.reduceSurfaceRecords(bytes, 2),
      Uint8Array.from([136, 0, 80, 0, 10, 20, 30, 255]));
    assert.throws(() => getTerrainKernels()!.reduceSurfaceRecords(bytes, 512), /lattice/);
  } finally { setTerrainKernelMode(previous); }
});
