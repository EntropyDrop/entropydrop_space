import { Chunk } from '../voxel/Chunk.ts';
import type { TerrainGenerator } from './TerrainGenerator.ts';

export const VOXEL_LOD_SIZES = [1, 2, 4, 8, 16, 32, 64] as const;
export const VOXEL_FACE_BYTES = 16;
export const VOXEL_BRICK_SIZE = 64;
const OCCUPIED = 0x80000000;

/** Six directed, greedy surface quads. Positions and extents use metres.
 * direction = axis * 2 + positive; U/V follow the next two cyclic axes.
 * Bricks are closed at their borders, keeping independent LODs watertight.
 */
export function meshVoxelBrick(data: Uint32Array, axis: number, size: number,
  origin: readonly number[], emit: (x: number, y: number, z: number, w: number, h: number, dir: number, value: number) => void) {
  const strides = [1, axis, axis * axis];
  const mask = new Uint32Array(axis * axis);
  for (let dim = 0; dim < 3; dim++) {
    const u = (dim + 1) % 3, v = (dim + 2) % 3;
    for (let positive = 0; positive < 2; positive++) for (let plane = 0; plane < axis; plane++) {
      for (let j = 0; j < axis; j++) for (let i = 0; i < axis; i++) {
        const index = plane * strides[dim] + i * strides[u] + j * strides[v];
        const value = data[index];
        const neighbour = plane + (positive ? 1 : -1);
        mask[i + j * axis] = value && (neighbour < 0 || neighbour >= axis || !data[index + (positive ? 1 : -1) * strides[dim]]) ? value : 0;
      }
      for (let j = 0; j < axis; j++) for (let i = 0; i < axis;) {
        const value = mask[i + j * axis];
        if (!value) { i++; continue; }
        let width = 1, height = 1;
        // Subdivide long planar quads to limit torus chord error at fine LOD.
        const limit = Math.max(1, 8 / size);
        while (width < limit && i + width < axis && mask[i + width + j * axis] === value) width++;
        outer: while (height < limit && j + height < axis) {
          for (let k = 0; k < width; k++) if (mask[i + k + (j + height) * axis] !== value) break outer;
          height++;
        }
        const p = [...origin];
        p[dim] += (plane + positive) * size; p[u] += i * size; p[v] += j * size;
        emit(p[0], p[1], p[2], width * size, height * size, dim * 2 + positive, value);
        for (let y = 0; y < height; y++) mask.fill(0, i + (j + y) * axis, i + width + (j + y) * axis);
        i += width;
      }
    }
  }
}

/** Reduce all three axes. Empty space stays empty; occupied children contribute
 * their colour without averaging against air. Thin bridges survive coarsening. */
export function reduceVoxelBrick(data: Uint32Array, axis: number): Uint32Array {
  const n = axis / 2, result = new Uint32Array(n ** 3);
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let count = 0, red = 0, green = 0, blue = 0, emissive = 0;
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const value = data[x * 2 + dx + (y * 2 + dy) * axis + (z * 2 + dz) * axis * axis];
      if (!value) continue;
      count++; red += value >>> 16 & 255; green += value >>> 8 & 255; blue += value & 255;
      emissive += value >>> 24 & 1;
    }
    if (count) result[x + y * n + z * n * n] = (OCCUPIED | (emissive * 2 >= count ? 1 << 24 : 0)
      | Math.round(red / count) << 16 | Math.round(green / count) << 8 | Math.round(blue / count)) >>> 0;
  }
  return result;
}

class FaceWriter {
  private bytes = new Uint8Array(65536);
  private view = new DataView(this.bytes.buffer);
  length = 0;
  emit = (x: number, y: number, z: number, w: number, h: number, dir: number, value: number) => {
    if (this.length + 16 > this.bytes.length) {
      const next = new Uint8Array(this.bytes.length * 2); next.set(this.bytes);
      this.bytes = next; this.view = new DataView(next.buffer);
    }
    const at = this.length;
    for (const [i, n] of [x, y, z, w, h].entries()) this.view.setUint16(at + i * 2, n * 8, true);
    this.bytes[at + 10] = dir; this.bytes[at + 11] = value >>> 24 & 1;
    this.bytes[at + 12] = value >>> 16 & 255; this.bytes[at + 13] = value >>> 8 & 255; this.bytes[at + 14] = value & 255;
    this.length += 16;
  };
  finish() { return this.bytes.slice(0, this.length); }
}

/** Bounded scratch: one 64x256x64 column of bricks, never a dense world volume.
 * The height lattice is metadata for residency only; geometry is six-sided 3D.
 * Micro ornaments contribute occupancy/material at the finest distant 1m LOD.
 */
export function generateVoxelSurfaceZone(generator: TerrainGenerator, zoneX: number, zoneZ: number, onProgress?: (completed: number) => void) {
  const records = new Uint8Array(512 * 512 * 8), view = new DataView(records.buffer);
  const writers = VOXEL_LOD_SIZES.map(() => new FaceWriter());
  const chunk = new Chunk(0, 0, null);
  for (let bx = 0; bx < 8; bx++) for (let bz = 0; bz < 8; bz++) {
    const bricks = Array.from({ length: 4 }, () => new Uint32Array(64 ** 3));
    const occupied = new Uint8Array(4);
    for (let cx = 0; cx < 4; cx++) for (let cz = 0; cz < 4; cz++) {
      chunk.reuseAt(zoneX * 32 + bx * 4 + cx, zoneZ * 32 + bz * 4 + cz, null);
      generator.generateChunk(chunk);
      const top = chunk.getOccupiedYRange()?.max ?? -1;
      for (let y = 0; y <= top; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        const index = Chunk.getIndex(x, y, z);
        if (!chunk.blocks[index]) continue;
        const by = y >> 6, lx = cx * 16 + x, lz = cz * 16 + z;
        bricks[by][lx + (y & 63) * 64 + lz * 4096] = (OCCUPIED | chunk.colors[index] | chunk.materials[index] << 24) >>> 0;
        occupied[by] = 1;
      }
      for (let i = 0; i < chunk.terrainDetails.length; i += 4) {
        const [mx, my, mz, value] = chunk.terrainDetails.subarray(i, i + 4);
        const x = cx * 16 + (mx >> 3), y = my >> 3, z = cz * 16 + (mz >> 3), by = y >> 6;
        const index = x + (y & 63) * 64 + z * 4096;
        // Keep solids authoritative; use one stable micro representative per cell.
        if (!bricks[by][index]) bricks[by][index] = (OCCUPIED | value) >>> 0;
        occupied[by] = 1;
      }
    }
    for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) {
      let high = -1, low = 256, color = 0;
      for (let y = 0; y < 256; y++) {
        const value = bricks[y >> 6][x + (y & 63) * 64 + z * 4096];
        if (value) { high = y; low = Math.min(low, y); color = value; }
      }
      const at = ((bx * 64 + x) * 512 + bz * 64 + z) * 8;
      view.setUint16(at, (high + 1) * 8, true);
      view.setUint16(at + 2, high < 0 ? 0 : low * 8, true);
      records.set([color >>> 16 & 255, color >>> 8 & 255, color & 255, 0], at + 4);
    }
    for (let by = 0; by < 4; by++) {
      if (!occupied[by]) continue;
      let data: Uint32Array = bricks[by];
      let axis = 64;
      for (let level = 0; level < VOXEL_LOD_SIZES.length; level++) {
        meshVoxelBrick(data, axis, VOXEL_LOD_SIZES[level], [bx * 64, by * 64, bz * 64], writers[level].emit);
        if (axis > 1) data = reduceVoxelBrick(data, axis);
        axis /= 2;
      }
    }
    onProgress?.(bx * 8 + bz + 1);
  }
  return { records, levels: writers.map((writer, i) => ({ cellSize: VOXEL_LOD_SIZES[i], faces: writer.finish() })) };
}

export function encodeVoxelLevels(levels: { cellSize: number; faces: Uint8Array }[]) {
  const bytes = new Uint8Array(8 + levels.reduce((n, level) => n + 8 + level.faces.length, 0));
  const view = new DataView(bytes.buffer);
  bytes.set([86, 88, 76, 55, levels.length, 0, 0, 0]);
  let offset = 8;
  for (const { cellSize, faces } of levels) {
    bytes[offset] = cellSize; view.setUint32(offset + 4, faces.length / 16, true);
    bytes.set(faces, offset + 8); offset += 8 + faces.length;
  }
  return bytes;
}
