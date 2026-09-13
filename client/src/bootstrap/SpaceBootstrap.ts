import type {
  TerrainEditChunk,
  TerrainMutation,
  WorldEditRemote,
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
  ensureSpaceAccessToken,
  installSpaceAuthFetchInterceptor,
} from './SpaceAuthSession.ts';
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

export const TERRAIN_STREAM_RADIUS_CHUNKS = 32;
export const TERRAIN_STREAM_TILE_CHUNKS = 8;
export const TERRAIN_STREAM_PAGE_SIZE = 64;
export const TERRAIN_STREAM_HYSTERESIS_CHUNKS = 1.5;
export const TERRAIN_STREAM_SWITCH_DEBOUNCE_MS = 500;
export const MAX_SKIN_PNG_BYTES = 256 * 1024;
const MAX_SPACE_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TERRAIN_PAGE_BYTES = 16 * 1024 * 1024;

export interface TerrainStreamArea {
  centerChunkX: number;
  centerChunkZ: number;
  radiusChunks: number;
  key: string;
}

export type SkinType = 'strong' | 'slim';
export type SpaceSessionMode = 'online';

export const DEFAULT_PLAYER_SKIN_URL = new URL('../../skin_D2A9EB7A.png', import.meta.url).href;

export interface SpaceBootstrapPayload {
  protocol_version: 2;
  max_online_players: 32;
  queue_enabled: true;
  websocket_url: string;
  world: {
    id: string;
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
    || !isBoundedInteger(payload?.max_online_players, 1, 32)
    || payload?.queue_enabled !== true
    || !isBoundedString(payload?.websocket_url, 2048)
    || !isBoundedString(world?.id, 128)
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

export interface PreparedOnlineSpace {
  payload: SpaceBootstrapPayload;
  apiOrigin: string;
  token: string;
  skinObjectUrl: string;
  entryWarning: string | null;
  latencyMonitor: LatencyMonitor;
}

export type SpaceEntryErrorCode =
  | 'PC_ONLY_REQUIRED'
  | 'LOGIN_REQUIRED'
  | 'BOOTSTRAP_FAILED';

export interface SpaceEntryAction {
  label: string;
  url: string;
  secondary?: boolean;
  subtle?: boolean;
}

export class SpaceEntryError extends Error {
  readonly code: SpaceEntryErrorCode;
  readonly actionUrl: string;
  readonly actionLabel: string;
  readonly actions: SpaceEntryAction[];

  constructor(
    code: SpaceEntryErrorCode,
    message: string,
    actionUrl: string,
    actionLabel: string,
    actions?: SpaceEntryAction[]
  ) {
    super(message);
    this.name = 'SpaceEntryError';
    this.code = code;
    this.actionUrl = actionUrl;
    this.actionLabel = actionLabel;
    this.actions = actions && actions.length > 0
      ? actions
      : [{ label: actionLabel, url: actionUrl }];
  }
}

export function isZhLang(): boolean {
  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage?.getItem('lang');
      if (stored) return stored.startsWith('zh');
    } catch {}
  }
  return typeof navigator !== 'undefined' && (navigator.language || '').toLowerCase().startsWith('zh');
}

export function isNonPcDevice(
  userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  platform = typeof navigator !== 'undefined' ? navigator.platform : '',
  maxTouchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0,
  screenWidth = typeof window !== 'undefined' ? window.innerWidth : 1920,
  screenHeight = typeof window !== 'undefined' ? window.innerHeight : 1080
): boolean {
  const ua = userAgent || '';
  const isMobileUa = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS|Windows Phone/i.test(ua);
  const isIPadOS = (platform === 'MacIntel' || ua.includes('Macintosh')) && maxTouchPoints > 1;
  const isTouchScreen = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const isSmallScreen = screenWidth < 1024 || screenHeight < 550;

  return isMobileUa || isIPadOS || Boolean(isTouchScreen && isSmallScreen);
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

export function resolveApiOrigin(configuredBase: string | undefined, pageOrigin: string) {
  const normalized = (configuredBase || '').trim().replace(/\/+$/, '');
  if (!normalized) return pageOrigin.includes('localhost') ? 'http://localhost:8000' : pageOrigin;
  return normalized.replace(/\/skin$/, '');
}

export function hasPngSignature(bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((value, index) => bytes[index] === value);
}

export function resolveInitialPlayerPose(
  player: SpaceBootstrapPayload['player'],
  randomFn: () => number = Math.random
) {
  const hasBackendStart = (
    typeof player.start_x_cm === 'number' &&
    typeof player.start_y_cm === 'number' &&
    typeof player.start_z_cm === 'number' &&
    typeof player.start_yaw_q15 === 'number'
  );
  if (hasBackendStart) {
    return {
      x: player.start_x_cm / 100,
      y: player.start_y_cm / 100,
      z: player.start_z_cm / 100,
      yaw: (player.start_yaw_q15 / 32767) * Math.PI,
      resumed: player.resumed,
    };
  }

  // Offline mode falls back to the same full-world policy.
  // Start above the procedural terrain ceiling and let physics settle the
  // player onto the local surface.
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
 * Coarsen player movement into overlapping terrain snapshot windows. A 32-chunk
 * radius covers the maximum 24-chunk render distance plus movement within one
 * eight-chunk tile, avoiding a snapshot request on every chunk boundary.
 */
export function terrainStreamAreaForPosition(
  xMeters: number,
  zMeters: number,
  radiusChunks = TERRAIN_STREAM_RADIUS_CHUNKS
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
  const normalizedRadius = Math.max(1, Math.floor(radiusChunks));
  return {
    centerChunkX,
    centerChunkZ,
    radiusChunks: normalizedRadius,
    key: `${centerChunkX},${centerChunkZ},${normalizedRadius}`,
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
 * two otherwise equivalent 65x65-chunk AOIs.
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
    currentArea.radiusChunks
  );
  if (nextArea.key === currentArea.key) return currentArea;

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

function entryErrorFromResponse(status: number, body: any) {
  const detail = body?.detail;
  const zh = isZhLang();
  if (status === 401 || status === 403) {
    return new SpaceEntryError(
      'LOGIN_REQUIRED',
      zh ? '进入 Space 前请先登录 EntropyDrop 账号。' : 'Please log in to EntropyDrop before entering Space.',
      '/skin/',
      zh ? '前往登录' : 'Log In',
      [
        { label: zh ? '前往登录' : 'Log In', url: '/skin/' },
        { label: zh ? '返回主站' : 'Back to Main Site', url: '/space/intro', secondary: true }
      ]
    );
  }
  return new SpaceEntryError(
    'BOOTSTRAP_FAILED',
    typeof detail === 'string'
      ? detail
      : (zh ? '无法加载 Space 玩家资料，请稍后重试。' : 'Could not load Space player profile. Please try again later.'),
    window.location.href,
    zh ? '重试' : 'Retry',
    [
      { label: zh ? '重试' : 'Retry', url: window.location.href },
      { label: zh ? '返回主站' : 'Back to Main Site', url: '/space/intro', secondary: true }
    ]
  );
}

async function downloadSkinPng(url: string) {
  const zh = isZhLang();
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
    throw new Error(zh
      ? '下载角色皮肤失败，请重新配置您的皮肤。'
      : 'Failed to download character skin PNG. Please reconfigure your skin.');
  }

  if (!response.ok) {
    throw new Error(zh
      ? `下载角色皮肤失败 (${response.status})，请重新配置您的皮肤。`
      : `Failed to download character skin PNG (${response.status}).`);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readResponseBytes(response, MAX_SKIN_PNG_BYTES);
  } catch {
    throw new Error(zh
      ? '角色皮肤文件无效或超过 256 KiB，请重新配置。'
      : 'Character skin is invalid or exceeds the 256 KiB safety limit.');
  }
  if (!hasPngSignature(bytes)) {
    throw new Error(zh
      ? '角色皮肤不是有效的 PNG 格式图片，请重新配置。'
      : 'Character skin is not a valid PNG file. Please reconfigure your skin.');
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
    throw new Error(zh
      ? '角色皮肤必须是可解析的 64×64 PNG 图片，请重新配置。'
      : 'Character skin must be a decodable 64×64 PNG. Please reconfigure your skin.');
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
          response.status === 401 || response.status === 403 ? '/skin/' : retryUrl,
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
    onPage?: (chunks: TerrainEditChunk[]) => void
  ) => {
    const area = {
      centerChunkX: Math.floor(centerChunkX),
      centerChunkZ: Math.floor(centerChunkZ),
      radiusChunks: Math.max(1, Math.floor(radiusChunks)),
      key: `${Math.floor(centerChunkX)},${Math.floor(centerChunkZ)},${Math.max(1, Math.floor(radiusChunks))}`,
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
    ? await loadArea(initialArea.centerChunkX, initialArea.centerChunkZ, initialArea.radiusChunks)
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
        if (code === 'TERRAIN_BATCH_EXPIRED') error.permanent = true;
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
  reportProgress?: SpaceEntryProgressReporter
): Promise<PreparedOnlineSpace> {
  const accountOrigin = resolveApiOrigin(import.meta.env?.VITE_API_BASE_URL, window.location.origin);
  const apiOrigin = resolveApiOrigin(import.meta.env?.VITE_SPACE_API_BASE_URL || accountOrigin, window.location.origin);
  installSpaceAuthFetchInterceptor(accountOrigin, apiOrigin);
  reportProgress?.(14, isZhLang() ? '正在验证 EntropyDrop 账号…' : 'Verifying EntropyDrop account…');
  const token = await ensureSpaceAccessToken(accountOrigin);
  if (!token) {
    throw entryErrorFromResponse(401, null);
  }

  const latencyMonitor = new LatencyMonitor({ apiOrigin });

  reportProgress?.(30, isZhLang() ? '正在加载 Space 角色与世界信息…' : 'Loading Space profile and world…');
  const response = await fetch(`${apiOrigin}/space/api/v2/bootstrap`, {
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
  const zh = isZhLang();
  let skinObjectUrl = DEFAULT_PLAYER_SKIN_URL;
  let entryWarning: string | null = null;
  if (configuredSkinUrl) {
    reportProgress?.(46, zh ? '正在下载角色皮肤…' : 'Downloading character skin…');
    try {
      skinObjectUrl = await downloadSkinPng(configuredSkinUrl);
    } catch (error) {
      console.warn('Configured Space skin could not be loaded; using the bundled default skin.', error);
      entryWarning = zh
        ? '⚠ 已设置的角色皮肤暂时无法加载，当前使用默认皮肤。按 O 打开设置查看处理方法。'
        : '⚠ Your configured character skin could not be loaded, so the default skin is in use. Press O to open Settings for help.';
    }
  } else {
    reportProgress?.(46, zh ? '正在使用默认角色皮肤…' : 'Using the default character skin…');
    entryWarning = zh
      ? '⚠ 尚未设置角色皮肤，当前使用默认皮肤。按 O 打开设置查看设置方法。'
      : '⚠ No character skin is configured, so the default skin is in use. Press O to open Settings and set one up.';
  }
  reportProgress?.(58, isZhLang() ? '角色资源已就绪…' : 'Character resources ready…');
  return { payload, apiOrigin, token, skinObjectUrl, entryWarning, latencyMonitor };
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
  const { payload, apiOrigin, token, skinObjectUrl, entryWarning, latencyMonitor } = prepared;
  latencyMonitor.start();
  let terrainEditRemote: WorldEditRemote;
  try {
    reportProgress?.(74, isZhLang() ? '正在加载附近地形…' : 'Loading nearby terrain…');
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
  reportProgress?.(86, isZhLang() ? '地形数据已就绪…' : 'Terrain data ready…');
  return {
    ...payload,
    mode: 'online',
    api_origin: apiOrigin,
    account_api_origin: resolveApiOrigin(import.meta.env?.VITE_API_BASE_URL, typeof window === "undefined" ? "http://localhost" : window.location.origin),
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
  const prepared = await prepareOnlineSpace();
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
        { label: 'Back to Main Site', url: '/space/intro', secondary: true }
      ]
    );
  }
  return completeOnlineSpace(prepared);
}

function renderEntryError(error: unknown) {
  const zh = isZhLang();
  const entryError = error instanceof SpaceEntryError
    ? error
    : new SpaceEntryError(
        'BOOTSTRAP_FAILED',
        zh ? 'Space 初始化失败，请检查网络后重试。' : 'Space initialization failed. Please check your network and try again.',
        window.location.href,
        zh ? '重试' : 'Retry',
        [
          { label: zh ? '重试' : 'Retry', url: window.location.href },
          { label: zh ? '返回主站' : 'Back to Main Site', url: '/space/intro', secondary: true }
        ]
      );
  const gate = document.getElementById('space-entry-gate');
  const status = document.getElementById('space-entry-status');
  const actionContainer = document.getElementById('space-entry-actions');
  const action = document.getElementById('space-entry-action') as HTMLAnchorElement | null;
  const progress = document.getElementById('space-entry-progress');
  if (gate) gate.hidden = false;
  if (status) status.textContent = entryError.message;
  if (progress) {
    progress.classList.add('failed');
    progress.setAttribute('aria-invalid', 'true');
    progress.setAttribute('aria-valuetext', entryError.message);
  }
  if (actionContainer) {
    actionContainer.innerHTML = '';
    for (const act of entryError.actions) {
      const a = document.createElement('a');
      a.className = [
        'space-entry-action',
        act.secondary ? 'secondary' : '',
        act.subtle ? 'subtle' : '',
      ].filter(Boolean).join(' ');
      a.href = act.url;
      a.textContent = act.label;
      actionContainer.appendChild(a);
    }
  } else if (action) {
    action.href = entryError.actionUrl;
    action.textContent = entryError.actionLabel;
    action.hidden = false;
  }
}

export async function enterSpace(
  startGame: (
    session: ReadySpaceSession,
    reportProgress: SpaceEntryProgressReporter,
  ) => void | Promise<void>,
  hooks: SpaceEntryHooks = {}
) {
  const gate = document.getElementById('space-entry-gate');
  const status = document.getElementById('space-entry-status');
  const action = document.getElementById('space-entry-action') as HTMLAnchorElement | null;
  const progress = document.getElementById('space-entry-progress');
  const progressFill = document.getElementById('space-entry-progress-fill') as HTMLElement | null;
  const progressValue = document.getElementById('space-entry-progress-value');
  const reportProgress: SpaceEntryProgressReporter = (value, message) => {
    const normalized = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    if (status) status.textContent = message;
    if (progress) {
      progress.classList.remove('failed');
      progress.removeAttribute('aria-invalid');
      progress.setAttribute('aria-valuenow', String(normalized));
      progress.setAttribute('aria-valuetext', `${message} ${normalized}%`);
    }
    if (progressFill) progressFill.style.width = `${normalized}%`;
    if (progressValue) progressValue.textContent = `${normalized}%`;
  };
  if (gate) gate.hidden = false;
  reportProgress(5, isZhLang() ? '正在准备进入 Space…' : 'Preparing to enter Space…');
  if (action) action.hidden = true;

  try {
    const searchParams = new URLSearchParams(window.location.search);
    const forcePc = searchParams.get('force_pc') === '1' || searchParams.get('force') === '1';
    if (isNonPcDevice() && !forcePc) {
      const zh = isZhLang();
      const pcError = new SpaceEntryError(
        'PC_ONLY_REQUIRED',
        zh
          ? 'Space 目前仅支持 PC 电脑端运行。游戏包含 3D 体素物理引擎、0.125m 微体素精细雕刻与键鼠自主控制系统，请使用电脑浏览器（推荐 Chrome / Edge）体验完整功能。'
          : 'EntropyDrop Space is designed for desktop PC browsers only. It requires 3D GPU acceleration, voxel physics, and keyboard & mouse controls.',
        '/space',
        zh ? '返回主站' : 'Back to Main Site',
        [
          {
            label: zh ? '返回 Space 主页' : 'Back to Space Overview',
            url: '/space',
            subtle: true,
          },
          {
            label: zh ? '仍然尝试进入 (开发者)' : 'Try Anyway (Dev)',
            url: window.location.search ? `${window.location.search}&force_pc=1` : '?force_pc=1',
            secondary: true
          }
        ]
      );
      renderEntryError(pcError);
      return;
    }

    if (searchParams.has('mode')) {
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('mode');
      window.history.replaceState(null, '', cleanUrl);
    }

    const prepared = await prepareOnlineSpace(reportProgress);
    reportProgress(64, isZhLang() ? '正在加入共享世界…' : 'Joining shared world…');
    const admission = await requestSpaceAdmission(
      prepared.apiOrigin,
      prepared.token,
      prepared.payload.world.id
    );
    if (admission.state === 'admitted') {
      const session = await completeOnlineSpace(prepared, reportProgress);
      hooks.onStateChange?.({
        mode: 'online',
        queuePosition: null,
        onlineReady: false,
        cancelQueue: null,
        enterOnline: null
      });
      reportProgress(92, isZhLang() ? '正在初始化地球模式场景…' : 'Initializing Earth-mode scene…');
      await startGame(session, reportProgress);
      reportProgress(100, isZhLang() ? 'Space 世界已就绪' : 'Space world ready');
      if (gate) gate.hidden = true;
      return;
    }

    let queueActive = true;
    let queueCancelling = false;
    let pollAfterMs = admission.poll_after_ms;
    let pollController: AbortController | null = null;
    let currentPoll: Promise<SpaceAdmissionStatus> | null = null;
    let cancelBeforeUnload: (() => void) | null = null;
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
      queueActive = false;
      window.location.href = '/space/intro';
    };

    hooks.onStateChange?.({
      mode: 'online',
      queuePosition: admission.position,
      onlineReady: false,
      cancelQueue,
      enterOnline: null
    });
    reportProgress(
      72,
      isZhLang()
        ? `在线队列 #${admission.position}，请稍候…`
        : `Space Queue #${admission.position}, please wait…`
    );

    cancelBeforeUnload = () => {
      if (!queueActive) return;
      queueActive = false;
      void cancelSpaceAdmission(
        prepared.apiOrigin,
        prepared.token,
        worldId,
        fetch,
        true
      ).catch(() => undefined);
    };
    window.addEventListener('pagehide', cancelBeforeUnload, { once: true });

    void (async () => {
      while (queueActive) {
        await new Promise(resolve => setTimeout(resolve, pollAfterMs));
        if (!queueActive) break;
        if (queueCancelling) continue;
        let poll: Promise<SpaceAdmissionStatus> | null = null;
        try {
          pollController = new AbortController();
          poll = requestSpaceAdmission(
            prepared.apiOrigin,
            prepared.token,
            worldId,
            fetch,
            pollController.signal
          );
          currentPoll = poll;
          const next = await poll;
          if (!queueActive || queueCancelling) continue;
          pollAfterMs = next.poll_after_ms;
          if (next.state === 'admitted') {
            queueActive = false;
            if (cancelBeforeUnload) {
              window.removeEventListener('pagehide', cancelBeforeUnload);
            }
            reportProgress(92, isZhLang() ? '排队完成，正在初始化 Space 场景…' : 'Admitted! Initializing Space scene…');
            const session = await completeOnlineSpace(prepared, reportProgress);
            hooks.onStateChange?.({
              mode: 'online',
              queuePosition: null,
              onlineReady: false,
              cancelQueue: null,
              enterOnline: null
            });
            await startGame(session, reportProgress);
            reportProgress(100, isZhLang() ? 'Space 世界已就绪' : 'Space world ready');
            if (gate) gate.hidden = true;
            return;
          }
          hooks.onStateChange?.({
            mode: 'online',
            queuePosition: next.position,
            onlineReady: false,
            cancelQueue,
            enterOnline: null
          });
          reportProgress(
            72,
            isZhLang()
              ? `在线队列 #${next.position}，请稍候…`
              : `Space Queue #${next.position}, please wait…`
          );
        } catch {
          // Retry on temporary network glitch
        } finally {
          if (currentPoll === poll) currentPoll = null;
          pollController = null;
        }
      }
    })();
  } catch (error) {
    renderEntryError(error);
  }
}
