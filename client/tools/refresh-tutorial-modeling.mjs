// Rebuild the Modeling practice and example pads from standard terrain blocks.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { normalizeWorldTerrainDecoration, storedTerrainDecoration } from '@entropydrop/space-engine/voxel/TerrainDecorationLayer.ts';
import { tutorialModelingAnchor, tutorialModelingOrigin, TUTORIAL_MODELING_EXAMPLE_ID,
  TUTORIAL_RAMP_DIMENSIONS, TUTORIAL_RAMP_POSITION, TUTORIAL_RAMP_ROTATION_Z } from '../src/tutorial/TutorialCourse.ts';

const file = new URL('../src/tutorial/tutorial-level.json', import.meta.url);
const level = JSON.parse(readFileSync(file, 'utf8'));
const practice = tutorialModelingOrigin(), example = tutorialModelingOrigin(true);
const practiceAnchor = tutorialModelingAnchor();
const exampleAnchor = tutorialModelingAnchor(true);
const insidePads = ([x, y, z]) => x >= practice.x && x < practice.x + 4 && y === practice.y
  && z >= practice.z && z < example.z + 4;
const unmodified = level.terrain.standard.filter(cell => !insidePads(cell));
const blocks = [];
for (const pad of [practice, example]) {
  for (let dx = 0; dx < 4; dx++) for (let dz = 0; dz < 4; dz++) {
    const x = pad.x + dx, z = pad.z + dz;
    const color = x === practiceAnchor.x && z === practiceAnchor.z ? 0x3bc1f2
      : pad === example && dz === 0 ? 0x69727c : (dx + dz) % 2 ? 0xc5cbd6 : 0xe4e8ed;
    blocks.push([x, pad.y, z, BlockTypes.COLOR_BLOCK, color]);
  }
}
level.terrain.standard = [...unmodified, ...blocks].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
assert.deepEqual(level.terrain.standard.filter(cell => !insidePads(cell)), unmodified);

const slope = storedTerrainDecoration(normalizeWorldTerrainDecoration({
  ...exampleAnchor, id: TUTORIAL_MODELING_EXAMPLE_ID, color: 0x9db3c8,
  position: TUTORIAL_RAMP_POSITION, scale: TUTORIAL_RAMP_DIMENSIONS,
  rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1),
    THREE.MathUtils.degToRad(TUTORIAL_RAMP_ROTATION_Z)).toArray(),
}));
level.terrain.decorations = (level.terrain.decorations ?? []).filter(decoration =>
  decoration.id !== slope.id || !insidePads([decoration.x, decoration.y, decoration.z]));
level.terrain.decorations.push(slope);
const retiredEntities = new Set(['tutorial-modeling-base', 'tutorial-modeling-example']);
level.entities.entities = level.entities.entities.filter(entity => !retiredEntities.has(entity.publicId));
writeFileSync(file, JSON.stringify(level, null, 2) + '\n');
console.log(JSON.stringify({ practiceAnchor, example: slope, blocks: blocks.length }, null, 2));
