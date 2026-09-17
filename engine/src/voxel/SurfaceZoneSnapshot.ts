export interface SurfaceZoneSnapshot {
  /** v4 uses a zone-wide X-major lattice; absent for legacy chunk-major data. */
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
}
