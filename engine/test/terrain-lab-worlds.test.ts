import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TerrainGenerator } from '../src/worldgen/TerrainGenerator.ts';
import { terrainLabSpawnAnchor } from '../src/worldgen/TerrainLabGenerator.ts';
import { HARBOR_DEFAULTS, generateHarborRegion } from '../src/worldgen/ColossusHarborGenerator.ts';
import { CANYON_DEFAULTS, generateCanyonRegion } from '../src/worldgen/TitanCanyonGenerator.ts';
import { FOUNDRY_DEFAULTS, generateFoundryRegion } from '../src/worldgen/AstralFoundryGenerator.ts';
import { BRUTALIST_DUSK_DEFAULTS, generateBrutalistDuskRegion } from '../src/worldgen/BrutalistDuskGenerator.ts';
import { Chunk } from '../src/voxel/Chunk.ts';

const worlds = [
  { name: 'Colossus Harbor', version: 4, generate: (config: any) => generateHarborRegion({ ...HARBOR_DEFAULTS, ...config }),
    materials: ['1:0', '8:0'], count: 16248, hash: '87cac6523c287e2c1e514cf5778ed86859ce340741749327d1998fc4b98dcfe9' },
  { name: 'Titan Canyon', version: 5, generate: (config: any) => generateCanyonRegion({ ...CANYON_DEFAULTS, ...config }),
    materials: ['1:0', '1:1', '8:0'], count: 31186, hash: '3a7c396d41f19beac85ad1c590079822d38b14c0b94d6c004b7cf1a9bf7329f5' },
  { name: 'Astral Foundry', version: 6, generate: (config: any) => generateFoundryRegion({ ...FOUNDRY_DEFAULTS, ...config }),
    materials: ['1:0', '1:1', '8:0', '8:1'], count: 33588, hash: '1b2eede91f72a3ea6457ab0dabe11717f565836652522187314c192acc1d9059' },
  { name: 'Brutalist Dusk', version: 7, generate: (config: any) => generateBrutalistDuskRegion({ ...BRUTALIST_DUSK_DEFAULTS, ...config }),
    materials: ['1:0', '1:1', '8:0'], count: 62789, hash: 'eed1c154620b8c1621029cd2d3d02965d78f7c71f6bc56c48dfd4a95050430cb' },
];

for (const world of worlds) {
  test(`${world.name}: solids, micro details, headless parity and safe wrapped spawn`, () => {
    for (const seed of [42, 73451, 20260922]) {
      const generator = new TerrainGenerator(seed, world.version), chunk = new Chunk(512, 64, null);
      generator.generateChunk(chunk);
      assert.equal(generator.version, world.version);
      const repeat = new Chunk(1536, 192, null);
      generator.generateChunk(repeat);
      assert.deepEqual(repeat.blocks, chunk.blocks);
      assert.deepEqual(repeat.colors, chunk.colors);
      assert.deepEqual(repeat.materials, chunk.materials);
      assert.deepEqual(repeat.terrainDetails, chunk.terrainDetails);
      generator.generateChunk(repeat, false);
      assert.deepEqual(repeat.blocks, chunk.blocks);
      assert.deepEqual(repeat.colors, chunk.colors);
      assert.deepEqual(repeat.materials, chunk.materials);
      assert.equal(repeat.terrainDetails.length, 0);
      const landing = Array.from({ length: 256 }, (_, y) => y).filter(y => chunk.blocks[Chunk.getIndex(0, y, 0)]);
      assert.ok(landing.length > 1 && Math.max(...landing) < 218, 'solid landing with headroom below 220m');
      assert.ok(chunk.blocks.filter(Boolean).length > 256);
      assert.ok(chunk.terrainDetails.length > 0);
      for (let i = 0; i < chunk.terrainDetails.length; i += 4) {
        const [x, y, z, packed] = chunk.terrainDetails.subarray(i, i + 4);
        assert.ok(x < 128 && z < 128 && y < 2048 && packed >>> 24 <= 1);
        assert.equal(chunk.blocks[Chunk.getIndex(x >> 3, y >> 3, z >> 3)], 0);
      }
    }
  });

  test(`${world.name}: independent chunks match a larger crop and terrain-lab reference`, () => {
    const anchor = terrainLabSpawnAnchor(42, world.version);
    const config = { seed: 42, sizeX: 64, sizeZ: 64, sizeY: 192, yCutoff: 192, offsetX: anchor.x, offsetZ: anchor.z };
    const whole = world.generate(config), micro = new Map<string, number>();
    const get = (x: number, y: number, z: number) => x < 0 || z < 0 || y < 0 || x >= 64 || z >= 64 || y >= 192
      ? 0 : whole.voxels[x + z * 64 + y * 4096];
    for (let i = 0; i < whole.details.length; i += 4) {
      const [x, y, z, v] = whole.details.subarray(i, i + 4); micro.set(`${x},${y},${z}`, v);
    }
    let microCount = 0;
    for (let cz = 0; cz < 4; cz++) for (let cx = 0; cx < 4; cx++) {
      const part = world.generate({ ...config, sizeX: 16, sizeZ: 16,
        offsetX: anchor.x - 24 + cx * 16, offsetZ: anchor.z - 24 + cz * 16 });
      for (let y = 0; y < 192; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++)
        assert.equal(part.voxels[x + z * 16 + y * 256], get(x + cx * 16, y, z + cz * 16));
      for (let i = 0; i < part.details.length; i += 4) {
        const [x, y, z, v] = part.details.subarray(i, i + 4);
        assert.equal(micro.get(`${x + cx * 128},${y},${z + cz * 128}`), v);
        microCount++;
      }
    }
    assert.equal(microCount, micro.size);
    const visible: number[][] = [];
    for (let y = 0; y < 192; y++) for (let z = 4; z < 60; z++) for (let x = 4; x < 60; x++) {
      const v = get(x, y, z);
      if (!v || (get(x - 1, y, z) && get(x + 1, y, z) && get(x, y - 1, z) && get(x, y + 1, z)
        && get(x, y, z - 1) && get(x, y, z + 1))) continue;
      visible.push([x * 8, y * 8, z * 8, 8, v & 0xffffff, v >>> 24 & 1]);
    }
    for (let i = 0; i < whole.details.length; i += 4) {
      const [x, y, z, v] = whole.details.subarray(i, i + 4);
      if (x >= 32 && z >= 32 && x < 480 && z < 480) visible.push([x, y, z, 1, v & 0xffffff, v >>> 24]);
    }
    // Captured independently from the original terrainLab generators, seed 42,
    // 64x192x64 at the anchor above. Ignore the four-metre crop edge where the
    // preview cannot query neighbouring support cells. Lower corners use 1/8m.
    assert.equal(visible.length, world.count);
    assert.equal(createHash('sha256').update(JSON.stringify(visible.map(v => JSON.stringify(v)).sort())).digest('hex'), world.hash);
    assert.deepEqual([...new Set(visible.map(v => `${v[3]}:${v[5]}`))].sort(), world.materials);
  });
}

test('Brutalist Dusk: district boundaries preserve building foundations, roofs and ornaments', () => {
  for (const seed of [42, 73451]) for (const [offsetX, offsetZ] of [[128, 0], [0, 128], [128, 128], [-128, -128]]) {
    const config = { ...BRUTALIST_DUSK_DEFAULTS, seed, sizeX: 48, sizeZ: 48, sizeY: 192, yCutoff: 192, offsetX, offsetZ };
    const whole = generateBrutalistDuskRegion(config), micro = new Map<string, number>();
    for (let i = 0; i < whole.details.length; i += 4) {
      const [x, y, z, v] = whole.details.subarray(i, i + 4); micro.set(`${x},${y},${z}`, v);
    }
    let microCount = 0;
    for (let cz = 0; cz < 3; cz++) for (let cx = 0; cx < 3; cx++) {
      const part = generateBrutalistDuskRegion({ ...config, sizeX: 16, sizeZ: 16,
        offsetX: offsetX - 16 + cx * 16, offsetZ: offsetZ - 16 + cz * 16 });
      for (let y = 0; y < 192; y++) for (let z = 0; z < 16; z++) {
        const index = cx * 16 + (z + cz * 16) * 48 + y * 48 * 48;
        assert.deepEqual(part.voxels.subarray(z * 16 + y * 256, z * 16 + y * 256 + 16), whole.voxels.subarray(index, index + 16));
      }
      for (let i = 0; i < part.details.length; i += 4) {
        const [x, y, z, v] = part.details.subarray(i, i + 4);
        assert.equal(micro.get(`${x + cx * 128},${y},${z + cz * 128}`), v);
        microCount++;
      }
    }
    assert.equal(microCount, micro.size);
  }
});
