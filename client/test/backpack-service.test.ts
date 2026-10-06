import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmptyInventories, inventoryGroup, addInventoryItem, renameInventoryItem, swapInventorySlots,
  deleteInventoryItem, ensureDefaultColorSet,
} from '../src/engine/inventory/Backpack.ts';
import { loadBackpack, saveBackpack, type BackpackStorage } from '../src/engine/inventory/BackpackPersistence.ts';
import { INVENTORY_STORAGE_KEY } from '../src/engine/inventory/InventoryStorageKeys.ts';
import { encodeInventoryItem } from '../src/engine/inventory/InventorySerialization.ts';
import { encodeBackpack } from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';
import type { PortableBlockSet } from '@entropydrop/space-engine/storage/InventoryTypes.ts';

function memoryStorage() {
  const values = new Map<string, string | Uint8Array>();
  let writes = 0;
  const storage: BackpackStorage = {
    getItem(key) { const value = values.get(key); return typeof value === 'string' ? value : null; },
    getBytes(key) { const value = values.get(key); return value instanceof Uint8Array ? value : null; },
    setItem(key, value) { writes++; values.set(key, value); },
    setBytes(key, value) { writes++; values.set(key, value); },
  };
  return { storage, values, get writes() { return writes; } };
}

test('backpack collections own aliases, selection, renaming and the last-palette guard without a controller', () => {
  const groups = createEmptyInventories();
  assert.deepEqual(Object.keys(groups), ['item', 'colorset']);
  assert.equal(groups.entity, groups.item);
  assert.equal(groups.blockset, groups.item);
  assert.equal(groups.item.items.length, 198);
  assert.equal(groups.colorset.items.length, 99);
  const legacy = { blockset: { selected: 2, items: [] }, entity: { selected: 4, items: [] } };
  assert.equal(inventoryGroup(legacy, 'blockset'), legacy.blockset);
  assert.equal(inventoryGroup(legacy, 'entity'), legacy.entity);
  assert.equal(inventoryGroup(legacy, 'item'), undefined);
  const index = addInventoryItem(groups, 'blockset', {
    kind: 'blockset', name: 'A', blocks: [{ dx: -0.125, dy: 0, dz: 0, size: 0.125, color: 1 }],
  });
  assert.equal(index, 0);
  assert.equal(groups.item.items[0]?.kind, 'item');
  assert.equal(renameInventoryItem(groups, 'entity', 0, '  Renamed  '), 'Renamed');
  assert.equal(swapInventorySlots(groups, 'item', 0, 5), true);
  assert.equal(groups.item.selected, 5);
  assert.equal(groups.item.items[5]?.name, 'Renamed');
  assert.equal(swapInventorySlots(groups, 'item', -1, 5), false);
  assert.equal(deleteInventoryItem(groups, 'item', 5), true);
  assert.equal(groups.item.selected, 0);
  assert.equal(ensureDefaultColorSet(groups), true);
  assert.equal(ensureDefaultColorSet(groups), false);
  assert.equal(deleteInventoryItem(groups, 'colorset', 0), false);
});

test('standalone persistence round trips the selected Item and its micro coordinates', () => {
  const fixture = memoryStorage();
  const groups = createEmptyInventories();
  addInventoryItem(groups, 'blockset', {
    kind: 'blockset', name: 'Fine', blocks: [{ dx: -0.125, dy: 0.25, dz: 0.875, size: 0.125, color: 0x123456 }],
  });
  ensureDefaultColorSet(groups);
  swapInventorySlots(groups, 'item', 0, 8);
  assert.equal(saveBackpack(groups, 'item', fixture.storage), true);
  const stored = fixture.values.get(INVENTORY_STORAGE_KEY);
  const loaded = loadBackpack(fixture.storage);
  assert.equal(loaded.loaded, true);
  assert.equal(loaded.retainedOriginal, false);
  assert.equal(loaded.inventories.item.selected, 8);
  assert.equal(loaded.inventories.item.items[8]?.id, groups.item.items[8]?.id);
  assert.deepEqual(encodeInventoryItem('item', loaded.inventories.item.items[8]), encodeInventoryItem('item', groups.item.items[8]));
  assert.deepEqual(loaded.inventories.item.items[8]?.blocks?.map(block => [block.dx, block.dy, block.dz, block.size]), [[-0.125, 0.25, 0.875, 0.125]]);
  assert.equal(fixture.writes, 1, 'unchanged v10 data must not be rewritten on load');
  assert.equal(fixture.values.get(INVENTORY_STORAGE_KEY), stored);
});

test('partially invalid resources retain the entire original backpack in storage', () => {
  const fixture = memoryStorage();
  const valid: PortableBlockSet = {
    type: 'space-blockset', version: 8, name: 'Valid', blocks: [{ dx: 0, dy: 0, dz: 0, color: 1 }],
  };
  const original = encodeBackpack({
    activeCategory: 'item', categories: {
      item: { selected: 1, items: [valid, { ...valid, blocks: [] }] },
    },
  });
  fixture.values.set(INVENTORY_STORAGE_KEY, original);
  const result = loadBackpack(fixture.storage);
  assert.equal(result.loaded, true);
  assert.equal(result.retainedOriginal, true);
  assert.ok(result.inventories.item.items[0]);
  assert.equal(result.inventories.item.items[1], null);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.values.get(INVENTORY_STORAGE_KEY), original);
});

test('serialization failures return false without throwing or replacing a stored backpack', () => {
  const fixture = memoryStorage();
  const original = new Uint8Array([1, 2, 3]);
  fixture.values.set(INVENTORY_STORAGE_KEY, original);
  const groups = createEmptyInventories();
  groups.item.items[0] = {
    kind: 'entity', rootComponentId: 'root',
    childEntities: [{ id: 'child', parentId: 'missing' }],
    blocks: [{ entityId: 'root', localX: 0, localY: 0, localZ: 0 }],
  };
  assert.equal(saveBackpack(groups, 'item', fixture.storage), false);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.values.get(INVENTORY_STORAGE_KEY), original);
});

test('unreadable storage can initialize a usable palette without overwriting the original bytes', () => {
  const fixture = memoryStorage();
  const original = new Uint8Array([255]);
  fixture.values.set(INVENTORY_STORAGE_KEY, original);
  const result = loadBackpack(fixture.storage);
  assert.equal(result.loaded, false);
  assert.equal(result.retainedOriginal, true);
  assert.equal(result.inventories.colorset.items[0]?.entries?.length, 9);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.values.get(INVENTORY_STORAGE_KEY), original);
});
