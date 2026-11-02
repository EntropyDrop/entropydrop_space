import * as THREE from 'three';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { createTutorialStorage, parseTutorialLevel, TUTORIAL_WORLD_ID } from '../src/bootstrap/TutorialLevel.ts';
import level from '../src/tutorial/tutorial-level.json' with { type: 'json' };

/** Load only the authored chunks needed by a lesson, through normal persistence. */
export function createLessonWorld(scene: THREE.Scene, bounds: { minX: number; maxX: number; minZ: number; maxZ: number }) {
  const storage = createTutorialStorage(parseTutorialLevel(level));
  const world = new World(scene, level.generator.seed, { worldId: TUTORIAL_WORLD_ID, storage }, level.generator.version);
  for (let x = Math.floor(bounds.minX / 16); x <= Math.floor(bounds.maxX / 16); x++) {
    for (let z = Math.floor(bounds.minZ / 16); z <= Math.floor(bounds.maxZ / 16); z++) world.getOrCreateChunk(x, z);
  }
  return { world, storage };
}
