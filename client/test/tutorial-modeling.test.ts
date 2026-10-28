import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { ModelingTool } from '../src/engine/controls/ModelingTool.ts';
import { PlayerController } from '../src/engine/controls/PlayerController.ts';
import { createTutorialStorage, parseTutorialLevel, TUTORIAL_WORLD_ID } from '../src/bootstrap/TutorialLevel.ts';
import { getTutorialTerrainCenter, TUTORIAL_CHUNK_RADIUS } from '../src/bootstrap/TutorialTerrain.ts';
import { tutorialVehicleStation, tutorialLessonHint, tutorialFinishPosition, tutorialModelingOrigin,
  TUTORIAL_MODELING_ENTITY_ID, TUTORIAL_RAMP_DIMENSIONS, TUTORIAL_RAMP_ROTATION_Z } from '../src/tutorial/TutorialCourse.ts';
import level from '../src/tutorial/tutorial-level.json' with { type: 'json' };

function fixture(t: test.TestContext) {
  const storage = createTutorialStorage(parseTutorialLevel(level));
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null, storage);
  manager.setWorldIdentity({ id: TUTORIAL_WORLD_ID, slug: 'tutorial', name: level.name });
  manager.loadEntitiesFromStorage();
  t.after(() => { for (const entity of manager.contraptions) entity.dispose(); });
  const entity = manager.contraptions.find(entity => entity.publicId === TUTORIAL_MODELING_ENTITY_ID);
  assert.ok(entity, 'the saved level loads its Modeling subject through normal persistence');
  return { manager, entity };
}

test('Modeling has an editable, stopped work pad and one finished sloping panel', t => {
  const { entity } = fixture(t);
  assert.equal(entity.canEditInternalSelection(), true);
  assert.equal(entity.isPhysicsSimulationEnabled(), false);
  assert.equal(entity.bodyType, 'kinematic');
  assert.equal(entity.getNodeScript(entity.rootComponentId), '');
  assert.equal(entity.blocks.length, 32);
  const [example] = entity.getComponentDecorations(entity.rootComponentId);
  assert.equal(entity.getDecorationCount(), 1);
  assert.deepEqual(example.scale, [...TUTORIAL_RAMP_DIMENSIONS]);
  const rotation = new THREE.Quaternion().fromArray(example.rotation!);
  const euler = new THREE.Euler().setFromQuaternion(rotation, 'XYZ');
  assert.ok(Math.abs(THREE.MathUtils.radToDeg(euler.z) - TUTORIAL_RAMP_ROTATION_Z) < 1e-8);
  const origin = tutorialModelingOrigin();
  const baseCorner = entity.entityLocalToWorld(entity.rootComponentId, new THREE.Vector3());
  assert.ok(baseCorner.distanceTo(new THREE.Vector3(origin.x, origin.y, origin.z)) < 1e-8);
  // The entire example clears the base, and its footprint leaves the other half empty.
  for (const x of [-2, 2]) for (const y of [-.125, .125]) for (const z of [-1.5, 1.5]) {
    const corner = new THREE.Vector3(x, y, z).applyQuaternion(rotation).add(new THREE.Vector3().fromArray(example.position!));
    assert.ok(corner.y > 1 && corner.z >= 4.5 && corner.z <= 7.5);
  }
});

test('following the Modeling lesson creates a slope and a fresh tutorial resets the edit', t => {
  const { manager, entity } = fixture(t);
  let unlocks = 0;
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, .1, 1000);
  camera.position.copy(entity.position).add(new THREE.Vector3(5, 7, 5));
  camera.lookAt(entity.position);
  camera.updateMatrixWorld(true);
  const controller = Object.assign(Object.create(PlayerController.prototype), {
    contraptions: manager, camera, selectedColor: 0xc5cbd6, selectedMaterialId: 0,
    sceneRenderer: { renderer: { domElement: { getBoundingClientRect: () => ({ width: 1024, height: 768 }) } } },
    ui: {}, unlock() { unlocks++; },
  });
  const tool = new ModelingTool(controller);
  t.after(() => tool.deactivate());
  const before = structuredClone(entity.blocks);
  tool.placement = { target: { contraption: entity, componentId: entity.rootComponentId },
    value: { id: 'preview', position: [2, 1.25, 2], scale: [2, .5, 2], color: 0xc5cbd6 } };
  assert.equal(tool.beginCreation({ clientX: 0, clientY: 0 }), true);
  assert.equal(tool.updateCreation({ clientX: 120, clientY: 80 }), true, 'RMB dragging draws a custom footprint');
  assert.equal(tool.endCreation(), true, 'releasing RMB creates and selects the panel');
  assert.ok(tool.getSelection());
  assert.equal(tool.openPrecision(), true, 'Escape enables numeric editing');
  assert.equal(unlocks, 1);
  assert.equal(tool.change({ scale: [...TUTORIAL_RAMP_DIMENSIONS] }), true);
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1),
    THREE.MathUtils.degToRad(TUTORIAL_RAMP_ROTATION_Z)).toArray();
  assert.equal(tool.change({ rotation, position: [2, 2.125, 2] }), true);
  const slope = tool.getSelection()!.value;
  assert.deepEqual(slope.scale, [...TUTORIAL_RAMP_DIMENSIONS]);
  assert.ok(new THREE.Quaternion().fromArray(slope.rotation!).angleTo(new THREE.Quaternion().fromArray(rotation)) < 1e-7);
  assert.equal(entity.getDecorationCount(), 2);
  assert.deepEqual(entity.blocks, before, 'Modeling does not change collision voxels');
  assert.equal(fixture(t).entity.getDecorationCount(), 1, 're-entry restores the authored example and empty pad');
});

test('Modeling follows the driving lane and its sign, subject and finish fit the fixed terrain window', () => {
  const drive = tutorialVehicleStation(13), modeling = tutorialVehicleStation(14);
  assert.ok(modeling.x + 2 < drive.x - 33, 'the work pad does not block the driving lane');
  const origin = tutorialModelingOrigin(), finish = tutorialFinishPosition(), sign = tutorialLessonHint(14);
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
