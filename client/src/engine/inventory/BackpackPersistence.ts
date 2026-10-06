import {
  BACKPACK_PROTOBUF_SCHEMA_VERSION,
  decodeBackpack,
  encodeBackpack,
  encodeInventoryResource,
  inventoryKindForPortable,
  protobufFromBase64,
  protobufToBase64,
  type PortableBackpack,
} from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';
import type { SpaceStorage } from '@entropydrop/space-engine/storage/SpaceStorage.ts';
import {
  INVENTORY_CATEGORIES,
  createEmptyInventories,
  ensureDefaultColorSet,
  type BackpackCategory,
  type Inventories,
} from './Backpack.ts';
import { parseInventoryImport } from './InventoryImport.ts';
import { serializeInventoryItem } from './InventorySerialization.ts';
import {
  INVENTORY_STORAGE_KEY,
  LEGACY_INVENTORY_STORAGE_KEY,
  PREVIOUS_INVENTORY_STORAGE_KEY,
} from './InventoryStorageKeys.ts';

export type BackpackStorage = Pick<SpaceStorage, 'getItem' | 'setItem' | 'getBytes' | 'setBytes'>;
export interface BackpackLoadResult {
  inventories: Inventories;
  activeCategory: BackpackCategory;
  loaded: boolean;
  /** A bad resource must never cause a partial backpack to overwrite storage. */
  retainedOriginal: boolean;
}

/** Persist Items and palettes in the same canonical format used by export. */
export function saveBackpack(inventories: Inventories, activeCategory: string, storage: BackpackStorage | null): boolean {
  if (!storage || !inventories) return false;
  try {
    const categories: PortableBackpack['categories'] = {};
    for (const category of INVENTORY_CATEGORIES) {
      const group = inventories[category];
      categories[category] = {
        selected: group.selected,
        items: group.items.map(item => item ? serializeInventoryItem(category, item) : null)
      };
    }
    const encoded = encodeBackpack({
      activeCategory: activeCategory === 'colorset' ? 'colorset' : 'item',
      categories
    });
    if (typeof storage.setBytes === 'function') storage.setBytes(INVENTORY_STORAGE_KEY, encoded);
    else storage.setItem(INVENTORY_STORAGE_KEY, protobufToBase64(encoded));
    return true;
  } catch (err) {
    console.warn('Could not save backpack to browser storage:', err);
    return false;
  }
}

/** Restore the backpack on startup; old or malformed storage is intentionally ignored. */
export function loadBackpack(storage: BackpackStorage | null): BackpackLoadResult {
  const inventories = createEmptyInventories();
  let activeCategory: BackpackCategory = 'item';
  let loaded = false;
  let changed = false;
  let failed = false;

  try {
    const raw = storage?.getBytes?.(INVENTORY_STORAGE_KEY)
      ?? storage?.getItem(INVENTORY_STORAGE_KEY)
      ?? storage?.getBytes?.(PREVIOUS_INVENTORY_STORAGE_KEY)
      ?? storage?.getItem(PREVIOUS_INVENTORY_STORAGE_KEY)
      ?? storage?.getBytes?.(LEGACY_INVENTORY_STORAGE_KEY)
      ?? storage?.getItem(LEGACY_INVENTORY_STORAGE_KEY);
    if (raw) {
      const data = decodeBackpack(typeof raw === 'string' ? protobufFromBase64(raw) : raw);
      changed = data.sourceSchemaVersion !== BACKPACK_PROTOBUF_SCHEMA_VERSION;
      for (const category of INVENTORY_CATEGORIES) {
        const storedGroup = data.categories?.[category];
        const maxLen = inventories[category].items.length;
        const storedItems = Array.isArray(storedGroup?.items) ? storedGroup.items.slice(0, maxLen) : [];
        for (let index = 0; index < storedItems.length; index++) {
          if (!storedItems[index]) continue;
          const parsed = parseInventoryImport(
            encodeInventoryResource(inventoryKindForPortable(storedItems[index]), storedItems[index]),
            category
          );
          if (parsed.ok) inventories[category].items[index] = parsed.item;
          else failed = true;
        }
        const selected = Number(storedGroup?.selected);
        inventories[category].selected = Number.isInteger(selected) && selected >= 0 && selected < maxLen ? selected : 0;
      }
      if (data.activeCategory === 'item' || data.activeCategory === 'colorset') activeCategory = data.activeCategory;
      loaded = true;
    }
  } catch (err) {
    failed = true;
    console.warn('Could not read backpack; original storage was retained:', err);
  }

  if (ensureDefaultColorSet(inventories)) changed = true;
  if (storage && !failed && (!loaded || changed)) {
    saveBackpack(inventories, activeCategory, storage);
  }
  return { inventories, activeCategory, loaded, retainedOriginal: failed };
}
