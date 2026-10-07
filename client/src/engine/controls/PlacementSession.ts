import { MAX_ENTITY_BOUNDS } from '@entropydrop/space-engine/constants/SpaceConstants.ts';
import type { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import type { InventoryInput } from '@entropydrop/space-engine/storage/InventoryTypes.ts';
import { CHUNK_SIZE_Y } from '@entropydrop/space-engine/voxel/Chunk.ts';
import { MICRO_DIVISIONS, MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import * as THREE from 'three';
import { createEntityPlacementObb, ENTITY_PLACEMENT_EPSILON, entityPlacementObbsOverlap, getEntityPlacementShape, getRotatedEntityPlacementBounds, getRotatedEntityTerrainShape, type EntityPlacementObb, type EntityPlacementShape, } from '../inventory/InventoryPlacementGeometry.ts';
import { normalizeQuarterTurns, rotateChildDefinitionsX90, rotateChildDefinitionsY90 } from '../inventory/InventoryRotation.ts';
import { InventoryThumbnailRenderer } from '../render/InventoryThumbnailRenderer.ts';
import type { Point3 } from '../render/PreviewTypes.ts';
import { SpecialTool } from './ControlBindings.ts';
import type { PlayerController } from './PlayerController.ts';
import { contraptionBlockOwnerId, contraptionRootId } from './SelectionGeometry.ts';

interface PlacementHit {
  kind?: string; hitPos?: Point3; entry?: Point3; normal?: Point3; microNormal?: Point3;
  placeMicroPos?: Point3; targetContraption?: Contraption | null; targetNodeId?: string; targetLocalNormal?: Point3;
}
type PlacementSlot = InventoryInput & { placementRotation?: number[]; itemName?: string };
const ENTITY_PLACEMENT_MAX_DROP = 48;
const ENTITY_TARGET_PLACEMENT_MAX_OUTWARD_STEPS = MAX_ENTITY_BOUNDS * MICRO_DIVISIONS;
const ENTITY_TARGET_PLACEMENT_BUCKET_SIZE = 2;
const entityPlacementTargetObbCache = new WeakMap<object, {
  poseSignature: string;
  entriesRef: Contraption['collisionEntries'] | Contraption['blocks'];
  boxes: EntityPlacementObb[];
  buckets: Map<string, EntityPlacementObb[]>;
}>();

export interface PlacementSessionPort {
  activeInventoryCategory: PlayerController['activeInventoryCategory'];
  activeTool: PlayerController['activeTool'];
  currentRaycast: PlayerController['currentRaycast'];
  hoveredContraption: PlayerController['hoveredContraption'];
  hoveredContraptionHit: PlayerController['hoveredContraptionHit'];
  inventorySlots: PlayerController['inventorySlots'];
  rotateBlocksX90: PlayerController['rotateBlocksX90'];
  rotateBlocksY90: PlayerController['rotateBlocksY90'];
  sceneRenderer: PlayerController['sceneRenderer'];
  selectedInventoryIndex: PlayerController['selectedInventoryIndex'];
  sound: PlayerController['sound'];
  ui: PlayerController['ui'];
  world: PlayerController['world'];
  worldPickingSuspended: PlayerController['worldPickingSuspended'];
}

/** Owns Hammer preview pose, temporary rotations and collision-aware placement resolution. */
export class PlacementSession {
  private readonly host: PlacementSessionPort;
  constructor(host: PlacementSessionPort) { this.host = host; }
  hammerRotationTurnsY = 0;
  hammerRotationTurnsX = 0;
  hammerRotatedSlotSource: PlacementSlot | null = null;
  hammerRotatedSlotTurnsKey: string | null = null;
  hammerRotatedSlotCache: PlacementSlot | null = null;
  inventoryPlacementPreview: ReturnType<PlacementSession['getInventoryPlacementPose']> = null;

  clearHammerRotation() {
    this.hammerRotationTurnsY = 0;
    this.hammerRotationTurnsX = 0;
    this.hammerRotatedSlotSource = null;
    this.hammerRotatedSlotTurnsKey = null;
    this.hammerRotatedSlotCache = null;
    this.inventoryPlacementPreview = null;
    if (this.host.sceneRenderer) this.host.sceneRenderer.inventoryPlacementSlot = null;
  }

  itemPlacementSlot(item: PlacementSlot | null | undefined) {
    if (item?.kind !== 'item') return item;
    if (item.blockSet && !item.entityList?.length) {
      return { ...item.blockSet, id: item.id, name: item.name };
    }
    const entity = item.entityList?.[0];
    if (entity && !item.blockSet && item.entityList?.length === 1
      && (entity.itemPosition || [0, 0, 0]).every(value => value === 0)
      && (entity.itemRotation || [0, 0, 0, 1]).every((value, index: number) => value === (index === 3 ? 1 : 0))) {
      return { ...entity, id: item.id, itemName: item.name, itemWorldConstraints: true };
    }
    return item;
  }

  getActiveHammerInventoryItem() {
    const stored = this.host.inventorySlots?.[this.host.selectedInventoryIndex];
    const slot = this.itemPlacementSlot(stored);
    if (!slot) return null;

    const turnsY = normalizeQuarterTurns(this.hammerRotationTurnsY);
    const turnsX = normalizeQuarterTurns(this.hammerRotationTurnsX);
    if (turnsY === 0 && turnsX === 0) return slot;

    const cacheKey = `${turnsY}:${turnsX}`;
    if (this.hammerRotatedSlotSource === slot &&
      this.hammerRotatedSlotTurnsKey === cacheKey &&
      this.hammerRotatedSlotCache) {
      return this.hammerRotatedSlotCache;
    }

    const isEntity = slot.kind === 'entity' || slot.kind === 'item';
    const qY = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      turnsY * Math.PI / 2
    );
    const qX = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      turnsX * Math.PI / 2
    );
    const placementRotation = qY.clone().multiply(qX);

    let rotatedBlocks = slot.blocks;
    if (turnsX !== 0 && Array.isArray(rotatedBlocks)) {
      rotatedBlocks = this.host.rotateBlocksX90(rotatedBlocks, turnsX);
    }
    if (turnsY !== 0 && Array.isArray(rotatedBlocks)) {
      rotatedBlocks = this.host.rotateBlocksY90(rotatedBlocks, turnsY);
    }

    let rotatedChildren = slot.childEntities;
    if (Array.isArray(rotatedChildren)) {
      if (turnsX !== 0) {
        rotatedChildren = rotateChildDefinitionsX90(rotatedChildren, turnsX);
      }
      if (turnsY !== 0) {
        rotatedChildren = rotateChildDefinitionsY90(rotatedChildren || [], turnsY);
      }
    }

    const rotatedSlot = isEntity
      ? {
        ...slot,
        // Entity geometry and scripts stay in their authored local frame.
        // The temporary anchor carries this roll for component installation,
        // while placementRotation carries the same pose for terrain builds.
        anchorRotation: this.getEntityAnchorRotation(slot)
          .multiply(placementRotation.clone().invert())
          .normalize()
          .toArray(),
        placementRotation: placementRotation.toArray()
      }
      : {
        ...slot,
        blocks: rotatedBlocks,
        childEntities: rotatedChildren
      };
    this.hammerRotatedSlotSource = slot;
    this.hammerRotatedSlotTurnsKey = cacheKey;
    this.hammerRotatedSlotCache = rotatedSlot;
    return rotatedSlot;
  }

  rotateActiveInventoryItem(direction = 1, axis: 'x' | 'y' = 'y') {
    const category = this.host.activeInventoryCategory;
    if (category === 'colorset') return false;
    const slot = this.host.inventorySlots?.[this.host.selectedInventoryIndex];
    if (!slot || !Array.isArray(slot.blocks) || slot.blocks.length === 0) {
      this.host.ui?.showToast?.('No item in current slot to rotate');
      return false;
    }

    const step = direction >= 0 ? 1 : -1;
    if (axis === 'x') {
      this.hammerRotationTurnsX = normalizeQuarterTurns((this.hammerRotationTurnsX || 0) + step);
    } else {
      this.hammerRotationTurnsY = normalizeQuarterTurns((this.hammerRotationTurnsY || 0) + step);
    }
    this.hammerRotatedSlotSource = null;
    this.hammerRotatedSlotTurnsKey = null;
    this.hammerRotatedSlotCache = null;

    if (this.host.sceneRenderer) {
      this.host.sceneRenderer.inventoryPlacementSlot = null;
    }
    this.updateInventoryPlacementPreview();

    InventoryThumbnailRenderer.getInstance().clearCache();

    this.host.sound?.playWrenchClick?.();
    const axisLabel = axis === 'x' ? 'pitch' : 'yaw';
    this.host.ui?.showToast?.(`Rotated "${slot.name || 'item'}" 90° (${axisLabel})`);
    this.host.ui?.syncInventoryState?.();
    return true;
  }

  rotateActiveInventoryItemY(direction = 1) {
    return this.rotateActiveInventoryItem(direction, 'y');
  }

  rotateActiveInventoryItemX(direction = 1) {
    return this.rotateActiveInventoryItem(direction, 'x');
  }

  getInventoryPlacementHit() {
    const entityHit = this.host.hoveredContraptionHit;
    if (entityHit?.point) {
      return {
        hitPos: entityHit.point,
        normal: entityHit.worldNormal || entityHit.normal || { x: 0, y: 1, z: 0 },
        microNormal: entityHit.worldNormal || entityHit.normal || { x: 0, y: 1, z: 0 },
        entry: entityHit.point,
        kind: entityHit.kind,
        targetContraption: entityHit.contraption || this.host.hoveredContraption || null,
        targetNodeId: entityHit.entityId ?? entityHit.entityNode?.id ?? contraptionRootId(entityHit.contraption),
        targetLocalNormal: entityHit.normal || entityHit.worldNormal || { x: 0, y: 1, z: 0 }
      };
    }
    return this.host.currentRaycast?.hit
      ? {
        hitPos: this.host.currentRaycast.hitPos,
        normal: this.host.currentRaycast.normal,
        microNormal: this.host.currentRaycast.normal,
        entry: this.host.currentRaycast.entry,
        kind: this.host.currentRaycast.kind,
        placeMicroPos: this.host.currentRaycast.placeMicroPos
      }
      : null;
  }

  usesMicroBlockSetPlacement(slot: InventoryInput | null) {
    return slot?.kind === 'blockset'
      && Array.isArray(slot.blocks)
      && slot.blocks.length > 0
      && slot.blocks.every(block => (Number(block?.size) || 1) < 1);
  }

  getMicroBlockSetPlacementPosition(placementHit: PlacementHit) {
    if (placementHit.kind === 'micro' && placementHit.placeMicroPos) {
      const micro = placementHit.placeMicroPos;
      if ([micro.x, micro.y, micro.z].every(Number.isFinite)) {
        return new THREE.Vector3(
          micro.x / MICRO_DIVISIONS,
          micro.y / MICRO_DIVISIONS,
          micro.z / MICRO_DIVISIONS
        );
      }
    }

    const point = placementHit.entry;
    if (!point) {
      const hp = placementHit.hitPos;
      if (!hp) return null;
      const fallbackNormal = placementHit.normal || { x: 0, y: 1, z: 0 };
      return new THREE.Vector3(
        Math.floor(hp.x + (fallbackNormal.x || 0)),
        Math.floor(hp.y + (fallbackNormal.y || 0)),
        Math.floor(hp.z + (fallbackNormal.z || 0))
      );
    }
    const normal = placementHit.microNormal || placementHit.normal || { x: 0, y: 1, z: 0 };
    const outside = new THREE.Vector3(point.x, point.y, point.z).addScaledVector(
      new THREE.Vector3(normal.x || 0, normal.y || 0, normal.z || 0),
      0.02
    );
    const snap = (value: number) => Math.floor(value * MICRO_DIVISIONS + 1e-6) / MICRO_DIVISIONS;
    return new THREE.Vector3(snap(outside.x), snap(outside.y), snap(outside.z));
  }

  getEntityPlacementSurfacePoint(placementHit: PlacementHit) {
    const entry = placementHit?.entry;
    if (entry && [entry.x, entry.y, entry.z].every(Number.isFinite)) {
      return new THREE.Vector3(entry.x, entry.y, entry.z);
    }
    const hp = placementHit?.hitPos;
    if (!hp || ![hp.x, hp.y, hp.z].every(Number.isFinite)) return null;
    const normal = placementHit.normal || { x: 0, y: 1, z: 0 };
    const cellSize = placementHit.kind === 'micro' ? 1 / MICRO_DIVISIONS : 1;
    const onFace = (value: number, axisNormal: number) => value + (
      axisNormal > 0 ? cellSize : axisNormal < 0 ? 0 : cellSize / 2
    );
    return new THREE.Vector3(
      onFace(hp.x, Number(normal.x) || 0),
      onFace(hp.y, Number(normal.y) || 0),
      onFace(hp.z, Number(normal.z) || 0)
    );
  }

  clampEntityPlacementY(shape: EntityPlacementShape, y: number) {
    const minOriginY = -shape.minY;
    const maxOriginY = CHUNK_SIZE_Y - shape.maxY;
    return Math.max(minOriginY, Math.min(maxOriginY, y));
  }

  snapEntityPlacementMicroValue(value: number) {
    const units = Math.round(value * MICRO_DIVISIONS);
    return units === 0 ? 0 : units / MICRO_DIVISIONS;
  }

  targetEntityLocalToWorld(target: Contraption | null | undefined, nodeId: string, point: THREE.Vector3) {
    if (typeof target?.entityLocalToWorld === 'function') {
      return target.entityLocalToWorld(nodeId, point.clone());
    }
    const node = target?.getEntityNode?.(nodeId) || target?.entityNodes?.get?.(nodeId);
    if (node?.group?.localToWorld) {
      node.group.updateWorldMatrix?.(true, false);
      return node.group.localToWorld(point.clone().sub(node.pivotLocal || new THREE.Vector3()));
    }
    return point.clone();
  }

  targetEntityWorldToLocal(target: Contraption | null | undefined, nodeId: string, point: THREE.Vector3) {
    if (typeof target?.worldToEntityLocal === 'function') {
      return target.worldToEntityLocal(nodeId, point.clone());
    }
    const node = target?.getEntityNode?.(nodeId) || target?.entityNodes?.get?.(nodeId);
    if (node?.group?.worldToLocal) {
      node.group.updateWorldMatrix?.(true, false);
      return node.group.worldToLocal(point.clone()).add(node.pivotLocal || new THREE.Vector3());
    }
    return point.clone();
  }

  getTargetEntityWorldQuaternion(target: Contraption | null | undefined, nodeId: string) {
    const direct = target?.getEntityNodeWorldQuaternion?.(nodeId);
    if (direct?.isQuaternion) return direct.clone().normalize();
    const node = target?.getEntityNode?.(nodeId) || target?.entityNodes?.get?.(nodeId);
    if (node?.group?.getWorldQuaternion) {
      node.group.updateWorldMatrix?.(true, false);
      return node.group.getWorldQuaternion(new THREE.Quaternion()).normalize();
    }
    return new THREE.Quaternion();
  }

  inventoryQuaternion(value: unknown, fallback = new THREE.Quaternion()) {
    if (!Array.isArray(value) || value.length < 4) return fallback.clone();
    const components = value.slice(0, 4).map(Number);
    if (!components.every(Number.isFinite)) return fallback.clone();
    const quaternion = new THREE.Quaternion(
      components[0], components[1], components[2], components[3]
    );
    return quaternion.lengthSq() > 1e-12 ? quaternion.normalize() : fallback.clone();
  }

  getEntityAnchorRotation(slot: InventoryInput) {
    return this.inventoryQuaternion(slot?.anchorRotation);
  }

  getEntityPlacementRotation(slot: PlacementSlot) {
    return this.inventoryQuaternion(slot?.placementRotation);
  }

  axisAlignedEntityFaceNormal(value: Point3 | null | undefined) {
    const normal = value instanceof THREE.Vector3
      ? value.clone()
      : new THREE.Vector3(Number(value?.x) || 0, Number(value?.y) || 0, Number(value?.z) || 0);
    const components = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)];
    const axis = components[1] > components[0]
      ? (components[2] > components[1] ? 2 : 1)
      : (components[2] > components[0] ? 2 : 0);
    const result = new THREE.Vector3();
    result.setComponent(axis, normal.getComponent(axis) < 0 ? -1 : 1);
    return result;
  }

  getTargetEntityPlacementPoseSignature(target: Contraption) {
    const values: Array<string | number> = [];
    const appendVector = (value: Partial<{ x: number; y: number; z: number; w: number }> | null | undefined) => {
      if (!value) return;
      for (const key of ['x', 'y', 'z', 'w'] as const) {
        if (Number.isFinite(Number(value[key]))) values.push(Number(value[key]));
      }
    };
    appendVector(target?.position);
    appendVector(target?.quaternion);
    for (const node of target?.entityNodes?.values?.() || []) {
      values.push(String(node.id || ''));
      appendVector(node.localPosition || node.group?.position);
      appendVector(node.localQuaternion || node.group?.quaternion);
    }
    return values.length > 0
      ? values.join(',')
      : String(Number(target?.collisionPoseVersion) || 0);
  }

  getTargetEntityPlacementObbs(target: Contraption | null | undefined) {
    if (!target) return { boxes: [], buckets: new Map<string, EntityPlacementObb[]>() };
    const entries = Array.isArray(target.collisionEntries) && target.collisionEntries.length > 0
      ? target.collisionEntries
      : null;
    const entriesRef = entries || target.blocks;
    const poseSignature = this.getTargetEntityPlacementPoseSignature(target);
    const cached = entityPlacementTargetObbCache.get(target);
    if (cached && cached.entriesRef === entriesRef && cached.poseSignature === poseSignature) return cached;

    const quaternionByNode = new Map<string, THREE.Quaternion>();
    const quaternionFor = (nodeId: string) => {
      const id = nodeId === undefined || nodeId === null ? contraptionRootId(target) : String(nodeId);
      let quaternion = quaternionByNode.get(id);
      if (!quaternion) {
        quaternion = this.getTargetEntityWorldQuaternion(target, id);
        quaternionByNode.set(id, quaternion);
      }
      return quaternion;
    };
    const boxes: EntityPlacementObb[] = [];
    if (entries) {
      for (const entry of entries) {
        const nodeId = contraptionBlockOwnerId(target, entry);
        const size = Number(entry.span) / MICRO_DIVISIONS;
        if (!(size > 0)) continue;
        const center = this.targetEntityLocalToWorld(target, nodeId, new THREE.Vector3(
          (Number(entry.x) + Number(entry.span) / 2) / MICRO_DIVISIONS,
          (Number(entry.y) + Number(entry.span) / 2) / MICRO_DIVISIONS,
          (Number(entry.z) + Number(entry.span) / 2) / MICRO_DIVISIONS
        ));
        boxes.push(createEntityPlacementObb(center, size, quaternionFor(nodeId)));
      }
    } else {
      for (const block of target.blocks || []) {
        const nodeId = contraptionBlockOwnerId(target, block);
        const size = Number(block.size) || 1;
        const center = target.getBlockWorldCenter?.(block)
          || this.targetEntityLocalToWorld(target, nodeId, new THREE.Vector3(
            Number(block.localX) + size / 2,
            Number(block.localY) + size / 2,
            Number(block.localZ) + size / 2
          ));
        boxes.push(createEntityPlacementObb(center, size, quaternionFor(nodeId)));
      }
    }
    const buckets = new Map<string, EntityPlacementObb[]>();
    for (const box of boxes) {
      const minX = Math.floor(box.min.x / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const minY = Math.floor(box.min.y / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const minZ = Math.floor(box.min.z / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const maxX = Math.floor((box.max.x - ENTITY_PLACEMENT_EPSILON) / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const maxY = Math.floor((box.max.y - ENTITY_PLACEMENT_EPSILON) / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const maxZ = Math.floor((box.max.z - ENTITY_PLACEMENT_EPSILON) / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          for (let z = minZ; z <= maxZ; z++) {
            const key = `${x},${y},${z}`;
            const bucket = buckets.get(key);
            if (bucket) bucket.push(box);
            else buckets.set(key, [box]);
          }
        }
      }
    }
    const result = { poseSignature, entriesRef, boxes, buckets };
    entityPlacementTargetObbCache.set(target, result);
    return result;
  }

  entitySlotOverlapsTarget(slot: InventoryInput, position: THREE.Vector3, quaternion: THREE.Quaternion, target: Contraption | null | undefined) {
    const shape = getEntityPlacementShape(slot);
    if (!shape) return false;
    const targetIndex = this.getTargetEntityPlacementObbs(target);
    if (targetIndex.boxes.length === 0) return false;
    for (const entry of shape.entries) {
      const center = entry.center.clone().applyQuaternion(quaternion).add(position);
      const placed = createEntityPlacementObb(center, entry.size, quaternion);
      const candidates = new Set<EntityPlacementObb>();
      const minX = Math.floor(placed.min.x / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const minY = Math.floor(placed.min.y / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const minZ = Math.floor(placed.min.z / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const maxX = Math.floor((placed.max.x - ENTITY_PLACEMENT_EPSILON) / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const maxY = Math.floor((placed.max.y - ENTITY_PLACEMENT_EPSILON) / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const maxZ = Math.floor((placed.max.z - ENTITY_PLACEMENT_EPSILON) / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          for (let z = minZ; z <= maxZ; z++) {
            for (const box of targetIndex.buckets.get(`${x},${y},${z}`) || []) candidates.add(box);
          }
        }
      }
      for (const existing of candidates) {
        if (entityPlacementObbsOverlap(placed, existing)) return true;
      }
    }
    return false;
  }

  resolveEntityTargetPlacement(slot: InventoryInput, shape: EntityPlacementShape, surface: THREE.Vector3, placementHit: PlacementHit) {
    const target = placementHit.targetContraption;
    const nodeId = placementHit.targetNodeId ?? contraptionRootId(placementHit.targetContraption);
    const targetWorldRotation = this.getTargetEntityWorldQuaternion(target, nodeId);
    const localNormal = this.axisAlignedEntityFaceNormal(placementHit.targetLocalNormal);
    const faceRotation = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      localNormal
    ).normalize();
    const relativeRotation = faceRotation
      .clone()
      .multiply(this.getEntityAnchorRotation(slot).invert())
      .normalize();
    const worldRotation = targetWorldRotation.clone().multiply(relativeRotation).normalize();
    const bounds = getRotatedEntityPlacementBounds(shape, relativeRotation);
    const surfaceLocal = this.targetEntityWorldToLocal(target, nodeId, surface);
    const originLocal = new THREE.Vector3(
      surfaceLocal.x - (bounds.minX + bounds.maxX) / 2,
      surfaceLocal.y - (bounds.minY + bounds.maxY) / 2,
      surfaceLocal.z - (bounds.minZ + bounds.maxZ) / 2
    );
    for (const axis of ['x', 'y', 'z'] as const) {
      const normal = localNormal[axis];
      if (normal > 0) originLocal[axis] = surfaceLocal[axis] - bounds[({ x: 'minX', y: 'minY', z: 'minZ' } as const)[axis]];
      else if (normal < 0) originLocal[axis] = surfaceLocal[axis] - bounds[({ x: 'maxX', y: 'maxY', z: 'maxZ' } as const)[axis]];
      originLocal[axis] = this.snapEntityPlacementMicroValue(originLocal[axis]);
    }

    const position = this.targetEntityLocalToWorld(target, nodeId, originLocal);
    const outwardWorld = localNormal.clone().applyQuaternion(targetWorldRotation).normalize();
    for (let step = 0; step <= ENTITY_TARGET_PLACEMENT_MAX_OUTWARD_STEPS; step++) {
      if (!this.entitySlotOverlapsTarget(slot, position, worldRotation, target)) {
        return { position, quaternion: worldRotation, localNormal };
      }
      position.addScaledVector(outwardWorld, 1 / MICRO_DIVISIONS);
    }
    return null;
  }

  resolveEntityTerrainSupport(
    shape: EntityPlacementShape,
    origin: THREE.Vector3,
    placementHit: PlacementHit
  ) {
    const normalY = Number(placementHit?.normal?.y) || 0;
    let bestOriginY = -Infinity;
    let supported = false;
    const down = new THREE.Vector3(0, -1, 0);
    const canRaycastStandard = typeof this.host.world?.raycast === 'function';
    const canRaycastMicro = typeof this.host.world?.raycastMicro === 'function';

    if (canRaycastStandard || canRaycastMicro) {
      // Start just below a downward-facing hit so the ceiling voxel itself is
      // not mistaken for support. Other faces start above the placed shape.
      const startY = origin.y + shape.maxY + (normalY < -0.5 ? -0.05 : 0.05);
      for (const sample of shape.supportSamples) {
        const lowestSurfaceY = origin.y + sample.bottom - ENTITY_PLACEMENT_MAX_DROP;
        const maxDistance = Math.max(0.05, startY - lowestSurfaceY);
        const rayOrigin = new THREE.Vector3(
          origin.x + sample.x,
          startY,
          origin.z + sample.z
        );
        for (const raycast of [
          canRaycastStandard ? this.host.world.raycast(rayOrigin, down, maxDistance) : null,
          canRaycastMicro ? this.host.world.raycastMicro(rayOrigin, down, maxDistance) : null
        ]) {
          const distance = Number(raycast?.distance);
          if (!raycast?.hit || !Number.isFinite(distance)
            || distance < -ENTITY_PLACEMENT_EPSILON
            || distance > maxDistance + ENTITY_PLACEMENT_EPSILON) continue;
          const supportTop = startY - Math.max(0, distance);
          bestOriginY = Math.max(bestOriginY, supportTop - sample.bottom);
          supported = true;
        }
      }
    }

    return {
      y: this.clampEntityPlacementY(
        shape,
        supported ? bestOriginY : origin.y
      ),
      supported
    };
  }

  getInventoryPlacementPose(slot: InventoryInput) {
    if (!slot || !Array.isArray(slot.blocks) || slot.blocks.length === 0) return null;

    const placementHit = this.getInventoryPlacementHit();
    if (!placementHit) return null;

    if (this.usesMicroBlockSetPlacement(slot)) {
      const position = this.getMicroBlockSetPlacementPosition(placementHit);
      if (!position) return null;
      return { slot, kind: 'blockset', position };
    }

    const hp = placementHit.hitPos;
    const n = placementHit.normal;
    const position = new THREE.Vector3(
      hp.x + (n?.x || 0),
      hp.y + (n?.y || 0),
      hp.z + (n?.z || 0)
    );
    const quaternion = new THREE.Quaternion();

    if (slot.kind === 'blockset') {
      position.set(
        Math.floor(position.x),
        Math.floor(position.y),
        Math.floor(position.z)
      );
    } else {
      const shape = getEntityPlacementShape(slot);
      const surface = this.getEntityPlacementSurfacePoint(placementHit);
      if (shape && surface) {
        if (placementHit.targetContraption && (slot.kind !== 'item'
          || (!slot.blockSet && slot.entityList?.length === 1))) {
          const targetPose = this.resolveEntityTargetPlacement(slot, shape, surface, placementHit);
          if (!targetPose) return null;
          position.copy(targetPose.position);
          quaternion.copy(targetPose.quaternion);
        } else {
          const placementRotation = this.getEntityPlacementRotation(slot);
          const terrainShape = getRotatedEntityTerrainShape(shape, placementRotation);
          quaternion.copy(placementRotation);
          const normal = placementHit.normal || { x: 0, y: 1, z: 0 };
          let originX = surface.x - terrainShape.centerX;
          let originY = surface.y - terrainShape.minY;
          let originZ = surface.z - terrainShape.centerZ;
          // On a wall or ceiling, keep the nearest authored face outside the
          // hit surface instead of centring half of the entity inside terrain.
          if ((Number(normal.x) || 0) > 0.5) originX = surface.x - terrainShape.minX;
          else if ((Number(normal.x) || 0) < -0.5) originX = surface.x - terrainShape.maxX;
          if ((Number(normal.z) || 0) > 0.5) originZ = surface.z - terrainShape.minZ;
          else if ((Number(normal.z) || 0) < -0.5) originZ = surface.z - terrainShape.maxZ;
          if ((Number(normal.y) || 0) < -0.5) originY = surface.y - terrainShape.maxY;
          const candidateOrigin = new THREE.Vector3(originX, originY, originZ);
          candidateOrigin.y = this.clampEntityPlacementY(terrainShape, candidateOrigin.y);
          position.copy(candidateOrigin);
          position.y = this.resolveEntityTerrainSupport(terrainShape, position, placementHit).y;
        }
      }
    }

    return {
      slot,
      kind: slot.kind === 'blockset' ? 'blockset' : 'entity',
      position: slot.kind === 'item' && slot.blockSet
        ? this.snapItemTerrainOrigin(slot, position)
        : position,
      quaternion,
      targetContraption: placementHit.targetContraption || null,
      targetNodeId: placementHit.targetNodeId || null
    };
  }

  snapItemTerrainOrigin(slot: InventoryInput, position: Point3) {
    const step = (slot.blockSet?.blocks || []).some(block => (block.size || 1) === 1) ? 1 : MICRO_SIZE;
    return new THREE.Vector3(
      Math.round(position.x / step) * step,
      Math.ceil((position.y - 1e-6) / step) * step,
      Math.round(position.z / step) * step,
    );
  }

  updateInventoryPlacementPreview() {
    this.inventoryPlacementPreview = null;
    if (this.host.worldPickingSuspended) return;
    if (this.host.activeTool !== SpecialTool.HAMMER) return;
    // Color sets apply to the palette with left-click — no placement ghost.
    if (this.host.activeInventoryCategory === 'colorset') return;
    const slot = this.getActiveHammerInventoryItem();
    if (!slot) return;
    this.inventoryPlacementPreview = this.getInventoryPlacementPose(slot);
  }
}
