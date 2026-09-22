import test from 'node:test';
import assert from 'node:assert/strict';
import { Chunk } from '../src/voxel/Chunk.ts';
import { TerrainGenerator, TERRAIN_GENERATOR_MIXED } from '../src/worldgen/TerrainGenerator.ts';
import { generateMixedRegion, sampleMixedBiomes, sampleMixedGroundHeight, mixedBiomeSite, mixedFeatureFits } from '../src/worldgen/MixedBiomeGenerator.ts';
import { terrainLabSpawnAnchor } from '../src/worldgen/TerrainLabGenerator.ts';
import { BRUTALIST_DUSK_DEFAULTS, generateBrutalistDuskRegion } from '../src/worldgen/BrutalistDuskGenerator.ts';
import { HARBOR_DEFAULTS, generateHarborRegion } from '../src/worldgen/ColossusHarborGenerator.ts';
import { CANYON_DEFAULTS, generateCanyonRegion } from '../src/worldgen/TitanCanyonGenerator.ts';
import { FOUNDRY_DEFAULTS, generateFoundryRegion } from '../src/worldgen/AstralFoundryGenerator.ts';
import { AETHER_DEFAULTS, generateAetherRegion, aetherSpawnAnchor } from '../src/worldgen/AetherArchipelagoGenerator.ts';

const config = { seed: 42, sizeX: 32, sizeZ: 32, sizeY: 256, yCutoff: 256, offsetX: 0, offsetZ: 0 };
const microMap = (details: Uint32Array) => {
  const result = new Map<string, number>();
  for (let i = 0; i < details.length; i += 4) {
    const [x, y, z, value] = details.subarray(i, i + 4); result.set(`${x},${y},${z}`, value);
  }
  return result;
};

test('Mixed: five populated biome cores retain terrain-lab solids and micro details', () => {
  for (let biome = 0; biome < 5; biome++) {
    const site = mixedBiomeSite(42, biome, 0);
    assert.deepEqual(sampleMixedBiomes(42, site.x, site.z).map(e => [e.site.biome, e.weight]), [[biome, 1]]);
    const mixed = generateMixedRegion({ ...config, offsetX: site.x, offsetZ: site.z });
    const a = biome === 4 ? aetherSpawnAnchor(site.seed) : terrainLabSpawnAnchor(site.seed, [7, 4, 5, 6][biome]);
    const sourceConfig = { ...config, seed: site.seed, offsetX: a.x, offsetZ: a.z };
    let source;
    if (biome === 0) source = generateBrutalistDuskRegion({ ...sourceConfig, ...BRUTALIST_DUSK_DEFAULTS });
    if (biome === 1) source = generateHarborRegion({ ...sourceConfig, ...HARBOR_DEFAULTS });
    if (biome === 2) source = generateCanyonRegion({ ...sourceConfig, ...CANYON_DEFAULTS });
    if (biome === 3) source = generateFoundryRegion({ ...sourceConfig, ...FOUNDRY_DEFAULTS });
    if (biome === 4) {
      const r = generateAetherRegion({ ...sourceConfig, ...AETHER_DEFAULTS });
      source = { voxels: Uint32Array.from(r.cells, id => id ? (0x80000000 | r.palette[id].color | (r.palette[id].emission > 0 ? 1 << 24 : 0)) >>> 0 : 0), details: r.details };
    }
    assert.deepEqual(mixed.voxels, source.voxels);
    assert.deepEqual(microMap(mixed.details), microMap(source.details));
    assert.ok(mixed.voxels.filter(Boolean).length > 1024 && mixed.details.length > 0);
    assert.deepEqual(generateMixedRegion({ ...config, offsetX: site.x, offsetZ: site.z }, false).voxels, mixed.voxels);
    for (let i = 0; i < mixed.details.length; i += 4) {
      const [x, y, z, value] = mixed.details.subarray(i, i + 4);
      assert.ok(x < 256 && z < 256 && y < 2048 && value >>> 24 <= 1);
      assert.equal(mixed.voxels[(x >> 3) + (z >> 3) * 32 + (y >> 3) * 1024], 0);
    }
  }
});

test('Mixed: normalized, smoothly varying biome weights wrap around both torus seams', () => {
  const seen = new Set<number>();
  for (let z = -1024; z < 1024; z += 64) for (let x = -8192; x < 8192; x += 64) {
    const entries = sampleMixedBiomes(42, x, z), next = sampleMixedBiomes(42, x + 1, z);
    assert.ok(Math.abs(entries.reduce((n, e) => n + e.weight, 0) - 1) < 1e-12);
    for (const e of entries) {
      seen.add(e.site.biome);
      assert.ok(Math.abs(e.weight - (next.find(n => n.site.id === e.site.id)?.weight ?? 0)) < 0.02);
    }
    assert.deepEqual(entries.map(e => [e.site.id, e.weight]), sampleMixedBiomes(42, x + 16384, z + 2048).map(e => [e.site.id, e.weight]));
  }
  assert.equal(seen.size, 5);
  assert.notDeepEqual(sampleMixedBiomes(42, 500, 0), sampleMixedBiomes(43, 500, 0));
});

test('Mixed: border slopes are continuous ground, with blended colours and no sliced towers', () => {
  const r = generateMixedRegion({ ...config, offsetX: 500, offsetZ: 0 });
  let changes = 0;
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
    const h = Math.round(sampleMixedGroundHeight(42, 484 + x, -16 + z));
    for (let y = 0; y < 256; y++) assert.equal(Boolean(r.voxels[x + z * 32 + y * 1024]), y < h);
    const previous = sampleMixedGroundHeight(42, 483 + x, -16 + z);
    assert.ok(Math.abs(h - previous) < 2, 'no vertical wall at a biome boundary');
    if (x > 0 && r.voxels[x + z * 32] !== r.voxels[x - 1 + z * 32]) changes++;
  }
  assert.ok(changes > 128, 'colour blends per column across the transition');
  assert.equal(r.details.length, 0, 'no unsupported facade scraps in the shared slope');
  assert.ok(sampleMixedBiomes(42, -6688, -640).length >= 3, 'three-way biome junction');
});

test('Mixed: complete footprints stay inside their allowed biome even along curved boundaries', () => {
  let accepted = 0, rejected = 0, islandTransitions = 0;
  for (let biome = 0; biome < 5; biome++) {
    const site = mixedBiomeSite(42, biome, 0);
    for (let dz = -500; dz <= 500; dz += 100) for (let dx = -500; dx <= 500; dx += 100) for (const radius of [15, 60, 100]) {
      const x = site.x + dx, z = site.z + dz;
      if (!mixedFeatureFits(42, site, x, z, radius)) { rejected++; continue; }
      accepted++;
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 16) {
        const entry = sampleMixedBiomes(42, x + Math.cos(angle) * radius, z + Math.sin(angle) * radius).find(e => e.site.id === site.id);
        assert.ok(entry && (biome === 4 ? entry.weight > 0 : entry.weight === 1), 'whole footprint fits without clipping');
        if (biome === 4 && entry!.weight < 1) islandTransitions++;
      }
    }
  }
  assert.ok(accepted > 50 && rejected > 50 && islandTransitions > 0);
});

test('Mixed: independent chunks agree across boundaries, three-way junctions and world seams', () => {
  for (const [offsetX, offsetZ] of [[500, 0], [1500, 0], [2500, 0], [3660, 0], [-6688, -640], [8192, 1024], [0, 1024]]) {
    const cfg = { ...config, offsetX, offsetZ }, whole = generateMixedRegion(cfg), micros = microMap(whole.details);
    let microCount = 0;
    for (let cz = 0; cz < 2; cz++) for (let cx = 0; cx < 2; cx++) {
      const part = generateMixedRegion({ ...cfg, sizeX: 16, sizeZ: 16, offsetX: offsetX - 8 + cx * 16, offsetZ: offsetZ - 8 + cz * 16 });
      for (let y = 0; y < 256; y++) for (let z = 0; z < 16; z++) {
        const index = cx * 16 + (z + cz * 16) * 32 + y * 1024;
        assert.deepEqual(part.voxels.subarray(z * 16 + y * 256, z * 16 + y * 256 + 16), whole.voxels.subarray(index, index + 16));
      }
      for (let i = 0; i < part.details.length; i += 4) {
        const [x, y, z, value] = part.details.subarray(i, i + 4);
        assert.equal(micros.get(`${x + cx * 128},${y},${z + cz * 128}`), value); microCount++;
      }
    }
    assert.equal(microCount, micros.size);
    const wrapped = generateMixedRegion({ ...cfg, offsetX: offsetX + 16384, offsetZ: offsetZ + 2048 });
    assert.deepEqual(whole.voxels, wrapped.voxels);
    assert.deepEqual(micros, microMap(wrapped.details));
  }
});

test('Mixed: playable spawn, deterministic generation and headless collision parity', () => {
  for (const seed of [42, 73451, 20260922]) {
    const generator = new TerrainGenerator(seed, TERRAIN_GENERATOR_MIXED), chunk = new Chunk(512, 64, null), wrapped = new Chunk(1536, 192, null);
    generator.generateChunk(chunk); generator.generateChunk(wrapped);
    assert.equal(generator.version, 8);
    assert.deepEqual(chunk.blocks, wrapped.blocks); assert.deepEqual(chunk.colors, wrapped.colors);
    assert.deepEqual(chunk.materials, wrapped.materials); assert.deepEqual(chunk.terrainDetails, wrapped.terrainDetails);
    generator.generateChunk(wrapped, false);
    assert.deepEqual(chunk.blocks, wrapped.blocks); assert.deepEqual(chunk.colors, wrapped.colors);
    assert.deepEqual(chunk.materials, wrapped.materials); assert.equal(wrapped.terrainDetails.length, 0);
    assert.ok(chunk.blocks[Chunk.getIndex(0, 1, 0)] && !chunk.blocks[Chunk.getIndex(0, 219, 0)]);
    assert.ok(chunk.terrainDetails.length > 0);
  }
});
