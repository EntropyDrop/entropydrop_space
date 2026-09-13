import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';


test('Space UI shows queue position and can cancel queue', async () => {
  const store = new SpaceUiStore();
  let cancelled = 0;
  store.setSessionState('online', 12, async () => {
    cancelled += 1;
    store.setSessionState('online', null, null);
  });

  assert.equal(store.getSnapshot().sessionMode, 'online');
  assert.equal(store.getSnapshot().queuePosition, 12);
  await store.cancelSpaceQueue();
  assert.equal(cancelled, 1);
  assert.equal(store.getSnapshot().sessionMode, 'online');
  assert.equal(store.getSnapshot().queuePosition, null);
});

test('a completed queue signals onlineReady for the player', async () => {
  const store = new SpaceUiStore();
  let enteredOnline = 0;
  store.setSessionState(
    'online',
    null,
    null,
    true,
    () => {
      enteredOnline += 1;
    }
  );

  assert.equal(store.getSnapshot().onlineReady, true);
  assert.equal(enteredOnline, 0);

  store.enterOnlineSpace();
  assert.equal(enteredOnline, 1);
});

test('Space UI keeps skin setup guidance available in settings', () => {
  const store = new SpaceUiStore();
  assert.equal(store.getSnapshot().skinWarning, null);

  store.setSkinWarning('Default skin is in use.');
  assert.equal(store.getSnapshot().skinWarning, 'Default skin is in use.');
});


test('Space welcome surfaces do NOT expose offline mode entries', () => {
  const appHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  assert.doesNotMatch(appHtml, /\?mode=offline/);
});

test('main.ts runs exclusively in online mode with remote persistence and backpack persistence', () => {
  const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

  // Must not branch on offline mode
  assert.doesNotMatch(mainSource, /session\.mode === 'offline'/);

  // Storage and remote persistence are always enabled
  assert.match(mainSource, /storage:\s*persistentStorage/);
  assert.match(mainSource, /this\.contraptionManager\.setEntityPersistenceMode\(\s*'remote'\s*\)/);
  assert.doesNotMatch(mainSource, /this\.contraptionManager\.loadEntitiesFromStorage\(\)/);

  // Backpack retains persistentStorage
  assert.match(mainSource, /new PlayerController\([\s\S]*?persistentStorage\s*\)/);
});

test('WorldEditPersistence with storage null does not persist terrain edits', async () => {
  const { WorldEditPersistence } = await import('@entropydrop/space-engine/voxel/WorldEditPersistence.ts');
  const worldId = 'test-sandbox-v1';
  const persistence = new WorldEditPersistence({
    worldId,
    storage: null,
  });

  persistence.recordStandard(10, 20, 30, 1, 0xff0000);
  persistence.recordMicro(80, 160, 240, 0x00ff00);
  const flushed = persistence.flush();
  assert.equal(flushed, false);
});

test('ContraptionManager in none mode does not persist or load entities and purges storage', async () => {
  const { ContraptionManager, worldEntitiesStorageKey } = await import('@entropydrop/space-engine/contraption/ContraptionManager.ts');
  const worldId = 'test-sandbox-v1';
  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };

  // Pre-seed legacy offline entity data
  store.set(worldEntitiesStorageKey(worldId), JSON.stringify({
    type: 'space-entities',
    version: 4,
    worldId,
    entities: [{ publicId: 'test-car', slot: { blocks: [] } }]
  }));

  const manager = new ContraptionManager(null, null, null, null, mockStorage as any);
  manager.setWorldId(worldId);

  // Setting mode to 'none' must purge existing offline storage
  manager.setEntityPersistenceMode('none');
  assert.equal(store.has(worldEntitiesStorageKey(worldId)), false);

  // Saving must be a no-op
  const saved = manager.saveEntitiesToStorage();
  assert.equal(saved, false);
  assert.equal(store.has(worldEntitiesStorageKey(worldId)), false);

  // Loading must return 0
  const loaded = manager.loadEntitiesFromStorage();
  assert.equal(loaded, 0);
});
