import { createGeometryArena, type GeometryArena } from './GeometryKernels.ts';

type Triangle = { a: readonly number[]; b: readonly number[]; c: readonly number[] };
type Grid = { sx: number; sy: number; sz: number; minX: number; minY: number; minZ: number; size: number };
const LIMIT = 128 * 1024 * 1024, BATCH = 4096, CONTEXT = 65536;

/** One bounded arena per import. Oversized inputs retain the JS reference. */
export class ModelVoxelKernels {
  private readonly arena: GeometryArena;
  private readonly grid: number;
  private readonly effective: number;
  private readonly colors: number;
  private readonly output: number;
  private readonly cells: number;

  private constructor(arena: GeometryArena, grid: number, effective: number, colors: number, output: number, cells: number) {
    this.arena = arena; this.grid = grid; this.effective = effective; this.colors = colors; this.output = output; this.cells = cells;
  }

  static create(triangles: readonly Triangle[], buckets: ReadonlyMap<string, readonly number[]>, bucketSize: number, dimensions: Grid): ModelVoxelKernels | null {
    const cells = dimensions.sx * dimensions.sy * dimensions.sz;
    if (!Number.isSafeInteger(cells) || cells <= 0 || cells > 32 * 1024 * 1024
      || ![dimensions.sx, dimensions.sy, dimensions.sz, dimensions.minX, dimensions.minY, dimensions.minZ]
        .every(n => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647)
      || !Number.isFinite(bucketSize) || bucketSize <= 0 || !Number.isFinite(dimensions.size) || dimensions.size <= 0) return null;
    if (dimensions.minX + dimensions.sx > 2147483647 || dimensions.minY + dimensions.sy > 2147483647
      || dimensions.minZ + dimensions.sz > 2147483647) return null;
    let minY = Infinity, minZ = Infinity, maxY = -Infinity, maxZ = -Infinity, references = 0;
    for (const [key, ids] of buckets) {
      const [y, z] = key.split(',').map(Number);
      if (![y, z].every(n => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647)) return null;
      minY = Math.min(minY, y); minZ = Math.min(minZ, z); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
      references += ids.length;
    }
    const ny = maxY - minY + 1, nz = maxZ - minZ + 1, slots = ny * nz;
    const trianglePtr = CONTEXT + 96, table = trianglePtr + triangles.length * 72;
    const refs = table + slots * 8, stamps = refs + references * 4, grid = stamps + triangles.length * 4;
    const effective = grid + cells, colors = Math.ceil((effective + cells) / 8) * 8;
    const output = Math.ceil((colors + cells * 4) / 8) * 8, end = output + BATCH * 40;
    if (!Number.isSafeInteger(end) || end > LIMIT || slots < 1) return null;
    const arena = createGeometryArena(LIMIT);
    if (!arena) return null;
    arena.reserve(end);
    const buffer = arena.exports.memory.buffer;
    const vertices = new Float64Array(buffer, trianglePtr, triangles.length * 9);
    for (let i = 0; i < triangles.length; i++) {
      const t = triangles[i]; vertices.set(t.a, i * 9); vertices.set(t.b, i * 9 + 3); vertices.set(t.c, i * 9 + 6);
    }
    // Invalid floating-point models keep the reference's error/degenerate behavior.
    if (!vertices.every(Number.isFinite)) return null;
    const tableData = new Int32Array(buffer, table, slots * 2), idsData = new Uint32Array(buffer, refs, references);
    let cursor = 0;
    for (const [key, ids] of buckets) {
      const [y, z] = key.split(',').map(Number), slot = ((y - minY) * nz + z - minZ) * 2;
      tableData[slot] = cursor; tableData[slot + 1] = ids.length; idsData.set(ids, cursor); cursor += ids.length;
    }
    const meta = new DataView(buffer, CONTEXT, 96);
    for (const [offset, value] of [[0, trianglePtr], [4, table], [8, refs], [12, stamps], [16, minY], [20, minZ], [24, ny], [28, nz],
      [40, dimensions.sx], [44, dimensions.sy], [48, dimensions.sz], [52, triangles.length], [56, dimensions.minX], [60, dimensions.minY], [64, dimensions.minZ],
      [80, grid], [84, effective], [88, colors]]) meta.setInt32(offset, value, true);
    meta.setFloat64(32, bucketSize, true); meta.setFloat64(72, dimensions.size, true);
    return new ModelVoxelKernels(arena, grid, effective, colors, output, cells);
  }

  fill(grid: Uint8Array, colors: Int32Array, fallbackColor: number) {
    if (grid.length !== this.cells || colors.length !== this.cells) throw new RangeError('Invalid model voxel buffers');
    const exports = this.arena.exports, buffer = exports.memory.buffer;
    new Uint8Array(buffer, this.grid, this.cells).set(grid);
    new Int32Array(buffer, this.colors, this.cells).set(colors);
    exports.modelFill(CONTEXT, fallbackColor);
    grid.set(new Uint8Array(buffer, this.grid, this.cells));
    colors.set(new Int32Array(buffer, this.colors, this.cells));
  }

  hollow(enabled: boolean): Uint8Array {
    this.arena.exports.modelHollow(CONTEXT, enabled ? 1 : 0);
    return new Uint8Array(this.arena.exports.memory.buffer, this.effective, this.cells).slice();
  }

  sampleSurface(consume: (cell: number, triangle: number, u: number, v: number, w: number) => void) {
    const exports = this.arena.exports;
    for (let start = 0; start < this.cells; start += BATCH) {
      const count = exports.modelNearest(CONTEXT, start, Math.min(this.cells, start + BATCH), this.output);
      const records = new Float64Array(exports.memory.buffer, this.output, count * 5);
      for (let i = 0; i < count; i++) consume(records[i * 5], records[i * 5 + 1], records[i * 5 + 2], records[i * 5 + 3], records[i * 5 + 4]);
    }
  }
}
