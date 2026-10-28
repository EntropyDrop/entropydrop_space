import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TerrainGenerator } from '@entropydrop/space-engine/worldgen/TerrainGenerator.ts';
import { TERRAIN_GENERATOR_TUTORIAL, TUTORIAL_GROUND_HEIGHT } from '@entropydrop/space-engine/worldgen/TutorialGenerator.ts';
import { Chunk } from '@entropydrop/space-engine/voxel/Chunk.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { WorldEditPersistence } from '@entropydrop/space-engine/voxel/WorldEditPersistence.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { captureTutorialLevel, createTutorialStorage, parseTutorialLevel, TUTORIAL_WORLD_ID, tutorialDestination } from '../src/bootstrap/TutorialLevel.ts';
import { createTutorialSession, enterTutorialSpace } from '../src/bootstrap/TutorialSpace.ts';
import { configureTutorialTerrain } from '../src/bootstrap/TutorialTerrain.ts';
import { loadBackpack, saveBackpack } from '../src/engine/inventory/BackpackPersistence.ts';
import { addInventoryItem } from '../src/engine/inventory/Backpack.ts';
import { isTutorialRoute } from '../src/bootstrap/SpaceFeatures.ts';
import { resolveInitialPlayerPose } from '../src/bootstrap/SpaceBootstrap.ts';
import { rememberSpacePlayerName } from '../src/bootstrap/SpacePlayerName.ts';
import source from '../src/tutorial/tutorial-level.json' with { type: 'json' };

// Authoring the bundled lesson must not change these isolated test fixtures.
const level = parseTutorialLevel({
  ...source,
  terrain: { version: 3, standard: [], micro: [] },
  entities: { version: 4, entities: [] },
});

test('the bundled tutorial remains a valid level file', () => {
  parseTutorialLevel(source);
});

test('tutorial generator is completely level at distant locations and both seams', () => {
  const generator = new TerrainGenerator(42, TERRAIN_GENERATOR_TUTORIAL);
  const reference = new Chunk(0, 0, null);
  generator.generateChunk(reference);
  for (const [x, z] of [[0, 0], [512, 64], [1023, 127], [-1, -1], [1024, 128]]) {
    const chunk = new Chunk(x, z, null);
    generator.generateChunk(chunk);
    assert.deepEqual(chunk.blocks, reference.blocks);
    assert.deepEqual(chunk.colors, reference.colors);
    assert.equal(chunk.terrainDetails.length, 0);
    assert.equal(chunk.getLocalBlock(0, TUTORIAL_GROUND_HEIGHT, 0), BlockTypes.COLOR_BLOCK);
    assert.equal(chunk.getLocalBlock(0, TUTORIAL_GROUND_HEIGHT + 1, 0), BlockTypes.AIR);
    assert.equal(generator.sampleHeight(x * 16, z * 16), TUTORIAL_GROUND_HEIGHT);
  }
});

test('tutorial files round trip additions, carved ground, paint, micro materials and distant edits without persisting play changes', () => {
  const storage = createTutorialStorage(level);
  const edits = new WorldEditPersistence({ worldId: TUTORIAL_WORLD_ID, storage });
  edits.recordStandard(8192, 16, 1024, BlockTypes.AIR, 0);
  edits.recordStandard(8193, 17, 1024, BlockTypes.COLOR_BLOCK, 0xaabbcc, 1);
  edits.recordStandard(8194, 16, 1024, BlockTypes.COLOR_BLOCK, 0xabcdef);
  edits.recordStandard(16000, 20, 2000, BlockTypes.COLOR_BLOCK, 0x102030);
  edits.recordMicro(8192 * 8, 18 * 8, 1024 * 8, 0x334455, 'root', 1);
  edits.flush();
  const saved = captureTutorialLevel(storage, level);
  assert.equal(saved.terrain.standard.length, 4);
  assert.equal(saved.terrain.micro.length, 1);
  assert.ok(JSON.stringify(saved).length < 1500, 'generated chunks must not be serialized');
  assert.doesNotMatch(JSON.stringify(saved), /pendingBatches|backpack|savedAt|token/);
  const restored = new WorldEditPersistence({
    worldId: TUTORIAL_WORLD_ID, storage: createTutorialStorage(parseTutorialLevel(JSON.parse(JSON.stringify(saved)))),
  });
  assert.deepEqual([...restored.getStandardEditsForChunk(512, 64)], [...edits.getStandardEditsForChunk(512, 64)]);
  assert.deepEqual([...restored.getStandardEditsForChunk(1000, 125)], [...edits.getStandardEditsForChunk(1000, 125)]);
  assert.deepEqual([...restored.getMicroEdits()], [...edits.getMicroEdits()]);
  // Re-enter from the lesson, not from the just-played mutable session.
  const reset = new WorldEditPersistence({ worldId: TUTORIAL_WORLD_ID, storage: createTutorialStorage(level) });
  assert.deepEqual([...reset.getStandardEditsForChunk(512, 64)], []);
  assert.deepEqual([...reset.getMicroEdits()], []);
});

test('tutorial export captures active and dormant entities, scripts and child components', () => {
  const storage = createTutorialStorage(level);
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null, storage);
  manager.setWorldIdentity({ id: TUTORIAL_WORLD_ID, slug: 'tutorial', name: level.name });
  const create = (x: number) => manager.buildFromSlot({
    name: 'Lesson entity', rootComponentId: 'root',
    blocks: [
      { localX: 0, localY: 0, localZ: 0, size: 1, entityId: 'root', block: BlockTypes.COLOR_BLOCK, color: 0xff0000 },
      { localX: 1, localY: 0, localZ: 0, size: 1, entityId: 'arm', block: BlockTypes.COLOR_BLOCK, color: 0x00ff00 },
    ],
    childEntities: [{ id: 'arm', parentId: 'root', pivot: [1.5, 0.5, 0.5] }],
    scripts: [{ id: 'root', code: 'self.setName("Tutorial");', language: 'assemblyscript' }],
    enabled: [{ id: 'root', enabled: false }],
  }, new THREE.Vector3(x, 20, 1024), null, false);
  const active = create(8192), dormant = create(16000);
  assert.ok(active && dormant);
  manager.unloadContraption(dormant);
  assert.equal(manager.contraptions.length, 1);
  assert.equal(manager.saveEntitiesToStorage(), true);
  const saved = captureTutorialLevel(storage, level);
  assert.equal(saved.entities.entities.length, 2);
  const restoredStorage = createTutorialStorage(saved);
  const restored = new ContraptionManager(new THREE.Scene(), null, null, null, restoredStorage);
  restored.setWorldIdentity({ id: TUTORIAL_WORLD_ID, slug: 'tutorial', name: level.name });
  try {
    assert.equal(restored.loadEntitiesFromStorage(), 2);
    for (const entity of restored.contraptions) {
      assert.equal(entity.getNodeScript('root'), 'self.setName("Tutorial");');
      assert.equal(entity.entityNodes.get('arm')?.parentId, 'root');
      assert.equal(entity.blocks.length, 2);
    }
  } finally {
    for (const entity of [...manager.contraptions, ...restored.contraptions]) entity.dispose();
  }
});

test('tutorial renders exactly 25 by 25 course chunks regardless of player movement or settings', () => {
  const world = new World(new THREE.Scene(), level.generator.seed, null, level.generator.version);
  configureTutorialTerrain(world, level.spawn);
  world.updateChunksAround(8190, 561, false);
  const expected = new Set<string>();
  // The window extends ahead far enough to include the final driving lane.
  const centerX = 503, centerZ = 36;
  for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) {
    expected.add(`${(centerX + dx + 1024) % 1024},${(centerZ + dz + 128) % 128}`);
  }
  assert.equal(world.activeChunkKeys.size, 625);
  assert.deepEqual(world.activeChunkKeys, expected);
  for (const distance of [4, 8, 16]) {
    world.setRenderDistance(distance);
    assert.equal(world.renderDistance, 12);
    assert.equal(world.renderDistanceZ, 12);
    assert.equal(world.setDistantSurfaceEnabled(true), false);
    for (const [x, z] of [[0, 0], [16000, 2000], [8190 + 400, 561 + 400]]) {
      world.updateChunksAround(x, z, false);
      assert.deepEqual(world.activeChunkKeys, expected);
    }
  }
  assert.equal(world.distantSurface.mesh.visible, false);
  assert.equal(world.distantSurface.loadedZones.size, 0);
  // A saved spawn close to either torus seam still gets the full square.
  configureTutorialTerrain(world, { ...level.spawn, x_cm: 0, z_cm: 0 });
  world.updateChunksAround(5000, 500, false);
  assert.equal(world.activeChunkKeys.size, 625);
  assert.ok(world.activeChunkKeys.has('1004,117'));
  assert.ok(world.activeChunkKeys.has('4,13'));
  assert.equal(world.activeChunkKeys.has('5,1'), false);
});

test('tutorial routing preserves the regular world and omits credentials and online panels', () => {
  const entered = tutorialDestination('https://example.com/space/app/?world=nature&panel=market&token=secret#token=secret', true);
  const url = new URL(entered);
  assert.equal(isTutorialRoute(url.search), true);
  assert.equal(url.searchParams.get('world'), 'nature');
  assert.equal(url.searchParams.has('token'), false);
  assert.equal(url.searchParams.has('panel'), false);
  assert.equal(url.hash, '');
  assert.equal(tutorialDestination(entered, false), 'https://example.com/space/app/?world=nature');
  assert.equal(isTutorialRoute('?world=tutorial'), false);
  assert.throws(() => parseTutorialLevel({ ...level, version: 99 }), /unsupported/);
  assert.throws(() => parseTutorialLevel({ ...level, generator: { seed: 42, version: 1 } }), /unsupported/);
});

test('tutorial exports airborne spawn positions above the voxel terrain ceiling', () => {
  const spawn = { ...level.spawn, y_cm: 35000, yaw_q15: -32768 };
  const base = parseTutorialLevel({ ...level, spawn });
  const saved = captureTutorialLevel(createTutorialStorage(base), base);
  const session = createTutorialSession(parseTutorialLevel(JSON.parse(JSON.stringify(saved))));
  assert.equal(session.player.start_y_cm, spawn.y_cm);
  assert.equal(session.player.start_yaw_q15, spawn.yaw_q15);
  for (const invalidSpawn of [
    { ...spawn, y_cm: Infinity },
    { ...spawn, y_cm: 10_000_001 },
  ]) {
    assert.throws(() => parseTutorialLevel({ ...level, spawn: invalidSpawn }), /unsupported/);
  }
});

test('saving after movement preserves the fixed spawn position and direction on every entry', async () => {
  for (const pitch_q15 of [undefined, 1698]) {
    const base = parseTutorialLevel({
      ...level, spawn: { x_cm: 819000, y_cm: 1700, z_cm: 56100, yaw_q15: 18151, pitch_q15 },
    });
    let saved = base;
    for (const yaw_q15 of [-32768, 0, 16384, 32767]) {
      const session = createTutorialSession(saved);
      await session.player_position_remote.save({
        x_cm: 816699, y_cm: 35000, z_cm: 56859, yaw_q15, pitch_q15: -1000,
      });
      saved = captureTutorialLevel(createTutorialStorage(saved), saved);
      assert.deepEqual(saved.spawn, base.spawn);
      const reentered = createTutorialSession(parseTutorialLevel(JSON.parse(JSON.stringify(saved))));
      const pose = resolveInitialPlayerPose(reentered.player, () => assert.fail('tutorial direction must not be random'));
      assert.equal(pose.yaw, (base.spawn.yaw_q15 / 32767) * Math.PI);
      assert.deepEqual([pose.x, pose.y, pose.z], [8190, 17, 561]);
    }
  }
  assert.throws(() => parseTutorialLevel({ ...level, spawn: { ...level.spawn, yaw_q15: 32768 } }), /unsupported/);
});

test('tutorial entry never contacts APIs and shares only the normal backpack storage', async t => {
  const original = new Map<string, PropertyDescriptor | undefined>();
  const set = (key: string, value: unknown) => {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  t.after(() => {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const values = new Map<string, string>();
  const shared = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const before = loadBackpack(shared);
  addInventoryItem(before.inventories, 'colorset', { kind: 'colorset', name: 'Shared palette', colors: Array(9).fill('#112233') });
  saveBackpack(before.inventories, 'colorset', shared);
  const gate = { hidden: false, style: { display: '' } };
  set('document', { getElementById: (id: string) => id === 'space-entry-gate' ? gate : null });
  set('window', { location: { href: 'https://example.com/?tutorial=1' } });
  set('localStorage', shared);
  set('indexedDB', undefined);
  set('fetch', () => assert.fail('tutorial must not call fetch'));
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'current-player' })).toString('base64url')}.signature`;
  shared.setItem('token', token);
  rememberSpacePlayerName({ user_id: 'current-player', username: 'Tutorial Player' }, token, shared);
  const session = createTutorialSession(level);
  assert.equal(session.player.username, 'Tutorial Player');
  assert.equal(session.token, '');
  assert.equal(session.terrain_edit_remote, null);
  assert.equal(session.surface_snapshot_remote, null);
  assert.equal(session.latency_monitor, null);
  await session.player_position_remote.save({ x_cm: 0, y_cm: 0, z_cm: 0, yaw_q15: 0 });
  await enterTutorialSpace(async (_session, backpackStorage, worldStorage) => {
    assert.equal(_session.player.username, 'Tutorial Player');
    assert.ok(backpackStorage);
    assert.notEqual(worldStorage, backpackStorage);
    const backpack = loadBackpack(backpackStorage);
    assert.ok(backpack.inventories.colorset.items.some(item => item?.name === 'Shared palette'));
    addInventoryItem(backpack.inventories, 'colorset', { kind: 'colorset', name: 'From tutorial', colors: Array(9).fill('#334455') });
    assert.equal(saveBackpack(backpack.inventories, 'colorset', backpackStorage), true);
    worldStorage.setItem('temporary-world-change', 'only in memory');
  });
  assert.equal(gate.hidden, true);
  assert.equal(shared.getItem('temporary-world-change'), null);
  assert.ok(loadBackpack(shared).inventories.colorset.items.some(item => item?.name === 'From tutorial'));
});
