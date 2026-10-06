import type { InventoryVoxel } from '@entropydrop/space-engine/storage/InventoryTypes.ts';
import { MICRO_DIVISIONS, MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';

interface RotatableChild { position?: { x: number; y: number; z: number } }

export function normalizeQuarterTurns(turns = 0) {
  const wholeTurns = Number.isFinite(turns) ? Math.trunc(turns) : 0;
  return ((wholeTurns % 4) + 4) % 4;
}

/**
 * Rotate a set of voxel blocks around the X axis by `quarterTurns * 90°`.
 * The result is calculated directly from the supplied original coordinates,
 * never by repeatedly rotating an already rounded intermediate result.
 */
export function rotateBlocksX90(blocks: InventoryVoxel[], quarterTurns = 1) {
  if (!Array.isArray(blocks) || blocks.length === 0) return blocks;

  const turns = normalizeQuarterTurns(quarterTurns);
  if (turns === 0) return blocks.map(block => ({ ...block }));

  const isEntity = 'localX' in blocks[0] || 'localY' in blocks[0];
  const hasMicro = blocks.some(b => (b.size && b.size < 1) || (isEntity ? (!Number.isInteger(b.localY ?? 0) || !Number.isInteger(b.localZ ?? 0)) : (!Number.isInteger(b.dy ?? 0) || !Number.isInteger(b.dz ?? 0))));
  const S = hasMicro ? MICRO_SIZE : 1.0;

  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (const b of blocks) {
    const y = isEntity ? (b.localY ?? 0) : (b.dy ?? 0);
    const z = isEntity ? (b.localZ ?? 0) : (b.dz ?? 0);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;

  const rotatePoint = (y: number, z: number) => {
    if (turns === 1) return [cy + cz - z, cz - cy + y];
    if (turns === 2) return [2 * cy - y, 2 * cz - z];
    return [cy - cz + z, cz + cy - y];
  };

  // Rotating an even-height/depth shape around its geometric center can land its
  // lower-corner coordinates on half cells. Apply one deterministic grid
  // correction derived from the original bounds for this final orientation.
  const [sampleY, sampleZ] = rotatePoint(minY, minZ);
  const gridUnitsY = sampleY / S;
  const gridUnitsZ = sampleZ / S;
  const remY = (gridUnitsY - Math.round(gridUnitsY)) * S;
  const remZ = (gridUnitsZ - Math.round(gridUnitsZ)) * S;

  return blocks.map(b => {
    const y = isEntity ? (b.localY ?? 0) : (b.dy ?? 0);
    const z = isEntity ? (b.localZ ?? 0) : (b.dz ?? 0);

    const rotated = rotatePoint(y, z);
    let ry = rotated[0] - remY;
    let rz = rotated[1] - remZ;

    if (hasMicro) {
      ry = Math.round(ry * MICRO_DIVISIONS) / MICRO_DIVISIONS;
      rz = Math.round(rz * MICRO_DIVISIONS) / MICRO_DIVISIONS;
    } else {
      ry = Math.round(ry);
      rz = Math.round(rz);
    }

    if (isEntity) {
      return { ...b, localY: ry, localZ: rz };
    } else {
      return { ...b, dy: ry, dz: rz };
    }
  });
}

/**
 * Rotate a set of voxel blocks around the Y axis by `quarterTurns * 90°`.
 * The result is calculated directly from the supplied original coordinates,
 * never by repeatedly rotating an already rounded intermediate result.
 */
export function rotateBlocksY90(blocks: InventoryVoxel[], quarterTurns = 1) {
  if (!Array.isArray(blocks) || blocks.length === 0) return blocks;

  const turns = normalizeQuarterTurns(quarterTurns);
  if (turns === 0) return blocks.map(block => ({ ...block }));

  const isEntity = 'localX' in blocks[0];
  const hasMicro = blocks.some(b => (b.size && b.size < 1) || (isEntity ? (!Number.isInteger(b.localX ?? 0) || !Number.isInteger(b.localZ ?? 0)) : (!Number.isInteger(b.dx ?? 0) || !Number.isInteger(b.dz ?? 0))));
  const S = hasMicro ? MICRO_SIZE : 1.0;

  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (const b of blocks) {
    const x = isEntity ? (b.localX ?? 0) : (b.dx ?? 0);
    const z = isEntity ? (b.localZ ?? 0) : (b.dz ?? 0);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;

  const rotatePoint = (x: number, z: number) => {
    if (turns === 1) return [cx + cz - z, cz - cx + x];
    if (turns === 2) return [2 * cx - x, 2 * cz - z];
    return [cx - cz + z, cz + cx - x];
  };

  // Rotating an even-width shape around its geometric center can land its
  // lower-corner coordinates on half cells. Apply one deterministic grid
  // correction derived from the original bounds for this final orientation.
  const [sampleX, sampleZ] = rotatePoint(minX, minZ);
  const gridUnitsX = sampleX / S;
  const gridUnitsZ = sampleZ / S;
  const remX = (gridUnitsX - Math.round(gridUnitsX)) * S;
  const remZ = (gridUnitsZ - Math.round(gridUnitsZ)) * S;

  return blocks.map(b => {
    const x = isEntity ? (b.localX ?? 0) : (b.dx ?? 0);
    const z = isEntity ? (b.localZ ?? 0) : (b.dz ?? 0);

    const rotated = rotatePoint(x, z);
    let rx = rotated[0] - remX;
    let rz = rotated[1] - remZ;

    if (hasMicro) {
      rx = Math.round(rx * MICRO_DIVISIONS) / MICRO_DIVISIONS;
      rz = Math.round(rz * MICRO_DIVISIONS) / MICRO_DIVISIONS;
    } else {
      rx = Math.round(rx);
      rz = Math.round(rz);
    }

    if (isEntity) {
      return { ...b, localX: rx, localZ: rz };
    } else {
      return { ...b, dx: rx, dz: rz };
    }
  });
}

/**
 * Rotate child entity definitions around the same center (cy, cz).
 */
export function rotateChildDefinitionsX90<T extends RotatableChild>(childEntities: T[], quarterTurns = 1, center: { cy: number; cz: number } | null = null) {
  if (!Array.isArray(childEntities) || childEntities.length === 0) return childEntities;
  const turns = normalizeQuarterTurns(quarterTurns);
  if (turns === 0) return childEntities.map(child => ({
    ...child,
    position: child.position ? { ...child.position } : child.position
  }));
  return childEntities.map(child => {
    const pos = child.position || { x: 0, y: 0, z: 0 };
    const cy = center ? center.cy : 0;
    const cz = center ? center.cz : 0;
    const ry = turns === 1
      ? cy + cz - pos.z
      : turns === 2
        ? 2 * cy - pos.y
        : cy - cz + pos.z;
    const rz = turns === 1
      ? cz - cy + pos.y
      : turns === 2
        ? 2 * cz - pos.z
        : cz + cy - pos.y;
    return {
      ...child,
      position: {
        x: pos.x,
        y: Math.round(ry * MICRO_DIVISIONS) / MICRO_DIVISIONS,
        z: Math.round(rz * MICRO_DIVISIONS) / MICRO_DIVISIONS
      }
    };
  });
}

/**
 * Rotate child entity definitions around the same center (cx, cz).
 */
export function rotateChildDefinitionsY90<T extends RotatableChild>(childEntities: T[], quarterTurns = 1, center: { cx: number; cz: number } | null = null) {
  if (!Array.isArray(childEntities) || childEntities.length === 0) return childEntities;
  const turns = normalizeQuarterTurns(quarterTurns);
  if (turns === 0) return childEntities.map(child => ({
    ...child,
    position: child.position ? { ...child.position } : child.position
  }));
  return childEntities.map(child => {
    const pos = child.position || { x: 0, y: 0, z: 0 };
    const cx = center ? center.cx : 0;
    const cz = center ? center.cz : 0;
    const rx = turns === 1
      ? cx + cz - pos.z
      : turns === 2
        ? 2 * cx - pos.x
        : cx - cz + pos.z;
    const rz = turns === 1
      ? cz - cx + pos.x
      : turns === 2
        ? 2 * cz - pos.z
        : cz + cx - pos.x;
    return {
      ...child,
      position: {
        x: Math.round(rx * MICRO_DIVISIONS) / MICRO_DIVISIONS,
        y: pos.y,
        z: Math.round(rz * MICRO_DIVISIONS) / MICRO_DIVISIONS
      }
    };
  });
}
