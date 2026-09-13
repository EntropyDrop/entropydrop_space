import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { PlayerController } from '../src/engine/controls/PlayerController.ts';
import { decodeInventoryResource } from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';

function sourceEntity() {
  return new Contraption(1, [
    { localX: 0, localY: 0, localZ: 0, size: 1, block: 1, color: 1, entityId: 'world' },
    { localX: 1, localY: 0, localZ: 0, size: 1, block: 1, color: 2, entityId: 'root' },
    { localX: 2, localY: 0, localZ: 0, size: 1, block: 1, color: 3, entityId: 'B' },
  ], new THREE.Vector3(), new THREE.Scene(), {
    rootComponentId: 'world', rootComponentName: 'Robot',
    childEntities: [
      { id: 'root', name: 'Shared module', parentId: 'world' },
      { id: 'B', name: 'Shared module', parentId: 'world' },
    ],
    constraints: [{ id: 'joint', type: 'point', bodyA: 'world', bodyB: 'root' }],
  });
}

test('component names survive subtree export, attachment, independent build and offline reload', () => {
  const source = sourceEntity();
  const controller = Object.create(PlayerController.prototype);
  const storage = new Map<string, string>();
  const backend = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null, backend);
  manager.setWorldId('named-world');

  const portable = decodeInventoryResource(controller.encodeInventoryItem('entity', source.serializeSubtree())).portable;
  assert.equal('name' in portable, false);
  assert.equal(portable.root.name, 'Robot');
  assert.deepEqual(portable.root.children.map(child => [child.id, child.name]), [
    ['B', 'Shared module'], ['root', 'Shared module'],
  ]);
  const imported = controller.parseInventoryImport(controller.encodeInventoryItem('entity', source.serializeSubtree()), 'entity');
  assert.equal(imported.ok, true, imported.error);
  const built = manager.buildFromSlot(imported.item, new THREE.Vector3(0, 8, 0));
  assert.equal(built.getComponentName(), 'Robot');
  assert.equal(built.getComponentName('root'), 'Shared module');
  assert.equal(manager.saveEntitiesToStorage(), true);
  const restoredManager = new ContraptionManager(new THREE.Scene(), null, null, null, backend);
  restoredManager.setWorldId('named-world');
  assert.equal(restoredManager.loadEntitiesFromStorage(), 1);
  assert.equal(restoredManager.contraptions[0].getComponentName('root'), 'Shared module');

  const extracted = source.serializeSubtree('root');
  assert.equal(extracted.name, 'Shared module');
  const standalone = manager.buildFromSlot(extracted, new THREE.Vector3(10, 8, 0));
  assert.equal(standalone.rootComponentId, 'root');
  assert.equal(standalone.getComponentName(), 'Shared module');
  const host = sourceEntity();
  host.setPhysicsSimulationEnabled(false);
  const installed = host.installEntitySlot(extracted, 'world', new THREE.Vector3(5, 0, 0));
  assert.equal(installed.ok, true);
  assert.notEqual(installed.rootId, 'root', 'collision remaps identity without changing display name');
  assert.equal(host.getComponentName(installed.rootId), 'Shared module');
  assert.equal(host.serializeSubtree(installed.rootId).name, 'Shared module');
});

test('renaming components changes only display names, including duplicate and unnamed roots', () => {
  const source = sourceEntity();
  const before = source.serializeSubtree();
  assert.equal(source.setComponentName('world', ' Shared module '), true);
  assert.equal(source.setComponentName('B', 'ZZZ'), true);
  assert.equal(source.setComponentName('root', 'AAA'), true);
  assert.deepEqual(source.getHierarchyTree().children.map(child => child.id), ['B', 'root']);
  const after = source.serializeSubtree();
  assert.equal(after.name, 'Shared module');
  assert.deepEqual(after.blocks, before.blocks);
  assert.deepEqual(after.constraints, before.constraints);
  assert.deepEqual(after.scripts, before.scripts);
  assert.equal(source.setComponentName('root', ''), true);
  const slot = source.serializeSubtree('root');
  assert.equal(slot.name, '');
  const controller = Object.create(PlayerController.prototype);
  assert.equal(controller.inventoryItemName('entity', slot), 'root');
  const roundTrip = controller.parseInventoryImport(controller.encodeInventoryItem('entity', slot), 'entity');
  assert.equal(roundTrip.ok, true, roundTrip.error);
  assert.equal(roundTrip.item.name, '');
  assert.equal(source.setComponentName('absent', 'Name'), false);
});
