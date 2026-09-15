import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ActionDomain } from '@entropydrop/space-engine/actions/BasicActions.ts';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';

function fixture() {
  const scene = new THREE.Scene();
  const world = new World(scene);
  const manager = new ContraptionManager(scene, world, null, null);
  const entity = new Contraption(1, [
    { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0xff0000 },
    { localX: 2, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0xff0000 }
  ], new THREE.Vector3(0, 50, 0), scene, { rootComponentId: 'root' });
  entity.stopAllNodeScripts();
  manager.registerContraption(entity);
  const controller: any = Object.create(PlayerController.prototype);
  Object.assign(controller, {
    _activeTool: SpecialTool.SELECTOR, contraptions: manager, world,
    selectedSubtree: null, selectedBlockSelection: null, selectorRange: null, selectorLevel: null,
    selectorShape: 'box', selectorMicroMode: false, keys: {}, selectedColor: 0x00ff00,
    sound: { playWrenchClick() {}, playBlockPlace() {}, playBlockBreak() {}, playAssemblyClack() {} },
    inventorySlots: new Array(8).fill(null), selectedInventoryIndex: 0
  });
  const toasts: string[] = [];
  controller.ui = { showToast: m => toasts.push(m), renderInventoryBar() {}, notifyContraptionStructureChanged() {} };
  manager.selectionHost = controller;
  return { controller, manager, entity, world, toasts };
}

const operations = [
  'deleteSelectionBlocks', 'copySelectionSmart', 'copySelectionToInventory', 'copySelectionAsBlockSet',
  'copySelectedSubtreeToInventory', 'fillSelectionBlocks', 'paintSelectionBlocks',
  'createChildFromSelectedBlocks', 'assembleSelection', 'rotateSelection'
];

for (const selection of ['world-A', 'world-Shift', 'entity-A', 'entity-Shift']) {
  for (const operation of operations) {
    test(`${operation} rejects ${selection} without dispatching or mutating`, () => {
      const { controller, manager, entity, world, toasts } = fixture();
      world.setBlock(10, 50, 10, BlockTypes.COLOR_BLOCK, false, 0xff0000);
      if (selection === 'world-A') manager.setCornerA({ x: 10, y: 50, z: 10 });
      if (selection === 'world-Shift') manager.toggleWorldGlueCell({ x: 10, y: 50, z: 10 });
      if (selection === 'entity-A') {
        controller.selectedSubtree = { contraption: entity, rootId: 'root', nodeIds: new Set(['root']) };
        controller.selectorRange = { contraption: entity, nodeId: 'root', pointA: { x: 0, y: 0, z: 0 }, pointB: null };
      }
      if (selection === 'entity-Shift') controller.selectedBlockSelection = {
        contraption: entity, nodeId: 'root', blocks: [entity.blocks[0]]
      };
      let dispatched = 0;
      controller.performBasicAction = () => { dispatched++; throw new Error('Unconfirmed operation dispatched'); };
      controller[operation]('cw', 'y');
      assert.equal(dispatched, 0);
      assert.equal(entity.blocks.length, 2);
      assert.equal(entity.blocks[0].color, 0xff0000);
      assert.equal(entity.childDefinitions.size, 0);
      assert.equal(world.getBlockColor(10, 50, 10), 0xff0000);
      assert.equal(controller.inventorySlots.every(slot => slot === null), true);
      assert.equal(controller.canUseSelectionActions(), false);
      assert.ok(toasts.some(m => m.includes('A and B')));
    });
  }
}

test('confirmed A/B enables copying, filling and painting entity selections', () => {
  for (const operation of ['copySelectionSmart', 'copySelectionAsBlockSet', 'fillSelectionBlocks', 'paintSelectionBlocks']) {
    const { controller, entity } = fixture();
    controller.hoveredContraptionHit = { contraption: entity, entityId: 'root' };
    assert.equal(controller.selectAllSelectionBlocks(), true);
    assert.equal(controller.canUseSelectionActions(), true);
    controller[operation]();
    if (operation.startsWith('copy')) {
      assert.ok(controller.inventorySlots.some(Boolean));
      assert.equal(entity.blocks.length, 2);
      assert.equal(entity.blocks[0].color, 0xff0000);
    } else {
      assert.equal(entity.blocks[0].color, 0x00ff00);
      assert.equal(entity.blocks.length, operation === 'fillSelectionBlocks' ? 3 : 2);
    }
  }
});

test('a rejected Shift micro paint/fill/copy never materializes virtual entity voxels', () => {
  for (const operation of ['paintSelectionBlocks', 'fillSelectionBlocks', 'copySelectionAsBlockSet', 'createChildFromSelectedBlocks']) {
    const { controller, entity } = fixture();
    controller.selectorMicroMode = true;
    controller.selectedBlockSelection = {
      contraption: entity, nodeId: 'root', micro: true,
      blocks: [{ ...entity.blocks[0], size: 0.125, virtualMicro: true }]
    };
    controller[operation]();
    assert.equal(entity.blocks.length, 2);
    assert.equal(entity.blocks.every(block => (block.size || 1) === 1), true);
  }
});

test('canonical player geometry attempts immediately stop only; the next attempt edits', () => {
  const { controller, entity, toasts } = fixture();
  entity.enableAllNodeScripts();
  const command = { domain: ActionDomain.ENTITY, action: 'remove-standard', target: { contraption: entity },
    cell: { x: 0, y: 0, z: 0 }, nodeId: 'root' };
  assert.equal(controller.performBasicAction(command).reason, 'entity_not_stopped');
  assert.equal(entity.isPhysicsSimulationEnabled(), false);
  assert.equal(entity.blocks.length, 2);
  assert.ok(toasts.some(m => m === 'Entity #1 stopped'));
  assert.equal(controller.performBasicAction(command).ok, true);
  assert.equal(entity.blocks.length, 1);
});

for (const tool of [SpecialTool.SHOVEL, SpecialTool.SPOON]) {
  for (const method of ['handleLeftClick', 'handleRightClick']) {
    for (const kind of ['standard', 'micro']) {
      for (const shiftKey of [false, true]) {
        test(`${tool} ${method} ${kind} Shift=${shiftKey} immediately stops without editing`, () => {
          const { controller, entity, toasts } = fixture();
          entity.enableAllNodeScripts();
          controller._activeTool = tool;
          controller.hoveredContraptionHit = { contraption: entity, entityId: 'root', kind,
            block: entity.blocks[0], cell: { x: 0, y: 0, z: 0 },
            point: new THREE.Vector3(0.5, 50.5, 0.5) };
          const dispatch = controller.performBasicAction.bind(controller);
          let stopCommands = 0;
          controller.performBasicAction = command => {
            if (command.domain === ActionDomain.SELECTION) {
              assert.equal(command.action, 'clear', 'only selection cleanup is allowed');
            } else {
              assert.equal(command.action, 'stop-scripts', 'the physical click cannot dispatch an edit');
              stopCommands++;
            }
            return dispatch(command);
          };
          assert.equal(controller[method]({ shiftKey }), false);
          assert.equal(stopCommands, 1);
          assert.equal(entity.isPhysicsSimulationEnabled(), false);
          assert.equal(entity.blocks.length, 2);
          assert.equal(entity.blocks.every(block => block.color === 0xff0000 && (block.size || 1) === 1), true);
          assert.deepEqual(toasts, ['Entity #1 stopped']);
        });
      }
    }
  }
}

for (const operation of operations) {
  test(`${operation} immediately stops a running selection without also performing the action`, () => {
    const { controller, entity, toasts } = fixture();
    entity.enableAllNodeScripts();
    controller.selectedBlockSelection = { contraption: entity, nodeId: 'root', blocks: [...entity.blocks],
      confirmedRange: { pointA: { x: 0, y: 0, z: 0 }, pointB: { x: 2, y: 0, z: 0 } } };
    controller[operation]('cw', 'y');
    assert.equal(entity.isPhysicsSimulationEnabled(), false);
    assert.equal(entity.blocks.length, 2);
    assert.equal(entity.blocks.every(block => block.color === 0xff0000), true);
    assert.equal(entity.childDefinitions.size, 0);
    assert.equal(controller.inventorySlots.every(slot => slot === null), true);
    assert.equal(controller.selectedBlockSelection, null);
    assert.deepEqual(toasts, ['Entity #1 stopped']);
  });
}

test('Select All immediately stops a running entity and selects only on the next attempt', () => {
  const { controller, entity, toasts } = fixture();
  entity.enableAllNodeScripts();
  controller.hoveredContraptionHit = { contraption: entity, entityId: 'root' };
  assert.equal(controller.selectAllSelectionBlocks(), false);
  assert.equal(entity.isPhysicsSimulationEnabled(), false);
  assert.equal(controller.selectedBlockSelection, null);
  assert.equal(controller.canUseSelectionActions(), false);
  assert.deepEqual(toasts, ['Entity #1 stopped']);
  assert.equal(controller.selectAllSelectionBlocks(), true);
  assert.equal(controller.canUseSelectionActions(), true);
});

test('every target and restart stops on the first attempt, independent of timing', t => {
  const { controller, entity, manager, toasts } = fixture();
  const other = new Contraption(2, [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(10, 50, 0), new THREE.Scene());
  manager.registerContraption(other);
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  for (const target of [entity, other, entity, other]) {
    target.enableAllNodeScripts();
    now += 5000;
    assert.equal(controller.handleRunningEntityInteraction(target), true);
    assert.equal(target.isPhysicsSimulationEnabled(), false);
    assert.equal(controller.handleRunningEntityInteraction(target), false, 'a stopped entity is not stopped twice');
  }
  assert.deepEqual(toasts, ['Entity #1 stopped', 'Entity #2 stopped', 'Entity #1 stopped', 'Entity #2 stopped']);
});

test('server stop waits for acknowledgement and consumes all attempts while pending', async () => {
  const { controller, entity } = fixture();
  entity.enableAllNodeScripts();
  Object.assign(entity, { serverManaged: true, serverCanControl: true, serverCanEdit: true, serverDesiredRunState: 'running' });
  let acknowledge!: () => void;
  let requests = 0;
  const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
  controller.serverEntityRunStateHandler = async (_, state) => { requests++; assert.equal(state, 'stopped'); await acknowledgement; };
  controller.handleRunningEntityInteraction(entity);
  assert.equal(requests, 1, 'the first operation must send Stop immediately');
  assert.equal(controller.canEditEntityInternals(entity), false);
  assert.equal(entity.isPhysicsSimulationEnabled(), true);
  controller.handleRunningEntityInteraction(entity);
  assert.equal(requests, 1, 'pending retries must not duplicate stop requests');
  const command = { domain: ActionDomain.ENTITY, action: 'remove-standard', target: { contraption: entity },
    cell: { x: 0, y: 0, z: 0 }, nodeId: 'root' };
  assert.equal(controller.performBasicAction(command).ok, false);
  assert.equal(entity.blocks.length, 2);
  acknowledge();
  await acknowledgement;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(entity.isPhysicsSimulationEnabled(), false);
  assert.equal(entity.serverDesiredRunState, 'stopped');
  assert.equal(controller.canUseSelectionActions(), false);
});

test('server stop cannot bypass owner permissions or a failed acknowledgement', async () => {
  for (const owner of [false, true]) {
    const { controller, entity } = fixture();
    entity.enableAllNodeScripts();
    Object.assign(entity, { serverManaged: true, serverCanControl: owner, serverCanEdit: true, serverDesiredRunState: 'running' });
    let requests = 0;
    controller.serverEntityRunStateHandler = async () => { requests++; throw new Error('Stop failed'); };
    controller.handleRunningEntityInteraction(entity);
    controller.handleRunningEntityInteraction(entity);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(requests, owner ? 1 : 0);
    assert.equal(entity.isPhysicsSimulationEnabled(), true);
    assert.equal(entity.serverDesiredRunState, 'running');
    assert.equal(controller.canEditEntityInternals(entity), false);
  }
});

test('one Spoon click stops without subdivision or carving; the next click carves normally', () => {
  const { controller, entity } = fixture();
  entity.enableAllNodeScripts();
  controller._activeTool = SpecialTool.SPOON;
  controller.hoveredContraptionHit = { contraption: entity, entityId: 'root', kind: 'standard',
    block: entity.blocks[0], cell: { x: 0, y: 0, z: 0 },
    placeMicroPos: { localX: 0.125, localY: 0, localZ: 0 }, normal: { x: 1, y: 0, z: 0 },
    point: new THREE.Vector3(0, 50, 0) };
  controller.particles = { emitBlockBreak() {} };
  controller.handleLeftClick();
  assert.equal(entity.isPhysicsSimulationEnabled(), false);
  assert.equal(entity.blocks.length, 2, 'the Stop click must not carve or subdivide');
  controller.handleLeftClick();
  assert.ok(entity.blocks.some(block => block.size === 0.125), 'the next click may subdivide and carve');
});

test('the first click on a newly running entity stops and clears stale internal selection', () => {
  const { controller, entity } = fixture();
  controller.selectedBlockSelection = { contraption: entity, nodeId: 'root', blocks: [...entity.blocks],
    confirmedRange: { pointA: { x: 0, y: 0, z: 0 }, pointB: { x: 2, y: 0, z: 0 } } };
  entity.enableAllNodeScripts();
  controller.hoveredContraptionHit = { contraption: entity, entityId: 'root', point: new THREE.Vector3(0.5, 50.5, 0.5) };
  controller.handleLeftClick();
  assert.equal(entity.isPhysicsSimulationEnabled(), false);
  assert.equal(entity.blocks.length, 2, 'stopping does not edit the previous selection');
  assert.equal(controller.selectedBlockSelection, null);
  assert.equal(controller.selectorRange, null);
});

test('delayed server stop acknowledgement cannot overwrite a newer remote Start', async () => {
  const { controller, entity } = fixture();
  entity.enableAllNodeScripts();
  Object.assign(entity, { serverManaged: true, serverCanControl: true, serverCanEdit: true,
    serverDesiredRunState: 'running', serverRevision: 1 });
  controller.serverEntityRunStateHandler = async () => {
    entity.serverRevision = 3;
    entity.serverDesiredRunState = 'running';
  };
  controller.handleRunningEntityInteraction(entity);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(entity.serverDesiredRunState, 'running');
  assert.equal(entity.isPhysicsSimulationEnabled(), true);
  assert.equal(controller.canEditEntityInternals(entity), false);
});

test('a locally frozen mirror with durable running state still requires owner stop', () => {
  const { controller, entity } = fixture();
  Object.assign(entity, { serverManaged: true, serverCanControl: false, serverCanEdit: true, serverDesiredRunState: 'running' });
  assert.equal(entity.isPhysicsSimulationEnabled(), false);
  assert.equal(controller.canEditEntityInternals(entity), false);
  assert.equal(controller.handleRunningEntityInteraction(entity), true);
  assert.equal(controller.handleRunningEntityInteraction(entity), true);
  assert.equal(entity.serverDesiredRunState, 'running');
  assert.equal(controller.canEditEntityInternals(entity), false);
});
