import type { SpaceStorage } from '@entropydrop/space-engine/storage/SpaceStorage.ts';
export type { SpaceStorage } from '@entropydrop/space-engine/storage/SpaceStorage.ts';

const DATABASE_NAME = 'entropydrop-space';
const DATABASE_VERSION = 1;
const OBJECT_STORE_NAME = 'persistent-values';

export interface EnumerableSpaceStorage extends SpaceStorage {
  readonly length?: number;
  key?(index: number): string | null;
}

export interface AsyncKeyValueBackend {
  entries(): Promise<Array<[string, SpaceStoredValue]>>;
  set(key: string, value: SpaceStoredValue): Promise<void>;
  remove(key: string): Promise<void>;
}

type SpaceStoredValue = string | Uint8Array;

export function isLargeSpaceStorageKey(key: string) {
  return key === 'space.backpack.v8.pb'
    || key.startsWith('space.world-edits.v3.')
    || key.startsWith('entropydrop_space_entities.');
}

function enumerableKeys(storage: EnumerableSpaceStorage | null) {
  if (!storage || typeof storage.length !== 'number' || typeof storage.key !== 'function') return [];
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (typeof key === 'string') keys.push(key);
  }
  return keys;
}

/**
 * Synchronous localStorage-compatible view backed by an asynchronously
 * committed IndexedDB object store. The browser entry point awaits hydration
 * before constructing the game, so existing engine code can keep synchronous
 * reads without blocking the main thread on disk I/O.
 */
export class BufferedIndexedDbStorage implements SpaceStorage {
  private readonly values: Map<string, SpaceStoredValue>;
  private readonly backend: AsyncKeyValueBackend;
  private pendingWrites: Promise<void> = Promise.resolve();
  private writeErrors: unknown[] = [];

  private constructor(backend: AsyncKeyValueBackend, values: Map<string, SpaceStoredValue>) {
    this.backend = backend;
    this.values = values;
  }

  static async hydrate(
    backend: AsyncKeyValueBackend,
    legacyStorage: EnumerableSpaceStorage | null = null
  ) {
    const values = new Map(await backend.entries());

    // Migrate only high-volume game data. Authentication and tiny synchronous
    // UI preferences intentionally stay in localStorage.
    for (const key of enumerableKeys(legacyStorage).filter(isLargeSpaceStorageKey)) {
      const legacyValue = legacyStorage?.getItem(key);
      if (legacyValue !== null) {
        // Commit before deleting the legacy copy: an interrupted migration is
        // therefore retryable and never loses the only durable value. A legacy
        // value also wins over an existing IndexedDB value because it may have
        // been written by a previous session that had to use the fallback.
        await backend.set(key, legacyValue);
        values.set(key, legacyValue);
      }
      try {
        legacyStorage?.removeItem(key);
      } catch {
        // A read-only legacy store is harmless; IndexedDB is already durable.
      }
    }

    return new BufferedIndexedDbStorage(backend, values);
  }

  getItem(key: string) {
    const value = this.values.get(String(key));
    return typeof value === 'string' ? value : null;
  }

  setItem(key: string, value: string) {
    const normalizedKey = String(key);
    const normalizedValue = String(value);
    this.values.set(normalizedKey, normalizedValue);
    this.enqueueWrite(() => this.backend.set(normalizedKey, normalizedValue));
  }

  getBytes(key: string) {
    const value = this.values.get(String(key));
    return value instanceof Uint8Array ? value.slice() : null;
  }

  setBytes(key: string, value: Uint8Array) {
    const normalizedKey = String(key);
    const normalizedValue = value.slice();
    this.values.set(normalizedKey, normalizedValue);
    this.enqueueWrite(() => this.backend.set(normalizedKey, normalizedValue));
  }

  removeItem(key: string) {
    const normalizedKey = String(key);
    this.values.delete(normalizedKey);
    this.enqueueWrite(() => this.backend.remove(normalizedKey));
  }

  async whenIdle() {
    await this.pendingWrites;
    if (this.writeErrors.length === 0) return;
    const errors = this.writeErrors.splice(0);
    throw errors.length === 1
      ? errors[0]
      : new AggregateError(errors, 'One or more IndexedDB writes failed');
  }

  private enqueueWrite(operation: () => Promise<void>) {
    this.pendingWrites = this.pendingWrites.then(async () => {
      try {
        await operation();
      } catch (error) {
        this.writeErrors.push(error);
        console.warn('Space could not persist browser data to IndexedDB.', error);
      }
    });
  }
}

class IndexedDbKeyValueBackend implements AsyncKeyValueBackend {
  private readonly database: IDBDatabase;

  private constructor(database: IDBDatabase) {
    this.database = database;
  }

  static open(factory: IDBFactory) {
    return new Promise<IndexedDbKeyValueBackend>((resolve, reject) => {
      const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(OBJECT_STORE_NAME)) {
          database.createObjectStore(OBJECT_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(new IndexedDbKeyValueBackend(request.result));
      request.onerror = () => reject(request.error || new Error('Could not open IndexedDB'));
      request.onblocked = () => reject(new Error('IndexedDB upgrade was blocked by another tab'));
    });
  }

  entries() {
    return new Promise<Array<[string, SpaceStoredValue]>>((resolve, reject) => {
      const transaction = this.database.transaction(OBJECT_STORE_NAME, 'readonly');
      const request = transaction.objectStore(OBJECT_STORE_NAME).openCursor();
      const entries: Array<[string, SpaceStoredValue]> = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (typeof cursor.key === 'string') {
          if (typeof cursor.value === 'string') {
            entries.push([cursor.key, cursor.value]);
          } else if (cursor.value instanceof Uint8Array) {
            entries.push([cursor.key, cursor.value.slice()]);
          } else if (cursor.value instanceof ArrayBuffer) {
            entries.push([cursor.key, new Uint8Array(cursor.value)]);
          } else if (ArrayBuffer.isView(cursor.value)) {
            const bytes = new Uint8Array(cursor.value.byteLength);
            bytes.set(new Uint8Array(cursor.value.buffer, cursor.value.byteOffset, cursor.value.byteLength));
            entries.push([cursor.key, bytes]);
          }
        }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve(entries);
      transaction.onerror = () => reject(transaction.error || new Error('Could not read IndexedDB'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB read was aborted'));
    });
  }

  set(key: string, value: SpaceStoredValue) {
    return this.runWrite(store => store.put(value, key));
  }

  remove(key: string) {
    return this.runWrite(store => store.delete(key));
  }

  private runWrite(operation: (store: IDBObjectStore) => IDBRequest) {
    return new Promise<void>((resolve, reject) => {
      const transaction = this.database.transaction(OBJECT_STORE_NAME, 'readwrite');
      operation(transaction.objectStore(OBJECT_STORE_NAME));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB write failed'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB write was aborted'));
    });
  }
}

function resolveLocalStorage(): EnumerableSpaceStorage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

export interface CreateSpaceStorageOptions {
  indexedDb?: IDBFactory | null;
  legacyStorage?: EnumerableSpaceStorage | null;
}

export async function createSpacePersistentStorage(options: CreateSpaceStorageOptions = {}) {
  const legacyStorage = options.legacyStorage === undefined
    ? resolveLocalStorage()
    : options.legacyStorage;
  const factory = options.indexedDb === undefined ? globalThis.indexedDB : options.indexedDb;
  if (!factory) return legacyStorage;

  try {
    const backend = await IndexedDbKeyValueBackend.open(factory);
    return await BufferedIndexedDbStorage.hydrate(backend, legacyStorage);
  } catch (error) {
    console.warn('Space is using localStorage because IndexedDB is unavailable.', error);
    return legacyStorage;
  }
}
