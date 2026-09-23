import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { spaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

function createTestEntity() {
  return new Contraption(1, [
    { localX: 0, localY: 0, localZ: 0, size: 1, block: 1, color: 1, entityId: 'root' },
    { localX: 1, localY: 0, localZ: 0, size: 1, block: 1, color: 2, entityId: 'arm' },
    { localX: 2, localY: 0, localZ: 0, size: 1, block: 1, color: 3, entityId: 'hand' },
  ], new THREE.Vector3(), new THREE.Scene(), {
    rootComponentId: 'root',
    rootComponentName: 'Robot',
    childEntities: [
      { id: 'arm', name: 'Arm Component', parentId: 'root' },
      { id: 'hand', name: 'Hand Component', parentId: 'arm' },
    ],
    constraints: [
      { id: 'joint1', type: 'point', bodyA: 'root', bodyB: 'arm' },
      { id: 'joint2', type: 'point', bodyA: 'arm', bodyB: 'hand' },
    ],
  });
}

test('SpaceUiStore deleteComponent deletes child component subtree and updates selectedComponentNodeId', () => {
  const entity = createTestEntity();
  (spaceUiStore as any).patch({
    editingContraption: entity,
    selectedComponentNodeId: 'hand',
    activeModal: 'code',
  });

  // 1. Delete leaf child 'hand'
  const result1 = spaceUiStore.deleteComponent('hand');
  assert.equal(result1, true);
  assert.equal(entity.entityNodes.has('hand'), false);
  assert.equal(entity.entityNodes.has('arm'), true);
  assert.equal(entity.entityNodes.has('root'), true);
  // selectedComponentNodeId was 'hand', so it should have fallen back to root
  assert.equal(spaceUiStore.getSnapshot().selectedComponentNodeId, 'root');

  // 2. Select 'arm' then delete 'arm' (which is parent of nothing now)
  (spaceUiStore as any).patch({ selectedComponentNodeId: 'arm' });
  const result2 = spaceUiStore.deleteComponent('arm');
  assert.equal(result2, true);
  assert.equal(entity.entityNodes.has('arm'), false);
  assert.equal(spaceUiStore.getSnapshot().selectedComponentNodeId, 'root');

  // 3. Attempt to delete root body -> rejected
  const resultRoot = spaceUiStore.deleteComponent('root');
  assert.equal(resultRoot, false);
  assert.equal(entity.entityNodes.has('root'), true);

  // 4. Attempt to delete non-existent component -> rejected
  const resultMissing = spaceUiStore.deleteComponent('missing_node');
  assert.equal(resultMissing, false);
});

test('SpaceUiStore deleteComponent rejects deletion on read-only serverManaged entities', () => {
  const entity = createTestEntity();
  entity.serverManaged = true;
  entity.serverCanEdit = false;

  (spaceUiStore as any).patch({
    editingContraption: entity,
    selectedComponentNodeId: 'arm',
    activeModal: 'code',
  });

  const result = spaceUiStore.deleteComponent('arm');
  assert.equal(result, false);
  assert.equal(entity.entityNodes.has('arm'), true);
});
