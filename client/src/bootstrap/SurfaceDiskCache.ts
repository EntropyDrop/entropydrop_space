/** Optional, content-addressed cache. Authentication always happens at the
 * manifest; cached bytes are revalidated against its digest before use. */
export interface SurfaceByteCache {
  get(digest: string): Promise<Uint8Array | undefined>;
  put(digest: string, bytes: Uint8Array): Promise<void>;
  remove(digest: string): Promise<void>;
}

const STORE = 'snapshots';
const META = 'metadata';
const MiB = 1024 * 1024;
export function surfaceDiskBudget(quota?: number): number {
  // Share quota with edits, inventory and other site storage. Never request
  // persistent-storage permission or fill the disk unconditionally.
  return Math.max(0, Math.min(2048 * MiB, Number.isFinite(quota) ? quota! * 0.2 : 512 * MiB));
}

export function createSurfaceDiskCache(): SurfaceByteCache {
  let database: Promise<IDBDatabase | null> | undefined;
  let writes = Promise.resolve();
  const open = () => database ??= new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    try {
      const request = indexedDB.open('space-surface-cache-v1', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: 'digest' });
        const store = request.result.createObjectStore(META, { keyPath: 'digest' });
        store.createIndex('accessed', 'accessed');
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); database = undefined; };
        resolve(db);
      };
      request.onerror = request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  async function transact<T>(mode: IDBTransactionMode,
    action: (store: IDBObjectStore, result: (value: T) => void, meta: IDBObjectStore) => void): Promise<T | undefined> {
    const db = await open();
    if (!db) return undefined;
    return new Promise(resolve => {
      try {
        const transaction = db.transaction([STORE, META], mode);
        let value: T | undefined;
        transaction.oncomplete = () => resolve(value);
        transaction.onerror = transaction.onabort = () => resolve(undefined);
        action(transaction.objectStore(STORE), result => { value = result; }, transaction.objectStore(META));
      } catch { resolve(undefined); }
    });
  }
  return {
    async get(digest) {
      return transact<Uint8Array>('readwrite', (store, result, meta) => {
        const request = store.get(digest);
        request.onsuccess = () => {
          const row = request.result;
          if (!(row?.bytes instanceof Uint8Array)) return;
          result(row.bytes);
          meta.put({ digest, size: row.bytes.byteLength, accessed: Date.now() });
        };
      });
    },
    async put(digest, bytes) {
      // Serialize writes so simultaneous downloads cannot all pass the same
      // quota check. Scan metadata via cursors, never clone all cached blobs.
      writes = writes.then(async () => {
        let quota: number | undefined;
        try { quota = (await navigator.storage?.estimate())?.quota; } catch { /* optional */ }
        const budget = surfaceDiskBudget(quota);
        if (bytes.byteLength > budget) return;
        await transact<void>('readwrite', (store, _result, meta) => {
          const rows: { digest: string; size: number }[] = [];
          let total = bytes.byteLength;
          const cursor = meta.index('accessed').openCursor();
          cursor.onsuccess = () => {
            const entry = cursor.result;
            if (entry) {
              const row = entry.value;
              if (row.digest !== digest) {
                rows.push({ digest: row.digest, size: row.size });
                total += row.size;
              }
              entry.continue();
            } else {
              for (const row of rows) {
                if (total <= budget) break;
                store.delete(row.digest); meta.delete(row.digest); total -= row.size;
              }
              store.put({ digest, bytes });
              meta.put({ digest, size: bytes.byteLength, accessed: Date.now() });
            }
          };
        });
      }).catch(() => { /* Quota/private mode must never block terrain. */ });
      await writes;
    },
    async remove(digest) { await transact<void>('readwrite', (store, _result, meta) => {
      store.delete(digest); meta.delete(digest);
    }); },
  };
}
