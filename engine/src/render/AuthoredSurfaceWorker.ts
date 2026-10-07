import { buildAuthoredSurface } from './AuthoredSurfaceMesher.ts';
import type { DistantChunkSnapshot } from '../voxel/SurfaceZoneSnapshot.ts';

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<{source: DistantChunkSnapshot; cellSize: number}>) => void) | null;
  postMessage(value: unknown, transfer?: ArrayBuffer[]): void };
scope.onmessage = ({data}) => {
  try {
    const mesh = buildAuthoredSurface(data.source, data.cellSize);
    scope.postMessage({mesh}, [mesh.positions.buffer,mesh.normals.buffer,mesh.colors.buffer,mesh.indices.buffer] as ArrayBuffer[]);
  } catch (error) { scope.postMessage({error:String(error)}); }
};
