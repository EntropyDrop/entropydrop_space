// Rebuild the floating course signs with an integer 5 x 7 font. Rendering a
// 12px browser font at 8px and thresholding its alpha joins unrelated strokes.
// Rebuild lettering and wheel face paint without changing practice geometry.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { tutorialLessonHint, tutorialVehicleStation, tutorialWheelBounds, TUTORIAL_LESSON_STEP } from '../src/tutorial/TutorialCourse.ts';
import { getTutorialTerrainCenter, TUTORIAL_CHUNK_RADIUS } from '../src/bootstrap/TutorialTerrain.ts';

const rows = {
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01111','10000','10000','10000','10000','10000','01111'],
  D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01111','10000','10000','10111','10001','10001','01111'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['11111','00100','00100','00100','00100','00100','11111'],
  J: ['00111','00010','00010','00010','10010','10010','01100'],
  K: ['10001','10010','10100','11000','10100','10010','10001'],
  L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  N: ['10001','11001','11001','10101','10011','10011','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  Q: ['01110','10001','10001','10001','10101','10010','01101'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'],
  V: ['10001','10001','10001','10001','10001','01010','00100'],
  W: ['10001','10001','10001','10101','10101','10101','01010'],
  X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
  Z: ['11111','00001','00010','00100','01000','10000','11111'],
  0: ['01110','10001','10011','10101','11001','10001','01110'],
  1: ['00100','01100','00100','00100','00100','00100','01110'],
  2: ['01110','10001','00001','00010','00100','01000','11111'],
  3: ['11110','00001','00001','01110','00001','00001','11110'],
  4: ['00010','00110','01010','10010','11111','00010','00010'],
  5: ['11111','10000','10000','11110','00001','00001','11110'],
  6: ['01110','10000','10000','11110','10001','10001','01110'],
  7: ['11111','00001','00010','00100','01000','01000','01000'],
  8: ['01110','10001','10001','01110','10001','10001','01110'],
  9: ['01110','10001','10001','01111','00001','00001','01110'],
  a: ['00000','00000','01110','00001','01111','10001','01111'],
  c: ['00000','00000','01111','10000','10000','10000','01111'],
  d: ['00001','00001','01111','10001','10001','10001','01111'],
  e: ['00000','00000','01110','10001','11111','10000','01111'],
  f: ['00110','01001','01000','11100','01000','01000','01000'],
  h: ['10000','10000','10110','11001','10001','10001','10001'],
  i: ['00100','00000','01100','00100','00100','00100','01110'],
  l: ['01100','00100','00100','00100','00100','00100','01110'],
  n: ['00000','00000','11110','10001','10001','10001','10001'],
  o: ['00000','00000','01110','10001','10001','10001','01110'],
  p: ['00000','11110','10001','10001','11110','10000','10000'],
  r: ['00000','00000','10110','11001','10000','10000','10000'],
  s: ['00000','00000','01111','10000','01110','00001','11110'],
  t: ['01000','01000','11100','01000','01000','01001','00110'],
  u: ['00000','00000','10001','10001','10001','10011','01101'],
  y: ['00000','10001','10001','01111','00001','10001','01110'],
  '.': ['00000','00000','00000','00000','00000','00100','00100'],
  ',': ['00000','00000','00000','00000','00110','00100','01000'],
  ':': ['00000','00100','00100','00000','00100','00100','00000'],
  ';': ['00000','00100','00100','00000','00110','00100','01000'],
  '+': ['00000','00100','00100','11111','00100','00100','00000'],
  '-': ['00000','00000','00000','11111','00000','00000','00000'],
  '!': ['00100','00100','00100','00100','00100','00000','00100'],
  '(': ['00010','00100','01000','01000','01000','00100','00010'],
  ')': ['01000','00100','00010','00010','00010','00100','01000'],
  '[': ['01110','01000','01000','01000','01000','01000','01110'],
  ']': ['01110','00010','00010','00010','00010','00010','01110'],
  '↑': ['00100','01110','10101','00100','00100','00100','00100'],
  '▶': ['01000','01100','01110','01111','01110','01100','01000'],
};

const WHITE = 0xffffff, GOLD = 0xf2a93b, BLUE = 0x3bc1f2, GREEN = 0x5af23b, RED = 0xff3b30;
const MAX_WIDTH = 152; // Regular signs fit the roughly 20 m station spacing.
const GAP = 4;

function text(value, { color = GOLD, scale = 1 } = {}) {
  const cells = [];
  let cursor = 0;
  for (const char of value) {
    if (char === ' ') { cursor += 5 * scale; continue; }
    const glyph = rows[char];
    assert.ok(glyph, `Missing tutorial glyph: ${char}`);
    glyph.forEach((row, y) => [...row].forEach((pixel, x) => {
      if (pixel !== '1') return;
      for (let dx = 0; dx < scale; dx++) for (let dy = 0; dy < scale; dy++) {
        cells.push([cursor + x * scale + dx, (6 - y) * scale + dy, color]);
      }
    }));
    cursor += 7 * scale; // Always leave two clear columns between letters.
  }
  return { cells, width: cursor - 2 * scale, height: 7 * scale };
}

function key(value) {
  const label = text(value, { color: WHITE });
  const width = label.width + 4, height = label.height + 4;
  const cells = label.cells.map(([x, y, color]) => [x + 2, y + 2, color]);
  for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) {
    if (x === 0 || x === width - 1 || y === 0 || y === height - 1) cells.push([x, y, WHITE]);
  }
  return { cells, width, height };
}

function join(parts, gap = 6) {
  const height = Math.max(...parts.map(part => part.height)), cells = [];
  let cursor = 0;
  for (const part of parts) {
    const bottom = Math.floor((height - part.height) / 2);
    cells.push(...part.cells.map(([x, y, color]) => [x + cursor, y + bottom, color]));
    cursor += part.width + gap;
  }
  return { cells, width: cursor - gap, height };
}

const instruction = (button, caption) => join([key(button), text(caption)]);
function corners(firstColor = BLUE) {
  const square = color => ({ width: 7, height: 7,
    cells: Array.from({ length: 49 }, (_, i) => [i % 7, Math.floor(i / 7), color]) });
  return join([text('CLICK'), square(firstColor), text('THEN'), square(GREEN)]);
}
function wasd() {
  const unit = key('W'), cells = [];
  for (const [value, x, y] of [['W', 14, 14], ['A', 0, 0], ['S', 14, 0], ['D', 28, 0]]) {
    cells.push(...key(value).cells.map(([dx, dy, color]) => [x + dx, y + dy, color]));
  }
  return { cells, width: 28 + unit.width, height: 14 + unit.height };
}

const lessons = [
  ['01 MOVE', [wasd(), text('MOVE FORWARD')]],
  ['02 JUMP', [instruction('SPACE', 'JUMP'), text('OVER THE BRICKS')]],
  ['03 AIR DASH', [text('LOOK UP, THEN'), instruction('SPACE', 'JUMP'), instruction('SPACE', 'DASH IN AIR')]],
  ['04 FLY', [instruction('F', 'FLY MODE'), instruction('SPACE', 'RISE'), text('FLY OVER THE WALL')]],
  ['05 SELECTOR', [instruction('1', 'SELECTOR'), corners(), instruction('F', 'FILL')]],
  ['06 CYLINDER', [instruction('TAB', 'STANDARD'), instruction('ALT+2', 'CYLINDER'), corners(), instruction('F', 'FILL')]],
  ['07 CARVE', [instruction('TAB', 'MICRO'), instruction('ALT+2', 'CYLINDER'), corners(RED), instruction('DEL', 'CUT OUT')]],
  ['08 ROTATE', [instruction('TAB', 'STANDARD'), instruction('ALT+2', 'CYLINDER'), corners(), instruction('↑', 'ROTATE'), instruction('F', 'FILL')]],
  ['09 ENTITY', [instruction('ALT+1', 'BOX'), corners(), instruction('G', 'ASSEMBLE'), text('RUN WITH GRAVITY'),
    instruction('RMB', 'STOP'), instruction('3', 'WRENCH'), instruction('HOLD LMB', 'CARRY CHASSIS')]],
  ['10 WHEEL', [instruction('1', 'SELECTOR'), instruction('TAB', 'MICRO'), instruction('ALT+2', 'CYLINDER'),
    corners(), text('GOLD HUB: FRONT'), text('DARK HUB: BACK'), instruction('G', 'ASSEMBLE WHEEL'), instruction('RMB', 'STOP')]],
  ['11 MOTOR', [instruction('RMB', 'KINEMATIC'), text('VIEW GOLD FRONT'),
    text('30: COUNTERCLOCKWISE'), text('-30: CLOCKWISE'),
    ...['CODE HERE SHOWS HOW IT WORKS', 'FULL GAME: ASK AGENT', 'IN NATURAL LANGUAGE', 'USUALLY NO MANUAL CODING']
      .map(line => text(line, { color: WHITE })),
    instruction('C', 'ENTER CODE'),
    text('self.setLocalSpin([0, 1, 0], 30);', { color: WHITE }),
    instruction('▶', 'START'), instruction('RMB', 'STOP'), instruction('RMB', 'COPY TO BACKPACK')]],
  ['12 MODULE', [text('PLACE 09 CHASSIS'), instruction('RMB', 'RESET ROTATION'), instruction('2', 'HAMMER'), instruction('↑', 'TURN WHEEL UPRIGHT'),
    instruction('RIGHT X2', 'OTHER SIDE'), text('GOLD HUB OUTWARD'),
    instruction('TAB', 'MICRO'), instruction('LMB', 'AIM AT CHASSIS'), text('DRAG XYZ TO ALIGN'),
    instruction('ENTER', 'ATTACH'), text('ADD FOUR WHEELS')]],
  ['13 DRIVE', [instruction('3', 'WRENCH'), text('CAR TO START LINE'), text('ALIGN WITH THE LANE'),
    instruction('C', 'SELECT WHEEL TAB'), text('FLIPPED SIDE: -30'), text('MATCH DRIVE DIRECTION'),
    instruction('RMB', 'START'), text('WATCH THE WHEELS DRIVE'), instruction('RMB', 'STOP')]],
].map(([title, content], index) => ({
  title,
  rows: [text(title, { scale: 2 }), ...content],
  axis: 'z',
  plane: Math.round(tutorialLessonHint(index + 1).z * 8),
  center: Math.round(tutorialLessonHint(index + 1).x * 8),
  direction: -1,
  maxWidth: index === 10 ? 224 : MAX_WIDTH,
}));

for (let i = 1; i < lessons.length; i++) {
  const previous = lessons[i - 1], current = lessons[i];
  const halfWidths = [previous, current].map(sign => Math.max(...sign.rows.map(row => row.width)) / 2);
  assert.ok(Math.abs(previous.center - current.center) > halfWidths[0] + halfWidths[1] + 4,
    `${previous.title} and ${current.title} need more space between their lettering`);
}

const file = new URL('../src/tutorial/tutorial-level.json', import.meta.url);
const level = JSON.parse(readFileSync(file, 'utf8'));
const old = structuredClone(level);
const terrainCenter = getTutorialTerrainCenter(level.spawn);
const minX = (Math.floor(terrainCenter.x / 16) - TUTORIAL_CHUNK_RADIUS) * 16;
const minZ = (Math.floor(terrainCenter.z / 16) - TUTORIAL_CHUNK_RADIUS) * 16;
const terrainSize = (TUTORIAL_CHUNK_RADIUS * 2 + 1) * 16;
const driveStation = tutorialVehicleStation(13);
const finish = { title: 'NICE WORK!', axis: 'x', plane: (driveStation.x - 33) * 8,
  center: Math.round((driveStation.z - 33 * TUTORIAL_LESSON_STEP.z / TUTORIAL_LESSON_STEP.x) * 8), direction: -1 };
const isSignCell = ([x, y, z]) => lessons.some(sign =>
  z === sign.plane && Math.abs(x - sign.center) <= Math.max(100, sign.maxWidth / 2 + 4) && y >= 17 * 8)
  || x === finish.plane && Math.abs(z - finish.center) <= 100 && y >= 17 * 8;
const wheel = tutorialWheelBounds();
function paintWheelFace(cell) {
  const [x, y, z, color] = cell;
  if (color === BLUE || color === GREEN || x < wheel.minX * 8 || x >= wheel.maxX * 8
    || y < wheel.minY * 8 || y >= wheel.maxY * 8 || z < wheel.minZ * 8 || z >= wheel.maxZ * 8) return cell;
  const dx = x + .5 - (wheel.minX + wheel.maxX) * 4;
  const dz = z + .5 - (wheel.minZ + wheel.maxZ) * 4;
  const radiusSquared = dx * dx + dz * dz;
  // A gold hub and one spoke make front-facing rotation visible. Back is dark.
  if (y === wheel.maxY * 8 - 1 && (radiusSquared <= 8 || (dx >= 0 && Math.abs(dz) < 1 && radiusSquared < 42))) {
    return [x, y, z, GOLD, ...cell.slice(4)];
  }
  if (y === wheel.minY * 8 && radiusSquared <= 8) return [x, y, z, 0x303846, ...cell.slice(4)];
  return cell;
}
const micro = new Map(level.terrain.micro.filter(cell => !isSignCell(cell))
  .map(paintWheelFace).map(cell => [cell.slice(0, 3).join(','), cell]));
const occupied = new Set(level.terrain.standard.filter(cell => cell[3]).map(cell => cell.slice(0, 3).join(',')));
const signBounds = [];

function place(sign, shape, bottom) {
  assert.ok(shape.width <= (sign.maxWidth ?? MAX_WIDTH), `${sign.title}: ${shape.width} cells exceed station width`);
  const left = Math.round(sign.center - sign.direction * shape.width / 2);
  for (const [u, v, color] of shape.cells) {
    const along = left + sign.direction * u;
    const cell = sign.axis === 'z' ? [along, bottom + v, sign.plane, color] : [sign.plane, bottom + v, along, color];
    const id = cell.slice(0, 3).join(',');
    assert.ok(!micro.has(id), `Overlapping tutorial signs: ${id}`);
    assert.ok(!occupied.has(cell.slice(0, 3).map(value => Math.floor(value / 8)).join(',')), `Sign inside terrain: ${id}`);
    assert.ok(cell[0] >= minX * 8 && cell[0] < (minX + terrainSize) * 8
      && cell[2] >= minZ * 8 && cell[2] < (minZ + terrainSize) * 8);
    micro.set(id, cell);
  }
}

for (const sign of lessons) {
  let bottom = 17 * 8 + 6;
  for (const shape of [...sign.rows].reverse()) {
    place(sign, shape, bottom);
    bottom += shape.height + GAP;
  }
  signBounds.push({ chapter: sign.title, width: Math.max(...sign.rows.map(row => row.width)) / 8, top: (bottom - GAP) / 8 });
}
place(finish, text('NICE WORK!', { scale: 2 }), 20 * 8);
level.terrain.micro = [...micro.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
assert.deepEqual(level.terrain.standard, old.terrain.standard);
assert.deepEqual(level.spawn, old.spawn);
assert.deepEqual(level.entities, old.entities);
assert.deepEqual(level.terrain.micro.filter(cell => !isSignCell(cell)),
  old.terrain.micro.filter(cell => !isSignCell(cell)).map(paintWheelFace));
writeFileSync(file, JSON.stringify(level, null, 2) + '\n');
console.log(JSON.stringify({ signBounds, microCells: micro.size, practiceGeometryPreserved: true }, null, 2));
