import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BodyType, ContraptionMode } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';

function block(x: number, entityId = 'root', color = 0xf2a93b) {
  return {
    localX: x,
    localY: 0,
    localZ: 0,
    size: 1,
    color,
    block: BlockTypes.COLOR_BLOCK,
    entityId
  };
}

function moduleSlot() {
  return {
    name: 'Motor',
    kind: 'entity',
    rootComponentId: 'root',
    mode: ContraptionMode.PROGRAMMABLE,
    bodyType: BodyType.DYNAMIC,
    blockCount: 2,
    blocks: [block(0), block(1, 'arm', 0x48dbfb)],
    childEntities: [{
      id: 'arm',
      parentId: 'root',
      pivot: [1.5, 0.5, 0.5],
      bodyType: BodyType.DYNAMIC,
      seats: [{ position: [0, 1, 0] }]
    }],
    scripts: [{
      id: 'root',
      code: "const motor = self.child('arm'); if (motor) motor.body.applyTorque([0, 1, 0]);"
    }],
    enabled: [{ id: 'root', enabled: true }],
    constraints: [
      { id: 'motor_hinge', type: 'hinge', bodyA: 'root', bodyB: 'arm', stiffness: 0.8 },
      { id: 'display_anchor', type: 'weld', bodyA: null, bodyB: 'root', stiffness: 1 }
    ],
    restitution: 0.2,
    friction: 0.6,
    useGravity: true,
    collisionEnabled: true,
    seats: [{ position: [0, 0.5, 0] }]
  };
}

function targetSlot() {
  return {
    name: 'Vehicle',
    kind: 'entity',
    rootComponentId: 'root',
    mode: ContraptionMode.PROGRAMMABLE,
    bodyType: BodyType.DYNAMIC,
    blockCount: 2,
    blocks: [block(0), block(1, 'arm')],
    childEntities: [{
      id: 'arm',
      parentId: 'root',
      pivot: [1.5, 0.5, 0.5],
      bodyType: BodyType.KINEMATIC
    }],
    scripts: [],
    enabled: [],
    constraints: []
  };
}

test('Hammer entity installation merges a reusable subtree and keeps the target as one entity', () => {
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null) as any;
  const target = manager.buildFromSlot(targetSlot(), new THREE.Vector3(10, 2, 4), null, false) as any;
  target.stopAllNodeScripts();
  const placement = new THREE.Vector3(14, 3, 6);

  const result = manager.installSlotAsComponent(target, moduleSlot(), 'root', placement, false);

  assert.equal(result.ok, true);
  assert.equal(manager.contraptions.length, 1, 'installation must not register a nested Contraption');
  assert.equal(result.rootId, 'root_2');
  assert.equal(target.getComponentName(result.rootId), 'Motor');
  assert.equal(result.skippedExternalConstraints, 1, 'external constraints do not leak into an installed module');
  assert.equal(target.getEntityNode('root_2').parentId, 'root');
  assert.equal(target.getNodeBodyType('root_2'), BodyType.KINEMATIC, 'the installed root is rigidly attached');
  assert.equal(target.getEntityNode('root_2_arm').parentId, 'root_2', 'conflicting ids are namespaced');
  assert.equal(target.getNodeBodyType('root_2_arm'), BodyType.DYNAMIC, 'internal body configuration is preserved');
  assert.equal(target.getComponentSeats('root_2').length, 1);
  assert.equal(target.getComponentSeats('root_2_arm').length, 1);
  assert.match(target.getNodeScript('root_2'), /child\("root_2_arm"\)/, 'literal child lookups follow remapped ids');
  assert.equal(target.scriptStatus, 'stopped', 'installing scripts cannot start a stopped target');
  assert.equal(target.isNodeScriptEnabled('root_2'), false);

  const installedRootBlock = target.blocks.find(item => item.entityId === 'root_2');
  const installedArmBlock = target.blocks.find(item => item.entityId === 'root_2_arm');
  assert.ok(installedRootBlock);
  assert.ok(installedArmBlock);
  assert.ok(target.getBlockWorldCenter(installedRootBlock).distanceTo(placement.clone().addScalar(0.5)) < 1e-9);
  assert.ok(target.getBlockWorldCenter(installedArmBlock).distanceTo(
    placement.clone().add(new THREE.Vector3(1.5, 0.5, 0.5))
  ) < 1e-9);

  const hinge = [...target.constraintDefinitions.values()].find(item => item.bodyB === 'root_2_arm');
  assert.ok(hinge);
  assert.equal(hinge.bodyA, 'root_2');
});

test('the same entity module can be installed repeatedly with stable remapped scripts', () => {
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null) as any;
  const target = manager.buildFromSlot(targetSlot(), new THREE.Vector3(), null, false) as any;
  target.stopAllNodeScripts();

  const first = manager.installSlotAsComponent(target, moduleSlot(), 'root', new THREE.Vector3(3, 0, 0), false);
  const second = manager.installSlotAsComponent(target, moduleSlot(), 'root', new THREE.Vector3(6, 0, 0), false);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.rootId, 'root_3');
  assert.equal(target.getComponentName(second.rootId), 'Motor');
  assert.ok(target.getEntityNode('root_3_arm'));
  assert.match(target.getNodeScript('root_3'), /child\("root_3_arm"\)/);
  assert.equal(target.entityNodes.size, 6);
  assert.equal(target.blocks.length, 6);
});

test('installed modules keep the Hammer world pose on rotated targets and after persistence restore', () => {
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null) as any;
  const target = manager.buildFromSlot(targetSlot(), new THREE.Vector3(10, 2, 4), null, false) as any;
  target.stopAllNodeScripts();
  target.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  target.updateTransform();
  const placement = new THREE.Vector3(15, 4, 9);

  const result = manager.installSlotAsComponent(target, moduleSlot(), 'arm', placement, false);
  assert.equal(result.ok, true);
  const installedBlock = target.blocks.find(item => item.entityId === result.rootId);
  const before = target.getBlockWorldCenter(installedBlock);
  assert.ok(before.distanceTo(placement.clone().addScalar(0.5)) < 1e-9,
    'the module follows its world-space Hammer ghost instead of inheriting target rotation');

  const record = manager.captureContraptionForStreaming(target, { id: '0,0' });
  const restoredManager = new ContraptionManager(new THREE.Scene(), null, null, null) as any;
  const restored = restoredManager.buildFromSlot(
    record.slot,
    new THREE.Vector3().fromArray(record.constructorOrigin),
    record,
    false
  ) as any;
  const restoredBlock = restored.blocks.find(item => item.entityId === result.rootId);

  assert.ok(restored.getEntityNode(result.rootId));
  assert.equal(restored.getEntityNode(result.rootId).parentId, 'arm');
  assert.ok(restored.getBlockWorldCenter(restoredBlock).distanceTo(before) < 1e-9);
  assert.equal(restored.getNodeScript(result.rootId), target.getNodeScript(result.rootId));
});

test('component installation is rejected without mutation while the target is running', () => {
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null) as any;
  const target = manager.buildFromSlot(targetSlot(), new THREE.Vector3(), null, false) as any;
  target.scriptStatus = 'running';
  const blockCount = target.blocks.length;
  const componentCount = target.entityNodes.size;

  const result = manager.installSlotAsComponent(target, moduleSlot(), 'root', new THREE.Vector3(3, 0, 0), false);

  assert.deepEqual(result, { ok: false, reason: 'target_not_stopped' });
  assert.equal(target.blocks.length, blockCount);
  assert.equal(target.entityNodes.size, componentCount);
});

test('Hammer forwards Shift/crouch as an explicit install modifier', () => {
  const controller = Object.create(PlayerController.prototype) as any;
  controller.activeTool = SpecialTool.HAMMER;
  controller.bulkEditJob = null;
  controller.keys = { crouch: false };
  const calls: boolean[] = [];
  controller.pasteInventorySlot = value => calls.push(value);

  controller.handleLeftClick({ shiftKey: false });
  controller.handleLeftClick({ shiftKey: true });
  controller.keys.crouch = true;
  controller.handleLeftClick({ shiftKey: false });

  assert.deepEqual(calls, [false, true, true]);
});

test('plain Hammer placement on an entity installs under the hit component automatically', () => {
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null) as any;
  const target = manager.buildFromSlot(targetSlot(), new THREE.Vector3(), null, false) as any;
  target.stopAllNodeScripts();
  const sensorSlot = {
    name: 'Sensor',
    kind: 'entity',
    rootComponentId: 'root',
    blockCount: 1,
    blocks: [block(0)],
    childEntities: [],
    scripts: [],
    enabled: [],
    constraints: []
  };
  const controller = Object.create(PlayerController.prototype) as any;
  controller.activeTool = SpecialTool.HAMMER;
  controller.bulkEditJob = null;
  controller.hammerRotationTurns = 0;
  controller.inventories = controller.createEmptyInventories();
  controller.activeInventoryCategory = 'entity';
  controller.inventories.entity.items[0] = sensorSlot;
  controller.inventories.entity.selected = 0;
  controller.contraptions = manager;
  controller.currentRaycast = { hit: false };
  controller.hoveredContraptionHit = {
    point: new THREE.Vector3(1.5, 0.5, 1),
    worldNormal: new THREE.Vector3(0, 0, 1),
    normal: new THREE.Vector3(0, 0, 1),
    contraption: target,
    entityId: 'arm'
  };
  controller.physics = { getEyePosition: () => new THREE.Vector3() };
  controller.sound = { playAssemblyClack() {}, playBlockPlace() {} };
  controller.ui = { showToast() {}, notifyContraptionStructureChanged() {} };

  const pose = controller.getInventoryPlacementPose(sensorSlot);
  const expectedCenter = getExpectedPlacedCenter(sensorSlot.blocks[0], pose);
  assert.equal(controller.pasteInventorySlot(false), true);

  assert.equal(manager.contraptions.length, 1, 'entity-on-entity placement must not spawn a second Contraption');
  assert.equal(target.getEntityNode('root_2').parentId, 'arm');
  assert.equal(target.getComponentName('root_2'), 'Sensor');
  const installedBlock = target.blocks.find(item => item.entityId === 'root_2');
  assert.ok(installedBlock);
  assert.ok(target.getBlockWorldCenter(installedBlock).distanceTo(expectedCenter) < 1e-8,
    'the installed child must use the exact preview position and outward rotation');
});

test('entity anchor frame and Hammer roll compose into the installed localRotation', () => {
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null) as any;
  const target = manager.buildFromSlot(targetSlot(), new THREE.Vector3(), null, false) as any;
  target.stopAllNodeScripts();
  const anchor = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    -Math.PI / 2
  );
  const rotorSlot = {
    name: 'Rotor',
    kind: 'entity',
    rootComponentId: 'root',
    anchorRotation: anchor.toArray(),
    blockCount: 1,
    blocks: [block(0)],
    childEntities: [],
    scripts: [],
    enabled: [],
    constraints: []
  };
  const controller = Object.create(PlayerController.prototype) as any;
  controller.activeTool = SpecialTool.HAMMER;
  controller.bulkEditJob = null;
  controller.inventories = controller.createEmptyInventories();
  controller.activeInventoryCategory = 'entity';
  controller.inventories.entity.items[0] = rotorSlot;
  controller.inventories.entity.selected = 0;
  controller.hammerRotationTurns = 1;
  controller.contraptions = manager;
  controller.currentRaycast = { hit: false };
  controller.hoveredContraptionHit = {
    point: new THREE.Vector3(1.5, 0.5, 1),
    worldNormal: new THREE.Vector3(0, 0, 1),
    normal: new THREE.Vector3(0, 0, 1),
    contraption: target,
    entityId: 'arm'
  };
  controller.physics = { getEyePosition: () => new THREE.Vector3() };
  controller.sound = { playAssemblyClack() {}, playBlockPlace() {} };
  controller.ui = { showToast() {}, notifyContraptionStructureChanged() {} };

  const placedSlot = controller.getActiveHammerInventoryItem();
  const pose = controller.getInventoryPlacementPose(placedSlot);
  const authoredOutward = new THREE.Vector3(0, 1, 0).applyQuaternion(anchor);
  const worldOutward = authoredOutward.clone().applyQuaternion(pose.quaternion).normalize();
  assert.ok(worldOutward.distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-8,
    'Hammer roll must preserve the anchor outward direction');

  assert.equal(controller.pasteInventorySlot(false), true);
  const installed = target.getEntityNode('root_2');
  const placedAnchor = new THREE.Quaternion().fromArray(placedSlot.anchorRotation);
  assert.ok(installed);
  assert.ok(target.getEntityNodeWorldQuaternion('root_2').angleTo(pose.quaternion) < 1e-8);
  assert.equal(target.getComponentName('root_2'), 'Rotor');
  assert.ok(installed.anchorQuaternion.angleTo(placedAnchor) < 1e-8,
    'the installed component retains the right-clicked anchor roll');

  const copied = target.serializeSubtree('root_2');
  assert.ok(new THREE.Quaternion().fromArray(copied.anchorRotation).angleTo(placedAnchor) < 1e-8,
    'copying the installed module must retain its authored anchor frame');
});

function getExpectedPlacedCenter(blockValue: any, pose: any) {
  const size = Number(blockValue.size) || 1;
  return new THREE.Vector3(
    Number(blockValue.localX) + size / 2,
    Number(blockValue.localY) + size / 2,
    Number(blockValue.localZ) + size / 2
  ).applyQuaternion(pose.quaternion).add(pose.position);
}
