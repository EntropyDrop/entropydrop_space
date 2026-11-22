import assert from 'node:assert/strict';
import test from 'node:test';
import { Scene, Vector3 } from 'three';
import { BodyType, Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { TORUS_SIZE_X } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { Chunk } from '@entropydrop/space-engine/voxel/Chunk.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { loadRapierPhysics } from '@entropydrop/space-engine/rapier/loadRapierPhysics.ts';
import { RapierPlayerPhysics } from '@entropydrop/space-engine/rapier/RapierPlayerPhysics.ts';

const block = (localX: number) => ({ localX, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK });
const dt = 1 / 20;

test('resident voxel and decoration colliders are updated independently of pose and paint', async () => {
  const scene = new Scene();
  const world = new World(scene);
  const physics = await loadRapierPhysics(world);
  const entity = new Contraption('shapes', [block(0), block(1)], new Vector3(400, 180, 3), scene, {
    rootComponentId: 'base', useGravity: false,
    decorations: [{ id: 'trim', position: [4, 1, 0], scale: [2, 0.1, 1], color: 0xff0000 }],
  });
  try {
    entity.velocity.x = 3;
    for (let i = 0; i < 4; i++) physics.update(entity, dt);
    assert.equal(physics.counts.steps, 12);
    assert.deepEqual([physics.counts.bodyCreates, physics.counts.voxelRebuilds, physics.counts.decorationRebuilds], [1, 1, 1]);
    entity.setNodeCollisionEnabled('base', false);
    physics.update(entity, dt);
    entity.setNodeCollisionEnabled('base', true);
    physics.update(entity, dt);
    assert.deepEqual([physics.counts.bodyCreates, physics.counts.voxelRebuilds, physics.counts.decorationRebuilds], [1, 1, 1]);

    assert.equal(entity.editRuntimeDecoration('base', 'trim', { color: 0xffffff }).ok, true);
    physics.update(entity, dt);
    assert.equal(physics.counts.decorationRebuilds, 1);
    assert.equal(entity.editRuntimeDecoration('base', 'trim', { position: [8, 1, 4] }).ok, true);
    physics.update(entity, dt);
    assert.equal(physics.counts.decorationRebuilds, 2);

    const removed = entity.blocks.pop()!;
    entity.rebuildAfterBlockChange('remove', 'base', null, { added: [], removed: [removed] });
    physics.update(entity, dt);
    assert.deepEqual([physics.counts.bodyCreates, physics.counts.voxelRebuilds, physics.counts.decorationRebuilds], [1, 2, 2]);
  } finally { entity.dispose(); }
});

test('resident terrain contacts retain sleeping support across a torus seam and wake on an edit', async () => {
  const scene = new Scene();
  const world = new World(scene);
  for (let x = TORUS_SIZE_X - 1; x <= TORUS_SIZE_X; x++) {
    const { cx, cz } = world.worldToChunkCoords(x, 5);
    world.chunks.set(World.getChunkKey(cx, cz), new Chunk(cx, cz, world));
    world.setBlock(x, 180, 5, BlockTypes.COLOR_BLOCK, false);
  }
  const physics = await loadRapierPhysics(world);
  const entity = new Contraption('seam', [block(0)], new Vector3(TORUS_SIZE_X - 0.5, 182, 5), scene);
  try {
    for (let i = 0; i < 80; i++) physics.update(entity, dt);
    assert.ok(entity.isOnGround);
    assert.ok(Math.abs(entity.position.y - 181.5) < 0.025, `body height ${entity.position.y}`);
    assert.ok(physics.isSleeping(entity));
    entity.pendingScriptContacts.length = 0;
    physics.update(entity, dt);
    const contact = entity.pendingScriptContacts.find(value => value.kind === 'terrain');
    assert.ok(contact, 'sleeping bodies keep their terrain observations');
    assert.ok(contact.normal && contact.normal[1] > 0.9);
    assert.equal(contact.impulse, 0);

    for (let x = TORUS_SIZE_X - 1; x <= TORUS_SIZE_X; x++) {
      assert.ok(world.setBlock(x, 180, 5, BlockTypes.AIR, false));
    }
    physics.update(entity, dt);
    assert.equal(physics.isSleeping(entity), false);
    assert.ok(entity.velocity.y < -0.5, `fall velocity ${entity.velocity.y}, y ${entity.position.y}, onGround ${entity.isOnGround}`);
    assert.equal(entity.isOnGround, false);
  } finally { entity.dispose(); }
});

test('a kinematic collider and both dynamic bodies stay in the same Rapier world', async () => {
  const scene = new Scene();
  const world = new World(scene);
  const physics = await loadRapierPhysics(world);
  const manager = new ContraptionManager(scene, world, null, null);
  manager.setPhysics(physics);
  const mover = new Contraption('mover', [block(0)], new Vector3(4, 180, 4), scene, { useGravity: false });
  const wall = new Contraption('wall', [block(0)], new Vector3(6, 180, 4), scene, { bodyType: BodyType.KINEMATIC });
  const remote = new Contraption('other', [block(0)], new Vector3(80, 180, 4), scene, { useGravity: false });
  for (const entity of [mover, wall, remote]) manager.registerContraption(entity);
  try {
    const remoteStart = remote.position.x;
    mover.velocity.x = 35;
    remote.velocity.x = 3;
    for (let i = 0; i < 4; i++) manager.update(dt, null);
    assert.equal(physics.counts.steps, 12);
    assert.equal(physics.counts.bodyCreates, 3);
    assert.ok(mover.position.x < wall.position.x);
    assert.ok(mover.pendingScriptContacts.some(contact => contact.kind === 'entity' && contact.otherEntityId === wall.publicId));
    assert.ok(remote.position.x > remoteStart);
  } finally { for (const entity of [mover, wall, remote]) entity.dispose(); }
});

test('a scripted kinematic body clips its swept motion against a stopped collider', async () => {
  const scene = new Scene();
  const world = new World(scene);
  const physics = await loadRapierPhysics(world);
  const manager = new ContraptionManager(scene, world, null, null);
  manager.setPhysics(physics);
  const moving = new Contraption('moving', [block(0)], new Vector3(4, 180, 4), scene, { bodyType: BodyType.KINEMATIC });
  const stopped = new Contraption('stopped', [block(0)], new Vector3(6, 180, 4), scene, { physicsSimulationEnabled: false });
  manager.registerContraption(moving);
  manager.registerContraption(stopped);
  try {
    manager.update(dt, null);
    moving.position.x += 4;
    moving.updateTransform();
    manager.update(dt, null);
    assert.ok(Math.abs(stopped.position.x - moving.position.x - 1) < 0.015);
    assert.equal(physics.counts.steps, 6);
    assert.equal(physics.counts.bodyCreates, 2);
  } finally { moving.dispose(); stopped.dispose(); physics.dispose(); }
});

test('an attached kinematic collider transfers impacts to its dynamic carrier', async () => {
  const scene = new Scene();
  const world = new World(scene);
  const physics = await loadRapierPhysics(world);
  const manager = new ContraptionManager(scene, world, null, null);
  manager.setPhysics(physics);
  const mover = new Contraption('mover', [{ ...block(0), entityId: 'base' }, { ...block(2), entityId: 'arm' }],
    new Vector3(4, 180, 4), scene, { rootComponentId: 'base', useGravity: false,
      childEntities: [{ id: 'arm', parentId: 'base', bodyType: BodyType.KINEMATIC, pivot: [2, 0, 0] }] });
  const wall = new Contraption('wall', [block(0)], new Vector3(8, 180, 4), scene, { physicsSimulationEnabled: false });
  manager.registerContraption(mover);
  manager.registerContraption(wall);
  try {
    const start = mover.position.x;
    mover.velocity.x = 18;
    let travel = 0;
    for (let i = 0; i < 4; i++) {
      manager.update(dt, null);
      travel = Math.max(travel, mover.position.x - start);
    }
    assert.ok(Math.abs(travel - 1) < 0.1, `arm travelled ${travel} m before impact`);
    assert.ok(mover.pendingScriptContacts.some(contact => contact.selfNodeId === 'arm' && contact.otherEntityId === wall.publicId));
  } finally { mover.dispose(); wall.dispose(); physics.dispose(); }
});

test('Rapier point, weld and limited hinge joints keep dynamic child anchors attached', async () => {
  const scene = new Scene();
  const world = new World(scene);
  const physics = await loadRapierPhysics(world);
  const manager = new ContraptionManager(scene, world, null, null);
  manager.setPhysics(physics);
  const types = ['point', 'weld', 'hinge'] as const;
  const examples = types.map((type, index) => new Contraption(type,
    [{ ...block(0), entityId: 'base' }, { ...block(2), entityId: 'child' }],
    new Vector3(index * 10 + 4, 180, 4), scene, {
      rootComponentId: 'base', bodyType: BodyType.KINEMATIC,
      childEntities: [{ id: 'child', parentId: 'base', bodyType: BodyType.DYNAMIC }],
      constraints: [{ id: 'joint', type, bodyA: 'base', bodyB: 'child',
        axisA: [0, 1, 0], axisB: [0, 1, 0], limits: { min: -0.15, max: 0.15 } }],
    }));
  try {
    for (const entity of examples) {
      manager.registerContraption(entity);
      entity.getRigidBody('child')!.angularVelocity.set(0, 6, 0);
    }
    for (let i = 0; i < 20; i++) manager.update(dt, null);
    assert.equal(physics.counts.bodyCreates, 6);
    assert.equal(physics.counts.jointCreates, 3);
    for (const entity of examples) {
      const joint = entity.constraintDefinitions.get('joint')!;
      const a = entity.getRigidBody('base')!, b = entity.getRigidBody('child')!;
      const anchorA = new Vector3().fromArray(joint.anchorA).applyQuaternion(a.quaternion).add(a.position);
      const anchorB = new Vector3().fromArray(joint.anchorB).applyQuaternion(b.quaternion).add(b.position);
      assert.ok(anchorA.distanceTo(anchorB) < 0.03, entity.id.toString());
    }
    assert.ok(examples[1].getRigidBody('child')!.quaternion.angleTo(examples[1].quaternion) < 0.04);
    assert.ok(examples[2].getRigidBody('child')!.quaternion.angleTo(examples[2].quaternion) < 0.2);
  } finally {
    for (const entity of examples) entity.dispose();
    physics.dispose();
  }
});

test('Rapier resolves terrain and entity casts for the player without moving the entity', async () => {
  const scene = new Scene();
  const world = new World(scene);
  world.chunks.set(World.getChunkKey(0, 0), new Chunk(0, 0, world));
  world.setBlock(4, 179, 4, BlockTypes.COLOR_BLOCK, false);
  const physics = await loadRapierPhysics(world);
  const manager = new ContraptionManager(scene, world, null, null);
  const cube = new Contraption('wall', [block(0)], new Vector3(6, 180, 4), scene, { useGravity: false });
  manager.registerContraption(cube);
  const player = new RapierPlayerPhysics(physics.module, world, manager);
  try {
    player.position.set(4.5, 180.5, 4.5);
    player.velocity.set(0, -15, 0);
    player.moveWithCollision(dt);
    assert.ok(player.isOnGround);
    assert.ok(Math.abs(player.position.y - 180) < 0.005);
    const cubePosition = cube.position.clone();
    player.velocity.set(50, 0, 0);
    player.moveWithCollision(dt);
    assert.ok(player.position.x + player.width / 2 <= 6.001);
    assert.equal(player.velocity.x, 0);
    assert.ok(cube.position.equals(cubePosition));
    assert.equal(cube.velocity.lengthSq(), 0);

    player.position.set(6.5, 181.05, 4.5);
    player.velocity.set(0, -2, 0);
    player.moveWithCollision(dt);
    assert.equal(player.ridingContraption, cube);
    cube.capturePreviousEntityTransforms();
    cube.position.x += 0.75;
    cube.updateTransform();
    player.resolveDynamicContraptionOverlaps();
    assert.ok(Math.abs(player.position.x - 7.25) < 0.005);
    assert.equal(player.ridingContraption, cube);
    cube.setCollisionSimulationEnabled(false);
    player.resolveDynamicContraptionOverlaps();
    assert.equal(player.ridingContraption, null);
  } finally { cube.dispose(); physics.dispose(); }
});

test('stopped bodies remain solid and resume on the same Rapier body', async () => {
  const scene = new Scene();
  const world = new World(scene);
  const physics = await loadRapierPhysics(world);
  const manager = new ContraptionManager(scene, world, null, null);
  manager.setPhysics(physics);
  const moving = new Contraption('moving', [block(0)], new Vector3(4, 180, 4), scene, { useGravity: false });
  const stopped = new Contraption('stopped', [block(0)], new Vector3(6, 180, 4), scene, { useGravity: false });
  stopped.setPhysicsSimulationEnabled(false);
  manager.registerContraption(moving);
  manager.registerContraption(stopped);
  try {
    const start = stopped.position.x;
    moving.velocity.x = 25;
    for (let i = 0; i < 4; i++) manager.update(dt, null);
    assert.equal(physics.counts.steps, 12);
    assert.equal(physics.counts.bodyCreates, 2);
    assert.equal(stopped.position.x, start);
    assert.ok(moving.position.x < stopped.position.x);
    assert.ok(moving.pendingScriptContacts.some(contact => contact.otherEntityId === stopped.publicId));

    stopped.setPhysicsSimulationEnabled(true);
    stopped.velocity.x = 2;
    manager.update(dt, null);
    assert.equal(physics.counts.bodyCreates, 2);
    assert.ok(stopped.position.x > start);
  } finally { moving.dispose(); stopped.dispose(); }
});
