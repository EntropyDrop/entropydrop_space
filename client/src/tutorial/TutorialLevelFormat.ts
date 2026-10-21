import type { PlayerPositionPayload } from '../bootstrap/SpaceBootstrap.ts';

export interface TutorialLevel {
  format: 'entropydrop-tutorial';
  version: 1;
  name: string;
  generator: { version: number; seed: number };
  spawn: PlayerPositionPayload;
  terrain: { version: 3; standard: unknown[][]; micro: unknown[][] };
  entities: { version: number; entities: unknown[] };
}

/** Version 1 fixes the generator, world dimensions and persistence formats. */
export function parseTutorialLevel(value: unknown): TutorialLevel {
  const level = value as TutorialLevel | undefined;
  const spawn = level?.spawn;
  if (level?.format !== 'entropydrop-tutorial' || level.version !== 1
    || typeof level.name !== 'string' || !level.name.trim()
    || level.generator?.version !== 9
    || !Number.isSafeInteger(level.generator.seed)
    || !spawn || ![spawn.x_cm, spawn.y_cm, spawn.z_cm, spawn.yaw_q15].every(Number.isSafeInteger)
    || spawn.x_cm < 0 || spawn.x_cm >= 16384 * 100
    || spawn.z_cm < 0 || spawn.z_cm >= 2048 * 100
    || spawn.y_cm < -10_000_000 || spawn.y_cm > 10_000_000
    || spawn.yaw_q15 < -32768 || spawn.yaw_q15 > 32767
    || level.terrain?.version !== 3
    || !Array.isArray(level.terrain.standard) || !level.terrain.standard.every(Array.isArray)
    || !Array.isArray(level.terrain.micro) || !level.terrain.micro.every(Array.isArray)
    || level.entities?.version !== 4 || !Array.isArray(level.entities.entities)) {
    throw new Error('Invalid or unsupported tutorial level file.');
  }
  // Match the persistence reader's limits; never silently save a truncated level.
  if (level.terrain.standard.length > 250_000 || level.terrain.micro.length > 500_000) {
    throw new Error('Tutorial terrain exceeds the supported level size.');
  }
  return level;
}
