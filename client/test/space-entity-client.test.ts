import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CheckpointEntityRequest,
  CreateEntityRequest,
} from '@entropydrop/space-engine/generated/space_api.ts';
import {
  SpaceEntityApiError,
  SpaceEntityClient,
} from '../src/bootstrap/SpaceEntityClient.ts';


const definition = Uint8Array.from([8, 4, 26, 0]);
const definitionDigest = '0caed08c0cdfe078464c77fbc4032b985d9757db85e8fac65733d57ee7fb5917';
const snapshot = new TextEncoder().encode('{"position":[1,32,2]}');
const snapshotDigest = '8ac8c3d59ef8d0cb5704fde86de4e635578b7f9fa8f32536d2fdf9572e3df2c2';

function entity(overrides: Record<string, unknown> = {}) {
  return {
    id: '3cd7daba-d196-44e8-a433-cf139258f617',
    world_id: 'world-1',
    owner_user_id: 'owner-1',
    name: 'Walker',
    schema_version: 7,
    definition_digest: definitionDigest,
    definition_size_bytes: definition.byteLength,
    definition_url: '/ignored/untrusted/path',
    snapshot_digest: null,
    snapshot_size_bytes: 0,
    snapshot_url: null,
    position: { x_cm: 100, y_cm: 3200, z_cm: 200 },
    yaw_quarter_turns: 1,
    desired_run_state: 'running',
    revision: 1,
    can_control: true,
    can_edit: false,
    created_at: '2026-09-03T00:00:00+00:00',
    updated_at: '2026-09-03T00:00:00+00:00',
    ...overrides,
  };
}

test('SpaceEntityClient lists, verifies definitions, creates, and changes run state with auth', async () => {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, options: RequestInit = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/definition?digest=')) return new Response(definition, { status: 200 });
    if (String(url).endsWith('/snapshot')) return new Response(snapshot, { status: 200 });
    if (String(url).endsWith('/execution-leases')) {
      const request = JSON.parse(String(options.body));
      return new Response(JSON.stringify({
        instance_id: request.instance_id,
        lease_seconds: 8,
        items: [{
          entity_id: entity().id,
          granted: true,
          execution_epoch: 1,
          lease_expires_at: '2099-09-03T00:00:00+00:00',
        }],
      }), { status: 200 });
    }
    if (String(url).endsWith('/checkpoint')) {
      return new Response(JSON.stringify(entity({
        can_edit: true, revision: 2,
      })), { status: 200 });
    }
    if (options.method === 'DELETE') {
      return new Response(JSON.stringify({ deleted: true, entity_id: entity().id }), { status: 200 });
    }
    if (options.method === 'PUT') {
      return new Response(JSON.stringify(entity({ desired_run_state: 'stopped', revision: 2 })), { status: 200 });
    }
    if (String(url).endsWith('/browser')) {
      return new Response(JSON.stringify(entity({
        can_edit: true,
      })), { status: 201 });
    }
    if (options.method === 'POST') return new Response(JSON.stringify(entity()), { status: 201 });
    return new Response(JSON.stringify({ items: [entity()], truncated: false, limit: 256 }), { status: 200 });
  };
  const client = new SpaceEntityClient(
    'https://api.example.test/',
    'space-token',
    'world-1',
    fetchImpl as typeof fetch,
  );

  const listed = await client.list(100, 200, 16_000);
  await client.getDefinition(listed.items[0]);
  await client.create({
    definition,
    position: { x_cm: 100, y_cm: 3200, z_cm: 200 },
  });
  const browserEntity = entity({
    can_edit: true,
    snapshot_digest: snapshotDigest,
    snapshot_size_bytes: snapshot.byteLength,
    snapshot_url: '/snapshot',
  }) as any;
  await client.createBrowser({
    definition,
    snapshot: { position: [1, 32, 2] },
    position: { x_cm: 100, y_cm: 3200, z_cm: 200 },
    desired_run_state: 'stopped',
  });
  const loadedSnapshot = await client.getSnapshot(browserEntity);
  await client.checkpointBrowser(browserEntity.id, 1, {
    snapshot: { position: [1, 32, 2] },
    position: { x_cm: 100, y_cm: 3200, z_cm: 200 },
    desired_run_state: 'stopped',
  });
  await client.delete(browserEntity.id);
  const stopped = await client.setRunState(listed.items[0].id, 'stopped', 1);
  const leases = await client.claimExecutionLeases(
    '55437452-a51f-4d26-93b9-24c6a41f5e1a',
    [listed.items[0].id],
  );

  assert.equal(listed.items[0].name, 'Walker');
  assert.equal(listed.items[0].schema_version, 7);
  assert.deepEqual(loadedSnapshot, { position: [1, 32, 2] });
  assert.equal(stopped.revision, 2);
  assert.equal(leases[0].granted, true);
  assert.match(calls[0].url, /center_x_cm=100/);
  assert.match(calls[0].url, /radius_cm=16000/);
  assert.equal((calls[0].options.headers as any).Authorization, 'Bearer space-token');
  assert.equal(calls[1].url, `https://api.example.test/space/api/v2/worlds/world-1/entities/3cd7daba-d196-44e8-a433-cf139258f617/definition?digest=${definitionDigest}`);
  assert.equal((calls[1].options.headers as any).Authorization, 'Bearer space-token');
  assert.equal((calls[2].options.headers as any)['Content-Type'], 'application/x-protobuf');
  const createEnvelope = CreateEntityRequest.decode(calls[2].options.body as Uint8Array);
  assert.deepEqual(Array.from(createEnvelope.definition!), Array.from(definition));
  assert.deepEqual(createEnvelope.position, { xCm: 100, yCm: 3200, zCm: 200 });
  assert.match(createEnvelope.operationId!, /^[0-9a-f-]{36}$/i);
  assert.match(calls[3].url, /\/browser$/);
  const browserEnvelope = CreateEntityRequest.decode(calls[3].options.body as Uint8Array);
  assert.deepEqual(Array.from(browserEnvelope.definition!), Array.from(definition));
  assert.equal(new TextDecoder().decode(browserEnvelope.snapshotJson!), '{"position":[1,32,2]}');
  assert.match(calls[4].url, /\/snapshot$/);
  assert.match(calls[5].url, /\/checkpoint$/);
  const checkpointEnvelope = CheckpointEntityRequest.decode(calls[5].options.body as Uint8Array);
  assert.equal(checkpointEnvelope.expectedRevision, 1);
  assert.equal(checkpointEnvelope.definition?.length ?? 0, 0);
  assert.equal(new TextDecoder().decode(checkpointEnvelope.snapshotJson!), '{"position":[1,32,2]}');
  assert.equal(calls[6].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(String(calls[7].options.body)).desired_run_state, 'stopped');
  assert.equal(JSON.parse(String(calls[7].options.body)).expected_revision, 1);
  assert.match(calls[8].url, /execution-leases$/);
});

test('SpaceEntityClient rejects entity records outside the supported inventory schema', async () => {
  for (const schema_version of [5, 8]) {
    const client = new SpaceEntityClient('https://api.example.test', 'token', 'world-1',
      (async () => Response.json({
        items: [entity({ schema_version })], truncated: false, limit: 256,
      })) as typeof fetch);
    await assert.rejects(client.list(100, 200, 16_000), /Invalid Space world entity response/);
  }
});

test('SpaceEntityClient rejects a definition whose exact-byte digest does not match', async () => {
  const client = new SpaceEntityClient(
    'https://api.example.test',
    'token',
    'world-1',
    (async () => new Response(definition, { status: 200 })) as typeof fetch,
  );
  await assert.rejects(
    () => client.getDefinition(entity({ definition_digest: '0'.repeat(64) }) as any),
    (error: any) => (
      error instanceof SpaceEntityApiError
      && error.code === 'ENTITY_DEFINITION_DIGEST_MISMATCH'
    ),
  );
});

test('disabled hosting methods never issue a network request', async () => {
  let requests = 0;
  const client = new SpaceEntityClient('https://api.example.test', 'token', 'world-1', (async () => {
    requests++;
    return Response.json({});
  }) as typeof fetch);
  await assert.rejects(client.setHosting('entity-1', true), { code: 'HOSTING_DISABLED' });
  await assert.rejects(client.getHosting('entity-1'), { code: 'HOSTING_DISABLED' });
  assert.equal(requests, 0);
});
