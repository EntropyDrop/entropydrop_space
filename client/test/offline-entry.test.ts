import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { offlineSession, ephemeralStorage } from '../src/dev/OfflineEntry.ts';

test('offline development fixtures contain no credentials or remote services', async () => {
  const session = offlineSession();
  assert.equal(session.token, '');
  assert.equal(session.api_origin, '');
  assert.equal(session.websocket_url, '');
  assert.equal(session.latency_monitor, null);
  assert.equal(session.terrain_edit_remote, null);
  assert.equal(session.surface_snapshot_remote, null);
  assert.equal(session.player.is_admin, false);
  assert.equal(session.world.terrain_generator_version, 2);
  await session.player_position_remote.save({ x_cm: 0, y_cm: 6400, z_cm: 0, yaw_q15: 0, pitch_q15: 0 });
  const first = ephemeralStorage(), second = ephemeralStorage();
  first.setItem('edit', 'local');
  assert.equal(first.getItem('edit'), 'local');
  assert.equal(second.getItem('edit'), null);
});

test('offline entry is dynamically imported behind a build-time development guard', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(import\.meta\.env\.DEV &&[^\n]+dev_offline[^\n]+\) \{\s+void import\('\.\/dev\/OfflineEntry\.ts'\)/);
  assert.match(source, /const offline = import\.meta\.env\.DEV && developmentOffline/);
  assert.match(source, /if \(!offline\) \{\s+this\.multiplayerSync = new MultiplayerSync/);
  const entry = readFileSync(new URL('../src/dev/OfflineEntry.ts', import.meta.url), 'utf8');
  assert.match(entry, /!import\.meta\.env\.DEV \|\|.*location\.hostname/);
});
