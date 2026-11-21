import assert from 'node:assert/strict';
import test from 'node:test';
import { Scene, Vector3 } from 'three';
import { BodyType, Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { TORUS_SIZE_X } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { Chunk } from '@entropydrop/space-engine/voxel/Chunk.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { loadRapierPhysics } from '../src/physics/loadRapierPhysics.ts';

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

test('a swept collision with a kinematic entity stays in Space while distant bodies use Rapier', async () => {
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
    assert.equal(physics.counts.bodyCreates, 1, 'only the remote body joins Rapier');
    assert.ok(mover.position.x < wall.position.x);
    assert.ok(mover.pendingScriptContacts.some(contact => contact.kind === 'entity' && contact.otherEntityId === wall.publicId));
    assert.ok(remote.position.x > remoteStart);
  } finally { for (const entity of [mover, wall, remote]) entity.dispose(); }
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
