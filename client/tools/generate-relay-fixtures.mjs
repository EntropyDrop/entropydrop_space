#!/usr/bin/env node
// Generate the canonical space-relay-v1 wire fixture consumed by the contract
// tests in apps/space/test/space-relay-v1.test.ts (frontend) and
// entropydrop_backend/tests/test_space_relay_contract.py (backend).
//
// The generated JSON must stay byte-identical in both repositories; the backend
// test skips that assertion when the sibling frontend checkout is absent.
//
// Usage: node tools/generate-relay-fixtures.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from '@msgpack/msgpack';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const frames = {
  // Client -> server. The server accepts binary MessagePack maps only and
  // rejects frames larger than 4096 bytes (SPACE_REALTIME_MAX_MESSAGE_BYTES).
  hello_client: {
    direction: 'client',
    value: { type: 'hello', ticket: 'test-ticket-000000000000000000000000000000001' },
  },
  // Pose sampled at 20 Hz for changed poses. Coordinates are wrapped world
  // centimetres (X in [0, 1638400), Z in [0, 204800)); yaw/pitch are Q15 over
  // pi: value / 32767 * pi radians.
  pose_client: {
    direction: 'client',
    value: {
      type: 'pose',
      sequence: 42,
      x_cm: 819_200,
      y_cm: 3_200,
      z_cm: 102_400,
      yaw_q15: 16_384,
      pitch_q15: 0,
    },
  },
  // Optional latency probe; the server supports it, the bundled client does not
  // send it yet.
  ping_client: {
    direction: 'client',
    value: { type: 'ping', client_time: 1_750_000_000_000 },
  },
  // Explicit menu leave; frees the admission slot immediately.
  leave_client: {
    direction: 'client',
    value: { type: 'leave' },
  },
  // Documents the inbound 4096-byte server limit: this frame must be rejected.
  hello_oversize_client: {
    direction: 'client',
    value: { type: 'hello', ticket: 't'.repeat(4_200) },
  },
  // Server -> client.
  hello_server: {
    direction: 'server',
    value: {
      type: 'hello',
      protocol: 'space-relay-v1',
      input_hz: 20,
      snapshot_hz: 10,
      persistence_seconds: 5,
    },
  },
  // One state frame per observer containing only players inside the wrapped AOI
  // radius, sent at snapshot_hz. updated_at is an ISO string or null; empty
  // skin_url falls back to the bundled offline skin on the client.
  state_server: {
    direction: 'server',
    value: {
      type: 'state',
      server_tick: 1_000,
      players: [
        {
          user_id: 'edSelf123',
          username: 'Alice',
          player_entity_id: 'ent-aaaaaaaa-0001',
          skin_url: '',
          skin_type: 'strong',
          x_cm: 819_200,
          y_cm: 3_200,
          z_cm: 102_400,
          yaw_q15: 16_384,
          pitch_q15: 0,
          is_self: true,
          updated_at: null,
        },
        {
          user_id: 'edOther456',
          username: 'Bob',
          player_entity_id: 'ent-bbbbbbbb-0002',
          skin_url: 'https://cdn.example/skins/bob.png',
          skin_type: 'slim',
          x_cm: 0,
          y_cm: 3_200,
          z_cm: 100,
          yaw_q15: -16_384,
          pitch_q15: 512,
          is_self: false,
          updated_at: '2026-09-13T08:00:00Z',
        },
      ],
    },
  },
  // Terrain revision bump; the REST cursor is invalidated and re-poll requested.
  terrain_server: {
    direction: 'server',
    value: { type: 'terrain', terrain_revision: 12_345 },
  },
  pong_server: {
    direction: 'server',
    value: { type: 'pong', client_time: 1_750_000_000_000 },
  },
};

const encoded = {};
for (const [name, frame] of Object.entries(frames)) {
  encoded[name] = {
    direction: frame.direction,
    msgpack_base64: Buffer.from(encode(frame.value)).toString('base64'),
  };
}

const fixture = {
  protocol: 'space-relay-v1',
  _note:
    'Canonical space-relay-v1 wire fixture. Keep byte-identical with '
    + 'entropydrop_backend/tests/fixtures/space-relay-v1.json. Contract tests: '
    + 'apps/space/test/space-relay-v1.test.ts and '
    + 'entropydrop_backend/tests/test_space_relay_contract.py. '
    + 'Regenerate with: node tools/generate-relay-fixtures.mjs',
  frames: encoded,
};

const target = join(appRoot, 'test', 'fixtures');
mkdirSync(target, { recursive: true });
writeFileSync(join(target, 'space-relay-v1.json'), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Wrote ${join(target, 'space-relay-v1.json')}`);
