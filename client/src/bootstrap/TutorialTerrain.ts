import type { World } from '@entropydrop/space-engine/voxel/World.ts';
import type { TutorialLevel } from '../tutorial/TutorialLevelFormat.ts';

export const TUTORIAL_CHUNK_RADIUS = 12;
export const TUTORIAL_TERRAIN_FORWARD_OFFSET = 128;

/** Cover the whole straight course while retaining the fixed 625-chunk budget. */
export function getTutorialTerrainCenter(spawn: TutorialLevel['spawn']) {
  const yaw = spawn.yaw_q15 / 32767 * Math.PI;
  return { x: spawn.x_cm / 100 - Math.sin(yaw) * TUTORIAL_TERRAIN_FORWARD_OFFSET,
    z: spawn.z_cm / 100 - Math.cos(yaw) * TUTORIAL_TERRAIN_FORWARD_OFFSET };
}

export function configureTutorialTerrain(world: World, spawn: TutorialLevel['spawn']) {
  const center = getTutorialTerrainCenter(spawn);
  world.setFixedTerrainWindow(center.x, center.z, TUTORIAL_CHUNK_RADIUS);
}
