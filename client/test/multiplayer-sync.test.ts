import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { decode, encode } from '@msgpack/msgpack';
import {
  MultiplayerSync,
  parseRealtimePlayers,
  resolveWebSocketUrl,
} from '../src/engine/network/MultiplayerSync.ts';
import { DEFAULT_PLAYER_SKIN_URL } from '../src/bootstrap/SpaceBootstrap.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { Chunk } from '@entropydrop/space-engine/voxel/Chunk.ts';

test('resolveWebSocketUrl follows the API origin for relative realtime URLs', () => {
  assert.equal(
    resolveWebSocketUrl('/space/ws/v2', 'https://entropydrop.com'),
    'wss://entropydrop.com/space/ws/v2'
  );
  assert.equal(
    resolveWebSocketUrl('/space/ws/v2', 'http://localhost:8000'),
    'ws://localhost:8000/space/ws/v2'
  );
  assert.throws(
    () => resolveWebSocketUrl('wss://attacker.example/collect', 'https://entropydrop.com'),
    /authenticated API host/
  );
  assert.throws(
    () => resolveWebSocketUrl('ws://entropydrop.com/space/ws/v2', 'https://entropydrop.com'),
    /require a WSS/
  );
});

test('realtime player parsing drops non-finite records and caps untrusted snapshots', () => {
  const valid = {
    user_id: 'user-1',
    username: 'A'.repeat(100),
    player_entity_id: 'entity-1',
    skin_url: '/skin/a.png',
    skin_type: 'slim',
    x_cm: 100,
    y_cm: 200,
    z_cm: 300,
    yaw_q15: 0,
    pitch_q15: 0,
    is_self: false,
  };
  const parsed = parseRealtimePlayers([
    { ...valid, x_cm: Number.NaN },
    ...Array.from({ length: 40 }, (_, index) => ({ ...valid, user_id: `user-${index + 1}` })),
  ], 'user-2');

  assert.equal(parsed.length, 31);
  assert.equal(parsed[0].username.length, 80);
  assert.equal(parsed[1].is_self, true);
  assert.deepEqual([parsed[0].x, parsed[0].y, parsed[0].z], [1, 2, 3]);

  const withoutSkin = parseRealtimePlayers([{ ...valid, skin_url: null }], 'someone-else');
  assert.equal(withoutSkin[0].skin_url, DEFAULT_PLAYER_SKIN_URL);
  assert.equal(withoutSkin[0].skin_type, 'strong');
});

test('MultiplayerSync sends poses over binary WebSocket and keeps HTTP for terrain', async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const fetchBodies: any[] = [];
  const sentMessages: any[] = [];
  let receivedPlayers: any[] = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: FakeWebSocket[] = [];
    readyState = FakeWebSocket.CONNECTING;
    bufferedAmount = 0;
    binaryType = '';
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    url: string;
    protocol: string;

    constructor(url: string, protocol: string) {
      this.url = url;
      this.protocol = protocol;
      FakeWebSocket.instances.push(this);
      setTimeout(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      }, 0);
    }

    send(data: Uint8Array) {
      const message = decode(data) as any;
      sentMessages.push(message);
      if (message.type === 'hello') {
        setTimeout(() => this.serverSend({ type: 'hello', snapshot_hz: 10, input_hz: 20 }), 0);
      }
    }

    serverSend(message: any) {
      const bytes = encode(message);
      const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      this.onmessage?.({ data });
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.();
    }
  }

  globalThis.WebSocket = FakeWebSocket as any;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/join-ticket')) {
      return new Response(JSON.stringify({
        ticket: 'one-use-ticket',
        websocket_url: '/space/ws/v2'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (init?.body) fetchBodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({
      players: [],
      terrain_chunks: [],
      max_terrain_revision: 0
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    const sync = new MultiplayerSync({
      apiOrigin: 'http://localhost:8000',
      token: 'jwt-test-token',
      worldId: 'world-123',
      currentUserId: 'user-alice',
      websocketUrl: '/space/ws/v2',
      poseIntervalMs: 20,
      terrainPollIntervalMs: 50,
      onPlayersUpdate: players => {
        receivedPlayers = players;
      }
    });
    sync.getPlayerPosition = () => ({ x: 12.34, y: 56.78, z: 90.12, yaw: 0.5, pitch: -0.25 });
    sync.start();
    await new Promise(resolve => setTimeout(resolve, 80));

    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    assert.equal(socket.url, 'ws://localhost:8000/space/ws/v2');
    assert.equal(socket.protocol, 'space-relay-v1');
    assert.equal(sentMessages[0].type, 'hello');
    const pose = sentMessages.find(message => message.type === 'pose');
    assert.equal(pose.x_cm, 1234);
    assert.equal(pose.y_cm, 5678);
    assert.equal(pose.z_cm, 9012);
    assert.equal(fetchBodies.at(-1).include_players, false);
    assert.equal('x_cm' in fetchBodies.at(-1), false);

    socket.serverSend({
      type: 'state',
      players: [{
        user_id: 'user-bob',
        username: 'Bob',
        player_entity_id: 'entity-bob',
        skin_url: '/skin/bob.png',
        skin_type: 'slim',
        x_cm: 1000,
        y_cm: 6400,
        z_cm: 2000,
        yaw_q15: 16384,
        pitch_q15: 0,
        is_self: false,
        updated_at: '2026-08-28T00:00:00+00:00'
      }]
    });
    assert.equal(receivedPlayers[0].x, 10);
    assert.equal(receivedPlayers[0].yaw, (16384 / 32767) * Math.PI);
    sync.stop();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test('MultiplayerSync polls heartbeat and dispatches player and terrain updates', async () => {
  let capturedUrl = '';
  let capturedBody: any = null;
  const mockPlayers = [
    {
      user_id: 'user_bob',
      username: 'Bob',
      player_entity_id: 'entity_bob',
      skin_url: '/skin/bob.png',
      skin_type: 'strong',
      x: 100,
      y: 64,
      z: 200,
      yaw: 1.5,
      is_self: false,
      updated_at: new Date().toISOString()
    }
  ];
  const mockChunks = [
    {
      chunk_x: 0,
      chunk_z: 0,
      revision: 5,
      standard: [[0, 64, 0, BlockTypes.COLOR_BLOCK, 0x123456]],
      micro: []
    }
  ];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    if (init?.body) {
      capturedBody = JSON.parse(String(init.body));
    }
    return new Response(JSON.stringify({
      world_id: 'world-123',
      players: mockPlayers,
      terrain_chunks: mockChunks,
      max_terrain_revision: 5
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    let receivedPlayers: any = null;
    let receivedChunks: any = null;

    const sync = new MultiplayerSync({
      apiOrigin: 'http://localhost:8000',
      token: 'jwt-test-token',
      worldId: 'world-123',
      currentUserId: 'user_alice',
      heartbeatIntervalMs: 50,
      onPlayersUpdate: (players) => {
        receivedPlayers = players;
      },
      onTerrainUpdate: (chunks) => {
        receivedChunks = chunks;
      }
    });

    sync.getPlayerPosition = () => ({
      x: 50,
      y: 64,
      z: 75,
      yaw: 0.5
    });

    sync.start();
    await new Promise(resolve => setTimeout(resolve, 80));
    sync.stop();

    assert.ok(capturedUrl.includes('/space/api/v2/worlds/world-123/heartbeat'));
    assert.equal(capturedBody.x_cm, 5000);
    assert.equal(capturedBody.y_cm, 6400);
    assert.equal(capturedBody.z_cm, 7500);
    assert.equal(capturedBody.yaw_q15, Math.round((0.5 / Math.PI) * 32767));
    assert.equal(capturedBody.center_chunk_x, 4);
    assert.equal(capturedBody.center_chunk_z, 4);
    assert.equal(capturedBody.terrain_radius_chunks, 32);
    assert.deepEqual(receivedPlayers, mockPlayers);
    assert.deepEqual(receivedChunks, mockChunks);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MultiplayerSync normalizes large accumulated yaw angles without clamping', async () => {
  let capturedBody: any = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) {
      capturedBody = JSON.parse(String(init.body));
    }
    return new Response(JSON.stringify({
      world_id: 'world-123',
      players: [],
      terrain_chunks: [],
      max_terrain_revision: 0
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    const sync = new MultiplayerSync({
      apiOrigin: 'http://localhost:8000',
      token: 'jwt-test-token',
      worldId: 'world-123',
      currentUserId: 'user_alice',
      heartbeatIntervalMs: 50
    });

    // 4 full turns + 0.5 rad (approx 25.63 rad)
    sync.getPlayerPosition = () => ({
      x: 10,
      y: 20,
      z: 30,
      yaw: Math.PI * 8 + 0.5
    });

    sync.start();
    await new Promise(resolve => setTimeout(resolve, 80));
    sync.stop();

    // Should normalize cleanly to 0.5 rad instead of clamping to 32767
    const expectedYawQ15 = Math.round((0.5 / Math.PI) * 32767);
    assert.equal(capturedBody.yaw_q15, expectedYawQ15);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('World.applyRemoteChunkUpdates updates loaded chunk blocks and microblocks in real time', () => {
  const scene = new THREE.Scene();
  const world = new World(scene, 12345);

  // Load chunk (0, 0)
  const chunk = world.getOrCreateChunk(0, 0);
  assert.ok(chunk);

  // Apply remote terrain update
  world.applyRemoteChunkUpdates([
    {
      chunk_x: 0,
      chunk_z: 0,
      revision: 1,
      standard: [
        [5, 40, 5, BlockTypes.COLOR_BLOCK, 0xff0000]
      ],
      micro: [
        [25, 200, 25, 0x00ff00, 'part_1']
      ]
    }
  ]);

  // Verify standard block edit is applied
  assert.equal(world.getBlock(5, 40, 5), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlockColor(5, 40, 5), 0xff0000);

  // Verify microblock edit is applied
  const microColor = world.microVoxels.get(25, 200, 25);
  assert.equal(microColor, 0x00ff00);
  assert.equal(world.microVoxels.parts.get('25,200,25'), 'part_1');
});

test('queued remote chunks are coalesced and applied during the bounded frame update', () => {
  const world = new World(new THREE.Scene(), 12345);
  world.getOrCreateChunk(0, 0);
  world.queueRemoteChunkUpdates([
    {
      chunk_x: 0,
      chunk_z: 0,
      revision: 1,
      standard: [[5, 40, 5, BlockTypes.COLOR_BLOCK, 0x111111]],
      micro: []
    },
    {
      chunk_x: 0,
      chunk_z: 0,
      revision: 2,
      standard: [[5, 40, 5, BlockTypes.COLOR_BLOCK, 0x222222]],
      micro: []
    }
  ]);

  assert.notEqual(world.getBlockColor(5, 40, 5), 0x222222);
  world.updateChunksAround(0, 0);
  assert.equal(world.getBlockColor(5, 40, 5), 0x222222);

  world.queueRemoteChunkUpdates([{
    chunk_x: 0,
    chunk_z: 0,
    revision: 1,
    standard: [[5, 40, 5, BlockTypes.COLOR_BLOCK, 0x333333]],
    micro: []
  }]);
  world.updateChunksAround(0, 0);
  assert.equal(world.getBlockColor(5, 40, 5), 0x222222, 'an older AOI page must not regress a newer heartbeat');
});

test('off-thread remote snapshots keep published terrain and collision until atomic replacement', () => {
  const world = new World(new THREE.Scene(), 12345) as any;
  world.setRenderDistance(3);
  world.updateChunksAround(0, 0);
  const chunk = world.getChunk(0, 0);
  assert.ok(chunk?.mesh);
  const previousMesh = chunk.mesh;
  world.pendingStreamChunks = [];
  world.dirtyChunks.clear();

  const requests: any[] = [];
  world.terrainWorker = {
    postMessage(request) {
      requests.push(request);
    },
  };
  const detailTransitions: boolean[] = [];
  const setDetailChunkReady = world.distantSurface.setDetailChunkReady.bind(world.distantSurface);
  world.distantSurface.setDetailChunkReady = (cx, cz, ready) => {
    if (cx === 0 && cz === 0) detailTransitions.push(ready);
    return setDetailChunkReady(cx, cz, ready);
  };

  world.queueRemoteChunkUpdates([{
    chunk_x: 0,
    chunk_z: 0,
    revision: 1,
    standard: [[5, 200, 5, BlockTypes.COLOR_BLOCK, 0xabcdef]],
    micro: [],
  }]);
  world.updateChunksAround(0, 0, true, 50, true);

  assert.equal(requests.length, 1);
  assert.equal(world.getChunk(0, 0), chunk, 'the live chunk must not be detached for regeneration');
  assert.equal(chunk.mesh, previousMesh, 'the previous detailed mesh remains published while work runs');
  assert.equal(world.getBlock(5, 200, 5), BlockTypes.AIR,
    'collision stays on the complete previous snapshot until publication');
  assert.deepEqual(detailTransitions, []);

  const generated = new Chunk(0, 0, world);
  world.terrainGen.generateChunk(generated);
  generated.setLocalBlock(5, 200, 5, BlockTypes.COLOR_BLOCK, 0xabcdef);
  const mesh = world.mesher.buildChunkMeshData(generated);
  const job = world.terrainWorkerJob;
  world.terrainWorkerJob = null;
  world.completedTerrainWorkerJobs.push({
    job,
    result: {
      ok: true,
      type: 'generate',
      requestId: job.requestId,
      cx: 0,
      cz: 0,
      hasUserEdits: true,
      blocks: generated.blocks,
      terrainColors: generated.colors,
      mesh,
    },
  });
  world.updateChunksAround(0, 0, true, 50, true);

  assert.equal(world.getChunk(0, 0), chunk, 'replacement should preserve the live chunk identity');
  assert.notEqual(chunk.mesh, previousMesh);
  assert.equal(previousMesh.parent, null);
  assert.equal(world.getBlock(5, 200, 5), BlockTypes.COLOR_BLOCK);
  assert.deepEqual(detailTransitions, [true], 'publication must not clear the detail ownership mask');
});

test('remote standard-to-micro replacement waits and publishes both layers together', () => {
  const world = new World(new THREE.Scene(), 12345) as any;
  world.setRenderDistance(3);
  world.updateChunksAround(0, 0);
  const chunk = world.getChunk(0, 0);
  world.setBlock(1, 200, 1, BlockTypes.COLOR_BLOCK, false, 0x48dbfb);
  world.publishChunkMesh(chunk, world.mesher.buildChunkMeshData(chunk));
  world.pendingStreamChunks = [];
  world.dirtyChunks.clear();
  const previousMesh = chunk.mesh;
  const requests: any[] = [];
  world.terrainWorker = { postMessage: request => requests.push(request) };
  const micro = Array.from({ length: 512 }, (_, index) => {
    const dx = index % 5;
    const dy = Math.floor(index / 5) % 5;
    const dz = Math.floor(index / 25);
    return [5 + dx, 1_000 + dy, 5 + dz, 0x48dbfb];
  });

  world.queueRemoteChunkUpdates([{
    chunk_x: 0,
    chunk_z: 0,
    revision: 1,
    standard: [],
    micro,
  }]);
  for (let frame = 0; frame < 10 && requests.length === 0; frame++) {
    world.updateChunksAround(0, 0, true, 50, true);
  }

  assert.equal(requests.length, 1);
  assert.equal(chunk.mesh, previousMesh, 'the old standard block remains visible during staging');
  assert.equal(world.microVoxels.meshChunks.size, 0,
    'the new coplanar micro geometry must not publish before standard removal');
  assert.equal(world.crossLayerPublicationChunks.has('0,0'), true);

  const generated = new Chunk(0, 0, world);
  world.terrainGen.generateChunk(generated);
  const mesh = world.mesher.buildChunkMeshData(generated);
  const job = world.terrainWorkerJob;
  world.terrainWorkerJob = null;
  world.completedTerrainWorkerJobs.push({
    job,
    result: {
      ok: true,
      type: 'generate',
      requestId: job.requestId,
      cx: 0,
      cz: 0,
      hasUserEdits: false,
      blocks: generated.blocks,
      terrainColors: generated.colors,
      mesh,
    },
  });
  for (let frame = 0; frame < 40 && world.crossLayerPublicationChunks.has('0,0'); frame++) {
    world.updateChunksAround(0, 0, true, 50, true);
  }

  assert.notEqual(chunk.mesh, previousMesh);
  assert.ok(world.microVoxels.mesh);
  assert.equal(world.crossLayerPublicationChunks.has('0,0'), false);
});

test('an evicted remote replacement keeps its atomic barrier through the missing-chunk retry', () => {
  const world = new World(new THREE.Scene(), 12345) as any;
  world.setRenderDistance(3);
  world.updateChunksAround(0, 0);
  const replacedChunk = world.getChunk(0, 0);
  assert.ok(replacedChunk?.mesh);
  world.pendingStreamChunks = [];
  world.dirtyChunks.clear();
  const requests: any[] = [];
  world.terrainWorker = { postMessage: request => requests.push(request) };

  world.queueRemoteChunkUpdates([{
    chunk_x: 0,
    chunk_z: 0,
    revision: 1,
    standard: [],
    micro: [[5, 1_000, 5, 0x48dbfb]],
  }]);
  for (let frame = 0; frame < 10 && requests.length === 0; frame++) {
    world.updateChunksAround(0, 0, true, 50, true);
  }
  const replacingJob = world.terrainWorkerJob;
  assert.equal(replacingJob.replacingChunk, replacedChunk);
  assert.equal(world.crossLayerPublicationChunks.has('0,0'), true);

  world.updateChunksAround(10 * 16, 0, true, 50, true);
  world.updateChunksAround(10 * 16, 0, true, 50, true);
  assert.equal(world.getChunk(0, 0), null, 'the unedited procedural chunk should be evicted');
  assert.equal(world.suspendedCrossLayerPublicationChunks.has('0,0'), true);

  world.updateChunksAround(0, 0, false);
  assert.equal(world.crossLayerPublicationChunks.has('0,0'), true);
  const firstGenerated = new Chunk(0, 0, world);
  world.terrainGen.generateChunk(firstGenerated);
  world.terrainWorkerJob = null;
  world.completedTerrainWorkerJobs.push({
    job: replacingJob,
    result: {
      ok: true,
      type: 'generate',
      requestId: replacingJob.requestId,
      cx: 0,
      cz: 0,
      blocks: firstGenerated.blocks,
      terrainColors: firstGenerated.colors,
      mesh: world.mesher.buildChunkMeshData(firstGenerated),
    },
  });
  world.updateChunksAround(0, 0, true, 50, true);
  world.updateChunksAround(0, 0, true, 50, true);

  assert.equal(requests.length, 2, 'the stale replacing job should retry as a missing-chunk snapshot');
  assert.equal(world.terrainWorkerJob.replacingChunk, null);
  assert.equal(world.crossLayerPublicationChunks.has('0,0'), true,
    'discarding the stale replacing job must not discard its publication intent');
  assert.equal(world.microVoxels.meshChunks.size, 0,
    'the micro replacement must remain staged until retry publication');

  const retryJob = world.terrainWorkerJob;
  const retryGenerated = new Chunk(0, 0, world);
  world.terrainGen.generateChunk(retryGenerated);
  world.terrainWorkerJob = null;
  world.completedTerrainWorkerJobs.push({
    job: retryJob,
    result: {
      ok: true,
      type: 'generate',
      requestId: retryJob.requestId,
      cx: 0,
      cz: 0,
      blocks: retryGenerated.blocks,
      terrainColors: retryGenerated.colors,
      mesh: world.mesher.buildChunkMeshData(retryGenerated),
    },
  });
  for (let frame = 0; frame < 20 && world.crossLayerPublicationChunks.has('0,0'); frame++) {
    world.updateChunksAround(0, 0, true, 50, true);
  }

  assert.ok(world.getChunk(0, 0)?.mesh);
  assert.ok(world.microVoxels.mesh);
  assert.equal(world.crossLayerPublicationChunks.has('0,0'), false);
});

test('a local edit racing a completed remote snapshot is included in its retry', () => {
  const world = new World(new THREE.Scene(), 12345) as any;
  world.setRenderDistance(3);
  world.updateChunksAround(0, 0);
  const chunk = world.getChunk(0, 0);
  world.pendingStreamChunks = [];
  world.dirtyChunks.clear();
  const requests: any[] = [];
  world.terrainWorker = { postMessage: request => requests.push(request) };

  world.queueRemoteChunkUpdates([{
    chunk_x: 0,
    chunk_z: 0,
    revision: 1,
    standard: [[5, 200, 5, BlockTypes.COLOR_BLOCK, 0xabcdef]],
    micro: [],
  }]);
  world.updateChunksAround(0, 0, true, 50, true);
  const firstJob = world.terrainWorkerJob;
  const generated = new Chunk(0, 0, world);
  world.terrainGen.generateChunk(generated);
  generated.setLocalBlock(5, 200, 5, BlockTypes.COLOR_BLOCK, 0xabcdef);
  const mesh = world.mesher.buildChunkMeshData(generated);
  world.terrainWorkerJob = null;
  world.completedTerrainWorkerJobs.push({
    job: firstJob,
    result: {
      ok: true,
      type: 'generate',
      requestId: firstJob.requestId,
      cx: 0,
      cz: 0,
      hasUserEdits: true,
      blocks: generated.blocks,
      terrainColors: generated.colors,
      mesh,
    },
  });

  world.setBlock(6, 200, 5, BlockTypes.COLOR_BLOCK, true, 0x123456);
  world.updateChunksAround(0, 0, true, 50, true);

  assert.equal(world.getChunk(0, 0), chunk);
  assert.equal(world.getBlock(6, 200, 5), BlockTypes.COLOR_BLOCK);
  assert.equal(requests.length, 2, 'the stale completed snapshot should be regenerated');
  assert.deepEqual(
    requests[1].standardEdits.at(-1),
    [6, 200, 5, BlockTypes.COLOR_BLOCK, 0x123456],
    'the retry must carry the edit made after worker completion',
  );
});

test('a local micro edit made during remote replacement survives incremental clearing', () => {
  const world = new World(new THREE.Scene(), 12345) as any;
  world.setRenderDistance(3);
  world.updateChunksAround(0, 0);
  world.pendingStreamChunks = [];
  world.dirtyChunks.clear();
  world.terrainWorker = { postMessage() {} };

  for (let index = 0; index < 500; index++) {
    world.setMicroBlock(index % 80, 1_000, Math.floor(index / 80), 0x111111);
  }
  const targetMx = 499 % 80;
  const targetMz = Math.floor(499 / 80);
  world.queueRemoteChunkUpdates([{
    chunk_x: 0,
    chunk_z: 0,
    revision: 1,
    standard: [],
    micro: [],
  }]);
  world.updateChunksAround(0, 0, true, 50, true);
  assert.ok(world.pendingRemoteChunkApply, 'the 500-cell clear should span multiple bounded slices');

  world.setMicroBlock(targetMx, 1_000, targetMz, 0xabcdef);
  for (let frame = 0; frame < 20 && world.pendingRemoteChunkApply; frame++) {
    world.updateChunksAround(0, 0, true, 50, true);
  }

  assert.equal(world.pendingRemoteChunkApply, null);
  assert.equal(world.getMicroBlock(targetMx, 1_000, targetMz)?.color, 0xabcdef,
    'the local override must be replayed after the old detached index finishes clearing');
});

test('deleting a published micro cell during remote replacement cannot be lost', () => {
  const world = new World(new THREE.Scene(), 12345) as any;
  world.setRenderDistance(3);
  world.updateChunksAround(0, 0);
  world.pendingStreamChunks = [];
  world.dirtyChunks.clear();
  world.terrainWorker = { postMessage() {} };

  const target = { mx: 1, my: 1_600, mz: 1 };
  const shovelTarget = { mx: 9, my: 1_600, mz: 1 };
  world.setMicroBlock(target.mx, target.my, target.mz, 0x112233);
  world.setMicroBlock(shovelTarget.mx, shovelTarget.my, shovelTarget.mz, 0x334455);
  for (let index = 0; index < 500; index++) {
    world.setMicroBlock(2 + index % 78, target.my, 2 + Math.floor(index / 78), 0x445566);
  }
  world.microVoxels.updateMesh();
  world.queueRemoteChunkUpdates([{
    chunk_x: 0,
    chunk_z: 0,
    revision: 1,
    standard: [],
    micro: [
      [target.mx, target.my, target.mz, 0xabcdef],
      [shovelTarget.mx, shovelTarget.my, shovelTarget.mz, 0xfedcba],
    ],
  }]);

  world.updateChunksAround(0, 0, true, 50, true);
  assert.ok(world.pendingRemoteChunkApply, 'the old live data should clear incrementally');
  assert.equal(world.getMicroBlock(target.mx, target.my, target.mz), null,
    'the staging view has already cleared the old target');
  assert.equal(
    world.microVoxels.getPublishedCollisionColor(target.mx, target.my, target.mz),
    0x112233,
    'the old target remains visible until the replacement publishes',
  );
  assert.equal(world.removeMicroBlock(target.mx, target.my, target.mz), true,
    'clicking the visible old target should record a delete intent');
  assert.equal(world.removeMicroBlock(target.mx, target.my, target.mz), false,
    'the same published target must not report a second successful local delete');
  world.microVoxels.set(target.mx, target.my, target.mz, 0xabcdef);
  assert.equal(world.removeMicroBlock(target.mx, target.my, target.mz), false,
    'reappearing remote staging data must not consume another click for the queued delete');
  assert.equal(world.pendingRemoteChunkApply.localMicroOverrides.length, 1,
    'the already queued delete intent should not be duplicated');
  assert.ok(world.clearMicroStandardCell(1, 200, 0) >= 1,
    'a shovel clear should also accept visible published micro cells');

  for (let frame = 0; frame < 20 && world.pendingRemoteChunkApply; frame++) {
    world.updateChunksAround(0, 0, true, 50, true);
  }
  assert.equal(world.pendingRemoteChunkApply, null);
  assert.equal(world.getMicroBlock(target.mx, target.my, target.mz), null,
    'the delete override must replay after the incoming snapshot adds the cell');
  assert.equal(world.getMicroBlock(shovelTarget.mx, shovelTarget.my, shovelTarget.mz), null,
    'the clear-cell override must replay after the incoming snapshot adds the cell');
});

test('large queued micro snapshots are installed over multiple frame budgets', () => {
  const world = new World(new THREE.Scene(), 12345) as any;
  const micro = Array.from({ length: 5_000 }, (_, index) => [
    index % 80,
    Math.floor(index / 80),
    0,
    0x48dbfb,
  ]);
  world.queueRemoteChunkUpdates([{
    chunk_x: 0,
    chunk_z: 0,
    revision: 1,
    standard: [],
    micro,
  }]);

  world.updateChunksAround(0, 0);
  assert.ok(world.microVoxels.cells.size > 0 && world.microVoxels.cells.size < micro.length);
  assert.equal(world.microMeshBuildBlockedChunks.has('0,0'), true,
    'partial snapshots must not repeatedly rebuild incomplete micro meshes');

  for (let frame = 0; frame < 10 && world.microVoxels.cells.size < micro.length; frame++) {
    world.updateChunksAround(0, 0);
  }
  assert.equal(world.microVoxels.cells.size, micro.length);
  assert.equal(world.microMeshBuildBlockedChunks.size, 0);
});

test('remote chunk snapshots are cached without echoing them back as local mutations', async () => {
  const scene = new THREE.Scene();
  const sent: any[] = [];
  const world = new World(scene, 12345, {
    worldId: 'shared-world',
    storage: null,
    saveDelayMs: 0,
    remote: {
      chunks: [],
      async sendBatch(batchId, mutations) {
        sent.push({ batchId, mutations });
      }
    }
  });
  world.getOrCreateChunk(0, 0);

  world.applyRemoteChunkUpdates([{
    chunk_x: 0,
    chunk_z: 0,
    revision: 1,
    standard: [[5, 40, 5, BlockTypes.COLOR_BLOCK, 0x123456]],
    micro: [[30, 200, 25, 0x00ff00, 'remote']]
  }]);
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(sent.length, 0);
  assert.equal(world.getBlockColor(5, 40, 5), 0x123456);
  assert.equal(world.microVoxels.parts.get('30,200,25'), 'remote');
});
