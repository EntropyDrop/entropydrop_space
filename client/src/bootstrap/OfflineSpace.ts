import {
  DEFAULT_PLAYER_SKIN_URL,
  type PlayerPositionPayload,
  type ReadySpaceSession,
  type SpaceEntryProgressReporter,
} from './SpaceBootstrap.ts';
import { createSpacePersistentStorage, type SpaceStorage } from '../engine/storage/BrowserStorage.ts';
import { TORUS_SIZE_X, TORUS_SIZE_Z } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { onlineSpaceUrl } from './SpaceSiteLinks.ts';

const WORLDS = {
  'aether-archipelago': { name: 'Aether Archipelago', seed: 42, version: 3, x: 819250, y: 18000, z: 102450 },
  nature: { name: 'Nature', seed: 42, version: 1, x: 537760, y: 1800, z: 82130 },
  'copper-metropolis': { name: 'Copper Metropolis', seed: 20260922, version: 2, x: 820000, y: 12800, z: 103200 },
} as const;

function validPosition(value: any): value is PlayerPositionPayload {
  return value && [value.x_cm, value.y_cm, value.z_cm, value.yaw_q15].every(Number.isSafeInteger)
    && value.x_cm >= 0 && value.x_cm < TORUS_SIZE_X * 100
    && value.z_cm >= 0 && value.z_cm < TORUS_SIZE_Z * 100
    && value.y_cm >= -10_000_000 && value.y_cm <= 10_000_000
    && value.yaw_q15 >= -32768 && value.yaw_q15 <= 32767;
}

/** Local world IDs and saves are separate from every server-authoritative world. */
export function createOfflineSession(storage: SpaceStorage | null, requestedWorld?: string | null): ReadySpaceSession {
  const slug = requestedWorld && Object.hasOwn(WORLDS, requestedWorld)
    ? requestedWorld as keyof typeof WORLDS : 'aether-archipelago';
  const world = WORLDS[slug];
  const id = `offline-${slug}-v${world.version}`;
  const positionKey = `space.offline.position.${id}`;
  let position: PlayerPositionPayload = { x_cm: world.x, y_cm: world.y, z_cm: world.z, yaw_q15: 16384 };
  try {
    const saved = JSON.parse(storage?.getItem(positionKey) || 'null');
    if (validPosition(saved)) position = saved;
  } catch { /* A damaged save falls back to the world's spawn. */ }
  return {
    protocol_version: 2, max_online_players: 32, queue_enabled: true,
    mode: 'online', api_origin: '', token: '', websocket_url: '',
    world: {
      id, slug, name: `${world.name} (Offline)`, seed: world.seed,
      terrain_generator_version: world.version, terrain_revision: 0, surface_snapshot_url: '',
    },
    player: {
      user_id: 'offline-local-player', username: 'Local player', player_entity_id: 'offline-player',
      skin_url: DEFAULT_PLAYER_SKIN_URL, skin_type: 'strong', is_admin: false,
      start_x_cm: position.x_cm, start_y_cm: position.y_cm, start_z_cm: position.z_cm,
      start_yaw_q15: position.yaw_q15, resumed: true,
    },
    skin_object_url: DEFAULT_PLAYER_SKIN_URL, entry_warning: null,
    terrain_edit_remote: null, surface_snapshot_remote: null, latency_monitor: null,
    player_position_remote: {
      async save(value) {
        if (validPosition(value)) storage?.setItem(positionKey, JSON.stringify(value));
      },
    },
  };
}

/** Production entry for the static distribution: no account, admission or network adapters. */
export async function enterOfflineSpace(startGame: (
  session: ReadySpaceSession,
  storage: SpaceStorage | null,
  reportProgress: SpaceEntryProgressReporter,
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
    report(5, 'Preparing your offline world…');
    const storage = await createSpacePersistentStorage();
    const session = createOfflineSession(storage, new URLSearchParams(window.location.search).get('world'));
    report(92, `Entering ${session.world.name}…`);
    await startGame(session, storage, report);
    report(100, 'Offline world ready');
    if (gate) { gate.hidden = true; gate.style.display = 'none'; }
  } catch (error) {
    if (status) status.textContent = `Could not start the offline world: ${error instanceof Error ? error.message : String(error)}`;
    progress?.classList.add('failed');
    if (action) {
      action.hidden = false;
      action.href = onlineSpaceUrl();
      action.target = '_blank';
      action.rel = 'noopener noreferrer';
      action.textContent = 'Open Space Online';
    }
    console.error('Offline Space initialization failed.', error);
  }
}
