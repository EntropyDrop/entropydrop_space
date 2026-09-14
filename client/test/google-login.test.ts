import test from 'node:test';
import assert from 'node:assert/strict';
import { signInToSpaceWithGoogle } from '../src/bootstrap/SpaceGoogleLogin.ts';

test('Space exchanges Google credentials with the main account API and saves the returned access token', async () => {
  const saved = new Map<string, string>();
  const calls: { url: string; init?: RequestInit }[] = [];
  const token = await signInToSpaceWithGoogle('https://api.entropydrop.com/skin', 'google-id-token', async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ access_token: 'account-access-token' }));
  }, { setItem: (key, value) => saved.set(key, value) });
  assert.equal(token, 'account-access-token');
  assert.equal(saved.get('token'), token);
  assert.equal(calls[0].url, 'https://api.entropydrop.com/api/auth/google');
  assert.equal(calls[0].init?.credentials, 'include');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { token: 'google-id-token' });
});

for (const status of [401, 403, 500, 200]) {
  test(`Google rejection or malformed response (${status}) does not overwrite the existing account`, async () => {
    let saved = false;
    await assert.rejects(signInToSpaceWithGoogle('https://api.entropydrop.com', 'google-id-token', async () => {
      return new Response('{}', { status });
    }, { setItem: () => { saved = true; } }));
    assert.equal(saved, false);
  });
}
