// Rebuild the terrain practice pad and a separate finished Modeling example.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { captureEntityStreamState } from '@entropydrop/space-engine/contraption/EntityStreaming.ts';
import { tutorialModelingOrigin, TUTORIAL_MODELING_ENTITY_ID, TUTORIAL_MODELING_EXAMPLE_ID,
  TUTORIAL_RAMP_DIMENSIONS, TUTORIAL_RAMP_ROTATION_Z } from '../src/tutorial/TutorialCourse.ts';

const file = new URL('../src/tutorial/tutorial-level.json', import.meta.url);
const level = JSON.parse(readFileSync(file, 'utf8'));
const old = structuredClone(level);
const previous = level.entities.entities.find(entity => entity.publicId === TUTORIAL_MODELING_EXAMPLE_ID);
const others = level.entities.entities.filter(entity =>
  entity.publicId !== TUTORIAL_MODELING_ENTITY_ID && entity.publicId !== TUTORIAL_MODELING_EXAMPLE_ID);
const origin = tutorialModelingOrigin();
const insidePad = ([x, y, z]) => x >= origin.x && x < origin.x + 4 && y === origin.y
  && z >= origin.z && z < origin.z + 4;
level.terrain.standard = level.terrain.standard.filter(cell => !insidePad(cell));
for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) {
  const color = x === 0 && z === 0 ? 0x3bc1f2 : x === 3 && z === 3 ? 0x5af23b
    : (x + z) % 2 ? 0xc5cbd6 : 0xe4e8ed;
  level.terrain.standard.push([origin.x + x, origin.y, origin.z + z, 1, color]);
}
level.terrain.standard.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
const blocks = [];
for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) {
  blocks.push({ localX: x, localY: 0, localZ: z, size: 1, block: 1,
    color: z === 0 ? 0x69727c : (x + z) % 2 ? 0xc5cbd6 : 0xe4e8ed, entityId: 'base' });
}
const entity = new Contraption(previous?.id ?? Math.max(0, ...others.map(entity => entity.id)) + 1,
  blocks, new THREE.Vector3(origin.x, origin.y, origin.z + 4), new THREE.Scene(), {
    publicId: TUTORIAL_MODELING_EXAMPLE_ID, rootComponentId: 'base', rootComponentName: '13 Modeling example',
    bodyType: 'kinematic', useGravity: false,
    decorations: [{ id: 'slope-example', color: 0x9db3c8, position: [2, 2.125, 2],
      scale: [...TUTORIAL_RAMP_DIMENSIONS], rotation: new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(TUTORIAL_RAMP_ROTATION_Z)).toArray() }],
  });
try {
  entity.stopAllNodeScripts();
  const record = captureEntityStreamState(entity, { id: `${Math.floor(origin.x / 16)},${Math.floor(origin.z / 16)}` });
  assert.equal(record.scriptStatus, 'stopped');
  level.entities.entities = [...others, record];
  assert.deepEqual(level.spawn, old.spawn);
  assert.deepEqual(level.terrain.micro, old.terrain.micro);
  assert.deepEqual(level.terrain.standard.filter(cell => !insidePad(cell)), old.terrain.standard.filter(cell => !insidePad(cell)));
  writeFileSync(file, JSON.stringify(level, null, 2) + '\n');
  console.log(JSON.stringify({ entity: entity.publicId, origin, practiceBlocks: 16, exampleBaseBlocks: blocks.length,
    example: record.slot.decorations, otherEntitiesPreserved: others.length }, null, 2));
} finally { entity.dispose(); }
