import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

test('Selector right-click delegates to the UI context menu with the pointer position', () => {
  const calls: any[] = [];
  const controller: any = Object.create(PlayerController.prototype);
  controller._activeTool = SpecialTool.SELECTOR;
  controller.bulkEditJob = null;
  controller.ui = {
    showSelectorContextMenu(position) { calls.push(position); }
  };

  const handled = controller.handleRightClick({ clientX: 321, clientY: 123 });

  assert.equal(handled, true);
  assert.deepEqual(calls, [{ x: 321, y: 123 }]);
});

test('Selector menu releases pointer lock and restores it when closed', () => {
  const calls: string[] = [];
  const store = new SpaceUiStore();
  const controller: any = {
    activeTool: SpecialTool.SHOVEL,
    fov: 75,
    perspective: 'first_person',
    thirdPersonDistance: 4,
    inventories: { blockset: { items: [] }, entity: { items: [] }, colorset: { items: [] } },
    unlock() { calls.push('unlock'); },
    requestLock() { calls.push('lock'); return Promise.resolve(true); }
  };
  store.setController(controller);

  store.showSelectorContextMenu({ x: 0, y: 0 });
  const menu = store.getSnapshot().selectorContextMenu;
  assert.equal(calls.at(-1), 'unlock');
  assert.equal(menu?.x, 512);
  assert.equal(menu?.y, 384);

  store.closeSelectorContextMenu(true);
  assert.equal(store.getSnapshot().selectorContextMenu, null);
  assert.equal(calls.at(-1), 'lock');
});

test('Selector context menu exposes mode, every shape, rotation, and all selection actions', () => {
  const source = readFileSync(new URL('../src/ui/react/components/Hud.tsx', import.meta.url), 'utf8');
  assert.match(source, /id="selector-context-menu"/);
  for (const label of ['Standard', 'Micro', 'Box', 'Cylinder', 'Sphere / Circle', 'Stairs', 'Line']) {
    assert.ok(source.includes(label), `missing selector menu option: ${label}`);
  }
  for (const action of [
    'rotateSelection',
    'assembleCurrentSelection',
    'fillSelectionBlocks',
    'paintSelectionBlocks',
    'copySelectionSmart',
    'selectAllSelectionBlocks',
    'deleteSelectionBlocks',
    'clearSelection'
  ]) {
    assert.ok(source.includes(action), `missing selector menu action: ${action}`);
  }
  assert.match(source, />Select All<\/button>/);
});

test('Selector UI enables every selection action only for confirmed A/B', () => {
  const manager = new ContraptionManager(new THREE.Scene(), {}, null, null);
  const controller: any = {
    activeTool: SpecialTool.SHOVEL,
    contraptions: manager,
    selectedSubtree: null,
    selectedBlockSelection: null,
    inventories: { blockset: { items: [] }, entity: { items: [] }, colorset: { items: [] } },
    canDeleteSelection: PlayerController.prototype.canDeleteSelection,
    canUseSelectionActions: PlayerController.prototype.canUseSelectionActions,
  };
  const store = new SpaceUiStore();
  store.setController(controller);
  store.setContraptions(manager);
  const selector = () => (store as any).buildSelectorView();

  manager.setCornerA({ x: 1, y: 80, z: 1 });
  assert.equal(selector().canDelete, false, 'A alone leaves both Delete buttons disabled');

  manager.setCornerB({ x: 2, y: 80, z: 1 });
  assert.equal(selector().canDelete, true, 'confirmed A/B enables both Delete buttons');
  store.showSelectorContextMenu();
  assert.equal(store.getSnapshot().selector.canDelete, true, 'opening the menu refreshes deletion readiness immediately');

  manager.toggleWorldGlueCell({ x: 1, y: 80, z: 1 });
  assert.equal(selector().canDelete, false, 'Shift selection invalidates box confirmation');
  assert.equal(selector().canModify, false, 'Fill and Paint also require A/B');
  assert.equal(selector().canCopy, false);
  assert.equal(selector().canAssemble, false);
});
