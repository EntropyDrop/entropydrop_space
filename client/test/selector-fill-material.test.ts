import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

function fixture() {
  const scene = new THREE.Scene();
  const world = new World(scene);
  const manager = new ContraptionManager(scene, world, null, null);
  const store = new SpaceUiStore();
  const controller: any = Object.create(PlayerController.prototype);
  Object.assign(controller, {
    _activeTool: SpecialTool.SELECTOR, world, contraptions: manager, ui: store,
    selectedSubtree: null, selectedBlockSelection: null, selectorLevel: null,
    selectorRange: null, selectorShape: 'box', selectorMicroMode: false,
    inventorySlots: new Array(9).fill(null), selectedInventoryIndex: 0,
    keys: {}, physics: { isFlying: false, isSprinting: false },
    sound: { playBlockPlace() {} },
  });
  manager.selectionHost = controller;
  store.setController(controller);
  store.setContraptions(manager);
  controller._activeTool = SpecialTool.SELECTOR;
  store.setPaletteEntry(1, { stops: [{ color: '#48dbfb', position: 0 }], materialId: 1 });
  store.selectPresetColor(0);
  return { controller, manager, world, store };
}

for (const micro of [false, true]) for (const sampled of [false, true]) {
  test(`selector ${micro ? 'micro' : 'standard'} Fill uses the ${sampled ? 'sampled' : 'chosen'} palette material`, () => {
    const { controller, manager, world, store } = fixture();
    if (sampled) store.setBuildColor('#48dbfb', false);
    else store.selectPresetColor(1);
    assert.equal(store.getSnapshot().paletteColors[store.getSnapshot().selectedColorIndex].materialId, 1);
    if (micro) {
      manager.microBounds = { minX: 80, maxX: 81, minY: 400, maxY: 401, minZ: 80, maxZ: 81 };
    } else {
      manager.selectionCornerA = { x: 10, y: 50, z: 10 };
      manager.selectionCornerB = { x: 11, y: 50, z: 10 };
    }
    manager.selectionBoxConfirmed = true;
    controller.fillSelectionBlocks();
    if (micro) {
      for (const x of [80, 81]) for (const y of [400, 401]) for (const z of [80, 81]) {
        assert.equal(world.getMicroBlock(x, y, z)?.materialId, 1);
        assert.equal(world.getMicroBlock(x, y, z)?.color, 0x48dbfb);
      }
    } else {
      for (const x of [10, 11]) {
        assert.equal(world.getBlockMaterial(x, 50, 10), 1);
        assert.equal(world.getBlockColor(x, 50, 10), 0x48dbfb);
      }
    }
  });
}

test('sampling a default palette color also switches Fill back from emissive to default', () => {
  const { controller, manager, world, store } = fixture();
  store.selectPresetColor(1);
  store.setBuildColor(store.getSnapshot().paletteColors[0].hex, false);
  manager.selectionCornerA = manager.selectionCornerB = { x: 10, y: 50, z: 10 };
  manager.selectionBoxConfirmed = true;
  controller.fillSelectionBlocks();
  assert.equal(world.getBlockMaterial(10, 50, 10), 0);
  assert.equal(controller.selectedMaterialId, 0);
  assert.equal(store.getSnapshot().selectedMaterialId, 0);
});

test('sampling retains the active material when palette entries share the same color', () => {
  const { controller, store } = fixture();
  const color = store.getSnapshot().paletteColors[0].hex;
  store.setPaletteEntry(1, { stops: [{ color, position: 0 }], materialId: 1 });
  store.setBuildColor(color, false);
  assert.equal(store.getSnapshot().selectedColorIndex, 1);
  assert.equal(store.getSnapshot().selectedMaterialId, 1);
  assert.equal(controller.selectedMaterialId, 1);
});

test('sampling a color outside the palette retains the current build material', () => {
  const { controller, store } = fixture();
  store.selectPresetColor(1);
  store.setBuildColor('#010203', false);
  assert.equal(controller.selectedColor, 0x010203);
  assert.equal(controller.selectedMaterialId, 1);
  assert.equal(store.getSnapshot().selectedMaterialId, 1);
});
