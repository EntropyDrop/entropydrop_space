import { SPACE_HOSTING_UI_ENABLED } from './SpaceFeatures.ts';
import { INVENTORY_PROTOBUF_SCHEMA_VERSION } from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';
import {
  CheckpointEntityRequest,
  CreateEntityRequest,
  EntityRunState,
} from '@entropydrop/space-engine/generated/space_api.ts';
import {
  readJsonResponse,
  readResponseBytes,
  sha256Hex,
} from './NetworkSafety.ts';


const MAX_ENTITY_API_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_WORLD_ENTITY_DEFINITION_BYTES = 8 * 1024 * 1024;
export const MAX_WORLD_ENTITY_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export type SpaceEntityRunState = 'running' | 'stopped';

export interface SpaceEntityHostingStatus {
  entity_id: string;
  world_id: string;
  execution_mode: 'browser' | 'hosted';
  enabled: boolean;
  state: 'running' | 'starting' | 'paused' | 'unavailable';
  name: string;
  position: { x_cm: number; y_cm: number; z_cm: number };
  teleport_position?: { x_cm: number; y_cm: number; z_cm: number };
  core_id: number | null;
  can_manage: boolean;
  revision: number;
  execution_epoch: number;
  reason: string | null;
  error: string | null;
  credits_per_hour: 1;
  remaining_ms: number;
  budget_remaining_credits: number;
  billed_hours: number;
  last_tick_at: string | null;
  activity_radius_chunks: number;
  logs?: string[];
}

export interface SpaceHostingList {
  enabled: boolean;
  worker_available: boolean;
  capacity: { limit: number; total: number; used: number; available: number };
  items: SpaceEntityHostingStatus[];
}

export interface SpaceWorldEntityRecord {
  id: string;
  world_id: string;
  owner_user_id: string;
  owner_name?: string | null;
  executor_name?: string | null;
  execution_user_id?: string | null;
  execution_lease_expires_at?: string | null;
  execution_epoch?: number;
  name: string;
  schema_version: typeof INVENTORY_PROTOBUF_SCHEMA_VERSION;
  definition_digest: string;
  definition_size_bytes: number;
  definition_url: string;
  snapshot_digest: string | null;
  snapshot_size_bytes: number;
  snapshot_url: string | null;
  position: { x_cm: number; y_cm: number; z_cm: number };
  yaw_quarter_turns: 0 | 1 | 2 | 3;
  desired_run_state: SpaceEntityRunState;
  execution_mode?: 'browser' | 'hosted';
  hosting_enabled?: boolean;
  hosting_core_id?: number | null;
  can_manage_hosting?: boolean;
  revision: number;
  can_control: boolean;
  can_edit: boolean;
  created_at: string;
  updated_at: string;
}

export interface SpaceWorldEntityList {
  items: SpaceWorldEntityRecord[];
  truncated: boolean;
  limit: number;
}

export interface CreateSpaceWorldEntity {
  operation_id: string;
  definition: Uint8Array;
  position: { x_cm: number; y_cm: number; z_cm: number };
  yaw_quarter_turns?: 0 | 1 | 2 | 3;
  desired_run_state?: SpaceEntityRunState;
}

export interface PersistBrowserWorldEntity {
  definition: Uint8Array;
  snapshot: Record<string, unknown>;
  position: { x_cm: number; y_cm: number; z_cm: number };
  desired_run_state: SpaceEntityRunState;
}

export interface SpaceEntityExecutionLease {
  entity_id: string;
  granted: boolean;
  execution_epoch: number;
  lease_expires_at: string | null;
  executor_name?: string | null;
}

export class SpaceEntityApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: any;

  constructor(status: number, code: string, message: string, detail: any) {
    super(message);
    this.name = 'SpaceEntityApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function isInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function parseHostingStatus(value: any): SpaceEntityHostingStatus {
  const positionValid = (position: any) => [position?.x_cm, position?.y_cm, position?.z_cm].every(isInteger);
  if (typeof value?.entity_id !== 'string' || typeof value?.world_id !== 'string'
    || typeof value?.name !== 'string' || value.name.length > 80 || !positionValid(value.position)
    || !(value.teleport_position === undefined || positionValid(value.teleport_position))
    || typeof value.enabled !== 'boolean' || typeof value.can_manage !== 'boolean'
    || !['browser', 'hosted'].includes(value.execution_mode)
    || !['running', 'starting', 'paused', 'unavailable'].includes(value.state)
    || !(value.core_id === null || (isInteger(value.core_id) && value.core_id >= 0 && value.core_id < 128))
    || (value.enabled && (value.core_id === null || value.execution_mode !== 'hosted' || value.state === 'paused'))
    || (!value.enabled && value.state !== 'paused')
    || !isInteger(value.revision) || value.revision < 1 || !isInteger(value.execution_epoch) || value.execution_epoch < 0
    || value.credits_per_hour !== 1 || !isInteger(value.remaining_ms) || value.remaining_ms < 0 || value.remaining_ms > 3_600_000
    || !isInteger(value.budget_remaining_credits) || value.budget_remaining_credits < 0 || value.budget_remaining_credits > 168
    || !isInteger(value.billed_hours) || value.billed_hours < 0
    || !(value.last_tick_at === null || (typeof value.last_tick_at === 'string' && Number.isFinite(Date.parse(value.last_tick_at))))
    || ![value.reason, value.error].every(text => text === null || (typeof text === 'string' && text.length <= 500))
    || !isInteger(value.activity_radius_chunks) || value.activity_radius_chunks < 1) {
    throw new SpaceEntityApiError(0, 'ENTITY_API_INVALID_RESPONSE', 'Invalid hosting status response.', value);
  }
  return value;
}

function parseEntity(value: any): SpaceWorldEntityRecord {
  const position = value?.position;
  if (
    typeof value?.id !== 'string'
    || typeof value?.world_id !== 'string'
    || typeof value?.owner_user_id !== 'string'
    || !(value?.execution_user_id === undefined || value?.execution_user_id === null || typeof value.execution_user_id === 'string')
    || ![value?.owner_name, value?.executor_name].every(name => name === undefined || name === null || (typeof name === 'string' && name.length <= 100))
    || !(value?.execution_lease_expires_at === undefined || value?.execution_lease_expires_at === null
      || (typeof value.execution_lease_expires_at === 'string' && Number.isFinite(Date.parse(value.execution_lease_expires_at))))
    || typeof value?.name !== 'string'
    || !(value?.hosting_core_id === undefined || value?.hosting_core_id === null || (isInteger(value.hosting_core_id) && value.hosting_core_id >= 0 && value.hosting_core_id < 128))
    || !(value?.can_manage_hosting === undefined || typeof value.can_manage_hosting === 'boolean')
    || !(value?.execution_epoch === undefined || (isInteger(value.execution_epoch) && value.execution_epoch >= 0))
    || value?.schema_version !== INVENTORY_PROTOBUF_SCHEMA_VERSION
    || !/^[0-9a-f]{64}$/i.test(value?.definition_digest || '')
    || !isInteger(value?.definition_size_bytes)
    || value.definition_size_bytes < 1
    || value.definition_size_bytes > MAX_WORLD_ENTITY_DEFINITION_BYTES
    || typeof value?.definition_url !== 'string'
    || !(value?.snapshot_digest === null || /^[0-9a-f]{64}$/i.test(value?.snapshot_digest || ''))
    || !isInteger(value?.snapshot_size_bytes)
    || value.snapshot_size_bytes < 0
    || value.snapshot_size_bytes > MAX_WORLD_ENTITY_SNAPSHOT_BYTES
    || !(value?.snapshot_url === null || typeof value?.snapshot_url === 'string')
    || !isInteger(position?.x_cm)
    || !isInteger(position?.y_cm)
    || !isInteger(position?.z_cm)
    || ![0, 1, 2, 3].includes(value?.yaw_quarter_turns)
    || !['running', 'stopped'].includes(value?.desired_run_state)
    || !isInteger(value?.revision)
    || value.revision < 1
    || typeof value?.can_control !== 'boolean'
    || typeof value?.can_edit !== 'boolean'
    || typeof value?.created_at !== 'string'
    || typeof value?.updated_at !== 'string'
  ) {
    throw new Error('Invalid Space world entity response.');
  }
  return value as SpaceWorldEntityRecord;
}

const PROTOBUF_CONTENT_TYPE = 'application/x-protobuf';

function runStateEnum(value: SpaceEntityRunState | undefined): EntityRunState {
  return value === 'running'
    ? EntityRunState.ENTITY_RUN_STATE_RUNNING
    : EntityRunState.ENTITY_RUN_STATE_STOPPED;
}

function encodeSnapshotJson(snapshot: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(snapshot));
}

function positionMessage(position: { x_cm: number; y_cm: number; z_cm: number }) {
  return { xCm: position.x_cm, yCm: position.y_cm, zCm: position.z_cm };
}

function operationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  throw new Error('This browser cannot generate secure entity operation IDs.');
}

export class SpaceEntityClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiOrigin: string, token: string, worldId: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = `${apiOrigin.replace(/\/+$/, '')}/space/api/v2/worlds/${encodeURIComponent(worldId)}/entities`;
    this.token = token;
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  private async request(path: string, options: RequestInit = {}): Promise<any> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    let body: any;
    try {
      body = await readJsonResponse(response, MAX_ENTITY_API_RESPONSE_BYTES);
    } catch (error) {
      throw new SpaceEntityApiError(
        response.status,
        'ENTITY_API_INVALID_RESPONSE',
        'The Space entity API returned an invalid or oversized response.',
        error,
      );
    }
    if (!response.ok) {
      const detail = body?.detail;
      throw new SpaceEntityApiError(
        response.status,
        detail?.code || `HTTP_${response.status}`,
        detail?.message || 'Space entity request failed.',
        detail,
      );
    }
    return body;
  }

  async list(centerXcm: number, centerZcm: number, radiusCm: number, limit = 256): Promise<SpaceWorldEntityList> {
    const query = new URLSearchParams({
      center_x_cm: String(Math.round(centerXcm)),
      center_z_cm: String(Math.round(centerZcm)),
      radius_cm: String(Math.round(radiusCm)),
      limit: String(Math.max(1, Math.min(256, Math.floor(limit)))),
    });
    const body = await this.request(`?${query}`);
    if (!Array.isArray(body?.items) || typeof body?.truncated !== 'boolean' || !isInteger(body?.limit)) {
      throw new SpaceEntityApiError(0, 'ENTITY_API_INVALID_RESPONSE', 'Invalid entity list response.', body);
    }
    return { ...body, items: body.items.map(parseEntity) };
  }

  async create(payload: Omit<CreateSpaceWorldEntity, 'operation_id'> & { operation_id?: string }) {
    const { definition, ...requestPayload } = payload;
    const envelope = CreateEntityRequest.encode({
      operationId: payload.operation_id || operationId(),
      definition,
      position: positionMessage(requestPayload.position),
      yawQuarterTurns: requestPayload.yaw_quarter_turns ?? 0,
      desiredRunState: runStateEnum(requestPayload.desired_run_state),
    }).finish();
    const body = await this.request('', {
      method: 'POST',
      headers: { 'Content-Type': PROTOBUF_CONTENT_TYPE },
      body: envelope,
    });
    return parseEntity(body);
  }

  async get(entityId: string) {
    return parseEntity(await this.request(`/${encodeURIComponent(entityId)}`));
  }

  async createBrowser(payload: PersistBrowserWorldEntity, createOperationId = operationId()) {
    const envelope = CreateEntityRequest.encode({
      operationId: createOperationId,
      definition: payload.definition,
      position: positionMessage(payload.position),
      desiredRunState: runStateEnum(payload.desired_run_state),
      snapshotJson: encodeSnapshotJson(payload.snapshot),
    }).finish();
    const body = await this.request('/browser', {
      method: 'POST',
      headers: { 'Content-Type': PROTOBUF_CONTENT_TYPE },
      body: envelope,
    });
    return parseEntity(body);
  }

  async getDefinition(entity: SpaceWorldEntityRecord): Promise<Uint8Array> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/${encodeURIComponent(entity.id)}/definition?digest=${entity.definition_digest}`,
      {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/x-protobuf',
      },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      },
    );
    let definition: Uint8Array;
    try {
      definition = await readResponseBytes(response, MAX_WORLD_ENTITY_DEFINITION_BYTES);
    } catch (error) {
      throw new SpaceEntityApiError(
        response.status,
        'ENTITY_DEFINITION_TOO_LARGE',
        'The entity definition exceeds the 8 MiB safety limit.',
        error,
      );
    }
    if (!response.ok || definition.byteLength !== entity.definition_size_bytes) {
      throw new SpaceEntityApiError(
        response.status,
        'ENTITY_DEFINITION_DOWNLOAD_FAILED',
        'The entity definition could not be downloaded.',
        null,
      );
    }
    const actualDigest = await sha256Hex(definition);
    if (actualDigest !== entity.definition_digest.toLowerCase()) {
      throw new SpaceEntityApiError(
        0,
        'ENTITY_DEFINITION_DIGEST_MISMATCH',
        'The entity definition failed its SHA-256 integrity check.',
        { expected: entity.definition_digest, actual: actualDigest },
      );
    }
    return definition;
  }

  async getSnapshot(entity: SpaceWorldEntityRecord): Promise<Record<string, unknown> | null> {
    if (!entity.snapshot_url || !entity.snapshot_digest || entity.snapshot_size_bytes === 0) return null;
    const response = await this.fetchImpl(`${this.baseUrl}/${encodeURIComponent(entity.id)}/snapshot`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    let encoded: Uint8Array;
    try {
      encoded = await readResponseBytes(response, MAX_WORLD_ENTITY_SNAPSHOT_BYTES);
    } catch (error) {
      throw new SpaceEntityApiError(
        response.status,
        'ENTITY_SNAPSHOT_TOO_LARGE',
        'The entity snapshot exceeds the 4 MiB safety limit.',
        error,
      );
    }
    if (!response.ok || encoded.byteLength !== entity.snapshot_size_bytes) {
      throw new SpaceEntityApiError(
        response.status,
        'ENTITY_SNAPSHOT_DOWNLOAD_FAILED',
        'The entity snapshot could not be downloaded.',
        null,
      );
    }
    const actualDigest = await sha256Hex(encoded);
    if (actualDigest !== entity.snapshot_digest.toLowerCase()) {
      throw new SpaceEntityApiError(
        0,
        'ENTITY_SNAPSHOT_DIGEST_MISMATCH',
        'The entity snapshot failed its SHA-256 integrity check.',
        { expected: entity.snapshot_digest, actual: actualDigest },
      );
    }
    try {
      const snapshot = JSON.parse(new TextDecoder().decode(encoded));
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('not an object');
      return snapshot;
    } catch (error) {
      throw new SpaceEntityApiError(
        0,
        'ENTITY_SNAPSHOT_INVALID',
        'The entity snapshot is not valid JSON state.',
        error,
      );
    }
  }

  async checkpointBrowser(
    entityId: string,
    expectedRevision: number,
    payload: Omit<PersistBrowserWorldEntity, 'definition'> & {
      definition?: Uint8Array;
      execution_instance_id?: string;
      execution_epoch?: number;
    },
  ) {
    const envelope = CheckpointEntityRequest.encode({
      operationId: operationId(),
      expectedRevision,
      executionInstanceId: payload.execution_instance_id,
      executionEpoch: payload.execution_epoch,
      ...(payload.definition ? { definition: payload.definition } : {}),
      position: positionMessage(payload.position),
      desiredRunState: runStateEnum(payload.desired_run_state),
      snapshotJson: encodeSnapshotJson(payload.snapshot),
    }).finish();
    const body = await this.request(`/${encodeURIComponent(entityId)}/checkpoint`, {
      method: 'PUT',
      headers: { 'Content-Type': PROTOBUF_CONTENT_TYPE },
      body: envelope,
    });
    return parseEntity(body);
  }

  async delete(entityId: string, instanceId?: string, epoch?: number): Promise<void> {
    const body = await this.request(`/${encodeURIComponent(entityId)}`, { method: 'DELETE',
      ...(instanceId && epoch ? { headers: {
        'X-Space-Execution-Instance': instanceId, 'X-Space-Execution-Epoch': String(epoch),
      } } : {}),
    });
    if (body?.deleted !== true || body?.entity_id !== entityId) {
      throw new SpaceEntityApiError(0, 'ENTITY_API_INVALID_RESPONSE', 'Invalid entity deletion response.', body);
    }
  }

  async setHosting(entityId: string, enabled: boolean, maxCredits = 1, operation = operationId(), epoch?: number): Promise<SpaceEntityHostingStatus> {
    if (!SPACE_HOSTING_UI_ENABLED) {
      throw new SpaceEntityApiError(503, 'HOSTING_DISABLED', 'Entity hosting is not available.', null);
    }
    return parseHostingStatus(await this.request(`/${encodeURIComponent(entityId)}/hosting`, {
      method: 'PUT',
      body: JSON.stringify({ operation_id: operation, enabled, max_credits: maxCredits,
        release_to_browser: !enabled, ...(epoch !== undefined ? { expected_execution_epoch: epoch } : {}) }),
    }));
  }

  async getHosting(entityId: string): Promise<SpaceEntityHostingStatus> {
    if (!SPACE_HOSTING_UI_ENABLED) {
      throw new SpaceEntityApiError(503, 'HOSTING_DISABLED', 'Entity hosting is not available.', null);
    }
    return parseHostingStatus(await this.request(`/${encodeURIComponent(entityId)}/hosting`));
  }

  async listHosting(): Promise<SpaceHostingList> {
    const body = await this.request('/hosting/list');
    const capacity = body?.capacity;
    if (typeof body?.enabled !== 'boolean' || typeof body?.worker_available !== 'boolean'
      || !Array.isArray(body?.items) || body.items.length > 256
      || ![capacity?.limit, capacity?.total, capacity?.used, capacity?.available].every(value => isInteger(value) && value >= 0 && value <= 128)
      || capacity.limit !== 128 || capacity.used + capacity.available !== capacity.total) {
      throw new SpaceEntityApiError(0, 'ENTITY_API_INVALID_RESPONSE', 'Invalid hosting list response.', body);
    }
    return { ...body, items: body.items.map(parseHostingStatus) };
  }

  async setRunState(entityId: string, desiredRunState: SpaceEntityRunState, expectedRevision: number,
    instanceId?: string, epoch?: number, stopPose?: { position: number[]; quaternion: number[] }) {
    const body = await this.request(`/${encodeURIComponent(entityId)}/run-state`, {
      method: 'PUT',
      body: JSON.stringify({
        operation_id: operationId(),
        desired_run_state: desiredRunState,
        expected_revision: expectedRevision,
        ...(instanceId ? { execution_instance_id: instanceId } : {}),
        ...(epoch ? { execution_epoch: epoch } : {}),
        ...(stopPose ? { stop_pose: stopPose } : {}),
      }),
    });
    return parseEntity(body);
  }

  async claimExecutionLeases(instanceId: string, entityIds: string[]): Promise<SpaceEntityExecutionLease[]> {
    if (entityIds.length === 0) return [];
    const body = await this.request('/execution-leases', {
      method: 'PUT',
      body: JSON.stringify({ instance_id: instanceId, entity_ids: entityIds.slice(0, 256) }),
    });
    if (!Array.isArray(body?.items) || body?.instance_id !== instanceId) {
      throw new SpaceEntityApiError(0, 'ENTITY_API_INVALID_RESPONSE', 'Invalid execution lease response.', body);
    }
    return body.items.map((item: any) => {
      if (
        typeof item?.entity_id !== 'string'
        || typeof item?.granted !== 'boolean'
        || !isInteger(item?.execution_epoch)
        || !(item?.lease_expires_at === null || typeof item?.lease_expires_at === 'string')
        || !(item?.executor_name === undefined || item?.executor_name === null || (typeof item.executor_name === 'string' && item.executor_name.length <= 100))
      ) {
        throw new SpaceEntityApiError(0, 'ENTITY_API_INVALID_RESPONSE', 'Invalid execution lease item.', item);
      }
      return item as SpaceEntityExecutionLease;
    });
  }
}
