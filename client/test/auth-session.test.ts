import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installSpaceAuthFetchInterceptor,
  jwtExpiresAt,
  refreshSpaceAuthSession,
} from '../src/bootstrap/SpaceAuthSession.ts';

test('split Space origin refreshes through cloud accounts and never authorizes other hosts', async () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new MemoryStorage();
  storage.setItem('token', 'old-token');
  const calls: Array<{ url: string; token: string | null }> = [];
  let rejectSpace = true;
  const fakeWindow = {
    location: { href: 'https://entropydrop.com/space/' },
    dispatchEvent() {},
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, token: new Headers(init?.headers).get('Authorization') });
      if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ access_token: 'fresh-token' }));
      if (url.startsWith('https://space-api.entropydrop.com/space/api/') && rejectSpace) {
        rejectSpace = false;
        return new Response(null, { status: 401 });
      }
      return new Response('{}');
    },
  };
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  try {
    installSpaceAuthFetchInterceptor('https://api.entropydrop.com', 'https://space-api.entropydrop.com');
    await fakeWindow.fetch('https://space-api.entropydrop.com/space/api/v2/bootstrap');
    await fakeWindow.fetch('https://api.entropydrop.com/space/api/v2/api-keys');
    await fakeWindow.fetch('https://cdn.entropydrop.com/space/api/v2/untrusted');
    await fakeWindow.fetch('https://space-api.entropydrop.com/skin/api/auth/me');
    assert.deepEqual(calls.map(c => c.token), ['Bearer old-token', null, 'Bearer fresh-token', 'Bearer fresh-token', null, null]);
    assert.equal(calls[1].url, 'https://api.entropydrop.com/skin/api/auth/refresh');
  } finally {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
    else delete (globalThis as any).window;
    if (priorStorage) Object.defineProperty(globalThis, 'localStorage', priorStorage);
    else delete (globalThis as any).localStorage;
  }
});

class MemoryStorage {
  values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function unsignedToken(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `header.${payload}.signature`;
}

test('Space refresh stores a new short-lived access token using the HttpOnly cookie', async () => {
  const storage = new MemoryStorage();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ access_token: 'fresh-access-token' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await refreshSpaceAuthSession('https://api.entropydrop.com/skin', {
    fetchImpl: fetchImpl as typeof fetch,
    storage,
  });

  assert.deepEqual(result, { token: 'fresh-access-token', terminal: false });
  assert.equal(storage.getItem('token'), 'fresh-access-token');
  assert.equal(requests[0].url, 'https://api.entropydrop.com/skin/api/auth/refresh');
  assert.equal(requests[0].init?.method, 'POST');
  assert.equal(requests[0].init?.credentials, 'include');
  assert.equal(requests[0].init?.cache, 'no-store');
});

test('Space distinguishes an expired login session from a temporary refresh failure', async () => {
  const storage = new MemoryStorage();
  const unauthorized = await refreshSpaceAuthSession('https://api.entropydrop.com', {
    fetchImpl: (async () => new Response(null, { status: 401 })) as typeof fetch,
    storage,
  });
  const unavailable = await refreshSpaceAuthSession('https://api.entropydrop.com', {
    fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch,
    storage,
  });

  assert.deepEqual(unauthorized, { token: null, terminal: true });
  assert.deepEqual(unavailable, { token: null, terminal: false });
});

test('Space can evaluate access-token expiry without trusting token contents', () => {
  const future = Math.floor(Date.now() / 1000) + 60;
  const past = Math.floor(Date.now() / 1000) - 60;

  assert.equal(jwtExpiresAt(unsignedToken(future)), future * 1000);
  assert.equal(jwtExpiresAt(unsignedToken(past)), past * 1000);
  assert.equal(jwtExpiresAt('not-a-jwt'), null);
});
