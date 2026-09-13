import { readJsonResponse } from './NetworkSafety.ts';
import { spaceAgentConnection } from './SpaceAgentGuide.ts';


const MAX_API_KEY_RESPONSE_BYTES = 256 * 1024;

export type SpaceApiKeyScope = 'space:entity:create' | 'space:entity:run' | 'space:entity:edit' | 'space:blockset:build';

export interface SpaceApiKeyRecord {
  id: string;
  name: string;
  key_prefix: string;
  scopes: SpaceApiKeyScope[];
  created_at: string;
  last_used_at: string | null;
}

export interface CreatedSpaceApiKey extends SpaceApiKeyRecord {
  api_key: string;
}

export class SpaceApiKeyError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: any;

  constructor(status: number, code: string, message: string, detail: any) {
    super(message);
    this.name = 'SpaceApiKeyError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function parseApiKey(value: any): SpaceApiKeyRecord {
  if (
    typeof value?.id !== 'string'
    || typeof value?.name !== 'string'
    || typeof value?.key_prefix !== 'string'
    || !value.key_prefix.startsWith('edapi_')
    || !Array.isArray(value?.scopes)
    || value.scopes.some((scope: unknown) => ![
      'space:entity:create',
      'space:entity:run',
      'space:entity:edit',
      'space:blockset:build',
    ].includes(String(scope)))
    || !value.scopes.includes('space:entity:create')
    || typeof value?.created_at !== 'string'
    || !(value?.last_used_at === null || typeof value?.last_used_at === 'string')
  ) {
    throw new SpaceApiKeyError(
      0,
      'SPACE_API_KEY_INVALID_RESPONSE',
      'The Space API key service returned an invalid response.',
      value,
    );
  }
  return value as SpaceApiKeyRecord;
}

export class SpaceApiKeyClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly usageOrigin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiOrigin: string, token: string, fetchImpl: typeof fetch = fetch, spaceOrigin: string = apiOrigin) {
    this.baseUrl = `${apiOrigin.replace(/\/+$/, '')}/space/api/v2/api-keys`;
    this.token = token;
    this.usageOrigin = spaceOrigin.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  getAgentConnection() {
    return spaceAgentConnection(this.usageOrigin);
  }

  private async request(path: string, options: RequestInit = {}, origin?: string): Promise<any> {
    const response = await this.fetchImpl(new URL(origin ? `${origin}${path}` : `${this.baseUrl}${path}`).href, {
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
      body = await readJsonResponse(response, MAX_API_KEY_RESPONSE_BYTES);
    } catch (error) {
      throw new SpaceApiKeyError(
        response.status,
        'SPACE_API_KEY_INVALID_RESPONSE',
        'The Space API key service returned an invalid response.',
        error,
      );
    }
    if (!response.ok) {
      const detail = body?.detail;
      throw new SpaceApiKeyError(
        response.status,
        detail?.code || `HTTP_${response.status}`,
        detail?.message || 'Space API key request failed.',
        detail,
      );
    }
    return body;
  }

  async list(): Promise<SpaceApiKeyRecord[]> {
    const body = await this.request('');
    if (!Array.isArray(body?.items)) {
      throw new SpaceApiKeyError(
        0,
        'SPACE_API_KEY_INVALID_RESPONSE',
        'The Space API key list is invalid.',
        body,
      );
    }
    return body.items.map(parseApiKey);
  }

  async create(name: string): Promise<CreatedSpaceApiKey> {
    const body = await this.request('', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    const record = parseApiKey(body);
    if (typeof body?.api_key !== 'string' || !body.api_key.startsWith(record.key_prefix)) {
      throw new SpaceApiKeyError(
        0,
        'SPACE_API_KEY_INVALID_RESPONSE',
        'The new Space API key is missing from the response.',
        body,
      );
    }
    return { ...record, api_key: body.api_key };
  }

  async usage(worldId: string): Promise<SpaceApiUsage> {
    const body = await this.request(`/space/api/v2/worlds/${encodeURIComponent(worldId)}/api-usage`, {}, this.usageOrigin);
    const nonnegative = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
    const allowance = (value: any) => value && ['used', 'limit', 'remaining'].every(key => nonnegative(value[key]));
    if (body?.world_id !== worldId || !nonnegative(body?.credits)
      || !Number.isFinite(Date.parse(body?.updated_at))
      || !['entity_create_credits', 'blockset_build_credits'].every(key => nonnegative(body?.pricing?.[key]))
      || !['api_keys', 'entities', 'entity_storage_bytes', 'running_entities'].every(key => allowance(body?.quotas?.[key]))
      || !['hour', 'day'].every(key => allowance(body?.quotas?.terrain?.[key]) && Number.isFinite(Date.parse(body.quotas.terrain[key].reset_at)))
      || !['blockset_blocks_per_build', 'terrain_chunks_per_build', 'terrain_zones_per_build', 'build_requests_per_minute', 'build_requests_per_hour'].every(key => nonnegative(body?.limits?.[key]))
      || typeof body?.admin_quota_exemptions !== 'boolean'
      || (body?.features?.entity_hosting === true && (
        !['hosting_credits_per_hour', 'hosting_max_budget_credits'].every(key => nonnegative(body?.pricing?.[key]))
        || !allowance(body?.quotas?.hosted_entities_world)
        || !['hosted_blocks_per_entity', 'hosted_components_per_entity'].every(key => nonnegative(body?.limits?.[key]))
      ))) {
      throw new SpaceApiKeyError(0, 'SPACE_API_USAGE_INVALID_RESPONSE', 'The Space API allowance response is invalid.', body);
    }
    return body;
  }

  async revoke(apiKeyId: string): Promise<void> {
    const body = await this.request(`/${encodeURIComponent(apiKeyId)}`, { method: 'DELETE' });
    if (body?.revoked !== true || body?.api_key_id !== apiKeyId) {
      throw new SpaceApiKeyError(
        0,
        'SPACE_API_KEY_INVALID_RESPONSE',
        'The Space API key revoke response is invalid.',
        body,
      );
    }
  }
}


export interface ApiAllowance { used: number; limit: number; remaining: number }
export interface SpaceApiUsage {
  world_id: string;
  updated_at: string;
  features?: { entity_hosting: boolean };
  credits: number;
  pricing: {
    entity_create_credits: number;
    blockset_build_credits: number;
    hosting_credits_per_hour?: number;
    hosting_billing?: string;
    hosting_max_budget_credits?: number;
  };
  quotas: {
    api_keys: ApiAllowance;
    entities: ApiAllowance;
    entity_storage_bytes: ApiAllowance;
    running_entities: ApiAllowance;
    hosted_entities_world?: ApiAllowance;
    terrain: { hour: ApiAllowance & { reset_at: string }; day: ApiAllowance & { reset_at: string } };
  };
  limits: {
    blockset_blocks_per_build: number;
    blockset_definition_bytes: number;
    build_requests_per_minute: number;
    build_requests_per_hour: number;
    entity_create_requests_per_minute: number;
    entity_create_requests_per_hour: number;
    terrain_submitted_per_10_seconds: number;
    terrain_chunks_per_build: number;
    terrain_zones_per_build: number;
    build_retry_days: number;
    hosted_blocks_per_entity?: number;
    hosted_components_per_entity?: number;
  };
  admin_quota_exemptions: boolean;
}
