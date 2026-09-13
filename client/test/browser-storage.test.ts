import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BufferedIndexedDbStorage,
  createSpacePersistentStorage,
  isLargeSpaceStorageKey,
  type AsyncKeyValueBackend,
} from '../src/engine/storage/BrowserStorage.ts';

class MemoryBackend implements AsyncKeyValueBackend {
  readonly values = new Map<string, string | Uint8Array>();
  failNextWrite = false;

  constructor(entries: Array<[string, string | Uint8Array]> = []) {
    for (const [key, value] of entries) this.values.set(key, value);
  }

  async entries() {
    return [...this.values.entries()];
  }

  async set(key: string, value: string | Uint8Array) {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('simulated IndexedDB failure');
    }
    this.values.set(key, value);
  }

  async remove(key: string) {
    this.values.delete(key);
  }
}

class EnumerableMemoryStorage {
  readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

test('large game payloads are selected for IndexedDB while synchronous preferences stay local', () => {
  assert.equal(isLargeSpaceStorageKey('space.backpack.v8.pb'), true);
  assert.equal(isLargeSpaceStorageKey('space.backpack.v5.pb'), false);
  assert.equal(isLargeSpaceStorageKey('space.backpack.v3.pb'), false);
  assert.equal(isLargeSpaceStorageKey('space.backpack.v2'), false);
  assert.equal(isLargeSpaceStorageKey('space.world-edits.v3.world-a'), true);
  assert.equal(isLargeSpaceStorageKey('space.world-edits.v1.world-a'), false);
  assert.equal(isLargeSpaceStorageKey('entropydrop_space_entities.world-a'), true);
  assert.equal(isLargeSpaceStorageKey('token'), false);
  assert.equal(isLargeSpaceStorageKey('space_setting_fov'), false);
  assert.equal(isLargeSpaceStorageKey('space_palette_colors'), false);
});

test('IndexedDB hydration migrates legacy large payloads and preserves fallback-session writes', async () => {
  const legacy = new EnumerableMemoryStorage();
  legacy.setItem('token', 'keep-synchronous');
  legacy.setItem('space_setting_fov', '80');
  legacy.setItem('space.world-edits.v3.world-a', 'legacy-terrain');
  legacy.setItem('entropydrop_space_entities.world-a', 'legacy-entities');
  legacy.setItem('space.backpack.v8.pb', 'fallback-session-backpack');
  const backend = new MemoryBackend([['space.backpack.v8.pb', 'older-indexeddb-backpack']]);

  const storage = await BufferedIndexedDbStorage.hydrate(backend, legacy);

  assert.equal(storage.getItem('space.world-edits.v3.world-a'), 'legacy-terrain');
  assert.equal(storage.getItem('entropydrop_space_entities.world-a'), 'legacy-entities');
  assert.equal(storage.getItem('space.backpack.v8.pb'), 'fallback-session-backpack');
  assert.equal(backend.values.get('space.backpack.v8.pb'), 'fallback-session-backpack');
  assert.equal(backend.values.get('space.world-edits.v3.world-a'), 'legacy-terrain');
  assert.equal(legacy.getItem('space.world-edits.v3.world-a'), null);
  assert.equal(legacy.getItem('entropydrop_space_entities.world-a'), null);
  assert.equal(legacy.getItem('space.backpack.v8.pb'), null);
  assert.equal(legacy.getItem('token'), 'keep-synchronous');
  assert.equal(legacy.getItem('space_setting_fov'), '80');
});

test('the hydrated adapter is synchronous in memory and exposes durable write completion', async () => {
  const backend = new MemoryBackend();
  const storage = await BufferedIndexedDbStorage.hydrate(backend);

  storage.setItem('space.backpack.v8.pb', 'payload');
  assert.equal(storage.getItem('space.backpack.v8.pb'), 'payload');
  await storage.whenIdle();
  assert.equal(backend.values.get('space.backpack.v8.pb'), 'payload');

  const bytes = Uint8Array.from([8, 5, 26, 0]);
  storage.setBytes('space.backpack.v8.pb', bytes);
  bytes[0] = 0;
  assert.deepEqual(storage.getBytes('space.backpack.v8.pb'), Uint8Array.from([8, 5, 26, 0]));
  assert.equal(storage.getItem('space.backpack.v8.pb'), null);
  await storage.whenIdle();
  assert.deepEqual(backend.values.get('space.backpack.v8.pb'), Uint8Array.from([8, 5, 26, 0]));

  storage.removeItem('space.backpack.v8.pb');
  assert.equal(storage.getBytes('space.backpack.v8.pb'), null);
  await storage.whenIdle();
  assert.equal(backend.values.has('space.backpack.v8.pb'), false);

  backend.failNextWrite = true;
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    storage.setItem('space.backpack.v8.pb', 'retryable');
    await assert.rejects(storage.whenIdle(), /simulated IndexedDB failure/);
  } finally {
    console.warn = originalWarn;
  }
});

test('storage creation falls back to localStorage when IndexedDB is unavailable', async () => {
  const legacy = new EnumerableMemoryStorage();
  const storage = await createSpacePersistentStorage({ indexedDb: null, legacyStorage: legacy });
  assert.equal(storage, legacy);
});
