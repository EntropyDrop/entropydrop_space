import { worldStub, requireValue } from './fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { LegacyBackpack } from '@entropydrop/space-engine/generated/backpack.ts';
import { InventoryResource } from '@entropydrop/space-engine/generated/inventory.ts';
import {
  decodeBackpack, decodeInventoryResource, encodeInventoryResource,
  protobufFromBase64, protobufToBase64,
} from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';
import { BULK_EDIT_THRESHOLD, PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { getInventoryPreviewBlocks } from '../src/engine/render/SceneRenderer.ts';

function controller() {
  const instance: any = Object.create(PlayerController.prototype);
  instance.activeTool = SpecialTool.HAMMER;
  instance.inventoryCategory();
  instance.ui = { showToast() {}, renderInventoryBar() {} };
  return instance;
}

function entity(x: number, name = 'Motor'): any {
  return {
    type: 'space-entity', version: 8,
    root: {
      id: 'root', name, localPosition: [x, 0, 0],
      body: { type: 'dynamic' }, blocks: [{ dx: 0, dy: 0, dz: 0, color: 2, materialId: 1 }],
      children: [], seats: [], script: 'export function update(): void {}', scriptLanguage: 'assemblyscript',
    }, constraints: [],
  };
}

function mixedItem(): any {
  return {
    type: 'space-item', version: 8, id: 'workshop', name: 'Workshop',
    blockSet: {
      type: 'space-blockset', version: 8, name: 'Base',
      blocks: [{ dx: 0, dy: -1, dz: 0, color: 1, materialId: 1 }],
    }, entityList: [entity(2), entity(6, 'Cart')],
  };
}

function parse(instance: any, item = mixedItem()) {
  const result = instance.parseInventoryImport(encodeInventoryResource('item', item), 'item');
  assert.equal(result.ok, true, result.error);
  return result.item;
}

test('mixed Item import/export keeps root poses, scripts, materials and local id scopes', () => {
  const instance = controller();
  const slot = parse(instance);
  assert.equal(slot.blockCount, 3);
  assert.equal(slot.entityList.length, 2);
  assert.deepEqual(slot.entityList.map((entry: import('@entropydrop/space-engine/storage/InventoryTypes.ts').InventoryInput) => entry.rootComponentId), ['root', 'root']);
  assert.deepEqual(slot.entityList[0].itemPosition, [2, 0, 0]);
  assert.equal(slot.blockSet.blocks[0].materialId, 1);
  assert.equal(slot.entityList[0].blocks[0].materialId, 1);
  assert.equal(slot.entityList[0].scripts[0].code, 'export function update(): void {}');
  const geometry = getInventoryPreviewBlocks(slot);
  assert.deepEqual(geometry.map(entry => entry.center.toArray()), [[0.5, -0.5, 0.5], [2.5, 0.5, 0.5], [6.5, 0.5, 0.5]]);
  const original = decodeInventoryResource(encodeInventoryResource('item', mixedItem())).portable;
  const exported = decodeInventoryResource(instance.encodeInventoryItem('item', slot), 'item').portable;
  assert.deepEqual(exported, original);
});

test('Item validation rejects empty content, overlaps, invalid poses and aggregate budgets', () => {
  const instance = controller();
  const rejects = (item: any, pattern: RegExp) => {
    const result = instance.parseInventoryImport(encodeInventoryResource('item', item), 'item');
    assert.equal(result.ok, false);
    assert.match(result.error, pattern);
  };
  rejects({ ...mixedItem(), blockSet: undefined, entityList: [] }, /at least|between/);
  rejects({ ...mixedItem(), blockSet: undefined, entityList: [entity(2), entity(2)] }, /overlap/);
  const invalidPosition = mixedItem();
  invalidPosition.entityList[0].root.localPosition = [513, 0, 0];
  rejects(invalidPosition, /position/);
  const badRotation = mixedItem();
  badRotation.entityList[0].root.localRotation = [0, 0, 0, 0];
  rejects(badRotation, /rotation/);
  const tooMany = mixedItem();
  for (const entry of tooMany.entityList) {
    entry.root.children = Array.from({ length: 32 }, (_, index) => ({
      id: `child_${index}`, body: { type: 'kinematic' }, blocks: [], children: [], seats: [],
    }));
  }
  rejects(tooMany, /aggregate/);
});

test('Item Entity origins keep fractional offsets while exact occupancy still rejects overlaps', () => {
  const instance = controller();
  for (const position of [[-1.03, 0.2, 0.031], [1e-8, 0.01, -0.1]]) {
    const definition = entity(0);
    definition.root.localPosition = position;
    const item = { ...mixedItem(), blockSet: undefined, entityList: [definition] };
    const slot = parse(instance, item);
    assert.deepEqual(slot.entityList[0].itemPosition, position);
    const exported = decodeInventoryResource(instance.encodeInventoryItem('item', slot), 'item').portable;
    assert.deepEqual(exported.entityList[0].root.localPosition, position);
  }
  const microEntity = (x: number) => {
    const definition = entity(x);
    definition.root.blocks = [{ dx: 0, dy: 0, dz: 0, mx: 0, my: 0, mz: 0, color: 2 }];
    return definition;
  };
  const item = { ...mixedItem(), blockSet: undefined, entityList: [microEntity(1.01), microEntity(1.12)] };
  const overlap = instance.parseInventoryImport(encodeInventoryResource('item', item), 'item');
  assert.equal(overlap.ok, false);
  assert.match(overlap.error, /overlap/);
  item.entityList[1].root.localPosition = [1.135, 0, 0];
  assert.ok(parse(instance, item), 'touching micro voxels at a fractional boundary remain valid');
  item.entityList = [microEntity(0.99), microEntity(256.74)];
  assert.ok(parse(instance, item), 'portable bounds measure occupied volume rather than rounded parent cells');
  item.entityList[1].root.localPosition = [256.9, 0, 0];
  const oversized = instance.parseInventoryImport(encodeInventoryResource('item', item), 'item');
  assert.equal(oversized.ok, false);
  assert.match(oversized.error, /bounds/);
  const invalidComponent = entity(2);
  invalidComponent.root.children = [{
    id: 'arm', pivot: [1.5, 0.5, 0.5], localPosition: [0.1, 0, 0],
    body: { type: 'kinematic' }, blocks: [{ dx: 1, dy: 0, dz: 0, color: 2 }], children: [], seats: [],
  }];
  const invalid = instance.parseInventoryImport(encodeInventoryResource('item', {
    ...mixedItem(), blockSet: undefined, entityList: [invalidComponent],
  }), 'item');
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /grid/);
});

test('mixed Item placement shares one rotation/origin and creates fresh independent entities', () => {
  const instance = controller();
  const item = mixedItem();
  item.entityList[0].constraints = [{
    id: 'world_joint', type: 'point', bodyA: null, bodyB: 'root',
    anchorA: [2.5, 0.5, 0.5], anchorB: [0, 0, 0], stiffness: 0.9,
  }];
  const slot = parse(instance, item);
  instance.inventories.item.items[0] = slot;
  instance.world = {};
  instance.contraptions = new ContraptionManager(new THREE.Scene(), worldStub({}), null, null);
  const origin = new THREE.Vector3(10, 20, 30);
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  instance.getInventoryPlacementPose = () => ({ position: origin.clone(), quaternion: rotation.clone() });
  const cells: any[] = [];
  const started: any[] = [];
  instance.performBasicAction = (action: { action: string; cell?: { x: number; y: number; z: number }; target: { contraption: import('@entropydrop/space-engine/contraption/Contraption.ts').Contraption } }) => {
    if (action.action === 'place-standard') cells.push(action.cell);
    if (action.action === 'start-scripts') started.push(action.target.contraption);
    return { placed: 1 };
  };
  assert.equal(instance.pasteInventorySlot(), true);
  assert.equal(instance.activeTool, SpecialTool.WRENCH);
  assert.equal(instance.inventoryPlacementPreview, null);
  assert.equal(cells.length, 1);
  assert.deepEqual(Object.values(cells[0]), [10, 19, 29]);
  const created = instance.contraptions.contraptions;
  assert.equal(created.length, 2);
  for (let index = 0; index < created.length; index++) {
    const expected = new THREE.Vector3(index === 0 ? 2 : 6, 0, 0).applyQuaternion(rotation).add(origin);
    assert.ok(created[index].originWorldPos.distanceTo(expected) < 1e-9);
    assert.ok(created[index].quaternion.angleTo(rotation) < 1e-7);
    assert.equal(created[index].rootComponentId, 'root');
  }
  const anchor = new THREE.Vector3(2.5, 0.5, 0.5).applyQuaternion(rotation).add(origin);
  assert.ok(new THREE.Vector3().fromArray(created[0].constraintDefinitions.get('world_joint').anchorA).distanceTo(anchor) < 1e-9);
  assert.equal(started.length, 2);
  assert.notEqual(created[0].publicId, created[1].publicId);
  const firstIds = created.map((entry: import('@entropydrop/space-engine/contraption/Contraption.ts').Contraption) => entry.publicId);
  instance.activateTool(SpecialTool.HAMMER);
  assert.equal(instance.pasteInventorySlot(), true);
  assert.equal(new Set(created.map((entry: import('@entropydrop/space-engine/contraption/Contraption.ts').Contraption) => entry.publicId)).size, 4);
  assert.deepEqual(created.slice(0, 2).map((entry: import('@entropydrop/space-engine/contraption/Contraption.ts').Contraption) => entry.publicId), firstIds);
  for (const entry of created) entry.dispose();
});

test('Hammer switches tools only after actual construction and clears its placement pose', () => {
  const instance = controller();
  assert.equal(instance.pasteInventorySlot(), false);
  assert.equal(instance.activeTool, SpecialTool.HAMMER);
  instance.inventories.item.items[0] = parse(instance, { ...mixedItem(), entityList: [] });
  instance.world = {};
  instance.getInventoryPlacementPose = () => null;
  assert.equal(instance.pasteInventorySlot(), false);
  assert.equal(instance.activeTool, SpecialTool.HAMMER);
  instance.getInventoryPlacementPose = () => ({ position: new THREE.Vector3() });
  instance.performBasicAction = () => ({ placed: 0 });
  assert.equal(instance.pasteInventorySlot(), false, 'occupied cells do not count as construction');
  assert.equal(instance.activeTool, SpecialTool.HAMMER);

  const tools: string[] = [];
  instance.ui.selectTool = (tool: string) => tools.push(tool);
  instance.inventoryPlacementPreview = { position: new THREE.Vector3() };
  instance.hammerRotationTurnsY = 1;
  instance.performBasicAction = () => ({ placed: 1 });
  assert.equal(instance.pasteInventorySlot(), true);
  assert.equal(instance.activeTool, SpecialTool.WRENCH);
  assert.deepEqual(tools, [SpecialTool.WRENCH]);
  assert.equal(instance.inventoryPlacementPreview, null);
  assert.equal(instance.hammerRotationTurnsY, 0);

  instance.activateTool(SpecialTool.HAMMER);
  instance.inventories.item.items[0] = parse(instance, {
    ...mixedItem(), blockSet: undefined, entityList: [entity(0)],
  });
  instance.contraptions = { buildFromSlot: () => null };
  assert.equal(instance.pasteInventorySlot(), false);
  assert.equal(instance.activeTool, SpecialTool.HAMMER);
});

test('large static and mixed Item builds switch to Wrench after their final frame', () => {
  for (const withEntities of [false, true]) {
    for (const changedTool of [false, true]) {
      const instance = controller();
      const item = mixedItem();
      const total = BULK_EDIT_THRESHOLD + 44;
      item.blockSet.blocks = Array.from({ length: total }, (_, index) => ({
        dx: index % 10, dy: -1 - Math.floor(index / 100), dz: Math.floor(index / 10) % 10,
        color: 1, materialId: 1,
      }));
      if (!withEntities) item.entityList = [];
      instance.inventories.item.items[0] = parse(instance, item);
      instance.world = {};
      instance.contraptions = new ContraptionManager(new THREE.Scene(), worldStub({}), null, null);
      instance.getInventoryPlacementPose = () => ({ position: new THREE.Vector3(10, 20, 30) });
      instance.performBasicAction = () => ({ placed: 1 });
      assert.equal(instance.pasteInventorySlot(), true);
      assert.equal(instance.activeTool, SpecialTool.HAMMER);
      instance.processBulkEditFrame(128, Infinity);
      assert.ok(instance.bulkEditJob);
      assert.equal(instance.activeTool, SpecialTool.HAMMER);
      assert.equal(instance.contraptions.contraptions.length, 0);
      if (changedTool) instance.activateTool(SpecialTool.SHOVEL);
      while (instance.bulkEditJob) instance.processBulkEditFrame(128, Infinity);
      assert.equal(instance.activeTool, changedTool ? SpecialTool.SHOVEL : SpecialTool.WRENCH);
      assert.equal(instance.contraptions.contraptions.length, withEntities ? 2 : 0);
      for (const entry of instance.contraptions.contraptions) entry.dispose();
    }
  }
});

test('legacy backpack migration keeps all 198 slots, selection and unresolved world anchors', () => {
  const instance = controller();
  const blockSet = mixedItem().blockSet;
  const definition = entity(0);
  delete definition.root.localPosition;
  definition.constraints = [{ id: 'world_joint', type: 'point', bodyA: null, bodyB: 'root', anchorA: [100, 10, 0], stiffness: 0.9 }];
  const blockResource = InventoryResource.decode(encodeInventoryResource('blockset', blockSet));
  const entityResource = InventoryResource.decode(encodeInventoryResource('entity', definition));
  const oldBytes = LegacyBackpack.encode({
    schemaVersion: 9, activeCategory: 1,
    blockSets: { selected: 0, slots: Array.from({ length: 99 }, () => ({ resource: blockResource })) },
    entities: { selected: 98, slots: Array.from({ length: 99 }, () => ({ resource: entityResource })) },
  }).finish();
  const values = new Map<string, string>([['space.backpack.v9.pb', protobufToBase64(oldBytes)]]);
  const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value) };
  assert.equal(instance.loadInventoriesFromLocalStorage(storage), true);
  assert.equal(instance.inventories.item.items.filter(Boolean).length, 198);
  assert.equal(instance.selectedInventoryIndex, 107);
  assert.equal(values.get('space.backpack.v9.pb'), protobufToBase64(oldBytes));
  const persisted = decodeBackpack(protobufFromBase64(values.get('space.backpack.v10.pb')!));
  assert.equal(persisted.categories.item!.items.length, 198);
  const persistedEntity = requireValue(persisted.categories.item!.items[0]);
  assert.ok(persistedEntity.type === 'space-entity');
  assert.deepEqual(requireValue(persistedEntity.constraints)[0].anchorA, [100, 10, 0]);
  assert.equal(requireValue(persisted.categories.item!.items[197]).type, 'space-item');
});

test('a single Entity Item installs with its authored root pose composed into the placement pose', () => {
  const instance = controller();
  const definition = entity(2);
  const innerRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  definition.root.localRotation = innerRotation.toArray();
  const slot = parse(instance, { ...mixedItem(), blockSet: undefined, entityList: [definition] });
  instance.inventories.item.items[0] = slot;
  const origin = new THREE.Vector3(10, 20, 30);
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const target = { canEditInternalSelection: () => true };
  instance.handleRunningEntityInteraction = () => false;
  instance.getInventoryPlacementPose = () => ({
    position: origin.clone(), quaternion: rotation.clone(), targetContraption: target, targetNodeId: 'arm',
  });
  let installed: any;
  instance.finishEntitySlotInstall = (entitySlot: import('@entropydrop/space-engine/storage/InventoryTypes.ts').InventoryInput, pose: { position: import('three').Vector3; quaternion?: import('three').Quaternion }) => { installed = { entitySlot, pose }; return { ok: true }; };
  assert.equal(instance.pasteInventorySlot(true), true);
  assert.equal(installed.entitySlot.rootComponentId, 'root');
  assert.equal(installed.pose.targetContraption, target);
  assert.equal(installed.pose.targetNodeId, 'arm');
  const expected = new THREE.Vector3(2, 0, 0).applyQuaternion(rotation).add(origin);
  assert.ok(installed.pose.position.distanceTo(expected) < 1e-9);
  assert.ok(installed.pose.quaternion.angleTo(rotation.clone().multiply(innerRotation)) < 1e-7);
});

test('omitted world anchors are resolved after applying the final Item placement pose', () => {
  const instance = controller();
  const definition = entity(2);
  definition.constraints = [{ id: 'joint', type: 'point', bodyA: null, bodyB: 'root', stiffness: 0.9 }];
  instance.inventories.item.items[0] = parse(instance, { ...mixedItem(), blockSet: undefined, entityList: [definition] });
  instance.contraptions = new ContraptionManager(new THREE.Scene(), worldStub({}), null, null);
  instance.performBasicAction = () => ({});
  const origin = new THREE.Vector3(10, 20, 30);
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  instance.getInventoryPlacementPose = () => ({ position: origin.clone(), quaternion: rotation.clone() });
  assert.equal(instance.pasteInventorySlot(), true);
  const created = instance.contraptions.contraptions[0];
  const pivot = created.entityNodes.get('root').group.getWorldPosition(new THREE.Vector3());
  const constraint = created.constraintDefinitions.get('joint');
  assert.ok(new THREE.Vector3().fromArray(constraint.anchorA).distanceTo(pivot) < 1e-9);
  const expectedAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
  assert.ok(new THREE.Vector3().fromArray(constraint.axisA).distanceTo(expectedAxis) < 1e-9);
  created.dispose();
});

test('copying a world Entity rebases its external anchor into the new Item frame', () => {
  const instance = controller();
  const definition = entity(0);
  delete definition.root.localPosition;
  const parsed = instance.parseInventoryImport(encodeInventoryResource('entity', definition), 'entity');
  assert.equal(parsed.ok, true, parsed.error);
  const manager = new ContraptionManager(new THREE.Scene(), worldStub({}), null, null);
  const created = manager.buildFromSlot(parsed.item, new THREE.Vector3(100, 10, 30));
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const origin = new THREE.Vector3(100, 10, 30);
  requireValue(created).position.copy(origin).add(requireValue(created).localCenter.clone().applyQuaternion(rotation));
  requireValue(created).quaternion.copy(rotation);
  requireValue(created).updateTransform();
  const localAnchor = new THREE.Vector3(2, 3, 4);
  requireValue(created).createConstraint({
    id: 'joint', type: 'point', bodyA: null, bodyB: 'root',
    anchorA: localAnchor.clone().applyQuaternion(rotation).add(origin).toArray(),
    axisA: new THREE.Vector3(0, 0, 1).applyQuaternion(rotation).toArray(),
  });
  const captured = requireValue(created).serializeSubtree();
  instance.addInventoryItem('entity', captured);
  const stored = instance.inventories.item.items[0];
  assert.equal(stored.kind, 'item');
  const constraint = stored.entityList[0].constraints[0];
  assert.ok(new THREE.Vector3().fromArray(constraint.anchorA).distanceTo(localAnchor) < 1e-9);
  assert.ok(new THREE.Vector3().fromArray(constraint.axisA).distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-9);
  const exported = decodeInventoryResource(instance.encodeInventoryItem('item', stored)).portable;
  assert.equal(exported.type, 'space-item');
  assert.ok(new THREE.Vector3().fromArray(requireValue(exported.entityList[0].constraints[0].anchorA)).distanceTo(localAnchor) < 1e-9);
  requireValue(created).dispose();
});

test('shared Item slots swap static and Entity templates without changing template identities', () => {
  const instance = controller();
  const staticSlot = parse(instance, { ...mixedItem(), id: 'static', entityList: [] });
  const entitySlot = parse(instance, { ...mixedItem(), id: 'entity', blockSet: undefined });
  instance.addInventoryItem('item', staticSlot);
  instance.addInventoryItem('item', entitySlot);
  instance.selectedInventoryIndex = 0;
  assert.equal(instance.swapInventorySlots('item', 0, 1), true);
  assert.equal(instance.selectedInventoryIndex, 1);
  assert.equal(instance.inventories.item.items[0].id, 'entity');
  assert.equal(instance.inventories.item.items[1].id, 'static');
});
