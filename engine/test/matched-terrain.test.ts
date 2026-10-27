import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { Chunk } from '../src/voxel/Chunk.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';
import { TerrainGenerator } from '../src/worldgen/TerrainGenerator.ts';
import { MATCHED_ORIGIN_X, MATCHED_ORIGIN_Z, MATCHED_SIZE, matchedHeight, matchedColor, matchedColorIndex } from '../src/worldgen/MatchedTerrainSpec.ts';

test('shared terrain matches the complete independently executed Java volume checksum', () => {
  let crc = 0, solids = 0;
  const bytes = new Uint8Array(385);
  for (let z = 0; z < MATCHED_SIZE; z++) for (let x = 0; x < MATCHED_SIZE; x++) {
    const h = matchedHeight(x, z); bytes[0] = h + 1;
    let end = 1;
    for (let y = 0; y <= h; y++) {
      const rgb = matchedColor(matchedColorIndex(x, y, z));
      bytes[end++] = rgb >>> 16; bytes[end++] = rgb >>> 8; bytes[end++] = rgb; solids++;
    }
    crc = crc32(bytes.subarray(0, end), crc);
  }
  assert.equal(solids, 48810696); assert.equal(crc.toString(16), 'bef315c8');
});

test('real Space chunks preserve shared cells, colors, empty boundaries and lack of micro geometry', () => {
  const gen = new TerrainGenerator(42, 10);
  for (const [cx, cz] of [[0, 0], [31, 31], [32, 32], [63, 63], [-1, 0], [64, 63]]) {
    const chunk = new Chunk(MATCHED_ORIGIN_X / 16 + cx, MATCHED_ORIGIN_Z / 16 + cz, null);
    gen.generateChunk(chunk);
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const wx = cx * 16 + x, wz = cz * 16 + z, h = matchedHeight(wx, wz);
      assert.equal(gen.sampleHeight(wx + MATCHED_ORIGIN_X, wz + MATCHED_ORIGIN_Z), h);
      for (let y = 0; y < 256; y++) {
        const i = Chunk.getIndex(x, y, z);
        assert.equal(chunk.blocks[i], y <= h ? BlockTypes.COLOR_BLOCK : 0);
        if (y <= h) assert.equal(chunk.colors[i], matchedColor(matchedColorIndex(wx, y, wz)));
      }
    }
    assert.equal(chunk.terrainDetails.length, 0); assert.ok(chunk.materials.every(m => m === 0));
  }
});
