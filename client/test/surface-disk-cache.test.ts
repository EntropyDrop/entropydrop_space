import test from 'node:test';
import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  createSurfaceDiskCache, surfaceDiskBudget, encodeSurfaceCacheRecord, decodeSurfaceCacheRecord,
} from '../src/bootstrap/SurfaceDiskCache.ts';

test('disk cache has a large but quota-aware bound', () => {
  const MiB = 1024 * 1024;
  assert.equal(surfaceDiskBudget(), 512 * MiB);
  assert.equal(surfaceDiskBudget(50_000 * MiB), 2048 * MiB);
  assert.equal(surfaceDiskBudget(1000 * MiB), 200 * MiB);
  assert.equal(surfaceDiskBudget(0), 0);
  assert.equal(surfaceDiskBudget(-1), 0);
  assert.equal(surfaceDiskBudget(NaN), 512 * MiB);
});

test('unavailable browser storage is a non-blocking cache miss', async () => {
  const cache = createSurfaceDiskCache();
  assert.equal(await cache.get('a'.repeat(64)), undefined);
  await cache.put('a'.repeat(64), new Uint8Array([1, 2, 3]));
  await cache.remove('a'.repeat(64));
});

test('large terrain cache records shrink without changing authenticated bytes', async () => {
  const source = new Uint8Array(2 * 1024 * 1024);
  for (let i = 0; i < source.length; i += 8) source.set([128, 0, 120, 0, 113, 143, 97, 0], i);
  const digest = 'a'.repeat(64);
  const row = await encodeSurfaceCacheRecord(digest, source);
  assert.equal(row.codec, 'gzip');
  assert.equal(row.digest, digest);
  assert.equal(row.rawSize, source.length);
  assert.ok(row.bytes.length < source.length / 100);
  assert.deepEqual(await decodeSurfaceCacheRecord(row), source);
});

test('legacy, tiny and incompressible cache entries remain usable', async () => {
  const tiny = new Uint8Array([1, 2, 3]);
  const random = randomFillSync(new Uint8Array(8192));
  for (const source of [tiny, random]) {
    const row = await encodeSurfaceCacheRecord('b'.repeat(64), source);
    assert.equal(row.codec, undefined);
    assert.deepEqual(await decodeSurfaceCacheRecord(row), source);
  }
  assert.deepEqual(await decodeSurfaceCacheRecord({ digest: '', bytes: new Uint8Array(8192) }), new Uint8Array(8192));
});

test('missing native compression falls back to raw caching', async t => {
  const source = new Uint8Array(8192);
  t.mock.property(globalThis, 'CompressionStream', undefined);
  const row = await encodeSurfaceCacheRecord('', source);
  assert.equal(row.codec, undefined);
  assert.deepEqual(await decodeSurfaceCacheRecord(row), source);
});

test('corrupt compressed caches are misses and decompression respects the declared size', async () => {
  const source = new Uint8Array(8192), bytes = new Uint8Array(gzipSync(source));
  const row = { digest: '', bytes, codec: 'gzip' as const, rawSize: source.length };
  assert.equal(await decodeSurfaceCacheRecord({ ...row, bytes: bytes.slice(0, -1) }), undefined);
  assert.equal(await decodeSurfaceCacheRecord({ ...row, rawSize: 1 }), undefined);
  assert.equal(await decodeSurfaceCacheRecord({ ...row, rawSize: source.length + 1 }), undefined);
  assert.equal(await decodeSurfaceCacheRecord({ ...row, rawSize: 64 * 1024 * 1024 + 1 }), undefined);
  assert.equal(await decodeSurfaceCacheRecord({ ...row, rawSize: NaN }), undefined);
});

test('background cache writes are bounded, deduplicated and recover after failures', async () => {
  const { SurfaceCacheWrites } = await import('../src/bootstrap/SurfaceCacheWrites.ts');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const written: string[] = [];
  const queue = new SurfaceCacheWrites(async key => {
    written.push(key);
    if (key === 'a') { await held; throw new Error('disk failed'); }
  }, 8, 2);
  const first = queue.enqueue('a', new Uint8Array(4));
  assert.equal(queue.enqueue('a', new Uint8Array(4)), first);
  const second = queue.enqueue('b', new Uint8Array(4));
  await queue.enqueue('dropped', new Uint8Array(4));
  assert.equal(queue.pendingBytes, 8);
  assert.equal(queue.pendingEntries, 2);
  assert.deepEqual(written, ['a']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(written, ['a', 'b']);
  assert.equal(queue.pendingBytes, 0);
  await queue.enqueue('c', new Uint8Array(8));
  assert.deepEqual(written, ['a', 'b', 'c']);
});

test('v1 cache accounting migrates once and updates atomically across writers and eviction', async t => {
  const { IDBFactory, IDBObjectStore, IDBIndex } = await import('fake-indexeddb');
  const idb = new IDBFactory();
  const oldIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const oldStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');
  let quota = 10000;
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: idb });
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate: async () => ({ quota }) } });
  t.after(() => {
    if (oldIndexedDB) Object.defineProperty(globalThis, 'indexedDB', oldIndexedDB);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
    if (oldStorage) Object.defineProperty(navigator, 'storage', oldStorage);
    else Reflect.deleteProperty(navigator, 'storage');
  });
  const open = (version: number) => new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open('space-surface-cache-v1', version);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('snapshots', { keyPath: 'digest' });
      request.result.createObjectStore('metadata', { keyPath: 'digest' }).createIndex('accessed', 'accessed');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const legacy = await open(1);
  await new Promise<void>((resolve, reject) => {
    const tx = legacy.transaction(['snapshots', 'metadata'], 'readwrite');
    for (const [index, digest] of ['a', 'b'].entries()) {
      tx.objectStore('snapshots').put({ digest, bytes: new Uint8Array(100) });
      tx.objectStore('metadata').put({ digest, size: 100, accessed: index + 1 });
    }
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
  legacy.close();
  const scan = t.mock.method(IDBObjectStore.prototype, 'openCursor');
  const victims = t.mock.method(IDBIndex.prototype, 'openCursor');
  const cache = createSurfaceDiskCache(), otherTab = createSurfaceDiskCache();
  await cache.put('c', new Uint8Array(100));
  assert.equal(scan.mock.callCount(), 1, 'one scan initializes legacy metadata');
  await otherTab.put('c', new Uint8Array(150));
  await cache.remove('b');
  quota = 1500; // 300-byte cache budget
  await cache.put('d', new Uint8Array(100));
  assert.equal(scan.mock.callCount(), 1, 'ordinary writes and removal never rescan all metadata');
  assert.equal(victims.mock.callCount(), 1, 'only the overflowing write searches for LRU victims');
  assert.equal(await cache.get('a'), undefined);
  assert.equal((await cache.get('c'))?.length, 150);
  assert.equal((await cache.get('d'))?.length, 100);
  const db = await open(2);
  const total = await new Promise<number>(resolve => {
    const request = db.transaction('accounting').objectStore('accounting').get('bytes');
    request.onsuccess = () => resolve(request.result);
  });
  assert.equal(total, 250);
  db.close();
});
