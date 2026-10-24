import * as THREE from 'three';
import type { InventoryInput } from '@entropydrop/space-engine/storage/InventoryTypes.ts';
import { normalizeColor } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { normalizeVoxelMaterialId } from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';
import { getInventoryPreviewBlocks, STOPPED_GRID_EPSILON, type InventoryPreviewBlock } from './InventoryGeometry.ts';

export const INVENTORY_PREVIEW_DETAIL_LIMIT = 200;

/** Display geometry only. Placement and construction keep their exact voxels. */
export function getInventoryRenderPreviewBlocks(
  slot: InventoryInput | null | undefined,
  detailLimit = INVENTORY_PREVIEW_DETAIL_LIMIT
): InventoryPreviewBlock[] {
  const entries = getInventoryPreviewBlocks(slot, true);
  if (entries.length <= detailLimit) return entries;

  const cells = new Map<string, {
    center: THREE.Vector3;
    weight: number;
    r: number; g: number; b: number;
    materials: Map<number, number>;
  }>();
  const unitBox = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  const bounds = new THREE.Box3();
  const transform = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();

  for (const entry of entries) {
    if (entry.scale) scale.copy(entry.scale);
    else scale.setScalar(entry.size);
    if (entry.quaternion) {
      transform.compose(entry.center, entry.quaternion, scale);
      bounds.copy(unitBox).applyMatrix4(transform);
    } else {
      bounds.setFromCenterAndSize(entry.center, scale);
    }
    if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) continue;
    const minX = Math.floor(bounds.min.x + STOPPED_GRID_EPSILON);
    const minY = Math.floor(bounds.min.y + STOPPED_GRID_EPSILON);
    const minZ = Math.floor(bounds.min.z + STOPPED_GRID_EPSILON);
    const maxX = Math.ceil(bounds.max.x - STOPPED_GRID_EPSILON) - 1;
    const maxY = Math.ceil(bounds.max.y - STOPPED_GRID_EPSILON) - 1;
    const maxZ = Math.ceil(bounds.max.z - STOPPED_GRID_EPSILON) - 1;
    color.setHex(normalizeColor(entry.color));
    const materialId = normalizeVoxelMaterialId(entry.materialId);

    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          const weight = (Math.min(x + 1, bounds.max.x) - Math.max(x, bounds.min.x))
            * (Math.min(y + 1, bounds.max.y) - Math.max(y, bounds.min.y))
            * (Math.min(z + 1, bounds.max.z) - Math.max(z, bounds.min.z));
          const key = `${x},${y},${z}`;
          let cell = cells.get(key);
          if (!cell) {
            cell = { center: new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5), weight: 0,
              r: 0, g: 0, b: 0, materials: new Map() };
            cells.set(key, cell);
          }
          cell.weight += weight;
          cell.r += color.r * weight;
          cell.g += color.g * weight;
          cell.b += color.b * weight;
          cell.materials.set(materialId, (cell.materials.get(materialId) || 0) + weight);
        }
      }
    }
  }

  return [...cells.values()].map(cell => {
    let materialId = 0, materialWeight = -1;
    for (const [id, weight] of cell.materials) {
      if (weight > materialWeight || (weight === materialWeight && id < materialId)) {
        materialId = id;
        materialWeight = weight;
      }
    }
    return { center: cell.center, size: 1, materialId,
      color: color.setRGB(cell.r / cell.weight, cell.g / cell.weight, cell.b / cell.weight).getHex() };
  });
}
