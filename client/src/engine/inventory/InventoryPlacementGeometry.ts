import type { InventoryInput, InventoryVoxel } from '@entropydrop/space-engine/storage/InventoryTypes.ts';
import * as THREE from 'three';
import { getInventoryPreviewBlocks } from './InventoryGeometry.ts';

export const ENTITY_PLACEMENT_EPSILON = 1e-5;
const ENTITY_PLACEMENT_SUPPORT_BINS = 12;
const ENTITY_PLACEMENT_SUPPORT_SAMPLE_LIMIT = 256;

export type EntityPlacementEntry = { center: THREE.Vector3; size: number };
export type EntityPlacementObb = {
  center: THREE.Vector3;
  axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  halfExtents: [number, number, number];
  min: THREE.Vector3;
  max: THREE.Vector3;
};

export type EntityPlacementShape = {
  blocksRef: InventoryVoxel[];
  childEntitiesRef: InventoryInput['childEntities'];
  entries: EntityPlacementEntry[];
  supportSamples: Array<{ x: number; z: number; bottom: number }>;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  centerX: number;
  centerZ: number;
};

const entityPlacementShapeCache = new WeakMap<object, EntityPlacementShape>();
export function getEntityPlacementShape(slot: InventoryInput | null | undefined): EntityPlacementShape | null {
  if (!slot || typeof slot !== 'object' || !Array.isArray(slot.blocks)) return null;
  const cached = entityPlacementShapeCache.get(slot);
  if (cached
    && cached.blocksRef === slot.blocks
    && cached.childEntitiesRef === slot.childEntities) return cached;

  const entries = getInventoryPreviewBlocks(slot).flatMap(entry => {
    const size = Number(entry?.size) || 1;
    const center = entry?.center;
    if (!(size > 0) || !center
      || ![center.x, center.y, center.z].every(Number.isFinite)) return [];
    return [{ center: center.clone(), size }];
  });
  if (entries.length === 0) return null;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const entry of entries) {
    const half = entry.size / 2;
    minX = Math.min(minX, entry.center.x - half);
    minY = Math.min(minY, entry.center.y - half);
    minZ = Math.min(minZ, entry.center.z - half);
    maxX = Math.max(maxX, entry.center.x + half);
    maxY = Math.max(maxY, entry.center.y + half);
    maxZ = Math.max(maxZ, entry.center.z + half);
  }

  // Preserve all small footprints. Large ones use one lowest voxel per X/Z
  // bin, spreading support probes across the whole authored footprint.
  let representatives = entries;
  const binLimit = ENTITY_PLACEMENT_SUPPORT_BINS * ENTITY_PLACEMENT_SUPPORT_BINS;
  if (entries.length > binLimit) {
    const width = Math.max(ENTITY_PLACEMENT_EPSILON, maxX - minX);
    const depth = Math.max(ENTITY_PLACEMENT_EPSILON, maxZ - minZ);
    const bins = new Map<number, { center: THREE.Vector3; size: number }>();
    for (const entry of entries) {
      const bx = Math.min(
        ENTITY_PLACEMENT_SUPPORT_BINS - 1,
        Math.max(0, Math.floor((entry.center.x - minX) / width * ENTITY_PLACEMENT_SUPPORT_BINS))
      );
      const bz = Math.min(
        ENTITY_PLACEMENT_SUPPORT_BINS - 1,
        Math.max(0, Math.floor((entry.center.z - minZ) / depth * ENTITY_PLACEMENT_SUPPORT_BINS))
      );
      const key = bx * ENTITY_PLACEMENT_SUPPORT_BINS + bz;
      const previous = bins.get(key);
      if (!previous
        || entry.center.y - entry.size / 2 < previous.center.y - previous.size / 2) {
        bins.set(key, entry);
      }
    }
    representatives = [...bins.values()];
  }

  const rawSamples: Array<{ x: number; z: number; bottom: number }> = [];
  const sampleKeys = new Set<string>();
  const addSample = (x: number, z: number, bottom: number) => {
    const key = `${Math.round(x * 1000)},${Math.round(z * 1000)},${Math.round(bottom * 1000)}`;
    if (sampleKeys.has(key)) return;
    sampleKeys.add(key);
    rawSamples.push({ x, z, bottom });
  };
  for (const entry of representatives) {
    const half = entry.size / 2;
    const bottom = entry.center.y - half;
    addSample(entry.center.x, entry.center.z, bottom);
    // Edge probes keep a one-voxel entity from hanging over a ledge merely
    // because its centre ray missed the supporting terrain cell.
    const inset = Math.max(0, half - Math.min(0.05, entry.size * 0.1));
    if (inset > ENTITY_PLACEMENT_EPSILON) {
      addSample(entry.center.x - inset, entry.center.z - inset, bottom);
      addSample(entry.center.x + inset, entry.center.z - inset, bottom);
      addSample(entry.center.x - inset, entry.center.z + inset, bottom);
      addSample(entry.center.x + inset, entry.center.z + inset, bottom);
    }
  }
  const supportSamples = rawSamples.length <= ENTITY_PLACEMENT_SUPPORT_SAMPLE_LIMIT
    ? rawSamples
    : Array.from({ length: ENTITY_PLACEMENT_SUPPORT_SAMPLE_LIMIT }, (_, index) => (
      rawSamples[Math.floor(index * (rawSamples.length - 1) / (ENTITY_PLACEMENT_SUPPORT_SAMPLE_LIMIT - 1))]
    ));

  const shape: EntityPlacementShape = {
    blocksRef: slot.blocks,
    childEntitiesRef: slot.childEntities,
    entries,
    supportSamples,
    minX, minY, minZ,
    maxX, maxY, maxZ,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2
  };
  entityPlacementShapeCache.set(slot, shape);
  return shape;
}

export function getRotatedEntityPlacementBounds(shape: EntityPlacementShape, rotation: THREE.Quaternion) {
  const axes = [
    new THREE.Vector3(1, 0, 0).applyQuaternion(rotation),
    new THREE.Vector3(0, 1, 0).applyQuaternion(rotation),
    new THREE.Vector3(0, 0, 1).applyQuaternion(rotation)
  ];
  const bounds = {
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity
  };
  for (const entry of shape.entries) {
    const center = entry.center.clone().applyQuaternion(rotation);
    const half = entry.size / 2;
    const radiusX = half * axes.reduce((sum, axis) => sum + Math.abs(axis.x), 0);
    const radiusY = half * axes.reduce((sum, axis) => sum + Math.abs(axis.y), 0);
    const radiusZ = half * axes.reduce((sum, axis) => sum + Math.abs(axis.z), 0);
    bounds.minX = Math.min(bounds.minX, center.x - radiusX);
    bounds.minY = Math.min(bounds.minY, center.y - radiusY);
    bounds.minZ = Math.min(bounds.minZ, center.z - radiusZ);
    bounds.maxX = Math.max(bounds.maxX, center.x + radiusX);
    bounds.maxY = Math.max(bounds.maxY, center.y + radiusY);
    bounds.maxZ = Math.max(bounds.maxZ, center.z + radiusZ);
  }
  return bounds;
}

/** Rotate cached support probes together with the entity without mutating the authored shape. */
export function getRotatedEntityTerrainShape(shape: EntityPlacementShape, rotation: THREE.Quaternion): EntityPlacementShape {
  const bounds = getRotatedEntityPlacementBounds(shape, rotation);
  const supportSamples = shape.supportSamples.map(sample => {
    const point = new THREE.Vector3(sample.x, sample.bottom, sample.z).applyQuaternion(rotation);
    return { x: point.x, z: point.z, bottom: point.y };
  });
  return {
    ...shape,
    ...bounds,
    supportSamples,
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerZ: (bounds.minZ + bounds.maxZ) / 2
  };
}

export function createEntityPlacementObb(center: THREE.Vector3, size: number, quaternion: THREE.Quaternion): EntityPlacementObb {
  const axes = [
    new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion).normalize(),
    new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize(),
    new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize()
  ] as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  const half = Number(size) / 2;
  const radius = new THREE.Vector3(
    half * axes.reduce((sum, axis) => sum + Math.abs(axis.x), 0),
    half * axes.reduce((sum, axis) => sum + Math.abs(axis.y), 0),
    half * axes.reduce((sum, axis) => sum + Math.abs(axis.z), 0)
  );
  return {
    center,
    axes,
    halfExtents: [half, half, half],
    min: center.clone().sub(radius),
    max: center.clone().add(radius)
  };
}

export function entityPlacementObbsOverlap(a: EntityPlacementObb, b: EntityPlacementObb) {
  if (a.max.x <= b.min.x + ENTITY_PLACEMENT_EPSILON || a.min.x >= b.max.x - ENTITY_PLACEMENT_EPSILON
    || a.max.y <= b.min.y + ENTITY_PLACEMENT_EPSILON || a.min.y >= b.max.y - ENTITY_PLACEMENT_EPSILON
    || a.max.z <= b.min.z + ENTITY_PLACEMENT_EPSILON || a.min.z >= b.max.z - ENTITY_PLACEMENT_EPSILON) {
    return false;
  }
  const axes = [...a.axes, ...b.axes];
  for (const axisA of a.axes) {
    for (const axisB of b.axes) {
      const cross = new THREE.Vector3().crossVectors(axisA, axisB);
      if (cross.lengthSq() > 1e-10) axes.push(cross.normalize());
    }
  }
  const delta = b.center.clone().sub(a.center);
  for (const rawAxis of axes) {
    const axis = rawAxis.clone().normalize();
    const radiusA = a.halfExtents.reduce((sum, halfExtent, index) => (
      sum + halfExtent * Math.abs(a.axes[index].dot(axis))
    ), 0);
    const radiusB = b.halfExtents.reduce((sum, halfExtent, index) => (
      sum + halfExtent * Math.abs(b.axes[index].dot(axis))
    ), 0);
    if (radiusA + radiusB - Math.abs(delta.dot(axis)) <= ENTITY_PLACEMENT_EPSILON) return false;
  }
  return true;
}
