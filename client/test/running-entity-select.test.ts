import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ActionDomain } from '@entropydrop/space-engine/actions/BasicActions.ts';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';

/**
 * Running interactions warn once, then a quick retry stops without selecting or editing.
 */

function makeEntityWithChildren() {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    1,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: 0, localY: 1, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: 0, localY: 2, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: 2, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }
    ],
    new THREE.Vector3(0, 10, 0),
    scene,
    {
      childEntities: [
        { id: 'arm', parentId: 'root', kind: 'child', pivot: [0.5, 0.5, 0.5], blockKeys: [['0', '1', '0']] },
        { id: 'hand', parentId: 'arm', kind: 'child', pivot: [0.5, 1.5, 0.5], blockKeys: [['0', '2', '0']] },
        { id: 'wing', parentId: 'root', kind: 'child', pivot: [1.5, 0.5, 0.5], blockKeys: [['2', '0', '0']] }
      ]
    }
  );
  return { contraption, scene };
}

function makeSelectorController(overrides: any = {}) {
  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectedSubtree = null;
  controller.selectedBlockSelection = null;
  controller.selectorLevel = null;
  controller.selectorRange = null;
  controller.inventorySlots = new Array(8).fill(null);
  controller.selectedInventoryIndex = 0;
  controller.contraptions = overrides.manager || null;
  controller.keys = {};
  const toasts: string[] = [];
  controller.ui = {
    showToast: m => toasts.push(m),
    renderInventoryBar() {}
  };
  Object.assign(controller, overrides);
  controller.__toasts = toasts;
  return controller;
}

function clickEntity(controller, contraption, entityId, cell, point, e = null) {
  controller.hoveredContraptionHit = { contraption, entityId, cell, point };
  controller.handleLeftClick(e);
}

test('running entity selection warns, retries only stop, then A/B enable actions', () => {
  const { contraption, scene } = makeEntityWithChildren();
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.registerContraption(contraption);
  const controller = makeSelectorController({ manager });
  contraption.scriptStatus = 'running';

  clickEntity(controller, contraption, 'arm', { x: 0, y: 1, z: 0 }, new THREE.Vector3(0.5, 11.5, 0.5));
  assert.equal(contraption.scriptStatus, 'running', 'the first attempt must not stop');
  assert.equal(controller.selectorRange, null, 'running entities do not expose a block box');
  assert.equal(controller.selectedSubtree, null, 'the first attempt cannot select');
  assert.ok(controller.__toasts.some(m => m.includes('within 1 second')));

  const before = contraption.blocks.length;
  controller.deleteSelectionBlocks();
  assert.equal(contraption.blocks.length, before, 'the retry stops only; it must not delete');
  assert.equal(contraption.scriptStatus, 'stopped');
  assert.equal(contraption.isPhysicsSimulationEnabled(), false);
  assert.equal(controller.selectorRange, null);
  assert.equal(controller.canUseSelectionActions(), false);
  clickEntity(controller, contraption, 'arm', { x: 0, y: 1, z: 0 }, new THREE.Vector3(0.5, 11.5, 0.5));
  assert.ok(controller.selectorRange?.pointA);
  assert.equal(controller.canUseSelectionActions(), false);
  clickEntity(controller, contraption, 'arm', { x: 0, y: 1, z: 0 }, new THREE.Vector3(0.5, 11.5, 0.5));
  assert.equal(controller.canUseSelectionActions(), true);
});

test('selecting a server-managed running entity does not change durable or local run state', async () => {
  const { contraption } = makeEntityWithChildren();
  const controller = makeSelectorController();
  contraption.scriptStatus = 'running';
  contraption.serverManaged = true;
  contraption.serverCanEdit = true;
  contraption.serverCanControl = true;
  contraption.serverDesiredRunState = 'running';
  let runStateCalls = 0;
  controller.serverEntityRunStateHandler = async () => {
    runStateCalls++;
    return { id: 'ent-1', desired_run_state: 'stopped', owner_user_id: 'u', revision: 2, execution_mode: 'browser' };
  };

  clickEntity(controller, contraption, 'arm', { x: 0, y: 1, z: 0 }, new THREE.Vector3(0.5, 11.5, 0.5));
  assert.equal(contraption.scriptStatus, 'running');
  assert.equal(contraption.serverDesiredRunState, 'running');
  assert.equal(controller.canEditEntityInternals(contraption), false);
  assert.equal(controller.selectedSubtree, null);

  await Promise.resolve();
  assert.equal(runStateCalls, 0, 'selection must not send a stop request');
});

test('after an explicit stop, level switching and box clicks behave normally', () => {
  const { contraption } = makeEntityWithChildren();
  const controller = makeSelectorController();
  contraption.scriptStatus = 'running';

  contraption.stopAllNodeScripts();

  clickEntity(controller, contraption, 'arm', { x: 0, y: 1, z: 0 }, new THREE.Vector3(0.5, 11.5, 0.5)); // point 1
  assert.equal(controller.selectorRange?.nodeId, 'arm');
  assert.ok(controller.selectorRange?.pointA);

  // Shift-clicking hand switches levels instead of entering box mode.
  clickEntity(controller, contraption, 'hand', { x: 0, y: 2, z: 0 }, new THREE.Vector3(0.5, 12.5, 0.5), { shiftKey: true });
  assert.equal(controller.selectedSubtree?.rootId, 'hand', 'Shift-click switches the level');
  assert.equal(controller.selectorRange?.pointA ?? null, null, 'Shift-click does not set a box point');
});

test('a quick stop discards stale internal selection without setting a new A', () => {
  const { contraption } = makeEntityWithChildren();
  const controller = makeSelectorController();
  contraption.scriptStatus = 'running';
  // Simulate arm-level box mode with point 1 already set.
  controller.selectedSubtree = { contraption, rootId: 'arm', nodeIds: new Set(['arm', 'hand']) };
  controller.selectorLevel = { contraption, nodeId: 'arm' };
  controller.selectorRange = {
    contraption,
    nodeId: 'arm',
    pointA: { x: 0, y: 0, z: 0 },
    pointB: null
  };

  clickEntity(controller, contraption, 'arm', { x: 0, y: 1, z: 0 }, new THREE.Vector3(0.5, 11.5, 0.5));
  assert.equal(contraption.scriptStatus, 'running');
  assert.ok(controller.selectorRange?.pointA, 'warning alone does not mutate selection');
  clickEntity(controller, contraption, 'arm', { x: 0, y: 1, z: 0 }, new THREE.Vector3(0.5, 11.5, 0.5));
  assert.equal(contraption.scriptStatus, 'stopped');
  assert.equal(controller.selectorRange, null, 'stale box progress is discarded');
  assert.equal(controller.selectorLevel, null);
  assert.equal(controller.selectedSubtree, null);
});

test('a stopped entity still allows arm-subtree selection and box mode', () => {
  const { contraption } = makeEntityWithChildren();
  const controller = makeSelectorController();
  contraption.stopAllNodeScripts();
  clickEntity(controller, contraption, 'arm', { x: 0, y: 1, z: 0 }, new THREE.Vector3(0.5, 11.5, 0.5));
  assert.equal(controller.selectedSubtree.rootId, 'arm', 'level selection should work normally');
  assert.ok(controller.selectorRange, 'box mode should activate');
  assert.equal(controller.selectorRange.nodeId, 'arm');
});

test('shared selection API rejects entity internals until stopped but keeps whole-root selection', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null) as any;
  const { contraption } = makeEntityWithChildren();
  manager.registerContraption(contraption);
  contraption.scriptStatus = 'running';

  const childResult = manager.scriptSelectionApi.entity(contraption.publicId, 'arm');
  assert.deepEqual(childResult, { ok: false, selected: 0, reason: 'entity_not_stopped' });

  const boxResult = manager.scriptSelectionApi.entityBox(
    contraption.publicId,
    'arm',
    [-1, -1, -1],
    [1, 1, 1]
  );
  assert.equal(boxResult.ok, false);
  assert.equal(boxResult.reason, 'entity_not_stopped');

  const rootResult = manager.scriptSelectionApi.entity(contraption.publicId, 'root');
  assert.equal(rootResult.ok, true, 'whole-root selection must remain available while running');
  assert.equal(manager.entitySelection.rootId, 'root');

  contraption.stopAllNodeScripts();
  const stoppedBox = manager.scriptSelectionApi.entityBox(
    contraption.publicId,
    'arm',
    [-1, -1, -1],
    [1, 1, 1]
  );
  assert.equal(stoppedBox.ok, true);
  assert.ok(stoppedBox.selected > 0);
});

test('starting an entity invalidates an internal selection and stale destructive calls are gated', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null) as any;
  const { contraption } = makeEntityWithChildren();
  manager.registerContraption(contraption);
  contraption.setScript('self.state.ticks = (self.state.ticks || 0) + 1;');
  contraption.stopAllNodeScripts();

  const selected = manager.scriptSelectionApi.entityBox(
    contraption.publicId,
    'arm',
    [-1, -1, -1],
    [1, 1, 1]
  );
  assert.equal(selected.ok, true);
  assert.equal(manager.entitySelection.kind, 'entity-blocks');
  manager.selectionHost = {
    selectedBlockSelection: { contraption, nodeId: 'arm', blocks: [...manager.entitySelection.blocks] },
    selectedSubtree: { contraption, rootId: 'arm', nodeIds: new Set(['arm', 'hand']) },
    selectorLevel: { contraption, nodeId: 'arm' },
    selectorRange: { contraption, nodeId: 'arm', pointA: null, pointB: null }
  };

  const started = manager.performBasicAction({
    domain: ActionDomain.ENTITY,
    action: 'start-scripts',
    target: { contraption }
  });
  assert.equal(started.ok, true);
  assert.equal(manager.entitySelection, null, 'starting must clear construction-grid selections');
  assert.equal(manager.selectionHost.selectedBlockSelection, null, 'UI-side internal selection must clear too');
  assert.equal(manager.selectionHost.selectedSubtree, null);
  assert.equal(manager.selectionHost.selectorLevel, null);
  assert.equal(manager.selectionHost.selectorRange, null);

  const armBlocks = contraption.blocks.filter(block => (block.entityId || 'root') === 'arm');
  manager.entitySelection = { kind: 'entity-blocks', contraption, nodeId: 'arm', blocks: armBlocks };
  const before = contraption.blocks.length;
  const deleted = manager.scriptSelectionApi.delete();
  assert.equal(deleted.ok, false);
  assert.equal(deleted.reason, 'entity_not_stopped');
  assert.equal(contraption.blocks.length, before);
  assert.equal(manager.entitySelection, null, 'a rejected stale selection is discarded');
});

test('clicking an entity during an active world box is rejected with toast and clears selection', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const { contraption } = makeEntityWithChildren();
  manager.contraptions.push(contraption);
  const toasts: string[] = [];
  const controller = makeSelectorController({ manager });
  controller.ui = { showToast: (m: string) => toasts.push(m) };
  contraption.scriptStatus = 'running';

  // First world click sets cornerA.
  controller.currentRaycast = { hit: true, hitPos: { x: 0, y: 10, z: 0 } };
  controller.handleLeftClick();
  assert.ok(manager.selectionCornerA, 'point 1 should be set');

  // Second click on an entity is rejected.
  clickEntity(controller, contraption, 'root', { x: 0, y: 0, z: 0 }, new THREE.Vector3(0.8, 10.8, 0.7));
  assert.equal(manager.selectionCornerA, null, 'selection should be cleared on invalid entity endpoint');
  assert.equal(manager.selectionCornerB, null, 'point 2 should not be set');
  assert.ok(toasts.some(m => m.includes('starts in the world cannot end on an entity')), 'toast should warn about invalid endpoint');
  assert.equal(controller.selectedSubtree, null, 'whole-entity selection should not activate');
});

test('R on a running entity consumes its retry to stop, and copies only after A/B', () => {
  const { contraption, scene } = makeEntityWithChildren();
  const manager = new ContraptionManager(scene, {}, null, null);
  manager.registerContraption(contraption);
  const controller = makeSelectorController({ manager });
  contraption.scriptStatus = 'running';

  clickEntity(controller, contraption, 'root', { x: 0, y: 0, z: 0 }, new THREE.Vector3(0.5, 10.5, 0.5));
  assert.equal(contraption.scriptStatus, 'running');

  controller.copySelectionToInventory(); // R-key path.
  assert.equal(controller.inventorySlots[0], null, 'retry must not copy');
  assert.equal(contraption.scriptStatus, 'stopped');
  controller.copySelectionToInventory();
  assert.equal(controller.inventorySlots[0], null, 'stopping alone is not confirmed A/B');
  assert.equal(controller.selectAllSelectionBlocks(), true);
  controller.copySelectionToInventory();
  const slot = controller.inventorySlots[0];
  assert.ok(slot, 'the whole entity should be copied into the slot');
  assert.equal(slot.blockCount, 1, 'Select All covers only root-owned blocks');
  assert.notEqual(slot.kind, 'blockset', 'R should remain entity copy');
  assert.equal(contraption.scriptStatus, 'stopped', 'copying is read-only');
});
