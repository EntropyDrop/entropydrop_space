/* Exploratory checks of the Selector tool, especially micro (0.2 m) selection. */
import * as THREE from 'three';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';
import { ActionDomain, executeBasicAction } from '@entropydrop/space-engine/actions/BasicActions.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { bendPoint, bendDirection } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { CHUNK_SIZE_X } from '@entropydrop/space-engine/voxel/Chunk.ts';

function makeController(overrides: any = {}) {
  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.SELECTOR;
  controller.selectedSubtree = null;
  controller.selectedBlockSelection = null;
  controller.selectorLevel = null;
  controller.selectorRange = null;
  controller.selectorMicroMode = false;
  controller.hoveredContraptionHit = null;
  controller.currentRaycast = { hit: false };
  controller.inventorySlots = new Array(9).fill(null);
  controller.selectedInventoryIndex = 0;
  controller.inventories = null;
  controller.keys = {};
  controller.contraptions = overrides.manager || null;
  controller.world = overrides.world || null;
  controller.particles = { emitBlockBreak() {} };
  controller.sound = { playBlockBreak() {}, playWrenchClick() {}, playGlueApply() {} };
  const toasts: string[] = [];
  controller.ui = { showToast: m => toasts.push(m), renderInventoryBar() {}, notifyContraptionStructureChanged() {} };
  Object.assign(controller, overrides);
  controller.__toasts = toasts;
  return controller;
}

const scene = new THREE.Scene();
console.log('Building real world...');
const world = new World(scene);

// Stream chunks around the test area (x=100..103, z=100)
world.getOrCreateChunk(Math.floor(100 / CHUNK_SIZE_X), Math.floor(100 / CHUNK_SIZE_X));
world.getOrCreateChunk(Math.floor(101 / CHUNK_SIZE_X), Math.floor(101 / CHUNK_SIZE_X));
world.getOrCreateChunk(Math.floor(100 / CHUNK_SIZE_X), Math.floor(101 / CHUNK_SIZE_X));
world.getOrCreateChunk(Math.floor(101 / CHUNK_SIZE_X), Math.floor(100 / CHUNK_SIZE_X));

// Find terrain height at column (100, 100) so we build above the surface.
let groundY = -1;
for (let y = 63; y >= 0; y--) {
  if (world.getBlock(100, y, 100) !== BlockTypes.AIR) { groundY = y; break; }
}
console.log('terrain height at (100,100):', groundY);
const baseY = groundY + 1; // first free layer above terrain

// Build a small structure: standard blocks + one subdivided block
for (const [x, z] of [[100, 100], [101, 100], [100, 101]] as Array<[number, number]>) {
  world.setBlock(x, baseY, z, BlockTypes.COLOR_BLOCK);
}
world.setBlock(101, baseY, 101, BlockTypes.COLOR_BLOCK);
world.subdivideBlock(101, baseY, 101);
// carve two micro voxels out of the subdivided block
world.removeMicroBlock(101 * 5 + 4, baseY * 5 + 4, 101 * 5 + 0);
world.removeMicroBlock(101 * 5 + 3, baseY * 5 + 4, 101 * 5 + 0);

const manager = new ContraptionManager(scene, world, null, null);
const controller = makeController({ manager, world });
controller.selectorMicroMode = true;

// --- helpers: fake bent-space raycast results ---
function aimTop(cellX: number, cellY: number, cellZ: number, fx: number, fz: number) {
  return {
    hit: true, kind: 'standard',
    hitPos: { x: cellX, y: cellY, z: cellZ },
    normal: { x: 0, y: 1, z: 0 },
    entry: { x: cellX + fx, y: cellY + 1, z: cellZ + fz }
  };
}
function aimSide(cellX: number, cellY: number, cellZ: number, face: string, fy: number, fz: number) {
  const n = { x: 0, y: 0, z: 0 };
  let entry = { x: 0, y: 0, z: 0 };
  if (face === '+x') { n.x = 1; entry = { x: cellX + 1, y: cellY + fy, z: cellZ + fz }; }
  if (face === '-x') { n.x = -1; entry = { x: cellX, y: cellY + fy, z: cellZ + fz }; }
  if (face === '+z') { n.z = 1; entry = { x: cellX + fz, y: cellY + fy, z: cellZ + 1 }; }
  if (face === '-z') { n.z = -1; entry = { x: cellX + fz, y: cellY + fy, z: cellZ }; }
  if (face === '-y') { n.y = -1; entry = { x: cellX + fy, y: cellY, z: cellZ + fz }; }
  return { hit: true, kind: 'standard', hitPos: { x: cellX, y: cellY, z: cellZ }, normal: n, entry };
}

console.log('\n=== [A] surface micro-cell pick per face ===');
for (const [name, ray] of [
  ['top (fx=0.6, fz=0.2)', aimTop(100, baseY, 100, 0.6, 0.2)],
  ['bottom (fy=0.4, fz=0.9)', aimSide(100, baseY, 100, '-y', 0.4, 0.9)],
  ['left  (-x, fy=0.1, fz=0.5)', aimSide(100, baseY, 100, '-x', 0.1, 0.5)],
  ['right (+x, fy=0.8, fz=0.2)', aimSide(100, baseY, 100, '+x', 0.8, 0.2)],
] as Array<[string, any]>) {
  controller.currentRaycast = ray;
  const cell = controller.selectorMicroCellFromRaycast();
  console.log(`  ${name}: cell=${JSON.stringify(cell)}`);
}

console.log('\n=== [B] Del on a micro toggle selection (real world) ===');
manager.clearSelection();
controller.currentRaycast = aimTop(101, baseY, 101, 0.4, 0.9);
controller.handleLeftClick({ shiftKey: true });
console.log('  toggled:', JSON.stringify(manager.microSelection));
console.log('  toasts:', controller.__toasts.slice(-1));
const before = world.microVoxels.cells.size;
controller.deleteSelectionBlocks();
console.log('  removed:', before - world.microVoxels.cells.size, 'of', before);
console.log('  toasts:', controller.__toasts.slice(-1));

console.log('\n=== [C] G assemble from micro toggle selection ===');
manager.clearSelection();
controller.currentRaycast = aimTop(101, baseY, 101, 0.6, 0.9); // fresh cell (508,89,509)
controller.handleLeftClick({ shiftKey: true });
const sel = manager.microSelection;
console.log('  selected:', JSON.stringify(sel));
const cellX0 = sel[0].x, cellY0 = sel[0].y, cellZ0 = sel[0].z;
const entity = manager.assembleSelection();
console.log('  entity:', entity ? `#${entity.id}` : null);
if (entity) {
  console.log('  blocks:', entity.blocks.map(b => `${b.localX.toFixed(2)},${b.localY.toFixed(2)},${b.localZ.toFixed(2)} s=${b.size}`).join(' | '));
  console.log('  originWorldPos:', entity.originWorldPos.toArray());
  console.log('  position (pivot):', entity.position.toArray().map(v => +v.toFixed(3)));
  const expected = { x: cellX0 * 0.2 + 0.1, y: cellY0 * 0.2 + 0.1, z: cellZ0 * 0.2 + 0.1 };
  console.log('  expected voxel center:', expected);
  console.log('  world still has voxel?', !!world.getMicroBlock(cellX0, cellY0, cellZ0));
}

console.log('\n=== [D] 2-click micro box spanning two cells ===');
// re-subdivide for material
world.setBlock(102, baseY, 100, BlockTypes.COLOR_BLOCK);
world.subdivideBlock(102, baseY, 100);
manager.clearSelection();
controller.currentRaycast = aimTop(101, baseY, 101, 0.8, 0.1); // A at right-front
controller.handleLeftClick();
console.log('  cornerA:', JSON.stringify(manager.selectionCornerA));
controller.currentRaycast = aimTop(102, baseY, 100, 0.2, 0.9); // B at left-back of next cell
controller.handleLeftClick();
const sel2 = manager.microSelection || [];
console.log('  materialized count:', sel2.length);
const xs = [...new Set(sel2.map(c => c.x))].sort((a, b) => a - b);
const ys = [...new Set(sel2.map(c => c.y))].sort((a, b) => a - b);
const zs = [...new Set(sel2.map(c => c.z))].sort((a, b) => a - b);
console.log('  x span:', xs[0], '..', xs[xs.length - 1], `(expect ${101*5+4}..${102*5+1})`);
console.log('  y span:', ys[0], '..', ys[ys.length - 1], `(expect ${baseY*5+4} only)`);
console.log('  z span:', zs[0], '..', zs[zs.length - 1], `(expect ${101*5}..${101*5+4})`);

console.log('\n=== [E] preview box matches materialized span ===');
manager.clearSelection();
controller.currentRaycast = aimTop(101, baseY, 101, 0.8, 0.1);
controller.handleLeftClick(); // corner A
controller.currentRaycast = aimTop(102, baseY, 100, 0.2, 0.9);
controller.updateMicroCarvePreview(); // sets boxSelectionPreview without confirming
const preview = controller.boxSelectionPreview;
const renderer: any = Object.create(SceneRenderer.prototype);
renderer.scene = { add() {} };
renderer.setupBoxSelectionPreview();
renderer.setBoxSelectionPreview(preview.pointA, preview.cursor, preview.micro);
const g = renderer.boxSelectionGroup;
console.log('  preview group pos:', g.position.toArray().map(v => +v.toFixed(4)), 'scale:', renderer.boxSelectionFill.scale.toArray().map(v => +v.toFixed(4)));
const minMx = 101*5+4, maxMx = 102*5+1, minMy = baseY*5+4, maxMy = baseY*5+4, minMz = 101*5, maxMz = 101*5+4;
console.log('  expected pos:', [minMx*0.2 + (maxMx-minMx+1)*0.1, minMy*0.2+0.1, minMz*0.2 + (maxMz-minMz+1)*0.1].map(v => +v.toFixed(4)));
console.log('  expected scale:', [(maxMx-minMx+1)*0.2, (maxMy-minMy+1)*0.2, (maxMz-minMz+1)*0.2]);

console.log('\n=== [F] bent-space raycast end-to-end (micro pick) ===');
// Floating micro voxel in air cell (100, baseY+2, 100), sub (3,4,2)
const airY = baseY + 2;
world.setMicroBlock(100*5+3, airY*5+4, 100*5+2, 0x00ff00);
console.log('  placed in air cell?', !!world.getMicroBlock(100*5+3, airY*5+4, 100*5+2));
// Eye to the side, looking straight at the voxel's +x face
const eye = new THREE.Vector3(104.0, airY + 4*0.2 + 0.1, 100 + 2/5 + 0.1);
const target = new THREE.Vector3(100 + 3/5 + 0.2, airY + 4*0.2 + 0.1, 100 + 2/5 + 0.1);
const dir = target.clone().sub(eye).normalize();
const eyeBent = new THREE.Vector3();
bendPoint(eye.x, eye.y, eye.z, eyeBent);
const dirBent = new THREE.Vector3();
bendDirection(eye.x, eye.y, eye.z, dir, dirBent);
const q = executeBasicAction({ manager, world }, {
  domain: ActionDomain.QUERY, action: 'raycast', origin: eyeBent, direction: dirBent,
  maxDistance: 8, space: 'bent', include: 'all', voxelKinds: ['standard', 'micro']
});
const hit = q.worldHit;
console.log('  kind:', hit?.kind, 'microPos:', JSON.stringify(hit?.microPos), 'hitPos:', JSON.stringify(hit?.hitPos));
if (hit?.kind === 'micro') {
  controller.currentRaycast = hit;
  manager.clearSelection();
  controller.handleLeftClick({ shiftKey: true });
  console.log('  toggled:', JSON.stringify(manager.microSelection));
  const ok = manager.microSelection?.[0]?.x === hit.microPos.x
    && manager.microSelection?.[0]?.y === hit.microPos.y
    && manager.microSelection?.[0]?.z === hit.microPos.z;
  console.log('  picks exact hit micro voxel:', ok);
  console.log('  cursor:', JSON.stringify(controller.getCursorHighlight()));
} else {
  console.log('  !! expected micro hit but got', JSON.stringify(hit));
}

console.log('\n=== [G] standard-mode Del on a box containing micro voxels ===');
manager.clearSelection();
controller.selectorMicroMode = false;
controller.currentRaycast = aimTop(100, baseY, 100, 0.1, 0.1);
controller.handleLeftClick();
controller.currentRaycast = aimTop(102, baseY, 100, 0.9, 0.9);
controller.handleLeftClick();
const bounds = manager.getSelectionBounds();
console.log('  standard bounds:', JSON.stringify(bounds));
const countStd = () => { let n = 0; for (let x = 100; x <= 102; x++) for (let z = 100; z <= 102; z++) if (world.getBlock(x, baseY, z) !== BlockTypes.AIR) n++; return n; };
const beforeStd = countStd();
const beforeMicro = world.microVoxels.cells.size;
controller.deleteSelectionBlocks();
console.log('  standard blocks before/after:', beforeStd, countStd());
console.log('  micro before/after:', beforeMicro, world.microVoxels.cells.size);
console.log('  toasts:', controller.__toasts.slice(-1));
