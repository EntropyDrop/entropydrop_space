import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SpaceEntitySync } from '../src/engine/network/SpaceEntitySync.ts';
import { TORUS_SIZE_X } from '@entropydrop/space-engine/torus/TorusWorld.ts';


const definition = Uint8Array.from([8, 4, 26, 0]);
const definitionDigest = '0caed08c0cdfe078464c77fbc4032b985d9757db85e8fac65733d57ee7fb5917';

function farRetentionHarness() {
  const entity = { ...record(), desired_run_state: 'stopped' };
  const dormant = new Set([entity.id]);
  const removed: string[] = [];
  const radii: number[] = [];
  const state = { player: { x: 1, z: 2 }, visible: true, truncated: false, maxDistance: 800 };
  const sync = new SpaceEntitySync({
    apiOrigin: 'https://api.example.test', token: 'token', worldId: 'world-1', currentUserId: 'observer',
    world: { renderDistance: 8 }, controller: {},
    contraptions: {
      contraptions: [],
      findActiveContraptionByPublicId: () => null,
      updateDormantServerEntity: (id: string) => dormant.has(id),
      deleteDormantContraption(id: string) { dormant.delete(id); removed.push(id); },
    },
    getPlayerPosition: () => state.player,
    getEntityImpostorDistance: () => state.maxDistance,
    fetchImpl: (async (url, options) => {
      assert.equal(options?.method || 'GET', 'GET', 'distant retention must not start execution');
      const query = new URL(String(url)).searchParams;
      radii.push(Number(query.get('radius_cm')));
      return new Response(JSON.stringify({ items: state.visible ? [entity] : [], truncated: state.truncated, limit: 256 }));
    }) as typeof fetch,
  });
  return { sync, state, dormant, removed, radii, id: entity.id };
}

test('AOI exit keeps lightweight plane metadata across polls and range changes while freeing full entity data', async () => {
  const { sync, state, dormant, removed, radii, id } = farRetentionHarness();
  await sync.poll();
  state.visible = false;
  state.player.x = 401;
  await sync.poll();
  await sync.poll();
  assert.equal(dormant.has(id), false, 'full entity snapshots can be released outside the simulation AOI');
  assert.equal(sync.hasRetainedImpostor(id), true, 'AOI absence must not clear the independent plane cache');
  state.maxDistance = 300;
  await sync.poll();
  assert.equal(sync.hasRetainedImpostor(id), true, 'retain the small cache so a later range increase can reuse it');
  state.maxDistance = 800;
  await sync.poll();
  assert.equal(sync.hasRetainedImpostor(id), true);
  assert.ok(radii.every(radius => radius === 16000), 'never expand the simulation AOI to the plane range');
});

test('complete in-AOI deletion clears retained entities, with wraparound and truncated-list protection', async () => {
  const { sync, state, dormant, removed, id } = farRetentionHarness();
  await sync.poll();
  state.visible = false;
  state.player.x = 401;
  await sync.poll();
  state.player.x = TORUS_SIZE_X - 20;
  state.truncated = true;
  await sync.poll();
  assert.equal(sync.hasRetainedImpostor(id), true, 'an incomplete response cannot prove deletion');
  state.truncated = false;
  await sync.poll();
  assert.equal(sync.hasRetainedImpostor(id), false, 'the wrapped location is nearby, so complete absence means deletion');
});

function record() {
  return {
    id: '3cd7daba-d196-44e8-a433-cf139258f617',
    world_id: 'world-1',
    owner_user_id: 'owner-1',
    name: 'Walker',
    schema_version: 7,
    definition_digest: definitionDigest,
    definition_size_bytes: definition.byteLength,
    definition_url: '/definition',
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
  };
}

function harness(currentUserId: string, overrides: Record<string, unknown> = {}) {
  const actions: string[] = [];
  const created: any[] = [];
  const removed: any[] = [];
  const restored: any[] = [];
  const manager: any = {
    contraptions: created,
    findActiveContraptionByPublicId: () => null,
    updateDormantServerEntity: () => false,
    removeContraption(contraption: any) {
      removed.push(contraption);
    },
    restoreContraptionStreamingState(contraption: any, state: any) {
      restored.push({ contraption, state });
      if (Array.isArray(state.position)) contraption.position.fromArray(state.position);
    },
    buildFromSlot(_slot, origin) {
      let running = true;
      const entity: any = {
        publicId: 'temporary',
        position: origin.clone().add(new THREE.Vector3(1, 0, 0)),
        quaternion: new THREE.Quaternion(),
        localCenter: new THREE.Vector3(1, 0, 0),
        originWorldPos: origin.clone(),
        isPhysicsSimulationEnabled: () => running,
        updateTransform() {},
        setRunning(value: boolean) { running = value; },
        setPhysicsSimulationEnabled(value: boolean) { running = value; },
      };
      created.push(entity);
      return entity;
    },
    performBasicAction(command) {
      const running = command.action === 'start-scripts';
      command.target.contraption.setRunning(running);
      actions.push(command.action);
      return { ok: true };
    },
  };
  const fetchImpl = async (url: string | URL | Request, options: RequestInit = {}) => {
    if (String(url).includes('/definition?digest=')) return new Response(definition, { status: 200 });
    if (String(url).endsWith('/execution-leases')) {
      assert.notEqual(overrides.execution_mode, 'hosted', 'hosted entities never request browser leases');
      const request = JSON.parse(String(options.body));
      return new Response(JSON.stringify({
        instance_id: request.instance_id,
        lease_seconds: 8,
        items: [{
          entity_id: record().id,
          granted: true,
          execution_epoch: 1,
          lease_expires_at: new Date(Date.now() + 8_000).toISOString(),
        }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [{ ...record(), ...overrides }], truncated: false, limit: 256 }), { status: 200 });
  };
  const sync = new SpaceEntitySync({
    apiOrigin: 'https://api.example.test',
    token: 'token',
    worldId: 'world-1',
    currentUserId,
    controller: { parseInventoryImport: () => ({ ok: true, item: { blocks: [{}] } }) },
    contraptions: manager,
    world: { renderDistance: 8 },
    getPlayerPosition: () => ({ x: 1, z: 2 }),
    fetchImpl: fetchImpl as typeof fetch,
  });
  return { sync, created, actions, removed, restored, overrides };
}

test('the owner lease runs one browser entity at its exact quarter-turn construction origin', async () => {
  const { sync, created, actions } = harness('owner-1');

  await sync.poll();

  assert.equal(created.length, 1);
  assert.equal(created[0].publicId, record().id);
  assert.equal(created[0].serverExecutesLocally, true);
  assert.equal(created[0].isPhysicsSimulationEnabled(), true);
  assert.deepEqual(actions, []);
  assert.ok(created[0].originWorldPos.distanceTo(new THREE.Vector3(1, 32, 2)) < 1e-12);
  assert.ok(created[0].position.distanceTo(new THREE.Vector3(1, 32, 1)) < 1e-12);
});

test('a non-owner browser keeps the shared entity in stopped collision state', async () => {
  const { sync, created, actions } = harness('observer-1');

  await sync.poll();

  assert.equal(created[0].serverExecutesLocally, false);
  assert.equal(created[0].isPhysicsSimulationEnabled(), false);
  assert.deepEqual(actions, ['stop-scripts']);
});

test('hosted entities preserve the server pose without browser execution or global Stop', async () => {
  const { sync, created, actions } = harness('owner-1', { execution_mode: 'hosted', hosting_enabled: true });
  await sync.poll();
  const entity = created[0];
  assert.equal(entity.serverExecutesLocally, false);
  assert.equal(entity.serverExecutionMode, 'hosted');
  assert.equal(entity.serverHostingEnabled, true);
  assert.equal(entity.isPhysicsSimulationEnabled(), false);
  assert.deepEqual(actions, [], 'global Stop would erase the saved runtime pose');
  assert.ok(entity.position.distanceTo(new THREE.Vector3(1, 32, 1)) < 1e-12);
});

test('entities grabbed by the wrench are not interrupted by server sync or polling playback', async () => {
  const { sync, created, actions } = harness('owner-1');
  await sync.poll();
  assert.equal(created.length, 1);
  const entity = created[0];
  entity.isWrenchGrabbed = true;
  entity.scriptStatus = 'stopped';
  // Simulate entity being dragged: physics is active for drag servo
  entity.setPhysicsSimulationEnabled(true);

  // Poll again with updated revision
  await sync.poll();
  assert.deepEqual(actions, [], 'applyPlayback must not fire stop-scripts or start-scripts while wrench-grabbed');
});

test('entities stopped by wrench do not get restarted by polling after release', async () => {
  const { sync, created, actions } = harness('owner-1');
  await sync.poll();
  assert.equal(created.length, 1);
  const entity = created[0];

  // Grab with wrench: mark stopped and clear lease
  entity.isWrenchGrabbed = true;
  entity.serverDesiredRunState = 'stopped';
  entity.scriptStatus = 'stopped';
  entity.setPhysicsSimulationEnabled(true);

  // Release grab
  entity.isWrenchGrabbed = false;
  entity.setPhysicsSimulationEnabled(false);

  // Poll arrives with stale server state having desired_run_state 'running'
  actions.length = 0;
  await sync.poll();
  assert.deepEqual(actions, [], 'stale server poll must not restart an entity that was stopped locally');
  assert.equal(entity.scriptStatus, 'stopped');
  assert.equal(entity.isPhysicsSimulationEnabled(), false);
});

test('a snapshot-only server change updates the entity in place instead of rebuilding it', async () => {
  const overrides: Record<string, unknown> = { snapshot_digest: 'a'.repeat(64) };
  const { sync, created, removed, restored } = harness('owner-1', overrides);
  await sync.poll();
  assert.equal(created.length, 1);
  const entity = created[0];
  assert.equal(entity.serverSnapshotDigest, 'a'.repeat(64));

  // The server publishes a new runtime snapshot while the definition is unchanged.
  (sync as any).client.getSnapshot = async () => ({
    position: [5, 40, 6],
    velocity: [1, 0, 0],
    nodes: [],
    bodies: [],
  });
  overrides.snapshot_digest = 'b'.repeat(64);
  await sync.poll();

  assert.equal(removed.length, 0, 'a snapshot-only change must not remove the entity');
  assert.equal(created.length, 1, 'the entity must not be rebuilt');
  assert.equal(restored.length, 1, 'the runtime snapshot must be applied in place');
  assert.deepEqual(restored[0].state.position, [5, 40, 6]);
  assert.equal(entity.serverSnapshotDigest, 'b'.repeat(64), 'the local digest must advance to the server one');
  assert.equal(entity.position.y, 40, 'the runtime pose is applied without a rebuild');
});
