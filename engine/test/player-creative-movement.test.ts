import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerPhysics } from '../src/physics/PlayerPhysics.ts';
import type { PlayerTerrain } from '../src/physics/PhysicsTerrain.ts';
import { Contraption } from '../src/contraption/Contraption.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';

function createPlayer(world?: PlayerTerrain) {
  const player = new PlayerPhysics(world ?? {
    getBlock: () => BlockTypes.AIR,
    getMicroBlocksInAABB: () => []
  });
  player.setInitialPosition(0, 0, 0);
  player.update(0.05, {}, 0);
  return player;
}

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `expected ${expected}, got ${actual}`);
}

test('quick jump taps survive a physics tick and pressing again in midair adds no impulse', () => {
  const player = createPlayer();
  player.update(0.05, { jump: false, jumpPressed: true }, 0);
  near(player.velocity.y, player.jumpForce);
  for (let tick = 0; tick < 5; tick++) {
    const previousY = player.velocity.y;
    player.update(0.05, { jump: true, jumpPressed: true }, 0);
    near(player.velocity.y, previousY + player.gravity * 0.05);
    near(player.position.x, 0);
    near(player.position.z, 0);
    assert.equal(player.isFlying, false);
  }
});

test('flight ascends, hovers and descends without gravity or a crouched collision box', () => {
  const player = createPlayer();
  player.position.y = 10;
  player.isFlying = true;
  player.update(0.05, { jump: true }, 0);
  near(player.position.y, 10 + player.flySpeed * 0.05);
  const hoverY = player.position.y;
  player.update(0.05, {}, 0);
  near(player.position.y, hoverY);
  near(player.velocity.length(), 0);
  player.update(0.05, { crouch: true }, 0);
  near(player.position.y, 10);
  assert.equal(player.isCrouching, false);
  player.update(0.05, { jump: true, crouch: true }, 0);
  near(player.position.y, 10);
  assert.equal(player.isFlying, true);
});

test('flight sprint boosts horizontal movement while vertical speed stays independent', () => {
  const player = createPlayer();
  player.position.y = 10;
  player.isFlying = true;
  player.isSprinting = true;
  player.update(0.05, { forward: true, jump: true }, -Math.PI / 2);
  near(player.velocity.x, player.flySpeed * 1.8);
  near(player.velocity.z, 0);
  near(player.velocity.y, player.flySpeed);
});

test('sneaking slows grounded movement even with sprint requested and restores normal height on release', () => {
  const player = createPlayer();
  player.isSprinting = true;
  for (let tick = 0; tick < 20; tick++) player.update(0.05, { forward: true, crouch: true }, 0);
  assert.equal(player.isCrouching, true);
  near(player.getAABB().maxY - player.position.y, 1.45);
  assert.ok(Math.abs(player.velocity.z) <= player.walkSpeed * 0.3);
  player.update(0.05, { forward: true }, 0);
  assert.equal(player.isCrouching, false);
  near(player.getAABB().maxY - player.position.y, player.height);
  assert.ok(Math.abs(player.velocity.z) > player.walkSpeed * 0.3);
});

test('descending onto the world boundary ends flight and a new grounded press can jump', () => {
  const player = createPlayer();
  player.position.y = 0.5;
  player.isFlying = true;
  player.update(0.1, { crouch: true }, 0);
  near(player.position.y, 0);
  assert.equal(player.isFlying, false);
  assert.equal(player.isOnGround, true);
  player.update(0.05, { jump: true }, 0);
  near(player.velocity.y, player.jumpForce);
});

for (const kind of ['voxel', 'micro', 'entity'] as const) {
  test(`fast flight stops at a ${kind} wall without tunnelling`, () => {
    const world: PlayerTerrain = {
      getBlock: (x, y, z) => kind === 'voxel' && x === 1 && y >= 0 && y < 6 && z === 0
        ? BlockTypes.COLOR_BLOCK : BlockTypes.AIR,
      getMicroBlocksInAABB: () => kind === 'micro'
        ? Array.from({ length: 48 }, (_, y) => ({ x: 1.125, y: y / 8, z: 0.5, size: 0.125,
          color: 0xffffff, materialId: 0, part: null, micro: true })) : []
    };
    const player = createPlayer(world);
    player.position.set(0, 2, 0.5625);
    const wall = kind === 'entity' ? new Contraption(1, [
      { localX: 0, localY: 0, localZ: 0, size: 4, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }
    ], new THREE.Vector3(1, 0, 0), new THREE.Scene()) : null;
    player.setContraptionManager({ contraptions: wall ? [wall] : [] });
    player.isFlying = true;
    player.isSprinting = true;
    for (let tick = 0; tick < 4; tick++) player.update(0.1, { forward: true }, -Math.PI / 2);
    near(player.position.x, (kind === 'micro' ? 1.125 : 1) - player.width / 2);
    near(player.velocity.x, 0);
    assert.equal(player.isFlying, true);
    wall?.dispose();
  });

  for (const vertical of [-1, 1]) {
    test(`${vertical > 0 ? 'ascending' : 'descending'} flight collides with a ${kind} surface`, () => {
      const player = createPlayer();
      const size = kind === 'voxel' ? 1 : 0.125;
      const surfaceY = 5;
      player.position.set(0.0625, vertical > 0 ? 2 : 8, 0.0625);
      player.world = {
        getBlock: (_x, y) => kind === 'voxel' && y === surfaceY ? BlockTypes.COLOR_BLOCK : BlockTypes.AIR,
        getMicroBlocksInAABB: () => kind === 'micro'
          ? [{ x: 0, y: surfaceY, z: 0, size, color: 0xffffff, materialId: 0, part: null, micro: true }] : []
      };
      const surface = kind === 'entity' ? new Contraption(1, [
        { localX: 0, localY: 0, localZ: 0, size, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }
      ], new THREE.Vector3(0, surfaceY, 0), new THREE.Scene()) : null;
      player.setContraptionManager({ contraptions: surface ? [surface] : [] });
      player.isFlying = true;
      for (let tick = 0; tick < 3; tick++) {
        player.update(0.1, { jump: vertical > 0, crouch: vertical < 0 }, 0);
      }
      near(player.position.y, vertical > 0 ? surfaceY - player.height : surfaceY + size);
      near(player.velocity.y, 0);
      assert.equal(player.isOnGround, vertical < 0);
      assert.equal(player.isFlying, vertical > 0);
      const stoppedY = player.position.y;
      player.beginRenderInterpolation(0.5);
      assert.ok(vertical > 0 ? player.position.y <= stoppedY : player.position.y >= stoppedY);
      player.endRenderInterpolation();
      near(player.position.y, stoppedY);
      surface?.dispose();
    });
  }
}
