import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BodyType, Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { PlayerPhysics } from '../src/physics/PlayerPhysics.ts';
import {
  DECORATION_COLLISION_COLUMN_BUDGET, decorationColumnBudget, splitCollisionBoxes, voxelizeDecoration,
} from '../src/physics/DecorationCollision.ts';
import type { CollisionBox } from '../src/physics/CollisionGeometry.ts';
import { World } from '../src/voxel/World.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';
import { MICRO_SIZE } from '../src/voxel/MicroGrid.ts';
import { TORUS_SIZE_X } from '../src/torus/TorusWorld.ts';

const covers = (boxes: CollisionBox[], x: number, y: number, z: number) => boxes.some(box => (
  x >= box.x && x < box.x + box.spanX && y >= box.y && y < box.y + box.spanY && z >= box.z && z < box.z + box.spanZ
));
const volume = (boxes: CollisionBox[]) => boxes.reduce((sum, box) => sum + box.spanX * box.spanY * box.spanZ, 0);

test('axis-aligned decorations become one grid box whose faces round to the nearest plane', () => {
  assert.deepEqual(voxelizeDecoration({ position: [4, 1, 0], scale: [2, 0.1, 1] }, 'base'),
    [{ x: 24, y: 8, z: -4, spanX: 16, spanY: 1, spanZ: 8, entityId: 'base' }],
    'a 0.1 m panel keeps the one cell holding its centre');
  assert.deepEqual(voxelizeDecoration({ position: [0.5, 0.5, 0.5] }, 'base'),
    [{ x: 0, y: 0, z: 0, spanX: 8, spanY: 8, spanZ: 8, entityId: 'base' }], 'the default 1 m cube is exact');
  const quarterTurn = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  assert.deepEqual(voxelizeDecoration({ rotation: quarterTurn, scale: [2, 0.5, 1] }, 'base'),
    [{ x: -4, y: -2, z: -8, spanX: 8, spanY: 4, spanZ: 16, entityId: 'base' }], 'quarter turns swap extents');
});

test('rotated decorations fill exactly the micro cells whose centres lie inside the cube', () => {
  // The tutorial's sloping panel: 4 x 0.25 x 3 m, rotated -30 degrees about Z.
  const angle = -Math.PI / 6;
  const shape = { position: [2, 2.125, 2], scale: [4, 0.25, 3], rotation: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)] };
  const boxes = voxelizeDecoration(shape, 'base');
  const quaternion = new THREE.Quaternion(...shape.rotation as [number, number, number, number]).invert();
  let inside = 0;
  for (let x = -8; x < 40; x++) for (let y = -8; y < 40; y++) for (let z = 0; z < 32; z++) {
    const local = new THREE.Vector3((x + 0.5) * MICRO_SIZE, (y + 0.5) * MICRO_SIZE, (z + 0.5) * MICRO_SIZE)
      .sub(new THREE.Vector3(2, 2.125, 2)).applyQuaternion(quaternion);
    const expected = Math.abs(local.x) <= 2 + 1e-9 && Math.abs(local.y) <= 0.125 + 1e-9 && Math.abs(local.z) <= 1.5 + 1e-9;
    if (expected) inside++;
    assert.equal(covers(boxes, x, y, z), expected, `cell ${x},${y},${z}`);
  }
  assert.equal(volume(boxes), inside, 'boxes never overlap');
  assert.ok(boxes.length < 40, `runs merge into a staircase, got ${boxes.length} boxes`);
});

test('columns outside a rotated windscreen do not produce infinite collision bounds', () => {
  const angle = 0.25;
  const boxes = voxelizeDecoration({
    position: [2.58, 3.19, 0],
    scale: [0.058, 1.46, 2.36],
    rotation: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)],
  }, 'windscreen');
  assert.ok(boxes.length > 0);
  for (const { x, y, z, spanX, spanY, spanZ } of boxes) {
    assert.ok([x, y, z, spanX, spanY, spanZ].every(Number.isFinite));
    assert.ok(spanX > 0 && spanY > 0 && spanZ > 0);
  }
});

test('thin rotated panels stay closed and huge ones coarsen within the run budget', () => {
  const angle = Math.PI / 6;
  const rotation = [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
  const panel = voxelizeDecoration({ scale: [3, 0.02, 2], rotation }, 'base');
  // Every vertical column under the panel's projected span meets the footprint.
  for (let x = -10; x <= 9; x++) for (let z = -7; z <= 6; z++) {
    assert.ok(panel.some(box => x >= box.x && x < box.x + box.spanX && z >= box.z && z < box.z + box.spanZ), `hole at ${x},${z}`);
  }
  const huge = voxelizeDecoration({ scale: [64, 64, 64], rotation: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)] }, 'base');
  const grid = Math.min(...huge.flatMap(box => [box.spanX, box.spanY, box.spanZ]));
  assert.ok(grid >= 8, `a 64 m rotated cube is sampled coarsely, grid=${grid}`);
  assert.ok(huge.every(box => [box.x, box.y, box.z, box.spanX, box.spanY, box.spanZ].every(value => value % grid === 0)));
  assert.equal(decorationColumnBudget(1), DECORATION_COLLISION_COLUMN_BUDGET);
  assert.equal(decorationColumnBudget(32), 2048);
  assert.equal(decorationColumnBudget(100000), 256);
  const pieces = splitCollisionBoxes([{ x: 0, y: 0, z: 0, spanX: 96, spanY: 96, spanZ: 96, entityId: 'base' }], 32);
  assert.equal(pieces.length, 26, 'the enclosed centre piece is dropped');
});

const voxel = (x: number, entityId = 'base') => ({ localX: x, localY: 0, localZ: 0, size: 1, color: 0x123456, block: 1, entityId });

test('entity decorations collide without mass, follow runtime edits and the component collision switch', () => {
  const entity = new Contraption(1, [voxel(0)], new THREE.Vector3(), new THREE.Scene(), {
    rootComponentId: 'base', decorations: [{ id: 'deck', color: 0, position: [4, 1, 0], scale: [2, 0.1, 1] }],
  });
  try {
    const body = entity.getRigidBody('base')!;
    const physical = [entity.mass, body.mass, body.inverseInertia, entity.boundingRadius];
    assert.equal(entity.collisionPhysicsBoxes.length, 2);
    const deck = entity.getCollisionWorldAABBs().find(box => box.minX > 2)!;
    assert.deepEqual([deck.minX, deck.maxX, deck.minY, deck.maxY], [3, 5, 1, 1.125]);
    assert.ok(entity.getCollisionRadius() > 4.5, 'broadphase covers the decoration');
    assert.equal(entity.queryCollisionWorldAABBs({ minX: 3.9, maxX: 4.1, minY: 1, maxY: 1.2, minZ: -0.1, maxZ: 0.1 }).length, 1);
    assert.ok(entity.collisionTerrainBoxes.some(box => box.x === 24));

    assert.equal(entity.editRuntimeDecoration('base', 'deck', { position: [8, 1, 0] }).ok, true);
    assert.ok(entity.getCollisionWorldAABBs().some(box => box.minX === 7), 'runtime edits move the footprint');
    assert.deepEqual([entity.mass, body.mass, body.inverseInertia, entity.boundingRadius], physical, 'decorations add no mass');

    entity.setNodeCollisionEnabled('base', false);
    assert.equal(entity.queryCollisionWorldAABBs({ minX: 7.9, maxX: 8.1, minY: 1, maxY: 1.2, minZ: -0.1, maxZ: 0.1 }).length, 0);
    entity.setNodeCollisionEnabled('base', true);
    entity.setComponentDecorations('base', []);
    assert.equal(entity.collisionPhysicsBoxes.length, 1);
    assert.equal(entity.getDecorationCollisionBoxes().length, 0);
  } finally { entity.dispose(); }
});

test('a player lands on an entity decoration', () => {
  const entity = new Contraption(1, [voxel(0)], new THREE.Vector3(), new THREE.Scene(), {
    rootComponentId: 'base', decorations: [{ id: 'deck', color: 0, position: [6, 1, 0.5], scale: [3, 0.1, 3] }],
  });
  try {
    const player = new PlayerPhysics({ getBlock: () => BlockTypes.AIR, getMicroBlocksInAABB: () => [] }, { contraptions: [entity] }) as any;
    player.position.set(6, 3, 0.5);
    player.velocity.set(0, -4, 0);
    for (let i = 0; i < 60; i++) player.moveWithCollision(1 / 30);
    assert.ok(Math.abs(player.position.y - 1.125) < 1e-6, `player rests on the deck, y=${player.position.y}`);
  } finally { entity.dispose(); }
});

function decoratedWorld() {
  const world = new World(new THREE.Scene()) as any;
  world.setBlock(3, 40, 3, BlockTypes.COLOR_BLOCK, false);
  // A 4 x 0.25 x 4 m plate one metre above its anchor: y 41.375..41.625.
  world.setTerrainDecoration({ id: 'd_plate', x: 3, y: 40, z: 3, color: 0, position: [0, 1, 0], scale: [4, 0.25, 4] });
  return world;
}

test('terrain decoration footprints answer every terrain collision query and wake sleepers', () => {
  const world = decoratedWorld();
  const [plate] = world.getTerrainDecorationCollisionBoxesInAABB({ minX: 3, maxX: 4, minY: 41, maxY: 42, minZ: 3, maxZ: 4 });
  assert.deepEqual(plate, { minX: 1.5, maxX: 5.5, minY: 41.375, maxY: 41.625, minZ: 1.5, maxZ: 5.5 });
  assert.equal(world.hasTerrainCollisionInAABB({ minX: 2, maxX: 2.1, minY: 41.4, maxY: 41.5, minZ: 2, maxZ: 2.1 }), true);
  assert.equal(world.hasTerrainDecorationCollisionAt(16, 331, 16), true);
  assert.equal(world.hasTerrainDecorationCollisionAt(16, 333, 16), false);
  assert.ok(world.prepareTerrainCollisionQuery({ minX: 2, maxX: 3, minY: 41, maxY: 42, minZ: 2, maxZ: 3 }).microBoxes.length > 0);
  const hit = world.raycastTerrainDecorations(new THREE.Vector3(2, 45, 2), new THREE.Vector3(0, -1, 0), 10);
  assert.equal(hit.hit, true);
  assert.ok(Math.abs(hit.distance - 3.375) < 1e-9);
  assert.deepEqual(hit.normal, { x: 0, y: 1, z: 0 });

  const stamp = world.getTerrainCollisionStamp({ minX: 0, maxX: 1, minZ: 0, maxZ: 1 });
  world.setTerrainDecoration({ id: 'd_plate', x: 3, y: 40, z: 3, color: 0, position: [0, 2, 0], scale: [4, 0.25, 4] });
  assert.notDeepEqual(world.getTerrainCollisionStamp({ minX: 0, maxX: 1, minZ: 0, maxZ: 1 }), stamp);
  world.setBlock(3, 40, 3, BlockTypes.AIR, false);
  assert.equal(world.getTerrainDecorationCollisionBoxesInAABB({ minX: 0, maxX: 8, minY: 40, maxY: 44, minZ: 0, maxZ: 8 }).length, 0,
    'removing the anchor removes its collision');
});

test('terrain footprints that cross the torus seam are found from both sides', () => {
  const world = new World(new THREE.Scene()) as any;
  const x = TORUS_SIZE_X - 1;
  world.setBlock(x, 40, 3, BlockTypes.COLOR_BLOCK, false);
  world.setTerrainDecoration({ id: 'd_seam', x, y: 40, z: 3, color: 0, position: [2, 0, 0], scale: [2, 1, 1] });
  // Centre x = TORUS_SIZE_X + 1.5, so the cube spans the seam by 2.5 m.
  const [after] = world.getTerrainDecorationCollisionBoxesInAABB({ minX: 1, maxX: 1.5, minY: 40, maxY: 41, minZ: 3, maxZ: 4 });
  assert.deepEqual([after.minX, after.maxX], [0.5, 2.5]);
  const [before] = world.getTerrainDecorationCollisionBoxesInAABB({ minX: TORUS_SIZE_X + 1, maxX: TORUS_SIZE_X + 1.5, minY: 40, maxY: 41, minZ: 3, maxZ: 4 });
  assert.deepEqual([before.minX, before.maxX], [TORUS_SIZE_X + 0.5, TORUS_SIZE_X + 2.5]);
});

test('players and dynamic entities rest on terrain decorations', () => {
  const world = decoratedWorld();
  const player = new PlayerPhysics(world, { contraptions: [] }) as any;
  player.position.set(2, 44, 2);
  player.velocity.set(0, -4, 0);
  for (let i = 0; i < 90; i++) player.moveWithCollision(1 / 30);
  assert.ok(Math.abs(player.position.y - 41.625) < 1e-6, `player rests on the plate, y=${player.position.y}`);

  const entity = new Contraption(0, [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(4, 44, 4), new THREE.Scene(), { bodyType: BodyType.DYNAMIC, restitution: 0.01 });
  try {
    const physics = new ContraptionPhysics(world);
    for (let tick = 0; tick < 120; tick++) physics.update(entity, 0.05);
    const bottom = entity.getCollisionWorldAABBs()[0].currentMinY;
    assert.ok(Math.abs(bottom - 41.625) < 0.02, `entity rests on the plate, bottom=${bottom}`);
  } finally { entity.dispose(); }
});

test('an entity lands on terrain with its own decoration and carries another entity on one', () => {
  const physics = new ContraptionPhysics({
    raycast: () => ({ hit: false as const }),
    raycastMicro: () => ({ hit: false as const }),
    getBlock: (_x: number, y: number) => y <= 0 ? BlockTypes.COLOR_BLOCK : BlockTypes.AIR,
    microVoxels: { get: () => null },
  } as any);
  // A wide skid hangs 1 m below the single voxel: y -0.625..-0.375 in construction space.
  const sled = new Contraption('sled', [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(0, 5, 0), new THREE.Scene(), {
      bodyType: BodyType.DYNAMIC, restitution: 0.01,
      decorations: [{ id: 'skid', color: 0, position: [0.5, -0.5, 0.5], scale: [3, 0.25, 3] }],
    });
  try {
    for (let tick = 0; tick < 120; tick++) physics.update(sled, 0.05);
    const boxes = sled.getCollisionWorldAABBs();
    const bottom = Math.min(...boxes.map(box => box.currentMinY));
    assert.ok(Math.abs(bottom - 1) < 0.02, `the skid rests on the floor, bottom=${bottom}`);
    assert.ok(boxes.every(box => box.currentMinY >= bottom - 1e-9));
    const voxelBottom = Math.min(...boxes.filter(box => box.maxX - box.minX < 1.5).map(box => box.currentMinY));
    assert.ok(voxelBottom > 1.3, `the voxel stays above the skid, bottom=${voxelBottom}`);
  } finally { sled.dispose(); }

  const air = new ContraptionPhysics({
    raycast: () => ({ hit: false as const }), raycastMicro: () => ({ hit: false as const }), getBlock: () => BlockTypes.AIR,
  } as any);
  const tower = new Contraption('tower', [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(0, 0, 0), new THREE.Scene(), {
      bodyType: BodyType.KINEMATIC, decorations: [{ id: 'roof', color: 0, position: [0.5, 3, 0.5], scale: [4, 0.25, 4] }],
    });
  const box = new Contraption('box', [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    // Its bottom (y 3.05) overlaps the roof's top face (y 3.125).
    new THREE.Vector3(1, 3.05, 1), new THREE.Scene(), { bodyType: BodyType.DYNAMIC, restitution: 0 });
  try {
    box.velocity.set(0, -2, 0);
    air.resolveContraptionPairs([tower, box]);
    assert.ok(box.velocity.y > -1e-6, `the roof stops the falling box, vy=${box.velocity.y}`);
    assert.ok(box.getPhysicsCollisionWorldAABBs()[0].currentMinY > 3.05, 'the box is pushed out of the roof');
  } finally { tower.dispose(); box.dispose(); }
});
