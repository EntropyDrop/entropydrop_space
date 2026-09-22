import test from 'node:test';
import assert from 'node:assert/strict';
import { Chunk } from '../src/voxel/Chunk.ts';
import { TerrainGenerator } from '../src/worldgen/TerrainGenerator.ts';
import { generateSurfaceZoneRecords } from '../src/worldgen/SurfaceZoneGenerator.ts';

test('shared Copper far snapshots preserve exact one-metre top columns and colors', () => {
  const generator = new TerrainGenerator(20260922, 2);
  const records = generateSurfaceZoneRecords(generator, 16, 2);
  assert.equal(records.byteLength, 512 * 512 * 8);
  const view = new DataView(records.buffer);
  for (const [cx, cz] of [[0, 0], [7, 13], [31, 31]]) {
    const chunk = new Chunk(512 + cx, 64 + cz, null);
    generator.generateChunk(chunk, false);
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      let y = 255;
      while (y >= 0 && !chunk.blocks[Chunk.getIndex(x, y, z)]) y--;
      const color = y >= 0 ? chunk.colors[Chunk.getIndex(x, y, z)] : 0;
      const offset = ((cx * 16 + x) * 512 + cz * 16 + z) * 8;
      assert.equal(view.getUint16(offset, true), (y + 1) * 8);
      assert.equal(view.getUint16(offset + 2, true), (y + 1) * 8);
      assert.deepEqual([...records.subarray(offset + 4, offset + 8)],
        [color >>> 16 & 255, color >>> 8 & 255, color & 255, 0]);
    }
  }
});
