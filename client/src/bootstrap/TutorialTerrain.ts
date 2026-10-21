import type { World } from '@entropydrop/space-engine/voxel/World.ts';
import type { TutorialLevel } from '../tutorial/TutorialLevelFormat.ts';

export const TUTORIAL_CHUNK_RADIUS = 12;

export function configureTutorialTerrain(world: World, spawn: TutorialLevel['spawn']) {
  world.setFixedTerrainWindow(spawn.x_cm / 100, spawn.z_cm / 100, TUTORIAL_CHUNK_RADIUS);
}
