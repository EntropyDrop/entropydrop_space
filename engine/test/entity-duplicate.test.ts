import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Contraption, ContraptionMode } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';

test('duplicate preserves the whole rotated hierarchy beside the source, with independent data and identity', t => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, null, null, null);
  const source = new Contraption(1, [
    { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, color: 0x123456, entityId: 'world' },
    { localX: 2, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, materialId: 1, entityId: 'arm' },
    { localX: 3, localY: 0, localZ: 0, size: 0.125, block: BlockTypes.COLOR_BLOCK, color: 0xabcdef, entityId: 'hand' }
  ], new THREE.Vector3(10, 20, 30), scene, {
    rootComponentId: 'world', rootComponentName: 'Walker', mode: ContraptionMode.PROGRAMMABLE,
    bodyType: 'kinematic', mass: 12, friction: 0.4, useGravity: false,
    localCenter: [0.25, 0.5, 0.75], rootPivotOverride: [0.25, 0.5, 0.75],
    seats: [{ position: [0, 1, 0], rotation: [0, 0, 0, 1] }],
    decorations: [{ id: 'panel', position: [0, 0, 8], scale: [3, 2, 1], color: 0xff0000 }],
    childEntities: [
      { id: 'arm', parentId: 'world', name: 'Arm', bodyType: 'dynamic', mass: 7 },
      { id: 'hand', parentId: 'arm', bodyType: 'kinematic', collisionEnabled: false,
        decorations: [{ id: 'finger', scale: [0.5, 1, 0.5], color: 0x00ff00 }] }
    ],
    constraints: [
      { id: 'joint', type: 'hinge', bodyA: 'world', bodyB: 'arm', limits: { min: -30, max: 30 } },
      { id: 'anchor', type: 'point', bodyA: null, bodyB: 'world', anchorA: [10, 22, 30] }
    ]
  });
  manager.registerContraption(source);
  t.after(() => { for (const entity of manager.contraptions) entity.dispose(); });
  source.setNodeScript('world', 'self.state.setNumber("ticks", 1);');
  source.setNodeScript('hand', 'self.state.setNumber("ticks", 2);');
  source.setNodeScriptEnabled('hand', false);
  source.quaternion.setFromEuler(new THREE.Euler(0.2, Math.PI / 3, -0.1));
  source.updateTransform();
  const arm = source.getRigidBody('arm')!;
  arm.position.add(new THREE.Vector3(1, 2, 3));
  arm.quaternion.setFromEuler(new THREE.Euler(0.4, 0.6, 0.2));
  source.syncAllBodyTransforms();
  source.velocity.set(2, 3, 4);
  source.scriptStatus = 'running';
  source.getComponentState('world').ticks = 42;
  Object.assign(source, { serverManaged: true, serverCanEdit: true, serverCanControl: true,
    serverOwnerUserId: 'owner', serverExecutionMode: 'hosted', serverRevision: 12,
    serverDesiredRunState: 'running' });
  const originalDefinition = structuredClone(source.serializeSubtree());
  const originalBounds = source.getVisualWorldBounds();
  const originalPositions = source.blocks.map(block => source.getBlockWorldCenter(block));
  let saves = 0;
  manager.saveEntitiesToStorage = () => { saves++; return true; };

  const copy = manager.duplicateContraption(source)!;
  assert.ok(copy);
  assert.equal(manager.contraptions.length, 2);
  assert.equal(saves, 1);
  assert.notEqual(copy.id, source.id);
  assert.notEqual(copy.publicId, source.publicId);
  assert.notEqual(copy.serverManaged, true);
  assert.notEqual(copy.serverExecutionMode, 'hosted');
  assert.notEqual(copy.serverOwnerUserId, source.serverOwnerUserId);
  assert.equal(copy.scriptStatus, 'stopped');
  assert.equal(copy.isPhysicsSimulationEnabled(), false);
  assert.deepEqual(copy.getComponentState('world'), {});
  assert.equal(copy.mode, source.mode);
  assert.equal(copy.mass, 12);
  assert.equal(copy.getRigidBody('arm')!.mass, 7);
  assert.deepEqual(copy.localCenter, source.localCenter);
  assert.deepEqual(copy.rootPivotOverride, source.rootPivotOverride);
  assert.ok(copy.quaternion.angleTo(source.quaternion) < 1e-7);
  assert.deepEqual([...copy.entityNodes.keys()], [...source.entityNodes.keys()]);
  const copiedDefinition = copy.serializeSubtree()!;
  for (const field of ['name', 'blocks', 'childEntities', 'scripts', 'enabled', 'seats', 'decorations'] as const) {
    assert.deepEqual(copiedDefinition[field], originalDefinition![field], field);
  }
  const offset = copy.position.clone().sub(source.position);
  assert.equal(offset.y, 0);
  assert.equal(offset.z, 0);
  assert.ok(Math.abs(copy.getVisualWorldBounds().min.x - originalBounds.max.x - 1) < 1e-7);
  copy.blocks.forEach((block, index) => {
    assert.ok(copy.getBlockWorldCenter(block).distanceTo(originalPositions[index].clone().add(offset)) < 1e-7);
  });
  for (const body of copy.getRigidBodies()) {
    assert.equal(body.velocity.lengthSq(), 0);
    assert.equal(body.angularVelocity.lengthSq(), 0);
  }
  const originalAnchor = source.constraintDefinitions.get('anchor')!;
  const copiedAnchor = copy.constraintDefinitions.get('anchor')!;
  assert.deepEqual(copiedAnchor.anchorA, new THREE.Vector3().fromArray(originalAnchor.anchorA).add(offset).toArray());
  assert.deepEqual(copy.constraintDefinitions.get('joint'), source.constraintDefinitions.get('joint'));
  copiedAnchor.anchorA[0] += 100;
  copy.constraintDefinitions.get('joint')!.limits!.min = -90;
  copy.blocks[0].color = 0;
  copy.decorations[0].position![0] = 100;
  copy.setNodeScript('world', '');
  assert.deepEqual(source.serializeSubtree(), originalDefinition);
  assert.equal(source.scriptStatus, 'running');
  assert.equal(source.isPhysicsSimulationEnabled(), true);
  assert.deepEqual(source.velocity.toArray(), [2, 3, 4]);
  assert.equal(source.getComponentState('world').ticks, 42);
});

test('duplicate rejects missing or empty entities without registering or saving a copy', t => {
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null);
  const empty = new Contraption(1, [], new THREE.Vector3(), manager.scene);
  t.after(() => empty.dispose());
  manager.saveEntitiesToStorage = () => assert.fail('failed duplication must not save');
  assert.equal(manager.duplicateContraption(empty), null);
  manager.registerContraption(empty);
  assert.equal(manager.duplicateContraption(empty), null);
  assert.deepEqual(manager.contraptions, [empty]);
});
