import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { addInventoryItem, createEmptyInventories } from '../src/engine/inventory/Backpack.ts';
import { BULK_EDIT_THRESHOLD, PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

const item = (name: string) => ({ kind: 'item', id: name, name, entityList: [] });

test('copied items append after the existing hotbar items, including a hotbar with gaps', () => {
  const inventories = createEmptyInventories();
  const first = item('first'), second = item('second'), copy = item('copy');
  inventories.item.items[0] = first;
  inventories.item.items[5] = second;
  inventories.item.selected = 0;
  assert.equal(addInventoryItem(inventories, 'item', copy, 'hotbar-end'), 2);
  assert.deepEqual(inventories.item.items.slice(0, 4), [first, second, copy, null]);
  assert.equal(inventories.item.selected, 2);
});

test('a full hotbar moves its old last item after all existing storage items', () => {
  const inventories = createEmptyInventories();
  const hotbar = Array.from({ length: 9 }, (_, i) => item(`hotbar-${i}`));
  inventories.item.items.splice(0, 9, ...hotbar);
  const storageFirst = item('storage-first'), storageLast = item('storage-last');
  inventories.item.items[9] = storageFirst;
  inventories.item.items[12] = storageLast;
  const copy = item('copy');
  assert.equal(addInventoryItem(inventories, 'item', copy, 'hotbar-end'), 8);
  assert.deepEqual(inventories.item.items.slice(0, 9), [...hotbar.slice(0, 8), copy]);
  assert.equal(inventories.item.items[9], storageFirst);
  assert.equal(inventories.item.items[12], storageLast);
  assert.equal(inventories.item.items[13], hotbar[8]);
  assert.equal(inventories.item.selected, 8);
});

test('a storage gap makes room at the end without losing or reordering existing items', () => {
  const inventories = createEmptyInventories();
  inventories.item.items = inventories.item.items.map((_, i) => item(String(i)));
  inventories.item.items[30] = null;
  const before = inventories.item.items.filter(Boolean);
  const copy = item('copy');
  assert.equal(addInventoryItem(inventories, 'item', copy, 'hotbar-end'), 8);
  assert.deepEqual(inventories.item.items.slice(9), [...before.slice(9), before[8]]);
  const full = [...inventories.item.items];
  assert.equal(addInventoryItem(inventories, 'item', item('overflow'), 'hotbar-end'), null);
  assert.deepEqual(inventories.item.items, full);
  assert.equal(inventories.item.items.length, 198);
});

function fixture() {
  const scene = new THREE.Scene();
  const world = new World(scene);
  const manager = new ContraptionManager(scene, world, null, null);
  const toasts: string[] = [];
  const controller: any = Object.assign(Object.create(PlayerController.prototype), {
    _activeTool: SpecialTool.SELECTOR, world, contraptions: manager, keys: {},
    sound: { playBlockBreak() {}, playWrenchClick() {} },
    ui: { showToast: (message: string) => toasts.push(message), renderInventoryBar() {}, notifyContraptionStructureChanged() {} }
  });
  manager.selectionHost = controller;
  controller.inventoryCategory();
  const select = (x: number, maxX = x) => {
    manager.setCornerA({ x, y: 80, z: 10 });
    manager.setCornerB({ x: maxX, y: 80, z: 10 });
  };
  const entity = (x: number, count = 1) => {
    const source = new Contraption(manager.contraptions.length + 1,
      Array.from({ length: count }, (_, i) => ({ localX: i, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0x123456 })),
      new THREE.Vector3(x, 80, 10), scene);
    source.stopAllNodeScripts();
    manager.registerContraption(source);
    return source;
  };
  const drain = () => {
    let frames = 0;
    while (controller.bulkEditJob && frames++ < 1000) controller.processBulkEditFrame(64, Infinity);
    assert.equal(controller.bulkEditJob, null);
  };
  return { controller, world, manager, toasts, select, entity, drain };
}

test('X cuts confirmed world voxels and enclosed entities while keeping unselected content', () => {
  const f = fixture();
  f.world.setBlock(10, 80, 10, BlockTypes.COLOR_BLOCK, false, 0xff0000);
  f.world.setMicroBlock(88, 640, 80, 0xabcdef);
  f.world.setBlock(12, 80, 10, BlockTypes.COLOR_BLOCK, false, 0x00ff00);
  const inside = f.entity(12), outside = f.entity(15);
  f.select(10, 13);
  f.manager.connectedSelection = [{ x: 10, y: 80, z: 10 }, { x: 11, y: 80, z: 10 }, { x: 13, y: 80, z: 10 }];
  f.controller.handleKeyDown({ code: 'KeyX', preventDefault() {} });
  const copied = f.controller.inventories.item.items[0];
  assert.equal(copied.blockSet.blocks.length, 2);
  assert.equal(copied.entityList.length, 1);
  assert.equal(f.world.getBlock(10, 80, 10), BlockTypes.AIR);
  assert.equal(f.world.getMicroBlock(88, 640, 80), null);
  assert.equal(f.world.getBlock(12, 80, 10), BlockTypes.COLOR_BLOCK);
  assert.equal(f.manager.contraptions.includes(inside), false);
  assert.equal(f.manager.contraptions.includes(outside), true);
  assert.equal(f.manager.selectionBoxConfirmed, false);
  assert.equal(f.controller.activeTool, SpecialTool.HAMMER);
  assert.ok(f.toasts.some(message => message.startsWith('Cut ')));
});

test('cutting component blocks saves the selected blocks and preserves the others', () => {
  const f = fixture();
  const source = f.entity(10, 2);
  f.controller.selectedBlockSelection = {
    contraption: source, nodeId: source.rootComponentId, blocks: [source.blocks[0]],
    confirmedRange: { pointA: { x: 0, y: 0, z: 0 }, pointB: { x: 0, y: 0, z: 0 } }
  };
  assert.ok(f.controller.cutSelectionSmart());
  assert.equal(source.blocks.length, 1);
  assert.equal(source.blocks[0].localX, 1);
  assert.equal(f.controller.inventories.item.items[0].entityList[0].blocks.length, 1);
  assert.equal(f.controller.selectedBlockSelection, null);
  assert.equal(f.controller.activeTool, SpecialTool.HAMMER);
});

test('micro cutting removes only the selected virtual cell from a standard world block', () => {
  const f = fixture();
  f.world.setBlock(10, 80, 10, BlockTypes.COLOR_BLOCK, false, 0xabcdef);
  f.manager.setCornerA({ x: 10, y: 80, z: 10 }, { micro: true });
  f.manager.setCornerB({ x: 10, y: 80, z: 10 }, { micro: true });
  assert.ok(f.controller.cutSelectionSmart());
  assert.equal(f.controller.inventories.item.items[0].blockSet.blocks[0].size, 0.125);
  assert.equal(f.world.getMicroBlock(80, 640, 80), null);
  assert.equal(f.world.getMicroBlock(81, 640, 80)?.color, 0xabcdef);
});

test('cutting every parent block preserves unselected child components', () => {
  const f = fixture();
  const source = new Contraption(1, [
    { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0x123456, entityId: 'root' },
    { localX: 1, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0xabcdef, entityId: 'arm' }
  ], new THREE.Vector3(10, 80, 10), new THREE.Scene(), {
    rootComponentId: 'root', childEntities: [{ id: 'arm', parentId: 'root', pivot: [1.5, 0.5, 0.5] }]
  });
  source.stopAllNodeScripts();
  f.manager.registerContraption(source);
  f.controller.selectedBlockSelection = {
    contraption: source, nodeId: 'root', blocks: [source.blocks[0]],
    confirmedRange: { pointA: { x: 0, y: 0, z: 0 }, pointB: { x: 0, y: 0, z: 0 } }
  };
  assert.ok(f.controller.cutSelectionSmart());
  assert.equal(f.manager.contraptions.includes(source), true);
  assert.equal(source.blocks.length, 1);
  assert.equal(source.blocks[0].entityId, 'arm');
  assert.equal(source.entityNodes.has('arm'), true);
  assert.equal(f.controller.inventories.item.items[0].entityList[0].blocks.length, 1);
});

test('cutting a virtual entity micro cell copies that cell and keeps the other 511 cells', () => {
  const f = fixture();
  const source = f.entity(10);
  const block = source.blocks[0];
  f.controller.selectedBlockSelection = {
    contraption: source, nodeId: source.rootComponentId, micro: true,
    blocks: [{ ...block, size: 0.125, virtualMicro: true, sourceBlock: block }],
    confirmedRange: { pointA: { x: 0, y: 0, z: 0 }, pointB: { x: 0, y: 0, z: 0 } }
  };
  assert.ok(f.controller.cutSelectionSmart());
  assert.equal(source.blocks.length, 511);
  assert.equal(source.blocks.some(cell => cell.localX === 0 && cell.localY === 0 && cell.localZ === 0), false);
  const copied = f.controller.inventories.item.items[0].entityList[0].blocks;
  assert.equal(copied.length, 1);
  assert.equal(copied[0].size, 0.125);
});

test('world cutting rejects enclosed entities that cannot be edited without saving or deleting anything', () => {
  const f = fixture();
  const source = f.entity(10);
  source.serverManaged = true;
  source.serverCanEdit = false;
  f.world.setBlock(11, 80, 10, BlockTypes.COLOR_BLOCK, false, 0xabcdef);
  f.select(10, 11);
  assert.equal(f.controller.cutSelectionSmart(), null);
  assert.equal(f.controller.inventories.item.items.filter(Boolean).length, 0);
  assert.equal(f.manager.contraptions.includes(source), true);
  assert.equal(f.world.getBlock(11, 80, 10), BlockTypes.COLOR_BLOCK);
  assert.equal(f.manager.selectionBoxConfirmed, true);
});

test('a full backpack rejects cutting without changing the source or selection', () => {
  for (const target of ['world', 'entity']) {
    const f = fixture();
    f.controller.inventories.item.items.fill(item('full'));
    f.world.setBlock(10, 80, 10, BlockTypes.COLOR_BLOCK, false, 0xabcdef);
    const source = f.entity(12);
    if (target === 'world') f.select(10, 12);
    else f.controller.selectedBlockSelection = {
      contraption: source, nodeId: source.rootComponentId, blocks: [...source.blocks],
      confirmedRange: { pointA: { x: 0, y: 0, z: 0 }, pointB: { x: 0, y: 0, z: 0 } }
    };
    assert.equal(f.controller.cutSelectionSmart(), null);
    assert.equal(f.world.getBlock(10, 80, 10), BlockTypes.COLOR_BLOCK);
    assert.equal(source.blocks.length, 1);
    assert.equal(f.manager.contraptions.includes(source), true);
    assert.equal(f.controller.canUseSelectionActions(), true);
    assert.equal(f.controller.activeTool, SpecialTool.SELECTOR);
  }
});

test('large cutting finishes the backup before deleting captured cells across bounded frames', () => {
  const f = fixture();
  const side = Math.floor(Math.sqrt(BULK_EDIT_THRESHOLD)) + 1;
  const count = side * side;
  for (let i = 0; i < count; i++) f.world.setBlock(10 + i % side, 80, 10 + Math.floor(i / side), BlockTypes.COLOR_BLOCK, false, 0xabcdef);
  f.manager.setCornerA({ x: 10, y: 80, z: 10 });
  f.manager.setCornerB({ x: 10 + side - 1, y: 80, z: 10 + side - 1 });
  assert.equal(f.controller.cutSelectionSmart(), true);
  f.controller.processBulkEditFrame(1, Infinity);
  assert.equal(f.controller.inventories.item.items.filter(Boolean).length, 0);
  assert.equal(f.world.getBlock(10, 80, 10), BlockTypes.COLOR_BLOCK);
  // A new selection must not redirect the pending cut.
  f.world.setBlock(500, 80, 10, BlockTypes.COLOR_BLOCK, false, 0x123456);
  f.select(500);
  while (f.controller.bulkEditJob?.label === 'Copying world selection') f.controller.processBulkEditFrame(16, Infinity);
  assert.ok(f.controller.inventories.item.items[0]);
  assert.equal(f.controller.bulkEditJob?.label, 'Cutting world selection');
  f.drain();
  assert.equal(f.world.getBlock(10, 80, 10), BlockTypes.AIR);
  assert.equal(f.world.getBlock(10 + side - 1, 80, 10 + side - 1), BlockTypes.AIR);
  assert.equal(f.world.getBlock(500, 80, 10), BlockTypes.COLOR_BLOCK);
  assert.equal(f.controller.inventories.item.items[0].blockSet.blocks.length, count);
});

test('X ignores key repeat, text inputs and other tools', () => {
  const f = fixture();
  let cuts = 0;
  f.controller.cutSelectionSmart = () => { cuts++; };
  const press = (options = {}) => f.controller.handleKeyDown({ code: 'KeyX', preventDefault() {}, ...options });
  press({ repeat: true });
  press({ target: { tagName: 'INPUT' } });
  f.controller._activeTool = SpecialTool.HAMMER;
  press();
  assert.equal(cuts, 0);
  f.controller._activeTool = SpecialTool.SELECTOR;
  press();
  assert.equal(cuts, 1);
});

test('backpack Copy and selector Copy both select the new hotbar item and retain the displaced item', () => {
  for (const operation of ['backpack', 'selector']) {
    const f = fixture();
    const hotbar = Array.from({ length: 9 }, (_, i) => ({ kind: 'blockset', name: `slot-${i}`,
      blocks: [{ dx: 0, dy: 0, dz: 0, color: 0x123456 }], blockCount: 1 }));
    f.controller.inventories.item.items.splice(0, 9, ...hotbar);
    f.controller.inventories.item.items[10] = item('stored');
    if (operation === 'backpack') {
      const store = new SpaceUiStore();
      store.setController(f.controller);
      store.copyInventoryItem('item', 0);
    } else {
      f.world.setBlock(10, 80, 10, BlockTypes.COLOR_BLOCK, false, 0xabcdef);
      f.select(10);
      assert.ok(f.controller.copySelectionSmart());
    }
    assert.equal(f.controller.inventories.item.selected, 8);
    assert.notEqual(f.controller.inventories.item.items[8], hotbar[8]);
    assert.equal(f.controller.inventories.item.items[11], hotbar[8]);
    assert.equal(f.controller.inventories.item.items.filter(Boolean).length, 11);
  }
});
