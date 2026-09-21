import { TERRAIN_KERNEL_BASE64 } from './TerrainKernelBinary.ts';
import { DEFAULT_BLOCK_COLOR } from '../voxel/BlockTypes.ts';
import type { Chunk } from '../voxel/Chunk.ts';
import type { SurfaceZoneSnapshot } from '../voxel/SurfaceZoneSnapshot.ts';
import type { SurfaceSelection } from './SurfaceSelection.ts';

export interface SurfaceMip {
  cellSize: number;
  axis: number;
  heights: Uint16Array;
  colors: Uint8Array;
  minHeights: Uint16Array;
  colorErrors: Float32Array;
  maxResidual?: number;
}

export interface SurfaceConnectionKernel {
  add(records: Int32Array): void;
  edges(records: Int32Array): Int32Array;
}

type KernelExports = {
  memory: WebAssembly.Memory;
  abiVersion(): number;
  natureHeights(...args: number[]): void;
  natureSurface(...args: number[]): void;
  clearChunk(...args: number[]): void;
  fillNature(...args: number[]): number;
  paintBoxes(...args: number[]): void;
  paintMicro(...args: number[]): number;
  occupiedBounds(...args: number[]): number;
  reduceSurfaceBytes(...args: number[]): void;
  surfaceBase(...args: number[]): number;
  reduceSurface(...args: number[]): number;
  microMesh(...args: number[]): number;
  surfaceOwners(...args: number[]): void;
  surfaceConnections(...args: number[]): number;
  surfaceSelect(...args: number[]): number;
  standardFaces(...args: number[]): number;
  standardMesh(...args: number[]): void;
  collisionSamples(...args: number[]): number;
};

export type TerrainKernelMode = 'auto' | 'js' | 'wasm';
let mode: TerrainKernelMode = typeof process !== 'undefined' && process.env.SPACE_TERRAIN_BACKEND === 'js'
  ? 'js' : 'auto';
let instance: TerrainKernels | undefined;
let initializationError: unknown;
let compiledModule: WebAssembly.Module;

/** Diagnostic/benchmark override. Production defaults to WASM with an init fallback. */
export function setTerrainKernelMode(value: TerrainKernelMode) {
  const previous = mode;
  mode = value;
  return previous;
}

/** One tiny, embedded module per worker/realm: no fetch, async race or asset URL. */
export function getTerrainKernels(): TerrainKernels | null {
  if (mode === 'js') return null;
  if (instance) return instance;
  if (!initializationError) {
    try {
      const bytes = Uint8Array.from(atob(TERRAIN_KERNEL_BASE64), c => c.charCodeAt(0));
      compiledModule = new WebAssembly.Module(bytes);
      const exports = new WebAssembly.Instance(compiledModule).exports as KernelExports;
      if (exports.abiVersion() !== 1) throw new Error('Terrain WASM ABI mismatch');
      instance = new TerrainKernels(exports);
      return instance;
    } catch (error) {
      initializationError = error;
      console.warn('Terrain WASM unavailable; using JavaScript kernels.', error);
    }
  }
  if (mode === 'wasm') throw initializationError;
  return null;
}

/** Synchronous, non-reentrant scratch arena. No WASM-owned views escape a call. */
export class TerrainKernels {
  private cursor = 65536;
  private readonly exports: KernelExports;
  constructor(exports: KernelExports) { this.exports = exports; }

  private alloc(bytes: number): number {
    const start = this.cursor;
    this.cursor += Math.ceil(bytes / 8) * 8;
    if (!Number.isSafeInteger(this.cursor) || this.cursor > 32 * 1024 * 1024) {
      throw new RangeError('Terrain WASM scratch budget exceeded');
    }
    const memory = this.exports.memory;
    if (this.cursor > memory.buffer.byteLength) {
      memory.grow(Math.ceil((this.cursor - memory.buffer.byteLength) / 65536));
    }
    return start;
  }

  private copy(source: ArrayBufferView): number {
    const pointer = this.alloc(source.byteLength);
    new Uint8Array(this.exports.memory.buffer, pointer, source.byteLength)
      .set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
    return pointer;
  }

  private chunkBuffers() {
    const blocks = this.alloc(65536), colors = this.alloc(65536 * 4);
    this.exports.clearChunk(blocks, colors, DEFAULT_BLOCK_COLOR);
    return { blocks, colors };
  }

  selectSurfaceBatch(root: SurfaceSelection, visibleCount: number): Int32Array {
    this.cursor = 65536;
    root.parameters[7] = visibleCount;
    const h = this.copy(root.heights), m = this.copy(root.minima), e = this.copy(root.errors);
    const tx = this.copy(root.trigX), tz = this.copy(root.trigZ), d = this.copy(root.detail);
    const splits = this.copy(root.splits), work = this.copy(root.work), p = this.copy(root.parameters);
    const output = this.alloc(256 * 12);
    const count = this.exports.surfaceSelect(h, m, e, tx, tz, d, splits, work, p, output);
    const buffer = this.exports.memory.buffer;
    root.splits.set(new Uint8Array(buffer, splits, root.splits.length));
    root.work.set(new Int32Array(buffer, work, root.work.length));
    root.parameters[8] = new Float64Array(buffer, p, 9)[8];
    return new Int32Array(buffer, output, count * 3).slice();
  }

  meshMicroPartition(halo: Int32Array, height: number, minY: number, linear: Float64Array) {
    if (!Number.isInteger(height) || height < 1 || height > 16
      || halo.length !== 18 * 18 * (height + 2) || linear.length !== 256) {
      throw new RangeError('Invalid micro mesh partition');
    }
    this.cursor = 65536;
    const input = this.copy(halo), lookup = this.copy(linear);
    const capacity = 6 * 16 * 16 * height;
    const mask = this.alloc(16 * 16 * 4), quads = this.alloc(capacity * 32);
    const positions = this.alloc(capacity * 24), normals = this.alloc(capacity * 12);
    const colors = this.alloc(capacity * 12), indices = this.alloc(capacity * 24), counts = this.alloc(8);
    const count = this.exports.microMesh(input, height, minY, mask, quads, positions, normals, colors, indices, lookup, counts);
    const buffer = this.exports.memory.buffer;
    return {
      positions: new Uint16Array(buffer, positions, count * 12).slice(),
      normals: new Int8Array(buffer, normals, count * 12).slice(),
      colors: new Uint8Array(buffer, colors, count * 12).slice(),
      indices: count * 4 <= 65535 ? new Uint16Array(buffer, indices, count * 6).slice()
        : new Uint32Array(buffer, indices, count * 6).slice(),
      materialIndexCounts: Array.from(new Uint32Array(buffer, counts, 2)) as [number, number],
    };
  }

  meshStandardChunk(chunk: Chunk, neighbors: Uint16Array, minY: number, maxY: number, linear: Float64Array) {
    this.cursor = 65536;
    const blocks = this.copy(chunk.blocks), colors = this.copy(chunk.colors), materials = this.copy(chunk.materials);
    const halo = this.copy(neighbors), lookup = this.copy(linear);
    const faces = this.alloc(6 * 256 * (maxY - minY + 1) * 32), table = this.alloc(32768 * 16), counts = this.alloc(8);
    const faceCount = this.exports.standardFaces(blocks, colors, materials, halo, minY, maxY, faces, table, counts);
    const materialIndexCounts = Array.from(new Uint32Array(this.exports.memory.buffer, counts, 2)) as [number, number];
    const count = (materialIndexCounts[0] + materialIndexCounts[1]) / 6;
    const bounds = { occupiedMinY: minY, occupiedMaxY: maxY + 1, materialIndexCounts };
    if (!count) return { ...bounds, positions: null, normals: null, colors: null, indices: null };
    const positions = this.alloc(count * 24), normals = this.alloc(count * 12), outputColors = this.alloc(count * 12);
    const indices = this.alloc(count * 6 * (count * 4 <= 65535 ? 2 : 4));
    this.exports.standardMesh(faces, faceCount, count * 4, positions, normals, outputColors, indices, lookup);
    const buffer = this.exports.memory.buffer;
    return { ...bounds, positions: new Uint16Array(buffer, positions, count * 12).slice(),
      normals: new Int8Array(buffer, normals, count * 12).slice(), colors: new Uint8Array(buffer, outputColors, count * 12).slice(),
      indices: count * 4 <= 65535 ? new Uint16Array(buffer, indices, count * 6).slice() : new Uint32Array(buffer, indices, count * 6).slice() };
  }

  transformCollisionSamples(positions: Float64Array, owners: Uint32Array, matrices: Float64Array) {
    this.cursor = 65536;
    const points = this.copy(positions), ids = this.copy(owners), transforms = this.copy(matrices);
    const output = this.alloc(positions.byteLength);
    const count = this.exports.collisionSamples(points, ids, owners.length, transforms, output);
    return new Float64Array(this.exports.memory.buffer, output, count * 3).slice();
  }

  /** Own instance/arena: this table survives render yields and unrelated terrain calls. */
  createSurfaceConnections(cellCount: number, detail: Uint8Array): SurfaceConnectionKernel | null {
    if (!Number.isInteger(cellCount) || cellCount < 0 || cellCount > 524288) return null;
    if (detail.length !== 1024 * 128) throw new RangeError('Invalid surface ownership mask');
    const session = new TerrainKernels(new WebAssembly.Instance(compiledModule).exports as KernelExports);
    let capacity = 2;
    while (capacity < cellCount * 2) capacity *= 2;
    const table = session.alloc(capacity * 8), mask = capacity - 1;
    const ownership = session.copy(detail), input = session.alloc(128 * 16);
    const output = session.alloc(128 * 4 * 64 * 32);
    let added = 0;
    const put = (records: Int32Array) => {
      if (records.length % 4 || records.length > 128 * 4) throw new RangeError('Invalid connection batch');
      for (let i = 0; i < records.length; i += 4) {
        const x = records[i], z = records[i + 1], size = records[i + 2], height = records[i + 3];
        if (size < 1 || size > 64 || (size & (size - 1)) || x < 0 || x >= 16384 || z < 0 || z >= 2048
          || x % size || z % size || height < 0 || height > 65535) throw new RangeError('Invalid surface cell');
      }
      new Int32Array(session.exports.memory.buffer, input, records.length).set(records);
      return records.length / 4;
    };
    return {
      add(records: Int32Array) {
        const count = put(records);
        if (added + count > cellCount) throw new RangeError('Surface owner capacity exceeded');
        session.exports.surfaceOwners(table, mask, input, count);
        added += count;
      },
      edges(records: Int32Array) {
        const count = put(records);
        const written = session.exports.surfaceConnections(table, mask, ownership, input, count, output);
        return new Int32Array(session.exports.memory.buffer, output, written * 8).slice();
      },
    };
  }

  private installChunk(chunk: Chunk, blocks: number, colors: number, low: number, high: number, count = 65536) {
    chunk.blocks.set(new Uint8Array(this.exports.memory.buffer, blocks, count));
    chunk.colors.set(new Uint32Array(this.exports.memory.buffer, colors, count));
    chunk.setGeneratedOccupiedYRange(low, high);
    chunk.hasGenerated = true;
  }

  private heights(permutation: Uint8Array, x: number, z: number, axis: number, width: number, length: number) {
    const trigX = new Float64Array(axis * 2), trigZ = new Float64Array(axis * 2);
    for (let i = 0; i < axis; i++) {
      const theta = ((x + i) / width) * Math.PI * 2;
      const phi = ((z + i) / length) * Math.PI * 2;
      trigX[i * 2] = Math.cos(theta); trigX[i * 2 + 1] = Math.sin(theta);
      trigZ[i * 2] = Math.cos(phi); trigZ[i * 2 + 1] = Math.sin(phi);
    }
    const p = this.copy(permutation), tx = this.copy(trigX), tz = this.copy(trigZ);
    const output = this.alloc(axis * axis * 2);
    this.exports.natureHeights(p, tx, tz, output, axis, x, z, width, length);
    return output;
  }

  generateNature(chunk: Chunk, permutation: Uint8Array) {
    this.cursor = 65536;
    const { x, z } = chunk.getWorldOrigin();
    const heights = this.heights(permutation, x, z, 16, 16384, 2048);
    const count = 22 * 256;
    const blocks = this.alloc(count), colors = this.alloc(count * 4);
    const high = this.exports.fillNature(heights, blocks, colors, DEFAULT_BLOCK_COLOR);
    this.installChunk(chunk, blocks, colors, 0, high, count);
  }

  /** Box grammar stays shared TypeScript; rasterization and shell cells run in WASM. */
  rasterizeCopper(chunk: Chunk, solidOps: number[], microOps: number[]): Uint32Array {
    this.cursor = 65536;
    const solid = this.copy(Int32Array.from(solidOps)), micro = this.copy(Int32Array.from(microOps));
    const { blocks, colors } = this.chunkBuffers();
    this.exports.paintBoxes(solid, solidOps.length / 7, blocks, colors);
    let capacity = 0;
    for (let i = 0; i < microOps.length; i += 7) {
      capacity += Math.max(0, Math.min(128, microOps[i + 3]) - Math.max(0, microOps[i]))
        * Math.max(0, Math.min(2048, microOps[i + 4]) - Math.max(0, microOps[i + 1]))
        * Math.max(0, Math.min(128, microOps[i + 5]) - Math.max(0, microOps[i + 2]));
    }
    const output = this.alloc(capacity * 16);
    const count = this.exports.paintMicro(micro, microOps.length / 7, blocks, output);
    const bounds = this.exports.occupiedBounds(blocks);
    this.installChunk(chunk, blocks, colors, bounds >>> 16, (bounds & 65535) - 1);
    return new Uint32Array(this.exports.memory.buffer, output, count * 4).slice();
  }

  /** Input and output are X-major packed v5/v6 eight-byte surface records. */
  reduceSurfaceRecords(records: Uint8Array, axis: number): Uint8Array {
    if (axis < 2 || axis > 512 || axis % 2 || records.byteLength !== axis * axis * 8) {
      throw new RangeError('Invalid surface lattice');
    }
    this.cursor = 65536;
    const input = this.copy(records), output = this.alloc(records.length / 4);
    this.exports.reduceSurfaceBytes(input, output, axis);
    return new Uint8Array(this.exports.memory.buffer, output, records.length / 4).slice();
  }

  buildSurfaceMips(zone: SurfaceZoneSnapshot, srgb: Uint8Array): Map<number, SurfaceMip> {
    this.cursor = 65536;
    const size = zone.sampleSize ?? 2, axis = 512 / size, count = axis * axis;
    if (![1, 2, 4, 8, 16, 32, 64].includes(size)
      || zone.heightsMicro.length !== count || zone.colors.length !== count * 3
      || (zone.minHeightsMicro && zone.minHeightsMicro.length !== count)
      || (zone.colorErrors && zone.colorErrors.length !== count) || srgb.length !== 256) {
      throw new RangeError('Invalid surface snapshot');
    }
    const h = this.copy(zone.heightsMicro), c = this.copy(zone.colors);
    const m = zone.minHeightsMicro ? this.copy(zone.minHeightsMicro) : 0;
    const e = zone.colorErrors ? this.copy(zone.colorErrors) : 0;
    const lookup = this.copy(srgb);
    const allocate = (n: number) => [this.alloc(n * 2), this.alloc(n * 3), this.alloc(n * 2), this.alloc(n * 4)];
    let pointers = allocate(count);
    let residual = this.exports.surfaceBase(h, c, m, e, lookup, ...pointers, axis, size,
      zone.sampleSize === undefined ? 1 : 0);
    const mips = new Map<number, SurfaceMip>();
    for (let cellSize = size, currentAxis = axis; cellSize <= 64; cellSize *= 2, currentAxis /= 2) {
      if (cellSize !== size) {
        const next = allocate(currentAxis * currentAxis);
        residual = this.exports.reduceSurface(...pointers, ...next, currentAxis * 2, cellSize);
        pointers = next;
      }
      const n = currentAxis * currentAxis, buffer = this.exports.memory.buffer;
      mips.set(cellSize, {
        cellSize, axis: currentAxis,
        heights: new Uint16Array(buffer, pointers[0], n).slice(),
        colors: new Uint8Array(buffer, pointers[1], n * 3).slice(),
        minHeights: new Uint16Array(buffer, pointers[2], n).slice(),
        colorErrors: new Float32Array(buffer, pointers[3], n).slice(),
        maxResidual: residual,
      });
    }
    return mips;
  }
}
