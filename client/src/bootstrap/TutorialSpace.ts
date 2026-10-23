import { DEFAULT_PLAYER_SKIN_URL, type ReadySpaceSession, type SpaceEntryProgressReporter } from './SpaceBootstrap.ts';
import { createSpacePersistentStorage, type SpaceStorage } from '../engine/storage/BrowserStorage.ts';
import { TUTORIAL_WORLD_ID, createTutorialStorage, parseTutorialLevel, type TutorialLevel } from './TutorialLevel.ts';
import levelSource from '../tutorial/tutorial-level.json' with { type: 'json' };
import { readCachedSpacePlayerName } from './SpacePlayerName.ts';

export function createTutorialSession(level: TutorialLevel): ReadySpaceSession {
  return {
    protocol_version: 2, max_online_players: 32, queue_enabled: true,
    mode: 'online', api_origin: '', token: '', websocket_url: '',
    world: {
      id: TUTORIAL_WORLD_ID, slug: 'tutorial', name: level.name,
      seed: level.generator.seed, terrain_generator_version: level.generator.version,
      terrain_revision: 0, surface_snapshot_url: '',
    },
    player: {
      user_id: 'tutorial-local-player', username: readCachedSpacePlayerName() || 'Local player', player_entity_id: 'tutorial-player',
      skin_url: DEFAULT_PLAYER_SKIN_URL, skin_type: 'strong', is_admin: false,
      start_x_cm: level.spawn.x_cm, start_y_cm: level.spawn.y_cm,
      start_z_cm: level.spawn.z_cm, start_yaw_q15: level.spawn.yaw_q15, resumed: true,
    },
    skin_object_url: DEFAULT_PLAYER_SKIN_URL, entry_warning: null,
    terrain_edit_remote: null, surface_snapshot_remote: null, latency_monitor: null,
    player_position_remote: { async save() {} },
  };
}

export async function enterTutorialSpace(startGame: (
  session: ReadySpaceSession, backpackStorage: SpaceStorage | null,
  worldStorage: SpaceStorage, level: TutorialLevel, report: SpaceEntryProgressReporter,
) => Promise<void>): Promise<void> {
  const gate = document.getElementById('space-entry-gate');
  const status = document.getElementById('space-entry-status');
  const progress = document.getElementById('space-entry-progress');
  const fill = document.getElementById('space-entry-progress-fill');
  const label = document.getElementById('space-entry-progress-value');
  const action = document.getElementById('space-entry-action') as HTMLAnchorElement | null;
  if (gate) { gate.hidden = false; gate.style.display = ''; }
  if (action) action.hidden = true;
  const report: SpaceEntryProgressReporter = (value, message) => {
    const percent = Math.max(0, Math.min(100, Math.round(value)));
    if (status) status.textContent = message;
    progress?.setAttribute('aria-valuenow', String(percent));
    if (fill) fill.style.width = `${percent}%`;
    if (label) label.textContent = `${percent}%`;
  };
  try {
    report(5, 'Preparing the local tutorial…');
    const level = parseTutorialLevel(levelSource);
    const backpackStorage = await createSpacePersistentStorage();
    const worldStorage = createTutorialStorage(level);
    report(92, 'Generating flat tutorial terrain…');
    await startGame(createTutorialSession(level), backpackStorage, worldStorage, level, report);
    report(100, 'Tutorial ready');
    if (gate) { gate.hidden = true; gate.style.display = 'none'; }
  } catch (error) {
    if (status) status.textContent = `Could not start the tutorial: ${error instanceof Error ? error.message : String(error)}`;
    progress?.classList.add('failed');
    if (action) { action.hidden = false; action.href = window.location.href; action.textContent = 'Retry tutorial'; }
    console.error('Tutorial initialization failed.', error);
  }
}
