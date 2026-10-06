import * as THREE from 'three';
import { MICRO_DIVISIONS } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import { BlockTypes, normalizeColor } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { normalizeVoxelMaterialId } from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';
import { normalizePaletteEntry } from '@entropydrop/space-engine/voxel/Palette.ts';
import { normalizeDecorations } from '@entropydrop/space-engine/contraption/Decorations.ts';
import { trimInventoryName, truncateInventoryName } from '@entropydrop/space-engine/storage/InventoryName.ts';
import {
  encodeInventoryResource, inventoryKindForPortable, newItemTemplateId,
  INVENTORY_PROTOBUF_SCHEMA_VERSION, runtimeEntityToPortable,
} from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';

export function inventoryEntityRootId(item: any): string {
  if (typeof item?.rootComponentId === 'string' && item.rootComponentId) return item.rootComponentId;
  const definitions = Array.isArray(item?.childEntities) ? item.childEntities : [];
  const childIds = new Set(definitions.map(definition => String(definition?.id ?? '')));
  const candidates = new Set<string>();
  for (const block of item?.blocks || []) {
    const owner = block?.entityId;
    if (typeof owner === 'string' && owner && !childIds.has(owner)) candidates.add(owner);
  }
  for (const definition of definitions) {
    const parentId = definition?.parentId;
    if (typeof parentId === 'string' && parentId && !childIds.has(parentId)) candidates.add(parentId);
  }
  return candidates.size === 1 ? [...candidates][0] : '';
}

/** Display name for a backpack item. Names are intentionally not unique. */
export function inventoryItemName(category: string, item: any, index = 0): string {
  const explicitName = typeof item?.name === 'string' ? trimInventoryName(item.name) : '';
  if (explicitName) return truncateInventoryName(explicitName);
  if (category === 'item') return `Item ${index + 1}`;
  if (category === 'blockset') {
    return `Block set ${index + 1}`;
  }
  if (category === 'entity') {
    return String(item?.rootComponentId || `Entity ${index + 1}`);
  }
  return `Color set ${index + 1}`;
}

/** Build the portable object used by Protobuf storage and transfer. */
export function serializeInventoryItem(category: string, item: any) {
  if (!item) return null;
  if (category === 'item') {
    if (item.kind !== 'item') return serializeInventoryItem(item.kind || 'entity', item);
    return {
      type: 'space-item', version: INVENTORY_PROTOBUF_SCHEMA_VERSION,
      id: item.id || newItemTemplateId(), name: inventoryItemName('item', item),
      ...(item.blockSet ? { blockSet: serializeInventoryItem('blockset', item.blockSet) } : {}),
      entityList: (item.entityList || []).map(entity => {
        const portable = serializeInventoryItem('entity', entity);
        if (entity.itemPosition?.some(value => value !== 0)) portable.root.localPosition = [...entity.itemPosition];
        if (entity.itemRotation?.some((value, index) => value !== (index === 3 ? 1 : 0))) portable.root.localRotation = [...entity.itemRotation];
        return portable;
      }),
    };
  }
  if (category === 'blockset') {
    return {
      type: 'space-blockset',
      version: INVENTORY_PROTOBUF_SCHEMA_VERSION,
      name: inventoryItemName('blockset', item),
      blocks: (item.blocks || []).map(b => {
        const shared = {
          block: BlockTypes.COLOR_BLOCK,
          color: normalizeColor(b.color ?? 0xf2a93b),
          materialId: normalizeVoxelMaterialId(b.materialId)
        };
        if ((b.size ?? 1) < 1) {
          // Block-set files keep every coordinate integral. dx/dy/dz select
          // the standard cell; mx/my/mz select one of its 8 subdivisions.
          const microX = Math.round(Number(b.dx) * MICRO_DIVISIONS);
          const microY = Math.round(Number(b.dy) * MICRO_DIVISIONS);
          const microZ = Math.round(Number(b.dz) * MICRO_DIVISIONS);
          const dx = Math.floor(microX / MICRO_DIVISIONS);
          const dy = Math.floor(microY / MICRO_DIVISIONS);
          const dz = Math.floor(microZ / MICRO_DIVISIONS);
          return {
            dx,
            dy,
            dz,
            mx: microX - dx * MICRO_DIVISIONS,
            my: microY - dy * MICRO_DIVISIONS,
            mz: microZ - dz * MICRO_DIVISIONS,
            ...shared
          };
        }
        return {
          dx: Math.round(Number(b.dx)),
          dy: Math.round(Number(b.dy)),
          dz: Math.round(Number(b.dz)),
          ...shared
        };
      })
    };
  }
  if (category === 'entity') {
    const rootComponentId = inventoryEntityRootId(item);
    const vector3 = value => Array.isArray(value) && value.length >= 3
      && value.slice(0, 3).every(component => Number.isFinite(Number(component)))
      ? value.slice(0, 3).map(Number)
      : undefined;
    const quaternion4 = value => Array.isArray(value) && value.length >= 4
      && value.slice(0, 4).every(component => Number.isFinite(Number(component)))
      && value.slice(0, 4).reduce((sum, component) => sum + Number(component) ** 2, 0) > 1e-12
      ? new THREE.Quaternion(...value.slice(0, 4).map(Number) as [number, number, number, number]).normalize().toArray()
      : undefined;
    const optionalNumber = value => value !== null && value !== undefined && Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
    // Seats accept the legacy `[x,y,z]` shorthand and the current object form.
    // A missing rotation stays implicit so plain seats round trip unchanged;
    // an unusable one drops the seat exactly like an unusable position.
    const portableSeat = seat => {
      const position = vector3(Array.isArray(seat) ? seat : seat?.position);
      if (!position) return null;
      if (Array.isArray(seat)) return { position };
      const rotation = quaternion4(seat.rotation);
      if (seat.rotation !== undefined && seat.rotation !== null && !rotation) return null;
      return {
        position,
        ...(rotation ? { rotation } : {}),
        ...(seat.fixedOrientation === true ? { fixedOrientation: true } : {})
      };
    };
    const portableSeats = seats => (seats || []).flatMap(seat => {
      const parsed = portableSeat(seat);
      return parsed ? [parsed] : [];
    });
    const childEntities = (item.childEntities || []).map(definition => ({
      id: String(definition.id || ''),
      name: typeof definition.name === 'string' ? truncateInventoryName(trimInventoryName(definition.name)) : '',
      parentId: String(definition.parentId ?? ''),
      ...(definition.collisionEnabled === false ? { collisionEnabled: false } : {}),
      ...(typeof definition.useGravity === 'boolean' ? { useGravity: definition.useGravity } : {}),
      ...(vector3(definition.pivot) ? { pivot: vector3(definition.pivot) } : {}),
      ...(vector3(definition.localPosition) ? { localPosition: vector3(definition.localPosition) } : {}),
      ...(quaternion4(definition.localRotation) ? { localRotation: quaternion4(definition.localRotation) } : {}),
      ...(quaternion4(definition.anchorRotation) ? { anchorRotation: quaternion4(definition.anchorRotation) } : {}),
      ...(['dynamic', 'kinematic'].includes(definition.bodyType) ? { bodyType: definition.bodyType } : {}),
      ...(optionalNumber(definition.mass) !== undefined ? { mass: optionalNumber(definition.mass) } : {}),
      ...(optionalNumber(definition.restitution) !== undefined ? { restitution: optionalNumber(definition.restitution) } : {}),
      ...(optionalNumber(definition.friction) !== undefined ? { friction: optionalNumber(definition.friction) } : {}),
      seats: portableSeats(definition.seats),
      ...(definition.decorations?.length ? { decorations: normalizeDecorations(definition.decorations) } : {})
    }));
    const constraints = (item.constraints || []).map(constraint => ({
      id: String(constraint.id || ''),
      type: ['point', 'hinge', 'weld'].includes(constraint.type) ? constraint.type : 'point',
      bodyA: constraint.bodyA == null ? null : String(constraint.bodyA),
      bodyB: String(constraint.bodyB || constraint.nodeId || ''),
      ...(vector3(constraint.anchorA) ? { anchorA: vector3(constraint.anchorA) } : {}),
      ...(vector3(constraint.anchorB) ? { anchorB: vector3(constraint.anchorB) } : {}),
      ...(vector3(constraint.axisA) ? { axisA: vector3(constraint.axisA) } : {}),
      ...(vector3(constraint.axisB) ? { axisB: vector3(constraint.axisB) } : {}),
      ...(vector3(constraint.referenceA) ? { referenceA: vector3(constraint.referenceA) } : {}),
      ...(vector3(constraint.referenceB) ? { referenceB: vector3(constraint.referenceB) } : {}),
      ...(constraint.limits && Number.isFinite(Number(constraint.limits.min))
        && Number.isFinite(Number(constraint.limits.max))
        ? { limits: { min: Number(constraint.limits.min), max: Number(constraint.limits.max) } }
        : {}),
      stiffness: Number.isFinite(Number(constraint.stiffness)) ? Number(constraint.stiffness) : 0.9,
      collideConnected: constraint.collideConnected === true
    }));
    const rootPivotOverride = vector3(item.rootPivotOverride ?? item.pivot);
    return runtimeEntityToPortable({
      name: typeof item.name === 'string' ? truncateInventoryName(trimInventoryName(item.name)) : '',
      rootComponentId,
      blocks: (item.blocks || []).map(b => {
        const shared = {
          block: BlockTypes.COLOR_BLOCK,
          color: normalizeColor(b.color ?? 0xf2a93b),
          materialId: normalizeVoxelMaterialId(b.materialId),
          entityId: b.entityId === undefined || b.entityId === null
            ? rootComponentId
            : String(b.entityId)
        };
        const x = Number(b.localX ?? b.dx);
        const y = Number(b.localY ?? b.dy);
        const z = Number(b.localZ ?? b.dz);
        if ((b.size ?? 1) < 1) {
          const microX = Math.round(x * MICRO_DIVISIONS);
          const microY = Math.round(y * MICRO_DIVISIONS);
          const microZ = Math.round(z * MICRO_DIVISIONS);
          const dx = Math.floor(microX / MICRO_DIVISIONS);
          const dy = Math.floor(microY / MICRO_DIVISIONS);
          const dz = Math.floor(microZ / MICRO_DIVISIONS);
          return {
            dx,
            dy,
            dz,
            mx: microX - dx * MICRO_DIVISIONS,
            my: microY - dy * MICRO_DIVISIONS,
            mz: microZ - dz * MICRO_DIVISIONS,
            ...shared
          };
        }
        return {
          dx: Math.round(x),
          dy: Math.round(y),
          dz: Math.round(z),
          ...shared
        };
      }),
      childEntities,
      scripts: (item.scripts || []).map(script => ({ id: String(script.id || ''), code: script.language === 'assemblyscript' ? String(script.code || '') : '', language: 'assemblyscript' })),
      enabled: (item.enabled || []).map(entry => ({ id: String(entry.id || ''), enabled: entry.enabled === true })),
      constraints,
      ...(rootPivotOverride ? { rootPivotOverride } : {}),
      ...(quaternion4(item.anchorRotation) ? { anchorRotation: quaternion4(item.anchorRotation) } : {}),
      bodyType: item.bodyType,
      mass: item.mass,
      restitution: item.restitution,
      friction: item.friction,
      useGravity: item.useGravity,
      collisionEnabled: item.collisionEnabled,
      seats: portableSeats(item.seats),
      ...(item.decorations?.length ? { decorations: normalizeDecorations(item.decorations) } : {})
    });
  }
  if (category === 'colorset') {
    return {
      type: 'space-colorset',
      version: INVENTORY_PROTOBUF_SCHEMA_VERSION,
      name: item.name || 'color set',
      entries: (item.entries || item.colors?.map(color => ({ stops: [{ color, position: 0 }] })) || [])
        .map(entry => normalizePaletteEntry(entry, item.name || 'Custom'))
    };
  }
  return null;
}

export function encodeInventoryItem(category: string, item: any): Uint8Array | null {
  const portable = serializeInventoryItem(category, item);
  if (!portable) return null;
  return encodeInventoryResource(inventoryKindForPortable(portable), portable);
}
