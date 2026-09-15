import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ActionDomain } from '@entropydrop/space-engine/actions/BasicActions.ts';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { computeSelectionCells } from '../src/engine/controls/SelectorShapes.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

function fixture(micro = false) {
  const scene = new THREE.Scene();
  const world = new World(scene);
  const manager = new ContraptionManager(scene, world, null, null);
  const store = new SpaceUiStore();
  const holograms: any[][] = [];
  const controller: any = Object.create(PlayerController.prototype);
  Object.assign(controller, {
    _activeTool: SpecialTool.SELECTOR, contraptions: manager, world, ui: store,
    selectedSubtree: null, selectedBlockSelection: null, selectorRange: null, selectorLevel: null,
    selectorShape: 'box', selectorMicroMode: micro, selectionShapeAnchor: null,
    inventorySlots: new Array(8).fill(null), selectedInventoryIndex: 0, keys: {},
    entityInputDown: new Set(), entityInputPressed: new Set(), entityInputReleased: new Set(),
    sound: { playWrenchClick() {} },
    sceneRenderer: {
      updateSelectionHologram(...args) { holograms.push(args); },
      updateSelectionAxisGizmo() {}, clearSelectionAxisGizmo() {}
    }
  });
  manager.selectionHost = controller;
  store.setController(controller);
  store.setContraptions(manager);
  controller._activeTool = SpecialTool.SELECTOR;
  return { controller, manager, world, store, scene, holograms };
}

for (const micro of [false, true]) {
  test(`world ${micro ? 'micro' : 'standard'} shape changes publish new cells immediately, without a HUD tick`, () => {
    const { controller, manager, world, store, holograms } = fixture(micro);
    const a = { x: 0, y: micro ? 400 : 50, z: 0 };
    const b = { x: 4, y: micro ? 402 : 52, z: 4 };
    if (micro) world.setBlock(0, 50, 0, BlockTypes.COLOR_BLOCK, false, 0xff0000);
    manager.setCornerA(micro ? { x: a.x / 8, y: a.y / 8, z: a.z / 8 } : a, { micro });
    manager.setCornerB(micro ? { x: b.x / 8, y: b.y / 8, z: b.z / 8 } : b, { micro });
    store.updateToolPanelMode();
    const published: any[] = [];
    store.subscribe(() => published.push(store.getSnapshot().selector));
    for (const shape of ['sphere', 'stairs', 'box'] as const) {
      published.length = 0;
      const expected = computeSelectionCells(shape, a, b, micro).length;
      assert.doesNotThrow(() => store.setSelectorShape(shape), 'real UI/controller bridge must not recurse');
      assert.equal(controller.selectorShape, shape);
      assert.equal(manager.getSelectionBlockCount(), expected);
      assert.ok(published.length > 0);
      for (const state of published) {
        assert.equal(state.shape, shape);
        assert.match(state.details, new RegExp(`${expected} cells`));
        assert.equal(state.canModify, true);
        assert.equal(state.canCopy, true);
        assert.equal(state.canDelete, true);
      }
      assert.ok(holograms.length > 0, 'highlight refresh is synchronous too');
      assert.equal(manager.selectionBoxConfirmed, true, 'shape changes retain A/B confirmation');
    }
    assert.deepEqual(controller.selectionShapeAnchor.cornerA, a);
    assert.deepEqual(controller.selectionShapeAnchor.cornerB, b);
    if (micro) assert.equal(world.microVoxels.cells.size, 0, 'changing shape must not subdivide terrain');
  });
}

test('entity shape changes synchronize highlight, engine selection and UI count, and Box restores the range', () => {
  const { controller, manager, store, scene, holograms } = fixture();
  const blocks: any[] = [];
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) {
    blocks.push({ localX: x, localY: y, localZ: z, block: BlockTypes.COLOR_BLOCK });
  }
  const entity = new Contraption(1, blocks, new THREE.Vector3(0, 50, 0), scene, { rootComponentId: 'root' });
  entity.stopAllNodeScripts();
  manager.registerContraption(entity);
  controller.hoveredContraptionHit = { contraption: entity, entityId: 'root' };
  assert.equal(controller.selectAllSelectionBlocks(), true);
  for (const shape of ['sphere', 'stairs', 'box'] as const) {
    store.setSelectorShape(shape);
    const expected = computeSelectionCells(shape, { x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 2 }).length;
    assert.equal(controller.selectedBlockSelection.blocks.length, expected);
    assert.equal(manager.entitySelection.blocks, controller.selectedBlockSelection.blocks);
    assert.equal(manager.performBasicAction({ domain: ActionDomain.SELECTION, action: 'get' }).count, expected);
    assert.match(store.getSnapshot().selector.details, new RegExp(`${expected} blocks`));
    assert.equal(store.getSnapshot().selector.shape, shape);
    assert.equal(store.getSnapshot().selector.canDelete, true);
    const highlight = holograms.at(-1);
    assert.ok(highlight?.[4]?.object, 'entity-local rendering frame is retained');
  }
  assert.equal(entity.blocks.length, 27, 'only selection changes, not entity geometry');
});

test('empty entity shapes retain confirmed A/B and immediately disable actions, then Box restores them', () => {
  const { controller, manager, store, scene } = fixture();
  const blocks: any[] = [];
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
    blocks.push({ localX: x, localY: y, localZ: z, block: BlockTypes.COLOR_BLOCK });
  }
  const entity = new Contraption(1, blocks, new THREE.Vector3(), scene, { rootComponentId: 'root' });
  entity.stopAllNodeScripts();
  manager.registerContraption(entity);
  controller.hoveredContraptionHit = { contraption: entity, entityId: 'root' };
  controller.selectAllSelectionBlocks();
  store.setSelectorShape('sphere');
  const empty = store.getSnapshot().selector;
  assert.match(empty.details, /0 blocks.*A\/B \[2\/2\]/);
  assert.equal(empty.hasSelection, true, 'the range can still be cleared or changed back');
  assert.equal(empty.canModify, false);
  assert.equal(empty.canCopy, false);
  assert.equal(empty.canDelete, false);
  assert.equal(empty.canAssemble, false);
  assert.equal(manager.entitySelection.blocks.length, 0);
  store.setSelectorShape('box');
  assert.match(store.getSnapshot().selector.details, /8 blocks/);
  assert.equal(store.getSnapshot().selector.canDelete, true);
});

test('entity micro shapes publish virtual voxel counts without subdividing geometry', () => {
  const { controller, manager, store, scene } = fixture(true);
  const entity = new Contraption(1, [
    { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0xff0000 }
  ], new THREE.Vector3(), scene, { rootComponentId: 'root' });
  entity.stopAllNodeScripts();
  manager.registerContraption(entity);
  controller.hoveredContraptionHit = { contraption: entity, entityId: 'root' };
  assert.equal(controller.selectAllSelectionBlocks(), true);
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 7, y: 7, z: 7 };
  for (const shape of ['sphere', 'stairs', 'box'] as const) {
    store.setSelectorShape(shape);
    const expected = computeSelectionCells(shape, a, b, true).length;
    assert.equal(controller.selectedBlockSelection.blocks.length, expected);
    assert.equal(manager.entitySelection.blocks.length, expected);
    assert.match(store.getSnapshot().selector.details, new RegExp(`${expected} blocks`));
    assert.equal(store.getSnapshot().selector.canModify, true);
    assert.equal(entity.blocks.length, 1);
    assert.equal(entity.blocks[0].size || 1, 1);
  }
});

test('shape shortcut publishes state immediately and cannot promote Shift selection to confirmed A/B', () => {
  const { controller, manager, store } = fixture();
  manager.toggleWorldGlueCell({ x: 0, y: 50, z: 0 });
  controller.handleKeyDown({ code: 'Digit3', altKey: true, preventDefault() {} });
  assert.equal(store.getSnapshot().selector.shape, 'sphere');
  assert.equal(store.getSnapshot().selector.canModify, false);
  assert.equal(store.getSnapshot().selector.canCopy, false);
  assert.equal(store.getSnapshot().selector.canDelete, false);
  assert.equal(manager.selectionBoxConfirmed, false);
});
