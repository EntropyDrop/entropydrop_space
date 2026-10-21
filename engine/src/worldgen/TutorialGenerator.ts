import { Chunk, CHUNK_SIZE_X, CHUNK_SIZE_Z } from '../voxel/Chunk.ts';
import { BlockTypes } from '../voxel/BlockTypes.ts';
import { TORUS_GREF } from '../torus/TorusWorld.ts';

export const TERRAIN_GENERATOR_TUTORIAL = 9;
export const TUTORIAL_GROUND_HEIGHT = TORUS_GREF;
const TUTORIAL_GROUND_COLORS = [0xe8e8e8, 0xb8b8b8] as const;

/** A level surface across both torus seams, with no procedural decorations. */
export function generateTutorialChunk(chunk: Chunk) {
  const layerSize = CHUNK_SIZE_X * CHUNK_SIZE_Z;
  chunk.blocks.fill(BlockTypes.COLOR_BLOCK, 0, (TUTORIAL_GROUND_HEIGHT + 1) * layerSize);
  for (let z = 0; z < CHUNK_SIZE_Z; z++) {
    for (let x = 0; x < CHUNK_SIZE_X; x++) {
      const wx = chunk.cx * CHUNK_SIZE_X + x;
      const wz = chunk.cz * CHUNK_SIZE_Z + z;
      chunk.colors[z * CHUNK_SIZE_X + x] = TUTORIAL_GROUND_COLORS[(wx + wz) & 1];
    }
  }
  // Repeat the one-block checkerboard down each column, including exposed cuts.
  for (let y = 1; y <= TUTORIAL_GROUND_HEIGHT; y++) {
    chunk.colors.copyWithin(y * layerSize, 0, layerSize);
  }
  chunk.setGeneratedOccupiedYRange(0, TUTORIAL_GROUND_HEIGHT);
  chunk.hasGenerated = true;
  return chunk.terrainDetails;
}
