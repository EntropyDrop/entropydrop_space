// Rebuild the micro rotation exercise and the full-size vehicle assembly guide.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { computeSelectionCells } from '../src/engine/controls/SelectorShapes.ts';
import { tutorialRotationBounds, tutorialChassisBounds, tutorialChassisWheelMounts,
  tutorialVehicleStation } from '../src/tutorial/TutorialCourse.ts';

const file = new URL('../src/tutorial/tutorial-level.json', import.meta.url);
const level = JSON.parse(readFileSync(file, 'utf8')), old = structuredClone(level);
const rotation = tutorialRotationBounds(), chassis = tutorialChassisBounds();
const station = tutorialVehicleStation(12), source = tutorialVehicleStation(9);
const inRotation = (cell, scale) => cell[0] >= rotation.minX * scale && cell[0] < rotation.maxX * scale
  && cell[1] >= rotation.minY * scale && cell[1] < rotation.maxY * scale
  && cell[2] >= rotation.minZ * scale && cell[2] < rotation.maxZ * scale;
const isGuide = ([x, y, z, color]) => color === 0xffffff && y >= 17 * 8 && y <= 18 * 8
  && Math.abs(x / 8 - station.x) <= 6 && Math.abs(z / 8 - station.z) <= 4;
const affected = cell => inRotation(cell, 8) || isGuide(cell);
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
level.terrain.standard = level.terrain.standard.filter(cell => !inRotation(cell, 1));

// A body-sized outline and four wheel footprints replace the old plate guide.
const halfLength = (chassis.maxX - chassis.minX) / 2;
const halfWidth = (chassis.maxZ - chassis.minZ) / 2;
const minX = (station.x - halfLength) * 8, maxX = (station.x + halfLength) * 8 - 1;
const minZ = (station.z - halfWidth) * 8, maxZ = (station.z + halfWidth) * 8 - 1;
for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
  if (x === minX || x === maxX || z === minZ || z === maxZ) put(x, 18 * 8, z, 0xffffff);
}
for (const mount of tutorialChassisWheelMounts()) {
  const cx = station.x + mount.x - source.x;
  const cz = station.z + mount.z - source.z + mount.side * .25;
  for (const dx of [-1, .875]) for (const dz of [-.25, .125]) {
    put((cx + dx) * 8, 17 * 8, (cz + dz) * 8, 0xffffff);
  }
}
level.terrain.micro = [...micro.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
assert.deepEqual(level.spawn, old.spawn);
assert.deepEqual(level.entities, old.entities);
assert.deepEqual(level.terrain.micro.filter(cell => !affected(cell)), old.terrain.micro.filter(cell => !affected(cell)));
assert.deepEqual(level.terrain.standard, old.terrain.standard.filter(cell => !inRotation(cell, 1)));
writeFileSync(file, JSON.stringify(level, null, 2) + '\n');
console.log(JSON.stringify({ rotationMicroCells: cylinder.length, bodyGuide: [halfLength * 2, halfWidth * 2],
  otherPracticeGeometryPreserved: true }));
