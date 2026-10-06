import {
  MAX_BACKPACK_ITEM_SLOTS,
  MAX_BACKPACK_SLOTS_PER_CATEGORY,
} from '@entropydrop/space-engine/constants/SpaceConstants.ts';
import { trimInventoryName, truncateInventoryName } from '@entropydrop/space-engine/storage/InventoryName.ts';
import {
  inventoryResourcePreviewItem,
  newItemTemplateId,
  wrapLegacyInventoryResource,
} from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';
import type { InventoryInput, InventoryKind } from '@entropydrop/space-engine/storage/InventoryTypes.ts';
import { PRESET_COLORS } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { normalizePaletteEntry } from '@entropydrop/space-engine/voxel/Palette.ts';
import { VoxelMaterialIds } from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';
import * as THREE from 'three';
import { inventoryItemName, serializeInventoryItem } from './InventorySerialization.ts';

export const INVENTORY_CATEGORIES = ['item', 'colorset'] as const;
export type BackpackCategory = typeof INVENTORY_CATEGORIES[number];
const DEFAULT_COLOR_SET_NAME = 'Default palette';
export interface InventoryGroup {
  items: Array<InventoryInput | null>;
  selected: number;
}
export interface Inventories {
  item: InventoryGroup;
  colorset: InventoryGroup;
  readonly blockset: InventoryGroup;
  readonly entity: InventoryGroup;
}

export function createEmptyInventories(): Inventories {
  const item: InventoryGroup = { items: Array.from({ length: MAX_BACKPACK_ITEM_SLOTS }, () => null), selected: 0 };
  const colorset: InventoryGroup = { items: Array.from({ length: MAX_BACKPACK_SLOTS_PER_CATEGORY }, () => null), selected: 0 };
  // Keep aliases non-enumerable: old callers share the Item collection/cursor,
  // while persistence and UI only enumerate the two current categories.
  return Object.defineProperties({ item, colorset }, {
    blockset: { get: () => item },
    entity: { get: () => item },
  }) as Inventories;
}

export function inventoryGroup(inventories: Partial<Inventories>, category: string): InventoryGroup | undefined {
  switch (category) {
    // Current collections expose aliases; older callers may still supply
    // independent blockset/entity collections without an Item collection.
    case 'item': case 'blockset': case 'entity': case 'colorset': return inventories[category];
    default: return undefined;
  }
}

export function addInventoryItem(inventories: Inventories, category: InventoryKind, item: InventoryInput | null): number | null {
  const originalCategory = category;
  category = category === 'colorset' ? 'colorset' : 'item';
  const group = inventoryGroup(inventories, category);
  if (!group || !item) return null;
  if (category === 'item' && item.kind !== 'item' && originalCategory !== 'item') {
    const portable = serializeInventoryItem(originalCategory, item);
    const worldPoseKnown = originalCategory === 'entity' && Array.isArray(item.sourcePosition) && Array.isArray(item.sourceRotation);
    if (worldPoseKnown && portable?.type === 'space-entity') {
      const inverseRotation = new THREE.Quaternion().fromArray(item.sourceRotation!).invert();
      const origin = new THREE.Vector3().fromArray(item.sourcePosition!);
      for (const constraint of portable.constraints || []) {
        if (constraint.bodyA != null) continue;
        for (const field of ['anchorA', 'axisA', 'referenceA'] as const) {
          if (!constraint[field]) continue;
          const value = new THREE.Vector3().fromArray(constraint[field]);
          if (field === 'anchorA') value.sub(origin);
          constraint[field] = value.applyQuaternion(inverseRotation).toArray();
        }
      }
    }
    if (!portable) return null;
    const wrapped = wrapLegacyInventoryResource(originalCategory, portable, item.id || newItemTemplateId(), worldPoseKnown);
    if (wrapped.type === 'space-item') item = inventoryResourcePreviewItem('item', wrapped);
  }
  if (category === 'colorset') {
    const source = Array.isArray(item.entries)
      ? item.entries
      : Array.isArray(item.colors)
        ? item.colors.map(color => ({ stops: [{ color, position: 0 }], materialId: 0 }))
        : [];
    item.entries = source.map(entry => normalizePaletteEntry(entry, item.name || 'Custom'));
    delete item.colors;
  }
  if (!item.id) {
    const prefix = category === 'colorset' ? 'cs_' : 'item_';
    item.id = typeof globalThis.crypto?.randomUUID === 'function'
      ? `${prefix}${globalThis.crypto.randomUUID()}`
      : `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
  // Put an item into the first available empty slot in the category.
  const index = group.items.findIndex(slot => !slot);
  if (index < 0) return null;
  item.name = inventoryItemName(category, item, index);
  group.items[index] = item;
  if (index < 9) {
    group.selected = index;
  }
  return index;
}

/** Rename one item. Duplicate and empty names are allowed within and across categories. */
export function renameInventoryItem(inventories: Inventories, category: string, index: number, name: unknown): string | null {
  const group = inventoryGroup(inventories, category);
  if (!group || !Number.isInteger(index) || !group.items[index]) return null;
  const cleanName = typeof name === 'string' ? truncateInventoryName(trimInventoryName(name)) : '';
  group.items[index].name = cleanName;
  return cleanName;
}

/** Remove one backpack item; keeps a valid selected index. */
export function deleteInventoryItem(inventories: Inventories, category: string, index: number): boolean {
  const group = inventoryGroup(inventories, category);
  if (!group || !Number.isInteger(index) || !group.items[index]) return false;
  if (category === 'colorset') {
    const nonNullCount = group.items.filter(Boolean).length;
    if (nonNullCount <= 1) return false;
    group.items.splice(index, 1);
    while (group.items.length < MAX_BACKPACK_SLOTS_PER_CATEGORY) {
      group.items.push(null);
    }
    if (group.selected >= group.items.filter(Boolean).length) {
      group.selected = Math.max(0, group.items.filter(Boolean).length - 1);
    }
    return true;
  }
  group.items[index] = null;
  if (!group.items[group.selected]) {
    const filled = group.items.findIndex(slot => slot);
    group.selected = filled >= 0 ? filled : 0;
  }
  return true;
}

/** Swap two slots within an inventory category. */
export function swapInventorySlots(inventories: Inventories, category: string, fromIndex: number, toIndex: number): boolean {
  const group = inventoryGroup(inventories, category);
  if (!group || !Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return false;
  const maxLen = group.items.length;
  if (fromIndex < 0 || fromIndex >= maxLen || toIndex < 0 || toIndex >= maxLen || fromIndex === toIndex) return false;

  const temp = group.items[fromIndex];
  group.items[fromIndex] = group.items[toIndex];
  group.items[toIndex] = temp;

  if (group.selected === fromIndex) {
    group.selected = toIndex;
  } else if (group.selected === toIndex) {
    group.selected = fromIndex;
  }

  return true;
}

/** Keep the built-in nine-entry palette available as a color set. */
export function ensureDefaultColorSet(inventories: Inventories): boolean {
  const items = inventories.colorset.items;
  const defaultEntries = PRESET_COLORS.map(color => normalizePaletteEntry({
    name: color.name,
    stops: [{ color: color.hex, position: 0 }],
    materialId: VoxelMaterialIds.DEFAULT,
  }));
  const alreadyPresent = items.some(item => item && Array.isArray(item.entries)
    && item.entries.length === defaultEntries.length
    && item.entries.every((entry, index) => (
      normalizePaletteEntry(entry).hex === defaultEntries[index].hex
      && normalizePaletteEntry(entry).stops.length === 1
    )));
  if (alreadyPresent) {
    items.forEach(item => {
      if (item && !item.id) {
        item.id = typeof globalThis.crypto?.randomUUID === 'function'
          ? `cs_${globalThis.crypto.randomUUID()}`
          : `cs_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      }
    });
    return false;
  }
  const index = items.findIndex(item => !item);
  if (index < 0) return false;
  items[index] = {
    id: typeof globalThis.crypto?.randomUUID === 'function'
      ? `cs_${globalThis.crypto.randomUUID()}`
      : `cs_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    name: DEFAULT_COLOR_SET_NAME,
    entries: defaultEntries
  };
  return true;
}
