// Rebuild chapter 09's double-cab off-road pickup without its four tires.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { bresenham3D } from '../src/engine/controls/SelectorShapes.ts';
import { tutorialChassisBounds, tutorialChassisWheelMounts } from '../src/tutorial/TutorialCourse.ts';

const file = new URL('../src/tutorial/tutorial-level.json', import.meta.url);
const level = JSON.parse(readFileSync(file, 'utf8')), old = structuredClone(level);
const bounds = tutorialChassisBounds();
const { minX: x, minY: y, minZ: z } = bounds;
const BODY = 0xc8783d, EDGE = 0xe0a066, TRIM = 0x252e34, STEEL = 0x535f68;
const SILVER = 0xb0b8c1, GLASS = 0x446574, REFLECTION = 0x7899a4;
const LAMP = 0xfff1cd, RED = 0xcb4438, AMBER = 0xe9a347;
const BLUE = 0x3bc1f2, GREEN = 0x5af23b;
const frame = new Map();
function inFrame(cell, scale, size) {
  return cell[0] / scale + size > bounds.minX && cell[0] / scale < bounds.maxX
    && cell[1] / scale + size > bounds.minY && cell[1] / scale < bounds.maxY
    && cell[2] / scale + size > bounds.minZ && cell[2] / scale < bounds.maxZ;
}
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

// The blue corner is in the front bumper; the opposite green corner floats above the rear.
// No supporting post is needed for two-point box selection.
part(0, 0, 0, .125, .125, .125, BLUE);
part(8.875, 3, 4.125, 9, 3.125, 4.25, GREEN);

const micro = new Map(level.terrain.micro.filter(cell => !inFrame(cell, 8, .125))
  .map(cell => [cell.slice(0, 3).join(','), cell]));
for (const [key, cell] of frame) {
  assert.ok(inFrame(cell, 8, .125));
  micro.set(key, cell);
}
level.terrain.standard = level.terrain.standard.filter(cell => !inFrame(cell, 1, 1));
level.terrain.micro = [...micro.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
assert.deepEqual(level.spawn, old.spawn);
assert.deepEqual(level.entities, old.entities);
assert.deepEqual(level.terrain.standard, old.terrain.standard.filter(cell => !inFrame(cell, 1, 1)));
assert.deepEqual(level.terrain.micro.filter(cell => !inFrame(cell, 8, .125)),
  old.terrain.micro.filter(cell => !inFrame(cell, 8, .125)));
writeFileSync(file, JSON.stringify(level, null, 2) + '\n');
console.log(JSON.stringify({ chassisMicroCells: frame.size,
  blueJoint: [...frame.values()].filter(cell => cell[3] === BLUE).length,
  greenJoint: [...frame.values()].filter(cell => cell[3] === GREEN).length,
  bounds, mounts: tutorialChassisWheelMounts(), otherLevelContentPreserved: true }, null, 2));
