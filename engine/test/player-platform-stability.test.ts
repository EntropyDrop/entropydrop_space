import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption, BodyType } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { PlayerPhysics } from '../src/physics/PlayerPhysics.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';

const idle = { forward: false, backward: false, left: false, right: false,
  jump: false, crouch: false, sprint: false };

function platformFixture(yaw = 0, restitution = 0.1, axis: 'x' | 'y' | 'z' = 'x') {
  const world: any = {
    terrainVersion: 0,
    getBlock: (_x, y, _z) => y === 0 ? BlockTypes.COLOR_BLOCK : BlockTypes.AIR,
    getMicroBlocksInAABB: () => [],
    raycast: (origin, direction, maxDistance) => {
      const distance = (1 - origin.y) / direction.y;
      return direction.y < 0 && distance >= 0 && distance <= maxDistance
        ? { hit: true, distance, normal: { x: 0, y: 1, z: 0 } } : { hit: false };
    },
    raycastMicro: () => ({ hit: false }),
    activeChunkKeys: new Set(['0,0', '-1,0', '0,-1', '-1,-1']),
    worldToChunkCoords: (x, z) => ({ cx: Math.floor(x / 16), cz: Math.floor(z / 16) })
  };
  const manager = new ContraptionManager(new THREE.Scene(), world, null, null);
  const physics = new ContraptionPhysics(world);
  manager.setPhysics(physics);
  const platform = new Contraption(1, [0, 1].map(offset => ({
    localX: axis === 'x' ? offset : 0, localY: axis === 'y' ? offset : 0,
    localZ: axis === 'z' ? offset : 0, block: BlockTypes.COLOR_BLOCK, entityId: 'root'
  })), new THREE.Vector3(0, 1, 0), manager.scene, { bodyType: BodyType.DYNAMIC, restitution });
  platform.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  platform.updateTransform();
  manager.registerContraption(platform);
  const player = new PlayerPhysics(world, manager);
  const step = () => {
    player.update(0.05, idle, 0);
    manager.update(0.05, null);
    player.resolveDynamicContraptionOverlaps();
  };
  return { world, manager, physics, platform, player, step };
}

test('two-block vertical and longitudinal layouts also support an off-centre standing player', () => {
  for (const axis of ['y', 'z'] as const) {
    for (const offset of [0.2, 0.5, 0.8]) {
      const { manager, platform, player, step } = platformFixture(0, 0.1, axis);
      for (let tick = 0; tick < 25; tick++) manager.update(0.05, null);
      player.position.copy(platform.localToWorld(new THREE.Vector3(
        axis === 'y' ? offset : 0.5, axis === 'y' ? 2 : 1, axis === 'z' ? offset * 2 : 0.5)));
      player.velocity.set(0, -1, 0);
      player.moveWithCollision(0.05);
      const before = player.position.clone();
      for (let tick = 0; tick < 100; tick++) step();
      assert.ok(player.position.distanceTo(before) < 0.01, `${axis}, offset=${offset}`);
      assert.equal(player.ridingContraption, platform);
      assert.ok(new THREE.Vector3(0, 1, 0).applyQuaternion(platform.quaternion).y > 0.9999);
    }
  }
});

test('resting support is invalidated when its kinematic foot is moved away', () => {
  const { world, physics } = platformFixture();
  const entity = new Contraption(2, [0, 1].map(localY => ({
    localX: 0, localY, localZ: 0, block: BlockTypes.COLOR_BLOCK,
    entityId: localY === 0 ? 'foot' : 'root'
  })), new THREE.Vector3(0, 1, 0), new THREE.Scene(), {
    rootComponentId: 'root', childEntities: [{ id: 'foot', parentId: 'root', bodyType: BodyType.KINEMATIC }]
  });
  delete world.terrainVersion;
  for (let tick = 0; tick < 25; tick++) physics.update(entity, 0.05);
  const before = entity.position.y;
  const foot = entity.entityNodes.get('foot')!;
  foot.localPosition.y += 3;
  foot.group.position.copy(foot.localPosition);
  entity.updateTransform();
  physics.update(entity, 0.05);
  assert.ok(entity.position.y < before - 0.02, 'the old foot contact cannot hold the unsupported root');
});

function landOn(player: PlayerPhysics, platform: Contraption, localX = 1.5) {
  player.position.copy(platform.localToWorld(new THREE.Vector3(localX, 1, 0.5)));
  player.velocity.set(0, -1, 0);
  player.moveWithCollision(0.05);
  assert.equal(player.ridingContraption, platform);
}

for (const yaw of [0, 0.3]) {
  for (const localX of [0.5, 1, 1.5]) {
    test(`a 50kg player stands on a grounded two-block platform at x=${localX}, yaw=${yaw}`, () => {
      const { manager, platform, player, step } = platformFixture(yaw);
      for (let tick = 0; tick < 25; tick++) manager.update(0.05, null);
      player.position.copy(platform.localToWorld(new THREE.Vector3(localX, 1, 0.5)));
      player.isOnGround = true;
      player.ridingContraption = platform;
      player.ridingBodyId = 'root';
      const start = player.position.clone();
      let maximumTilt = 0;
      let maximumDrift = 0;
      let detachedFrames = 0;
      for (let tick = 0; tick < 200; tick++) {
        step();
        maximumTilt = Math.max(maximumTilt,
          Math.acos(THREE.MathUtils.clamp(new THREE.Vector3(0, 1, 0).applyQuaternion(platform.quaternion).y, -1, 1)));
        maximumDrift = Math.max(maximumDrift, player.position.distanceTo(start));
        if (!player.isOnGround || player.ridingContraption !== platform) detachedFrames++;
      }
      const measurements = JSON.stringify({ maximumTilt, maximumDrift, detachedFrames,
        player: player.position.toArray(), platform: platform.position.toArray() });
      assert.ok(maximumTilt < 0.01, `standing load cannot rock a fully supported platform: ${measurements}`);
      assert.ok(maximumDrift < 0.01, `standing still cannot eject the player: ${measurements}`);
      assert.equal(detachedFrames, 0, measurements);
    });
  }
}

test('a rider follows solved translation and yaw exactly once, independent of velocity', () => {
  const { platform, player } = platformFixture();
  platform.setBodyType(BodyType.KINEMATIC);
  landOn(player, platform);
  for (let tick = 0; tick < 80; tick++) {
    platform.capturePreviousEntityTransforms();
    platform.position.add(new THREE.Vector3(0.025, tick % 2 ? -0.01 : 0.01, 0.02));
    platform.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), tick * 0.05);
    platform.updateTransform();
    player.resolveDynamicContraptionOverlaps();
    const expected = platform.localToWorld(new THREE.Vector3(1.5, 1, 0.5));
    assert.ok(player.position.distanceTo(expected) < 1e-8, `tick ${tick}: contact-point transform must be exact ${JSON.stringify({
      actual: player.position.toArray(), expected: expected.toArray(), riding: player.ridingContraption?.id })}`);
    player.resolveDynamicContraptionOverlaps();
    player.update(0.05, idle, 0);
    assert.ok(player.position.distanceTo(expected) < 1e-8, 'the next player step must not predict extra motion');
    assert.equal(player.ridingContraption, platform);
  }
});

test('a transported rider never applies standing momentum to the platform', () => {
  const { platform, player, physics } = platformFixture();
  landOn(player, platform);
  const impulses: THREE.Vector3[] = [];
  physics.applyImpulse = (_, impulse) => { impulses.push(impulse.clone()); };
  platform.velocity.set(4, 2, 0);
  platform.capturePreviousEntityTransforms();
  platform.position.addScaledVector(platform.velocity, 0.05);
  platform.updateTransform();
  player.resolveDynamicContraptionOverlaps();
  player.update(0.05, idle, 0);
  assert.equal(impulses.length, 0);
});

test('platform carriage respects a swept terrain wall and ceiling', () => {
  for (const axis of ['x', 'y'] as const) {
    const { world, platform, player } = platformFixture();
    platform.setBodyType(BodyType.KINEMATIC);
    landOn(player, platform);
    const getBlock = world.getBlock;
    world.getBlock = (x, y, z) => (axis === 'x' ? x === 3 : y === 4)
      ? BlockTypes.COLOR_BLOCK : getBlock(x, y, z);
    platform.capturePreviousEntityTransforms();
    platform.position[axis] += 4;
    platform.updateTransform();
    player.resolveDynamicContraptionOverlaps();
    assert.ok(player.position[axis] <= (axis === 'x' ? 2.7 : 2.2) + 1e-8, 'carry cannot tunnel through terrain');
  }
});

test('a vacated swept envelope is not a ghost floor', () => {
  const { platform, player } = platformFixture();
  platform.setBodyType(BodyType.KINEMATIC);
  platform.capturePreviousEntityTransforms();
  platform.position.x += 3;
  platform.updateTransform();
  player.position.set(0.5, 2.1, 0.5);
  player.velocity.set(0, -4, 0);
  player.moveWithCollision(0.05);
  assert.ok(Math.abs(player.position.y - 1.9) < 1e-8);
  assert.equal(player.isOnGround, false);
  assert.equal(player.ridingContraption, null);
});

test('walking off or disabling the supporting collider immediately releases platform attachment', () => {
  for (const cause of ['walk-off', 'disabled-collision']) {
    const { platform, player } = platformFixture();
    platform.setBodyType(BodyType.KINEMATIC);
    landOn(player, platform);
    if (cause === 'walk-off') {
      player.velocity.set(30, -1, 0);
      player.moveWithCollision(0.05);
    } else {
      platform.setCollisionSimulationEnabled(false);
      player.resolveDynamicContraptionOverlaps();
    }
    assert.equal(player.ridingContraption, null, cause);
    assert.equal(player.isOnGround, false, cause);
  }
});

test('an entity translating completely past the player still has a one-shot swept collision', () => {
  const { platform, player } = platformFixture();
  platform.setBodyType(BodyType.KINEMATIC);
  platform.position.x -= 4;
  platform.updateTransform();
  player.position.set(0.5, 1.1, 0.5);
  player.resolveDynamicContraptionOverlaps();
  platform.capturePreviousEntityTransforms();
  platform.position.x += 6;
  platform.updateTransform();
  assert.equal(player.resolveDynamicContraptionOverlaps(), true);
  assert.ok(Math.abs(player.position.x - 4.3) < 1e-8);
  assert.equal(player.resolveDynamicContraptionOverlaps(), false, 'the same sweep cannot fire twice');
});

test('standing stabilization cannot retain a removed floor or disabled collision', () => {
  for (const cause of ['removed-floor', 'disabled-collision']) {
    const { world, manager, platform, player, physics } = platformFixture();
    for (let tick = 0; tick < 25; tick++) manager.update(0.05, null);
    landOn(player, platform, 0.5);
    const before = platform.position.y;
    if (cause === 'removed-floor') {
      world.getBlock = () => BlockTypes.AIR;
      world.terrainVersion++;
    } else platform.setCollisionSimulationEnabled(false);
    physics.applyImpulse(platform, new THREE.Vector3(0, -5, 0));
    for (let tick = 0; tick < 5; tick++) manager.update(0.05, null);
    assert.ok(platform.position.y < before - 0.2, cause);
  }
});

test('a grounded platform ignores player jump reaction but still accepts authoritative impulses', () => {
  const { manager, platform, player, physics } = platformFixture();
  for (let tick = 0; tick < 25; tick++) manager.update(0.05, null);
  landOn(player, platform);
  player.update(0.05, { ...idle, jump: true }, 0);
  assert.equal(player.ridingContraption, null);
  assert.equal(player.velocity.y, player.jumpForce);
  assert.equal(platform.velocity.y, 0, 'one-way player collision must not transfer a jump reaction');
  const before = platform.position.y;
  physics.applyImpulse(platform, new THREE.Vector3(0, 2500, 0));
  manager.update(0.05, null);
  assert.ok(platform.position.y > before + 0.5, 'ground cannot pull an upwards impulse back down');
});
