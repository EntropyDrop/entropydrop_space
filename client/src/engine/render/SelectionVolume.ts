import type { CollisionBounds } from '@entropydrop/space-engine/physics/CollisionGeometry.ts';
import { MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import type { Point3 } from './PreviewTypes.ts';

export function selectionVolumeBounds(bounds: CollisionBounds, micro: boolean): CollisionBounds {
  const scale = micro ? MICRO_SIZE : 1;
  return { minX: bounds.minX * scale, minY: bounds.minY * scale, minZ: bounds.minZ * scale,
    maxX: (bounds.maxX + 1) * scale, maxY: (bounds.maxY + 1) * scale, maxZ: (bounds.maxZ + 1) * scale };
}

/** Preview every cell in the selected shape, including air, without changing action data. */
export function collectSelectionVolumeBoxes(bounds: CollisionBounds, cells: readonly Point3[] | null, micro: boolean): CollisionBounds[] {
  // Keep a box compact; the geometry builder tessellates only its six surfaces.
  if (cells === null) return [selectionVolumeBounds(bounds, micro)];
  const scale = micro ? MICRO_SIZE : 1;
  const boxes: CollisionBounds[] = [];
  for (const { x, y, z } of cells) {
    if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY || z < bounds.minZ || z > bounds.maxZ) continue;
    boxes.push({ minX: x * scale, minY: y * scale, minZ: z * scale,
      maxX: (x + 1) * scale, maxY: (y + 1) * scale, maxZ: (z + 1) * scale });
  }
  return boxes;
}
