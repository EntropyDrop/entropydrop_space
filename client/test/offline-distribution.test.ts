import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineSession, enterOfflineSpace } from '../src/bootstrap/OfflineSpace.ts';
import { onlineSpaceUrl } from '../src/bootstrap/SpaceSiteLinks.ts';
import { WorldEditPersistence } from '@entropydrop/space-engine/voxel/WorldEditPersistence.ts';

function storageFixture() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test('offline distribution includes three deterministic worlds without credentials or remote services', () => {
  for (const [world, version] of [['aether-archipelago', 3], ['nature', 1], ['copper-metropolis', 2]] as const) {
    const session = createOfflineSession(null, world);
    assert.equal(session.world.slug, world);
    assert.equal(session.world.terrain_generator_version, version);
    assert.match(session.world.id, /^offline-/);
    assert.equal(session.token, '');
    assert.equal(session.api_origin, '');
    assert.equal(session.websocket_url, '');
    assert.equal(session.terrain_edit_remote, null);
    assert.equal(session.surface_snapshot_remote, null);
    assert.equal(session.latency_monitor, null);
    assert.equal(session.player.is_admin, false);
    assert.equal(session.skin_object_url, session.player.skin_url);
  }
  for (const world of [undefined, 'default', 'unknown', '__proto__']) {
    assert.equal(createOfflineSession(null, world).world.slug, 'aether-archipelago');
  }
});

test('offline player saves survive restart and stay isolated per world', async () => {
  const storage = storageFixture();
  const session = createOfflineSession(storage);
  const position = { x_cm: 12345, y_cm: 6789, z_cm: 23456, yaw_q15: -900 };
  await session.player_position_remote.save(position);
  const restored = createOfflineSession(storage);
  assert.equal(restored.player.start_x_cm, position.x_cm);
  assert.equal(restored.player.start_y_cm, position.y_cm);
  assert.equal(restored.player.start_z_cm, position.z_cm);
  assert.equal(restored.player.start_yaw_q15, position.yaw_q15);
  assert.notEqual(createOfflineSession(storage, 'nature').player.start_x_cm, position.x_cm);
  await session.player_position_remote.save({ ...position, x_cm: NaN });
  assert.equal(createOfflineSession(storage).player.start_x_cm, position.x_cm);
  storage.setItem(`space.offline.position.${session.world.id}`, '{broken');
  assert.equal(createOfflineSession(storage).player.start_x_cm, createOfflineSession(null).player.start_x_cm);
});

test('offline terrain edits remain available to a new persistence instance', () => {
  const storage = storageFixture();
  const session = createOfflineSession(storage, 'nature');
  const edits = new WorldEditPersistence({ worldId: session.world.id, storage });
  edits.recordStandard(10, 20, 30, 1, 0xff0000);
  assert.equal(edits.flush(), true);
  const restored = new WorldEditPersistence({ worldId: session.world.id, storage });
  const saved = [...restored.getStandardEditsForChunk(0, 1)];
  assert.equal(saved.length, 1);
  assert.deepEqual(saved, [...edits.getStandardEditsForChunk(0, 1)]);
});

test('offline entry starts without contacting an account API and reports startup failures', async t => {
  const original = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (key: string, value: unknown) => {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  t.after(() => {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const elements = new Map<string, any>();
  for (const id of ['gate', 'status', 'progress', 'progress-fill', 'progress-value', 'action']) {
    elements.set(`space-entry-${id}`, { hidden: false, style: {}, textContent: '', setAttribute() {}, classList: { add() {} } });
  }
  setGlobal('document', { getElementById: (id: string) => elements.get(id) ?? null });
  setGlobal('window', { location: { search: '?world=nature' } });
  setGlobal('localStorage', storageFixture());
  setGlobal('indexedDB', undefined);
  setGlobal('fetch', () => assert.fail('offline entry must not fetch account or world APIs'));
  let started = 0;
  await enterOfflineSpace(async (session, storage, report) => {
    assert.equal(session.world.slug, 'nature');
    assert.ok(storage);
    report(95, 'Loading terrain');
    started++;
  });
  assert.equal(started, 1);
  assert.equal(elements.get('space-entry-gate').hidden, true);
  assert.equal(elements.get('space-entry-progress-value').textContent, '100%');
  setGlobal('console', { ...console, error() {} });
  await enterOfflineSpace(async () => { throw new Error('WebGPU unavailable'); });
  assert.equal(elements.get('space-entry-gate').hidden, false);
  assert.match(elements.get('space-entry-status').textContent, /WebGPU unavailable/);
  assert.equal(elements.get('space-entry-action').href, 'https://space.entropydrop.com/');
});

test('offline feature links point to the online Space and select the intended panel', () => {
  for (const panel of ['market', 'agent-build'] as const) {
    const url = new URL(onlineSpaceUrl(panel));
    assert.equal(url.origin, 'https://space.entropydrop.com');
    assert.equal(url.searchParams.get('panel'), panel);
  }
});
