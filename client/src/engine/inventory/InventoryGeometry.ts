import * as THREE from 'three';
import { MICRO_DIVISIONS } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import { MAX_ENTITY_BOUNDS } from '@entropydrop/space-engine/constants/SpaceConstants.ts';

// Geometry only: this module must not depend on a renderer, controller or DOM.
export const STOPPED_GRID_EPSILON = 1e-6;

export interface InventoryPreviewBlock {
  center: THREE.Vector3;
  size: number;
  color?: number;
  materialId?: number;
  decoration?: boolean;
  scale?: THREE.Vector3;
  quaternion?: THREE.Quaternion;
}

export function previewVector3(value, fallback = new THREE.Vector3()): THREE.Vector3 {
  if (value?.isVector3) return value.clone();
  if (Array.isArray(value)) {
    return new THREE.Vector3(Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0);
  }
  return fallback.clone();
}

function previewQuaternion(value): THREE.Quaternion {
  if (value?.isQuaternion) return value.clone().normalize();
  if (Array.isArray(value) && value.length >= 4) {
    const components = value.slice(0, 4).map(Number);
    if (components.every(Number.isFinite)) {
      const quaternion = new THREE.Quaternion(
        components[0], components[1], components[2], components[3]
      );
      if (quaternion.lengthSq() > 1e-12) return quaternion.normalize();
    }
    return new THREE.Quaternion();
  }
  if (Array.isArray(value) && value.length >= 3) {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(
      Number(value[0]) || 0,
      Number(value[1]) || 0,
      Number(value[2]) || 0,
      'XYZ'
    ));
  }
  return new THREE.Quaternion();
}

/**
 * Convert either inventory format into voxel instances relative to the exact
 * placement origin. Entity component transforms mirror Contraption's initial
 * hierarchy, so articulated copies preview in the same pose they build in.
 */
export function getInventoryPreviewBlocks(slot, includeDecorations = false): InventoryPreviewBlock[] {
  if (slot?.kind === 'item') {
    return [
      ...getInventoryPreviewBlocks(slot.blockSet, includeDecorations),
      ...(slot.entityList || []).flatMap(entity => {
        const position = new THREE.Vector3().fromArray(entity.itemPosition || [0, 0, 0]);
        const rotation = new THREE.Quaternion().fromArray(entity.itemRotation || [0, 0, 0, 1]);
        return getInventoryPreviewBlocks(entity, includeDecorations).map(entry => ({
          ...entry, center: entry.center.clone().applyQuaternion(rotation).add(position),
          ...(entry.quaternion ? { quaternion: rotation.clone().multiply(entry.quaternion) } : {}),
        }));
      }),
    ];
  }
  if (!slot || !Array.isArray(slot.blocks)) return [];
  if (slot.kind === 'blockset') {
    return slot.blocks.map(block => ({
      center: new THREE.Vector3(
        Number(block.dx) + (Number(block.size) || 1) / 2,
        Number(block.dy) + (Number(block.size) || 1) / 2,
        Number(block.dz) + (Number(block.size) || 1) / 2
      ),
      size: Number(block.size) || 1,
      color: block.color,
      materialId: block.materialId
    }));
  }

  if (slot.blocks.length === 0) return [];
  const rootComponentId = String(slot.rootComponentId || '');
  if (!rootComponentId) return [];
  const sourceChildIds = new Set((slot.childEntities || []).map(definition => definition.id));
  const blocks = slot.blocks.map(block => ({
    ...block,
    entityId: block.entityId ?? rootComponentId
  }));
  const definitions = (slot.childEntities || []).map(definition => ({
    ...definition,
    parentId: sourceChildIds.has(definition.parentId)
      ? definition.parentId
      : rootComponentId
  })).filter(definition => definition.id !== rootComponentId);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const block of blocks) {
    const x = Number(block.localX);
    const y = Number(block.localY);
    const z = Number(block.localZ);
    const size = Number(block.size) || 1;
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x + size); maxY = Math.max(maxY, y + size); maxZ = Math.max(maxZ, z + size);
  }
  const defaultRootPivot = new THREE.Vector3(
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2
  );
  const rootPivot = previewVector3(slot.rootPivotOverride, defaultRootPivot);
  const rootMatrix = new THREE.Matrix4().makeTranslation(rootPivot.x, rootPivot.y, rootPivot.z);
  const nodes = new Map([[rootComponentId, { pivot: rootPivot, matrix: rootMatrix }]]);
  const pending = [...definitions];
  let guard = pending.length + 1;
  while (pending.length > 0 && guard-- > 0) {
    let progressed = false;
    for (let index = pending.length - 1; index >= 0; index--) {
      const definition = pending[index];
      const parent = nodes.get(definition.parentId);
      if (!parent) continue;
      const pivot = previewVector3(definition.pivot, rootPivot);
      const defaultPosition = pivot.clone().sub(parent.pivot);
      const localPosition = previewVector3(definition.localPosition, defaultPosition);
      const localMatrix = new THREE.Matrix4().compose(
        localPosition,
        previewQuaternion(definition.localRotation),
        new THREE.Vector3(1, 1, 1)
      );
      nodes.set(definition.id, {
        pivot,
        matrix: new THREE.Matrix4().multiplyMatrices(parent.matrix, localMatrix)
      });
      pending.splice(index, 1);
      progressed = true;
    }
    if (!progressed) break;
  }

  // Match Contraption's safe fallback for invalid/cyclic parents.
  for (const definition of pending) {
    const pivot = previewVector3(definition.pivot, rootPivot);
    const localMatrix = new THREE.Matrix4().makeTranslation(
      pivot.x - rootPivot.x,
      pivot.y - rootPivot.y,
      pivot.z - rootPivot.z
    );
    nodes.set(definition.id, {
      pivot,
      matrix: new THREE.Matrix4().multiplyMatrices(rootMatrix, localMatrix)
    });
  }

  const result = blocks.flatMap(block => {
    const node = nodes.get(block.entityId ?? rootComponentId);
    if (!node) return [];
    const size = Number(block.size) || 1;
    const center = new THREE.Vector3(
      Number(block.localX) + size / 2,
      Number(block.localY) + size / 2,
      Number(block.localZ) + size / 2
    ).sub(node.pivot).applyMatrix4(node.matrix);
    return [{ center, size, color: block.color, materialId: block.materialId }];
  });
  if (!includeDecorations) return result;
  const decorations: any[] = [];
  for (const definition of [{ id: rootComponentId, decorations: slot.decorations }, ...definitions]) {
    const node = nodes.get(definition.id);
    if (!node) continue;
    for (const value of definition.decorations || []) {
      decorations.push({
        center: new THREE.Vector3().fromArray(value.position || [0, 0, 0]).sub(node.pivot).applyMatrix4(node.matrix),
        size: 1, color: value.color, materialId: value.materialId, decoration: true,
        scale: new THREE.Vector3().fromArray(value.scale || [1, 1, 1]),
        quaternion: new THREE.Quaternion().setFromRotationMatrix(node.matrix)
          .multiply(new THREE.Quaternion().fromArray(value.rotation || [0, 0, 0, 1])),
      });
    }
  }
  return [...result, ...decorations];
}

/** True when voxels along any axis do not exceed MAX_ENTITY_BOUNDS (256). */
export function withinEntityBounds(blocks: any[], keys: string[], ownerKey: string | null = null): boolean {
  const groups = new Map();
  for (const block of blocks) {
    const owner = ownerKey ? String(block[ownerKey] ?? '') : 'resource';
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(block);
  }
  for (const group of groups.values()) {
    for (let axis = 0; axis < 3; axis++) {
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const block of group) {
        const value = Math.floor(Number(block[keys[axis]]) + 1e-6);
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      if (max - min + 1 > MAX_ENTITY_BOUNDS) return false;
    }
  }
  return true;
}

/** True when no duplicate voxels exist and standard and micro voxels do not share cells. */
export function validateVoxelOccupancy(blocks: any[], coordinateKeys: string[], ownerKey: string | null = null): boolean {
  const standardCells = new Set();
  const microCells = new Set();
  const microParents = new Set();
  for (const block of blocks) {
    const owner = ownerKey ? String(block[ownerKey] ?? '') : 'resource';
    const coordinates = coordinateKeys.map(key => Number(block[key]));
    const base = coordinates.map(value => Math.floor(value + 1e-6));
    const isMicro = Number(block.size) < 1;
    const parentKey = `${owner}:${base.join(',')}`;
    const fine = coordinates.map(value => Math.round(value * MICRO_DIVISIONS));
    if (isMicro) {
      const key = `${owner}:${fine.join(',')}`;
      if (standardCells.has(parentKey) || microCells.has(key)) return false;
      microCells.add(key);
      microParents.add(parentKey);
    } else {
      if (standardCells.has(parentKey) || microParents.has(parentKey)) return false;
      standardCells.add(parentKey);
    }
  }
  return true;
}

export function isStoppedGridQuaternion(value): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length !== 4) return false;
  const components = value.map(Number);
  if (!components.every(Number.isFinite)) return false;
  const quaternion = new THREE.Quaternion(
    components[0], components[1], components[2], components[3]
  );
  if (quaternion.lengthSq() <= 1e-12) return false;
  quaternion.normalize();
  return [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1)
  ].every(axis => axis.applyQuaternion(quaternion).toArray().every(component => (
    Math.abs(component - Math.round(component)) <= STOPPED_GRID_EPSILON
    && Math.abs(Math.round(component)) <= 1
  )));
}

export function validateStoppedEntityGrid(slot): string | null {
  if (!isStoppedGridQuaternion(slot?.anchorRotation)) {
    return 'Root anchor rotation must be one of the 24 axis-aligned 90-degree rotations';
  }
  for (const definition of slot?.childEntities || []) {
    if (!isStoppedGridQuaternion(definition?.localRotation)) {
      return `Component ${String(definition?.id || '')} local rotation must use 90-degree grid steps`;
    }
    if (!isStoppedGridQuaternion(definition?.anchorRotation)) {
      return `Component ${String(definition?.id || '')} anchor rotation must use 90-degree grid steps`;
    }
  }

  const entries = getInventoryPreviewBlocks({ ...slot, kind: 'entity' });
  if (entries.length !== (slot?.blocks || []).length) {
    return 'Stopped entity hierarchy does not resolve every voxel';
  }
  return validateInventoryVoxelBounds(entries, true);
}

/** Validate occupancy in micro-grid units, allowing an Item's Entity origins to be fractional. */
export function validateInventoryVoxelBounds(entries: InventoryPreviewBlock[], requireGridAlignment: boolean): string | null {
  type VoxelBox = [number, number, number, number, number, number];
  const buckets = new Map<string, VoxelBox[]>();
  for (const entry of entries) {
    const size = Number(entry?.size) || 1;
    const bounds = [
      (Number(entry?.center?.x) - size / 2) * MICRO_DIVISIONS,
      (Number(entry?.center?.y) - size / 2) * MICRO_DIVISIONS,
      (Number(entry?.center?.z) - size / 2) * MICRO_DIVISIONS,
      (Number(entry?.center?.x) + size / 2) * MICRO_DIVISIONS,
      (Number(entry?.center?.y) + size / 2) * MICRO_DIVISIONS,
      (Number(entry?.center?.z) + size / 2) * MICRO_DIVISIONS
    ];
    const box = (requireGridAlignment ? bounds.map(Math.round) : bounds) as VoxelBox;
    if (bounds.some((value, index) => (
      !Number.isFinite(value) || (requireGridAlignment && Math.abs(value - box[index]) > STOPPED_GRID_EPSILON)
    ))) {
      return 'Stopped entity voxels must align to the 0.125-unit construction grid';
    }
    const [minX, minY, minZ, maxX, maxY, maxZ] = box;
    const keys: string[] = [];
    for (let x = Math.floor(minX / MICRO_DIVISIONS); x <= Math.floor((maxX - STOPPED_GRID_EPSILON) / MICRO_DIVISIONS); x++) {
      for (let y = Math.floor(minY / MICRO_DIVISIONS); y <= Math.floor((maxY - STOPPED_GRID_EPSILON) / MICRO_DIVISIONS); y++) {
        for (let z = Math.floor(minZ / MICRO_DIVISIONS); z <= Math.floor((maxZ - STOPPED_GRID_EPSILON) / MICRO_DIVISIONS); z++) {
          keys.push(`${x},${y},${z}`);
        }
      }
    }
    for (const key of keys) {
      for (const other of buckets.get(key) || []) {
        if (Math.min(maxX, other[3]) - Math.max(minX, other[0]) > STOPPED_GRID_EPSILON
          && Math.min(maxY, other[4]) - Math.max(minY, other[1]) > STOPPED_GRID_EPSILON
          && Math.min(maxZ, other[5]) - Math.max(minZ, other[2]) > STOPPED_GRID_EPSILON) {
          return 'Stopped entity components contain overlapping voxels';
        }
      }
    }
    for (const key of keys) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(box);
      else buckets.set(key, [box]);
    }
  }
  return null;
}
