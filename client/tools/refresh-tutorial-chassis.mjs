// Rebuild chapter 11's stopped pickup with three wheels; the player installs the last one.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { captureEntityStreamState } from '@entropydrop/space-engine/contraption/EntityStreaming.ts';
import { bresenham3D, computeSelectionCells } from '../src/engine/controls/SelectorShapes.ts';
import { tutorialChassisBounds, tutorialChassisWheelMounts, tutorialMissingWheelMount,
  tutorialWheelBounds, TUTORIAL_CHASSIS_ENTITY_ID } from '../src/tutorial/TutorialCourse.ts';

const file = new URL('../src/tutorial/tutorial-level.json', import.meta.url);
const level = JSON.parse(readFileSync(file, 'utf8')), old = structuredClone(level);
const bounds = tutorialChassisBounds();
const { minX: x, minY: y, minZ: z } = bounds;
const BODY = 0xc8783d, EDGE = 0xe0a066, TRIM = 0x252e34, STEEL = 0x535f68;
const SILVER = 0xb0b8c1, GLASS = 0x446574, REFLECTION = 0x7899a4;
const LAMP = 0xfff1cd, RED = 0xcb4438, AMBER = 0xe9a347;
const frame = new Map();
function part(x0, y0, z0, x1, y1, z1, color = BODY) {
  const grid = [x0, y0, z0, x1, y1, z1].map(v => v * 8);
  assert.ok(grid.every(Number.isSafeInteger), 'Pickup parts must align to microcells');
  for (let ix = grid[0]; ix < grid[3]; ix++) for (let iy = grid[1]; iy < grid[4]; iy++) {
    for (let iz = grid[2]; iz < grid[5]; iz++) {
      const cell = [x * 8 + ix, y * 8 + iy, z * 8 + iz, color];
      frame.set(cell.slice(0, 3).join(','), cell);
    }
  }
}
function tube(from, to, color = TRIM) {
  for (const p of bresenham3D(...from.map(v => v * 8), ...to.map(v => v * 8))) {
    part(p.x / 8, p.y / 8, p.z / 8, p.x / 8 + .25, p.y / 8 + .25, p.z / 8 + .25, color);
  }
}

// High-clearance ladder chassis, running boards and exposed axle ends.
for (const dz of [1, 3]) part(.375, 0, dz, 8.625, .375, dz + .25, STEEL);
part(.375, .25, .75, 8.625, .375, 3.5, STEEL);
for (const dx of [1.5, 7.5]) part(dx - .125, .375, .5, dx + .125, .625, 3.75, STEEL);
for (const dz of [0, 3.875]) {
  part(2.875, .125, dz, 6, .375, dz + .375, TRIM);
  part(3, .375, dz + .125, 5.875, .5, dz + .25, SILVER);
}
for (const dx of [3.25, 5.5]) {
  part(dx, .25, .25, dx + .25, .5, .875, STEEL);
  part(dx, .25, 3.375, dx + .25, .5, 4, STEEL);
}
for (const dx of [0, 8.625]) {
  part(dx, 0, 0, dx + .375, .375, 4.25, TRIM);
  part(dx, .375, .375, dx + .375, .625, 3.875, TRIM);
  part(dx, .125, 1.375, dx + .375, .25, 2.875, SILVER);
}

// Cutouts include the rotating tire envelope, placing the tires under the flares.
for (let ix = 3; ix < 70; ix++) for (let iy = 3; iy < 15; iy++) {
  const px = (ix + .5) / 8, py = (iy + .5) / 8;
  const radius = Math.min(Math.hypot(px - 1.5, py - .5), Math.hypot(px - 7.5, py - .5));
  if (radius < 1.125) continue;
  const flare = radius < 1.375;
  for (const side of [-1, 1]) {
    const lo = side < 0 ? (flare ? 0 : .375) : 3.625;
    const hi = side < 0 ? .625 : (flare ? 4.25 : 3.875);
    part(ix / 8, iy / 8, lo, (ix + 1) / 8, (iy + 1) / 8, hi, flare ? TRIM : BODY);
  }
}

// Low, tapered hood, separate grille and C-shaped lamps.
for (let ix = 4; ix < 22; ix++) {
  const rise = ix < 9 ? 1.5 : ix < 16 ? 1.625 : 1.75;
  const inset = ix < 7 ? .75 : .625;
  part(ix / 8, rise, inset, (ix + 1) / 8, rise + .125, 4.25 - inset);
}
part(1, 1.875, 1.5, 2.5, 2, 2.75, EDGE);
part(.875, 1.75, 1.625, 2.5, 1.875, 2.625);
part(2.25, 1.875, 1.75, 2.5, 2, 2.5, TRIM);
part(2.5, .375, .625, 2.75, 1.875, 3.625);
part(.375, .625, .5, .625, 1.625, 3.75);
part(.25, .75, 1.125, .375, 1.5, 3.125, TRIM);
for (let iz = 10; iz < 24; iz++) for (let iy = 7; iy < 12; iy++) {
  if ((iz + iy) % 2 === 0) part(.25, iy / 8, iz / 8, .375, (iy + 1) / 8, (iz + 1) / 8, STEEL);
}
part(.125, 1, 1.875, .375, 1.25, 2.375, SILVER);
for (const dz of [.5, 3.125]) {
  part(.25, 1, dz, .375, 1.5, dz + .625, TRIM);
  part(.125, 1.375, dz, .375, 1.5, dz + .625, LAMP);
  part(.125, 1, dz, .375, 1.125, dz + .625, LAMP);
  const outer = dz < 1 ? dz : dz + .5;
  part(.125, 1.125, outer, .375, 1.375, outer + .125, LAMP);
  part(.25, .75, dz + .125, .375, .875, dz + .5, AMBER);
}
for (const dz of [1, 3]) part(0, .125, dz, .25, .375, dz + .25, RED);
part(0, .5, 1, .25, .75, 3.25, STEEL);

// Four-door cabin: large windows and an inclined windshield above the low hood.
part(2.75, .375, .625, 5.875, .5, 3.625, TRIM);
for (const dz of [.375, 3.75]) {
  part(2.75, .5, dz, 5.875, 1.75, dz + .125);
  part(4.125, .5, dz, 4.25, 1.75, dz + .125, TRIM);
  part(5.75, .5, dz, 5.875, 1.75, dz + .125, TRIM);
  part(2.875, .5, dz, 5.75, .625, dz + .125, EDGE);
  for (const dx of [3.625, 5.25]) part(dx, 1.5, dz, dx + .375, 1.625, dz + .125, TRIM);
}
for (let row = 0; row < 11; row++) {
  const px = 2.5 + Math.floor(row / 3) * .125, py = 1.625 + row * .125;
  part(px, py, .5, px + .25, py + .125, 3.75);
  if (row >= 2 && row < 10) {
    part(px, py, .75, px + .25, py + .125, 3.5, GLASS);
    part(px, py, 1 + Math.floor(row / 2) * .125, px + .25, py + .125,
      1.125 + Math.floor(row / 2) * .125, REFLECTION);
  }
  for (const dz of [.5, 3.625]) {
    part(px + .125, py, dz, 5.875, py + .125, dz + .125);
    if (row >= 2 && row < 10) {
      part(px + .375, py, dz, 4.125, py + .125, dz + .125, GLASS);
      part(4.375, py, dz, 5.625, py + .125, dz + .125, GLASS);
      if (row === 9) {
        part(px + .375, py, dz, 4.125, py + .125, dz + .125, REFLECTION);
        part(4.375, py, dz, 5.625, py + .125, dz + .125, REFLECTION);
      }
    }
    part(4.125, py, dz, 4.375, py + .125, dz + .125, TRIM);
  }
}
part(2.875, 3, .5, 5.875, 3.125, 3.75, TRIM);
part(3.125, 3, .75, 5.625, 3.125, 3.5, STEEL);
part(5.75, .5, .625, 5.875, 3, 3.625);
part(5.875, 1.875, 1, 6, 2.75, 3.25, GLASS);
part(5.875, 2.625, 1, 6, 2.75, 3.25, REFLECTION);
for (const dz of [.125, 3.625]) {
  part(2.875, 1.75, dz, 3.375, 2.125, dz + .5, TRIM);
  part(3.25, 1.875, dz + .125, 3.375, 2, dz + .375, SILVER);
}
part(2.625, 1.25, .625, 3.125, 1.625, 3.625, TRIM);
for (const dx of [3.375, 4.75]) for (const dz of [.875, 2.375]) {
  part(dx, .5, dz, dx + .625, .875, dz + 1, TRIM);
  part(dx + .5, .875, dz, dx + .75, 1.625, dz + 1, TRIM);
}

// Open cargo bed: ribbed liner, wheel tubs, separate rails and a tailgate.
part(6, .75, .625, 8.625, .875, 3.625, TRIM);
for (const dz of [.875, 1.375, 1.875, 2.375, 2.875, 3.375]) part(6.125, .875, dz, 8.5, 1, dz + .125, STEEL);
for (const dz of [.625, 3.125]) part(6.5, .875, dz, 8.5, 1.625, dz + .5, TRIM);
for (const dz of [.375, 3.5]) part(6, 1.75, dz, 8.875, 1.875, dz + .375, TRIM);
part(8.625, .5, .5, 8.875, 1.75, 3.75);
part(8.625, 1.75, .375, 8.875, 1.875, 3.875, TRIM);
part(8.875, 1.375, 1.875, 9, 1.5, 2.375, TRIM);
part(8.875, .625, 1.625, 9, .875, 2.625, STEEL);
for (const dz of [.5, 3.375]) {
  part(8.875, .875, dz, 9, 1.625, dz + .375, RED);
  part(8.875, 1.125, dz, 9, 1.25, dz + .375, LAMP);
}
// A short sport bar leaves the bed open above.
for (const dz of [.625, 3.375]) {
  part(6, 1.75, dz, 6.25, 2.75, dz + .25, TRIM);
  tube([6.25, 2.5, dz], [7.25, 1.625, dz]);
}
part(6, 2.5, .625, 6.25, 2.75, 3.625, TRIM);
for (const dz of [1, 1.75, 2.5]) part(6, 2.75, dz, 6.25, 2.875, dz + .5, LAMP);

// Recessed pads touch the tires' inner faces, clear of the rotating envelope.
for (const mount of tutorialChassisWheelMounts()) {
  const dx = mount.x - x, dz = mount.z - z;
  part(dx - .25, .25, mount.side < 0 ? dz : dz - .25,
    dx + .25, .75, mount.side < 0 ? dz + .25 : dz, SILVER);
}

const inside = ([mx, my, mz]) => mx >= x * 8 && mx < bounds.maxX * 8
  && my >= y * 8 && my < bounds.maxY * 8 && mz >= z * 8 && mz < bounds.maxZ * 8;
// Remove the previous terrain chassis so only the saved car occupies the workbench.
level.terrain.micro = level.terrain.micro.filter(cell => !inside(cell));
const previous = level.entities.entities.find(entity => entity.publicId === TUTORIAL_CHASSIS_ENTITY_ID);
const others = level.entities.entities.filter(entity => entity.publicId !== TUTORIAL_CHASSIS_ENTITY_ID);
const entity = new Contraption(previous?.id ?? Math.max(0, ...others.map(entity => entity.id)) + 1,
  [...frame.values()].map(([mx, my, mz, color]) => ({
    localX: mx / 8 - x, localY: my / 8 - y, localZ: mz / 8 - z, size: .125, block: 1, color,
  })), new THREE.Vector3(x, y, z), new THREE.Scene(), {
    publicId: TUTORIAL_CHASSIS_ENTITY_ID, rootComponentId: 'chassis', rootComponentName: '11 Practice car',
    bodyType: 'kinematic', useGravity: false,
  });
try {
  entity.stopAllNodeScripts();
  const wheel = tutorialWheelBounds(), missing = tutorialMissingWheelMount();
  const selected = new Set(computeSelectionCells('cylinder',
    { x: wheel.minX * 8, y: wheel.maxY * 8 - 1, z: wheel.maxZ * 8 - 1 },
    { x: wheel.maxX * 8 - 1, y: wheel.minY * 8, z: wheel.minZ * 8 }, true)
    .map(cell => `${cell.x},${cell.y},${cell.z}`));
  const wheelBlocks = level.terrain.micro.filter(cell => selected.has(cell.slice(0, 3).join(',')))
    .map(([mx, my, mz, color]) => ({ localX: mx / 8 - wheel.minX, localY: my / 8 - wheel.minY,
      localZ: mz / 8 - wheel.minZ, size: .125, block: 1, color }));
  assert.ok(wheelBlocks.length > 400, 'Regenerate tutorial signs and the lesson 09 wheel first');
  const pivot = new THREE.Vector3((wheel.maxX - wheel.minX) / 2,
    (wheel.maxY - wheel.minY) / 2, (wheel.maxZ - wheel.minZ) / 2);
  for (const mount of tutorialChassisWheelMounts()) {
    if (mount.x === missing.x && mount.side === missing.side) continue;
    const end = mount.x === bounds.minX + 1.5 ? 'front' : 'rear', side = mount.side < 0 ? 'right' : 'left';
    const id = `${end}_${side}_wheel`;
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -mount.side * Math.PI / 2);
    const center = new THREE.Vector3(mount.x, mount.y, mount.z + mount.side * pivot.y);
    const result = entity.installEntitySlot({ rootComponentId: id, name: `${end} ${side} wheel`,
      blocks: wheelBlocks.map(block => ({ ...block, entityId: id })), rootPivotOverride: pivot.toArray(),
    }, entity.rootComponentId, center.clone().sub(pivot.clone().applyQuaternion(rotation)), null, rotation.toArray());
    assert.equal(result.ok, true, `${id}: ${result.reason}`);
    entity.setNodeScriptDraft(result.rootId, `self.setSpinYAxisRPM(${mount.side < 0 ? 30 : -30})`);
    assert.ok(entity.getEntityNodeWorldPosition(result.rootId).distanceTo(center) < 1e-6);
  }
  entity.stopAllNodeScripts();
  assert.equal(entity.entityNodes.size, 4);
  const record = captureEntityStreamState(entity, { id: `${Math.floor(x / 16)},${Math.floor(z / 16)}` });
  assert.equal(record.scriptStatus, 'stopped');
  level.entities.entities = [record, ...others];
  assert.deepEqual(level.spawn, old.spawn);
  assert.deepEqual(level.terrain.standard, old.terrain.standard);
  assert.deepEqual(level.terrain.micro, old.terrain.micro.filter(cell => !inside(cell)));
  assert.deepEqual(level.entities.entities.filter(entity => entity.publicId !== TUTORIAL_CHASSIS_ENTITY_ID), others);
  writeFileSync(file, JSON.stringify(level, null, 2) + '\n');
  console.log(JSON.stringify({ chassisMicroCells: frame.size, installedWheels: 3, missingWheel: missing,
    bounds, otherLevelContentPreserved: true }, null, 2));
} finally { entity.dispose(); }
