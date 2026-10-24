import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionPhysics } from '@entropydrop/space-engine/physics/ContraptionPhysics.ts';
import { computeSelectionCells } from '../src/engine/controls/SelectorShapes.ts';
import { setScript } from '../../engine/test/script-helpers.ts';
import level from '../src/tutorial/tutorial-level.json' with { type: 'json' };
import { tutorialWheelBounds } from '../src/tutorial/TutorialCourse.ts';
import { getTutorialTerrainCenter, TUTORIAL_CHUNK_RADIUS } from '../src/bootstrap/TutorialTerrain.ts';

// Code typed by the player from the lesson 11 world sign.
const wheelCode = 'self.setLocalSpin([0, 1, 0], 30);';
const mirroredWheelCode = 'self.setLocalSpin([0, 1, 0], -30);';
const wheelBounds = tutorialWheelBounds();
const wheelCells = computeSelectionCells('cylinder',
  { x: wheelBounds.minX * 8, y: wheelBounds.maxY * 8 - 1, z: wheelBounds.maxZ * 8 - 1 },
  { x: wheelBounds.maxX * 8 - 1, y: wheelBounds.minY * 8, z: wheelBounds.minZ * 8 }, true);

test('the default cylinder selects the entire flat tutorial wheel while leaving its corner markers', () => {
  const micro = new Map(level.terrain.micro.map(c => [c.slice(0, 3).join(','), c]));
  const selected = wheelCells.map(p => micro.get(`${p.x},${p.y},${p.z}`));
  assert.equal(wheelCells.length, 752);
  assert.ok(selected.every(Boolean), 'the complete flat wheel fits the default Y-axis cylinder');
  assert.equal(selected.filter(c => c![3] === 0x3bc1f2 || c![3] === 0x5af23b).length, 0);
  assert.equal(wheelBounds.maxY - wheelBounds.minY, .5, 'the wheel lies flat on the ground');
  const gold = selected.filter(c => c![3] === 0xf2a93b);
  const darkHub = selected.filter(c => c![3] === 0x303846);
  assert.ok(gold.length > 0 && gold.every(c => c![1] === wheelBounds.maxY * 8 - 1),
    'only the front (+Y) face has a gold hub and spoke');
  assert.ok(darkHub.length > 0 && darkHub.every(c => c![1] === wheelBounds.minY * 8),
    'the back (-Y) face has a dark hub');
  assert.ok(gold.some(c => c![0] > (wheelBounds.minX + wheelBounds.maxX) * 4 + 4),
    'an asymmetric spoke makes spin direction visible');
  const center = getTutorialTerrainCenter(level.spawn);
  const minX = (Math.floor(center.x / 16) - TUTORIAL_CHUNK_RADIUS) * 16;
  const minZ = (Math.floor(center.z / 16) - TUTORIAL_CHUNK_RADIUS) * 16;
  const size = (TUTORIAL_CHUNK_RADIUS * 2 + 1) * 16;
  for (const [divisor, terrain] of [[1, level.terrain.standard], [8, level.terrain.micro]] as const) {
    for (const c of terrain) {
      assert.ok(c[0] / divisor >= minX && c[0] / divisor < minX + size);
      assert.ok(c[2] / divisor >= minZ && c[2] / divisor < minZ + size);
    }
  }
  assert.equal(level.entities.entities.length, 0, 'the player supplies the chassis from lesson 09');
});

test('outward-facing wheels with opposite spin signs drive the actual lesson 09 chassis', async t => {
  const scene = new THREE.Scene();
  const selected = new Set(wheelCells.map(p => `${p.x},${p.y},${p.z}`));
  const wheelBlocks = level.terrain.micro
    .filter(([x, y, z]) => selected.has(`${x},${y},${z}`))
    .map(([x, y, z, color]) => ({ localX: x / 8 - wheelBounds.minX, localY: y / 8 - wheelBounds.minY,
      localZ: z / 8 - wheelBounds.minZ, size: 0.125, block: 1, color }));
  const wheel = new Contraption(1, wheelBlocks, new THREE.Vector3(0, 4, 0), scene);
  const wheelStart = wheel.position.clone();
  t.after(() => wheel.dispose());
  assert.equal(wheel.setBodyType('kinematic'), 'kinematic', 'the player first changes Type in the context menu');
  assert.equal(await setScript(wheel, wheelCode), true);
  wheel.enableAllNodeScripts();
  for (let i = 0; i < 5; i++) wheel.update(0.05, null, { gravity: [0, -18, 0], world: null });
  assert.equal(wheel.bodyType, 'kinematic');
  assert.ok(Math.abs(wheel.quaternion.y) > 0.2, 'the standalone wheel spins around its flat Y axis');
  assert.deepEqual(wheel.position.toArray(), wheelStart.toArray(), 'the menu-selected kinematic body ignores gravity');
  wheel.stopAllNodeScripts();
  const slot = wheel.serializeSubtree(wheel.rootComponentId);
  assert.ok(slot);

  const chassisBlocks = level.terrain.standard
    .filter(([x, y, z]) => x >= 8011 && x <= 8016 && y === 24 && z >= 589 && z <= 590)
    .map(([x, y, z, block, color]) => ({ localX: x - 8011, localY: 0, localZ: z - 589, size: 1, block, color }));
  assert.equal(chassisBlocks.length, 12);
  const chassis = new Contraption(2, chassisBlocks, new THREE.Vector3(0, 2, 0), scene);
  t.after(() => chassis.dispose());
  chassis.stopAllNodeScripts();
  const upright = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const flipped = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI).multiply(upright);
  const expectedScripts = new Map<string, string>();
  for (const x of [0.5, 3.5]) for (const z of [-0.5, 2]) {
    const rotation = z < 0 ? flipped : upright;
    const code = z < 0 ? mirroredWheelCode : wheelCode;
    const item = { ...slot, scripts: slot.scripts.map(script => ({ ...script, code })) };
    const front = new THREE.Vector3(0, 1, 0).applyQuaternion(rotation);
    assert.ok(front.dot(new THREE.Vector3(0, 0, Math.sign(z))) > .999, 'both gold faces point outward');
    const installed = chassis.installEntitySlot(item, chassis.rootComponentId, new THREE.Vector3(x, 3, z), null, rotation);
    assert.equal(installed.ok, true);
    expectedScripts.set(installed.rootId!, code);
  }
  assert.equal([...expectedScripts.values()].filter(code => code === mirroredWheelCode).length, 2);
  // The wrench aligns the car with the lane. Its chassis has no drive script.
  chassis.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(27, 158));
  chassis.updateTransform();
  chassis.enableAllNodeScripts();
  await chassis.scriptRuntimeClient.ready();
  const physics = new ContraptionPhysics({
    getBlock: (_x, y, _z) => y < 0 ? 1 : 0,
    raycast: point => ({ hit: true, distance: point.y }),
    raycastMicro: () => ({ hit: false }),
  });
  const start = chassis.position.clone();
  for (let i = 0; i < 100; i++) {
    chassis.update(0.05, null, { gravity: [0, -18, 0], world: null });
    physics.update(chassis, 0.05);
  }
  assert.equal(chassis.bodyType, 'dynamic', 'only the wheels become kinematic');
  assert.equal(chassis.entityNodes.size, 5);
  assert.equal(chassis.nodeScriptErrors.size, 0);
  assert.equal(chassis.getNodeScript(chassis.rootComponentId).trim(), '');
  for (const node of chassis.entityNodes.values()) if (node.parentId !== null) {
    assert.equal(chassis.getNodeScript(node.id), expectedScripts.get(node.id));
    assert.ok(node.localAngularVelocity.length() > 3);
  }
  assert.ok(chassis.position.x < start.x - 5, 'the assembled vehicle continues forward along the tutorial');
  assert.ok(chassis.position.z > start.z + .75, 'the vehicle follows the course toward positive Z');
  assert.ok(Math.abs(chassis.position.z - start.z - (start.x - chassis.position.x) * 205 / 1200) < 1,
    'the car stays inside the seven-metre-wide straight test lane');
  assert.ok(chassis.position.y > 1 && chassis.position.y < 2, 'the car stays on its wheels');
  chassis.stopAllNodeScripts();
  assert.equal(chassis.isPhysicsSimulationEnabled(), false);
  assert.equal(chassis.velocity.lengthSq(), 0);
});
