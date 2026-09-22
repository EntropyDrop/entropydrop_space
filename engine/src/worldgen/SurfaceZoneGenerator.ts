import { Chunk } from '../voxel/Chunk.ts';
import type { TerrainGenerator } from './TerrainGenerator.ts';

/** Exact 1m columns used by both the server snapshot job and local LOD tests.
 * Run off the render thread. Reuse one chunk allocation for all 1024 chunks. */
export function generateSurfaceZoneRecords(generator: TerrainGenerator, zoneX: number, zoneZ: number): Uint8Array {
  const bytes = new Uint8Array(512 * 512 * 8), view = new DataView(bytes.buffer);
  const chunk = new Chunk(0, 0, null);
  for (let cx = 0; cx < 32; cx++) for (let cz = 0; cz < 32; cz++) {
    chunk.reuseAt(zoneX * 32 + cx, zoneZ * 32 + cz, null);
    generator.generateChunk(chunk, false);
    const top = chunk.getOccupiedYRange()?.max ?? -1;
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      let y = top;
      while (y >= 0 && !chunk.blocks[Chunk.getIndex(x, y, z)]) y--;
      const height = Math.max(0, y + 1) * 8;
      const color = y >= 0 ? chunk.colors[Chunk.getIndex(x, y, z)] : 0;
      const offset = ((cx * 16 + x) * 512 + cz * 16 + z) * 8;
      view.setUint16(offset, height, true);
      view.setUint16(offset + 2, height, true);
      bytes.set([color >>> 16 & 255, color >>> 8 & 255, color & 255], offset + 4);
    }
  }
  return bytes;
}
