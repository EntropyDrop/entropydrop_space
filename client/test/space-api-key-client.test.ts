import test from 'node:test';
import assert from 'node:assert/strict';
import { SpaceApiKeyClient } from '../src/bootstrap/SpaceApiKeyClient.ts';


const metadata = {
  id: 'AbCdEfGhJkMnPqRs',
  name: 'Builder agent',
  key_prefix: 'edapi_AbCdEfGhJkMnPqRs_',
  scopes: ['space:entity:create', 'space:entity:run', 'space:blockset:build', 'space:entity:edit'],
  created_at: '2026-09-03T00:00:00+00:00',
  last_used_at: null,
};

test('SpaceApiKeyClient creates, lists, and revokes account-level keys with login auth', async () => {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, options: RequestInit = {}) => {
    calls.push({ url: String(url), options });
    if (options.method === 'POST') {
      return new Response(JSON.stringify({
        ...metadata,
        api_key: `${metadata.key_prefix}one-time-secret`,
      }), { status: 201 });
    }
    if (options.method === 'DELETE') {
      return new Response(JSON.stringify({ revoked: true, api_key_id: metadata.id }));
    }
    return new Response(JSON.stringify({ items: [metadata] }));
  };
  const client = new SpaceApiKeyClient(
    'https://api.example.test/',
    'login-token',
    fetchImpl as typeof fetch,
  );

  const listed = await client.list();
  const created = await client.create('Builder agent');
  await client.revoke(metadata.id);

  assert.equal(listed[0].key_prefix, metadata.key_prefix);
  assert.deepEqual(created.scopes, metadata.scopes);
  assert.equal(created.api_key, `${metadata.key_prefix}one-time-secret`);
  assert.equal((calls[0].options.headers as any).Authorization, 'Bearer login-token');
  assert.equal(calls[0].url, 'https://api.example.test/space/api/v2/api-keys');
  assert.deepEqual(JSON.parse(String(calls[1].options.body)), {
    name: 'Builder agent',
  });
  assert.equal(calls[2].options.method, 'DELETE');
  assert.match(calls[2].url, new RegExp(`/${metadata.id}$`));
});

test('invalid usage fails with a service error instead of breaking Settings', async () => {
  let requested = '';
  const client = new SpaceApiKeyClient('https://api.example.test/', 'login-token', (async url => {
    requested = String(url);
    return Response.json({ credits: 1 });
  }) as typeof fetch);
  await assert.rejects(client.usage('world-123'), { code: 'SPACE_API_USAGE_INVALID_RESPONSE' });
  assert.equal(requested, 'https://api.example.test/space/api/v2/worlds/world-123/api-usage');
});

test('API allowances work when the backend omits disabled hosting data', async () => {
  const quota = { used: 0, limit: 10, remaining: 10 };
  const body = {
    world_id: 'world-1', updated_at: '2026-09-05T00:00:00Z', credits: 12,
    features: { entity_hosting: false },
    pricing: { entity_create_credits: 0, blockset_build_credits: 0 },
    quotas: { api_keys: quota, entities: quota, entity_storage_bytes: quota, running_entities: quota,
      terrain: { hour: { ...quota, reset_at: '2026-09-05T01:00:00Z' }, day: { ...quota, reset_at: '2026-09-06T00:00:00Z' } } },
    limits: { blockset_blocks_per_build: 1024, terrain_chunks_per_build: 16, terrain_zones_per_build: 4,
      build_requests_per_minute: 30, build_requests_per_hour: 300 },
    admin_quota_exemptions: false,
  };
  const client = new SpaceApiKeyClient('https://api.example.test', 'token', (async () => Response.json(body)) as typeof fetch);
  const result = await client.usage('world-1');
  assert.equal(result.features?.entity_hosting, false);
  assert.equal(result.credits, 12);
  assert.equal(result.quotas.hosted_entities_world, undefined);
});
