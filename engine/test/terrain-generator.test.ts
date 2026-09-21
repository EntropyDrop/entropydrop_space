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

test('unknown terrain versions retain the nature generator', () => {
  const nature = new TerrainGenerator(1337, 1);
  const unknown = new TerrainGenerator(1337, 999);
  assert.equal(
    unknown.sampleHeight(TORUS_SPAWN_X + 64, TORUS_SPAWN_Z + 32),
    nature.sampleHeight(TORUS_SPAWN_X + 64, TORUS_SPAWN_Z + 32),
  );
});
