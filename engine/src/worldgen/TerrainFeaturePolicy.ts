/** Optional world-space footprint test for composing complete terrain features.
 * Standalone worlds omit it and retain their original terrain-lab geometry. */
export interface TerrainFeaturePolicy {
  placement?: (x: number, z: number, radius: number) => boolean;
}

export const acceptsTerrainFeature = (config: TerrainFeaturePolicy, x: number, z: number, radius: number) =>
  config.placement?.(x, z, radius) ?? true;
