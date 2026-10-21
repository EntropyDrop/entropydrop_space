import type { SpaceStorage } from '@entropydrop/space-engine/storage/SpaceStorage.ts';
import { worldEditStorageKey } from '@entropydrop/space-engine/voxel/WorldEditPersistence.ts';
import { worldEntitiesStorageKey, ENTITY_STORAGE_VERSION } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { parseTutorialLevel, type TutorialLevel } from '../tutorial/TutorialLevelFormat.ts';
export { parseTutorialLevel, type TutorialLevel } from '../tutorial/TutorialLevelFormat.ts';

export const TUTORIAL_WORLD_ID = 'local-tutorial-v1';

/** Only terrain/entities use this memory store. The backpack keeps its real storage. */
export function createTutorialStorage(level: TutorialLevel): SpaceStorage {
  parseTutorialLevel(level);
  const values = new Map<string, string>([
    [worldEditStorageKey(TUTORIAL_WORLD_ID), JSON.stringify({
      ...level.terrain, worldId: TUTORIAL_WORLD_ID, pendingBatches: [],
    })],
    [worldEntitiesStorageKey(TUTORIAL_WORLD_ID), JSON.stringify({
      ...level.entities, type: 'space-entities', worldId: TUTORIAL_WORLD_ID,
    })],
  ]);
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
}

/** Call after flushing the world and capturing active AND dormant entities. */
export function captureTutorialLevel(
  storage: SpaceStorage, base: TutorialLevel,
): TutorialLevel {
  const terrain = JSON.parse(storage.getItem(worldEditStorageKey(TUTORIAL_WORLD_ID)) || 'null');
  const entities = JSON.parse(storage.getItem(worldEntitiesStorageKey(TUTORIAL_WORLD_ID)) || 'null');
  return parseTutorialLevel({
    ...base,
    // Saving lesson content must preserve its authored spawn and entry direction.
    spawn: { ...base.spawn },
    terrain: { version: 3, standard: terrain?.standard ?? [], micro: terrain?.micro ?? [] },
    entities: { version: ENTITY_STORAGE_VERSION, entities: entities?.entities ?? [] },
  });
}

/** Preserve the selected regular world when entering/leaving the tutorial. */
export function tutorialDestination(href: string, enter: boolean): string {
  const url = new URL(href);
  if (enter) url.searchParams.set('tutorial', '1');
  else url.searchParams.delete('tutorial');
  for (const key of ['token', 'panel', 'sso_attempted']) url.searchParams.delete(key);
  url.hash = '';
  return url.href;
}
