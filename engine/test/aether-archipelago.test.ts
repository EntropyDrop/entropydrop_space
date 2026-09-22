import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainGenerator } from '../src/worldgen/TerrainGenerator.ts';
import { AETHER_DEFAULTS, generateAetherRegion, aetherSpawnAnchor } from '../src/worldgen/AetherArchipelagoGenerator.ts';
import { Chunk } from '../src/voxel/Chunk.ts';

const config = { ...AETHER_DEFAULTS, seed: 42, sizeX: 64, sizeZ: 64,
  sizeY: 256, yCutoff: 256, offsetX: -134, offsetZ: -11 };

test('Aether preserves mixed sizes, emissions, solid interiors and floating air', () => {
  const generator = new TerrainGenerator(42, 3), chunk = new Chunk(512, 64, null);
  generator.generateChunk(chunk);
  const repeated = new Chunk(512, 64, null);
  generator.generateChunk(repeated);
  assert.equal(generator.version, 3);
  assert.deepEqual(chunk.blocks, repeated.blocks);
  assert.deepEqual(chunk.colors, repeated.colors);
  assert.deepEqual(chunk.materials, repeated.materials);
  assert.deepEqual(chunk.terrainDetails, repeated.terrainDetails);
  assert.ok(chunk.blocks.filter(Boolean).length > 10000, 'retain island and building interiors');
  assert.ok(chunk.blocks.slice(0, 256 * 2).every(value => !value), 'no ground plane');
  assert.ok(chunk.terrainDetails.length > 4000);
  const materials = new Set<number>();
  for (let i = 0; i < chunk.terrainDetails.length; i += 4) {
    const [mx, my, mz, packed] = chunk.terrainDetails.slice(i, i + 4);
    assert.ok(mx < 128 && mz < 128 && my < 2048);
    assert.equal(chunk.blocks[Chunk.getIndex(mx >> 3, my >> 3, mz >> 3)], 0);
    materials.add(packed >>> 24);
  }
  assert.deepEqual([...materials].sort(), [0, 1]);
  const headless = new Chunk(512, 64, null);
  generator.generateChunk(headless, false);
  assert.deepEqual(headless.blocks, chunk.blocks);
  assert.deepEqual(headless.colors, chunk.colors);
  assert.deepEqual(headless.materials, chunk.materials);
  assert.equal(headless.terrainDetails.length, 0);
  new TerrainGenerator(73451, 3).generateChunk(repeated);
  assert.notDeepEqual(repeated.colors, chunk.colors);
});

test('independent Aether chunks exactly match a larger crop including edge details', () => {
  const whole = generateAetherRegion(config);
  const colorAt = (region: ReturnType<typeof generateAetherRegion>, index: number) => {
    const p = region.palette[region.cells[index]];
    return p.color | ((p.emission > 0 ? 1 : 0) << 24);
  };
  const microMap = new Map<string, number>();
  for (let i = 0; i < whole.details.length; i += 4) {
    const [x, y, z, color] = whole.details.slice(i, i + 4);
    microMap.set(`${x},${y},${z}`, color);
  }
  let microCount = 0;
  for (let cz = 0; cz < 4; cz++) for (let cx = 0; cx < 4; cx++) {
    const part = generateAetherRegion({ ...config, sizeX: 16, sizeZ: 16,
      offsetX: config.offsetX - 24 + cx * 16, offsetZ: config.offsetZ - 24 + cz * 16 });
    for (let y = 0; y < 256; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      assert.equal(colorAt(part, x + z * 16 + y * 256),
        colorAt(whole, x + cx * 16 + (z + cz * 16) * 64 + y * 4096));
    }
    for (let i = 0; i < part.details.length; i += 4) {
      const [x, y, z, color] = part.details.slice(i, i + 4);
      assert.equal(microMap.get(`${x + cx * 128},${y},${z + cz * 128}`), color);
      microCount++;
    }
  }
  assert.equal(microCount, microMap.size);
});

test('spawn has a solid landing below 180m across seeds and wrapped chunks repeat', () => {
  for (const seed of [42, 73451, 20260922]) {
    const anchor = aetherSpawnAnchor(seed);
    assert.ok(Number.isInteger(anchor.x) && Number.isInteger(anchor.z));
    const generator = new TerrainGenerator(seed, 3), a = new Chunk(512, 64, null);
    generator.generateChunk(a);
    const heights = Array.from({ length: 256 }, (_, y) => y).filter(y => a.blocks[Chunk.getIndex(0, y, 0)]);
    assert.ok(heights.length > 3 && Math.max(...heights) < 179);
    const b = new Chunk(1536, 192, null);
    generator.generateChunk(b);
    assert.deepEqual(a.colors, b.colors);
    assert.deepEqual(a.terrainDetails, b.terrainDetails);
  }
});

test('visible Aether geometry matches the terrain lab reference', async () => {
  const { createHash } = await import('node:crypto');
  const width = 96, layer = width * width;
  const region = generateAetherRegion({ ...config, sizeX: width, sizeZ: width, sizeY: 192, yCutoff: 192 });
  const get = (x: number, y: number, z: number) =>
    x < 0 || z < 0 || x >= width || z >= width || y < 0 || y >= 192 ? 0 : region.cells[x + z * width + y * layer];
  const visible: number[][] = [];
  for (let y = 0; y < 192; y++) for (let z = 0; z < width; z++) for (let x = 0; x < width; x++) {
    const id = get(x, y, z);
    if (!id || (get(x - 1, y, z) && get(x + 1, y, z) && get(x, y - 1, z)
      && get(x, y + 1, z) && get(x, y, z - 1) && get(x, y, z + 1))) continue;
    const { color, emission } = region.palette[id];
    visible.push([x, y, z, 1, color, emission > 0 ? 1 : 0]);
  }
  for (let i = 0; i < region.details.length; i += 4) {
    const [x, y, z, packed] = region.details.slice(i, i + 4);
    visible.push([x / 8, y / 8, z / 8, 0.125, packed & 0xffffff, packed >>> 24]);
  }
  // Captured from terrainLab/aetherArchipelago.ts at seed 42, crop (-134,-11),
  // 96x192x96. Normalize cube centres to lower corners and emission to material 1.
  assert.equal(visible.length, 90904);
  assert.equal(createHash('sha256').update(JSON.stringify(visible.map(v => JSON.stringify(v)).sort())).digest('hex'),
    '6b481cb4a30022e44a4eb263df58aaf2a6d9a04225ea048e030a1c8d7909edbc');
  assert.deepEqual([...new Set(visible.map(v => `${v[3]}:${v[5]}`))].sort(), ['0.125:0', '0.125:1', '1:0', '1:1']);
});
