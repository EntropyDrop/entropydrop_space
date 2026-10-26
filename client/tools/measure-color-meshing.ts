/** Face-count experiment only: no claim about gameplay FPS or build throughput. */
import { writeFileSync } from 'node:fs';
import { Chunk } from '../../engine/src/voxel/Chunk.ts';
import { TerrainGenerator } from '../../engine/src/worldgen/TerrainGenerator.ts';
import { meshVoxelBrick, reduceVoxelBrick } from '../../engine/src/worldgen/VoxelSurfaceGenerator.ts';
import { makePalette } from '../src/dev/ColorPaletteMath.ts';

const linear = Uint8Array.from({ length: 256 }, (_, n) => Math.round(255 * (n / 255 <= .04045
  ? n / 255 / 12.92 : ((n / 255 + .055) / 1.055) ** 2.4)));
function rendererColor(value: number) {
  const emit = value >>> 24 & 1, rgb = [value >>> 16 & 255, value >>> 8 & 255, value & 255];
  if (!emit) for (let c = 0; c < 3; c++) rgb[c] = linear[rgb[c]];
  return (rgb[0] | rgb[1] << 8 | rgb[2] << 16 | 0xff000000) >>> 0;
}
const origins = [[0,0], [3,2], [4,4], [7,7]];
const result: any = { revision: 'color-meshing-v1', zone: [16,2], columnBricks: origins,
  method: 'Four 64x256x64 columns per world; original occupancy and emissive flags; quantize each original mip independently before the existing greedy mesher; retain its 8m merge cap.', worlds: [] };
for (const [world, seed, version] of [['aether-archipelago',42,3], ['nature',42,1], ['copper-metropolis',20260922,2]] as const) {
  const generator = new TerrainGenerator(seed, version), chunk = new Chunk(0, 0, null);
  const levels: { data: Uint32Array; origin: number[] }[][] = Array.from({ length: 7 }, () => []);
  for (const [bx, bz] of origins) {
    const bricks = Array.from({ length: 4 }, () => new Uint32Array(64 ** 3));
    for (let cx = 0; cx < 4; cx++) for (let cz = 0; cz < 4; cz++) {
      chunk.reuseAt(512 + bx * 4 + cx, 64 + bz * 4 + cz, null); generator.generateChunk(chunk);
      for (let y = 0; y <= (chunk.getOccupiedYRange()?.max ?? -1); y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        const at = Chunk.getIndex(x, y, z); if (!chunk.blocks[at]) continue;
        bricks[y >> 6][cx * 16 + x + (y & 63) * 64 + (cz * 16 + z) * 4096] =
          (0x80000000 | chunk.colors[at] | chunk.materials[at] << 24) >>> 0;
      }
      for (let i = 0; i < chunk.terrainDetails.length; i += 4) {
        const [mx, my, mz, value] = chunk.terrainDetails.subarray(i, i + 4), y = my >> 3;
        const at = cx * 16 + (mx >> 3) + (y & 63) * 64 + (cz * 16 + (mz >> 3)) * 4096;
        if (!bricks[y >> 6][at]) bricks[y >> 6][at] = (0x80000000 | value) >>> 0;
      }
    }
    for (let by = 0; by < 4; by++) {
      if (!bricks[by].some(Boolean)) continue;
      let data: Uint32Array = bricks[by], axis = 64;
      for (let level = 0; level < 7; level++, axis /= 2) {
        levels[level].push({ data, origin: [bx * 64, by * 64, bz * 64] });
        if (axis > 1) data = reduceVoxelBrick(data, axis);
      }
    }
  }
  const rows: any[] = [];
  for (let level = 0; level < 7; level++) {
    const size = 2 ** level, axis = 64 / size, histogram = new Map<number, number>();
    // Weight by exposed area, not underground voxel volume.
    for (const brick of levels[level]) meshVoxelBrick(brick.data, axis, size, brick.origin, (_x,_y,_z,w,h,_dir,value) => {
      const word = rendererColor(value); histogram.set(word, (histogram.get(word) ?? 0) + w * h);
    });
    const palette = makePalette(histogram), modes: any = {};
    for (const mode of ['original','linear8','palette256','mono']) {
      let faces = 0, area = 0, emissionArea = 0;
      for (const brick of levels[level]) {
        const data = mode === 'original' ? brick.data : brick.data.map(value => {
          if (!value) return 0;
          const color = mode === 'linear8' ? rendererColor(value) & 0xffffff
            : mode === 'palette256' ? palette.indices.get(rendererColor(value)) ?? 0 : 0;
          return (0x80000000 | value & 0x01000000 | color) >>> 0;
        });
        meshVoxelBrick(data, axis, size, brick.origin, (_x,_y,_z,w,h,_dir,value) => {
          faces++; area += w * h; if (value >>> 24 & 1) emissionArea += w * h;
        });
      }
      modes[mode] = { faces, area, emissionArea };
      if (area !== modes.original.area || emissionArea !== modes.original.emissionArea) throw new Error('Meshing changed occupancy or emission.');
    }
    rows.push({ cellSize: size, bricks: levels[level].length, uniqueColors: histogram.size, paletteColors: palette.count, modes });
  }
  result.worlds.push({ world, seed, version, rows });
  console.log(world, JSON.stringify(rows));
}
writeFileSync(new URL('../src/dev/results/color-2026-10-26/meshing.json', import.meta.url), JSON.stringify(result, null, 2)+'\n');
