import { normalizeVoxelMaterialId } from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';
import * as THREE from 'three';
import type { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import type { RuntimeVoxel } from '@entropydrop/space-engine/contraption/EntityTypes.ts';
import type { CollisionBounds } from '@entropydrop/space-engine/physics/CollisionGeometry.ts';
import { MICRO_DIVISIONS, MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import { MAX_MICRO_SELECTION_CELLS } from '@entropydrop/space-engine/constants/SpaceConstants.ts';
import type { ComponentSelection, ComponentRange, SelectedVoxel } from './SelectionTypes.ts';
import type { Point3 } from '../render/PreviewTypes.ts';

export function contraptionRootId(contraption: Contraption | null | undefined): string {
  const explicit = contraption?.rootComponentId;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  for (const node of contraption?.entityNodes?.values?.() || []) {
    if (node?.parentId === null && typeof node.id === 'string' && node.id.length > 0) return node.id;
  }
  return '';
}

export function contraptionBlockOwnerId(contraption: Contraption, block: Pick<RuntimeVoxel, 'entityId'>): string {
  return block?.entityId === undefined || block?.entityId === null
    ? contraptionRootId(contraption)
    : String(block.entityId);
}

export function rangePointToLocal(range: ComponentSelection | null, worldPoint: Point3 | null) {
    if (!range || !worldPoint || !range.contraption) return null;
    const node = range.contraption.entityNodes.get(range.nodeId);
    if (!node) return null;
    return node.group.worldToLocal(new THREE.Vector3(worldPoint.x, worldPoint.y, worldPoint.z));
  }

export function rangePointToWorld(range: ComponentSelection | null, point: Point3 | null) {
    if (!range || !point || !range.contraption) return null;
    const node = range.contraption.entityNodes.get(range.nodeId);
    if (!node) return null;
    return node.group.localToWorld(new THREE.Vector3(point.x, point.y, point.z));
  }

export function rangePreviewFrame(range: ComponentSelection | null) {
    if (!range || !range.contraption) return null;
    const node = range.contraption.entityNodes.get(range.nodeId);
    if (!node) return null;
    // Clamp to EVERY block owned by this level, standard and micro alike. Filtering
    // to micro blocks alone broke components that mix granularities: after carving
    // a hole in one 1 m block, a box drawn on another (still standard) block was
    // clamped to the carved micro geometry elsewhere in the component, so the
    // live preview jumped to the wrong block.
    const ownerBlocks = range.contraption.blocks.filter(block => (
      contraptionBlockOwnerId(range.contraption, block) === range.nodeId
    ));
    if (ownerBlocks.length === 0) return null;
    node.group?.updateWorldMatrix?.(true, false);
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const block of ownerBlocks) {
      const size = block.size || 1;
      min.x = Math.min(min.x, block.localX);
      min.y = Math.min(min.y, block.localY);
      min.z = Math.min(min.z, block.localZ);
      max.x = Math.max(max.x, block.localX + size);
      max.y = Math.max(max.y, block.localY + size);
      max.z = Math.max(max.z, block.localZ + size);
    }
    const hasValidBounds = Number.isFinite(min.x) && Number.isFinite(max.x) &&
      Number.isFinite(min.y) && Number.isFinite(max.y) &&
      Number.isFinite(min.z) && Number.isFinite(max.z) &&
      min.x <= max.x && min.y <= max.y && min.z <= max.z;
    return {
      object: node.group,
      pivot: (node.pivotLocal || new THREE.Vector3()).clone(),
      // The live range is only a selector aid. Clamp it to real component
      // bounds so pointing outside the entity cannot draw cyan ghost cells.
      bounds: hasValidBounds ? { min, max } : null
    };
  }

export function rangePointToPreviewGrid(range: ComponentSelection | null, point: Point3 | null) {
    const frame = rangePreviewFrame(range);
    if (!frame || !point) return null;
    return new THREE.Vector3(point.x, point.y, point.z).add(frame.pivot);
  }

export function worldPointToRangePreviewGrid(range: ComponentSelection | null, worldPoint: Point3 | null) {
    const local = rangePointToLocal(range, worldPoint);
    return local ? rangePointToPreviewGrid(range, local) : null;
  }

export function entityMicroCellRangeForBox(range: ComponentRange) {
    const gridA = rangePointToPreviewGrid(range, range.pointA);
    const gridB = rangePointToPreviewGrid(range, range.pointB);
    if (!gridA || !gridB) return null;
    const minX = Math.min(gridA.x, gridB.x);
    const maxX = Math.max(gridA.x, gridB.x);
    const minY = Math.min(gridA.y, gridB.y);
    const maxY = Math.max(gridA.y, gridB.y);
    const minZ = Math.min(gridA.z, gridB.z);
    const maxZ = Math.max(gridA.z, gridB.z);
    return {
      minX: Math.ceil(minX * MICRO_DIVISIONS) - 1,
      maxX: Math.floor(maxX * MICRO_DIVISIONS),
      minY: Math.ceil(minY * MICRO_DIVISIONS) - 1,
      maxY: Math.floor(maxY * MICRO_DIVISIONS),
      minZ: Math.ceil(minZ * MICRO_DIVISIONS) - 1,
      maxZ: Math.floor(maxZ * MICRO_DIVISIONS)
    };
  }

export function buildEntityMicroSelection(contraption: Contraption, nodeId: string, contains: (x: number, y: number, z: number) => boolean, bounds: CollisionBounds) {
    const blocks: SelectedVoxel[] = [];
    let cells = 0;
    for (const block of contraption.blocks) {
      if (contraptionBlockOwnerId(contraption, block) !== nodeId) continue;
      const size = (block.size !== undefined && block.size !== null) ? block.size : 1;
      if (size < 1) {
        const cx = Math.round(block.localX * MICRO_DIVISIONS);
        const cy = Math.round(block.localY * MICRO_DIVISIONS);
        const cz = Math.round(block.localZ * MICRO_DIVISIONS);
        if (cx < bounds.minX || cx > bounds.maxX || cy < bounds.minY || cy > bounds.maxY || cz < bounds.minZ || cz > bounds.maxZ) continue;
        if (contains(cx, cy, cz)) {
          if (++cells > MAX_MICRO_SELECTION_CELLS) return null;
          blocks.push(block);
        }
        continue;
      }
      const baseX = Math.floor(block.localX + 1e-6) * MICRO_DIVISIONS;
      const baseY = Math.floor(block.localY + 1e-6) * MICRO_DIVISIONS;
      const baseZ = Math.floor(block.localZ + 1e-6) * MICRO_DIVISIONS;
      // Only enumerate the overlap. A tiny cut in a large entity must not visit
      // 512 virtual cells for every unrelated standard block.
      const minX = Math.max(0, bounds.minX - baseX);
      const minY = Math.max(0, bounds.minY - baseY);
      const minZ = Math.max(0, bounds.minZ - baseZ);
      const maxX = Math.min(MICRO_DIVISIONS - 1, bounds.maxX - baseX);
      const maxY = Math.min(MICRO_DIVISIONS - 1, bounds.maxY - baseY);
      const maxZ = Math.min(MICRO_DIVISIONS - 1, bounds.maxZ - baseZ);
      if (minX > maxX || minY > maxY || minZ > maxZ) continue;
      const owner = contraptionBlockOwnerId(contraption, block);
      for (let ix = minX; ix <= maxX; ix++) {
        for (let iy = minY; iy <= maxY; iy++) {
          for (let iz = minZ; iz <= maxZ; iz++) {
            if (!contains(baseX + ix, baseY + iy, baseZ + iz)) continue;
            if (++cells > MAX_MICRO_SELECTION_CELLS) return null;
            blocks.push({
              localX: (baseX + ix) * MICRO_SIZE,
              localY: (baseY + iy) * MICRO_SIZE,
              localZ: (baseZ + iz) * MICRO_SIZE,
              size: MICRO_SIZE,
              color: block.color,
              materialId: normalizeVoxelMaterialId(block.materialId),
              block: block.block,
              entityId: owner,
              virtualMicro: true,
              sourceBlock: block
            });
          }
        }
      }
    }
    return blocks;
  }

export function microCellKey(block: RuntimeVoxel) {
    return `${Math.round(block.localX * MICRO_DIVISIONS)},${Math.round(block.localY * MICRO_DIVISIONS)},${Math.round(block.localZ * MICRO_DIVISIONS)}`;
  }

export function getEntitySelectionBounds(blocks: RuntimeVoxel[], isMicro = false) {
    if (!blocks || blocks.length === 0) return null;
    if (isMicro) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const b of blocks) {
        const size = (b.size !== undefined && b.size !== null) ? b.size : 1;
        const bx = Math.round(b.localX * MICRO_DIVISIONS);
        const by = Math.round(b.localY * MICRO_DIVISIONS);
        const bz = Math.round(b.localZ * MICRO_DIVISIONS);
        const bSize = Math.max(1, Math.round(size * MICRO_DIVISIONS));
        minX = Math.min(minX, bx);
        minY = Math.min(minY, by);
        minZ = Math.min(minZ, bz);
        maxX = Math.max(maxX, bx + bSize - 1);
        maxY = Math.max(maxY, by + bSize - 1);
        maxZ = Math.max(maxZ, bz + bSize - 1);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
      return { minX, maxX, minY, maxY, minZ, maxZ };
    } else {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const b of blocks) {
        const size = b.size || 1;
        const bx = Math.floor(b.localX + 1e-6);
        const by = Math.floor(b.localY + 1e-6);
        const bz = Math.floor(b.localZ + 1e-6);
        const bSize = Math.max(1, Math.round(size));
        minX = Math.min(minX, bx);
        minY = Math.min(minY, by);
        minZ = Math.min(minZ, bz);
        maxX = Math.max(maxX, bx + bSize - 1);
        maxY = Math.max(maxY, by + bSize - 1);
        maxZ = Math.max(maxZ, bz + bSize - 1);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
      return { minX, maxX, minY, maxY, minZ, maxZ };
    }
  }
