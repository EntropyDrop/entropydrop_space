import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeBackpack,
  decodeBackpack,
  protobufFromBase64,
} from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';
import {
  VoxelMaterialIds,
  voxelMaterialEmission,
  voxelMaterialEmissionStrength,
} from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';
import { loadBackpack } from '../src/engine/inventory/BackpackPersistence.ts';
import { INVENTORY_STORAGE_KEY } from '../src/engine/inventory/InventoryStorageKeys.ts';
import { createVoxelTextPreviewMaterial } from '../src/engine/render/VoxelTextPreviewMaterial.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

class MemoryStorage {
  private readonly items = new Map<string, string>();
  private readonly binaries = new Map<string, Uint8Array>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, value); }
  getBytes(key: string) { return this.binaries.get(key) ?? null; }
  setBytes(key: string, value: Uint8Array) { this.binaries.set(key, value.slice()); }
}

test('loadBackpack migrates legacy emissive ID 1 to 151 across items and color sets and persists', () => {
  const storage = new MemoryStorage();
  const legacyItem: any = {
    type: 'space-item',
    version: 8,
    id: 'legacy-lamp',
    name: 'Legacy Lamp',
    blockSet: {
      type: 'space-blockset',
      version: 8,
      name: 'Lamp Static',
      blocks: [
        { dx: 0, dy: 0, dz: 0, color: 0xffaa00, materialId: 1 },
        { dx: 1, dy: 0, dz: 0, color: 0x112233, materialId: 185 },
      ],
      decorations: [{ dx: 0, dy: 0, dz: 0, color: 0xffffff, materialId: 1 }],
    },
    entityList: [{
      type: 'space-entity',
      version: 8,
      root: {
        id: 'root',
        name: 'Bulb',
        body: { type: 'kinematic' },
        blocks: [{ dx: 0, dy: 2, dz: 0, color: 0x00ffff, materialId: 1 }],
        decorations: [{ id: 'glow', color: 0xff00ff, materialId: 1 }],
        seats: [],
        children: [],
      },
      constraints: [],
    }],
  };
  const legacyColorset: any = {
    type: 'space-colorset',
    version: 8,
    name: 'Legacy Glow Palette',
    entries: Array.from({ length: 9 }, (_, i) => ({
      stops: [{ color: '#ffaa00', position: 0 }],
      materialId: i === 0 ? 1 : i === 1 ? 61 : i === 2 ? 201 : 0,
    })),
  };
  const encoded = encodeBackpack({
    activeCategory: 'item',
    categories: {
      item: { selected: 0, items: [legacyItem] },
      colorset: { selected: 0, items: [legacyColorset] },
    },
  });
  storage.setBytes(INVENTORY_STORAGE_KEY, encoded);

  const loaded = loadBackpack(storage);
  assert.equal(loaded.loaded, true);
  assert.equal(loaded.retainedOriginal, false);

  const restoredItem = loaded.inventories.item.items[0] as any;
  assert.equal(restoredItem.blockSet.blocks[0].materialId, 151);
  assert.equal(restoredItem.blockSet.blocks[1].materialId, 185);
  assert.equal(restoredItem.blockSet.anchoredDecorations[0].materialId, 151);
  assert.equal(restoredItem.entityList[0].blocks[0].materialId, 151);
  assert.equal(restoredItem.entityList[0].decorations[0].materialId, 151);

  const restoredPalette = loaded.inventories.colorset.items[0] as any;
  assert.deepEqual(restoredPalette.entries.slice(0, 4).map((e: any) => e.materialId), [151, 61, 201, 0]);

  const savedRaw = storage.getBytes(INVENTORY_STORAGE_KEY)
    ?? protobufFromBase64(storage.getItem(INVENTORY_STORAGE_KEY)!);
  const redecoded = decodeBackpack(savedRaw);
  const savedItem = redecoded.categories.item!.items[0] as any;
  assert.equal(savedItem.blockSet.blocks[0].materialId, 151);
  assert.equal(savedItem.blockSet.decorations[0].materialId, 151);
  assert.equal(savedItem.entityList[0].root.blocks[0].materialId, 151);
  assert.equal(savedItem.entityList[0].root.decorations[0].materialId, 151);
  assert.equal((redecoded.categories.colorset!.items[0] as any).entries[0].materialId, 151);
});

test('SpaceUiStore migrates legacy localStorage palette materialId 1 to 151 and formats glow levels', () => {
  const previousLocalStorage = (globalThis as any).localStorage;
  const map = new Map<string, string>();
  const legacyPalette = Array.from({ length: 9 }, (_, i) => ({
    name: `Slot ${i}`,
    stops: [{ color: '#ffaa00', position: 0 }],
    materialId: i === 0 ? 1 : i === 1 ? 102 : i === 2 ? 201 : 0,
  }));
  map.set('space_palette_colors', JSON.stringify(legacyPalette));
  (globalThis as any).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
  try {
    const store = new SpaceUiStore();
    store.setController(null);
    const snapshot = store.getSnapshot();
    assert.equal(snapshot.paletteColors[0].materialId, VoxelMaterialIds.EMISSIVE);
    assert.equal(snapshot.paletteColors[1].materialId, 102);
    assert.equal(snapshot.paletteColors[2].materialId, 201);
    const persisted = JSON.parse(map.get('space_palette_colors')!);
    assert.equal(persisted[0].materialId, 151);
  } finally {
    if (previousLocalStorage === undefined) delete (globalThis as any).localStorage;
    else (globalThis as any).localStorage = previousLocalStorage;
  }
});

test('VoxelTextPreviewMaterial supports legacy emissive ID 1 and all 100 glow levels', () => {
  for (const id of [1, 102, 151, 201]) {
    const material = createVoxelTextPreviewMaterial(id, 0xff8800) as any;
    assert.equal(material.type, 'MeshBasicNodeMaterial');
    assert.equal(material.transparent, true);
    assert.equal(material.opacity, 0.38);
    assert.ok(material.colorNode?.isNode);
    assert.ok(material.outputNode?.isNode);
    assert.equal(voxelMaterialEmission(id) / 50, voxelMaterialEmissionStrength(id));
    material.dispose();
  }
});
