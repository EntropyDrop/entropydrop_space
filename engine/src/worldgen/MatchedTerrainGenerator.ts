import { Chunk, CHUNK_SIZE_X, CHUNK_SIZE_Z } from '../voxel/Chunk.ts';
import { BlockTypes } from '../voxel/BlockTypes.ts';
import { matchedHeight, matchedColorIndex, matchedColor, MATCHED_ORIGIN_X, MATCHED_ORIGIN_Z } from './MatchedTerrainSpec.ts';

/** A bounded test landscape with the same occupied cells and albedo as Minecraft. */
export function generateMatchedChunk(chunk: Chunk, seed: number) {
  const origin = chunk.getWorldOrigin();
  let maxY = -1;
  for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
    const x = origin.x + lx - MATCHED_ORIGIN_X, z = origin.z + lz - MATCHED_ORIGIN_Z;
    const top = matchedHeight(x, z, seed); maxY = Math.max(maxY, top);
    for (let y = 0; y <= top; y++) {
      const at = Chunk.getIndex(lx, y, lz);
      chunk.blocks[at] = BlockTypes.COLOR_BLOCK;
      chunk.colors[at] = matchedColor(matchedColorIndex(x, y, z, seed));
    }
  }
  chunk.setGeneratedOccupiedYRange(maxY < 0 ? 256 : 0, maxY);
  chunk.hasGenerated = true;
  return chunk.terrainDetails;
}
