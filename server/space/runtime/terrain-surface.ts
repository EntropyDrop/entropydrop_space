import { TerrainGenerator } from '@entropydrop/space-engine/worldgen/TerrainGenerator.ts';
import { Chunk, CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from '@entropydrop/space-engine/voxel/Chunk.ts';

function integer(value: string | undefined, name: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid ${name}`);
  return parsed;
}

function generateChunk(generator: TerrainGenerator, chunkX: number, chunkZ: number) {
  const chunk = new Chunk(chunkX, chunkZ, null);
  generator.generateChunk(chunk);
  return chunk;
}

function writeZone(seed: number, version: number, zoneX: number, zoneZ: number) {
  const axis = 512;
  const recordBytes = 8;
  const output = Buffer.allocUnsafe(axis * axis * recordBytes);
  const generator = new TerrainGenerator(seed, version);
  for (let localChunkX = 0; localChunkX < 32; localChunkX++) {
    for (let localChunkZ = 0; localChunkZ < 32; localChunkZ++) {
      const chunk = generateChunk(
        generator,
        zoneX * 32 + localChunkX,
        zoneZ * 32 + localChunkZ,
      );
      const occupied = chunk.getOccupiedYRange();
      for (let localX = 0; localX < CHUNK_SIZE_X; localX++) {
        for (let localZ = 0; localZ < CHUNK_SIZE_Z; localZ++) {
          let y = occupied?.max ?? -1;
          while (y >= 0 && chunk.blocks[Chunk.getIndex(localX, y, localZ)] === 0) y--;
          const height = Math.max(0, y + 1) * 8;
          const color = y >= 0 ? chunk.colors[Chunk.getIndex(localX, y, localZ)] : 0;
          const x = localChunkX * CHUNK_SIZE_X + localX;
          const z = localChunkZ * CHUNK_SIZE_Z + localZ;
          const offset = (x * axis + z) * recordBytes;
          output.writeUInt16LE(height, offset);
          output.writeUInt16LE(height, offset + 2);
          output[offset + 4] = (color >>> 16) & 255;
          output[offset + 5] = (color >>> 8) & 255;
          output[offset + 6] = color & 255;
          output[offset + 7] = 0;
        }
      }
    }
  }
  process.stdout.write(output);
}

function writeChunk(seed: number, version: number, chunkX: number, chunkZ: number) {
  const chunk = generateChunk(new TerrainGenerator(seed, version), chunkX, chunkZ);
  const cellCount = CHUNK_SIZE_X * CHUNK_SIZE_Y * CHUNK_SIZE_Z;
  const output = Buffer.allocUnsafe(cellCount * 4);
  for (let index = 0; index < cellCount; index++) {
    const color = chunk.blocks[index] === 0 ? 0 : chunk.colors[index];
    const offset = index * 4;
    output[offset] = chunk.blocks[index];
    output[offset + 1] = (color >>> 16) & 255;
    output[offset + 2] = (color >>> 8) & 255;
    output[offset + 3] = color & 255;
  }
  process.stdout.write(output);
}

const [mode, seedValue, versionValue, xValue, zValue] = process.argv.slice(2);
const seed = integer(seedValue, 'seed');
const version = integer(versionValue, 'terrain generator version');
const x = integer(xValue, 'x');
const z = integer(zValue, 'z');
if (mode === 'zone') writeZone(seed, version, x, z);
else if (mode === 'chunk') writeChunk(seed, version, x, z);
else throw new Error('mode must be zone or chunk');
