export interface SurfaceZoneSnapshot {
  /** v4/v5 use a zone-wide X-major lattice; absent for legacy chunk-major data. */
  sampleSize?: number;
  zoneX: number;
  zoneZ: number;
  seed: number;
  terrainGeneratorVersion: number;
  sourceTerrainRevision: number;
  zoneSizeChunks: number;
  samplesPerChunkAxis: number;
  heightsMicro: Uint16Array;
  colors: Uint8Array;
  /** Conservative errors measured from the finest source, including in downloaded mips. */
  minHeightsMicro?: Uint16Array;
  colorErrors?: Uint8Array;
  /** Full vertical occupancy for authored chunks, independent of terrain LOD. */
  detailChunks?: DistantChunkSnapshot[];
}

export interface DistantChunkSnapshot {
  chunkX: number;
  chunkZ: number;
  revision: number;
  /** Chunk-local micro units: x, bottom, z, width, height, depth per solid run. */
  boxes: Uint16Array;
  colors: Uint8Array;
}
