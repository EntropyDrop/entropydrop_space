export const VoxelMaterialIds = Object.freeze({
  DEFAULT: 0,
  EMISSIVE: 1,
} as const);

export type VoxelMaterialId = typeof VoxelMaterialIds[keyof typeof VoxelMaterialIds];

// Cinematic bloom starts above 2.2; this keeps emissive voxels visibly bright
// without allocating one real-time light per voxel.
export const VOXEL_EMISSIVE_INTENSITY = 3;

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
