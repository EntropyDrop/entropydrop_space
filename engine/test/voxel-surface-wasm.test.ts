import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Chunk } from '../src/voxel/Chunk.ts';
import { TerrainGenerator } from '../src/worldgen/TerrainGenerator.ts';
import { encodeVoxelLevels, generateVoxelSurfaceZone, meshVoxelBrick, reduceVoxelBrick } from '../src/worldgen/VoxelSurfaceGenerator.ts';
import { getTerrainKernels, setTerrainKernelMode } from '../src/wasm/TerrainKernels.ts';
import type { VoxelSurfaceColumn } from '../src/wasm/VoxelSurfaceKernels.ts';

function referenceMips(source: Uint32Array, origin: number[]) {
  let data = source;
  const levels: Uint8Array[] = [];
  for (let axis = 64, size = 1; axis >= 1; axis /= 2, size *= 2) {
    const bytes = new Uint8Array(6 * data.length * 16), view = new DataView(bytes.buffer);
    let offset = 0;
    meshVoxelBrick(data, axis, size, origin, (x, y, z, w, h, dir, value) => {
      for (const [i, n] of [x, y, z, w, h].entries()) view.setUint16(offset + i * 2, n * 8, true);
      bytes.set([dir, value >>> 24 & 1, value >>> 16 & 255, value >>> 8 & 255, value & 255, 0], offset + 10);
      offset += 16;
    });
    levels.push(bytes.slice(0, offset));
    if (axis > 1) data = reduceVoxelBrick(data, axis);
  }
  return levels;
}

function addBrick(column: VoxelSurfaceColumn, data: Uint32Array, by: number) {
  const chunk = new Chunk(0, 0, null);
  for (let cx = 0; cx < 4; cx++) for (let cz = 0; cz < 4; cz++) {
    chunk.resetForTerrainGeneration();
    let low = 256, high = -1;
    for (let y = 0; y < 64; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const value = data[cx * 16 + x + y * 64 + (cz * 16 + z) * 4096];
      if (!value) continue;
      const wy = by * 64 + y, at = Chunk.getIndex(x, wy, z);
      chunk.blocks[at] = 1; chunk.colors[at] = value & 0xffffff; chunk.materials[at] = value >>> 24 & 1;
      low = Math.min(low, wy); high = Math.max(high, wy);
    }
    chunk.setGeneratedOccupiedYRange(low, high);
    column.addChunk(chunk, cx, cz);
    // The terrain generator and other callers reuse the shared scratch arena.
    getTerrainKernels()!.reduceSurfaceRecords(new Uint8Array(32), 2);
  }
}

for (const shape of ['slabs', 'checkerboard', 'random'] as const) {
  test(`volumetric WASM preserves all seven packed mips for ${shape}`, () => {
    const previous = setTerrainKernelMode('wasm');
    try {
      const data = new Uint32Array(64 ** 3);
      let random = 42;
      for (let z = 0; z < 64; z++) for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const at = x + y * 64 + z * 4096;
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        if (shape === 'slabs' && [0, 1, 12, 63].includes(y) && (x < 24 || z > 32)) {
          data[at] = x < 8 ? 0x80000000 : x < 16 ? 0x81010203 : 0x80020304;
        } else if (shape === 'checkerboard' && (x + y + z) % 2 === 0) data[at] = 0x81123456;
        else if (shape === 'random' && random % 7 < 3) data[at] = (0x80000000 | (random & 0x1ffffff)) >>> 0;
      }
      const column = getTerrainKernels()!.createVoxelSurfaceColumn();
      const by = 3;
      addBrick(column, data, by);
      const expected = referenceMips(data, [448, 192, 448]);
      const actual = column.meshBrick(by, 448, 448)!;
      assert.deepEqual(actual, expected);
      if (shape === 'checkerboard') assert.equal(actual[0].length / 16, 64 ** 3 / 2 * 6);
      const records = column.surfaceRecords(), view = new DataView(records.buffer);
      for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) {
        const occupied = Array.from({ length: 64 }, (_, y) => y).filter(y => data[x + y * 64 + z * 4096]);
        const high = occupied.at(-1), at = (x * 64 + z) * 8;
        assert.equal(view.getUint16(at, true), high === undefined ? 0 : (high + 193) * 8);
        assert.equal(view.getUint16(at + 2, true), high === undefined ? 0 : (occupied[0] + 192) * 8);
        const color = high === undefined ? 0 : data[x + high * 64 + z * 4096];
        assert.deepEqual([...records.subarray(at + 4, at + 8)], [color >>> 16 & 255, color >>> 8 & 255, color & 255, 0]);
      }
      column.reset();
      assert.equal(column.meshBrick(3, 0, 0), null);
      assert.ok(column.surfaceRecords().every(value => value === 0));
      assert.deepEqual(actual, expected, 'reset and subsequent calls cannot overwrite returned faces');
      assert.ok(records.some(Boolean), 'returned records survive reset');
    } finally { setTerrainKernelMode(previous); }
  });
}

test('voxel columns preserve solid precedence, micro order across batches, emission ties and independent sessions', () => {
  const previous = setTerrainKernelMode('wasm');
  try {
    const kernel = getTerrainKernels()!, column = kernel.createVoxelSurfaceColumn(), other = kernel.createVoxelSurfaceColumn();
    const chunk = new Chunk(0, 0, null);
    chunk.setLocalBlock(0, 0, 0, 1, 0);
    const details = [0, 0, 0, 0xffffff]; // Cannot replace the occupied black standard voxel.
    for (let i = 0; i < 4096; i++) details.push(8, 0, 0, 0x01010203);
    details.push(9, 0, 0, 0xffffff, 127, 2047, 127, 0x01fedcba);
    chunk.terrainDetails = Uint32Array.from(details);
    column.addChunk(chunk, 3, 3);
    const expected = new Uint32Array(64 ** 3);
    expected[48 + 48 * 4096] = 0x80000000;
    expected[49 + 48 * 4096] = 0x81010203;
    const first = column.meshBrick(0, 0, 0)!;
    assert.deepEqual(first, referenceMips(expected, [0, 0, 0]));
    other.addChunk(chunk, 0, 0);
    other.meshBrick(3, 64, 128); other.reset();
    assert.deepEqual(column.meshBrick(0, 0, 0), first);
    expected.fill(0); expected[63 + 63 * 64 + 63 * 4096] = 0x81fedcba;
    assert.deepEqual(column.meshBrick(3, 0, 0), referenceMips(expected, [0, 192, 0]));
    assert.equal(column.meshBrick(1, 0, 0), null);
    assert.throws(() => column.addChunk(chunk, 4, 0), /Invalid voxel surface chunk/);
    assert.throws(() => column.meshBrick(4, 0, 0), /Invalid voxel surface brick/);
    assert.throws(() => column.meshBrick(0, 449, 0), /Invalid voxel surface brick/);
    chunk.terrainDetails = new Uint32Array([128, 0, 0, 1]);
    assert.throws(() => other.addChunk(chunk, 0, 0), /Invalid voxel surface micro cell/);
  } finally { setTerrainKernelMode(previous); }
});

class FixtureGenerator extends TerrainGenerator {
  generateChunk(chunk: Chunk) {
    chunk.resetForTerrainGeneration();
    if ((Math.floor(chunk.cx / 4) + Math.floor(chunk.cz / 4)) % 2 === 0) {
      chunk.setLocalBlock(0, 0, 0, 1, 0);
      chunk.setLocalBlock(15, 63, 15, 1, 0x010203, 1);
      chunk.setLocalBlock(0, 64, 0, 1, 0xff8000);
      chunk.setLocalBlock(15, 255, 15, 1, 0x102030);
      chunk.terrainDetails = new Uint32Array([0, 0, 0, 0xffffff, 8, 800, 8, 0x01112233, 9, 800, 9, 0xffffff]);
    }
    chunk.hasGenerated = true;
    return chunk.terrainDetails;
  }
}

test('complete voxel zones preserve record layout, VXL7 wire bytes and progress through occupied and empty columns', () => {
  const previous = setTerrainKernelMode('js');
  try {
    const referenceProgress: number[] = [], actualProgress: number[] = [];
    const expected = generateVoxelSurfaceZone(new FixtureGenerator(), 31, 3, n => referenceProgress.push(n));
    setTerrainKernelMode('wasm');
    const actual = generateVoxelSurfaceZone(new FixtureGenerator(), 31, 3, n => {
      actualProgress.push(n);
      getTerrainKernels()!.reduceSurfaceRecords(new Uint8Array(32), 2);
    });
    assert.deepEqual(actual.records, expected.records);
    assert.deepEqual(encodeVoxelLevels(actual.levels), encodeVoxelLevels(expected.levels));
    assert.deepEqual(actualProgress, referenceProgress);
    assert.deepEqual(actualProgress, Array.from({ length: 64 }, (_, i) => i + 1));
  } finally { setTerrainKernelMode(previous); }
});

test('voxel zone generation falls back when WebAssembly is unavailable', () => {
  const surface = new URL('../src/worldgen/VoxelSurfaceGenerator.ts', import.meta.url).href;
  const kernels = new URL('../src/wasm/TerrainKernels.ts', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { generateVoxelSurfaceZone } = await import(${JSON.stringify(surface)});
    const { setTerrainKernelMode } = await import(${JSON.stringify(kernels)});
    const generator = { generateChunk(chunk) { chunk.resetForTerrainGeneration(); } };
    setTerrainKernelMode('js');
    const expected = generateVoxelSurfaceZone(generator, 0, 0);
    globalThis.WebAssembly = undefined;
    setTerrainKernelMode('auto');
    assert.deepEqual(generateVoxelSurfaceZone(generator, 0, 0), expected);
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.split('Terrain WASM unavailable').length - 1, 1);
});
