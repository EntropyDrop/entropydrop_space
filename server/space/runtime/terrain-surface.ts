import { TerrainGenerator } from '@entropydrop/space-engine/worldgen/TerrainGenerator.ts';
import { generateSurfaceZoneRecords } from '@entropydrop/space-engine/worldgen/SurfaceZoneGenerator.ts';
import { Chunk, CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from '@entropydrop/space-engine/voxel/Chunk.ts';
import { readFileSync } from 'node:fs';
import { generateVoxelSurfaceZone, encodeVoxelLevels } from '@entropydrop/space-engine/worldgen/VoxelSurfaceGenerator.ts';

function integer(value: string | undefined, name: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid ${name}`);
  return parsed;
}

function generateChunk(generator: TerrainGenerator, chunkX: number, chunkZ: number) {
  const chunk = new Chunk(chunkX, chunkZ, null);
  generator.generateChunk(chunk, false);
  return chunk;
}

function writeZone(seed: number, version: number, zoneX: number, zoneZ: number) {
  const generator = new TerrainGenerator(seed, version);
  process.stdout.write(generateSurfaceZoneRecords(generator, zoneX, zoneZ));
}

function writeChunk(generator: TerrainGenerator, chunkX: number, chunkZ: number) {
  const chunk = generateChunk(generator, chunkX, chunkZ);
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
if (mode === 'volume') {
  const result = generateVoxelSurfaceZone(new TerrainGenerator(seed, version), x, z);
  process.stdout.write(result.records);
  process.stdout.write(encodeVoxelLevels(result.levels));
} else if (mode === 'zone') writeZone(seed, version, x, z);
else if (mode === 'chunk') writeChunk(new TerrainGenerator(seed, version), x, z);
else if (mode === 'chunks') {
  const chunks = JSON.parse(readFileSync(0, 'utf8'));
  if (!Array.isArray(chunks) || chunks.length < 1 || chunks.length > 32
    || chunks.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(n => !Number.isSafeInteger(n)))) {
    throw new Error('invalid chunk batch');
  }
  const generator = new TerrainGenerator(seed, version);
  for (const [cx, cz] of chunks) writeChunk(generator, cx, cz);
} else throw new Error('mode must be zone, chunk or chunks');
