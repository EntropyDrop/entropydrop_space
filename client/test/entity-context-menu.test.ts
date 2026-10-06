import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { nearestGridAlignedQuaternion, PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

function harness() {
  const calls: any[] = [];
  const target: any = { id: 'one', publicId: 'target', rootComponentId: 'root', scriptStatus: 'running',
    serializeSubtree(id: string) { calls.push(['serialize', id]); return { type: 'entity', blockCount: 2, scripts: [] }; } };
  const other: any = { id: 'two' };
  const controller: any = Object.create(PlayerController.prototype);
  controller.hoveredContraption = other;
  controller.contraptions = { contraptions: [target, other], removeContraption(entity: import('@entropydrop/space-engine/contraption/Contraption.ts').Contraption, options: Record<string, unknown>) { calls.push(['remove', entity, options]); } };
  controller.performBasicAction = (command: { domain: string; action: string }) => { calls.push(['action', command]); return { ok: true }; };
  controller.ui = { showToast: (message: string) => calls.push(['toast', message]), openCodeEditor: (entity: import('@entropydrop/space-engine/contraption/Contraption.ts').Contraption) => calls.push(['program', entity]),
    notifyContraptionRemoved: (entity: import('@entropydrop/space-engine/contraption/Contraption.ts').Contraption) => calls.push(['notify', entity]) };
  controller.addInventoryItem = (category: string, slot: import('@entropydrop/space-engine/storage/InventoryTypes.ts').InventoryInput) => { calls.push(['inventory', category, slot]); return 0; };
  controller.activateTool = (tool: string) => calls.push(['tool', tool]);
  controller.setActiveInventoryCategory = (category: string) => calls.push(['category', category]);
  controller.clearSelection = () => calls.push(['clear']);
  return { calls, target, other, controller };
}

for (const tool of [SpecialTool.SHOVEL, SpecialTool.SPOON, SpecialTool.SELECTOR, SpecialTool.HAMMER, SpecialTool.WRENCH, SpecialTool.BRUSH]) {
  test(`${tool}: overhead menu wins both click buttons before tools, stopping, selection, bulk edit or placement`, () => {
    const controller: any = Object.create(PlayerController.prototype);
    controller._activeTool = tool;
    controller.bulkEditJob = { label: 'Editing' };
    let clicks = 0;
    controller.ui = { tryOpenEntityContextMenuAtPointer: () => { clicks++; return true; },
      showSelectorContextMenu() { throw new Error('must not open selection menu'); } };
    controller.handleRunningEntityInteraction = () => { throw new Error('must not stop entity'); };
    assert.equal(controller.handleLeftClick({ clientX: 3, clientY: 5 }), true);
    assert.equal(controller.handleRightClick({ clientX: 3, clientY: 5 }), true);
    assert.equal(clicks, 2);
    assert.equal(controller.toolUseSequence, undefined);
  });
}

test('menu locks a target, opens before unlocking, prevents canvas resume, closes mutually exclusive menus and handles Escape', () => {
  const { target, other } = harness();
  const store = new SpaceUiStore();
  let locks = 0;
  const controller: any = { isLocked: true, unlock() { this.isLocked = false; store.setPointerLocked(false); },
    requestLock() { locks++; } };
  (store as any).patch({ controller, hasStarted: true, contraptions: { contraptions: [target, other] }, selectorContextMenu: { x: 1, y: 2 } });
  const unsubscribe = store.subscribe(() => store.resumeFromCanvas());
  assert.equal(store.showEntityContextMenu(target, { x: 0, y: 0 }), true);
  unsubscribe();
  assert.equal(locks, 0);
  assert.deepEqual(store.getSnapshot().entityContextMenu, { contraption: target, x: 512, y: 384 });
  assert.equal(store.getSnapshot().selectorContextMenu, null);
  assert.equal(store.handleEscape(), true);
  assert.equal(store.getSnapshot().entityContextMenu, null);
  assert.equal(locks, 1);
  assert.equal(store.showEntityContextMenu(target, { x: 0, y: 0 }), true);
  assert.equal(store.getSnapshot().entityContextMenu?.x, 0);
  store.showSelectorContextMenu();
  assert.equal(store.getSnapshot().entityContextMenu, null);
  assert.equal(store.showEntityContextMenu({}), false);
});

test('menu commands always use clicked entity instead of current hover and reject departed targets', async () => {
  const { controller, target, calls } = harness();
  assert.equal(await controller.performEntityMenuAction(target, 'start'), true);
  assert.equal(calls.find(call => call[0] === 'action')[1].target.contraption, target);
  assert.equal(await controller.performEntityMenuAction(target, 'program'), true);
  assert.equal(calls.find(call => call[0] === 'program')[1], target);
  assert.equal(await controller.performEntityMenuAction({}, 'delete'), false);
  assert.equal(calls.some(call => call[0] === 'remove'), false);
});

test('whole entity copy needs no Selector A/B and includes the complete root definition without altering running source', async () => {
  const { controller, target, calls } = harness();
  controller.requireConfirmedSelection = () => { throw new Error('whole entity copy must not require A/B'); };
  assert.equal(await controller.performEntityMenuAction(target, 'copy'), true);
  assert.deepEqual(calls[0], ['serialize', 'root']);
  assert.ok(calls.some(call => call[0] === 'tool' && call[1] === SpecialTool.HAMMER));
  assert.equal(target.scriptStatus, 'running');
  calls.length = 0;
  controller.addInventoryItem = () => null;
  assert.equal(await controller.performEntityMenuAction(target, 'copy'), false);
  assert.equal(calls.some(call => call[0] === 'clear' || call[0] === 'tool'), false);
});

test('online control permissions are checked at action time, including hosted deletion', async () => {
  const { controller, target, calls } = harness();
  Object.assign(target, { serverManaged: true, serverCanControl: false, serverCanEdit: false, serverExecutionMode: 'hosted' });
  controller.serverEntityDeleteHandler = async () => { throw new Error('must not call backend'); };
  for (const action of ['start', 'stop', 'delete', 'disassemble', 'program']) assert.equal(await controller.performEntityMenuAction(target, action), false);
  assert.equal(calls.some(call => call[0] === 'remove' || call[0] === 'action'), false);
  target.serverCanControl = true;
  controller.serverEntityDeleteHandler = async (entity: import('@entropydrop/space-engine/contraption/Contraption.ts').Contraption) => { assert.equal(entity, target); calls.push(['remote-delete']); };
  assert.equal(await controller.performEntityMenuAction(target, 'delete'), true);
  assert.ok(calls.findIndex(call => call[0] === 'remote-delete') < calls.findIndex(call => call[0] === 'remove'));
  assert.deepEqual(calls.find(call => call[0] === 'remove')[2], { skipRemoteDelete: true });
});

test('deleting a newly created local entity still queues normal remote cleanup for an in-flight create', async () => {
  const { controller, target, calls } = harness();
  assert.equal(await controller.performEntityMenuAction(target, 'delete'), true);
  assert.deepEqual(calls.find(call => call[0] === 'remove')[2], { skipRemoteDelete: false });
});

test('remote delete waits for acknowledgement and keeps entity after failure or unavailable API', async () => {
  const { controller, target, calls } = harness();
  Object.assign(target, { serverManaged: true, serverCanControl: true });
  assert.equal(await controller.performEntityMenuAction(target, 'delete'), false);
  let reject: (error: Error) => void;
  controller.serverEntityDeleteHandler = () => new Promise((_resolve, fail) => { reject = fail; });
  const pending = controller.performEntityMenuAction(target, 'delete');
  assert.equal(calls.some(call => call[0] === 'remove'), false);
  reject!(new Error('offline'));
  assert.equal(await pending, false);
  assert.equal(calls.some(call => call[0] === 'remove'), false);
});

test('opening a menu during bulk editing is allowed but commands cannot race its captured entity', async () => {
  const { controller, target, calls } = harness();
  controller.bulkEditJob = { label: 'Filling selection' };
  for (const action of ['start', 'stop', 'copy', 'delete', 'disassemble', 'program', 'select-all']) {
    assert.equal(await controller.performEntityMenuAction(target, action), false);
  }
  assert.equal(calls.every(call => call[0] === 'toast'), true);
});

test('menu Select All uses explicit root target, while confirmed A/B selection gating remains in the canonical action', async () => {
  const { controller, target } = harness();
  controller.selectAllSelectionBlocks = (selection: { contraption: import('@entropydrop/space-engine/contraption/Contraption.ts').Contraption; nodeId: string }) => { assert.equal(selection.contraption, target); assert.equal(selection.nodeId, 'root'); return true; };
  assert.equal(await controller.performEntityMenuAction(target, 'select-all'), true);
});

test('nearest grid orientation chooses the closest proper 90-degree 3D rotation', () => {
  const nearQuarterTurn = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(4), THREE.MathUtils.degToRad(82), THREE.MathUtils.degToRad(-7), 'XYZ'
  ));
  const snapped = nearestGridAlignedQuaternion(nearQuarterTurn);
  const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  assert.ok(Math.abs(snapped.dot(expected)) > 1 - 1e-9);

  const tilted = nearestGridAlignedQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(87), THREE.MathUtils.degToRad(3), THREE.MathUtils.degToRad(91), 'XYZ'
  )));
  for (const axis of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]) {
    const transformed = axis.applyQuaternion(tilted);
    assert.equal(Math.round(Math.abs(transformed.x) + Math.abs(transformed.y) + Math.abs(transformed.z)), 1);
    assert.ok([transformed.x, transformed.y, transformed.z].every(value => Math.abs(value - Math.round(value)) < 1e-9));
  }
});

test('menu disassembly aligns first, then uses the canonical manager conversion and removes the menu target', async () => {
  const { controller, target, calls } = harness();
  controller.snapEntityRotationToGrid = async (entity: import('@entropydrop/space-engine/contraption/Contraption.ts').Contraption, options: Record<string, unknown>) => {
    assert.equal(entity, target);
    assert.deepEqual(options, { save: false, refresh: false });
    calls.push(['align']);
    return true;
  };
  controller.contraptions.disassembleContraption = (entity: import('@entropydrop/space-engine/contraption/Contraption.ts').Contraption, options: Record<string, unknown>) => {
    calls.push(['disassemble', entity, options]);
    return true;
  };
  controller.ui.refresh = () => calls.push(['refresh']);

  assert.equal(await controller.performEntityMenuAction(target, 'disassemble'), true);
  assert.ok(calls.findIndex(call => call[0] === 'align') < calls.findIndex(call => call[0] === 'disassemble'));
  assert.deepEqual(calls.find(call => call[0] === 'disassemble').slice(1), [target, { skipRemoteDelete: false }]);
  assert.ok(calls.some(call => call[0] === 'notify' && call[1] === target));
  assert.ok(calls.some(call => call[0] === 'toast' && call[1].includes('aligned to the grid and disassembled')));
});

test('menu disassembly applies the nearest grid rotation to the full rigid-body frame before conversion', async () => {
  const rootPosition = new THREE.Vector3(8.25, 12.5, -3.75);
  const startRotation = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(82)
  );
  const rootBody = { position: rootPosition.clone(), quaternion: startRotation.clone() };
  const childBody = {
    position: new THREE.Vector3(2, 0, 0).applyQuaternion(startRotation).add(rootPosition),
    quaternion: startRotation.clone()
  };
  const entity: any = {
    id: 'rotated', rootComponentId: 'root', scriptStatus: 'stopped',
    position: rootPosition.clone(), quaternion: startRotation.clone(),
    rigidBodies: new Map([['root', rootBody], ['child', childBody]]),
    getRigidBody(id: string) { return this.rigidBodies.get(id); },
    syncAllBodyTransforms() {}, updateTransform() {}, capturePreviousEntityTransforms() {},
    setCollisionSimulationEnabled() {}
  };
  let convertedRotation = null as THREE.Quaternion | null;
  const controller: any = Object.create(PlayerController.prototype);
  controller.contraptions = {
    contraptions: [entity],
    disassembleContraption() { convertedRotation = rootBody.quaternion.clone(); return true; }
  };
  controller.beginWrenchManipulation = () => {};
  controller.ui = { showToast() {}, refresh() {}, notifyContraptionRemoved() {} };

  assert.equal(await controller.performEntityMenuAction(entity, 'disassemble'), true);
  const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  assert.ok(convertedRotation && Math.abs(convertedRotation.dot(expected)) > 1 - 1e-9);
  assert.ok(rootBody.position.distanceTo(rootPosition) < 1e-9, 'root position stays fixed while orientation snaps');
  const expectedChildPosition = new THREE.Vector3(2, 0, 0).applyQuaternion(expected).add(rootPosition);
  assert.ok(childBody.position.distanceTo(expectedChildPosition) < 1e-9, 'child bodies follow the root rotation delta');
});

test('entity menu blocks keyboard tools and is cleared when target is removed', () => {
  const { controller, target } = harness();
  controller.ui.isEntityContextMenuOpen = () => true;
  assert.doesNotThrow(() => controller.handleKeyDown({ code: 'Delete' }));
  const store = new SpaceUiStore();
  (store as any).patch({ contraptions: { contraptions: [target] } });
  store.showEntityContextMenu(target);
  store.notifyContraptionRemoved(target);
  assert.equal(store.getSnapshot().entityContextMenu, null);
});

test('pointer-lock menu hit-test uses crosshair rather than stale cursor coordinates and rejects non-button hits', () => {
  const { target } = harness();
  const store = new SpaceUiStore();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const hits: number[][] = [];
  let button: any = { dataset: { entityMenuId: 'target' } };
  try {
    (globalThis as any).window = { innerWidth: 1000, innerHeight: 600 };
    (globalThis as any).document = { elementFromPoint(x: number, y: number) { hits.push([x, y]); return { closest: () => button }; } };
    const controller = { isLocked: true, unlock() { this.isLocked = false; } };
    (store as any).patch({ controller, hasStarted: true, contraptions: { contraptions: [target] } });
    assert.equal(store.tryOpenEntityContextMenuAtPointer({ clientX: 7, clientY: 9 }), true);
    assert.deepEqual(hits[0], [500, 300]);
    assert.equal(store.getSnapshot().entityContextMenu?.contraption, target);
    store.closeEntityContextMenu();
    assert.equal(store.tryOpenEntityContextMenuAtPointer({ clientX: 7, clientY: 9 }), true);
    assert.deepEqual(hits[1], [7, 9]);
    store.closeEntityContextMenu();
    button = null;
    assert.equal(store.tryOpenEntityContextMenuAtPointer({ clientX: 7, clientY: 9 }), false);
    button = { dataset: { entityMenuId: 'departed' } };
    assert.equal(store.tryOpenEntityContextMenuAtPointer({ clientX: 7, clientY: 9 }), false);
  } finally {
    (globalThis as any).window = previousWindow;
    (globalThis as any).document = previousDocument;
  }
});
