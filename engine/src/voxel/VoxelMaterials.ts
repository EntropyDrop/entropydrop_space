export const VoxelMaterialIds = Object.freeze({
  DEFAULT: 0,
  // Reserved original emissive ID kept for backward compatibility; renders as 50% glow (151).
  LEGACY_EMISSIVE: 1,
  TRANSLUCENT_MIN: 2,
  TRANSLUCENT_MAX: 101,
  // Default glass: 60% transparent, matching the original 40% opacity preset.
  TRANSLUCENT: 61,
  EMISSIVE_MIN: 102,
  EMISSIVE_MAX: 201,
  // Default glow: 50%, matching the legacy emissive preset (1).
  EMISSIVE: 151,
} as const);

export type VoxelMaterialId = number;

export function isTranslucentVoxelMaterial(materialId: number | undefined): boolean {
  return materialId !== undefined && materialId >= 2 && materialId <= 101;
}

export function isEmissiveVoxelMaterial(materialId: number | undefined): boolean {
  return materialId !== undefined
    && (materialId === VoxelMaterialIds.LEGACY_EMISSIVE || (materialId >= 102 && materialId <= 201));
}

/** Material IDs 2..101 encode transparency percentages 1..100; other IDs are opaque. */
export function voxelMaterialTransparency(materialId: number): number {
  return isTranslucentVoxelMaterial(materialId) ? materialId - 1 : 0;
}

/** Material IDs 102..201 encode glow percentages 1..100; reserved ID 1 renders as 50%. */
export function voxelMaterialEmission(materialId: number): number {
  if (materialId === VoxelMaterialIds.LEGACY_EMISSIVE) return 50;
  return materialId >= 102 && materialId <= 201 ? materialId - 101 : 0;
}

/** Relative emission strength: 50% glow (and reserved ID 1) = 1.0, 100% glow = 2.0. */
export function voxelMaterialEmissionStrength(materialId: number): number {
  return voxelMaterialEmission(materialId) / 50;
}

/** Map 0..100 glow percentage to material ID (0 = DEFAULT, 1..100 = 102..201). */
export function emissiveVoxelMaterialId(level: number): VoxelMaterialId {
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  return clamped === 0 ? VoxelMaterialIds.DEFAULT : clamped + 101;
}

/** Migrate reserved legacy emissive ID (1) to the canonical 50% glow ID (151). */
export function migrateLegacyVoxelMaterialId(materialId: number): VoxelMaterialId {
  return materialId === VoxelMaterialIds.LEGACY_EMISSIVE ? VoxelMaterialIds.EMISSIVE : materialId;
}

/** Three render buckets: 0 lit opaque, 1 emissive, 2 translucent. */
export function voxelMaterialRenderBucket(materialId: number): number {
  if (isEmissiveVoxelMaterial(materialId)) return 1;
  if (isTranslucentVoxelMaterial(materialId)) return 2;
  return 0;
}

/** RGBA8 alpha byte carries integer opacity (0..99) for glass, glow level (1..100) for emissive, or 255 for lit. */
export function voxelMaterialAlphaByte(materialId: number): number {
  if (isTranslucentVoxelMaterial(materialId)) return 101 - materialId;
  if (isEmissiveVoxelMaterial(materialId)) return voxelMaterialEmission(materialId);
  return 255;
}

/** RGBA8 opacity byte for translucent glass (0..99); non-translucent vertices use 255. */
export function voxelMaterialOpacityByte(materialId: number): number {
  return isTranslucentVoxelMaterial(materialId) ? 101 - materialId : 255;
}

export function voxelMaterialOpacity(materialId: number): number {
  return isTranslucentVoxelMaterial(materialId) ? (101 - materialId) / 100 : 1;
}

// Target linear luminance of the bloom source at 50% glow (strength 1.0), independent of tint.
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
    || materialId < VoxelMaterialIds.DEFAULT || materialId > VoxelMaterialIds.EMISSIVE_MAX) {
    throw new Error('Voxel materialId must be 0 (default), 1 (reserved emissive), 2–101 (1–100% transparency), or 102–201 (1–100% glow).');
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
