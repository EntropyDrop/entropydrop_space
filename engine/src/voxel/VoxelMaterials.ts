export const VoxelMaterialIds = Object.freeze({
  DEFAULT: 0,
  EMISSIVE: 1,
  TRANSLUCENT_MIN: 2,
  TRANSLUCENT_MAX: 101,
  // Default glass: 60% transparent, matching the original 40% opacity preset.
  TRANSLUCENT: 61,
} as const);

export type VoxelMaterialId = number;

export function isTranslucentVoxelMaterial(materialId: number | undefined): boolean {
  return materialId !== undefined && materialId >= 2 && materialId <= 101;
}

/** Material IDs 2..101 encode transparency percentages 1..100; 0/1 are opaque. */
export function voxelMaterialTransparency(materialId: number): number {
  return isTranslucentVoxelMaterial(materialId) ? materialId - 1 : 0;
}

/** Three render buckets, regardless of how many authored transparency IDs exist. */
export function voxelMaterialRenderBucket(materialId: number): number {
  return materialId >= 2 ? 2 : materialId;
}

/** RGBA8 uses its previously padded alpha byte to hold integer opacity percent.
 * Ordinary lit vertices keep alpha=255 for Three's built-in vertex color path. */
export function voxelMaterialOpacityByte(materialId: number): number {
  return isTranslucentVoxelMaterial(materialId) ? 101 - materialId : 255;
}

export function voxelMaterialOpacity(materialId: number): number {
  return isTranslucentVoxelMaterial(materialId) ? (101 - materialId) / 100 : 1;
}

// Target linear luminance of the bloom source, independent of tint.
// This is self-illumination, without allocating one real-time light per voxel.
export const VOXEL_EMISSIVE_INTENSITY = 1.5;

// A luminous surface needs its own radiance, including for dark palette tints.
// Keep it below the halo source so tone mapping leaves a soft colored core.
export const VOXEL_EMISSIVE_SURFACE_LUMINANCE = 0.65;

export function parseVoxelMaterialId(value: unknown): VoxelMaterialId {
  const materialId = value === undefined || value === null
    ? VoxelMaterialIds.DEFAULT
    : Number(value);
  if (!Number.isInteger(materialId)
    || materialId < VoxelMaterialIds.DEFAULT || materialId > VoxelMaterialIds.TRANSLUCENT_MAX) {
    throw new Error('Voxel materialId must be 0 (default), 1 (emissive), or 2–101 (1–100% transparency).');
  }
  return materialId as VoxelMaterialId;
}

export function normalizeVoxelMaterialId(value: unknown): VoxelMaterialId {
  try {
    return parseVoxelMaterialId(value);
  } catch {
    return VoxelMaterialIds.DEFAULT;
  }
}
