import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BodyType, Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { worldStub, requireValue } from './fixtures.ts';

function makeEntity(children = false) {
  return new Contraption('cached', [
    { localX: 0, localY: 0, localZ: 0, block: 1, entityId: 'root' },
    { localX: 2, localY: 0, localZ: 0, block: 1, entityId: children ? 'arm' : 'root' },
  ], new THREE.Vector3(0, 30, 0), new THREE.Scene(), {
    bodyType: BodyType.KINEMATIC,
    childEntities: children ? [{ id: 'arm', parentId: 'root', bodyType: BodyType.DYNAMIC, blockKeys: [[2, 0, 0]] }] : [],
  });
}

test('component bounds remain immutable through movement and update on geometry and ownership edits', () => {
  const entity = makeEntity();
  try {
    const bounds = requireValue(entity.getNodeBlocksBounds('root'));
    assert.deepEqual(bounds.size, [3, 1, 1]);
    assert.throws(() => { (bounds.min as number[])[0] = 100; }, TypeError);
    entity.position.x += 10;
    entity.updateTransform();
    assert.equal(entity.getNodeBlocksBounds('root'), bounds);
    entity.createChildEntity('root', new Set(['2,0,0']), 'arm');
    assert.deepEqual(entity.getNodeBlocksBounds('root')?.size, [1, 1, 1]);
    assert.deepEqual(entity.getNodeBlocksBounds('arm')?.min, [2, 0, 0]);
    entity.renameChildEntity('arm', 'renamed');
    assert.equal(entity.getNodeBlocksBounds('arm'), null);
    assert.deepEqual(entity.getNodeBlocksBounds('renamed')?.max, [3, 1, 1]);
    entity.removeComponentSubtree('renamed');
    assert.equal(entity.getNodeBlocksBounds('renamed'), null);
    const micro = { localX: -1, localY: 0, localZ: 0, size: .125, block: 1, entityId: 'root' };
    entity.blocks.push(micro);
    entity.rebuildAfterBlockChange('place', 'root', null, { added: [micro], removed: [] });
    assert.deepEqual(entity.getNodeBlocksBounds('root')?.min, [-1, 0, 0]);
    const removed = [...entity.blocks];
    entity.blocks = [];
    entity.rebuildAfterBlockChange('remove', 'root', null, { added: [], removed });
    assert.equal(entity.getNodeBlocksBounds('root'), null);
  } finally { entity.dispose(); }
});

test('collision caches settle swept history once after movement and survive stationary ticks and rendering', () => {
  const entity = makeEntity();
  try {
    entity.capturePreviousEntityTransforms();
    const before = entity.getPhysicsCollisionWorldAABBs();
    entity.position.x += 2;
    entity.updateTransform();
    const moving = entity.getPhysicsCollisionWorldAABBs();
    assert.notEqual(moving, before);
    assert.equal(moving[0].previousMinX, before[0].currentMinX);
    assert.equal(moving[0].currentMinX, before[0].currentMinX + 2);
    entity.beginRenderInterpolation(.25);
    entity.endRenderInterpolation();
    entity.updateTransform();
    assert.equal(entity.getPhysicsCollisionWorldAABBs(), moving);
    entity.capturePreviousEntityTransforms();
    const settled = entity.getPhysicsCollisionWorldAABBs();
    assert.notEqual(settled, moving);
    assert.equal(settled[0].previousMinX, settled[0].currentMinX);
    const samples = entity.getCollisionSamplePoints('root', true);
    for (let i = 0; i < 5; i++) entity.update(.05, null);
    assert.equal(entity.getPhysicsCollisionWorldAABBs(), settled);
    assert.equal(entity.getCollisionSamplePoints('root', true), samples);
    entity.setNodeCollisionEnabled('root', false);
    assert.equal(entity.getPhysicsCollisionWorldAABBs().length, 0);
    entity.setNodeCollisionEnabled('root', true);
    assert.notEqual(entity.getPhysicsCollisionWorldAABBs(), settled);
  } finally { entity.dispose(); }
});

test('projecting a dynamic child invalidates collision boxes even with a stationary root', () => {
  const entity = makeEntity(true);
  try {
    const before = entity.getPhysicsCollisionWorldAABBs();
    const arm = requireValue(entity.getRigidBody('arm'));
    arm.position.x += .5;
    entity.syncAllBodyTransforms();
    const after = entity.getPhysicsCollisionWorldAABBs();
    assert.notEqual(after, before);
    assert.equal(requireValue(after.find(box => box.entityId === 'arm')).currentMinX,
      requireValue(before.find(box => box.entityId === 'arm')).currentMinX + .5);
    assert.equal(requireValue(after.find(box => box.entityId === 'root')).currentMinX,
      requireValue(before.find(box => box.entityId === 'root')).currentMinX);
  } finally { entity.dispose(); }
});

test('body type changes refresh which stationary child samples belong to the parent', () => {
  const entity = makeEntity(true);
  try {
    const detached = entity.getCollisionSamplePoints('root', true);
    entity.setNodeBodyType('arm', BodyType.KINEMATIC, { runtimeOnly: true });
    entity.updateTransform();
    const attached = entity.getCollisionSamplePoints('root', true);
    assert.notEqual(attached, detached);
    assert.equal(attached.length, detached.length * 2);
    entity.setNodeBodyType('arm', BodyType.DYNAMIC, { runtimeOnly: true });
    entity.updateTransform();
    assert.equal(entity.getCollisionSamplePoints('root', true).length, detached.length);
  } finally { entity.dispose(); }
});

test('complex sleeping and stopped entities retain transformed collision boxes until edited or woken', () => {
  for (const stopped of [false, true]) {
    const world = worldStub({ terrainVersion: 0, getBlock: () => 0, getMicroBlocksInAABB: () => [],
      raycast: () => ({ hit: false }), raycastMicro: () => ({ hit: false }) });
    const scene = new THREE.Scene(), manager = new ContraptionManager(scene, world, null, null);
    const physics = new ContraptionPhysics(world);
    manager.setPhysics(physics);
    manager.entityPersistenceMode = 'none';
    const entity = new Contraption('sleep-cache', Array.from({ length: 100 }, (_, i) => ({
      localX: i % 10 * 2, localY: 0, localZ: Math.floor(i / 10) * 2, block: 1, entityId: 'root',
    })), new THREE.Vector3(0, 30, 0), scene);
    entity.useGravity = false;
    if (stopped) entity.setPhysicsSimulationEnabled(false);
    manager.registerContraption(entity);
    try {
      for (let i = 0; i < 40; i++) manager.update(.05, null);
      assert.equal(physics.isSleeping(entity), !stopped);
      const cached = entity.getPhysicsCollisionWorldAABBs();
      assert.equal(cached.length, 100);
      for (let i = 0; i < 10; i++) manager.update(.05, null);
      assert.equal(entity.getPhysicsCollisionWorldAABBs(), cached);
      const removed = entity.blocks.pop()!;
      entity.rebuildAfterBlockChange('remove', 'root', null, { added: [], removed: [removed] });
      assert.equal(entity.getPhysicsCollisionWorldAABBs().length, 99);
      entity.position.x += 1;
      entity.updateTransform();
      manager.update(.05, null);
      assert.equal(physics.isSleeping(entity), false);
      assert.notEqual(entity.getPhysicsCollisionWorldAABBs(), cached);
    } finally { entity.dispose(); }
  }
});
