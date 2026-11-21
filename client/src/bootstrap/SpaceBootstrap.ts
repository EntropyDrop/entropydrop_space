import { mainSiteUrl, spaceLoginUrl } from './SpaceSiteLinks.ts';
import {
  TERRAIN_DECORATION_REJECTIONS,
  type TerrainEditChunk,
  type TerrainMutation,
  type WorldEditRemote,
} from '@entropydrop/space-engine/voxel/WorldEditPersistence.ts';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z } from '@entropydrop/space-engine/voxel/Chunk.ts';
import {
  TORUS_GREF,
  TORUS_SIZE_X,
  TORUS_SIZE_Z,
  wrapX,
  wrapZ,
} from '@entropydrop/space-engine/torus/TorusWorld.ts';

import {
  LatencyMonitor,
  type LatencyMonitorOptions,
} from './LatencyMonitor.ts';
import {
  authenticateSpace,
  createEntryProgressReporter,
  entryErrorFromResponse,
  renderEntryError,
  SpaceEntryError,
  type SpaceEntryAuth,
} from './SpaceEntryAuth.ts';

export { entryErrorFromResponse, isNonPcDevice, resolveApiOrigin, SpaceEntryError } from './SpaceEntryAuth.ts';
import {
  readJsonResponse,
  readResponseBytes,
  resolveSafeHttpUrl,
} from './NetworkSafety.ts';
import {
  createSpaceSurfaceSnapshotRemote,
  type SpaceSurfaceSnapshotRemote,
} from './SpaceSurfaceSnapshot.ts';

export { LatencyMonitor, type LatencyMonitorOptions };

export const TERRAIN_STREAM_RADIUS_CHUNKS = 16;
// Maximum six detailed Z chunks plus tile movement and hysteresis (5.5).
export const TERRAIN_STREAM_RADIUS_Z_CHUNKS = 12;
export const TERRAIN_STREAM_TILE_CHUNKS = 8;
export const TERRAIN_STREAM_PAGE_SIZE = 64;
export const TERRAIN_STREAM_HYSTERESIS_CHUNKS = 1.5;
export const TERRAIN_STREAM_SWITCH_DEBOUNCE_MS = 500;
export const MAX_SKIN_PNG_BYTES = 256 * 1024;
export const MAX_SPACE_ONLINE_PLAYERS = 100;
const MAX_SPACE_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TERRAIN_PAGE_BYTES = 16 * 1024 * 1024;

export interface TerrainStreamArea {
  centerChunkX: number;
  centerChunkZ: number;
  radiusChunks: number;
  radiusChunksZ?: number;
  key: string;
}

export type SkinType = 'strong' | 'slim';
export type SpaceSessionMode = 'online';

export const DEFAULT_PLAYER_SKIN_URL = new URL('../../skin_D2A9EB7A.png', import.meta.url).href;

export interface SpaceBootstrapPayload {
  protocol_version: 2;
  max_online_players: number;
  queue_enabled: true;
  websocket_url: string;
  world: {
    id: string;
    slug?: string | null;
    is_default?: boolean;
    name: string;
    seed: number;
    terrain_generator_version: number;
    terrain_revision: number;
    surface_snapshot_url: string;
  };
  player: {
    user_id: string;
    username: string | null;
    is_admin?: boolean;
    player_entity_id: string;
    skin_url: string;
    skin_type: SkinType;
    start_x_cm: number | null;
    start_y_cm: number | null;
    start_z_cm: number | null;
    start_yaw_q15: number | null;
    resumed: boolean;
  };
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

/** Runtime boundary for the versioned bootstrap contract; TypeScript types alone do not validate JSON. */
export function parseSpaceBootstrapPayload(value: unknown): SpaceBootstrapPayload {
  const payload = value as any;
  const world = payload?.world;
  const player = payload?.player;
  const positions = [
    player?.start_x_cm,
    player?.start_y_cm,
    player?.start_z_cm,
    player?.start_yaw_q15,
  ];
  const startPositionValid = positions.every(position => (
    isBoundedInteger(position, -10_000_000, 10_000_000)
  ));
  const skinUrlMissing = player?.skin_url === null
    || player?.skin_url === undefined
    || (typeof player?.skin_url === 'string' && player.skin_url.trim().length === 0);
  const skinTypeMissing = player?.skin_type === null || player?.skin_type === undefined;

  if (
    payload?.protocol_version !== 2
    || !isBoundedInteger(payload?.max_online_players, 1, MAX_SPACE_ONLINE_PLAYERS)
    || payload?.queue_enabled !== true
    || !isBoundedString(payload?.websocket_url, 2048)
    || !isBoundedString(world?.id, 128)
    || !(world?.slug === undefined || world.slug === null || isBoundedString(world.slug, 64))
    || !(world?.is_default === undefined || typeof world.is_default === 'boolean')
    || !isBoundedString(world?.name, 128)
    || !isBoundedInteger(world?.seed, -2_147_483_648, 2_147_483_647)
    || !isBoundedInteger(world?.terrain_generator_version, 1, 1_000_000)
    || !isBoundedInteger(world?.terrain_revision, 0, Number.MAX_SAFE_INTEGER)
    || !isBoundedString(world?.surface_snapshot_url, 4096)
    || !isBoundedString(player?.user_id, 128)
    || !(player?.username === null || typeof player?.username === 'string')
    || !isBoundedString(player?.player_entity_id, 128)
    || !(skinUrlMissing || isBoundedString(player?.skin_url, 4096))
    || !(skinTypeMissing || ['strong', 'slim'].includes(player?.skin_type))
    || typeof player?.resumed !== 'boolean'
    || !startPositionValid
  ) {
    throw new Error('Invalid Space bootstrap API V2 response.');
  }
  if (!skinUrlMissing && !skinTypeMissing) return payload as SpaceBootstrapPayload;
  return {
    ...payload,
    player: {
      ...player,
      skin_url: skinUrlMissing ? DEFAULT_PLAYER_SKIN_URL : player.skin_url,
      skin_type: skinUrlMissing || skinTypeMissing ? 'strong' : player.skin_type,
    },
  } as SpaceBootstrapPayload;
}

export interface PlayerPositionPayload {
  x_cm: number;
  y_cm: number;
  z_cm: number;
  yaw_q15: number;
  pitch_q15?: number;
}

export interface PlayerPositionRemote {
  save(position: PlayerPositionPayload, keepalive?: boolean): Promise<void>;
}

export interface ReadySpaceSession extends SpaceBootstrapPayload {
  mode: SpaceSessionMode;
  api_origin: string;
  account_api_origin?: string;
  token: string;
  skin_object_url: string;
  entry_warning: string | null;
  terrain_edit_remote: WorldEditRemote | null;
  surface_snapshot_remote: SpaceSurfaceSnapshotRemote | null;
  player_position_remote: PlayerPositionRemote;
  latency_monitor: LatencyMonitor | null;
}

export interface SpaceAdmissionStatus {
  state: 'admitted' | 'queued' | 'cancelled';
  position: number | null;
  poll_after_ms: number;
}

export interface SpaceEntryState {
  mode: SpaceSessionMode;
  queuePosition: number | null;
  onlineReady: boolean;
  cancelQueue: (() => Promise<void>) | null;
  enterOnline: (() => void) | null;
}

export interface SpaceEntryHooks {
  onStateChange?: (state: SpaceEntryState) => void;
}

export type SpaceEntryProgressReporter = (value: number, message: string) => void;

export interface PreparedOnlineSpace extends SpaceEntryAuth {
  payload: SpaceBootstrapPayload;
  skinObjectUrl: string;
  entryWarning: string | null;
  latencyMonitor: LatencyMonitor;
}

export function isMacPlatform(
  userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  platform = typeof navigator !== 'undefined' ? ((navigator as any).userAgentData?.platform || navigator.platform) : ''
): boolean {
  const ua = userAgent || '';
  const plat = platform || '';
  return /Mac/i.test(plat) || /Macintosh|MacIntel|iPhone|iPad|iPod/i.test(ua);
}

export function getAltKeyLabel(): string {
  return isMacPlatform() ? 'Opt' : 'Alt';
}

export function requestedSpaceWorld(
  search = typeof window !== 'undefined' ? window.location.search : '',
): string | null {
  const requested = new URLSearchParams(search).get('world')?.trim();
  return requested ? requested.slice(0, 128) : null;
}


export function hasPngSignature(bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((value, index) => bytes[index] === value);
}

export function resolveInitialPlayerPose(
  player: SpaceBootstrapPayload['player'],
  randomFn: () => number = Math.random
) {
  const { start_x_cm, start_y_cm, start_z_cm, start_yaw_q15 } = player;
  const hasBackendStart = (
    typeof start_x_cm === 'number' &&
    typeof start_y_cm === 'number' &&
    typeof start_z_cm === 'number' &&
    typeof start_yaw_q15 === 'number'
  );
  if (hasBackendStart) {
    return {
      x: start_x_cm / 100,
      y: start_y_cm / 100,
      z: start_z_cm / 100,
      yaw: (start_yaw_q15 / 32767) * Math.PI,
      resumed: player.resumed,
    };
  }

  // A malformed legacy bootstrap without a server-selected start still uses
  // the full-world policy. Start above the terrain and let physics settle.
  const randomX = randomFn() * TORUS_SIZE_X;
  const randomZ = randomFn() * TORUS_SIZE_Z;
  const randomYaw = (randomFn() * 2 - 1) * Math.PI;

  return {
    x: wrapX(randomX),
    y: TORUS_GREF + 16,
    z: wrapZ(randomZ),
    yaw: randomYaw,
    resumed: false,
  };
}

/**
 * Coarsen player movement into overlapping 16-chunk snapshot windows. Detailed
 * rendering is clipped to the last synchronized window; its fringe stays LOD
 * until the next snapshot arrives. Z covers six chunks plus movement padding.
 */
export function terrainStreamAreaForPosition(
  xMeters: number,
  zMeters: number,
  radiusChunks = TERRAIN_STREAM_RADIUS_CHUNKS,
  radiusChunksZ = Math.min(radiusChunks, TERRAIN_STREAM_RADIUS_Z_CHUNKS)
): TerrainStreamArea {
  const chunkCountX = TORUS_SIZE_X / CHUNK_SIZE_X;
  const chunkCountZ = TORUS_SIZE_Z / CHUNK_SIZE_Z;
  const chunkX = Math.floor(wrapX(xMeters) / CHUNK_SIZE_X);
  const chunkZ = Math.floor(wrapZ(zMeters) / CHUNK_SIZE_Z);
  const tileX = Math.floor(chunkX / TERRAIN_STREAM_TILE_CHUNKS);
  const tileZ = Math.floor(chunkZ / TERRAIN_STREAM_TILE_CHUNKS);
  const centerChunkX = (
    tileX * TERRAIN_STREAM_TILE_CHUNKS + Math.floor(TERRAIN_STREAM_TILE_CHUNKS / 2)
  ) % chunkCountX;
  const centerChunkZ = (
    tileZ * TERRAIN_STREAM_TILE_CHUNKS + Math.floor(TERRAIN_STREAM_TILE_CHUNKS / 2)
  ) % chunkCountZ;
  const normalizedRadius = Math.max(1, Math.min(TERRAIN_STREAM_RADIUS_CHUNKS,
    Math.floor(Number(radiusChunks)) || TERRAIN_STREAM_RADIUS_CHUNKS));
  const normalizedRadiusZ = Math.max(1, Math.min(normalizedRadius,
    Math.floor(Number(radiusChunksZ)) || TERRAIN_STREAM_RADIUS_Z_CHUNKS));
  return {
    centerChunkX,
    centerChunkZ,
    radiusChunks: normalizedRadius,
    radiusChunksZ: normalizedRadiusZ,
    key: `${centerChunkX},${centerChunkZ},${normalizedRadius},${normalizedRadiusZ}`,
  };
}

function wrappedChunkDelta(position: number, center: number, chunkCount: number) {
  let delta = position - center;
  if (delta > chunkCount / 2) delta -= chunkCount;
  if (delta < -chunkCount / 2) delta += chunkCount;
  return delta;
}

/**
 * Keep the current snapshot window while the player is close to a tile edge.
 * The overlap prevents tiny back-and-forth movements from repeatedly loading
 * two otherwise equivalent rectangular AOIs.
 */
export function terrainStreamAreaForPositionWithHysteresis(
  xMeters: number,
  zMeters: number,
  currentArea: TerrainStreamArea,
  hysteresisChunks = TERRAIN_STREAM_HYSTERESIS_CHUNKS
): TerrainStreamArea {
  const nextArea = terrainStreamAreaForPosition(
    xMeters,
    zMeters,
    currentArea.radiusChunks,
    currentArea.radiusChunksZ ?? currentArea.radiusChunks
  );
  if (nextArea.key === currentArea.key) return currentArea;
  if (currentArea.radiusChunks > TERRAIN_STREAM_RADIUS_CHUNKS
    || (currentArea.radiusChunksZ ?? currentArea.radiusChunks) > TERRAIN_STREAM_RADIUS_CHUNKS) return nextArea;

  const chunkCountX = TORUS_SIZE_X / CHUNK_SIZE_X;
  const chunkCountZ = TORUS_SIZE_Z / CHUNK_SIZE_Z;
  const chunkX = wrapX(xMeters) / CHUNK_SIZE_X;
  const chunkZ = wrapZ(zMeters) / CHUNK_SIZE_Z;
  const keepDistance = TERRAIN_STREAM_TILE_CHUNKS / 2
    + Math.max(0, hysteresisChunks);
  const deltaX = wrappedChunkDelta(chunkX, currentArea.centerChunkX, chunkCountX);
  const deltaZ = wrappedChunkDelta(chunkZ, currentArea.centerChunkZ, chunkCountZ);

  return Math.abs(deltaX) < keepDistance && Math.abs(deltaZ) < keepDistance
    ? currentArea
    : nextArea;
}

export function initialTerrainStreamArea(player: SpaceBootstrapPayload['player']) {
  const hasBackendStart = typeof player.start_x_cm === 'number'
    && typeof player.start_z_cm === 'number';
  return terrainStreamAreaForPosition(
    hasBackendStart ? player.start_x_cm! / 100 : 0,
    hasBackendStart ? player.start_z_cm! / 100 : 0
  );
}

function wrapCentimeters(valueMeters: number, sizeMeters: number) {
  const sizeCm = sizeMeters * 100;
  const valueCm = Math.round(valueMeters * 100);
  return ((valueCm % sizeCm) + sizeCm) % sizeCm;
}

export function encodePlayerPosition(
  position: { x: number; y: number; z: number },
  yaw: number,
  pitch = 0
): PlayerPositionPayload {
  const normalizedYaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
  const maxPitch = Math.PI / 2 - 0.01;
  const clampedPitch = Math.max(-maxPitch, Math.min(maxPitch, pitch));
  return {
    x_cm: wrapCentimeters(position.x, TORUS_SIZE_X),
    y_cm: Math.round(position.y * 100),
    z_cm: wrapCentimeters(position.z, TORUS_SIZE_Z),
    yaw_q15: Math.max(-32767, Math.min(32767, Math.round((normalizedYaw / Math.PI) * 32767))),
    pitch_q15: Math.max(-32767, Math.min(32767, Math.round((clampedPitch / Math.PI) * 32767))),
  };
}

async function downloadSkinPng(url: string) {
  let response: Response;
  try {
    const safeUrl = resolveSafeHttpUrl(url, window.location.href);
    response = await fetch(safeUrl.toString(), {
      mode: 'cors',
      cache: 'force-cache',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new Error('Failed to download character skin PNG. Please reconfigure your skin.');
  }

  if (!response.ok) {
    throw new Error(`Failed to download character skin PNG (${response.status}).`);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readResponseBytes(response, MAX_SKIN_PNG_BYTES);
  } catch {
    throw new Error('Character skin is invalid or exceeds the 256 KiB safety limit.');
  }
  if (!hasPngSignature(bytes)) {
    throw new Error('Character skin is not a valid PNG file. Please reconfigure your skin.');
  }

  const pngBuffer = new Uint8Array(bytes.byteLength);
  pngBuffer.set(bytes);
  const blob = new Blob([pngBuffer.buffer], { type: 'image/png' });
  try {
    const bitmap = await createImageBitmap(blob);
    const validSize = bitmap.width === 64 && bitmap.height === 64;
    bitmap.close();
    if (!validSize) throw new Error('invalid dimensions');
  } catch {
    throw new Error('Character skin must be a decodable 64×64 PNG. Please reconfigure your skin.');
  }
  return URL.createObjectURL(blob);
}

export async function loadTerrainEditRemote(
  apiOrigin: string,
  token: string,
  worldId: string,
  fetchImpl: typeof fetch = fetch,
  _latencyMonitor?: LatencyMonitor,
  initialArea?: TerrainStreamArea
): Promise<WorldEditRemote> {
  const baseUrl = `${apiOrigin}/space/api/v2/worlds/${encodeURIComponent(worldId)}/terrain-edits`;
  const retryUrl = typeof window === 'undefined' ? '/' : window.location.href;
  const areaRequests = new Map<string, Promise<TerrainEditChunk[]>>();

  const fetchPages = async (
    area?: TerrainStreamArea,
    onPage?: (chunks: TerrainEditChunk[]) => void
  ) => {
    const chunks: TerrainEditChunk[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    do {
      const url = new URL(
        baseUrl,
        typeof window === 'undefined' ? 'http://localhost' : window.location.href
      );
      // Keep JSON decoding and validation below a long-task-sized response;
      // subsequent pages yield back to the browser between network awaits.
      url.searchParams.set('limit', String(TERRAIN_STREAM_PAGE_SIZE));
      if (area) {
        url.searchParams.set('center_chunk_x', String(area.centerChunkX));
        url.searchParams.set('center_chunk_z', String(area.centerChunkZ));
        url.searchParams.set('radius_chunks', String(area.radiusChunks));
        url.searchParams.set('radius_chunks_z', String(area.radiusChunksZ ?? area.radiusChunks));
      }
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await fetchImpl(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        },
        cache: 'no-store'
      });
      const body = await readJsonResponse<any>(response, MAX_TERRAIN_PAGE_BYTES, {
        offMainThread: true,
      }).catch(() => null);
      if (!response.ok) {
        throw new SpaceEntryError(
          response.status === 401 || response.status === 403 ? 'LOGIN_REQUIRED' : 'BOOTSTRAP_FAILED',
          'Could not load Space world edits. Please check your network connection.',
          response.status === 401 || response.status === 403 ? spaceLoginUrl() : retryUrl,
          response.status === 401 || response.status === 403 ? 'Log In' : 'Retry'
        );
      }
      if (!Array.isArray(body?.chunks)) {
        throw new SpaceEntryError(
          'BOOTSTRAP_FAILED',
          'Invalid Space world edits response format.',
          retryUrl,
          'Retry'
        );
      }
      const pageChunks = body.chunks as TerrainEditChunk[];
      chunks.push(...pageChunks);
      onPage?.(pageChunks);
      const nextCursor = typeof body.next_cursor === 'string' ? body.next_cursor : null;
      if (nextCursor && seenCursors.has(nextCursor)) {
        throw new SpaceEntryError(
          'BOOTSTRAP_FAILED',
          'Duplicate cursor in Space world edits pagination.',
          retryUrl,
          'Retry'
        );
      }
      if (nextCursor) seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return chunks;
  };

  const loadArea = (
    centerChunkX: number,
    centerChunkZ: number,
    radiusChunks: number,
    onPage?: (chunks: TerrainEditChunk[]) => void,
    radiusChunksZ = Math.min(radiusChunks, TERRAIN_STREAM_RADIUS_Z_CHUNKS)
  ) => {
    const radiusZ = Math.max(1, Math.min(Math.floor(radiusChunks), Math.floor(radiusChunksZ)));
    const area = {
      centerChunkX: Math.floor(centerChunkX),
      centerChunkZ: Math.floor(centerChunkZ),
      radiusChunks: Math.max(1, Math.floor(radiusChunks)),
      radiusChunksZ: radiusZ,
      key: `${Math.floor(centerChunkX)},${Math.floor(centerChunkZ)},${Math.max(1, Math.floor(radiusChunks))},${radiusZ}`,
    };
    const existing = areaRequests.get(area.key);
    if (existing) return existing;
    // Coalesce only concurrent requests. A completed area must be fetched again
    // when the player later returns, because other players may have edited it
    // while the global terrain cursor advanced in another AOI.
    const request = fetchPages(area, onPage).finally(() => areaRequests.delete(area.key));
    areaRequests.set(area.key, request);
    return request;
  };

  const chunks = initialArea
    ? await loadArea(initialArea.centerChunkX, initialArea.centerChunkZ, initialArea.radiusChunks,
      undefined, initialArea.radiusChunksZ ?? initialArea.radiusChunks)
    : await fetchPages();

  return {
    chunks,
    loadArea,
    async sendBatch(batchId: string, mutations: TerrainMutation[], metadata) {
      if (mutations.length < 1 || mutations.length > 256) {
        throw new Error('Space terrain mutation batches must contain 1-256 operations.');
      }
      const requestBody: Record<string, unknown> = { batch_id: batchId, mutations };
      if (metadata?.dedupeEpoch === 1 && Number.isFinite(Number(metadata.createdAtMs))) {
        requestBody.dedupe_epoch = 1;
        requestBody.created_at_ms = Math.floor(Number(metadata.createdAtMs));
      }
      const response = await fetchImpl(`${baseUrl}/batches`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      if (!response.ok) {
        const body = await readJsonResponse<any>(response, MAX_SPACE_API_RESPONSE_BYTES).catch(() => null);
        const detail = body?.detail;
        const code = detail?.code || `HTTP_${response.status}`;
        const error: Error & { code?: string; retryAfterMs?: number; permanent?: boolean } = new Error(
          detail?.message || `Space terrain batch was not accepted: ${code}`
        );
        error.code = code;
        if (code === 'TERRAIN_BATCH_EXPIRED' || code === 'STANDARD_CELL_OCCUPIED'
          || TERRAIN_DECORATION_REJECTIONS.has(code)) error.permanent = true;
        const retryAfter = response.headers?.get?.('Retry-After');
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const retryAt = Date.parse(retryAfter);
          const retryAfterMs = Number.isFinite(seconds)
            ? seconds * 1_000
            : Number.isFinite(retryAt)
              ? Math.max(0, retryAt - Date.now())
              : NaN;
          if (Number.isFinite(retryAfterMs)) error.retryAfterMs = retryAfterMs;
        }
        if (error.retryAfterMs === undefined) {
          const retryAfterSeconds = Number(detail?.retry_after_seconds);
          if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
            error.retryAfterMs = retryAfterSeconds * 1_000;
          }
        }
        throw error;
      }
      return readJsonResponse(response, MAX_SPACE_API_RESPONSE_BYTES);
    }
  };
}

export function createPlayerPositionRemote(
  apiOrigin: string,
  token: string,
  worldId: string,
  fetchImpl: typeof fetch = fetch,
  _latencyMonitor?: LatencyMonitor
): PlayerPositionRemote {
  const url = `${apiOrigin}/space/api/v2/worlds/${encodeURIComponent(worldId)}/players/me/position`;
  return {
    async save(position: PlayerPositionPayload, keepalive = false) {
      const response = await fetchImpl(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(position),
        keepalive
      });
      if (!response.ok) {
        const body = await readJsonResponse<any>(response, MAX_SPACE_API_RESPONSE_BYTES).catch(() => null);
        const code = body?.detail?.code || `HTTP_${response.status}`;
        throw new Error(`Space player position was not saved: ${code}`);
      }
    }
  };
}

async function prepareOnlineSpace(
  auth: SpaceEntryAuth,
  reportProgress?: SpaceEntryProgressReporter
): Promise<PreparedOnlineSpace> {
  const { apiOrigin, token } = auth;
  const latencyMonitor = new LatencyMonitor({ apiOrigin });

  reportProgress?.(30, 'Loading Space profile and world…');
  const requestedWorld = requestedSpaceWorld();
  const bootstrapUrl = `${apiOrigin}/space/api/v2/bootstrap${
    requestedWorld ? `?world=${encodeURIComponent(requestedWorld)}` : ''
  }`;
  const response = await fetch(bootstrapUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    }
  });
  const body = await readJsonResponse<any>(response, MAX_SPACE_API_RESPONSE_BYTES).catch(() => null);
  if (!response.ok) throw entryErrorFromResponse(response.status, body);

  const configuredSkinUrl = typeof body?.player?.skin_url === 'string'
    && body.player.skin_url.trim().length > 0
    ? body.player.skin_url
    : null;
  const payload = parseSpaceBootstrapPayload(body);
  let skinObjectUrl = DEFAULT_PLAYER_SKIN_URL;
  let entryWarning: string | null = null;
  if (configuredSkinUrl) {
    reportProgress?.(46, 'Downloading character skin…');
    try {
      skinObjectUrl = await downloadSkinPng(configuredSkinUrl);
    } catch (error) {
      console.warn('Configured Space skin could not be loaded; using the bundled default skin.', error);
      entryWarning = '⚠ Your configured character skin could not be loaded, so the default skin is in use. Press O to open Settings for help.';
    }
  } else {
    reportProgress?.(46, 'Using the default character skin…');
    entryWarning = '⚠ No character skin is configured, so the default skin is in use. Press O to open Settings and set one up.';
  }
  reportProgress?.(58, 'Character resources ready…');
  return { ...auth, payload, skinObjectUrl, entryWarning, latencyMonitor };
}

export async function requestSpaceAdmission(
  apiOrigin: string,
  token: string,
  worldId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<SpaceAdmissionStatus> {
  const response = await fetchImpl(
    `${apiOrigin}/space/api/v2/worlds/${encodeURIComponent(worldId)}/admission`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      signal
    }
  );
  const body = await readJsonResponse<any>(response, MAX_SPACE_API_RESPONSE_BYTES).catch(() => null);
  if (!response.ok) throw entryErrorFromResponse(response.status, body);
  if (!body || !['admitted', 'queued'].includes(body.state)) {
    throw new SpaceEntryError(
      'BOOTSTRAP_FAILED',
      'Invalid Space queue status. Please try again later.',
      window.location.href,
      'Retry'
    );
  }
  return {
    state: body.state,
    position: body.state === 'queued' ? Math.max(1, Number(body.position) || 1) : null,
    poll_after_ms: Math.max(500, Math.min(5_000, Number(body.poll_after_ms) || 2_000))
  };
}

export async function cancelSpaceAdmission(
  apiOrigin: string,
  token: string,
  worldId: string,
  fetchImpl: typeof fetch = fetch,
  keepalive = false
): Promise<void> {
  const response = await fetchImpl(
    `${apiOrigin}/space/api/v2/worlds/${encodeURIComponent(worldId)}/admission`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      keepalive
    }
  );
  if (!response.ok) {
    throw new Error(`Space queue cancellation failed with HTTP ${response.status}`);
  }
}

async function completeOnlineSpace(
  prepared: PreparedOnlineSpace,
  reportProgress?: SpaceEntryProgressReporter
): Promise<ReadySpaceSession> {
  const { payload, apiOrigin, accountOrigin, token, skinObjectUrl, entryWarning, latencyMonitor } = prepared;
  latencyMonitor.start();
  let terrainEditRemote: WorldEditRemote;
  try {
    reportProgress?.(74, 'Loading nearby terrain…');
    terrainEditRemote = await loadTerrainEditRemote(
      apiOrigin,
      token,
      payload.world.id,
      fetch,
      latencyMonitor,
      initialTerrainStreamArea(payload.player)
    );
  } catch (error) {
    latencyMonitor.stop();
    throw error;
  }
  reportProgress?.(86, 'Terrain data ready…');
  return {
    ...payload,
    mode: 'online',
    api_origin: apiOrigin,
    account_api_origin: accountOrigin,
    token,
    skin_object_url: skinObjectUrl,
    entry_warning: entryWarning,
    terrain_edit_remote: terrainEditRemote,
    surface_snapshot_remote: createSpaceSurfaceSnapshotRemote(
      apiOrigin,
      token,
      payload.world.surface_snapshot_url,
      payload.world.seed,
      payload.world.terrain_generator_version,
    ),
    player_position_remote: createPlayerPositionRemote(apiOrigin, token, payload.world.id, fetch, latencyMonitor),
    latency_monitor: latencyMonitor
  };
}

export async function bootstrapSpace(): Promise<ReadySpaceSession> {
  const auth = await authenticateSpace();
  if (!auth) throw entryErrorFromResponse(401, null);
  const prepared = await prepareOnlineSpace(auth);
  const admission = await requestSpaceAdmission(
    prepared.apiOrigin,
    prepared.token,
    prepared.payload.world.id
  );
  if (admission.state !== 'admitted') {
    throw new SpaceEntryError(
      'BOOTSTRAP_FAILED',
      `Space Queue #${admission.position}`,
      window.location.href,
      'Retry',
      [
        { label: 'Retry', url: window.location.href },
        { label: 'Back to Main Site', url: mainSiteUrl('/space/intro'), secondary: true }
      ]
    );
  }
  return completeOnlineSpace(prepared);
}

export async function enterSpace(
  startGame: (
    session: ReadySpaceSession,
    reportProgress: SpaceEntryProgressReporter,
  ) => void | Promise<void>,
  hooks: SpaceEntryHooks = {},
  entryAuth?: SpaceEntryAuth,
) {
  const gate = document.getElementById('space-entry-gate');
  const action = document.getElementById('space-entry-action') as HTMLAnchorElement | null;
  const reportProgress = createEntryProgressReporter();
  if (gate) gate.hidden = false;
  if (action) action.hidden = true;

  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('mode')) {
      url.searchParams.delete('mode');
      window.history.replaceState(null, '', url);
    }

    const auth = entryAuth ?? await authenticateSpace(reportProgress);
    if (!auth) return;
    const prepared = await prepareOnlineSpace(auth, reportProgress);
    const enterAdmittedWorld = async () => {
      hooks.onStateChange?.({
        mode: 'online',
        queuePosition: null,
        onlineReady: false,
        cancelQueue: null,
        enterOnline: null,
      });
      const session = await completeOnlineSpace(prepared, reportProgress);
      try {
        reportProgress(92, 'Initializing Space scene…');
        await startGame(session, reportProgress);
      } catch (error) {
        session.latency_monitor?.stop();
        throw error;
      }
      reportProgress(100, 'Space world ready');
      if (gate) gate.hidden = true;
    };

    reportProgress(64, 'Joining shared world…');
    const admission = await requestSpaceAdmission(prepared.apiOrigin, prepared.token, prepared.payload.world.id);
    if (admission.state === 'admitted') {
      await enterAdmittedWorld();
      return;
    }

    let queueActive = true;
    let cancelled = false;
    let queueCancelling = false;
    let pollAfterMs = admission.poll_after_ms;
    let pollController: AbortController | null = null;
    let currentPoll: Promise<SpaceAdmissionStatus> | null = null;
    const worldId = prepared.payload.world.id;
    const cancelQueue = async () => {
      if (!queueActive || queueCancelling) return;
      queueCancelling = true;
      pollController?.abort();
      await currentPoll?.catch(() => undefined);
      try {
        await cancelSpaceAdmission(prepared.apiOrigin, prepared.token, worldId);
      } catch (error) {
        queueCancelling = false;
        throw error;
      }
      cancelled = true;
      queueActive = false;
      window.location.href = mainSiteUrl('/space/intro');
    };

    hooks.onStateChange?.({
      mode: 'online',
      queuePosition: admission.position,
      onlineReady: false,
      cancelQueue,
      enterOnline: null
    });
    reportProgress(72, `Space Queue #${admission.position}, please wait…`);

    const cancelBeforeUnload = () => {
      if (!queueActive) return;
      cancelled = true;
      queueActive = false;
      pollController?.abort();
      void cancelSpaceAdmission(
        prepared.apiOrigin,
        prepared.token,
        worldId,
        fetch,
        true
      ).catch(() => undefined);
    };
    window.addEventListener('pagehide', cancelBeforeUnload, { once: true });

    try {
      while (queueActive) {
        await new Promise(resolve => setTimeout(resolve, pollAfterMs));
        if (!queueActive || queueCancelling) continue;
        pollController = new AbortController();
        currentPoll = requestSpaceAdmission(prepared.apiOrigin, prepared.token, worldId, fetch, pollController.signal);
        let next: SpaceAdmissionStatus;
        try {
          next = await currentPoll;
        } catch (error) {
          if (error instanceof SpaceEntryError && error.code === 'LOGIN_REQUIRED') throw error;
          continue;
        } finally {
          currentPoll = null;
          pollController = null;
        }
        if (!queueActive || queueCancelling) continue;
        pollAfterMs = next.poll_after_ms;
        if (next.state === 'admitted') {
          queueActive = false;
          break;
        }
        hooks.onStateChange?.({
          mode: 'online',
          queuePosition: next.position,
          onlineReady: false,
          cancelQueue,
          enterOnline: null
        });
        reportProgress(72, `Space Queue #${next.position}, please wait…`);
      }
    } finally {
      window.removeEventListener('pagehide', cancelBeforeUnload);
    }
    if (cancelled) return;
    await enterAdmittedWorld();
  } catch (error) {
    renderEntryError(error);
  }
}
