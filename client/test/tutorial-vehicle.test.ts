import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionPhysics } from '@entropydrop/space-engine/physics/ContraptionPhysics.ts';
import { computeSelectionCells } from '../src/engine/controls/SelectorShapes.ts';
import { setScript } from '../../engine/test/script-helpers.ts';
import level from '../src/tutorial/tutorial-level.json' with { type: 'json' };
import { tutorialChassisBounds, tutorialChassisWheelMounts, tutorialWheelBounds, tutorialRotationBounds } from '../src/tutorial/TutorialCourse.ts';
import { getTutorialTerrainCenter, TUTORIAL_CHUNK_RADIUS } from '../src/bootstrap/TutorialTerrain.ts';
import { nearbyTutorialSelectionChapter, tutorialSelectionMarkers } from '../src/tutorial/TutorialSelectionMarkers.ts';

// Code typed by the player from the lesson 11 world sign.
const wheelCode = 'self.setSpinYAxisRPM(30)';
const reverseWheelCode = 'self.setSpinYAxisRPM(-30)';
const wheelBounds = tutorialWheelBounds();
const wheelCells = computeSelectionCells('cylinder',
  { x: wheelBounds.minX * 8, y: wheelBounds.maxY * 8 - 1, z: wheelBounds.maxZ * 8 - 1 },
  { x: wheelBounds.maxX * 8 - 1, y: wheelBounds.minY * 8, z: wheelBounds.minZ * 8 }, true);
const chassisBounds = tutorialChassisBounds();
const chassisCells = level.terrain.micro.filter(([x, y, z]) =>
  x >= chassisBounds.minX * 8 && x < chassisBounds.maxX * 8
  && y >= chassisBounds.minY * 8 && y < chassisBounds.maxY * 8
  && z >= chassisBounds.minZ * 8 && z < chassisBounds.maxZ * 8);

test('tutorial A/B labels point to the authored micro corners and surviving practice geometry', () => {
  const cells = new Map(level.terrain.micro.map(([x, y, z, color]) => [`${x},${y},${z}`, color]));
  for (const marker of tutorialSelectionMarkers) {
    assert.equal(cells.get(`${marker.x * 8},${marker.y * 8},${marker.z * 8}`), marker.color);
    const { x, y, z } = marker.subject;
    assert.ok(cells.has(`${x * 8},${y * 8},${z * 8}`), 'labels are gated on actual subject voxels');
  }
  assert.equal(nearbyTutorialSelectionChapter({ x: 8018.4375, z: 595 }), 9,
    'the rear corner of the car must not show markers for the neighboring rotation exercise');
  assert.equal(nearbyTutorialSelectionChapter({ x: wheelBounds.minX, z: wheelBounds.minZ }), 10);
  assert.equal(nearbyTutorialSelectionChapter({ x: 8190, z: 561 }), null);
});

test('the complete off-road body includes both selector corners and four unobstructed wheel mounting faces', () => {
  assert.ok(chassisCells.length > 1000, 'the assembly subject is a detailed vehicle body');
  const blue = chassisCells.filter(cell => cell[3] === 0x3bc1f2);
  const green = chassisCells.filter(cell => cell[3] === 0x5af23b);
  assert.equal(blue.length, 1, 'the blue selector corner is one microcell');
  assert.equal(green.length, 1, 'the green selector corner is one microcell');
  for (const divisor of [1, 8]) for (const cell of chassisCells) for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.floor(cell[axis] / divisor) >= Math.floor(blue[0][axis] / divisor)
      && Math.floor(cell[axis] / divisor) <= Math.floor(green[0][axis] / divisor),
    'clicking the two microcells encloses every vehicle voxel in micro and standard mode');
  }
  const keys = new Set(chassisCells.map(cell => cell.slice(0, 3).join(',')));
  const reached = new Set<string>(), queue = [chassisCells[0].slice(0, 3)];
  while (queue.length) {
    const [x, y, z] = queue.pop()!, key = `${x},${y},${z}`;
    if (!keys.has(key) || reached.has(key)) continue;
    reached.add(key);
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) queue.push([x+dx,y+dy,z+dz]);
  }
  assert.equal(reached.size, chassisCells.length, 'all bodywork and both colored corners are connected to the chassis');
  const mounts = tutorialChassisWheelMounts();
  assert.equal(mounts.length, 4);
  for (const mount of mounts) {
    const pad = chassisCells.find(([x, y, z]) => x === mount.x * 8 && y === mount.y * 8
      && z === (mount.side < 0 ? mount.z * 8 : mount.z * 8 - 1));
    assert.equal(pad?.[3], 0xb0b8c1, 'each wheel has a visible mounting pad at its axle height');
    const wheelCenterZ = mount.z + mount.side * (wheelBounds.maxY - wheelBounds.minY) / 2;
    assert.ok(wheelCenterZ - .25 >= chassisBounds.minZ && wheelCenterZ + .25 <= chassisBounds.maxZ,
      'the tires sit under the wide fenders');
    for (const [x, y, z] of chassisCells) {
      if (z / 8 + .125 <= wheelCenterZ - .25 || z / 8 >= wheelCenterZ + .25) continue;
      const dx = Math.max(Math.abs(x / 8 + .0625 - mount.x) - .0625, 0);
      const dy = Math.max(Math.abs(y / 8 + .0625 - mount.y) - .0625, 0);
      assert.ok(Math.hypot(dx, dy) >= 1, 'bodywork clears the full rotating tire envelope');
    }
  }
  assert.ok(chassisCells.some(cell => cell[1] / 8 >= chassisBounds.minY + 2), 'the vehicle has a raised cabin');
  assert.equal(chassisCells.filter(([x, y, z]) => x / 8 >= chassisBounds.minX + 6.75
    && x / 8 < chassisBounds.minX + 8.5 && y / 8 >= chassisBounds.minY + 1.25
    && z / 8 >= chassisBounds.minZ + 1.25 && z / 8 < chassisBounds.minZ + 3).length, 0,
  'the pickup has an open cargo bed behind its double cab');
});

test('the default cylinder selects the entire flat tutorial wheel while leaving its corner markers', () => {
  const micro = new Map(level.terrain.micro.map(c => [c.slice(0, 3).join(','), c]));
  const selected = wheelCells.map(p => micro.get(`${p.x},${p.y},${p.z}`));
  const blocks = selected.filter((cell): cell is NonNullable<typeof cell> => !!cell);
  assert.equal(wheelCells.length, 752);
  assert.ok(blocks.length > 400 && blocks.length < wheelCells.length, 'the cylinder contains a wheel with open spoke windows');
  assert.equal(blocks.filter(c => c[3] === 0x3bc1f2 || c[3] === 0x5af23b).length, 0);
  assert.equal(wheelBounds.maxY - wheelBounds.minY, .5, 'the wheel lies flat on the ground');
  const face = (y: number) => blocks.filter(c => c[1] === y).map(([x, , z, color]) => [x, z, color]);
  const bottom = face(wheelBounds.minY * 8), top = face(wheelBounds.maxY * 8 - 1);
  assert.ok(top.length < bottom.length, 'the inside face has a hollow barrel instead of flush spokes');
  const centerX = (wheelBounds.minX + wheelBounds.maxX) * 4;
  const centerZ = (wheelBounds.minZ + wheelBounds.maxZ) * 4;
  assert.ok(top.every(([x, z]) => Math.hypot(x + .5 - centerX, z + .5 - centerZ) >= 5.25),
    'the inner half is recessed all the way to the lower spoke face');
  assert.ok(bottom.some(c => c[2] === 0xe4e8ed), 'light spokes stand out from the tire');
  const connected = new Set<string>();
  const keys = new Set(blocks.map(c => c.slice(0, 3).join(',')));
  const queue = [blocks[0].slice(0, 3)];
  while (queue.length) {
    const [x, y, z] = queue.pop()!, key = `${x},${y},${z}`;
    if (!keys.has(key) || connected.has(key)) continue;
    connected.add(key);
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) queue.push([x+dx,y+dy,z+dz]);
  }
  assert.equal(connected.size, blocks.length, 'the hub, spokes and tire form a connected wheel');
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

test('micro rotation practice matches the horizontal cylinder after rotating the selector', () => {
  const b = tutorialRotationBounds();
  const inside = (cell: number[], scale: number) => cell[0] >= b.minX * scale && cell[0] < b.maxX * scale
    && cell[1] >= b.minY * scale && cell[1] < b.maxY * scale && cell[2] >= b.minZ * scale && cell[2] < b.maxZ * scale;
  assert.equal(level.terrain.standard.filter(c => inside(c, 1)).length, 0);
  const cells = level.terrain.micro.filter(c => inside(c, 8));
  const blue = cells.filter(c => c[3] === 0x3bc1f2), green = cells.filter(c => c[3] === 0x5af23b);
  assert.equal(blue.length, 1);
  assert.equal(green.length, 1);
  const point = (c: number[]) => ({ x: c[0], y: c[1], z: c[2] });
  const selected = computeSelectionCells('cylinder', point(blue[0]), point(green[0]), true, 'z');
  assert.deepEqual(new Set(selected.map(p => `${p.x},${p.y},${p.z}`)),
    new Set(cells.filter(c => c[3] === 0xc5cbd6).map(c => c.slice(0, 3).join(','))));
});

test('outward-facing spoked wheels with reversed opposite-side RPM drive the lesson 09 vehicle', async t => {
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
  assert.equal(await setScript(wheel, reverseWheelCode), true);
  const reverseSlot = wheel.serializeSubtree(wheel.rootComponentId);
  assert.ok(reverseSlot);

  const chassisBlocks = chassisCells.map(([x, y, z, color]) => ({
    localX: x / 8 - chassisBounds.minX, localY: y / 8 - chassisBounds.minY,
    localZ: z / 8 - chassisBounds.minZ, size: .125, block: 1, color,
  }));
  const frameOrigin = new THREE.Vector3(0, 2, 0);
  const chassis = new Contraption(2, chassisBlocks, frameOrigin.clone(), scene);
  t.after(() => chassis.dispose());
  chassis.stopAllNodeScripts();
  const installedCodes = new Map<string, string>();
  for (const mount of tutorialChassisWheelMounts()) {
    const upright = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -mount.side * Math.PI / 2);
    const rotatedWheelPivot = new THREE.Vector3().fromArray(wheel.getComponentApi(wheel.rootComponentId)!.getPivot()).applyQuaternion(upright);
    const wheelCenter = frameOrigin.clone().add(new THREE.Vector3(
      mount.x - chassisBounds.minX, mount.y - chassisBounds.minY,
      mount.z - chassisBounds.minZ + mount.side * .25));
    const installed = chassis.installEntitySlot(mount.side < 0 ? slot : reverseSlot,
      chassis.rootComponentId, wheelCenter.sub(rotatedWheelPivot), null, upright);
    assert.equal(installed.ok, true);
    const node = [...chassis.entityNodes.values()].at(-1)!;
    installedCodes.set(node.id, mount.side < 0 ? wheelCode : reverseWheelCode);
  }
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
    assert.equal(chassis.getNodeScript(node.id), installedCodes.get(node.id));
    assert.ok(node.localAngularVelocity.length() > 3);
  }
  assert.ok(chassis.position.x < start.x - 5, 'the assembled vehicle continues forward along the tutorial');
  assert.ok(chassis.position.z > start.z + .75, 'the vehicle follows the course toward positive Z');
  assert.ok(Math.abs(chassis.position.z - start.z - (start.x - chassis.position.x) * 205 / 1200) < 1,
    'the car stays inside the seven-metre-wide straight test lane');
  const lowestPoint = chassis.getVisualWorldBounds().min.y;
  assert.ok(lowestPoint > -.2 && lowestPoint < .3, 'the completed car stays on its wheels');
  chassis.stopAllNodeScripts();
  assert.equal(chassis.isPhysicsSimulationEnabled(), false);
  assert.equal(chassis.velocity.lengthSq(), 0);
});
