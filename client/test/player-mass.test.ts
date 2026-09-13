import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  PlayerPhysics,
  PLAYER_GRAVITY_MPS2,
  PLAYER_MASS_KG
} from '@entropydrop/space-engine/physics/PlayerPhysics.ts';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionPhysics } from '@entropydrop/space-engine/physics/ContraptionPhysics.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { PlayerController } from '../src/engine/controls/PlayerController.ts';

function makeWorld() {
  return {
    getBlock: () => BlockTypes.AIR,
    getMicroBlocksInAABB: () => [],
    raycast: () => ({ hit: false }),
    raycastMicro: () => ({ hit: false })
  } as any;
}

function makeContactFixture() {
  const world = makeWorld();
  const contraption = new Contraption(
    1,
    [{
      localX: 0,
      localY: 0,
      localZ: 0,
      size: 1,
      block: BlockTypes.COLOR_BLOCK,
      color: 0xffffff,
      entityId: 'root'
    }],
    new THREE.Vector3(),
    new THREE.Scene()
  );
  const physics = new ContraptionPhysics(world);
  const manager = { contraptions: [contraption], physics };
  const player = new PlayerPhysics(world, manager) as any;
  return { player, contraption, body: contraption.getRigidBody('root') };
}

test('PlayerPhysics has immutable 50kg mass and derives weight in newtons', () => {
  assert.equal(PLAYER_MASS_KG, 50);
  assert.equal(PLAYER_GRAVITY_MPS2, -24);

  const player = new PlayerPhysics(makeWorld());
  assert.equal(player.mass, 50);
  assert.equal(player.weight, 1200);

  // Attempting to modify mass should fail or throw in strict mode
  assert.throws(() => {
    (player as any).mass = 80;
  }, /Cannot assign to read only property|Cannot set property mass/);

  assert.throws(() => {
    (player as any).weight = 80;
  }, /Cannot set property weight|which has only a getter/);

  assert.equal(player.mass, 50);
  assert.equal(player.weight, 1200);

  const massDescriptor = Object.getOwnPropertyDescriptor(player, 'mass');
  assert.equal(massDescriptor?.writable, false);
  assert.equal(massDescriptor?.configurable, false);
  assert.equal(massDescriptor?.value, 50);

  const weightDescriptor = Object.getOwnPropertyDescriptor(PlayerPhysics.prototype, 'weight');
  assert.equal(typeof weightDescriptor?.get, 'function');
  assert.equal(weightDescriptor?.set, undefined);

  player.gravity = -9.81;
  assert.ok(Math.abs(player.weight - 490.5) < 1e-9, 'weight should follow the current gravity');
});

test('PlayerController exposes 50kg mass and weight in newtons', () => {
  const playerPhysics = new PlayerPhysics(makeWorld());
  const controller: any = Object.create(PlayerController.prototype);
  controller.physics = playerPhysics;

  assert.equal(controller.mass, 50);
  assert.equal(controller.weight, 1200);
});

test('a landing player transfers 50kg of downward momentum to a dynamic entity', () => {
  const { player, body } = makeContactFixture();
  player.position.set(0.5, 1.2, 0.5);
  player.velocity.set(0, -4, 0);

  player.moveWithCollision(0.1);

  assert.equal(player.position.y, 1);
  assert.equal(player.isOnGround, true);
  assert.ok(Math.abs(body.velocity.y - (-20)) < 1e-9,
    '50kg × 4m/s transfers a 200N·s downward impulse to the 10kg body');
});

test('horizontal character collision transfers momentum using the 50kg contact mass', () => {
  const { player, body } = makeContactFixture();
  player.position.set(-2, 0.1, 0.5);
  player.velocity.set(30, 0, 0);

  player.moveWithCollision(0.1);

  assert.equal(player.velocity.x, 0, 'the authoritative character controller still stops at the solid face');
  assert.ok(Math.abs(body.velocity.x * body.mass - player.mass * 30) < 1e-9,
    'the dynamic body should receive the character momentum removed by collision resolution');
});

test('a standing player continuously loads a dynamic platform with physical weight', () => {
  const { player, contraption, body } = makeContactFixture();
  player.position.set(0.5, 1, 0.5);
  player.velocity.set(0, 0, 0);
  player.isOnGround = true;
  player.ridingContraption = contraption;
  player.ridingBodyId = 'root';

  player.update(0.05, {
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    crouch: false,
    sprint: false
  }, 0);

  const expectedDeltaVelocity = -(player.weight * 0.05) / body.mass;
  assert.ok(Math.abs(body.velocity.y - expectedDeltaVelocity) < 1e-9,
    'ground contact should transfer weight × dt to the supporting body');
});

test('jumping applies the equal-and-opposite 50kg launch impulse to the platform', () => {
  const { player, contraption, body } = makeContactFixture();
  player.position.set(0.5, 1, 0.5);
  player.velocity.set(0, 0, 0);
  player.isOnGround = true;
  player.ridingContraption = contraption;
  player.ridingBodyId = 'root';

  player.update(0.05, {
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: true,
    crouch: false,
    sprint: false
  }, 0);

  assert.equal(player.velocity.y, player.jumpForce);
  assert.ok(body.velocity.y < 0, 'the dynamic platform should receive the downward jump reaction');
});
