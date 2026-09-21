import type { SurfaceMip } from './TerrainKernels.ts';

export interface SurfaceSelection {
  heights: Uint16Array;
  minima: Uint16Array;
  errors: Float32Array;
  trigX: Float64Array;
  trigZ: Float64Array;
  detail: Uint8Array;
  splits: Uint8Array;
  work: Int32Array;
  parameters: Float64Array;
}

const xAngles = new Map<number, Float64Array>(), zAngles = new Map<number, Float64Array>();
function angles(origin: number, period: number, cache: Map<number, Float64Array>) {
  let values = cache.get(origin);
  if (values) return values;
  values = new Float64Array(129 * 2);
  for (let i = 0; i <= 128; i++) {
    const angle = (origin + i / 2) * ((Math.PI * 2) / period);
    values[i * 2] = Math.cos(angle); values[i * 2 + 1] = Math.sin(angle);
  }
  cache.set(origin, values);
  return values;
}

/** Breadth-level index inside an aligned 64m root, shared with the JS oracle. */
export function surfaceNodeIndex(x: number, z: number, size: number) {
  const axis = 64 / size;
  return (axis * axis - 1) / 3 + Math.floor((x % 64) / size) * axis + Math.floor((z % 64) / size);
}

export function prepareSurfaceSelection(mips: Map<number, SurfaceMip>, sampleSize: number,
  localX: number, localZ: number, worldX: number, worldZ: number, mask: Uint8Array,
  splits: Uint8Array, camera: { x: number; y: number; z: number },
  maxDistance: number, screenError: number, pixelScale: number): SurfaceSelection {
  const nodeCount = (4 * (64 / sampleSize) ** 2 - 1) / 3;
  const heights = new Uint16Array(nodeCount), minima = new Uint16Array(nodeCount), errors = new Float32Array(nodeCount);
  for (let size = 64; size >= sampleSize; size /= 2) {
    const mip = mips.get(Math.max(size, sampleSize))!, axis = 64 / size;
    const offset = (axis * axis - 1) / 3;
    for (let x = 0; x < axis; x++) for (let z = 0; z < axis; z++) {
      const source = Math.floor((localX + x * size) / mip.cellSize) * mip.axis + Math.floor((localZ + z * size) / mip.cellSize);
      const target = offset + x * axis + z;
      heights[target] = mip.heights[source]; minima[target] = mip.minHeights[source]; errors[target] = mip.colorErrors[source];
    }
  }
  // Evaluate transcendental functions in the same JS runtime as bendPoint.
  const trigX = angles(worldX, 16384, xAngles), trigZ = angles(worldZ, 2048, zAngles);
  const detail = new Uint8Array(36);
  for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) {
    detail[x * 6 + z] = mask[((worldZ / 16 + z - 1) & 127) * 1024 + ((worldX / 16 + x - 1) & 1023)];
  }
  const work = new Int32Array(64);
  work.set([3, 0, 0, 64]);
  return { heights, minima, errors, trigX, trigZ, detail, splits, work,
    parameters: new Float64Array([camera.x, camera.y, camera.z, maxDistance, screenError, pixelScale, sampleSize, 0, Infinity]) };
}
