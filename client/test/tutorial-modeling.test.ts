import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { ModelingTool } from '../src/engine/controls/ModelingTool.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { captureTutorialLevel, createTutorialStorage, parseTutorialLevel, TUTORIAL_WORLD_ID } from '../src/bootstrap/TutorialLevel.ts';
import { createLessonWorld } from './tutorial-fixtures.ts';
import { getTutorialTerrainCenter, TUTORIAL_CHUNK_RADIUS } from '../src/bootstrap/TutorialTerrain.ts';
import { tutorialVehicleStation, tutorialLessonHint, tutorialFinishPosition, tutorialModelingOrigin, tutorialModelingAnchor,
  TUTORIAL_CHASSIS_ENTITY_ID, TUTORIAL_MODELING_EXAMPLE_ID, TUTORIAL_RAMP_DIMENSIONS, TUTORIAL_RAMP_POSITION,
  TUTORIAL_RAMP_ROTATION_Z } from '../src/tutorial/TutorialCourse.ts';
import level from '../src/tutorial/tutorial-level.json' with { type: 'json' };

function fixture(t: test.TestContext) {
  const origin = tutorialModelingOrigin(), scene = new THREE.Scene();
  const { world, storage } = createLessonWorld(scene,
    { minX: origin.x, maxX: origin.x + 4, minZ: origin.z, maxZ: origin.z + 8 });
  const manager = new ContraptionManager(scene, world, null, null, storage);
  manager.setWorldIdentity({ id: TUTORIAL_WORLD_ID, slug: 'tutorial', name: level.name });
  assert.equal(manager.loadEntitiesFromStorage(), 1);
  assert.equal(manager.contraptions[0].publicId, TUTORIAL_CHASSIS_ENTITY_ID);
  t.after(() => { for (const entity of manager.contraptions) entity.dispose(); });
  return { world, manager, storage };
}

test('Modeling starts with a marked terrain block and a finished terrain decoration beside it', t => {
  const { world } = fixture(t);
  const practice = tutorialModelingAnchor(), anchor = tutorialModelingAnchor(true);
  assert.equal(world.getBlockColor(practice.x, practice.y, practice.z), 0x3bc1f2);
  assert.deepEqual(world.terrainDecorations.atAnchor(practice.x, practice.y, practice.z), []);
  for (const origin of [tutorialModelingOrigin(), tutorialModelingOrigin(true)]) {
    for (let x = origin.x; x < origin.x + 4; x++) for (let z = origin.z; z < origin.z + 4; z++) {
      assert.equal(world.getBlock(x, origin.y, z), BlockTypes.COLOR_BLOCK);
    }
  }
  const [example] = world.terrainDecorations.atAnchor(anchor.x, anchor.y, anchor.z);
  assert.equal(example.id, TUTORIAL_MODELING_EXAMPLE_ID);
  assert.deepEqual(example.scale, [...TUTORIAL_RAMP_DIMENSIONS]);
  assert.deepEqual(example.position, [...TUTORIAL_RAMP_POSITION]);
  const rotation = new THREE.Quaternion().fromArray(example.rotation!);
  const euler = new THREE.Euler().setFromQuaternion(rotation, 'XYZ');
  assert.ok(Math.abs(THREE.MathUtils.radToDeg(euler.z) - TUTORIAL_RAMP_ROTATION_Z) < 1e-8);
  world.terrainDecorationMeshes.sync(null);
  const hit = world.terrainDecorationMeshes.raycast(new THREE.Vector3(anchor.x, anchor.y + 5, anchor.z + 1),
    new THREE.Vector3(0, -1, 0), 5, false);
  assert.equal(hit?.decoration.id, example.id);
});

test('following the Modeling lesson edits terrain and saves through the tutorial authoring flow', t => {
  const { world, manager, storage } = fixture(t);
  const anchor = tutorialModelingAnchor(), exampleAnchor = tutorialModelingAnchor(true);
  const originalExample = world.terrainDecorations.atAnchor(exampleAnchor.x, exampleAnchor.y, exampleAnchor.z);
  let unlocks = 0;
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, .1, 1000);
  const aim = new THREE.Vector3(anchor.x + 0.5, anchor.y + 1, anchor.z + 0.5);
  camera.position.copy(aim).add(new THREE.Vector3(4, 5, -4));
  camera.lookAt(aim);
  camera.updateMatrixWorld(true);
  const controller = Object.assign(Object.create(PlayerController.prototype), {
    _activeTool: SpecialTool.MODELING, world, contraptions: manager, camera,
    physics: { getEyePosition: () => camera.position.clone() }, selectedColor: 0xc5cbd6, selectedMaterialId: 0,
    sceneRenderer: { renderer: { domElement: { getBoundingClientRect: () => ({ width: 1024, height: 768 }) } } },
    ui: {}, unlock() { unlocks++; },
  });
  const tool = new ModelingTool(controller);
  t.after(() => tool.deactivate());
  tool.update(controller.performAimRaycast('all'));
  assert.deepEqual(tool.placement?.target, { terrain: anchor });
  assert.equal(tool.beginCreation({ clientX: 0, clientY: 0 }), true);
  assert.equal(tool.updateCreation({ clientX: 120, clientY: 80 }), true, 'RMB dragging draws a custom footprint');
  assert.equal(tool.endCreation(), true, 'releasing RMB creates and selects the panel');
  assert.deepEqual(tool.getSelection()?.terrain, anchor);
  assert.equal(tool.openPrecision(), true, 'Escape enables numeric editing');
  assert.equal(unlocks, 1);
  assert.equal(tool.change({ scale: [...TUTORIAL_RAMP_DIMENSIONS] }), true);
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1),
    THREE.MathUtils.degToRad(TUTORIAL_RAMP_ROTATION_Z)).toArray();
  assert.equal(tool.change({ rotation, position: [...TUTORIAL_RAMP_POSITION] }), true);
  const slope = tool.getSelection()!.value;
  assert.deepEqual(slope.scale, [...TUTORIAL_RAMP_DIMENSIONS]);
  assert.ok(new THREE.Quaternion().fromArray(slope.rotation!).angleTo(new THREE.Quaternion().fromArray(rotation)) < 1e-7);
  assert.equal(world.getBlock(anchor.x, anchor.y, anchor.z), BlockTypes.COLOR_BLOCK);
  assert.equal(manager.contraptions.length, 1);
  assert.deepEqual(world.terrainDecorations.atAnchor(exampleAnchor.x, exampleAnchor.y, exampleAnchor.z), originalExample);

  world.flushPersistedEdits();
  const saved = captureTutorialLevel(storage, parseTutorialLevel(level));
  assert.ok(saved.terrain.decorations?.some(value => value.id === slope.id));
  const next = createTutorialStorage(saved);
  const restored = new World(new THREE.Scene(), level.generator.seed, { worldId: TUTORIAL_WORLD_ID, storage: next }, level.generator.version);
  assert.deepEqual(restored.terrainDecorations.atAnchor(anchor.x, anchor.y, anchor.z),
    world.terrainDecorations.atAnchor(anchor.x, anchor.y, anchor.z));
  assert.deepEqual(fixture(t).world.terrainDecorations.atAnchor(anchor.x, anchor.y, anchor.z), []);
});

test('Modeling follows the driving lane and its sign, subject and finish fit the fixed terrain window', () => {
  const drive = tutorialVehicleStation(12), modeling = tutorialVehicleStation(13);
  assert.ok(modeling.x + 2 < drive.x - 33, 'the work pad does not block the driving lane');
  const origin = tutorialModelingOrigin(), finish = tutorialFinishPosition(), sign = tutorialLessonHint(13);
  assert.ok(finish.x < origin.x);
  const center = getTutorialTerrainCenter(level.spawn);
  const minX = (Math.floor(center.x / 16) - TUTORIAL_CHUNK_RADIUS) * 16;
  const minZ = (Math.floor(center.z / 16) - TUTORIAL_CHUNK_RADIUS) * 16;
  const size = (TUTORIAL_CHUNK_RADIUS * 2 + 1) * 16;
  for (const point of [origin, { x: origin.x + 4, z: origin.z + 8 }, finish,
    { x: sign.x - 10, z: sign.z }, { x: sign.x + 10, z: sign.z }]) {
    assert.ok(point.x >= minX && point.x < minX + size && point.z >= minZ && point.z < minZ + size);
  }
  assert.ok(level.terrain.micro.some(([x, , z]) => z === Math.round(sign.z * 8) && Math.abs(x / 8 - sign.x) < 10));
});
