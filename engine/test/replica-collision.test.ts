import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '../src/contraption/Contraption.ts';
import { PlayerPhysics } from '../src/physics/PlayerPhysics.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';

function setup() {
  const world = { getBlock: () => BlockTypes.AIR, getMicroBlocksInAABB: () => [] };
  const c = new Contraption(1, [0, 1].map(x => ({ localX: x, localY: 0, localZ: 0,
    size: 1, block: BlockTypes.COLOR_BLOCK, color: 0xffffff, entityId: 'root' })),
  new THREE.Vector3(), new THREE.Scene(), { rootComponentId: 'root' });
  c.serverManaged = true;
  c.serverExecutesLocally = false;
  c.setPhysicsSimulationEnabled(false);
  const player = new PlayerPhysics(world, { contraptions: [c] }) as any;
  const pose = (x: number, angle = 0) => [{ id: 'root', position: [x, c.position.y, c.position.z],
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle).toArray() }];
  return { c, player, world, pose };
}

test('replica pose preserves authored dynamic bodies, never simulates code/forces, and retains swept history', () => {
  const { c, pose, world } = setup();
  c.setScript('self.setState({ran:true}); self.applyForce([0,1000,0]);');
  c.scriptStatus = 'running';
  const before = c.position.clone();
  c.applyReplicaBodyPoses(pose(before.x + 0.2), 0.05);
  assert.equal(c.getRigidBody('root')!.type, 'dynamic');
  assert.equal(c.isPhysicsSimulationEnabled(), false);
  assert.ok(c.previousPosition.equals(before));
  assert.ok(Math.abs(c.velocity.x - 4) < 1e-9);
  c.update(0.05);
  assert.ok(c.previousPosition.equals(before), 'manager update must not erase network sweep history');
  assert.equal(c.getComponentState('root').ran, undefined);
  assert.equal(c.appliedForces.lengthSq(), 0);
  const current = c.position.clone();
  new ContraptionPhysics(world).update(c, 0.05);
  assert.ok(c.position.equals(current));
  c.applyReplicaBodyPoses(pose(current.x), 0.05);
  assert.equal(c.velocity.lengthSq(), 0, 'stalled stream stops contact motion');
});

test('a player stays on a translating and rotating two-voxel replica through its local contact frame', () => {
  const { c, player, pose } = setup();
  player.position.set(0.5, 1, 0.5);
  player.isOnGround = true;
  player.ridingContraption = c;
  player.ridingBodyId = 'root';
  player.captureRidingPlatformPose();
  const oldMatrix = c.rootGroup.matrixWorld.clone();
  const oldPosition = player.position.clone();
  c.applyReplicaBodyPoses(pose(c.position.x + 0.1, 0.1), 0.05);
  const expected = oldPosition.applyMatrix4(oldMatrix.invert()).applyMatrix4(c.rootGroup.matrixWorld);
  player.followRidingPlatformPose();
  assert.ok(player.position.distanceTo(expected) < 1e-8);
  assert.ok(c.angularVelocity.y > 1.9 && c.angularVelocity.y < 2.1);
});

test('an authoritative local executor cannot be moved by received replica poses', () => {
  const { c, pose } = setup();
  c.serverExecutesLocally = true;
  const before = c.position.clone();
  assert.equal(c.applyReplicaBodyPoses(pose(100), 0.05), false);
  assert.ok(c.position.equals(before));
});

test('kinematic child poses project into collision/seat transforms without running their code', () => {
  const { c } = setup();
  c.createChildEntity('root', new Set(['1,0,0']), 'arm');
  const body = c.getRigidBody('arm')!;
  assert.equal(body.type, 'kinematic');
  const target = body.position.clone().add(new THREE.Vector3(0, 0.25, 0));
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.3);
  c.applyReplicaBodyPoses([{
    id: 'arm', position: target.toArray(), quaternion: rotation.toArray(), collisionEnabled: true,
  }], 0.05);
  const node = c.entityNodes.get('arm')!;
  const actual = node.group.getWorldPosition(new THREE.Vector3())
    .add(body.centerOfMassLocal.clone().applyQuaternion(rotation));
  assert.ok(actual.distanceTo(target) < 1e-8);
  assert.ok(node.group.getWorldQuaternion(new THREE.Quaternion()).angleTo(rotation) < 1e-7);
  assert.equal(body.simulationEnabled, false);
  c.applyReplicaBodyPoses([{
    id: 'arm', position: target.toArray(), quaternion: rotation.toArray(), collisionEnabled: false,
  }], 0.05);
  assert.equal(c.getNodeCollisionEnabled('arm'), false);
});

test('a replica teleport clears world-spanning swept history and contact velocity', () => {
  const { c, pose } = setup();
  c.applyReplicaBodyPoses(pose(1e6), 0.05);
  assert.ok(c.previousPosition.equals(c.position));
  assert.equal(c.velocity.lengthSq(), 0);
});
