import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as yieldTask } from 'node:timers/promises';
import { createSpaceSurfaceSnapshotRemote, type SurfaceZoneSnapshot } from '../src/bootstrap/SpaceSurfaceSnapshot.ts';
import type { SurfaceByteCache } from '../src/bootstrap/SurfaceDiskCache.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function fixture() {
  const saved = new Map<string, Uint8Array>(), manifests = new Map<string, string>();
  const payloads = new Map<string, Uint8Array>(), requests: string[] = [];
  const cache: SurfaceByteCache = {
    async get(key) { return saved.get(key)?.slice(); },
    async put(key, bytes) { saved.set(key, bytes.slice()); },
    async remove(key) { saved.delete(key); },
    async getManifest(key) { return manifests.get(key); },
    async putManifest(key, value) { manifests.set(key, value); },
  };
  const zone = (x: number, revision: number) => {
    const level = (size: number) => {
      const count = (512 / size) ** 2, bytes = new Uint8Array(32 + count * 5);
      bytes.set([0x45, 0x44, 0x53, 0x5a, 4, size, 32, 5]);
      const view = new DataView(bytes.buffer);
      view.setUint16(8, x, true);
      view.setInt32(12, 20260827, true);
      view.setUint32(16, 1, true);
      view.setBigUint64(20, BigInt(revision), true);
      view.setUint32(28, count, true);
      for (let offset = 32; offset < bytes.length; offset += 5) {
        view.setUint16(offset, 136, true);
        bytes.set([113, 143, 97], offset + 2);
      }
      const url = `/zones/${x}/${revision}/${size}`;
      payloads.set(url, bytes);
      return { sample_size: size, url, byte_length: bytes.length,
        digest: createHash('sha256').update(bytes).digest('hex') };
    };
    return { zone_x: x, zone_z: 0, revision, source_terrain_revision: revision,
      ...level(2), lods: [level(16), level(64)] };
  };
  const manifest = (revisions = [7, 7]) => ({ schema_version: 5, samples_per_chunk_axis: 8,
    zone_size_chunks: 32, width_chunks: revisions.length * 32, length_chunks: 32, complete: true,
    zones: revisions.map((revision, x) => zone(x, revision)) });
  let respond = async () => Response.json(manifest());
  let downloadsFail = false;
  const create = (url = '/manifest', seed = 20260827, version = 1, origin = 'https://api.entropydrop.com') =>
    createSpaceSurfaceSnapshotRemote(origin, 'token', url, seed, version, (async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer token');
      if (!path.startsWith('/zones/')) {
        assert.equal(init?.cache, 'no-store');
        return respond();
      }
      if (downloadsFail) throw new Error('download offline');
      return new Response(payloads.get(path)!.slice().buffer);
    }) as typeof fetch, cache);
  const options = { getZoneDemand: (x: number) => ({ sampleSize: 16, priority: x }) };
  return { saved, manifests, cache, requests, manifest, create, options,
    setResponse(next: () => Promise<Response>) { respond = next; },
    failDownloads() { downloadsFail = true; },
    async warm() {
      await create().loadAll(() => {}, undefined, options);
      await yieldTask();
      requests.length = 0;
    } };
}

test('cached LOD enters before a held version check, then replaces only changed zones', { timeout: 5000 }, async () => {
  const f = fixture();
  await f.warm();
  const response = deferred<Response>();
  f.setResponse(() => response.promise);
  const remote = f.create(), seen: string[] = [];
  let firstPassDone = false;
  const first = remote.loadAll(zone => {
    assert.equal(firstPassDone, false, 'entry callbacks must not be used by later background work');
    seen.push(`${zone.zoneX}:${zone.sourceTerrainRevision}:${zone.sampleSize}`);
  }, undefined, { getZoneDemand: x => ({ sampleSize: 2, priority: x }) });
  assert.equal(remote.loadAll(() => assert.fail('concurrent loads must coalesce')), first);
  const result = await first;
  firstPassDone = true;
  assert.equal(result.complete, true);
  assert.equal(result.revalidating, true);
  assert.deepEqual(seen.sort(), ['0:7:16', '0:7:64', '1:7:16', '1:7:64']);
  assert.deepEqual(f.requests, ['/manifest'], 'missing fine cache must not download stale URLs');
  response.resolve(Response.json(f.manifest([8, 7])));
  await yieldTask();
  const updates: string[] = [];
  await remote.loadAll(zone => updates.push(`${zone.zoneX}:${zone.sourceTerrainRevision}:${zone.sampleSize}`),
    undefined, f.options);
  assert.deepEqual(updates, ['0:8:16'], 'replacement retains detail and leaves unchanged zones installed');
  assert.deepEqual(f.requests, ['/manifest', '/zones/0/8/16']);
  await remote.loadAll(() => assert.fail('settled LOD must not reinstall'), undefined, f.options);
  assert.equal(f.requests.length, 2);
});

test('unchanged background versions reuse all cached data without downloads or rebuilding', { timeout: 5000 }, async () => {
  const f = fixture();
  await f.warm();
  const remote = f.create();
  assert.equal((await remote.loadAll(() => {}, undefined, f.options)).revalidating, true);
  await yieldTask();
  const result = await remote.loadAll(() => assert.fail('unchanged cache must stay installed'), undefined, f.options);
  assert.deepEqual(result, { loaded: 0, complete: true });
  assert.deepEqual(f.requests, ['/manifest']);
});

test('partial or corrupt caches display available zones and fill holes only from fresh versions', { timeout: 5000 }, async () => {
  const f = fixture();
  await f.warm();
  const old = f.manifest();
  f.saved.delete(old.zones[1].lods[0].digest);
  f.saved.set(old.zones[1].lods[1].digest, new Uint8Array([0]));
  const response = deferred<Response>(), cachedZone = deferred<void>();
  f.setResponse(() => response.promise);
  const remote = f.create(), seen: SurfaceZoneSnapshot[] = [];
  let done = false;
  const loading = remote.loadAll(zone => {
    seen.push(zone);
    if (zone.zoneX === 0 && zone.sampleSize === 16) cachedZone.resolve();
  }, undefined, f.options).then(result => { done = true; return result; });
  await cachedZone.promise;
  await yieldTask();
  assert.equal(done, false, 'a cached manifest alone does not prove complete terrain coverage');
  assert.deepEqual(f.requests, ['/manifest']);
  assert.ok(seen.every(zone => zone.zoneX === 0));
  response.resolve(Response.json(f.manifest([7, 8])));
  assert.equal((await loading).complete, true);
  assert.deepEqual(f.requests, ['/manifest', '/zones/1/8/64', '/zones/1/8/16']);
  assert.ok(seen.filter(zone => zone.zoneX === 1).every(zone => zone.sourceTerrainRevision === 8));
  assert.equal(f.saved.has(old.zones[1].lods[1].digest), false, 'corrupt bytes are removed');
});

test('a cached detail mip can restore coverage even when its overview was evicted', { timeout: 5000 }, async () => {
  const f = fixture();
  await f.warm();
  for (const zone of f.manifest().zones) f.saved.delete(zone.lods[1].digest);
  const response = deferred<Response>();
  f.setResponse(() => response.promise);
  const remote = f.create(), sizes: number[] = [];
  const result = await remote.loadAll(zone => sizes.push(zone.sampleSize!), undefined, f.options);
  assert.equal(result.complete, true);
  assert.deepEqual(sizes, [16, 16]);
  assert.deepEqual(f.requests, ['/manifest']);
  response.resolve(Response.json(f.manifest()));
});

test('failed revalidation retains cached geometry and a later poll recovers', { timeout: 5000 }, async () => {
  const f = fixture();
  await f.warm();
  const response = deferred<Response>();
  f.setResponse(() => response.promise);
  const remote = f.create();
  assert.equal((await remote.loadAll(() => {}, undefined, f.options)).complete, true);
  response.resolve(new Response('', { status: 503 }));
  await yieldTask();
  const unchanged = () => assert.fail('a failed check must not replace or remove cached terrain');
  await assert.rejects(remote.loadAll(unchanged, unchanged, f.options), /HTTP 503/);
  f.setResponse(async () => Response.json(f.manifest()));
  await remote.loadAll(unchanged, unchanged, f.options);
  await yieldTask();
  await remote.loadAll(unchanged, unchanged, f.options);
  assert.deepEqual(f.requests, ['/manifest', '/manifest']);
});

test('manifest cache is isolated by world, API origin, seed and generator version', { timeout: 5000 }, async () => {
  const f = fixture();
  await f.warm();
  const remotes = [f.create('/another-world'), f.create('/manifest', 99), f.create('/manifest', 20260827, 2),
    f.create('/manifest', 20260827, 1, 'https://other.entropydrop.com')];
  for (const remote of remotes) {
    const response = deferred<Response>();
    f.setResponse(() => response.promise);
    const loading = remote.loadAll(() => assert.fail('unrelated world cache must never render'), undefined, f.options);
    const rejected = assert.rejects(loading, /HTTP 403/);
    await yieldTask();
    response.resolve(new Response('', { status: 403 }));
    await rejected;
  }
});

test('invalid or unavailable manifest storage falls back to authenticated network loading', async () => {
  const f = fixture();
  await f.warm();
  for (const value of ['{broken', '{}']) {
    for (const key of f.manifests.keys()) f.manifests.set(key, value);
    assert.equal((await f.create().loadAll(() => {}, undefined, f.options)).complete, true);
  }
  f.cache.getManifest = async () => { throw new Error('storage disabled'); };
  f.cache.putManifest = async () => { throw new Error('quota'); };
  assert.equal((await f.create().loadAll(() => {}, undefined, f.options)).complete, true);
});

test('failed replacements preserve the previous disk manifest for the next entry', { timeout: 5000 }, async () => {
  const f = fixture();
  await f.warm();
  const savedManifests = [...f.manifests];
  f.setResponse(async () => Response.json(f.manifest([8, 7])));
  f.failDownloads();
  const remote = f.create();
  assert.equal((await remote.loadAll(() => {}, undefined, f.options)).revalidating, true);
  await yieldTask();
  await assert.rejects(remote.loadAll(() => assert.fail('failed replacement must not publish'), undefined, f.options),
    /download offline/);
  assert.deepEqual([...f.manifests], savedManifests);
  const response = deferred<Response>();
  f.setResponse(() => response.promise);
  const seen: number[] = [];
  assert.equal((await f.create().loadAll(zone => seen.push(zone.sourceTerrainRevision), undefined, f.options)).complete, true);
  assert.ok(seen.every(revision => revision === 7));
  response.resolve(new Response('', { status: 503 }));
});
