import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerPhysics, PLAYER_AIR_DASH_DISTANCE, PLAYER_AIR_DASH_DURATION } from '../src/physics/PlayerPhysics.ts';
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

function firstJump(player: PlayerPhysics, yaw = 0) {
  player.update(0.05, { jump: true }, yaw);
  assert.equal(player.isOnGround, false);
  assert.equal(player.velocity.y, player.jumpForce);
  assert.equal(player.isDashing, false);
  player.update(0.05, { jump: false }, yaw);
}

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `expected ${expected}, got ${actual}`);
}

test('second jump travels exactly 5 m along the locked camera heading at different tick rates', () => {
  for (const dt of [1 / 120, 1 / 60, 0.05, 0.073, 0.1]) {
    for (const yaw of [0, Math.PI / 2, Math.PI, Math.PI / 4]) {
      const player = createPlayer();
      firstJump(player, yaw);
      const start = player.position.clone();
      // Even sprinting/strafe input cannot lengthen or steer the dash.
      player.isSprinting = true;
      player.update(dt, { jump: true, right: true }, yaw);
      near(player.velocity.y, 0);
      for (let frame = 0; player.isDashing && frame < 100; frame++) {
        player.update(dt, { right: true }, yaw + Math.PI);
      }
      assert.equal(player.isDashing, false);
      near(player.position.y, start.y);
      near(player.position.x - start.x, -Math.sin(yaw) * PLAYER_AIR_DASH_DISTANCE);
      near(player.position.z - start.z, -Math.cos(yaw) * PLAYER_AIR_DASH_DISTANCE);
      player.update(0.05, {}, yaw);
      near(player.position.x - start.x, -Math.sin(yaw) * PLAYER_AIR_DASH_DISTANCE);
      near(player.position.z - start.z, -Math.cos(yaw) * PLAYER_AIR_DASH_DISTANCE);
    }
  }
});

test('pitched dashes follow a locked 3D ray for exactly 5 m, then gravity resumes', () => {
  for (const dt of [1 / 120, 1 / 60, 0.05, 0.073, 0.1]) {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 4]) {
      for (const pitch of [-Math.PI / 2, -Math.PI / 4, 0, Math.PI / 4, Math.PI / 2]) {
        const player = createPlayer();
        firstJump(player);
        player.position.y += 10;
        const start = player.position.clone();
        const direction = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
        // Non-unit camera vectors must not change the distance.
        const gaze = direction.clone().multiplyScalar(3);
        player.update(dt, { jump: true }, yaw, gaze);
        gaze.negate(); // Later camera changes cannot steer an active dash.
        for (let frame = 0; player.isDashing && frame < 100; frame++) {
          const displacement = player.position.clone().sub(start);
          near(displacement.clone().cross(direction).length(), 0);
          player.update(dt, {}, yaw + Math.PI, gaze);
        }
        const displacement = player.position.clone().sub(start);
        near(displacement.length(), PLAYER_AIR_DASH_DISTANCE);
        near(displacement.distanceTo(direction.clone().multiplyScalar(PLAYER_AIR_DASH_DISTANCE)), 0);
        near(player.velocity.length(), 0);
        player.update(0.05, {}, yaw, gaze);
        assert.ok(player.velocity.y < 0, 'gravity must resume after the dash');
      }
    }
  }
});

test('dash eases in and out over 0.4 seconds without an instantaneous teleport', () => {
  const player = createPlayer();
  firstJump(player);
  const distances: number[] = [];
  for (let frame = 0; frame < 8; frame++) {
    const before = player.position.z;
    player.update(0.05, { jump: frame === 0 }, 0);
    distances.push(before - player.position.z);
  }
  near(distances.reduce((sum, value) => sum + value, 0), PLAYER_AIR_DASH_DISTANCE);
  near(8 * 0.05, PLAYER_AIR_DASH_DURATION);
  assert.ok(distances[0] > 0 && distances[0] < distances[1]);
  assert.ok(distances[1] < distances[2] && distances[2] < distances[3]);
  for (let i = 0; i < 4; i++) near(distances[i], distances[7 - i]);
  assert.equal(player.isDashing, false);
  near(player.velocity.z, 0);
});

test('holding the second jump cruises continuously across tick rates and eases out on release', () => {
  const peakSpeed = 1.5 * PLAYER_AIR_DASH_DISTANCE / PLAYER_AIR_DASH_DURATION;
  for (const dt of [1 / 120, 1 / 60, 0.05, 0.073, 0.1]) {
    const player = createPlayer();
    firstJump(player);
    const start = player.position.clone();
    let time = 0;
    while (time < 2 - 1e-9) {
      const step = Math.min(dt, 2 - time);
      player.update(step, { jump: true }, 0);
      time += step;
      assert.equal(player.isDashing, true);
      near(player.position.y, start.y);
      if (time - step >= 0.2) {
        near(player.velocity.length(), peakSpeed);
        near(player.dashIntensity, 1);
      }
    }
    near(start.z - player.position.z, 2.5 + 1.8 * peakSpeed);
    const releaseZ = player.position.z;
    let previousSpeed = peakSpeed;
    for (let frame = 0; frame < 4; frame++) {
      player.update(0.05, {}, 0);
      assert.ok(player.velocity.length() < previousSpeed, 'release decelerates without a speed spike');
      previousSpeed = player.velocity.length();
    }
    assert.equal(player.isDashing, false);
    near(releaseZ - player.position.z, 2.5);
    near(player.dashIntensity, 0);
    player.update(0.05, {}, 0);
    assert.ok(player.velocity.y < 0);
  }
});

test('a sustained dash steers smoothly toward the live 3D gaze, including opposite turns', () => {
  const player = createPlayer();
  firstJump(player);
  player.position.y = 20;
  for (let frame = 0; frame < 8; frame++) player.update(0.05, { jump: true }, 0);
  const speed = player.velocity.length();
  for (const direction of [new THREE.Vector3(1, 1, 0).normalize(), new THREE.Vector3(-1, -1, 0).normalize()]) {
    const previous = player.velocity.clone().normalize();
    player.update(0.05, { jump: true }, 0, direction);
    const turned = player.velocity.clone().normalize();
    assert.ok(turned.dot(direction) > previous.dot(direction));
    assert.ok(turned.distanceTo(direction) > 0.1, 'turning must not snap instantly to the aim');
    for (let frame = 0; frame < 30; frame++) {
      player.update(0.05, { jump: true }, 0, direction);
      near(player.velocity.length(), speed);
      assert.equal(player.isDashing, true);
      near(player.dashIntensity, 1);
    }
    assert.ok(player.velocity.clone().normalize().dot(direction) > 0.999999);
  }
});

test('a release cannot be undone by another press before landing', () => {
  const player = createPlayer();
  firstJump(player);
  for (let frame = 0; frame < 20; frame++) player.update(0.05, { jump: true }, 0);
  // A fresh press while still held means keyup and keydown both occurred
  // between ticks. It must end, rather than replenish, the sustained dash.
  player.update(0.05, { jump: true, jumpPressed: true }, 0);
  for (let frame = 0; frame < 3; frame++) player.update(0.05, { jump: true }, 0);
  assert.equal(player.isDashing, false);
  near(player.velocity.length(), 0);
  player.update(0.05, { jump: true }, 0);
  assert.equal(player.isDashing, false);
  assert.ok(player.velocity.y < 0);
});

test('render interpolation remains smooth when a tick crosses into sustained cruising', () => {
  const player = createPlayer();
  firstJump(player);
  const start = player.position.clone();
  const dt = 0.073;
  const peakSpeed = 18.75;
  for (let frame = 0; frame < 8; frame++) {
    player.update(dt, { jump: true }, 0);
    const simulation = player.position.clone();
    for (const alpha of [0, 0.25, 0.5, 0.75, 1]) {
      player.beginRenderInterpolation(alpha);
      const seconds = (frame + alpha) * dt;
      const t = Math.min(0.5, seconds / PLAYER_AIR_DASH_DURATION);
      const distance = 5 * t * t * (3 - 2 * t) + Math.max(0, seconds - 0.2) * peakSpeed;
      near(start.z - player.position.z, distance);
      near(player.dashIntensity, Math.sin(Math.PI * t) ** 2);
      player.endRenderInterpolation();
      near(player.position.distanceTo(simulation), 0);
    }
  }
});

test('running through a dash preserves forward speed at both ends and still travels 5 m', () => {
  const player = createPlayer();
  firstJump(player);
  player.velocity.z = -player.walkSpeed;
  const start = player.position.z;
  player.update(0.05, { jump: true, forward: true }, 0);
  assert.ok(-player.velocity.z >= player.walkSpeed, 'takeoff must not first brake the walking player');
  for (let frame = 1; frame < 8; frame++) player.update(0.05, { forward: true }, 0);
  near(start - player.position.z, 5);
  near(player.velocity.z, -player.walkSpeed);
  player.update(0.05, { forward: true }, 0);
  near(start - player.position.z, 5 + player.walkSpeed * 0.05);
});

test('rendered dash samples follow the smooth curve between physics ticks and restore exact physics', () => {
  const player = createPlayer();
  firstJump(player);
  const start = player.position.z;
  for (let frame = 0; frame < 8; frame++) {
    player.update(0.05, { jump: frame === 0 }, 0);
    const simulation = player.position.clone();
    for (const alpha of [0, 0.25, 0.5, 0.75, 1]) {
      player.beginRenderInterpolation(alpha);
      const t = (frame + alpha) / 8;
      near(start - player.position.z, 5 * t * t * (3 - 2 * t));
      near(player.dashIntensity, Math.sin(Math.PI * t) ** 2);
      player.endRenderInterpolation();
      assert.deepEqual(player.position.toArray(), simulation.toArray());
    }
  }
  assert.equal(player.dashIntensity, 0);
});

test('pitched dash rendering eases all three axes along the same ray', () => {
  const player = createPlayer();
  firstJump(player);
  player.velocity.set(0, 0, 0);
  const start = player.position.clone();
  const direction = new THREE.Vector3(1, 1, -1).normalize();
  for (let frame = 0; frame < 8; frame++) {
    player.update(0.05, { jump: frame === 0 }, 0, direction);
    const simulation = player.position.clone();
    for (const alpha of [0, 0.25, 0.5, 0.75, 1]) {
      player.beginRenderInterpolation(alpha);
      const t = (frame + alpha) / 8;
      const expected = start.clone().addScaledVector(direction, 5 * t * t * (3 - 2 * t));
      near(player.position.distanceTo(expected), 0);
      player.endRenderInterpolation();
      near(player.position.distanceTo(simulation), 0);
    }
  }
});

test('a blocked dash never interpolates through its collision stop', () => {
  const player = createPlayer({
    getBlock: (x, y, z) => x === 0 && z === -2 && y < 6 ? BlockTypes.COLOR_BLOCK : BlockTypes.AIR,
    getMicroBlocksInAABB: () => []
  });
  player.position.x = 0.5;
  firstJump(player);
  player.update(0.1, { jump: true }, 0);
  assert.equal(player.isDashing, false);
  for (const alpha of [0.25, 0.5, 0.75, 1]) {
    player.beginRenderInterpolation(alpha);
    assert.ok(player.position.z >= -0.7);
    assert.equal(player.dashIntensity, 0);
    player.endRenderInterpolation();
  }
});

test('holding Space neither spends the second jump nor auto-jumps after landing', () => {
  const player = createPlayer();
  for (let frame = 0; frame < 40; frame++) player.update(0.05, { jump: true }, 0);
  assert.equal(player.isOnGround, true);
  near(player.position.z, 0);
  near(player.position.y, 0);
  player.update(0.05, {}, 0);
  player.update(0.05, { jump: true }, 0);
  assert.equal(player.velocity.y, player.jumpForce);
});

test('a third press is ignored and landing restores the second jump', () => {
  const player = createPlayer();
  firstJump(player);
  player.update(0.05, { jump: true }, 0);
  player.update(0.05, {}, 0);
  const previousSpeed = player.velocity.length();
  player.update(0.05, { jump: true }, 0);
  assert.ok(player.velocity.length() > previousSpeed, 'a third press must not restart the easing');
  for (let frame = 0; !player.isOnGround && frame < 80; frame++) player.update(0.05, {}, 0);
  assert.equal(player.isOnGround, true);
  near(player.position.z, -5);
  firstJump(player);
  player.update(0.05, { jump: true }, 0);
  assert.equal(player.isDashing, true);
});

test('a latched quick tap works even if held input did not change between physics ticks', () => {
  const player = createPlayer();
  player.update(0.05, { jump: true, jumpPressed: true }, 0);
  player.update(0.05, { jump: true, jumpPressed: true }, 0);
  assert.equal(player.isDashing, true);
  const previousSpeed = player.velocity.length();
  player.update(0.05, { jump: true, jumpPressed: false }, 0);
  assert.ok(player.velocity.length() > previousSpeed, 'held input must not restart the easing');
});

test('a tap released before the first tick still initiates a jump', () => {
  const player = createPlayer();
  player.update(0.05, { jump: false, jumpPressed: true }, 0);
  assert.equal(player.velocity.y, player.jumpForce);
  assert.equal(player.isOnGround, false);
});

for (const kind of ['voxel', 'micro', 'entity'] as const) {
  test(`dash stops at a ${kind} wall without tunnelling or resuming after it disappears`, () => {
    let wallPresent = true;
    const world: PlayerTerrain = {
      getBlock: (x, y, z) => kind === 'voxel' && wallPresent && x === 1 && y >= 0 && y < 6 && z === 0
        ? BlockTypes.COLOR_BLOCK : BlockTypes.AIR,
      getMicroBlocksInAABB: () => kind === 'micro' && wallPresent
        ? Array.from({ length: 48 }, (_, y) => ({ x: 1.125, y: y / 8, z: 0.5, size: 0.125,
          color: 0xffffff, materialId: 0, part: null, micro: true }))
        : []
    };
    const player = createPlayer(world);
    player.position.z = 0.5625;
    const wall = kind === 'entity' ? new Contraption(1, [
      { localX: 0, localY: 0, localZ: 0, size: 4, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }
    ], new THREE.Vector3(1, 0, 0), new THREE.Scene()) : null;
    const manager = { contraptions: wall ? [wall] : [] };
    player.setContraptionManager(manager);
    firstJump(player, -Math.PI / 2);
    for (let frame = 0; frame < 4; frame++) player.update(0.1, { jump: true }, -Math.PI / 2);
    near(player.position.x, (kind === 'micro' ? 1.125 : 1) - player.width / 2);
    assert.equal(player.isDashing, false);
    const stoppedX = player.position.x;
    wallPresent = false;
    manager.contraptions = [];
    player.update(0.05, { jump: true }, 0);
    near(player.position.x, stoppedX);
    wall?.dispose();
  });
}

test('teleporting cancels an unfinished dash and flight keeps held-Space ascent', () => {
  const player = createPlayer();
  firstJump(player);
  player.update(0.05, { jump: true }, 0);
  player.setInitialPosition(10, 10, 10);
  player.update(0.05, {}, 0);
  near(player.position.z, 10);
  assert.equal(player.isDashing, false);
  player.isFlying = true;
  for (let frame = 0; frame < 3; frame++) player.update(0.05, { jump: true }, 0);
  assert.equal(player.velocity.y, player.flySpeed);
  player.isFlying = false;
  player.update(0.05, { jump: true }, 0);
  assert.equal(player.isDashing, false);
  near(player.position.z, 10);
});

test('landing on an elevated surface interrupts a dash', () => {
  const player = createPlayer();
  firstJump(player);
  player.world = {
    getBlock: (_x, y) => y === 1 ? BlockTypes.COLOR_BLOCK : BlockTypes.AIR,
    getMicroBlocksInAABB: () => []
  };
  player.position.y = 2.01;
  player.update(0.05, { jump: true }, 0, new THREE.Vector3(0, -1, -1));
  assert.equal(player.isOnGround, true);
  assert.equal(player.isDashing, false);
  near(player.position.y, 2);
  const stoppedZ = player.position.z;
  player.update(0.05, {}, 0);
  near(player.position.z, stoppedZ);
});

for (const kind of ['voxel', 'micro', 'entity'] as const) {
  for (const vertical of [-1, 1]) {
    test(`${vertical > 0 ? 'upward' : 'downward'} dash stops at a ${kind} surface and stays cancelled`, () => {
      const player = createPlayer();
      firstJump(player);
      const size = kind === 'voxel' ? 1 : 0.125;
      const surfaceY = 5;
      player.position.set(0.0625, vertical > 0 ? 2 : 8, 0.0625);
      player.world = {
        getBlock: (_x, y) => kind === 'voxel' && y === surfaceY ? BlockTypes.COLOR_BLOCK : BlockTypes.AIR,
        getMicroBlocksInAABB: () => kind === 'micro'
          ? [{ x: 0, y: surfaceY, z: 0, size, color: 0xffffff, materialId: 0, part: null, micro: true }]
          : []
      };
      const surface = kind === 'entity' ? new Contraption(1, [
        { localX: 0, localY: 0, localZ: 0, size, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }
      ], new THREE.Vector3(0, surfaceY, 0), new THREE.Scene()) : null;
      player.setContraptionManager({ contraptions: surface ? [surface] : [] });
      player.update(0.1, { jump: true }, 0, new THREE.Vector3(0, vertical, 0));
      for (let frame = 0; player.isDashing && frame < 4; frame++) {
        player.update(0.1, { jump: true }, 0, new THREE.Vector3(0, vertical, 0));
      }
      assert.equal(player.isDashing, false);
      assert.equal(player.isOnGround, vertical < 0);
      const stoppedY = vertical > 0 ? surfaceY - player.height : surfaceY + size;
      near(player.position.y, stoppedY);
      near(player.velocity.length(), 0);
      for (const alpha of [0, 0.25, 0.5, 0.75, 1]) {
        player.beginRenderInterpolation(alpha);
        assert.ok(vertical > 0 ? player.position.y <= stoppedY : player.position.y >= stoppedY);
        player.endRenderInterpolation();
      }
      player.world = { getBlock: () => BlockTypes.AIR, getMicroBlocksInAABB: () => [] };
      player.setContraptionManager(null);
      player.update(0.05, {}, 0);
      assert.equal(player.isDashing, false);
      near(player.velocity.y, player.gravity * 0.05);
      surface?.dispose();
    });
  }
}

test('a downward gaze dash lands at the world boundary and rearms only on landing', () => {
  const player = createPlayer();
  firstJump(player);
  player.update(0.1, { jump: true }, 0, new THREE.Vector3(0, -1, 0));
  while (player.isDashing) player.update(0.1, {}, 0);
  near(player.position.y, 0);
  assert.equal(player.isOnGround, true);
  firstJump(player);
  player.update(0.05, { jump: true }, 0, new THREE.Vector3(0, 1, 0));
  assert.equal(player.isDashing, true);
  assert.ok(player.velocity.y > 0);
});
