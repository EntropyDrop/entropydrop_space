import { SurfaceCacheWrites } from './SurfaceCacheWrites.ts';

/** Optional, content-addressed cache. Authentication always happens at the
 * manifest; cached bytes are revalidated against its digest before use. */
export interface SurfaceByteCache {
  get(digest: string): Promise<Uint8Array | undefined>;
  put(digest: string, bytes: Uint8Array): Promise<void>;
  remove(digest: string): Promise<void>;
}

const STORE = 'snapshots';
const META = 'metadata';
const ACCOUNTING = 'accounting';
const TOTAL = 'bytes';
const MiB = 1024 * 1024;
// Match the snapshot decoder's per-zone limit, including after decompression.
const MAX_ENTRY_BYTES = 64 * MiB;

export interface SurfaceCacheRecord {
  digest: string;
  bytes: Uint8Array;
  codec?: 'gzip';
  encodingVersion?: 1;
  rawSize?: number;
}

/** Native streams compress asynchronously without running a JS deflater in a frame. */
export async function encodeSurfaceCacheRecord(digest: string, bytes: Uint8Array): Promise<SurfaceCacheRecord> {
  const raw: SurfaceCacheRecord = { digest, bytes, encodingVersion: 1 };
  if (bytes.byteLength < 1024 || typeof CompressionStream !== 'function'
    || typeof DecompressionStream !== 'function') return raw;
  try {
    const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('gzip'));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    if (compressed.byteLength < bytes.byteLength) {
      return { digest, bytes: compressed, codec: 'gzip', rawSize: bytes.byteLength, encodingVersion: 1 };
    }
  } catch { /* Compression is optional, just like the disk cache. */ }
  return raw;
}

export async function decodeSurfaceCacheRecord(row: SurfaceCacheRecord): Promise<Uint8Array | undefined> {
  if (!(row?.bytes instanceof Uint8Array) || row.bytes.byteLength > MAX_ENTRY_BYTES) return undefined;
  // Existing v1 rows remain usable; the authenticated manifest still checks their hash.
  if (row.codec === undefined) return row.bytes;
  if (row.codec !== 'gzip' || typeof DecompressionStream !== 'function'
    || !Number.isSafeInteger(row.rawSize) || row.rawSize! < 1 || row.rawSize! > MAX_ENTRY_BYTES) return undefined;
  const reader = new Blob([row.bytes as Uint8Array<ArrayBuffer>]).stream()
    .pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > row.rawSize!) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
    if (length !== row.rawSize) return undefined;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch { return undefined; }
  finally { reader.releaseLock(); }
}

export function surfaceDiskBudget(quota?: number): number {
  // Share quota with edits, inventory and other site storage. Never request
  // persistent-storage permission or fill the disk unconditionally.
  return Math.max(0, Math.min(2048 * MiB, Number.isFinite(quota) ? quota! * 0.2 : 512 * MiB));
}

interface CacheMetadata { digest: string; size: number; accessed: number }

export function createSurfaceDiskCache(): SurfaceByteCache {
  let database: Promise<IDBDatabase | null> | undefined;
  const touches = new Map<string, number>();
  let touchTimer: ReturnType<typeof setTimeout> | undefined;
  const open = () => database ??= new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    try {
      const request = indexedDB.open('space-surface-cache-v1', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'digest' });
        if (!db.objectStoreNames.contains(META)) {
          const store = db.createObjectStore(META, { keyPath: 'digest' });
          store.createIndex('accessed', 'accessed');
        }
        if (!db.objectStoreNames.contains(ACCOUNTING)) db.createObjectStore(ACCOUNTING);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); database = undefined; };
        resolve(db);
      };
      request.onerror = request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  async function transact<T>(stores: string[], mode: IDBTransactionMode,
    action: (transaction: IDBTransaction, result: (value: T) => void) => void): Promise<T | undefined> {
    const db = await open();
    if (!db) return undefined;
    return new Promise(resolve => {
      try {
        const transaction = db.transaction(stores, mode);
        let value: T | undefined;
        transaction.oncomplete = () => resolve(value);
        transaction.onerror = transaction.onabort = () => resolve(undefined);
        action(transaction, result => { value = result; });
      } catch { resolve(undefined); }
    });
  }
  // v1 rows have no total. Scan their small metadata once, atomically with the
  // first mutation. Later transactions (including other tabs) update the total.
  function withTotal(transaction: IDBTransaction, apply: (total: number) => void) {
    const accounting = transaction.objectStore(ACCOUNTING);
    const request = accounting.get(TOTAL);
    request.onsuccess = () => {
      if (Number.isSafeInteger(request.result) && request.result >= 0) {
        apply(request.result);
        return;
      }
      let total = 0;
      const cursor = transaction.objectStore(META).openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (entry) { total += Number(entry.value.size) || 0; entry.continue(); }
        else { accounting.put(total, TOTAL); apply(total); }
      };
    };
  }
  function touch(digest: string) {
    touches.set(digest, Date.now());
    if (touchTimer !== undefined) return;
    touchTimer = setTimeout(() => {
      touchTimer = undefined;
      const batch = [...touches];
      touches.clear();
      void transact<void>([META], 'readwrite', transaction => {
        const meta = transaction.objectStore(META);
        for (const [key, accessed] of batch) {
          const request = meta.get(key);
          request.onsuccess = () => {
            // Eviction/removal may have happened while the touch was queued.
            if (request.result) meta.put({ ...request.result, accessed });
          };
        }
      });
    }, 250);
    touchTimer.unref?.();
  }
  const writes = new SurfaceCacheWrites(async (digest, bytes) => {
    if (bytes.byteLength > MAX_ENTRY_BYTES || !await open()) return;
    let quota: number | undefined;
    try { quota = (await navigator.storage?.estimate())?.quota; } catch { /* optional */ }
    const budget = surfaceDiskBudget(quota);
    if (budget === 0) return;
    const row = await encodeSurfaceCacheRecord(digest, bytes);
    const storedSize = row.bytes.byteLength;
    if (storedSize > budget) return;
    await transact<void>([STORE, META, ACCOUNTING], 'readwrite', transaction => {
      const store = transaction.objectStore(STORE), meta = transaction.objectStore(META);
      const accounting = transaction.objectStore(ACCOUNTING);
      withTotal(transaction, currentTotal => {
        const previous = meta.get(digest);
        previous.onsuccess = () => {
          let total = currentTotal - (Number(previous.result?.size) || 0) + storedSize;
          const commit = () => {
            store.put(row);
            meta.put({ digest, size: storedSize, accessed: Date.now() });
            accounting.put(total, TOTAL);
          };
          if (total <= budget) { commit(); return; }
          // Visit only the oldest victims needed to make room, not every key.
          const cursor = meta.index('accessed').openCursor();
          cursor.onsuccess = () => {
            const entry = cursor.result;
            if (!entry) { commit(); return; }
            const victim = entry.value as CacheMetadata;
            if (victim.digest !== digest) {
              store.delete(victim.digest); entry.delete(); total -= victim.size;
            }
            if (total <= budget) commit();
            else entry.continue();
          };
        };
      });
    });
  });
  const cache: SurfaceByteCache = {
    async get(digest) {
      // Large blob reads use readonly transactions; LRU touches are batched.
      const row = await transact<SurfaceCacheRecord>([STORE], 'readonly', (transaction, result) => {
        const request = transaction.objectStore(STORE).get(digest);
        request.onsuccess = () => result(request.result);
      });
      if (!row) return undefined;
      const bytes = await decodeSurfaceCacheRecord(row).catch(() => undefined);
      if (!bytes) { await cache.remove(digest); return undefined; }
      touch(digest);
      // Mark even incompressible rows as migrated, avoiding recompression on
      // every read. This shares the bounded background-write queue.
      if (row.encodingVersion !== 1 && bytes.byteLength >= 1024) void writes.enqueue(digest, bytes);
      return bytes;
    },
    put: (digest, bytes) => writes.enqueue(digest, bytes),
    async remove(digest) {
      touches.delete(digest);
      await transact<void>([STORE, META, ACCOUNTING], 'readwrite', transaction => {
        const meta = transaction.objectStore(META);
        withTotal(transaction, total => {
          const request = meta.get(digest);
          request.onsuccess = () => {
            transaction.objectStore(STORE).delete(digest);
            meta.delete(digest);
            transaction.objectStore(ACCOUNTING).put(Math.max(0, total - (Number(request.result?.size) || 0)), TOTAL);
          };
        });
      });
    },
  };
  return cache;
}
