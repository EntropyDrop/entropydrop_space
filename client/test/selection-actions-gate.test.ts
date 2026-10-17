import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ActionDomain } from '@entropydrop/space-engine/actions/BasicActions.ts';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { ModelingTool } from '../src/engine/controls/ModelingTool.ts';

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
  controller.ui = { showToast: (m: string) => toasts.push(m), renderInventoryBar() {}, notifyContraptionStructureChanged() {} };
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
      assert.equal(controller.inventorySlots.every((slot: import('@entropydrop/space-engine/storage/InventoryTypes.ts').InventoryInput) => slot === null), true);
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

test('canonical player geometry attempts stay blocked until an explicit stop', () => {
  const { controller, entity, toasts } = fixture();
  entity.enableAllNodeScripts();
  const command = { domain: ActionDomain.ENTITY, action: 'remove-standard', target: { contraption: entity },
    cell: { x: 0, y: 0, z: 0 }, nodeId: 'root' };
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(controller.performBasicAction(command).reason, 'entity_not_stopped');
    assert.equal(entity.isPhysicsSimulationEnabled(), true);
    assert.equal(entity.blocks.length, 2);
  }
  assert.deepEqual(toasts, []);
  entity.stopAllNodeScripts();
  assert.equal(controller.performBasicAction(command).ok, true);
  assert.equal(entity.blocks.length, 1);
});

for (const tool of [SpecialTool.SHOVEL, SpecialTool.SPOON, SpecialTool.BRUSH]) {
  for (const method of ['handleLeftClick', 'handleRightClick']) {
    for (const kind of ['standard', 'micro']) {
      for (const shiftKey of [false, true]) {
        test(`${tool} ${method} ${kind} Shift=${shiftKey} keeps the entity running without editing`, () => {
          const { controller, entity, toasts } = fixture();
          entity.enableAllNodeScripts();
          entity.getComponentState('root').preserved = 42;
          controller._activeTool = tool;
          controller.hoveredContraptionHit = { contraption: entity, entityId: 'root', kind,
            block: entity.blocks[0], cell: { x: 0, y: 0, z: 0 },
            point: new THREE.Vector3(0.5, 50.5, 0.5) };
          controller.performBasicAction = () => assert.fail('clicks on running entities must not dispatch edits or Stop');
          for (let attempt = 0; attempt < 3; attempt++) assert.equal(controller[method]({ shiftKey }), false);
          assert.equal(entity.isPhysicsSimulationEnabled(), true);
          assert.equal(entity.getComponentState('root').preserved, 42);
          assert.equal(entity.blocks.length, 2);
          assert.equal(entity.blocks.every(block => block.color === 0xff0000 && (block.size || 1) === 1), true);
          assert.deepEqual(toasts, []);
        });
      }
    }
  }
}

for (const operation of operations) {
  test(`${operation} leaves a running selection and its entity unchanged`, () => {
    const { controller, entity, toasts } = fixture();
    entity.enableAllNodeScripts();
    const selection = { contraption: entity, nodeId: 'root', blocks: [...entity.blocks],
      confirmedRange: { pointA: { x: 0, y: 0, z: 0 }, pointB: { x: 2, y: 0, z: 0 } } };
    controller.selectedBlockSelection = selection;
    controller[operation]('cw', 'y');
    assert.equal(entity.isPhysicsSimulationEnabled(), true);
    assert.equal(entity.blocks.length, 2);
    assert.equal(entity.blocks.every(block => block.color === 0xff0000), true);
    assert.equal(entity.childDefinitions.size, 0);
    assert.equal(controller.inventorySlots.every((slot: import('@entropydrop/space-engine/storage/InventoryTypes.ts').InventoryInput) => slot === null), true);
    assert.equal(controller.selectedBlockSelection, selection);
    assert.deepEqual(toasts, []);
  });
}

test('Select All requires an explicit stop before selecting a running entity', () => {
  const { controller, entity, toasts } = fixture();
  entity.enableAllNodeScripts();
  controller.hoveredContraptionHit = { contraption: entity, entityId: 'root' };
  for (let attempt = 0; attempt < 3; attempt++) assert.equal(controller.selectAllSelectionBlocks(), false);
  assert.equal(entity.isPhysicsSimulationEnabled(), true);
  assert.equal(controller.selectedBlockSelection, null);
  assert.equal(controller.canUseSelectionActions(), false);
  assert.deepEqual(toasts, []);
  entity.stopAllNodeScripts();
  assert.equal(controller.selectAllSelectionBlocks(), true);
  assert.equal(controller.canUseSelectionActions(), true);
});

test('changing targets and repeating attempts never stops an entity', () => {
  const { controller, entity, manager, toasts } = fixture();
  const other = new Contraption(2, [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(10, 50, 0), new THREE.Scene());
  manager.registerContraption(other);
  for (const target of [entity, other, entity, other]) {
    target.enableAllNodeScripts();
    assert.equal(controller.handleRunningEntityInteraction(target), true);
    assert.equal(controller.handleRunningEntityInteraction(target), true);
    assert.equal(target.isPhysicsSimulationEnabled(), true);
  }
  assert.deepEqual(toasts, []);
});

test('player attempts never request server Stop, regardless of ownership or local mirror state', () => {
  for (const owner of [false, true]) {
    for (const locallyRunning of [false, true]) {
      const { controller, entity, toasts } = fixture();
      if (locallyRunning) entity.enableAllNodeScripts();
      Object.assign(entity, { serverManaged: true, serverCanControl: owner, serverCanEdit: true, serverDesiredRunState: 'running' });
      controller.serverEntityRunStateHandler = async () => assert.fail('an ignored click must not request server Stop');
      controller.hoveredContraptionHit = { contraption: entity, entityId: 'root' };
      for (let attempt = 0; attempt < 3; attempt++) {
        controller.handleLeftClick();
        const command = { domain: ActionDomain.ENTITY, action: 'remove-standard', target: { contraption: entity },
          cell: { x: 0, y: 0, z: 0 }, nodeId: 'root' };
        assert.equal(controller.performBasicAction(command).reason, 'entity_not_stopped');
      }
      assert.equal(entity.isPhysicsSimulationEnabled(), locallyRunning);
      assert.equal(entity.serverDesiredRunState, 'running');
      assert.equal(entity.blocks.length, 2);
      assert.equal(controller.canEditEntityInternals(entity), false);
      assert.deepEqual(toasts, []);
    }
  }
});

test('Spoon clicks do not carve a running entity; carving resumes after an explicit stop', () => {
  const { controller, entity } = fixture();
  entity.enableAllNodeScripts();
  controller._activeTool = SpecialTool.SPOON;
  controller.hoveredContraptionHit = { contraption: entity, entityId: 'root', kind: 'standard',
    block: entity.blocks[0], cell: { x: 0, y: 0, z: 0 },
    placeMicroPos: { localX: 0.125, localY: 0, localZ: 0 }, normal: { x: 1, y: 0, z: 0 },
    point: new THREE.Vector3(0, 50, 0) };
  controller.particles = { emitBlockBreak() {} };
  controller.handleLeftClick();
  controller.handleLeftClick();
  assert.equal(entity.isPhysicsSimulationEnabled(), true);
  assert.equal(entity.blocks.length, 2);
  entity.stopAllNodeScripts();
  controller.handleLeftClick();
  assert.ok(entity.blocks.some(block => block.size === 0.125), 'a stopped entity may be subdivided and carved');
});

for (const tool of [SpecialTool.SELECTOR, SpecialTool.HAMMER, SpecialTool.WRENCH, SpecialTool.MODELING, SpecialTool.PIPETTE]) {
  for (const method of ['handleLeftClick', 'handleRightClick']) {
    for (const serverManaged of [false, true]) {
      test(`${tool} ${method} leaves a ${serverManaged ? 'server' : 'local'} entity running`, () => {
        const { controller, entity } = fixture();
        entity.setComponentDecorations('root', [{ id: 'cube', color: 0xff0000 }]);
        if (serverManaged) Object.assign(entity, {
          serverManaged: true, serverCanControl: true, serverCanEdit: true, serverDesiredRunState: 'running'
        });
        else entity.enableAllNodeScripts();
        entity.getComponentState('root').preserved = 42;
        controller._activeTool = tool;
        controller.currentRaycast = { hit: false };
        controller.hoveredContraptionHit = { contraption: entity, entityId: 'root', kind: 'standard',
          block: entity.blocks[0], cell: { x: 0, y: 0, z: 0 }, point: entity.position.clone() };
        controller.activeInventoryCategory = 'item';
        controller.getActiveHammerInventoryItem = () => ({ kind: 'item' });
        controller.rotateActiveInventoryItem = () => true;
        controller.performBasicAction = () => assert.fail('running entity clicks must not dispatch edits or Stop');
        controller.serverEntityRunStateHandler = async () => assert.fail('running entity clicks must not request server Stop');
        controller.modeling = new ModelingTool(controller);
        controller.modeling.hovered = { contraption: entity, componentId: 'root', decorationId: 'cube' };
        controller.modeling.placement = { target: { contraption: entity, componentId: 'root' }, value: { id: 'preview', color: 1 } };

        for (let attempt = 0; attempt < 3; attempt++) controller[method]({ shiftKey: attempt === 1 });

        assert.equal(controller.isEntityRunning(entity), true);
        assert.equal(entity.isPhysicsSimulationEnabled(), !serverManaged);
        assert.equal(entity.getComponentState('root').preserved, 42);
        assert.equal(entity.getDecorationCount(), 1);
        assert.equal(entity.isWrenchGrabbed, false);
        assert.equal(controller.wrenchGrab == null, true);
        assert.equal(controller.modeling.selected, null);
      });
    }
  }
}

for (const kind of ['move', 'rotate']) {
  test(`Wrench ${kind} handle clicks do not stop a running entity`, () => {
    const { controller, entity } = fixture();
    entity.enableAllNodeScripts();
    controller._activeTool = SpecialTool.WRENCH;
    controller.refreshWrenchPivotTargetPose = () => ({ contraption: entity, bodyId: 'root' });
    controller.hoveredWrenchGizmoHandle = { kind, axis: 'x', handleKey: `${kind}-x`, worldPoint: entity.position.clone() };
    controller.performBasicAction = () => assert.fail('running handle clicks must not dispatch Stop');
    controller.handleLeftClick();
    assert.equal(entity.isPhysicsSimulationEnabled(), true);
    assert.equal(entity.isWrenchGrabbed, false);
    assert.equal(controller.activeWrenchGizmoDrag == null, true);
    assert.equal(entity.wrenchManipulationRevision || 0, 0);
  });
}

test('a click ignores stale internal selection on a newly running entity', () => {
  const { controller, entity } = fixture();
  const selection = { contraption: entity, nodeId: 'root', blocks: [...entity.blocks],
    confirmedRange: { pointA: { x: 0, y: 0, z: 0 }, pointB: { x: 2, y: 0, z: 0 } } };
  controller.selectedBlockSelection = selection;
  entity.enableAllNodeScripts();
  controller.hoveredContraptionHit = { contraption: entity, entityId: 'root', point: new THREE.Vector3(0.5, 50.5, 0.5) };
  controller.handleLeftClick();
  assert.equal(entity.isPhysicsSimulationEnabled(), true);
  assert.equal(entity.blocks.length, 2);
  assert.equal(controller.selectedBlockSelection, selection);
  assert.equal(controller.selectorRange, null);
});
