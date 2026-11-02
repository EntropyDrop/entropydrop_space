import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { ContraptionPhysics } from '@entropydrop/space-engine/physics/ContraptionPhysics.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { computeSelectionCells } from '../src/engine/controls/SelectorShapes.ts';
import { setScript } from '../../engine/test/script-helpers.ts';
import level from '../src/tutorial/tutorial-level.json' with { type: 'json' };
import { createLessonWorld } from './tutorial-fixtures.ts';
import { TUTORIAL_WORLD_ID } from '../src/bootstrap/TutorialLevel.ts';
import { tutorialChassisBounds, tutorialChassisWheelMounts, tutorialWheelBounds, tutorialRotationBounds,
  tutorialMissingWheelMount, tutorialVehicleWorkbench, tutorialVehicleStation,
  TUTORIAL_CHASSIS_ENTITY_ID, TUTORIAL_MODELING_EXAMPLE_ID } from '../src/tutorial/TutorialCourse.ts';
import { getTutorialTerrainCenter, TUTORIAL_CHUNK_RADIUS } from '../src/bootstrap/TutorialTerrain.ts';

// Code typed by the player from the lesson 10 world sign.
const wheelCode = 'self.setSpinYAxisRPM(30)';
const reverseWheelCode = 'self.setSpinYAxisRPM(-30)';
const wheelBounds = tutorialWheelBounds();
const wheelCells = computeSelectionCells('cylinder',
  { x: wheelBounds.minX * 8, y: wheelBounds.maxY * 8 - 1, z: wheelBounds.maxZ * 8 - 1 },
  { x: wheelBounds.maxX * 8 - 1, y: wheelBounds.minY * 8, z: wheelBounds.minZ * 8 }, true);
const chassisBounds = tutorialChassisBounds();
const savedChassis = level.entities.entities.find(entity => entity.publicId === TUTORIAL_CHASSIS_ENTITY_ID)!;
const chassisCells = savedChassis.slot.blocks.filter(block => block.entityId === savedChassis.slot.rootComponentId)
  .map(block => [(block.localX + chassisBounds.minX) * 8, (block.localY + chassisBounds.minY) * 8,
    (block.localZ + chassisBounds.minZ) * 8, block.color]);

function vehicleFixture(t: test.TestContext) {
  const scene = new THREE.Scene();
  const { world, storage } = createLessonWorld(scene, tutorialVehicleWorkbench());
  const manager = new ContraptionManager(scene, world, null, null, storage);
  manager.setWorldIdentity({ id: TUTORIAL_WORLD_ID, slug: 'tutorial', name: level.name });
  assert.equal(manager.loadEntitiesFromStorage(), 2);
  manager.setEntityPersistenceMode('none');
  const chassis = manager.contraptions.find(entity => entity.publicId === TUTORIAL_CHASSIS_ENTITY_ID)!;
  assert.ok(chassis);
  t.after(() => { for (const entity of manager.contraptions) entity.dispose(); });
  return { world, manager, chassis };
}

test('chapter 11 starts with a stopped kinematic car and three correctly oriented, programmed wheels', t => {
  const { world, chassis } = vehicleFixture(t);
  assert.equal(chassis.isPhysicsSimulationEnabled(), false);
  assert.equal(chassis.bodyType, 'kinematic');
  assert.equal(chassis.useGravity, false);
  assert.equal(chassis.getNodeScript(chassis.rootComponentId), '');
  assert.equal(chassis.entityNodes.size, 4, 'only the right rear wheel remains to install');
  const children = [...chassis.entityNodes.values()].filter(node => node.parentId !== null);
  const missing = tutorialMissingWheelMount();
  assert.equal(missing.side, -1, 'the missing wheel accepts lesson 10 code without changing the RPM sign');
  for (const mount of tutorialChassisWheelMounts()) {
    const center = new THREE.Vector3(mount.x, mount.y, mount.z + mount.side * .25);
    const child = children.find(node => chassis.getEntityNodeWorldPosition(node.id).distanceTo(center) < 1e-6);
    if (mount.x === missing.x && mount.side === missing.side) {
      assert.equal(child, undefined, 'the rear right axle is empty');
      continue;
    }
    assert.ok(child, 'the other three axle pads already have wheels');
    assert.equal(chassis.getNodeBodyType(child.id), 'kinematic');
    assert.equal(chassis.getNodeScript(child.id), mount.side < 0 ? wheelCode : reverseWheelCode);
    const hollow = new THREE.Vector3(0, 1, 0).applyQuaternion(chassis.getEntityNodeWorldQuaternion(child.id));
    assert.ok(hollow.dot(new THREE.Vector3(0, 0, -mount.side)) > .999, 'the hollow face points into the car');
  }
  assert.ok(chassisCells.every(([x, y, z]) => world.microVoxels.get(x, y, z) === null), 'no terrain copy overlaps the saved car');
  const bench = tutorialVehicleWorkbench();
  for (let x = bench.minX; x < bench.maxX; x++) for (let z = bench.minZ; z < bench.maxZ; z++) {
    assert.equal(world.getBlock(x, bench.maxY - 1, z), 1, 'the installation workbench stays intact');
  }
  chassis.setNodeScriptDraft(children[0].id, '');
  chassis.setBodyType('dynamic');
  const fresh = vehicleFixture(t).chassis;
  assert.equal(fresh.bodyType, 'kinematic', 're-entry resets the practice car');
  assert.equal(fresh.entityNodes.size, 4);
  assert.notEqual(fresh.getNodeScript(children[0].id), '', 're-entry restores the preconfigured wheel code');
});

test('the pickup has connected bodywork and four clear wheel mounts', () => {
  assert.ok(chassisCells.length > 1000, 'the assembly subject is a detailed vehicle body');
  const keys = new Set(chassisCells.map(cell => cell.slice(0, 3).join(',')));
  const reached = new Set<string>(), queue = [chassisCells[0].slice(0, 3)];
  while (queue.length) {
    const [x, y, z] = queue.pop()!, key = `${x},${y},${z}`;
    if (!keys.has(key) || reached.has(key)) continue;
    reached.add(key);
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) queue.push([x+dx,y+dy,z+dz]);
  }
  assert.equal(reached.size, chassisCells.length, 'all bodywork remains connected without floating selection helpers');
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
  assert.equal(wheelBounds.maxY - wheelBounds.minY, .5, 'the suspended wheel remains horizontal');
  assert.equal(wheelBounds.minY - 17, 1, 'the wheel can be selected from ground level');
  const motor = tutorialVehicleStation(10), assembly = tutorialVehicleWorkbench();
  assert.ok(wheelBounds.minX > motor.x && motor.x > chassisBounds.maxX
    && chassisBounds.minX > assembly.minX, 'wheel creation and programming precede installation');
  const markers = level.terrain.micro.filter(([x, y, z, color]) =>
    (color === 0x3bc1f2 || color === 0x5af23b)
    && x >= wheelBounds.minX * 8 && x < wheelBounds.maxX * 8
    && y >= wheelBounds.minY * 8 && y < wheelBounds.maxY * 8
    && z >= wheelBounds.minZ * 8 && z < wheelBounds.maxZ * 8);
  assert.equal(markers.length, 2, 'both colored selection corners move with the chapter 09 wheel');
  assert.equal(level.terrain.micro.filter(([x, y, z]) =>
    x >= wheelBounds.minX * 8 && x < wheelBounds.maxX * 8 && y >= 17 * 8
    && z >= wheelBounds.minZ * 8 && z < wheelBounds.maxZ * 8).length, blocks.length + markers.length,
  'lowering the wheel leaves no old wheel or corner markers above it');
  const [blue, green] = [0x3bc1f2, 0x5af23b].map(color => markers.find(c => c[3] === color)!);
  assert.deepEqual(new Set(computeSelectionCells('cylinder',
    { x: blue[0], y: blue[1], z: blue[2] }, { x: green[0], y: green[1], z: green[2] }, true)
    .map(p => `${p.x},${p.y},${p.z}`)), new Set(wheelCells.map(p => `${p.x},${p.y},${p.z}`)));
  assert.ok(!level.terrain.standard.some(([x, y, z, block]) => block && y >= 17 && y < 19
    && x + 1 > wheelBounds.minX && x < wheelBounds.maxX && z + 1 > wheelBounds.minZ && z < wheelBounds.maxZ),
  'the old landing workbench no longer intersects the wheel selection');
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
  assert.deepEqual(new Set(level.entities.entities.map(entity => entity.publicId)),
    new Set([TUTORIAL_CHASSIS_ENTITY_ID, TUTORIAL_MODELING_EXAMPLE_ID]),
    'the car and finished example are provided; the Modeling practice pad still needs assembly');
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

test('the player programs one wheel, installs it once, then drives the completed car without more code edits', async t => {
  const { world, manager, chassis } = vehicleFixture(t);
  const controller: any = Object.assign(Object.create(PlayerController.prototype), {
    _activeTool: SpecialTool.WRENCH, contraptions: manager, world,
    ui: { showToast() {}, refresh() {},
      notifyContraptionRemoved() {}, notifyContraptionStructureChanged() {},
      openCodeEditor() { assert.fail('wheel installation must not open the editor'); } },
    sceneRenderer: { setWrenchTether() {}, clearWrenchPivotGizmo() {} }, clearSelection() {},
    saveInventoriesToLocalStorage() {}, requestLock() {},
    activateTool(this: PlayerController, tool: string) { this.activeTool = tool; },
  });
  const selected = new Set(wheelCells.map(p => `${p.x},${p.y},${p.z}`));
  const wheelBlocks = level.terrain.micro
    .filter(([x, y, z]) => selected.has(`${x},${y},${z}`))
    .map(([x, y, z, color]) => ({ localX: x / 8 - wheelBounds.minX, localY: y / 8 - wheelBounds.minY,
      localZ: z / 8 - wheelBounds.minZ, size: 0.125, block: 1, color }));
  // Use the same assembly commit as G, with the authored wheel's airborne pose.
  const wheel = manager.commitPreparedAssembly(wheelBlocks,
    new THREE.Vector3(wheelBounds.minX, wheelBounds.minY, wheelBounds.minZ))!;
  assert.ok(wheel);
  assert.equal(wheel.bodyType, 'kinematic');
  assert.equal(wheel.useGravity, false);
  assert.equal(wheel.isPhysicsSimulationEnabled(), false, 'new assemblies are stopped and ready to carry');
  assert.equal(wheel.canEditInternalSelection(), true);
  const groundPhysics = new ContraptionPhysics({
    getBlock: (_x, y, _z) => y < 17 ? 1 : 0,
    raycast: (origin, direction, maxDistance) => {
      const distance = (17 - origin.y) / direction.y;
      return direction.y < 0 && distance >= 0 && distance <= maxDistance
        ? { hit: true, distance } : { hit: false };
    },
    raycastMicro: () => ({ hit: false }),
  });
  const airborne = wheel.position.clone();
  for (let i = 0; i < 10; i++) {
    wheel.update(.05, null, { gravity: [0, -18, 0], world: null });
    groundPhysics.update(wheel, .05);
  }
  assert.deepEqual(wheel.position.toArray(), airborne.toArray(), 'assembly keeps the wheel at its authored pose');
  controller.hoveredContraptionHit = { contraption: wheel, entityId: wheel.rootComponentId, point: wheel.position.clone() };
  assert.equal(controller.startWrenchGrab(), true, 'chapter 09 can lift the wheel without a Stop step');
  const motor = tutorialVehicleStation(10);
  wheel.position.set(motor.x - 1, 18, motor.z - 1).add(wheel.localCenter);
  wheel.updateTransform();
  controller.releaseWrenchGrab();
  assert.equal(wheel.bodyType, 'kinematic');
  assert.equal(wheel.isPhysicsSimulationEnabled(), false);
  const wheelStart = wheel.position.clone();
  assert.equal(await setScript(wheel, wheelCode), true);
  wheel.enableAllNodeScripts();
  for (let i = 0; i < 5; i++) wheel.update(0.05, null, { gravity: [0, -18, 0], world: null });
  assert.equal(wheel.bodyType, 'kinematic');
  assert.ok(Math.abs(wheel.quaternion.y) > 0.2, 'the standalone wheel spins around its flat Y axis');
  assert.deepEqual(wheel.position.toArray(), wheelStart.toArray(), 'the default kinematic body spins without falling');
  wheel.stopAllNodeScripts();
  assert.equal(await controller.performEntityMenuAction(wheel, 'reset-rotation'), true);
  assert.equal(await controller.performEntityMenuAction(wheel, 'cut'), true);
  assert.equal(manager.contraptions.includes(wheel), false, 'Cut removes the world instance after saving the module');
  assert.equal(controller.activeTool, SpecialTool.HAMMER);
  const savedWheel = controller.inventorySlots[controller.selectedInventoryIndex];
  const savedJson = JSON.stringify(savedWheel);
  assert.equal(chassis.entityNodes.size, 4, 'the car has three preinstalled wheels');
  assert.equal(chassis.canEditInternalSelection(), true);
  const bench = tutorialVehicleWorkbench();
  const frameOrigin = new THREE.Vector3(chassisBounds.minX, chassisBounds.minY, chassisBounds.minZ);
  const installedCodes = new Map([...chassis.entityNodes.values()].filter(node => node.parentId !== null)
    .map(node => [node.id, chassis.getNodeScript(node.id)]));
  const mount = tutorialMissingWheelMount();
  controller.hammerMicroMode = true;
  assert.equal(controller.hammerRotationTurnsX, 0);
  controller.rotateActiveInventoryItem(1, 'x');
  controller.rotateActiveInventoryItem(1, 'x');
  controller.hoveredContraptionHit = { contraption: chassis, entityId: chassis.rootComponentId,
    point: new THREE.Vector3(mount.x, mount.y, mount.z),
    normal: new THREE.Vector3(0, 0, mount.side), worldNormal: new THREE.Vector3(0, 0, mount.side) };
  controller.currentRaycast = null;
  assert.equal(controller.handleLeftClick(), true, 'the last wheel can be previewed on the empty axle');
  assert.equal(chassis.entityNodes.size, 4, 'preview does not install before Enter');
  assert.equal(controller.hammerPlacement.getInstallationLink()?.entity, chassis);
  controller.hammerPlacement.moveAlongAxis('x', .125);
  controller.hammerPlacement.moveAlongAxis('x', -.125);
  assert.equal(controller.hammerPlacement.confirm(), true);
  while (controller.bulkEditJob) controller.processBulkEditFrame(64, Infinity);
  assert.equal(controller.activeTool, SpecialTool.WRENCH);
  assert.equal(JSON.stringify(savedWheel), savedJson, 'installation preserves the reusable backpack module');
  const installed = [...chassis.entityNodes.values()].find(node => node.parentId !== null && !installedCodes.has(node.id))!;
  assert.ok(installed);
  assert.equal(chassis.getNodeScript(installed.id), wheelCode, 'the original 30 RPM code works unchanged');
  assert.equal(chassis.getNodeBodyType(installed.id), 'kinematic');
  const hollowFace = new THREE.Vector3(0, 1, 0).applyQuaternion(chassis.getEntityNodeWorldQuaternion(installed.id));
  assert.ok(hollowFace.dot(new THREE.Vector3(0, 0, -mount.side)) > .999, 'the recessed wheel face points into the chassis');
  const wheelCenter = new THREE.Vector3(mount.x, mount.y, mount.z + mount.side * .25);
  assert.ok(chassis.getEntityNodeWorldPosition(installed.id).distanceTo(wheelCenter) < .01, 'the wheel pivot aligns with the axle');
  installedCodes.set(installed.id, wheelCode);
  assert.equal(chassis.isPhysicsSimulationEnabled(), false, 'installation leaves the car stopped');
  assert.equal(chassis.getNodeScript(chassis.rootComponentId), '', 'the chassis needs no code');
  for (const [id, code] of installedCodes) assert.equal(chassis.getNodeScript(id), code, 'preinstalled wheel programs remain intact');
  assert.equal(manager.contraptions.length, 2, 'the last wheel joins the car rather than becoming a separate entity');
  assert.equal(chassis.entityNodes.size, 5);
  for (const box of chassis.getCollisionWorldAABBs()) {
    assert.ok(box.maxY <= bench.minY || box.minY >= bench.maxY - 1e-6
      || box.maxX <= bench.minX || box.minX >= bench.maxX
      || box.maxZ <= bench.minZ || box.minZ >= bench.maxZ,
    'the chassis and all mounted wheels clear the narrow assembly workbench');
    assert.ok(box.minY > 17, 'the mounted wheels also clear the floor');
  }
  // Carry the finished car off the workbench to the driving lane.
  chassis.position.add(new THREE.Vector3(0, 2, 0).sub(frameOrigin));
  // The wrench aligns the car with the lane. Its chassis has no drive script.
  chassis.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(27, 158));
  chassis.updateTransform();
  assert.equal(chassis.bodyType, 'kinematic', 'the car stays kinematic through wheel installation and carrying');
  assert.equal(chassis.useGravity, false);
  assert.equal(await controller.performEntityMenuAction(chassis, 'set-dynamic'), true);
  assert.equal(chassis.useGravity, true, 'chapter 12 enables gravity by changing the root type');
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
    if (i === 4) assert.ok(chassis.position.y < start.y - .25, 'the newly dynamic car visibly falls under gravity');
  }
  assert.equal(chassis.bodyType, 'dynamic', 'chapter 12 switches the chassis to dynamic');
  assert.equal(chassis.entityNodes.size, 5);
  assert.equal(chassis.nodeScriptErrors.size, 0);
  assert.equal(chassis.getNodeScript(chassis.rootComponentId).trim(), '');
  for (const node of chassis.entityNodes.values()) if (node.parentId !== null) {
    assert.equal(chassis.getNodeBodyType(node.id), 'kinematic', 'changing the root leaves the wheels kinematic');
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
