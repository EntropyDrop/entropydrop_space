import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ActionDomain } from '@entropydrop/space-engine/actions/BasicActions.ts';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';

/**
 * A running entity is stopped by the first selector click (returning it to its
 * construction pose); the next click starts the 2-point box. Entities the player
 * may not edit keep whole-entity selection only.
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

test('clicking a running entity stops it before starting the selection', () => {
  const { contraption } = makeEntityWithChildren();
  const controller = makeSelectorController();
  contraption.scriptStatus = 'running';

  // The first click stops the running entity instead of selecting it.
  clickEntity(controller, contraption, 'arm', { x: 0, y: 1, z: 0 }, new THREE.Vector3(0.5, 11.5, 0.5));
  assert.equal(contraption.scriptStatus, 'stopped', 'the first click must stop the running entity');
  assert.equal(controller.selectorRange, null, 'the stop click must not set a box point');
  assert.equal(controller.selectedSubtree, null, 'the stop click must not select the entity');
  assert.ok(controller.__toasts.some(m => m.includes('stopped')), 'a stop hint is shown');

  // The next click starts the 2-point box on the construction pose.
  clickEntity(controller, contraption, 'arm', { x: 0, y: 1, z: 0 }, new THREE.Vector3(0.5, 11.5, 0.5));
  assert.ok(controller.selectorRange, 'box mode activates once the entity is stopped');
  assert.equal(controller.selectorRange.nodeId, 'arm', 'the clicked component becomes the selection level');
  assert.ok(controller.selectorRange.pointA, 'the click after stopping sets the first point');
});

test('a server-managed running entity stops locally so the next click starts the box', async () => {
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

  // The stop must be applied locally right away, not only after a server round-trip.
  clickEntity(controller, contraption, 'arm', { x: 0, y: 1, z: 0 }, new THREE.Vector3(0.5, 11.5, 0.5));
  assert.equal(contraption.scriptStatus, 'stopped', 'the entity is stopped locally on the first click');
  assert.equal(contraption.serverDesiredRunState, 'stopped', 'the durable run state is advanced too');
  assert.equal(controller.canEditEntityInternals(contraption), true, 'the entity is editable immediately');
  assert.equal(controller.selectorRange, null, 'the stop click does not set a point');

  await Promise.resolve();
  assert.equal(runStateCalls, 1, 'the server is asked exactly once, not once per click');

  // The next click starts the box; it must not stop again.
  clickEntity(controller, contraption, 'arm', { x: 0, y: 1, z: 0 }, new THREE.Vector3(0.5, 11.5, 0.5));
  assert.ok(controller.selectorRange?.pointA, 'the next click sets the first point');
  assert.equal(controller.selectorRange?.nodeId, 'arm');
});

test('after the stop click, level switching and box clicks behave normally', () => {
  const { contraption } = makeEntityWithChildren();
  const controller = makeSelectorController();
  contraption.scriptStatus = 'running';

  clickEntity(controller, contraption, 'arm', { x: 0, y: 1, z: 0 }, new THREE.Vector3(0.5, 11.5, 0.5)); // stop
  assert.equal(contraption.scriptStatus, 'stopped');

  clickEntity(controller, contraption, 'arm', { x: 0, y: 1, z: 0 }, new THREE.Vector3(0.5, 11.5, 0.5)); // point 1
  assert.equal(controller.selectorRange?.nodeId, 'arm');
  assert.ok(controller.selectorRange?.pointA);

  // Shift-clicking hand switches levels instead of entering box mode.
  clickEntity(controller, contraption, 'hand', { x: 0, y: 2, z: 0 }, new THREE.Vector3(0.5, 12.5, 0.5), { shiftKey: true });
  assert.equal(controller.selectedSubtree?.rootId, 'hand', 'Shift-click switches the level');
  assert.equal(controller.selectorRange?.pointA ?? null, null, 'Shift-click does not set a box point');
});

test('a running entity is stopped even when a stale box was in progress', () => {
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

  assert.equal(contraption.scriptStatus, 'stopped', 'the running entity is stopped');
  assert.equal(controller.selectorRange, null, 'stale box progress is discarded by the stop');
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
  assert.ok(toasts.some(m => m.includes('起点不是实体，结束点也不能是实体')), 'toast should warn about invalid endpoint');
  assert.equal(controller.selectedSubtree, null, 'whole-entity selection should not activate');
});

test('R copies a whole entity into an entity slot after the running entity is stopped', () => {
  const { contraption } = makeEntityWithChildren();
  const controller = makeSelectorController();
  contraption.scriptStatus = 'running';

  // First click stops the entity; the next click selects the root level (whole tree).
  clickEntity(controller, contraption, 'root', { x: 0, y: 0, z: 0 }, new THREE.Vector3(0.5, 10.5, 0.5));
  assert.equal(contraption.scriptStatus, 'stopped');
  clickEntity(controller, contraption, 'root', { x: 0, y: 0, z: 0 }, new THREE.Vector3(0.5, 10.5, 0.5));

  controller.copySelectionToInventory(); // R-key path.
  const slot = controller.inventorySlots[0];
  assert.ok(slot, 'the whole entity should be copied into the slot');
  assert.equal(slot.blockCount, 4, 'the slot should include every entity block');
  assert.notEqual(slot.kind, 'blockset', 'R should remain entity copy');
});
