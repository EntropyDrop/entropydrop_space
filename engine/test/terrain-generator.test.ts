import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainGenerator } from '../src/worldgen/TerrainGenerator.ts';
import { Chunk } from '../src/voxel/Chunk.ts';
import {
  TORUS_SIZE_X,
  TORUS_SIZE_Z,
  TORUS_GREF,
  TORUS_SPAWN_X,
  TORUS_SPAWN_Z
} from '../src/torus/TorusWorld.ts';

test('torus terrain stays within a gentle ±5 m band with low one-block roughness', () => {
  const terrain = new TerrainGenerator(1337);
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  let maxStep = 0;
  let totalStep = 0;
  let stepCount = 0;

  for (let x = 0; x < TORUS_SIZE_X; x += 64) {
    for (let z = 0; z < TORUS_SIZE_Z; z += 32) {
      const height = terrain.sampleHeight(x, z);
      const stepX = Math.abs(terrain.sampleHeight(x + 1, z) - height);
      const stepZ = Math.abs(terrain.sampleHeight(x, z + 1) - height);
      minHeight = Math.min(minHeight, height);
      maxHeight = Math.max(maxHeight, height);
      maxStep = Math.max(maxStep, stepX, stepZ);
      totalStep += stepX + stepZ;
      stepCount += 2;
    }
  }

  assert.ok(minHeight >= TORUS_GREF - 5, `minimum height ${minHeight}`);
  assert.ok(maxHeight <= TORUS_GREF + 5, `maximum height ${maxHeight}`);
  assert.ok(maxStep <= 2, `maximum adjacent step ${maxStep}`);
  assert.ok(totalStep / stepCount < 0.35, `mean adjacent step ${totalStep / stepCount}`);
});

test('spawn pad remains flat at the torus reference height', () => {
  const terrain = new TerrainGenerator(1337);
  for (let dx = -8; dx <= 8; dx += 4) {
    for (let dz = -8; dz <= 8; dz += 4) {
      assert.equal(
        terrain.sampleHeight(TORUS_SPAWN_X + dx, TORUS_SPAWN_Z + dz),
        TORUS_GREF
      );
    }
  }
});

test('Copper Metropolis generates deterministic dense architecture around spawn', () => {
  const generate = (seed: number) => {
    const chunk = new Chunk(TORUS_SPAWN_X / 16, TORUS_SPAWN_Z / 16, null);
    new TerrainGenerator(seed, 2).generateChunk(chunk);
    return chunk;
  };
  const first = generate(20260922);
  const repeated = generate(20260922);
  const changed = generate(71293);

  assert.deepEqual(first.blocks, repeated.blocks);
  assert.deepEqual(first.colors, repeated.colors);
  assert.deepEqual(first.terrainDetails, repeated.terrainDetails);
  assert.notDeepEqual(first.colors, changed.colors);
  assert.ok(first.terrainDetails.length / 4 > 1000);
  assert.ok(first.terrainDetails.some((value, index) => index % 4 < 3 && value % 8 !== 0));
  const headless = new Chunk(TORUS_SPAWN_X / 16, TORUS_SPAWN_Z / 16, null);
  new TerrainGenerator(20260922, 2).generateChunk(headless, false);
  assert.equal(headless.terrainDetails.length, 0);
  assert.deepEqual(headless.blocks, first.blocks);
  assert.ok((first.getOccupiedYRange()?.max ?? 0) > 70);
  assert.ok(new Set(first.colors.filter((_, index) => first.blocks[index] !== 0)).size >= 8);
});

test('Copper city has broad landmarks, distinct neighbourhoods and a calm distant skyline', () => {
  const grassMaps: Uint8Array[] = [];
  const size = 512;
  for (const seed of [42, 20260922]) {
    const terrain = new TerrainGenerator(seed, 2);
    const heights = new Uint8Array(size * size), grassMap = new Uint8Array(size * size);
    let low = 0, medium = 0, tall = 0, grass = 0, paths = 0, trunks = 0;
    for (let cz = 0; cz < size / 16; cz++) for (let cx = 0; cx < size / 16; cx++) {
      const chunk = new Chunk(TORUS_SPAWN_X / 16 - 8 + cx, TORUS_SPAWN_Z / 16 - 8 + cz, null);
      terrain.generateChunk(chunk, false);
      for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        const index = x + cx * 16 + (z + cz * 16) * size;
        const ground = chunk.colors[Chunk.getIndex(x, 1, z)];
        if (ground === 0x66834b) {
          grass++; grassMap[index] = 1;
          if (chunk.colors[Chunk.getIndex(x, 2, z)] === 0x68543e) trunks++;
        }
        if (ground === 0xe3d2a2) paths++;
        let top = 255;
        while (top >= 0 && chunk.blocks[Chunk.getIndex(x, top, z)] === 0) top--;
        heights[index] = top;
        if (top < 12) continue;
        if (top < 35) low++;
        else if (top < 75) medium++;
        else tall++;
      }
    }
    const identity = `seed=${seed}`;
    assert.ok(low > 10000 && medium > 10000 && tall > 2500, `all building scales: ${identity}`);
    assert.ok(grass > 5000 && grass < 60000 && paths > 2000 && trunks > 100, `city parks: ${identity}`);
    let abrupt = 0, neighbours = 0;
    for (let z = 16; z < size; z += 16) for (let x = 16; x < size; x += 16) {
      const a = heights[x + z * size], b = heights[x - 16 + z * size];
      if (a < 12 || b < 12) continue;
      neighbours++;
      if (Math.abs(a - b) > 35) abrupt++;
    }
    assert.ok(abrupt / neighbours < 0.15, `avoid alternating tall/short needles: ${identity}`);
    const neighbourhoods: number[] = [];
    for (let cz = 0; cz < 4; cz++) for (let cx = 0; cx < 4; cx++) {
      let sum = 0;
      for (let z = cz * 128; z < (cz + 1) * 128; z++) {
        for (let x = cx * 128; x < (cx + 1) * 128; x++) sum += heights[x + z * size];
      }
      neighbourhoods.push(sum / 16384);
    }
    assert.ok(Math.max(...neighbourhoods) - Math.min(...neighbourhoods) > 25, `distinct district silhouettes: ${identity}`);
    // Exact 48m squares of occupied roofscape distinguish large structures
    // from the previous uniformly small lots. Road gaps cannot pass this test.
    const stride = size + 1, occupied = new Uint32Array(stride * stride);
    for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
      const at = x + 1 + (z + 1) * stride;
      occupied[at] = (heights[x + z * size] >= 12 ? 1 : 0)
        + occupied[at - 1] + occupied[at - stride] - occupied[at - stride - 1];
    }
    let largeFootprints = 0;
    for (let z = 0; z <= size - 48; z += 8) for (let x = 0; x <= size - 48; x += 8) {
      const count = occupied[x + 48 + (z + 48) * stride] - occupied[x + (z + 48) * stride]
        - occupied[x + 48 + z * stride] + occupied[x + z * stride];
      if (count === 48 * 48) largeFootprints++;
    }
    assert.ok(largeFootprints > 4, `wide halls and complexes: ${identity}`);
    grassMaps.push(grassMap);
  }
  assert.notDeepEqual(grassMaps[0], grassMaps[1], 'city layout and parks change with the seed');
});

test('unknown terrain versions retain the nature generator', () => {
  const nature = new TerrainGenerator(1337, 1);
  const unknown = new TerrainGenerator(1337, 999);
  assert.equal(
    unknown.sampleHeight(TORUS_SPAWN_X + 64, TORUS_SPAWN_Z + 32),
    nature.sampleHeight(TORUS_SPAWN_X + 64, TORUS_SPAWN_Z + 32),
  );
});
