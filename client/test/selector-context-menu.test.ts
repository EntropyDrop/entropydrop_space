import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';
import { selectorMenuPosition } from '../src/ui/react/utils/selectorMenuPosition.ts';

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
    isLocked: true,
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

test('a locked Selector menu always anchors at the crosshair, not the old cursor coordinates', () => {
  const store = new SpaceUiStore();
  const controller: any = {
    activeTool: SpecialTool.SHOVEL,
    inventories: { blockset: { items: [] }, entity: { items: [] }, colorset: { items: [] } },
    isLocked: true,
    unlock() { this.isLocked = false; }
  };
  store.setController(controller);
  for (const position of [{ x: 13, y: 19 }, { x: 900, y: 700 }, { x: 0, y: 0 }]) {
    controller.isLocked = true;
    store.showSelectorContextMenu(position);
    assert.deepEqual(store.getSnapshot().selectorContextMenu, { x: 512, y: 384 });
    store.closeSelectorContextMenu();
  }
});

test('an unlocked Selector menu preserves real cursor coordinates, including a screen edge', () => {
  const store = new SpaceUiStore();
  for (const position of [{ x: 321, y: 123 }, { x: 0, y: 0 }]) {
    store.showSelectorContextMenu(position);
    assert.deepEqual(store.getSnapshot().selectorContextMenu, position);
  }
});

test('Selector menu is present before unlock listeners can attempt to resume the canvas', () => {
  const store = new SpaceUiStore();
  let locks = 0;
  const controller: any = {
    activeTool: SpecialTool.SHOVEL, isLocked: true,
    inventories: { blockset: { items: [] }, entity: { items: [] }, colorset: { items: [] } },
    unlock() { this.isLocked = false; store.setPointerLocked(false); },
    requestLock() { locks++; }
  };
  store.setController(controller);
  store.setPointerLocked(true);
  const unsubscribe = store.subscribe(() => store.resumeFromCanvas());
  store.showSelectorContextMenu({ x: 900, y: 700 });
  unsubscribe();
  assert.equal(locks, 0, 'opening the menu must not race with canvas resume');
});

test('Selector menu positioning clamps all edges using its actual rendered size', () => {
  const viewport = { width: 1024, height: 768 };
  const size = { width: 360, height: 612 };
  assert.deepEqual(selectorMenuPosition({ x: 512, y: 384 }, size, viewport), { left: 332, top: 78 });
  for (const x of [-20, 0, 512, 1024, 1100]) for (const y of [-20, 0, 384, 768, 800]) {
    const position = selectorMenuPosition({ x, y }, size, viewport);
    assert.ok(position.left >= 12 && position.top >= 12);
    assert.ok(position.left + size.width <= viewport.width - 12);
    assert.ok(position.top + size.height <= viewport.height - 12);
  }
});

test('Selector menu remains visible in a small viewport and after its contents grow', () => {
  const viewport = { width: 320, height: 480 };
  const anchor = { x: 160, y: 240 };
  assert.deepEqual(selectorMenuPosition(anchor, { width: 296, height: 456 }, viewport), { left: 12, top: 12 });
  assert.deepEqual(selectorMenuPosition(anchor, { width: 296, height: 200 }, viewport), { left: 12, top: 140 });
});

function pointerFixture(t: any) {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const listeners = new Map<string, (event?: any) => void>();
  const body = {};
  let pointerLockElement: any = body;
  let exits = 0;
  globalThis.document = {
    body,
    get pointerLockElement() { return pointerLockElement; },
    exitPointerLock() { exits++; }, // Deliberately defer the browser's state-change notification.
    addEventListener(name, listener) { listeners.set(name, listener); }
  } as any;
  globalThis.window = { addEventListener() {} } as any;
  t.after(() => { globalThis.document = originalDocument; globalThis.window = originalWindow; });
  const controller: any = Object.assign(Object.create(PlayerController.prototype), {
    _activeTool: SpecialTool.SHOVEL, isLocked: true, pointerLockDesired: true,
    camera: new THREE.PerspectiveCamera(), yaw: 0.3, pitch: 0.2, mouseSensitivity: 0.002,
    ui: { setPointerLocked() {} }, updateAimRaycast() {}, refreshAimAfterPointerAction() {},
    releaseWrenchGrab() {}, clearWrenchPivotDisplay() {}
  });
  controller.setupPointerLock();
  controller.setupEventListeners();
  return { controller, listeners, exits: () => exits,
    setBrowserLock(locked: boolean) { pointerLockElement = locked ? body : null; } };
}

test('opening a menu stops mouse look before an asynchronous pointer unlock completes', t => {
  const { controller, listeners, exits } = pointerFixture(t);
  controller.unlock();
  assert.equal(controller.isLocked, false, 'UI unlock must stop input immediately');
  assert.equal(exits(), 1);
  listeners.get('mousemove')!({ movementX: 2000, movementY: -1500 });
  assert.equal(controller.yaw, 0.3);
  assert.equal(controller.pitch, 0.2);
});

test('relocking discards cursor-warp motion once, then ordinary mouse look resumes', t => {
  const { controller, listeners, setBrowserLock } = pointerFixture(t);
  controller.unlock();
  setBrowserLock(false);
  listeners.get('pointerlockchange')!();
  controller.pointerLockDesired = true;
  setBrowserLock(true);
  listeners.get('pointerlockchange')!();
  listeners.get('mousemove')!({ movementX: 2000, movementY: -1500 });
  assert.equal(controller.yaw, 0.3, 'lock-transition motion must not turn the camera');
  assert.equal(controller.pitch, 0.2);
  listeners.get('mousemove')!({ movementX: 10, movementY: 5 });
  assert.ok(Math.abs(controller.yaw - 0.28) < 1e-10);
  assert.ok(Math.abs(controller.pitch - 0.19) < 1e-10);
});

test('a late lock request cannot briefly enable game input while the menu is open', t => {
  const { controller, listeners, setBrowserLock } = pointerFixture(t);
  const states: boolean[] = [];
  controller.ui.setPointerLocked = (locked: boolean) => states.push(locked);
  controller.unlock();
  states.length = 0;
  setBrowserLock(true);
  listeners.get('pointerlockchange')!();
  assert.equal(controller.isLocked, false);
  assert.ok(states.every(locked => !locked), 'a stale completion must never publish a locked UI state');
  listeners.get('mousemove')!({ movementX: 2000, movementY: -1500 });
  assert.equal(controller.yaw, 0.3);
});

test('mouse look ignores browser-unlocked motion even before pointerlockchange is delivered', t => {
  const { controller, listeners, setBrowserLock } = pointerFixture(t);
  setBrowserLock(false);
  listeners.get('mousemove')!({ movementX: 2000, movementY: -1500 });
  assert.equal(controller.yaw, 0.3);
  assert.equal(controller.pitch, 0.2);
});

test('Selector overlay isolates outside clicks and measures the panel before its first paint', () => {
  const source = readFileSync(new URL('../src/ui/react/components/Hud.tsx', import.meta.url), 'utf8');
  const menu = source.slice(source.indexOf('function SelectorContextMenu()'), source.indexOf('function WrenchPanel()'));
  assert.match(menu, /useLayoutEffect\(/);
  assert.match(menu, /width: menu\.offsetWidth, height: menu\.offsetHeight/);
  assert.match(menu, /new ResizeObserver\(updatePosition\)/);
  assert.match(menu, /window\.addEventListener\('resize', updatePosition\)/);
  assert.match(menu, /onMouseDown=\{event => \{\s*event\.stopPropagation\(\);\s*if \(event\.target === event\.currentTarget\) close\(\);/);
  assert.match(menu, /onMouseUp=\{event => event\.stopPropagation\(\)\}/);
  assert.match(menu, /onClick=\{event => event\.stopPropagation\(\)\}/);
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  const panel = css.match(/\.selector-context-menu \{[^}]+\}/)?.[0] || '';
  assert.doesNotMatch(panel, /transform:/, 'measured positioning must not apply centering a second time');
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
