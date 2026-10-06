import * as THREE from 'three';
import { GEOMETRY_KERNEL_BASE64 } from './GeometryKernelBinary.ts';

export type GeometryKernelMode = 'auto' | 'js' | 'wasm';
export type GeometryExports = {
  memory: WebAssembly.Memory;
  abiVersion(): number;
  rayQuads(...args: number[]): void;
  obbContacts(...args: number[]): void;
  modelFill(...args: number[]): void;
  modelHollow(...args: number[]): void;
  modelNearest(...args: number[]): number;
  solveJoints(...args: number[]): void;
  solvePairImpulse(...args: number[]): number;
  solveTerrainImpulse(...args: number[]): number;
  toppleSupport(...args: number[]): void;
};
export type NumericObb = { center: { x: number; y: number; z: number };
  axes: { x: number; y: number; z: number }[]; halfExtents: number[] };
export type NumericBounds = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
export type GeometryContact = { normal: THREE.Vector3; penetration: number;
  featurePoint?: THREE.Vector3; faceSupport?: boolean; hitPosition?: THREE.Vector3 };

const configuredMode = typeof process !== 'undefined' ? process.env.SPACE_GEOMETRY_BACKEND : undefined;
let mode: GeometryKernelMode = configuredMode === 'js' || configuredMode === 'wasm' ? configuredMode : 'auto';
let compiled: WebAssembly.Module | undefined;
let initializationError: unknown;
let shared: GeometryKernels | undefined;
const imports = { math: { sin: Math.sin, cos: Math.cos, atan2: Math.atan2 } };

/** Diagnostic override only. Both paths retain the same host-side algorithms. */
export function setGeometryKernelMode(value: GeometryKernelMode) {
  const previous = mode; mode = value; return previous;
}

function moduleForGeometry(): WebAssembly.Module | null {
  if (mode === 'js') return null;
  if (!compiled && !initializationError) {
    try {
      const bytes = Uint8Array.from(atob(GEOMETRY_KERNEL_BASE64), c => c.charCodeAt(0));
      const candidate = new WebAssembly.Module(bytes);
      if (WebAssembly.Module.imports(candidate).some(i => i.module !== 'math' || i.kind !== 'function'
        || !['sin', 'cos', 'atan2'].includes(i.name))) throw new Error('Unexpected geometry kernel import');
      const exports = new WebAssembly.Instance(candidate, imports).exports as GeometryExports;
      if (exports.abiVersion() !== 2) throw new Error('Geometry WASM ABI mismatch');
      compiled = candidate;
    } catch (error) {
      initializationError = error;
      console.warn('Geometry WASM unavailable; using JavaScript kernels.', error);
    }
  }
  if (initializationError && mode === 'wasm') throw initializationError;
  return compiled ?? null;
}

/** Separate arena for persistent model jobs; no views survive a growth/call. */
export class GeometryArena {
  readonly exports: GeometryExports;
  private readonly limit: number;
  constructor(module: WebAssembly.Module, limit: number) {
    this.exports = new WebAssembly.Instance(module, imports).exports as GeometryExports;
    this.limit = limit;
  }
  reserve(end: number) {
    if (!Number.isSafeInteger(end) || end < 65536 || end > this.limit) throw new RangeError('Geometry WASM scratch budget exceeded');
    const missing = end - this.exports.memory.buffer.byteLength;
    if (missing > 0) this.exports.memory.grow(Math.ceil(missing / 65536));
  }
}

export function createGeometryArena(limit = 32 * 1024 * 1024): GeometryArena | null {
  if (!Number.isSafeInteger(limit) || limit < 65536 || limit > 128 * 1024 * 1024) throw new RangeError('Invalid geometry arena limit');
  const module = moduleForGeometry();
  return module ? new GeometryArena(module, limit) : null;
}

export function getGeometryKernels(): GeometryKernels | null {
  const module = moduleForGeometry();
  if (!module) return null;
  return shared ??= new GeometryKernels(new GeometryArena(module, 32 * 1024 * 1024));
}

function packObb(data: Float64Array, offset: number, box: NumericObb) {
  data[offset] = box.center.x; data[offset + 1] = box.center.y; data[offset + 2] = box.center.z;
  for (let i = 0; i < 3; i++) {
    data[offset + 3 + i * 3] = box.axes[i].x;
    data[offset + 4 + i * 3] = box.axes[i].y;
    data[offset + 5 + i * 3] = box.axes[i].z;
    data[offset + 12 + i] = box.halfExtents[i];
  }
}

export class GeometryKernels {
  private readonly arena: GeometryArena;
  constructor(arena: GeometryArena) { this.arena = arena; }

  /** Flat [quad, triangle, baryA, baryB, baryC, distance], or no intersection. */
  rayQuads(quads: Float64Array, origin: THREE.Vector3, direction: THREE.Vector3, distance: number): Float64Array | null {
    if (quads.length % 12) throw new RangeError('Invalid picking quads');
    const batch = 4096, input = 65536, ray = input + batch * 96, output = ray + 48;
    this.arena.reserve(output + 48);
    const exports = this.arena.exports, buffer = exports.memory.buffer;
    new Float64Array(buffer, ray, 6).set([origin.x, origin.y, origin.z, direction.x, direction.y, direction.z]);
    let result: Float64Array | null = null;
    for (let start = 0; start < quads.length / 12; start += batch) {
      const count = Math.min(batch, quads.length / 12 - start);
      new Float64Array(buffer, input, count * 12).set(quads.subarray(start * 12, (start + count) * 12));
      exports.rayQuads(input, count, ray, output, distance);
      const hit = new Float64Array(buffer, output, 6);
      if (hit[0] >= 0) { result = hit.slice(); result[0] += start; distance = result[5]; }
    }
    return result;
  }

  obbContacts(first: readonly (NumericObb | null)[], second: readonly (NumericObb | null)[], terrain?: false): ((GeometryContact & {featurePoint: THREE.Vector3; faceSupport: boolean}) | null)[];
  obbContacts(first: readonly (NumericObb | null)[], second: readonly (NumericBounds | null)[], terrain: true): ((GeometryContact & {hitPosition: THREE.Vector3}) | null)[];
  /** Batches preserve pair order. Only surviving contacts become Three objects. */
  obbContacts(first: readonly (NumericObb | null)[], second: readonly (NumericObb | NumericBounds | null)[], terrain = false): (GeometryContact | null)[] {
    if (first.length !== second.length) throw new RangeError('Invalid collision batch');
    const batch = 1024, input = 65536, output = input + batch * 240;
    this.arena.reserve(output + batch * 64);
    const exports = this.arena.exports, buffer = exports.memory.buffer;
    const data = new Float64Array(buffer, input, batch * 30), results = new Float64Array(buffer, output, batch * 8);
    const contacts: (GeometryContact | null)[] = new Array(first.length).fill(null);
    for (let start = 0; start < first.length; start += batch) {
      const count = Math.min(batch, first.length - start);
      for (let i = 0; i < count; i++) {
        const a = first[start + i], b = second[start + i];
        const offset = i * 30;
        if (!a || !b) { data.fill(0, offset, offset + 30); continue; }
        packObb(data, offset, a);
        if (!terrain) packObb(data, offset + 15, b as NumericObb);
        else {
          const bounds = b as NumericBounds;
          data[offset + 15] = (bounds.minX + bounds.maxX) / 2;
          data[offset + 16] = (bounds.minY + bounds.maxY) / 2;
          data[offset + 17] = (bounds.minZ + bounds.maxZ) / 2;
          data.fill(0, offset + 18, offset + 27);
          data[offset + 18] = data[offset + 22] = data[offset + 26] = 1;
          data[offset + 27] = (bounds.maxX - bounds.minX) / 2;
          data[offset + 28] = (bounds.maxY - bounds.minY) / 2;
          data[offset + 29] = (bounds.maxZ - bounds.minZ) / 2;
        }
      }
      exports.obbContacts(input, count, output, terrain ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const offset = i * 8, depth = results[offset + 3];
        if (!(depth > 0)) continue;
        const normal = new THREE.Vector3(results[offset], results[offset + 1], results[offset + 2]);
        const point = new THREE.Vector3(results[offset + 4], results[offset + 5], results[offset + 6]);
        contacts[start + i] = terrain ? { normal, penetration: depth, hitPosition: point }
          : { normal, penetration: depth, featurePoint: point, faceSupport: results[offset + 7] === 1 };
      }
    }
    return contacts;
  }
}
