import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
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

function componentHarness(t: test.TestContext, emptyRoot = false) {
  const f = harness();
  const target = new Contraption(3, [
    ...(!emptyRoot ? [{ localX: 0, localY: 0, localZ: 0, block: 1, entityId: 'root' }] : []),
    { localX: 1, localY: 0, localZ: 0, block: 1, entityId: 'arm' },
    { localX: 2, localY: 0, localZ: 0, block: 1, entityId: 'hand' },
    ...(!emptyRoot ? [{ localX: 3, localY: 0, localZ: 0, block: 1, entityId: 'wing' }] : []),
  ], new THREE.Vector3(1, 2, 3), new THREE.Scene(), { rootComponentId: 'root', childEntities: [
    { id: 'arm', parentId: 'root', name: 'Arm' }, { id: 'hand', parentId: 'arm' },
    ...(!emptyRoot ? [{ id: 'wing', parentId: 'root' }] : []),
  ], constraints: [{ id: 'arm-joint', type: 'point', bodyA: 'root', bodyB: 'arm' },
    { id: 'hand-joint', type: 'point', bodyA: 'arm', bodyB: 'hand' }] });
  target.stopAllNodeScripts();
  f.controller.contraptions.contraptions = [target, f.other];
  f.controller.contraptions.saveEntitiesToStorage = () => f.calls.push(['save']);
  f.controller.ui.notifyContraptionStructureChanged = (entity: unknown) => f.calls.push(['structure', entity]);
  f.controller.performBasicAction = PlayerController.prototype.performBasicAction.bind(f.controller);
  t.after(() => target.dispose());
  return { ...f, target };
}

test('Wrench menu captures the selected child before unlocking and retains it as hover changes', t => {
  const { controller, target, other } = componentHarness(t);
  const store = new SpaceUiStore();
  controller._activeTool = SpecialTool.WRENCH;
  controller.wrenchPivotTarget = { contraption: target, nodeId: 'arm' };
  controller.hoveredContraptionHit = { contraption: target, entityId: 'hand' };
  controller.unlock = () => { controller.wrenchPivotTarget = null; controller.hoveredContraptionHit = null; };
  (store as any).patch({ controller, contraptions: controller.contraptions });
  assert.equal(store.showEntityContextMenu(target), true);
  assert.equal(store.getSnapshot().entityContextMenu?.componentId, 'arm');
  controller.hoveredContraptionHit = { contraption: other, entityId: 'other' };
  store.refresh();
  assert.equal(store.getSnapshot().entityContextMenu?.componentId, 'arm');
  store.closeEntityContextMenu();
  controller.hoveredContraptionHit = { contraption: target, entityId: 'hand' };
  assert.equal(store.showEntityContextMenu(target), true);
  assert.equal(store.getSnapshot().entityContextMenu?.componentId, 'hand');
  store.closeEntityContextMenu();
  controller.hoveredContraptionHit = { contraption: target, entityId: 'root' };
  assert.equal(store.showEntityContextMenu(target), true);
  assert.equal(store.getSnapshot().entityContextMenu?.componentId, undefined);
});

test('component deletion removes only the captured subtree and its constraints, preserving root and siblings', async t => {
  const { controller, target, calls } = componentHarness(t);
  const rootPosition = target.getBlockWorldCenter(target.blocks[0]);
  controller.wrenchPivotTarget = { contraption: target, nodeId: 'hand' };
  controller.serverEntityDeleteHandler = async () => assert.fail('component removal must not delete the whole remote entity');
  assert.equal(await controller.performEntityMenuAction(target, 'delete-component', 'arm'), true);
  assert.deepEqual([...target.entityNodes.keys()].sort(), ['root', 'wing']);
  assert.deepEqual(target.blocks.map(block => block.entityId).sort(), ['root', 'wing']);
  assert.ok(target.getBlockWorldCenter(target.blocks[0]).distanceTo(rootPosition) < 1e-7);
  assert.equal(target.constraintDefinitions.size, 0);
  assert.equal(controller.wrenchPivotTarget, null);
  assert.equal(calls.filter(call => call[0] === 'save').length, 1);
  assert.equal(calls.some(call => call[0] === 'remove'), false);
  assert.ok(calls.some(call => call[0] === 'structure' && call[1] === target));
});

test('component deletion never promotes removal to the whole entity even if that subtree owns every voxel', async t => {
  const { controller, target, calls } = componentHarness(t, true);
  assert.equal(await controller.performEntityMenuAction(target, 'delete-component', 'arm'), true);
  assert.deepEqual([...target.entityNodes.keys()], ['root']);
  assert.equal(target.blocks.length, 0);
  assert.equal(calls.some(call => call[0] === 'remove'), false);
});

test('whole-entity deletion remains explicit when the menu captured a child', async t => {
  const { controller, target, calls } = componentHarness(t);
  assert.equal(await controller.performEntityMenuAction(target, 'delete', 'arm'), true);
  assert.ok(calls.some(call => call[0] === 'remove' && call[1] === target));
  assert.equal(calls.some(call => call[0] === 'structure'), false);
});

test('local running component deletion stops execution before removing its subtree', async t => {
  const { controller, target } = componentHarness(t);
  target.setPhysicsSimulationEnabled(true);
  assert.equal(await controller.performEntityMenuAction(target, 'delete-component', 'arm'), true);
  assert.equal(target.isPhysicsSimulationEnabled(), false);
  assert.equal(target.getEntityNode('arm'), null);
});

test('component deletion rejects roots, missing nodes, read-only and hosted entities without falling back to whole deletion', async t => {
  const { controller, target, calls } = componentHarness(t);
  for (const id of [undefined, 'root', 'missing']) {
    assert.equal(await controller.performEntityMenuAction(target, 'delete-component', id), false);
  }
  Object.assign(target, { serverManaged: true, serverCanControl: true, serverCanEdit: false });
  assert.equal(await controller.performEntityMenuAction(target, 'delete-component', 'arm'), false);
  Object.assign(target, { serverCanEdit: true, serverExecutionMode: 'hosted' });
  assert.equal(await controller.performEntityMenuAction(target, 'delete-component', 'arm'), false);
  assert.equal(target.blocks.length, 4);
  assert.equal(calls.some(call => ['save', 'remove', 'structure'].includes(call[0])), false);
});

test('remote component deletion stops through the backend then saves the remaining entity definition', async t => {
  const { controller, target, calls } = componentHarness(t);
  Object.assign(target, { serverManaged: true, serverCanControl: true, serverCanEdit: true, serverDesiredRunState: 'running' });
  controller.serverEntityRunStateHandler = async (entity: unknown, state: string) => {
    assert.equal(entity, target); assert.equal(state, 'stopped');
    calls.push(['remote-stop']); target.serverDesiredRunState = 'stopped'; target.stopAllNodeScripts();
  };
  controller.serverEntityDeleteHandler = async () => assert.fail('must not delete the server entity');
  assert.equal(await controller.performEntityMenuAction(target, 'delete-component', 'arm'), true);
  assert.ok(calls.findIndex(call => call[0] === 'remote-stop') < calls.findIndex(call => call[0] === 'save'));
  assert.deepEqual([...target.entityNodes.keys()].sort(), ['root', 'wing']);
  assert.equal(calls.some(call => call[0] === 'remove'), false);
});

test('a failed remote Stop preserves the component and explains why deletion failed', async t => {
  const { controller, target, calls } = componentHarness(t);
  Object.assign(target, { serverManaged: true, serverCanControl: true, serverCanEdit: true, serverDesiredRunState: 'running' });
  controller.serverEntityRunStateHandler = async () => { throw new Error('offline'); };
  assert.equal(await controller.performEntityMenuAction(target, 'delete-component', 'arm'), false);
  assert.equal(target.blocks.length, 4);
  assert.ok(calls.some(call => call[0] === 'toast' && /component was not deleted/.test(call[1])));
  assert.equal(calls.some(call => ['save', 'remove', 'structure'].includes(call[0])), false);
});

for (const change of ['component removed', 'permission revoked', 'entity replaced'] as const) {
  test(`remote component deletion rechecks its captured target after Stop: ${change}`, async t => {
    const { controller, target, calls } = componentHarness(t);
    Object.assign(target, { serverManaged: true, serverCanControl: true, serverCanEdit: true, serverDesiredRunState: 'running' });
    controller.serverEntityRunStateHandler = async () => {
      target.serverDesiredRunState = 'stopped'; target.stopAllNodeScripts();
      if (change === 'component removed') target.removeComponentSubtree('arm');
      if (change === 'permission revoked') target.serverCanEdit = false;
      if (change === 'entity replaced') controller.contraptions.contraptions = [];
    };
    assert.equal(await controller.performEntityMenuAction(target, 'delete-component', 'arm'), false);
    assert.equal(calls.some(call => ['save', 'remove', 'structure'].includes(call[0])), false);
  });
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
    assert.equal(controller.toolUseSequence, 0, 'menu clicks do not increment the tool counter');
  });
}

for (const tool of new Set(Object.values(SpecialTool))) {
  for (const [state, properties] of Object.entries({
    scripts: { scriptStatus: 'running' },
    physics: { scriptStatus: 'stopped', canEditInternalSelection: () => false },
    server: { scriptStatus: 'stopped', serverManaged: true, serverDesiredRunState: 'running' }
  })) {
    test(`${tool}: right-click opens entity actions while ${state} runs, before tool actions or bulk editing`, () => {
      const { controller, target, calls } = harness();
      Object.assign(target, properties);
      controller._activeTool = tool;
      controller.hoveredContraptionHit = { contraption: target };
      controller.bulkEditJob = { label: 'Editing' };
      controller.keys = { crouch: true };
      const unexpected = () => assert.fail('running entity right-click must only open entity actions');
      controller.ui.showSelectorContextMenu = unexpected;
      controller.modeling = { beginCreation: unexpected };
      controller.paintTargetedBlock = unexpected;
      controller.handleBrushRightClick = unexpected;
      controller.sampleTargetedColor = unexpected;
      controller.rotateActiveInventoryItem = unexpected;
      controller.performBasicAction = unexpected;
      controller.ui.showEntityContextMenu = (entity: unknown, position: unknown) => {
        calls.push(['menu', entity, position]);
        return true;
      };

      assert.equal(controller.handleRightClick({ clientX: 31, clientY: 47, shiftKey: true }), true);
      assert.deepEqual(calls, [['menu', target, { x: 31, y: 47 }]]);
      assert.equal(controller.activeTool, tool);
      assert.equal(controller.isEntityRunning(target), true, 'opening the menu preserves playback');

      calls.length = 0;
      controller.hoveredContraptionHit = null;
      controller.hoveredContraption = target;
      assert.equal(controller.handleRightClick({ clientX: 31, clientY: 47 }), true);
      assert.deepEqual(calls, [['menu', target, { x: 31, y: 47 }]], 'hover fallback matches Wrench');
    });
  }
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

test('menu body type changes save the clicked root default, preserve child types and survive Stop', async () => {
  const { controller, other } = harness();
  const target = new Contraption(1, [0, 1].map(localX => ({
    localX, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK
  })), new THREE.Vector3(), new THREE.Scene());
  target.createChildEntity(target.rootComponentId, new Set(['1,0,0']), 'arm');
  const childType = target.getNodeBodyType('arm');
  const savedTypes: string[] = [];
  controller.contraptions.contraptions = [target, other];
  controller.contraptions.saveEntitiesToStorage = () => {
    const slot = target.serializeSubtree(target.rootComponentId);
    assert.ok(slot);
    savedTypes.push(slot.bodyType);
  };
  controller.performBasicAction = PlayerController.prototype.performBasicAction;
  controller.selectedBlockSelection = { contraption: other, nodeId: 'unrelated-child' };

  const scriptApi = target.scriptApi;
  assert.ok(scriptApi);
  for (const bodyType of ['kinematic', 'dynamic']) {
    assert.equal(await controller.performEntityMenuAction(target, `set-${bodyType}`), true);
    assert.equal(target.bodyType, bodyType);
    assert.equal(target.getNodeBodyType('arm'), childType);
    assert.equal(savedTypes.at(-1), bodyType);
    scriptApi.body.setType(bodyType === 'kinematic' ? 'dynamic' : 'kinematic');
    target.stopAllNodeScripts();
    assert.equal(target.bodyType, bodyType, 'Stop restores the chosen default after a script override');
  }
  assert.deepEqual(savedTypes, ['kinematic', 'dynamic']);
  assert.equal(other.bodyType, undefined, 'hovered and selected entities remain unchanged');
});

test('menu body type changes recheck editing, execution and target availability before mutating or saving', async () => {
  for (const properties of [
    { serverManaged: true, serverCanControl: true, serverCanEdit: false },
    { serverManaged: true, serverCanControl: false, serverCanEdit: true },
    { serverManaged: true, serverCanControl: true, serverCanEdit: true, serverExecutionMode: 'hosted' }
  ]) {
    const { controller, target, calls } = harness();
    Object.assign(target, properties);
    controller.contraptions.saveEntitiesToStorage = () => assert.fail('rejected changes must not save');
    for (const action of ['set-kinematic', 'set-dynamic']) {
      assert.equal(await controller.performEntityMenuAction(target, action), false);
    }
    assert.equal(calls.some(call => call[0] === 'action'), false);
  }
  const { controller, target, calls } = harness();
  controller.contraptions.saveEntitiesToStorage = () => assert.fail('failed changes must not save');
  controller.performBasicAction = () => ({ ok: false });
  assert.equal(await controller.performEntityMenuAction(target, 'set-kinematic'), false);
  assert.ok(calls.some(call => call[0] === 'toast' && call[1] === 'Unable to change rigid body type'));
  controller.contraptions.contraptions = [];
  controller.performBasicAction = () => assert.fail('departed targets must not be mutated');
  assert.equal(await controller.performEntityMenuAction(target, 'set-dynamic'), false);
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
  for (const action of ['start', 'stop', 'copy', 'delete', 'disassemble', 'program', 'select-all', 'set-kinematic', 'set-dynamic']) {
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
