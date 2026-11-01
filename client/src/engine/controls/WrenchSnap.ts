import * as THREE from 'three';
import type { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { CollisionBoxIndex, collisionShapeSpans, type CollisionBounds } from '@entropydrop/space-engine/physics/CollisionGeometry.ts';
import { MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import { entityPlacementObbsOverlap, type EntityPlacementObb } from '../inventory/InventoryPlacementGeometry.ts';
import { nearestGridAlignedQuaternion } from './VoxelGridRotation.ts';

export const WRENCH_SNAP_DISTANCE = 0.85;
const EPSILON = 1e-5;
type SnapBox = EntityPlacementObb & { nodeId: string };
type IndexedBox = CollisionBounds & { box: SnapBox };
const boxCache = new WeakMap<Contraption, { version: number; boxes: SnapBox[]; bounds: THREE.Box3; index: CollisionBoxIndex<IndexedBox> }>();
const queryBounds = (box: EntityPlacementObb, margin = 0): CollisionBounds => ({
  minX: box.min.x - margin, minY: box.min.y - margin, minZ: box.min.z - margin,
  maxX: box.max.x + margin, maxY: box.max.y + margin, maxZ: box.max.z + margin,
});

export function canWrenchMerge(entity: Contraption, held = false): boolean {
  return entity.serverExecutionMode !== 'hosted'
    && (!entity.serverManaged || (entity.serverCanEdit === true && entity.serverCanControl === true
      && entity.serverDesiredRunState !== 'running'))
    && entity.scriptStatus === 'stopped'
    && (held && entity.isWrenchGrabbed === true || (!entity.isWrenchGrabbed && !entity.isPhysicsSimulationEnabled()));
}

function geometry(entity: Contraption) {
  const cached = boxCache.get(entity);
  if (cached?.version === entity.collisionPoseVersion) return cached;
  const bounds = new THREE.Box3();
  // The wrench temporarily disables collision simulation. Authored merged
  // boxes remain available and describe exactly the surfaces being dragged.
  const boxes = entity.collisionPhysicsBoxes.map((cell): SnapBox => {
    const sizes = collisionShapeSpans(cell);
    const rotation = entity.getEntityNodeWorldQuaternion(cell.entityId);
    const center = entity.entityLocalToWorld(cell.entityId, new THREE.Vector3(
      (cell.x + sizes[0] / 2) * MICRO_SIZE,
      (cell.y + sizes[1] / 2) * MICRO_SIZE,
      (cell.z + sizes[2] / 2) * MICRO_SIZE));
    const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]
      .map(axis => axis.applyQuaternion(rotation)) as SnapBox['axes'];
    const halfExtents = sizes.map(size => size * MICRO_SIZE / 2) as SnapBox['halfExtents'];
    const extent = new THREE.Vector3(...(['x', 'y', 'z'] as const).map(axis =>
      axes.reduce((sum, direction, i) => sum + Math.abs(direction[axis]) * halfExtents[i], 0)));
    const min = center.clone().sub(extent), max = center.clone().add(extent);
    bounds.expandByPoint(min); bounds.expandByPoint(max);
    return { center, min, max, nodeId: cell.entityId, axes, halfExtents };
  });
  const result = { version: entity.collisionPoseVersion, boxes, bounds,
    index: new CollisionBoxIndex(boxes.map(box => ({ ...queryBounds(box), box }))) };
  boxCache.set(entity, result);
  return result;
}

const movedBox = (box: SnapBox, offset: THREE.Vector3): SnapBox => ({ ...box,
  center: box.center.clone().add(offset), min: box.min.clone().add(offset), max: box.max.clone().add(offset) });
const radius = (box: SnapBox, axis: THREE.Vector3) => box.halfExtents
  .reduce((sum, half, i) => sum + half * Math.abs(box.axes[i].dot(axis)), 0);

function rotatedBoxes(source: Contraption, rotation: THREE.Quaternion) {
  const delta = rotation.clone().multiply(source.quaternion.clone().invert());
  return geometry(source).boxes.map(box => {
    const center = box.center.clone().sub(source.position).applyQuaternion(delta).add(source.position);
    const axes = box.axes.map(axis => axis.clone().applyQuaternion(delta)) as SnapBox['axes'];
    const extent = new THREE.Vector3(...(['x', 'y', 'z'] as const).map(axis =>
      axes.reduce((sum, direction, i) => sum + Math.abs(direction[axis]) * box.halfExtents[i], 0)));
    return { ...box, center, axes, min: center.clone().sub(extent), max: center.clone().add(extent) };
  });
}

export function wrenchPlacementClear(source: Contraption, target: Contraption, offset = new THREE.Vector3(), rotation = source.quaternion) {
  const fixed = geometry(target);
  return !rotatedBoxes(source, rotation).some(box => {
    const placed = movedBox(box, offset);
    return fixed.index.query(queryBounds(placed)).some(({ box: other }) => entityPlacementObbsOverlap(placed, other));
  });
}

/** Prefer mounting-face centers, then nearby voxel faces, with collision-safe poses. */
export function findWrenchSnap(source: Contraption, entities: readonly Contraption[], requestedOffset = new THREE.Vector3()) {
  const moving = geometry(source);
  if (moving.bounds.isEmpty()) return null;
  const near = moving.bounds.clone().translate(requestedOffset).expandByScalar(WRENCH_SNAP_DISTANCE);
  const candidates: { target: Contraption; nodeId: string; offset: THREE.Vector3; rotation: THREE.Quaternion; distance: number }[] = [];
  for (const target of entities) {
    if (target === source || !canWrenchMerge(target)) continue;
    const fixed = geometry(target);
    if (!near.intersectsBox(fixed.bounds)) continue;
    const relative = target.quaternion.clone().invert().multiply(source.quaternion);
    const aligned = target.quaternion.clone().multiply(nearestGridAlignedQuaternion(relative));
    const rotation = aligned.angleTo(source.quaternion) <= Math.PI / 9 ? aligned : source.quaternion.clone();
    const sourceBoxes = rotatedBoxes(source, rotation).map(box => movedBox(box, requestedOffset));
    const center = moving.bounds.getCenter(new THREE.Vector3()).add(requestedOffset);
    const spansByNode = new Map<string, number[]>();
    const stemsByFace = new Map<string, SnapBox[]>();
    const sourceSpans = (box: SnapBox) => {
      let spans = spansByNode.get(box.nodeId);
      if (!spans) {
        spans = box.axes.map(direction => {
          let min = Infinity, max = -Infinity;
          for (const part of sourceBoxes) {
            const extent = radius(part, direction), projection = part.center.dot(direction);
            min = Math.min(min, projection - extent); max = Math.max(max, projection + extent);
          }
          return max - min;
        });
        spansByNode.set(box.nodeId, spans);
      }
      return spans;
    };
    const isThin = (spans: number[]) => Math.min(...spans) < [...spans].sort((a, b) => a - b)[1] * .6;
    // Thin parts mount on their broad face, never sideways on their rim.
    const suitableFace = (box: SnapBox, axis: number) => {
      const spans = sourceSpans(box);
      return !isThin(spans) || spans[axis] <= Math.min(...spans) * 1.25;
    };
    const seenOffsets = new Set<string>();
    const add = (offset: THREE.Vector3, b: SnapBox, centered = false, mountPriority = 0) => {
      const key = offset.toArray().map(value => Math.round(value / EPSILON)).join(',');
      if (seenOffsets.has(key)) return;
      seenOffsets.add(key);
      candidates.push({ target, nodeId: b.nodeId, offset: offset.clone().add(requestedOffset), rotation,
        distance: offset.length() + (mountPriority ? -1.5 * mountPriority : centered ? 0 : 1.25) });
    };
    // Align the whole part's center with small mounting faces. This catches a
    // wheel near an axle even when its rim isn't already perfectly centered.
    for (const { box: b } of fixed.index.query({ minX: near.min.x, minY: near.min.y, minZ: near.min.z,
      maxX: near.max.x, maxY: near.max.y, maxZ: near.max.z })) {
      for (let i = 0; i < 3; i++) {
        if (!suitableFace(b, i)) continue;
        const axis = b.axes[i], side = center.clone().sub(b.center).dot(axis) < 0 ? -1 : 1;
        const tangents = [0, 1, 2].filter(j => j !== i);
        // Small faces provide useful centers; large walls keep the nearest face position.
        if (tangents.some(j => b.halfExtents[j] > .5)) continue;
        const offset = new THREE.Vector3();
        for (const j of tangents) offset.addScaledVector(b.axes[j], b.center.clone().sub(center).dot(b.axes[j]));
        // Axle ends, including a wider pad on a narrow stem, give a stronger
        // mounting cue than small boxes along a fender. Recognize the shape
        // in any entity rather than relying on tutorial IDs or voxel colors.
        const thin = isThin(sourceSpans(b));
        const faceKey = `${b.nodeId}:${i}`;
        let stems = stemsByFace.get(faceKey);
        if (!stems) {
          stems = fixed.boxes.filter(part => Math.abs(part.axes[i].dot(axis)) >= .999
            && Math.max(...tangents.map(j => part.halfExtents[j])) <= .5
            && part.halfExtents[i] >= Math.max(...tangents.map(j => part.halfExtents[j])) * 2);
          stemsByFace.set(faceKey, stems);
        }
        const stem = thin && stems.find(part => {
          const delta = part.center.clone().sub(b.center);
          return tangents.every(j => Math.abs(delta.dot(b.axes[j])) < EPSILON
            && part.halfExtents[j] <= b.halfExtents[j] + EPSILON)
            && Math.abs(delta.dot(axis)) <= part.halfExtents[i] + b.halfExtents[i] + MICRO_SIZE;
        });
        const mountPriority = stem ? (tangents.every(j => b.halfExtents[j] >= stem.halfExtents[j] * 1.5) ? 2 : 1) : 0;
        // When an assembly has axle-like mounts, decorative edge fragments
        // must not capture a wheel while it is still approaching those mounts.
        if (thin && stems.length && !stem) continue;
        if (offset.length() > (stem ? 1.35 : thin ? .35 : WRENCH_SNAP_DISTANCE)) continue;
        // A recessed hub can surround a mounting pad without a voxel at its
        // center. Align its outside face plane before considering inset contact.
        let edge = side > 0 ? Infinity : -Infinity;
        for (const a of sourceBoxes) {
          const value = a.center.dot(axis) - side * radius(a, axis);
          edge = side > 0 ? Math.min(edge, value) : Math.max(edge, value);
        }
        const faceCorrection = b.center.dot(axis) + side * b.halfExtents[i] - edge;
        if (Math.abs(faceCorrection) <= WRENCH_SNAP_DISTANCE) add(offset.clone().addScaledVector(axis, faceCorrection), b, true, mountPriority);
        for (const a of sourceBoxes) {
          const edge = a.center.dot(axis) - side * radius(a, axis);
          const correction = b.center.dot(axis) + side * b.halfExtents[i] - edge;
          if (Math.abs(correction) > WRENCH_SNAP_DISTANCE) continue;
          const candidate = offset.clone().addScaledVector(axis, correction);
          const placed = movedBox(a, candidate);
          const touching = { ...placed, halfExtents: placed.halfExtents.map(size => size + EPSILON * 4) as SnapBox['halfExtents'],
            min: placed.min.clone().addScalar(-EPSILON * 4), max: placed.max.clone().addScalar(EPSILON * 4) };
          if (entityPlacementObbsOverlap(touching, b)) add(candidate, b, true, mountPriority);
        }
      }
    }
    for (const a of sourceBoxes) {
      for (const { box: b } of fixed.index.query(queryBounds(a, WRENCH_SNAP_DISTANCE))) {
        const delta = a.center.clone().sub(b.center);
        for (let i = 0; i < 3; i++) {
          if (!suitableFace(b, i)) continue;
          const spans = sourceSpans(b);
          // A thin part approaching a small mount must reach its center.
          // Edge-only contact otherwise locks wheels prematurely on bumpers
          // and fenders. Broad walls still allow free face-to-face placement.
          if (isThin(spans) && [0, 1, 2].some(j => j !== i && b.halfExtents[j] * 2 < spans[j] - EPSILON)) continue;
          const axis = b.axes[i];
          const distance = delta.dot(axis);
          const correction = (distance < 0 ? -1 : 1) * (b.halfExtents[i] + radius(a, axis)) - distance;
          if (Math.abs(correction) > WRENCH_SNAP_DISTANCE) continue;
          const offset = axis.clone().multiplyScalar(correction);
          const placed = movedBox(a, offset);
          // An infinitesimal expansion turns touching into SAT overlap, rejecting
          // diagonal near misses and contact with an empty corner of a rotated box.
          const touching = { ...placed, halfExtents: placed.halfExtents.map(size => size + EPSILON * 4) as SnapBox['halfExtents'],
            min: placed.min.clone().addScalar(-EPSILON * 4), max: placed.max.clone().addScalar(EPSILON * 4) };
          if (!entityPlacementObbsOverlap(touching, b)) continue;
          add(offset, b);
        }
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  for (const candidate of candidates) {
    // A face can be close while a different part of the hierarchy intersects.
    if (!wrenchPlacementClear(source, candidate.target, candidate.offset, candidate.rotation)) continue;
    return candidate;
  }
  return null;
}

export function rotateWrenchEntity(entity: Contraption, rotation: THREE.Quaternion) {
  const delta = rotation.clone().multiply(entity.quaternion.clone().invert());
  const pivot = entity.position.clone();
  entity.quaternion.copy(rotation);
  for (const body of entity.rigidBodies.values()) {
    if (body.position !== entity.position) body.position.sub(pivot).applyQuaternion(delta).add(pivot);
    if (body.quaternion !== entity.quaternion) body.quaternion.premultiply(delta);
    body.previousKinematicPosition.copy(body.position);
    body.previousKinematicQuaternion.copy(body.quaternion);
  }
  entity.originWorldPos.sub(pivot).applyQuaternion(delta).add(pivot);
  for (const constraint of entity.constraintDefinitions.values()) {
    if (constraint.bodyA === null) {
      constraint.anchorA = new THREE.Vector3().fromArray(constraint.anchorA).sub(pivot).applyQuaternion(delta).add(pivot).toArray();
      constraint.axisA = new THREE.Vector3().fromArray(constraint.axisA).applyQuaternion(delta).toArray();
      constraint.referenceA = new THREE.Vector3().fromArray(constraint.referenceA).applyQuaternion(delta).toArray();
    }
  }
  if ([...entity.constraintDefinitions.values()].some(constraint => constraint.bodyA === null)) entity.markDefinitionChanged();
  entity.syncAllBodyTransforms();
  entity.capturePreviousEntityTransforms();
}

/** Translate the complete rigid-body frame without imparting a release impulse. */
export function translateWrenchEntity(entity: Contraption, offset: THREE.Vector3) {
  for (const body of entity.rigidBodies.values()) {
    if (body.position !== entity.position) body.position.add(offset);
    body.previousKinematicPosition.add(offset);
    body.velocity.set(0, 0, 0); body.angularVelocity.set(0, 0, 0);
  }
  entity.position.add(offset);
  entity.originWorldPos.add(offset);
  for (const constraint of entity.constraintDefinitions.values()) {
    if (constraint.bodyA === null) {
      constraint.anchorA = new THREE.Vector3().fromArray(constraint.anchorA).add(offset).toArray();
    }
  }
  if ([...entity.constraintDefinitions.values()].some(constraint => constraint.bodyA === null)) entity.markDefinitionChanged();
  entity.syncAllBodyTransforms();
  entity.capturePreviousEntityTransforms();
}

export interface WrenchSnapTarget {
  source: Contraption;
  target: Contraption;
  nodeId: string;
  sourcePosition: THREE.Vector3;
  sourceRotation: THREE.Quaternion;
  targetPosition: THREE.Vector3;
  targetRotation: THREE.Quaternion;
  sourceVersion: number;
  targetVersion: number;
  gridRotation: THREE.Quaternion;
  gridStep: number;
  anchorPosition: THREE.Vector3;
}

export function captureWrenchSnap(source: Contraption, target: Contraption, nodeId: string): WrenchSnapTarget {
  return { source, target, nodeId, sourcePosition: source.position.clone(), sourceRotation: source.quaternion.clone(),
    targetPosition: target.position.clone(), targetRotation: target.quaternion.clone(),
    sourceVersion: source.definitionVersion, targetVersion: target.definitionVersion,
    gridRotation: target.getEntityNodeWorldQuaternion(nodeId),
    gridStep: source.blocks.reduce((size, block) => Math.min(size, block.size || 1), 1), anchorPosition: source.position.clone() };
}

export function wrenchSnapStillValid(snap: WrenchSnapTarget, entities: readonly Contraption[]) {
  return entities.includes(snap.source) && entities.includes(snap.target)
    && canWrenchMerge(snap.source, true) && canWrenchMerge(snap.target)
    && snap.source.definitionVersion === snap.sourceVersion && snap.target.definitionVersion === snap.targetVersion
    && snap.source.position.distanceToSquared(snap.sourcePosition) < EPSILON * EPSILON
    && snap.target.position.distanceToSquared(snap.targetPosition) < EPSILON * EPSILON
    && snap.source.quaternion.angleTo(snap.sourceRotation) < EPSILON
    && snap.target.quaternion.angleTo(snap.targetRotation) < EPSILON
    && !!snap.target.getEntityNode(snap.nodeId);
}
