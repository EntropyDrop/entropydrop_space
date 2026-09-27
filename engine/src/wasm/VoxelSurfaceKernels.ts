import type { Chunk } from '../voxel/Chunk.ts';

export type VoxelSurfaceExports = {
  memory: WebAssembly.Memory;
  voxelColumnChunk(...args: number[]): number;
  voxelColumnMicro(...args: number[]): number;
  voxelColumnRecords(...args: number[]): void;
  reduceVoxelBrick(...args: number[]): void;
  meshVoxelBrick(...args: number[]): number;
};

const BRICK_CELLS = 64 ** 3;
const COLUMN = 65536;
const BLOCKS = COLUMN + 4 * BRICK_CELLS * 4;
const COLORS = BLOCKS + 65536;
const MATERIALS = COLORS + 65536 * 4;
const MICRO = MATERIALS + 65536;
const MICRO_BATCH = 4096;
const RECORDS = MICRO + MICRO_BATCH * 16;
const MASK = RECORDS + 64 * 64 * 8;
const MIPS = MASK + 64 * 64 * 4;
// Sum of all reduced brick volumes: 32^3 + 16^3 + ... + 1.
const FACES = MIPS + Math.ceil(((BRICK_CELLS - 1) / 7 * 4) / 8) * 8;
// Each axis has 64^2 lines and at most 65 occupied/air boundaries per line.
// Greedy merging cannot increase this bound, even with unique cell colours.
const FACE_CAPACITY = 3 * 65 * 64 * 64;
const SCRATCH_END = FACES + FACE_CAPACITY * 16;

/** Private arena per zone generation, reusable across columns and safe while
 * terrain generation uses the shared kernel instance. Only copied results escape. */
export class VoxelSurfaceColumn {
  private readonly exports: VoxelSurfaceExports;
  private occupied = 0;

  constructor(exports: VoxelSurfaceExports) {
    this.exports = exports;
    if (SCRATCH_END > 32 * 1024 * 1024) throw new RangeError('Terrain WASM scratch budget exceeded');
    const missing = SCRATCH_END - exports.memory.buffer.byteLength;
    if (missing > 0) exports.memory.grow(Math.ceil(missing / 65536));
  }

  reset() {
    new Uint32Array(this.exports.memory.buffer, COLUMN, 4 * BRICK_CELLS).fill(0);
    this.occupied = 0;
  }

  /** Append one generated 16x256x16 chunk at its slot in the current column. */
  addChunk(chunk: Chunk, x: number, z: number) {
    const top = chunk.getOccupiedYRange()?.max ?? -1;
    if (!Number.isInteger(x) || x < 0 || x >= 4 || !Number.isInteger(z) || z < 0 || z >= 4
      || !Number.isInteger(top) || top < -1 || top > 255 || chunk.blocks.length !== 65536
      || chunk.colors.length !== 65536 || chunk.materials.length !== 65536 || chunk.terrainDetails.length % 4) {
      throw new RangeError('Invalid voxel surface chunk');
    }
    const buffer = this.exports.memory.buffer, count = (top + 1) * 256;
    new Uint8Array(buffer, BLOCKS, count).set(chunk.blocks.subarray(0, count));
    new Uint32Array(buffer, COLORS, count).set(chunk.colors.subarray(0, count));
    new Uint8Array(buffer, MATERIALS, count).set(chunk.materials.subarray(0, count));
    this.occupied |= this.exports.voxelColumnChunk(COLUMN, BLOCKS, COLORS, MATERIALS, x * 16, z * 16, top);
    for (let start = 0; start < chunk.terrainDetails.length; start += MICRO_BATCH * 4) {
      const batch = chunk.terrainDetails.subarray(start, start + MICRO_BATCH * 4);
      new Uint32Array(buffer, MICRO, batch.length).set(batch);
      const occupied = this.exports.voxelColumnMicro(COLUMN, MICRO, batch.length / 4, x * 16, z * 16);
      if (occupied < 0) throw new RangeError('Invalid voxel surface micro cell');
      this.occupied |= occupied;
    }
  }

  surfaceRecords(): Uint8Array {
    this.exports.voxelColumnRecords(COLUMN, RECORDS, this.occupied);
    return new Uint8Array(this.exports.memory.buffer, RECORDS, 64 * 64 * 8).slice();
  }

  /** All seven mips of one brick. The dense column stays intact for the next brick. */
  meshBrick(y: number, originX: number, originZ: number): Uint8Array[] | null {
    if (!Number.isInteger(y) || y < 0 || y >= 4
      || !Number.isInteger(originX) || originX < 0 || originX > 448 || originX % 64
      || !Number.isInteger(originZ) || originZ < 0 || originZ > 448 || originZ % 64) {
      throw new RangeError('Invalid voxel surface brick');
    }
    if (!(this.occupied & (1 << y))) return null;
    let data = COLUMN + y * BRICK_CELLS * 4, next = MIPS;
    const levels: Uint8Array[] = [];
    for (let axis = 64, size = 1; axis >= 1; axis /= 2, size *= 2) {
      const count = this.exports.meshVoxelBrick(data, axis, size, originX, y * 64, originZ, MASK, FACES, FACE_CAPACITY);
      if (count < 0 || count > FACE_CAPACITY) throw new RangeError('Voxel surface face capacity exceeded');
      levels.push(new Uint8Array(this.exports.memory.buffer, FACES, count * 16).slice());
      if (axis > 1) {
        this.exports.reduceVoxelBrick(data, axis, next);
        data = next; next += (axis / 2) ** 3 * 4;
      }
    }
    return levels;
  }
}
