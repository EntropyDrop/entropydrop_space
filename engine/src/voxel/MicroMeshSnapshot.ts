import { getTerrainKernels } from '../wasm/TerrainKernels.ts';

export type MicroMeshSnapshot = {
  requestId: number;
  height: number;
  minY: number;
  /** Sparse pairs of halo index and material/color token + 1. */
  cells: Uint32Array;
  linear: Float64Array;
};

export type MicroMeshData = {
  positions: Uint16Array;
  normals: Int8Array;
  colors: Uint8Array;
  indices: Uint16Array | Uint32Array;
  materialIndexCounts: [number, number];
};

export type MicroMeshResult = {
  requestId: number;
  mesh?: MicroMeshData;
  error?: string;
};

/** Pure worker input: no live world, Three objects or shared WASM arena views. */
export function buildMicroMeshSnapshot(snapshot: MicroMeshSnapshot): MicroMeshData {
  const kernels = getTerrainKernels();
  if (!kernels) throw new Error('Micro mesh WASM is unavailable');
  const { height, minY, cells, linear } = snapshot;
  if (!Number.isInteger(height) || height < 1 || height > 16 || cells.length % 2) {
    throw new RangeError('Invalid micro mesh snapshot');
  }
  const halo = new Int32Array(18 * 18 * (height + 2));
  for (let i = 0; i < cells.length; i += 2) halo[cells[i]] = cells[i + 1];
  return kernels.meshMicroPartition(halo, height, minY, linear);
}
