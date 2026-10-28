// Rebuild only the stopped Modeling work pad and its finished slope example.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { captureEntityStreamState } from '@entropydrop/space-engine/contraption/EntityStreaming.ts';
import { tutorialModelingOrigin, TUTORIAL_MODELING_ENTITY_ID,
  TUTORIAL_RAMP_DIMENSIONS, TUTORIAL_RAMP_ROTATION_Z } from '../src/tutorial/TutorialCourse.ts';

const file = new URL('../src/tutorial/tutorial-level.json', import.meta.url);
const level = JSON.parse(readFileSync(file, 'utf8'));
const previous = level.entities.entities.find(entity => entity.publicId === TUTORIAL_MODELING_ENTITY_ID);
const others = level.entities.entities.filter(entity => entity.publicId !== TUTORIAL_MODELING_ENTITY_ID);
const origin = tutorialModelingOrigin();
const blocks = [];
for (let x = 0; x < 4; x++) for (let z = 0; z < 8; z++) {
  blocks.push({ localX: x, localY: 0, localZ: z, size: 1, block: 1,
    color: z === 4 ? 0x69727c : (x + z) % 2 ? 0xc5cbd6 : 0xe4e8ed, entityId: 'base' });
}
const entity = new Contraption(previous?.id ?? Math.max(0, ...others.map(entity => entity.id)) + 1,
  blocks, new THREE.Vector3(origin.x, origin.y, origin.z), new THREE.Scene(), {
    publicId: TUTORIAL_MODELING_ENTITY_ID, rootComponentId: 'base', rootComponentName: '14 Modeling practice',
    bodyType: 'kinematic', useGravity: false,
    decorations: [{ id: 'slope-example', color: 0x9db3c8, position: [2, 2.125, 6],
      scale: [...TUTORIAL_RAMP_DIMENSIONS], rotation: new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(TUTORIAL_RAMP_ROTATION_Z)).toArray() }],
  });
try {
  entity.stopAllNodeScripts();
  const record = captureEntityStreamState(entity, { id: `${Math.floor(origin.x / 16)},${Math.floor(origin.z / 16)}` });
  assert.equal(record.scriptStatus, 'stopped');
  level.entities.entities = [...others, record];
  writeFileSync(file, JSON.stringify(level, null, 2) + '\n');
  console.log(JSON.stringify({ entity: entity.publicId, origin, baseBlocks: blocks.length,
    example: record.slot.decorations, otherEntitiesPreserved: others.length }, null, 2));
} finally { entity.dispose(); }
