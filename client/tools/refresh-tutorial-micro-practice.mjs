// Rebuild the rotation exercise, vehicle workbenches and assembly floor guide.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { computeSelectionCells } from '../src/engine/controls/SelectorShapes.ts';
import { tutorialRotationBounds, tutorialChassisBounds, tutorialChassisWheelMounts,
  tutorialVehicleStation, tutorialVehicleWorkbench } from '../src/tutorial/TutorialCourse.ts';

const file = new URL('../src/tutorial/tutorial-level.json', import.meta.url);
const level = JSON.parse(readFileSync(file, 'utf8')), old = structuredClone(level);
const rotation = tutorialRotationBounds(), chassis = tutorialChassisBounds();
const station = tutorialVehicleStation(11);
const motor = tutorialVehicleStation(10);
const benches = [tutorialVehicleWorkbench()];
const assembly = benches[0];
const assemblyCenter = { x: (assembly.minX + assembly.maxX) / 2, z: (assembly.minZ + assembly.maxZ) / 2 };
const inRotation = (cell, scale) => cell[0] >= rotation.minX * scale && cell[0] < rotation.maxX * scale
  && cell[1] >= rotation.minY * scale && cell[1] < rotation.maxY * scale
  && cell[2] >= rotation.minZ * scale && cell[2] < rotation.maxZ * scale;
const isGuide = ([x, y, z, color]) => color === 0xffffff && y >= 17 * 8 && y <= 18 * 8
  && Math.abs(x / 8 - station.x) <= 6 && Math.abs(z / 8 - station.z) <= 4;
const affected = cell => inRotation(cell, 8) || isGuide(cell);
// Include the old tall collision post under the airborne chassis.
const inWorkbench = ([x, y, z]) => benches.some(b => x >= b.minX && x < b.maxX
  && y >= b.minY && y < b.maxY + 1 && z >= b.minZ && z < b.maxZ);
const inMotorStand = ([x, y, z]) => x >= Math.floor(motor.x) - 1 && x < Math.floor(motor.x) + 1
  && y === 17 && z === Math.round(motor.z);
const affectedStandard = cell => inRotation(cell, 1) || inWorkbench(cell) || inMotorStand(cell);
const micro = new Map(level.terrain.micro.filter(cell => !affected(cell))
  .map(cell => [cell.slice(0, 3).join(','), cell]));
function put(x, y, z, color) {
  assert.ok([x, y, z].every(Number.isSafeInteger));
  const key = `${x},${y},${z}`;
  assert.ok(!micro.has(key), `Practice geometry overlaps another lesson: ${key}`);
  micro.set(key, [x, y, z, color]);
}
const a = { x: rotation.maxX * 8 - 1, y: rotation.minY * 8, z: rotation.maxZ * 8 - 1 };
const b = { x: rotation.minX * 8, y: rotation.maxY * 8 - 1, z: rotation.minZ * 8 };
const cylinder = computeSelectionCells('cylinder', a, b, true, 'z');
for (const cell of cylinder) put(cell.x, cell.y, cell.z, 0xc5cbd6);
put(a.x, a.y, a.z, 0x3bc1f2);
put(b.x, b.y, b.z, 0x5af23b);
level.terrain.standard = level.terrain.standard.filter(cell => !affectedStandard(cell));
for (const x of [Math.floor(motor.x) - 1, Math.floor(motor.x)]) {
  level.terrain.standard.push([x, 17, Math.round(motor.z), 1, 0xafbac5]);
}
for (const bench of benches) {
  for (let x = bench.minX; x < bench.maxX; x++) for (let z = bench.minZ; z < bench.maxZ; z++) {
    const end = x === bench.minX || x === bench.maxX - 1;
    const edge = z === bench.minZ || z === bench.maxZ - 1;
    // One continuous level top; contrasting ends make the work surface visible.
    level.terrain.standard.push([x, bench.maxY - 1, z, 1, end ? 0xf2a93b : 0xb0b8c1]);
    if (end && edge) for (let y = bench.minY; y < bench.maxY - 1; y++) {
      level.terrain.standard.push([x, y, z, 1, 0x485464]);
    }
  }
}
level.terrain.standard.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

// Keep the outline on the floor; the narrow table supports the chassis rails
// while all four tires hang freely beside it during assembly.
const halfLength = (chassis.maxX - chassis.minX) / 2;
const halfWidth = (chassis.maxZ - chassis.minZ) / 2;
const minX = (assemblyCenter.x - halfLength) * 8, maxX = (assemblyCenter.x + halfLength) * 8 - 1;
const minZ = (assemblyCenter.z - halfWidth) * 8, maxZ = (assemblyCenter.z + halfWidth) * 8 - 1;
const guideKeys = new Set();
function putGuide(x, z) {
  const key = `${x},${z}`;
  if (guideKeys.has(key)) return; // Wheel corners can share the body outline.
  put(x, 17 * 8, z, 0xffffff);
  guideKeys.add(key);
}
for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
  if (x === minX || x === maxX || z === minZ || z === maxZ) putGuide(x, z);
}
for (const mount of tutorialChassisWheelMounts()) {
  const cx = mount.x;
  const cz = mount.z + mount.side * .25;
  for (const dx of [-1, .875]) for (const dz of [-.25, .125]) {
    putGuide((cx + dx) * 8, (cz + dz) * 8);
  }
}
level.terrain.micro = [...micro.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
assert.deepEqual(level.spawn, old.spawn);
assert.deepEqual(level.entities, old.entities);
assert.deepEqual(level.terrain.micro.filter(cell => !affected(cell)), old.terrain.micro.filter(cell => !affected(cell)));
assert.deepEqual(level.terrain.standard.filter(cell => !affectedStandard(cell)),
  old.terrain.standard.filter(cell => !affectedStandard(cell)));
writeFileSync(file, JSON.stringify(level, null, 2) + '\n');
console.log(JSON.stringify({ rotationMicroCells: cylinder.length, workbenches: benches,
  bodyGuide: [halfLength * 2, halfWidth * 2],
  otherPracticeGeometryPreserved: true }));
