import { TERRAIN_KERNEL_BASE64 } from './TerrainKernelBinary.ts';
import { DEFAULT_BLOCK_COLOR } from '../voxel/BlockTypes.ts';
import type { Chunk } from '../voxel/Chunk.ts';
import type { SurfaceZoneSnapshot } from '../voxel/SurfaceZoneSnapshot.ts';

export interface SurfaceMip {
  cellSize: number;
  axis: number;
  heights: Uint16Array;
  colors: Uint8Array;
  minHeights: Uint16Array;
  colorErrors: Float32Array;
  maxResidual?: number;
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
};

export type TerrainKernelMode = 'auto' | 'js' | 'wasm';
let mode: TerrainKernelMode = typeof process !== 'undefined' && process.env.SPACE_TERRAIN_BACKEND === 'js'
  ? 'js' : 'auto';
let instance: TerrainKernels | undefined;
let initializationError: unknown;

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
      const exports = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports as KernelExports;
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
