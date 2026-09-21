import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelSpaceAdmission,
  createPlayerPositionRemote,
  DEFAULT_PLAYER_SKIN_URL,
  encodePlayerPosition,
  hasPngSignature,
  initialTerrainStreamArea,
  loadTerrainEditRemote,
  parseSpaceBootstrapPayload,
  requestSpaceAdmission,
  requestedSpaceWorld,
  resolveApiOrigin,
  resolveInitialPlayerPose,
  terrainStreamAreaForPosition,
  terrainStreamAreaForPositionWithHysteresis,
} from '../src/bootstrap/SpaceBootstrap.ts';

test('Space derives the API origin from the main frontend API configuration', () => {
  assert.equal(resolveApiOrigin('http://localhost:8000/skin', 'http://localhost:5173'), 'http://localhost:8000');
  assert.equal(resolveApiOrigin('https://api.entropydrop.com/skin/', 'https://entropydrop.com'), 'https://api.entropydrop.com');
});

test('Space selects an alternate development world from the entry URL', () => {
  assert.equal(requestedSpaceWorld('?world=copper-metropolis&sso_attempted=1'), 'copper-metropolis');
  assert.equal(requestedSpaceWorld('?sso_attempted=1'), null);
  assert.equal(requestedSpaceWorld('?world=%20%20'), null);
});

test('Space accepts only a PNG signature before decoding the configured skin', () => {
  assert.equal(hasPngSignature(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
  assert.equal(hasPngSignature(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), false);
});

test('Space validates the bootstrap V2 contract before constructing the game', () => {
  const payload = {
    protocol_version: 2,
    max_online_players: 32,
    queue_enabled: true,
    websocket_url: '/space/ws/v2',
    world: {
      id: 'world-1',
      name: 'EntropyDrop Space',
      seed: 20260827,
      terrain_generator_version: 1,
      terrain_revision: 0,
      surface_snapshot_url: '/space/api/v2/worlds/world-1/surface-zones',
    },
    player: {
      user_id: 'user-1',
      username: 'Alice',
      player_entity_id: 'entity-1',
      skin_url: 'https://cdn.example.test/alice.png',
      skin_type: 'strong',
      start_x_cm: 0,
      start_y_cm: 3200,
      start_z_cm: 204799,
      start_yaw_q15: -32767,
      resumed: false,
    },
  };

  assert.equal(parseSpaceBootstrapPayload(payload), payload);
  assert.throws(() => parseSpaceBootstrapPayload({ ...payload, protocol_version: 3 }), /API V2/);
  assert.throws(() => parseSpaceBootstrapPayload({
    ...payload,
    player: { ...payload.player, start_z_cm: null },
  }), /API V2/);

  const withoutCharacterSkin = parseSpaceBootstrapPayload({
    ...payload,
    player: {
      ...payload.player,
      skin_url: null,
      skin_type: 'slim',
    },
  });
  assert.equal(withoutCharacterSkin.player.skin_url, DEFAULT_PLAYER_SKIN_URL);
  assert.equal(withoutCharacterSkin.player.skin_type, 'strong');
});

test('Space loads every terrain snapshot page and posts authenticated mutation batches', async () => {
  const requests: { url: string; options: RequestInit }[] = [];
  const fetchImpl = async (url: string | URL | Request, options: RequestInit = {}) => {
    const value = String(url);
    requests.push({ url: value, options });
    if (options.method === 'POST') {
      return new Response(JSON.stringify({ applied: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const parsed = new URL(value);
    const cursor = parsed.searchParams.get('cursor');
    return new Response(JSON.stringify(cursor
      ? {
          chunks: [{ chunk_x: 2, chunk_z: 0, revision: 2, standard: [], micro: [] }],
          next_cursor: null
        }
      : {
          chunks: [{ chunk_x: 0, chunk_z: 0, revision: 1, standard: [], micro: [] }],
          next_cursor: '0,0'
        }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const remote = await loadTerrainEditRemote(
    'https://api.entropydrop.com',
    'test-token',
    '00000000-0000-0000-0000-000000000001',
    fetchImpl as typeof fetch,
    undefined,
    terrainStreamAreaForPosition(8192, 1024)
  );
  const initialRequestCount = requests.length;
  const streamedPages: number[][] = [];
  await remote.loadArea?.(516, 68, 32, chunks => {
    streamedPages.push(chunks.map(chunk => chunk.chunk_x));
  });
  await remote.sendBatch('00000000-0000-4000-8000-000000000001', [{
    kind: 'set_standard', x: 1, y: 80, z: 1, block: 1, color: 0x123456
  }]);

  assert.deepEqual(remote.chunks.map(chunk => chunk.chunk_x), [0, 2]);
  assert.equal(requests.length, 5);
  assert.equal(initialRequestCount, 2);
  assert.equal((requests[0].options.headers as any).Authorization, 'Bearer test-token');
  assert.match(requests[0].url, /limit=64/);
  assert.match(requests[0].url, /center_chunk_x=516/);
  assert.match(requests[0].url, /center_chunk_z=68/);
  assert.match(requests[0].url, /radius_chunks=32/);
  assert.match(requests[1].url, /cursor=0%2C0/);
  assert.match(requests[3].url, /cursor=0%2C0/);
  assert.deepEqual(streamedPages, [[0], [2]]);
  assert.deepEqual(JSON.parse(String(requests[4].options.body)), {
    batch_id: '00000000-0000-4000-8000-000000000001',
    mutations: [{ kind: 'set_standard', x: 1, y: 80, z: 1, block: 1, color: 0x123456 }]
  });
});

test('terrain AOI windows are tiled, wrapped, and overlap the maximum render distance', () => {
  assert.deepEqual(terrainStreamAreaForPosition(8192, 1024), {
    centerChunkX: 516,
    centerChunkZ: 68,
    radiusChunks: 32,
    key: '516,68,32',
  });
  assert.equal(terrainStreamAreaForPosition(-1, -1).centerChunkX, 1020);
  assert.equal(terrainStreamAreaForPosition(-1, -1).centerChunkZ, 124);
});

test('terrain AOI hysteresis suppresses repeated loads around tile boundaries', () => {
  const leftArea = terrainStreamAreaForPosition(127, 64);
  const rightArea = terrainStreamAreaForPosition(129, 64);
  assert.notEqual(leftArea.key, rightArea.key);

  // Crossing the raw 128m tile edge by a small amount keeps the loaded AOI.
  assert.equal(
    terrainStreamAreaForPositionWithHysteresis(129, 64, leftArea).key,
    leftArea.key
  );
  // The switch commits after moving 1.5 chunks beyond the raw boundary.
  assert.equal(
    terrainStreamAreaForPositionWithHysteresis(153, 64, leftArea).key,
    rightArea.key
  );
  // Switching back also requires meaningful penetration into the old tile.
  assert.equal(
    terrainStreamAreaForPositionWithHysteresis(127, 64, rightArea).key,
    rightArea.key
  );
  assert.equal(
    terrainStreamAreaForPositionWithHysteresis(103, 64, rightArea).key,
    leftArea.key
  );
});

test('Space consumes backend resume/random starts and samples the whole world only for a legacy bootstrap fallback', () => {
  const player = {
    user_id: 'user-001',
    username: 'alice',
    player_entity_id: 'entity-001',
    skin_url: 'https://cdn.entropydrop.com/skins/alice.png',
    skin_type: 'strong' as const,
    start_x_cm: 12345,
    start_y_cm: 6789,
    start_z_cm: 23456,
    start_yaw_q15: 16384,
    resumed: true,
  };

  assert.deepEqual(resolveInitialPlayerPose(player), {
    x: 123.45,
    y: 67.89,
    z: 234.56,
    yaw: (16384 / 32767) * Math.PI,
    resumed: true,
  });

  assert.deepEqual(resolveInitialPlayerPose({
    ...player,
    start_x_cm: 409600,
    start_y_cm: 3200,
    start_z_cm: 153600,
    start_yaw_q15: 0,
    resumed: false,
  }), {
    x: 4096,
    y: 32,
    z: 1536,
    yaw: 0,
    resumed: false,
  });

  const randomValues = [0.25, 0.75, 0.5];
  const mockRandom = () => randomValues.shift()!;
  assert.deepEqual(resolveInitialPlayerPose({
    ...player,
    start_x_cm: null,
    start_y_cm: null,
    start_z_cm: null,
    start_yaw_q15: null,
    resumed: false,
  }, mockRandom), {
    x: 4096,
    y: 32,
    z: 1536,
    yaw: 0,
    resumed: false,
  });

  assert.equal(
    initialTerrainStreamArea({
      ...player,
      start_x_cm: 409600,
      start_y_cm: 3200,
      start_z_cm: 153600,
      start_yaw_q15: 0,
      resumed: false,
    }).key,
    terrainStreamAreaForPosition(4096, 1536).key,
  );
});

test('Space wraps and saves a small authenticated position checkpoint with keepalive', async () => {
  const requests: { url: string; options: RequestInit }[] = [];
  const fetchImpl = async (url: string | URL | Request, options: RequestInit = {}) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ revision: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  const remote = createPlayerPositionRemote(
    'https://api.entropydrop.com',
    'test-token',
    '00000000-0000-0000-0000-000000000001',
    fetchImpl as typeof fetch
  );
  const position = encodePlayerPosition({ x: -0.01, y: 45.678, z: 2048.01 }, Math.PI / 2);
  await remote.save(position, true);

  assert.deepEqual(position, {
    x_cm: 1638399,
    y_cm: 4568,
    z_cm: 1,
    yaw_q15: 16384,
    pitch_q15: 0,
  });
  assert.equal(requests[0].options.method, 'PUT');
  assert.equal(requests[0].options.keepalive, true);
  assert.equal((requests[0].options.headers as any).Authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(String(requests[0].options.body)), position);
  assert.match(requests[0].url, /players\/me\/position$/);
});

test('Space admission exposes only FIFO position and cancellation uses the same authenticated endpoint', async () => {
  const requests: { url: string; options: RequestInit }[] = [];
  const fetchImpl = async (url: string | URL | Request, options: RequestInit = {}) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({
      state: options.method === 'DELETE' ? 'cancelled' : 'queued',
      position: 7,
      poll_after_ms: 2000
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const status = await requestSpaceAdmission(
    'https://api.entropydrop.com',
    'token-queue',
    'world-1',
    fetchImpl as typeof fetch
  );
  await cancelSpaceAdmission(
    'https://api.entropydrop.com',
    'token-queue',
    'world-1',
    fetchImpl as typeof fetch
  );

  assert.deepEqual(status, { state: 'queued', position: 7, poll_after_ms: 2000 });
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[1].options.method, 'DELETE');
  assert.equal((requests[0].options.headers as any).Authorization, 'Bearer token-queue');
  assert.equal(requests[0].url, 'https://api.entropydrop.com/space/api/v2/worlds/world-1/admission');
  assert.equal('estimated_wait_ms' in status, false);
});
