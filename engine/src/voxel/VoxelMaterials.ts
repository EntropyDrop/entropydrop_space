export const VoxelMaterialIds = Object.freeze({
  DEFAULT: 0,
  EMISSIVE: 1,
} as const);

export type VoxelMaterialId = typeof VoxelMaterialIds[keyof typeof VoxelMaterialIds];

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
    || (materialId !== VoxelMaterialIds.DEFAULT && materialId !== VoxelMaterialIds.EMISSIVE)) {
    throw new Error('Voxel materialId must be 0 (default) or 1 (emissive).');
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
