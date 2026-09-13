import { readJsonResponse } from './NetworkSafety.ts';

type SpaceAuthStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;

export interface SpaceSessionRefreshResult {
  token: string | null;
  terminal: boolean;
}

let installed = false;
let installedApiOrigin = '';
let installedSpaceOrigin = '';
let browserFetch: typeof fetch | null = null;
let refreshInFlight: Promise<SpaceSessionRefreshResult> | null = null;

function normalizedOrigin(apiOrigin: string): string {
  return new URL(apiOrigin).origin;
}

function absoluteUrl(input: RequestInfo | URL): URL | null {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    return new URL(raw, typeof window === 'undefined' ? installedApiOrigin : window.location.href);
  } catch {
    return null;
  }
}

function isEntropyDropApi(url: URL | null, apiOrigin: string): boolean {
  return !!url
    && ((url.origin === normalizedOrigin(apiOrigin)
      && (/^\/space\/api(?:\/|$)/.test(url.pathname) || /^\/skin\/api(?:\/|$)/.test(url.pathname)))
      || (url.origin === installedSpaceOrigin && /^\/space\/api(?:\/|$)/.test(url.pathname)));
}

function isSessionControlRequest(url: URL | null): boolean {
  return !!url && /^\/skin\/api\/auth\/(?:google|refresh|logout)\/?$/.test(url.pathname);
}

export function jwtExpiresAt(token: string): number | null {
  try {
    const segment = token.split('.')[1];
    if (!segment) return null;
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')));
    return Number.isFinite(payload?.exp) ? Number(payload.exp) * 1000 : null;
  } catch {
    return null;
  }
}

export async function refreshSpaceAuthSession(
  apiOrigin: string,
  options: {
    fetchImpl?: typeof fetch;
    storage?: SpaceAuthStorage;
    timeoutMs?: number;
  } = {},
): Promise<SpaceSessionRefreshResult> {
  const fetchImpl = options.fetchImpl || browserFetch || fetch;
  const storage = options.storage || localStorage;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    const response = await fetchImpl(`${normalizedOrigin(apiOrigin)}/skin/api/auth/refresh`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      return { token: null, terminal: response.status === 401 || response.status === 403 };
    }
    const data = await readJsonResponse<any>(response, MAX_AUTH_RESPONSE_BYTES).catch(() => null);
    const token = typeof data?.access_token === 'string' ? data.access_token : null;
    if (!token) return { token: null, terminal: true };
    storage.setItem('token', token);
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('auth-token-updated'));
    return { token, terminal: false };
  } catch {
    return { token: null, terminal: false };
  } finally {
    clearTimeout(timeout);
  }
}

function refreshOnce(apiOrigin: string): Promise<SpaceSessionRefreshResult> {
  if (!refreshInFlight) {
    refreshInFlight = refreshSpaceAuthSession(apiOrigin).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export async function ensureSpaceAccessToken(apiOrigin: string): Promise<string | null> {
  const existingToken = localStorage.getItem('token');
  const result = await refreshOnce(apiOrigin);
  if (result.token) return result.token;

  const expiresAt = existingToken ? jwtExpiresAt(existingToken) : null;
  if (existingToken && expiresAt !== null && expiresAt > Date.now()) return existingToken;
  if (existingToken && (result.terminal || expiresAt === null || expiresAt <= Date.now())) {
    localStorage.removeItem('token');
  }
  return null;
}

function prepareRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  apiOrigin: string,
  token: string | null,
): { input: RequestInfo | URL; init?: RequestInit; retryInput: RequestInfo | URL; retryInit?: RequestInit } {
  const url = absoluteUrl(input);
  const isApi = isEntropyDropApi(url, apiOrigin);
  const shouldAuthorize = isApi && !isSessionControlRequest(url);

  if (input instanceof Request) {
    const headers = new Headers(init?.headers || input.headers);
    if (shouldAuthorize && token) headers.set('Authorization', `Bearer ${token}`);
    else if (shouldAuthorize) headers.delete('Authorization');
    const request = new Request(input, {
      ...init,
      headers,
      credentials: init?.credentials || (isApi ? 'include' : input.credentials),
    });
    return { input: request, retryInput: request.clone() };
  }

  const headers = new Headers(init?.headers || {});
  if (shouldAuthorize && token) headers.set('Authorization', `Bearer ${token}`);
  else if (shouldAuthorize) headers.delete('Authorization');
  const preparedInit: RequestInit = {
    ...init,
    headers,
    credentials: init?.credentials || (isApi ? 'include' : undefined),
  };
  return { input, init: preparedInit, retryInput: input, retryInit: preparedInit };
}

export function installSpaceAuthFetchInterceptor(apiOrigin: string, spaceOrigin: string = apiOrigin): void {
  if (typeof window === 'undefined') return;
  installedApiOrigin = normalizedOrigin(apiOrigin);
  installedSpaceOrigin = normalizedOrigin(spaceOrigin);
  if (installed) return;

  installed = true;
  browserFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = absoluteUrl(input);
    const isApi = isEntropyDropApi(url, installedApiOrigin);
    const prepared = prepareRequest(input, init, installedApiOrigin, localStorage.getItem('token'));
    let response = await browserFetch!(prepared.input, prepared.init);

    if (response.status === 401 && isApi && !isSessionControlRequest(url)) {
      const refreshed = await refreshOnce(installedApiOrigin);
      if (refreshed.token) {
        const retry = prepareRequest(
          prepared.retryInput,
          prepared.retryInit,
          installedApiOrigin,
          refreshed.token,
        );
        response = await browserFetch!(retry.input, retry.init);
      } else if (refreshed.terminal) {
        localStorage.removeItem('token');
        window.dispatchEvent(new Event('logout'));
      }
    }
    return response;
  };
}
