import {
  readJsonResponse,
  readResponseBytes,
  resolveSafeHttpUrl,
  sha256Hex,
} from './NetworkSafety.ts';
import {
  decodeInventoryResource,
  encodeInventoryResource,
  inventoryResourceName,
  INVENTORY_PROTOBUF_SCHEMA_VERSION,
} from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';

export type SpaceMarketCategory = 'blockset' | 'entity' | 'colorset';
export type SpaceMarketSort = 'downloads' | 'likes' | 'latest';

export const MAX_MARKET_RESOURCE_BYTES = 8 * 1024 * 1024;
const MAX_MARKET_API_RESPONSE_BYTES = 1024 * 1024;

export interface SpaceMarketQuota {
  daily_limit: number;
  published_today: number;
  remaining_today: number;
}

export interface SpaceMarketResource {
  id: string;
  kind: SpaceMarketCategory;
  schema_version: typeof INVENTORY_PROTOBUF_SCHEMA_VERSION;
  name: string;
  license: 'AGPL-3.0-only';
  digest: string;
  publisher: { id: string | null; username: string | null };
  size_bytes: number;
  block_count: number;
  node_count: number;
  script_count: number;
  downloads_count: number;
  likes_count: number;
  is_liked: boolean;
  can_delete: boolean;
  content_url: string;
  created_at: string;
}

export interface SpaceMarketListResponse {
  items: SpaceMarketResource[];
  total: number;
  limit: number;
  offset: number;
  quota: SpaceMarketQuota;
}

export interface SpaceMarketDownload {
  id: string;
  kind: SpaceMarketCategory;
  name: string;
  license: 'AGPL-3.0-only';
  digest: string;
  downloads_count: number;
  download_url: string;
  payload: Uint8Array;
}

type SpaceMarketDownloadDescriptor = Omit<SpaceMarketDownload, 'payload'>;
type SpaceMarketContentIdentity = Pick<SpaceMarketDownload, 'kind' | 'name' | 'digest'>;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export class SpaceMarketError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: any;

  constructor(status: number, code: string, message: string, detail: any) {
    super(message);
    this.name = 'SpaceMarketError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export class SpaceMarketClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiOrigin: string, token: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = `${apiOrigin.replace(/\/+$/, '')}/space/api/v2/market`;
    this.token = token;
    // Window.fetch is a Web IDL method in some browsers and throws
    // "Illegal invocation" when it is detached from Window. Keep injected
    // test fetches working while always calling the function with its native
    // global receiver.
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    let body: any = null;
    try {
      body = await readJsonResponse(response, MAX_MARKET_API_RESPONSE_BYTES);
    } catch (error) {
      throw new SpaceMarketError(
        response.status,
        'MARKET_API_INVALID_RESPONSE',
        'The Space market API returned an invalid or oversized response.',
        error
      );
    }
    if (!response.ok) {
      const detail = body?.detail;
      throw new SpaceMarketError(
        response.status,
        detail?.code || `HTTP_${response.status}`,
        detail?.message || 'Space market request failed.',
        detail
      );
    }
    return body as T;
  }

  listResources(
    kind: SpaceMarketCategory,
    sort: SpaceMarketSort = 'latest',
    limit = 24,
    offset = 0,
    mine = false
  ): Promise<SpaceMarketListResponse> {
    const query = new URLSearchParams({
      kind,
      sort,
      limit: String(Math.max(1, Math.min(100, Math.floor(Number(limit) || 24)))),
      offset: String(Math.max(0, Math.floor(Number(offset) || 0)))
    });
    if (mine) query.set('mine', 'true');
    return this.request<SpaceMarketListResponse>(`/resources?${query}`);
  }

  publishResource(_kind: SpaceMarketCategory, payload: Uint8Array) {
    if (payload.byteLength < 1 || payload.byteLength > MAX_MARKET_RESOURCE_BYTES) {
      return Promise.reject(new SpaceMarketError(
        413,
        'MARKET_RESOURCE_TOO_LARGE',
        'Market resources must be non-empty and no larger than 8 MiB.',
        null
      ));
    }
    const body = new Uint8Array(payload.byteLength);
    body.set(payload);
    return this.request<{ resource: SpaceMarketResource; quota: SpaceMarketQuota }>('/resources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf' },
      body: body.buffer
    });
  }

  async loadResourceContent(
    contentUrl: string,
    signal?: AbortSignal,
    expected?: SpaceMarketContentIdentity
  ): Promise<Uint8Array> {
    let safeUrl: URL;
    try {
      safeUrl = resolveSafeHttpUrl(
        contentUrl,
        typeof window === 'undefined' ? this.baseUrl : window.location.href
      );
    } catch (error) {
      throw new SpaceMarketError(
        0,
        'MARKET_CDN_URL_REJECTED',
        'The market resource URL is not allowed.',
        error
      );
    }
    let response: Response;
    try {
      response = await this.fetchImpl(safeUrl.toString(), {
        headers: { Accept: 'application/x-protobuf' },
        signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      });
    } catch (error) {
      throw new SpaceMarketError(
        0,
        'MARKET_CDN_DOWNLOAD_FAILED',
        'Could not download the market resource from the CDN.',
        error
      );
    }
    let payload: Uint8Array | null = null;
    try {
      payload = response.ok
        ? await readResponseBytes(response, MAX_MARKET_RESOURCE_BYTES)
        : null;
    } catch (error) {
      throw new SpaceMarketError(
        response.status,
        'MARKET_CDN_RESPONSE_TOO_LARGE',
        'The CDN resource exceeds the 8 MiB safety limit.',
        error
      );
    }
    if (!response.ok || !payload || payload.byteLength === 0) {
      throw new SpaceMarketError(
        response.status,
        'MARKET_CDN_DOWNLOAD_FAILED',
        'The CDN returned an invalid market resource.',
        payload
      );
    }
    if (expected !== undefined) {
      const normalizedDigest = expected.digest.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(normalizedDigest)) {
        throw new SpaceMarketError(
          0,
          'MARKET_DIGEST_INVALID',
          'The market API returned an invalid resource digest.',
          expected.digest
        );
      }

      let portable: any;
      try {
        portable = decodeInventoryResource(payload, expected.kind).portable;
      } catch (error) {
        throw new SpaceMarketError(
          0,
          'MARKET_RESOURCE_INVALID',
          'The downloaded market resource is not valid inventory Protobuf.',
          error
        );
      }
      const canonicalPayload = encodeInventoryResource(expected.kind, portable);
      if (!bytesEqual(payload, canonicalPayload)) {
        throw new SpaceMarketError(
          0,
          'MARKET_RESOURCE_NON_CANONICAL',
          'The downloaded market resource is not the canonical inventory encoding.',
          null
        );
      }
      const actualName = inventoryResourceName(expected.kind, portable);
      if (actualName !== expected.name) {
        throw new SpaceMarketError(
          0,
          'MARKET_RESOURCE_NAME_MISMATCH',
          'The downloaded market resource name does not match the market API.',
          { expected: expected.name, actual: actualName }
        );
      }

      // The market digest is a semantic identity used for global duplicate
      // detection. Its backend contract recursively omits all display names,
      // so hashing the named CDN blob itself rejects every real publication.
      const digestPayload = encodeInventoryResource(expected.kind, portable, { includeNames: false });
      const actualDigest = await sha256Hex(digestPayload);
      if (actualDigest !== normalizedDigest) {
        throw new SpaceMarketError(
          0,
          'MARKET_DIGEST_MISMATCH',
          'The downloaded market resource failed its SHA-256 integrity check.',
          { expected: normalizedDigest, actual: actualDigest }
        );
      }
    }
    return payload;
  }

  async downloadResource(resourceId: string): Promise<SpaceMarketDownload> {
    const descriptor = await this.request<SpaceMarketDownloadDescriptor>(
      `/resources/${encodeURIComponent(resourceId)}/download`
    );
    const payload = await this.loadResourceContent(
      descriptor.download_url,
      undefined,
      descriptor
    );
    return { ...descriptor, payload };
  }

  toggleLike(resourceId: string) {
    return this.request<{ is_liked: boolean; likes_count: number }>(
      `/resources/${encodeURIComponent(resourceId)}/like`,
      { method: 'POST' }
    );
  }

  deleteResource(resourceId: string) {
    return this.request<{
      deleted: boolean;
      resource_id: string;
      cdn_object_deleted: boolean;
      cdn_invalidation_requested: boolean;
    }>(
      `/resources/${encodeURIComponent(resourceId)}`,
      { method: 'DELETE' }
    );
  }
}
