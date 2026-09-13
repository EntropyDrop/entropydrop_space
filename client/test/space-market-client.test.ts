import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SpaceMarketClient, SpaceMarketError } from '../src/bootstrap/SpaceMarketClient.ts';
import { decodeInventoryResource, encodeInventoryResource } from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';

const COLORSET = {
  type: 'space-colorset',
  version: 7,
  name: 'Sunset',
  colors: [
    '#111111', '#222222', '#333333',
    '#444444', '#555555', '#666666',
    '#777777', '#888888', '#999999',
  ],
};
const COLORSET_PROTOBUF = encodeInventoryResource('colorset', COLORSET);
const COLORSET_DIGEST = createHash('sha256')
  .update(encodeInventoryResource('colorset', { ...COLORSET, name: '' }))
  .digest('hex');

const BLOCKSET = {
  type: 'space-blockset',
  version: 7,
  name: 'Signal tower',
  blocks: [{ dx: 1, dy: 2, dz: 3, block: 1, color: 0xf2a93b }],
};
const BLOCKSET_PROTOBUF = encodeInventoryResource('blockset', BLOCKSET);
// Cross-language fixture for the backend's deterministic, name-omitting digest.
const BLOCKSET_DIGEST = 'c190d16dabdeff20bbf2285fd6bb67c10c7cdace60227ae8eb4d7a1699446bb2';

test('market component names match Python bytes and recursive name-free digests', async () => {
  const component = (id, name, children) => ({ id, name, body: { type: 'dynamic' }, blocks: [], seats: [], children });
  const entity = { type: 'space-entity', version: 7, constraints: [],
    root: component('world', '机体', [component('root', '模块', [component('tip', '末端', [])])]) };
  const wire = encodeInventoryResource('entity', entity);
  assert.equal(Buffer.from(wire).toString('hex'), '08075a3612340a05776f726c641a0042210a04726f6f741a00420f0a037469701a006206e69cabe7abaf6206e6a8a1e59d976206e69cbae4bd93');
  assert.deepEqual(decodeInventoryResource(wire).portable, entity);
  const digest = '3aa9f6f2d1a424d0f63d1fb4fe85d927eac86db793c6afa5d4095391b994f4c8';
  assert.equal(createHash('sha256').update(encodeInventoryResource('entity', entity, { includeNames: false })).digest('hex'), digest);
  assert.equal(entity.root.children[0].name, '模块', 'digest encoding does not mutate names');
  let payload = wire;
  const client = new SpaceMarketClient('https://api.example.test', 'token', async () => new Response(responseBody(payload)));
  await client.loadResourceContent('https://cdn.example.test/entity.pb', undefined, { kind: 'entity', name: '机体', digest });

  entity.root.name = '';
  entity.root.children[0].name = 'Renamed';
  entity.root.children[0].children[0].name = 'Renamed';
  payload = encodeInventoryResource('entity', entity);
  await client.loadResourceContent('https://cdn.example.test/entity.pb', undefined, { kind: 'entity', name: 'world', digest });
  entity.root.children[0].children[0].body.type = 'kinematic';
  payload = encodeInventoryResource('entity', entity);
  await assert.rejects(client.loadResourceContent('https://cdn.example.test/entity.pb', undefined, { kind: 'entity', name: 'world', digest }),
    error => error instanceof SpaceMarketError && error.code === 'MARKET_DIGEST_MISMATCH');
});

function responseBody(bytes: Uint8Array): ArrayBuffer {
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return body.buffer;
}

test('SpaceMarketClient sends authenticated market list, publish, download, like, and delete requests', async () => {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, options: RequestInit = {}) => {
    calls.push({ url: String(url), options });
    const value = String(url);
    if (value === 'https://cdn.example.test/space-market/resources/r1/content.pb') {
      return new Response(responseBody(COLORSET_PROTOBUF), { status: 200 });
    }
    if (value.endsWith('/download')) {
      return new Response(JSON.stringify({
        id: 'r1',
        kind: 'colorset',
        name: COLORSET.name,
        digest: COLORSET_DIGEST,
        download_url: 'https://cdn.example.test/space-market/resources/r1/content.pb'
      }), { status: 200 });
    }
    if (value.endsWith('/like')) {
      return new Response(JSON.stringify({ is_liked: true, likes_count: 1 }), { status: 200 });
    }
    if (options.method === 'DELETE') {
      return new Response(JSON.stringify({ deleted: true, resource_id: 'r1' }), { status: 200 });
    }
    if (options.method === 'POST') {
      return new Response(JSON.stringify({ resource: { id: 'r1' }, quota: { remaining_today: 9 } }), { status: 201 });
    }
    return new Response(JSON.stringify({ items: [], total: 0, quota: { remaining_today: 10 } }), { status: 200 });
  };
  const client = new SpaceMarketClient('https://api.entropydrop.com/', 'token-1', fetchImpl as typeof fetch);

  await client.listResources('entity', 'downloads', 24, 0, true);
  const protobuf = COLORSET_PROTOBUF;
  await client.publishResource('colorset', protobuf);
  const downloaded = await client.downloadResource('r1');
  await client.toggleLike('r1');
  await client.deleteResource('r1');

  assert.equal(calls.length, 6);
  assert.match(calls[0].url, /kind=entity/);
  assert.match(calls[0].url, /sort=downloads/);
  assert.match(calls[0].url, /mine=true/);
  assert.equal((calls[0].options.headers as any).Authorization, 'Bearer token-1');
  assert.deepEqual(new Uint8Array(calls[1].options.body as ArrayBuffer), protobuf);
  assert.equal((calls[1].options.headers as any)['Content-Type'], 'application/x-protobuf');
  assert.equal(calls[2].options.method, undefined);
  assert.equal(calls[3].url, 'https://cdn.example.test/space-market/resources/r1/content.pb');
  assert.equal((calls[3].options.headers as any).Authorization, undefined);
  assert.deepEqual(downloaded.payload, protobuf);
  assert.equal(calls[4].options.method, 'POST');
  assert.equal(calls[5].options.method, 'DELETE');
});

test('SpaceMarketClient reports invalid CDN responses separately from API errors', async () => {
  const fetchImpl = async (url: string | URL | Request) => {
    if (String(url).includes('/download')) {
      return new Response(JSON.stringify({
        id: 'r1',
        kind: 'blockset',
        download_url: 'https://cdn.example.test/missing.json'
      }), { status: 200 });
    }
    return new Response('missing', { status: 404 });
  };
  const client = new SpaceMarketClient('https://api.example.test', 'token', fetchImpl as typeof fetch);

  await assert.rejects(
    () => client.downloadResource('r1'),
    (error: any) => {
      assert.ok(error instanceof SpaceMarketError);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'MARKET_CDN_DOWNLOAD_FAILED');
      return true;
    }
  );
});

test('SpaceMarketClient loads previews directly from the CDN without calling the counted download endpoint', async () => {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const contentUrl = 'https://cdn.example.test/space-market/resources/r1/content.pb';
  const fetchImpl = async (url: string | URL | Request, options: RequestInit = {}) => {
    calls.push({ url: String(url), options });
    return new Response(responseBody(BLOCKSET_PROTOBUF), { status: 200 });
  };
  const client = new SpaceMarketClient('https://api.example.test', 'token', fetchImpl as typeof fetch);

  const preview = await client.loadResourceContent(contentUrl, undefined, {
    kind: 'blockset',
    name: BLOCKSET.name,
    digest: BLOCKSET_DIGEST,
  });

  assert.deepEqual(preview, BLOCKSET_PROTOBUF);
  assert.deepEqual(calls.map(call => call.url), [contentUrl]);
  assert.equal((calls[0].options.headers as any).Authorization, undefined);
  assert.equal(calls.some(call => call.url.endsWith('/download')), false);
  assert.notEqual(
    createHash('sha256').update(BLOCKSET_PROTOBUF).digest('hex'),
    BLOCKSET_DIGEST,
    'the API digest omits the display name and is not the raw CDN blob digest'
  );
  assert.equal(
    createHash('sha256')
      .update(encodeInventoryResource('blockset', { ...BLOCKSET, name: '' }))
      .digest('hex'),
    BLOCKSET_DIGEST,
    'the frontend must reproduce the backend canonical content digest'
  );
});

test('SpaceMarketClient rejects unsafe, oversized, and digest-mismatched CDN content', async () => {
  const fetchImpl = async () => new Response(Uint8Array.from([8, 4, 26, 0]), {
    status: 200,
    headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) }
  });
  const client = new SpaceMarketClient('https://api.example.test', 'token', fetchImpl as typeof fetch);

  await assert.rejects(
    () => client.loadResourceContent('http://cdn.example.test/content.pb'),
    (error: any) => error instanceof SpaceMarketError && error.code === 'MARKET_CDN_URL_REJECTED'
  );
  await assert.rejects(
    () => client.loadResourceContent('https://cdn.example.test/content.pb'),
    (error: any) => error instanceof SpaceMarketError && error.code === 'MARKET_CDN_RESPONSE_TOO_LARGE'
  );

  const digestClient = new SpaceMarketClient(
    'https://api.example.test',
    'token',
    (async () => new Response(responseBody(BLOCKSET_PROTOBUF), { status: 200 })) as typeof fetch
  );
  await assert.rejects(
    () => digestClient.loadResourceContent('https://cdn.example.test/content.pb', undefined, {
      kind: 'blockset',
      name: BLOCKSET.name,
      digest: '0'.repeat(64),
    }),
    (error: any) => error instanceof SpaceMarketError && error.code === 'MARKET_DIGEST_MISMATCH'
  );
  await assert.rejects(
    () => digestClient.loadResourceContent('https://cdn.example.test/content.pb', undefined, {
      kind: 'blockset',
      name: 'Tampered name',
      digest: BLOCKSET_DIGEST,
    }),
    (error: any) => error instanceof SpaceMarketError && error.code === 'MARKET_RESOURCE_NAME_MISMATCH'
  );

  const protobufWithUnknownField = new Uint8Array(BLOCKSET_PROTOBUF.byteLength + 3);
  protobufWithUnknownField.set(BLOCKSET_PROTOBUF);
  protobufWithUnknownField.set([0xf8, 0x07, 0x01], BLOCKSET_PROTOBUF.byteLength);
  const nonCanonicalClient = new SpaceMarketClient(
    'https://api.example.test',
    'token',
    (async () => new Response(responseBody(protobufWithUnknownField), { status: 200 })) as typeof fetch
  );
  await assert.rejects(
    () => nonCanonicalClient.loadResourceContent('https://cdn.example.test/content.pb', undefined, {
      kind: 'blockset',
      name: BLOCKSET.name,
      digest: BLOCKSET_DIGEST,
    }),
    (error: any) => error instanceof SpaceMarketError && error.code === 'MARKET_RESOURCE_NON_CANONICAL'
  );
});

test('SpaceMarketClient exposes structured backend errors', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    detail: { code: 'RESOURCE_ALREADY_PUBLISHED', message: 'Duplicate resource', resource_id: 'existing' }
  }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  const client = new SpaceMarketClient('http://localhost:8000', 'token', fetchImpl as typeof fetch);

  await assert.rejects(
    () => client.publishResource('blockset', Uint8Array.from([8, 4, 18, 0])),
    (error: any) => {
      assert.ok(error instanceof SpaceMarketError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'RESOURCE_ALREADY_PUBLISHED');
      assert.equal(error.detail.resource_id, 'existing');
      return true;
    }
  );
});

test('SpaceMarketClient keeps native fetch bound to the browser global', async () => {
  let receiver: unknown;
  const receiverSensitiveFetch = function (this: unknown) {
    receiver = this;
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return Promise.resolve(new Response(JSON.stringify({
      items: [],
      total: 0,
      limit: 24,
      offset: 0,
      quota: { daily_limit: 10, published_today: 0, remaining_today: 10 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  } as typeof fetch;

  const client = new SpaceMarketClient('https://api.example.test', 'token', receiverSensitiveFetch);
  await client.listResources('blockset');

  assert.equal(receiver, globalThis);
});
