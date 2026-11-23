import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import type { TerrainEditChunk, WorldEditRemote } from '@entropydrop/space-engine/voxel/WorldEditPersistence.ts';
import {
  TERRAIN_STREAM_SWITCH_DEBOUNCE_MS,
  loadTerrainEditRemote,
  terrainStreamAreaForPosition,
} from '../src/bootstrap/SpaceBootstrap.ts';
import { MultiplayerSync } from '../src/engine/network/MultiplayerSync.ts';
import { TerrainAreaSync } from '../src/engine/network/TerrainAreaSync.ts';

const apiOrigin = 'https://example.test';
const initialArea = terrainStreamAreaForPosition(127, 64);
const chunk = (x: number, revision: number) => ({
  chunk_x: x, chunk_z: 4, revision, standard: [], micro: [],
});
const heartbeatResponse = (revision: number, chunks: TerrainEditChunk[] = [], cursor: string | null = null) =>
  Response.json({ max_terrain_revision: revision, terrain_chunks: chunks, terrain_cursor: cursor });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test('AOI heartbeat follows the loaded window and catches edits made during a snapshot load', async t => {
  let now = 0;
  let x = 127;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const snapshotTail = deferred<Response>();
  const oldHeartbeat = deferred<Response>();
  const requests: Array<{ body: Record<string, number | string>; signal: AbortSignal }> = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    requests.push({ body: JSON.parse(String(options.body)), signal: options.signal! });
    if (requests.length === 1) return heartbeatResponse(11, [chunk(1019, 1)]);
    if (requests.length === 2) return heartbeatResponse(13, [], '14:4:4');
    if (requests.length === 3) return oldHeartbeat.promise;
    if (requests.length === 4) return heartbeatResponse(12, [chunk(27, 2)]);
    return heartbeatResponse(12);
  });

  const snapshotRequests: string[] = [];
  const remote = await loadTerrainEditRemote(apiOrigin, 'token', 'world', async (input, options) => {
    const url = new URL(String(input));
    snapshotRequests.push(url.search);
    if (url.searchParams.get('center_chunk_x') === '4') return Response.json({ chunks: [] });
    assert.ok(options?.signal);
    if (url.searchParams.has('cursor')) return snapshotTail.promise;
    return Response.json({ chunks: [chunk(27, 1)], next_cursor: '27,4' });
  }, undefined, initialArea);

  const installed: string[] = [];
  const updates: Array<[number, number]> = [];
  const world = {
    setTerrainDataWindow: (area: typeof initialArea) => installed.push(area.key),
    queueRemoteChunkUpdates: (chunks: TerrainEditChunk[]) => {
      updates.push(...chunks.map(c => [c.chunk_x, c.revision] as [number, number]));
    },
  };
  const realtime = new MultiplayerSync({
    apiOrigin, token: 'token', worldId: 'world', currentUserId: 'player',
    onTerrainUpdate: world.queueRemoteChunkUpdates,
  });
  realtime.getPlayerPosition = () => ({ x, y: 64, z: 64, yaw: 0 });
  realtime.setTerrainArea(initialArea, 10);
  const areaSync = new TerrainAreaSync({ initialArea, loadArea: remote.loadArea!, world, realtime });
  realtime.start();
  t.after(() => realtime.stop());

  x = 129;
  areaSync.update(x, 64);
  now += TERRAIN_STREAM_SWITCH_DEBOUNCE_MS;
  areaSync.update(x, 64);
  t.mock.timers.tick(50);
  await nextTurn();
  assert.equal(snapshotRequests.length, 1);
  assert.equal(requests[0].body.center_chunk_x, 4);
  assert.equal(requests[0].body.x_cm, 12900);
  assert.deepEqual(updates, [[1019, 1]]);

  x = 192;
  areaSync.update(x, 64);
  now += TERRAIN_STREAM_SWITCH_DEBOUNCE_MS;
  areaSync.update(x, 64);
  await nextTurn();
  assert.equal(snapshotRequests.length, 3);
  assert.deepEqual(installed, []);

  t.mock.timers.tick(1_000);
  await nextTurn();
  assert.equal(requests[1].body.center_chunk_x, 4);
  t.mock.timers.tick(1_000);
  await nextTurn();
  assert.equal(requests[2].body.terrain_cursor, '14:4:4');

  snapshotTail.resolve(Response.json({ chunks: [] }));
  await nextTurn();
  assert.deepEqual(installed, [terrainStreamAreaForPosition(x, 64).key]);
  assert.equal(requests[2].signal.aborted, true);
  t.mock.timers.tick(1);
  await nextTurn();
  assert.equal(requests[3].body.center_chunk_x, 12);
  assert.equal(requests[3].body.since_terrain_revision, 11);
  assert.equal(requests[3].body.terrain_cursor, undefined);
  assert.deepEqual(updates, [[1019, 1], [27, 1], [27, 2]]);

  oldHeartbeat.resolve(heartbeatResponse(100, [chunk(1019, 2)], '101:4:4'));
  await nextTurn();
  t.mock.timers.tick(1_000);
  await nextTurn();
  assert.equal(requests[4].body.since_terrain_revision, 12);
  assert.equal(requests[4].body.terrain_cursor, undefined);
  assert.deepEqual(updates, [[1019, 1], [27, 1], [27, 2]]);
});

test('superseded snapshots cannot publish and a failed current snapshot retries automatically', async t => {
  let now = 0;
  let baseline = 10;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(console, 'warn', () => {});
  const loads: Array<{
    x: number;
    signal: AbortSignal;
    onPage: (chunks: TerrainEditChunk[]) => void;
    result: ReturnType<typeof deferred<TerrainEditChunk[]>>;
  }> = [];
  const loadArea: NonNullable<WorldEditRemote['loadArea']> = (x, _z, _r, onPage, _rz, signal) => {
    const result = deferred<TerrainEditChunk[]>();
    loads.push({ x, signal: signal!, onPage: onPage!, result });
    return result.promise;
  };
  const installed: string[] = [];
  const applied: TerrainEditChunk[] = [];
  const switches: Array<[string, number]> = [];
  const areaSync = new TerrainAreaSync({
    initialArea,
    loadArea,
    world: {
      setTerrainDataWindow: area => installed.push(`${area!.centerChunkX},${area!.centerChunkZ}`),
      queueRemoteChunkUpdates: chunks => applied.push(...chunks),
    },
    realtime: {
      getTerrainSnapshotBaseline: () => baseline,
      setTerrainArea: (area, revision) => switches.push([area.key, revision]),
    },
  });
  const move = (x: number) => {
    areaSync.update(x, 64);
    now += TERRAIN_STREAM_SWITCH_DEBOUNCE_MS;
    areaSync.update(x, 64);
  };

  move(192);
  assert.deepEqual(loads.map(load => load.x), [12]);
  const x = 320;
  move(x);
  assert.deepEqual(loads.map(load => load.x), [12, 20]);
  assert.equal(loads[0].signal.aborted, true);
  loads[0].onPage([chunk(12, 1)]);
  loads[0].result.resolve([]);
  await nextTurn();
  areaSync.update(x, 64);
  assert.equal(loads.length, 2);
  assert.deepEqual(applied, []);
  assert.deepEqual(installed, []);

  loads[1].result.reject(new Error('One snapshot page failed'));
  await nextTurn();
  now += 1_999;
  areaSync.update(x, 64);
  assert.equal(loads.length, 2);
  baseline = 14;
  now++;
  areaSync.update(x, 64);
  assert.deepEqual(loads.map(load => load.x), [12, 20, 20]);
  loads[2].onPage([chunk(20, 1)]);
  baseline = 15;
  loads[2].result.resolve([]);
  await nextTurn();
  assert.deepEqual(applied, [chunk(20, 1)]);
  assert.deepEqual(installed, ['20,4']);
  assert.deepEqual(switches, [[terrainStreamAreaForPosition(x, 64).key, 14]]);
});

test('heartbeat retries a failed page and restarts an invalid cursor at the last complete event', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'warn', () => {});
  const requests: Array<{ since_terrain_revision: number; terrain_cursor?: string }> = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    requests.push(JSON.parse(String(options.body)));
    if (requests.length === 1) return heartbeatResponse(11, [chunk(3, 1)], '12:3:4');
    if (requests.length === 2) return new Response(null, { status: 503 });
    if (requests.length === 3) return new Response(null, { status: 422 });
    if (requests.length === 4) return heartbeatResponse(12, [chunk(4, 1)]);
    return heartbeatResponse(12);
  });
  const delivered: number[] = [];
  const realtime = new MultiplayerSync({
    apiOrigin, token: 'token', worldId: 'world', currentUserId: 'player',
    onTerrainUpdate: chunks => delivered.push(...chunks.map(c => c.chunk_x)),
  });
  realtime.setTerrainArea(initialArea, 10);
  realtime.start();
  t.after(() => realtime.stop());
  for (const delay of [50, 1000, 1000, 1000, 1000]) {
    t.mock.timers.tick(delay);
    await nextTurn();
  }
  assert.deepEqual(requests.map(body => [body.since_terrain_revision, body.terrain_cursor]), [
    [10, undefined],
    [11, '12:3:4'],
    [11, '12:3:4'],
    [11, undefined],
    [12, undefined],
  ]);
  assert.deepEqual(delivered, [3, 4]);
});
