import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SpaceEntitySync } from '../src/engine/network/SpaceEntitySync.ts';
import { hostingList, hostingStatus } from './hosting-fixtures.ts';


const definition = Uint8Array.from([8, 4, 26, 0]);
const definitionDigest = '0caed08c0cdfe078464c77fbc4032b985d9757db85e8fac65733d57ee7fb5917';

function aoiUnloadHarness() {
  const entity = { ...record(), desired_run_state: 'stopped' };
  const dormant = new Set([entity.id]);
  const removed: string[] = [];
  const radii: number[] = [];
  const state = { player: { x: 1, z: 2 }, visible: true, truncated: false };
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
    fetchImpl: (async (url, options) => {
      assert.equal(options?.method || 'GET', 'GET', 'AOI polling must not start execution');
      const query = new URL(String(url)).searchParams;
      radii.push(Number(query.get('radius_cm')));
      return new Response(JSON.stringify({ items: state.visible ? [entity] : [], truncated: state.truncated, limit: 256 }));
    }) as typeof fetch,
  });
  return { sync, state, dormant, removed, radii, id: entity.id };
}

test('AOI exit unloads the full entity without retaining a render proxy', async () => {
  const { sync, state, dormant, removed, radii, id } = aoiUnloadHarness();
  await sync.poll();
  state.visible = false;
  state.player.x = 401;
  await sync.poll();
  await sync.poll();
  assert.equal(dormant.has(id), false);
  assert.deepEqual(removed, [id]);
  assert.ok(radii.every(radius => radius === 16000), 'entity loading stays bounded to the detailed AOI');
});

test('a truncated AOI response does not unload an entity until a complete response confirms absence', async () => {
  const { sync, state, dormant, removed, id } = aoiUnloadHarness();
  await sync.poll();
  state.visible = false;
  state.player.x = 401;
  state.truncated = true;
  await sync.poll();
  assert.equal(dormant.has(id), true);
  assert.deepEqual(removed, []);
  state.truncated = false;
  await sync.poll();
  assert.equal(dormant.has(id), false);
  assert.deepEqual(removed, [id]);
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
          executor_name: currentUserId === 'owner-1' ? overrides.owner_name || 'Alice' : 'Bob',
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

test('the holder lease runs one browser entity at its exact quarter-turn construction origin', async () => {
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

test('a non-author endpoint may claim available running intent and displays its own executor name', async () => {
  const { sync, created } = harness('operator-2', { owner_name: 'Alice', can_edit: true, execution_epoch: 0 });
  await sync.poll();
  assert.equal(created[0].serverOwnerUserId, 'owner-1');
  assert.equal(created[0].serverOwnerName, 'Alice');
  assert.equal(created[0].serverExecutorName, 'Bob');
  assert.equal(created[0].serverExecutesLocally, true);
  assert.equal(created[0].serverCanControl, true);
  assert.equal(created[0].serverCanEdit, true);
  assert.equal(created[0].isPhysicsSimulationEnabled(), true);
});

test('a non-author may edit a stopped entity and Start claims its own endpoint atomically', async () => {
  const { sync, created } = harness('operator-2', { owner_name: 'Alice', desired_run_state: 'stopped',
    execution_epoch: 1, can_edit: true });
  await sync.poll();
  const target = created[0];
  assert.equal(target.serverCanEdit, true);
  assert.equal(target.serverCanControl, true);
  assert.equal(target.serverExecutesLocally, false);
  const client = (sync as any).client;
  client.claimExecutionLeases = async () => { throw new Error('atomic Start must not claim twice'); };
  client.setRunState = async (id, state, revision, instance) => {
    assert.equal(id, record().id);
    assert.equal(state, 'running');
    assert.equal(revision, 1);
    assert.equal(instance, (sync as any).instanceId, 'not gated on creator identity');
    return { ...record(), owner_name: 'Alice', executor_name: 'Bob', execution_user_id: 'operator-2',
      execution_epoch: 2, can_edit: true, revision: 2,
      execution_lease_expires_at: new Date(Date.now() + 8_000).toISOString() };
  };
  await (sync as any).setRunState(target, 'running');
  assert.equal(target.serverExecutesLocally, true);
  assert.equal(target.serverOwnerUserId, 'owner-1');
  assert.equal(target.serverExecutorName, 'Bob');
  assert.equal(target.isPhysicsSimulationEnabled(), true);
});

test('executor identity and lease expiry reach active mirrors and are excluded from authored snapshot uploads', async () => {
  const expiry = new Date(Date.now() + 12_000).toISOString();
  const { sync, created } = harness('other', { owner_name: 'Alice', executor_name: 'Alice', execution_lease_expires_at: expiry });
  await sync.poll();
  assert.equal(created[0].serverOwnerName, 'Alice');
  assert.equal(created[0].serverExecutorName, 'Alice');
  assert.equal(created[0].serverExecutionLeaseExpiresAt, expiry);
  const payload = (sync as any).snapshotPayload({ ...created[0], position: [1, 2, 3] });
  for (const key of ['serverOwnerName', 'serverExecutorName', 'serverExecutionLeaseExpiresAt']) assert.equal(key in payload.snapshot, false);
  const local = harness('owner-1', { owner_name: 'Alice' });
  await local.sync.poll();
  assert.equal(local.created[0].serverExecutorName, 'Alice', 'a freshly claimed lease uses the verified executor name immediately');
  assert.ok(Date.parse(local.created[0].serverExecutionLeaseExpiresAt) > Date.now());
});

test('menu deletion surfaces errors, releases pending-deletion suppression, and permits retry', async () => {
  const { sync } = harness('owner-1');
  let attempts = 0;
  (sync as any).client.delete = async () => { if (++attempts === 1) throw new Error('offline'); };
  const id = record().id;
  await assert.rejects(() => (sync as any).queueDelete(id, true), /offline/);
  assert.equal((sync as any).pendingDeletes.has(id), false);
  assert.equal((sync as any).deletedEntityIds.has(id), false);
  await (sync as any).queueDelete(id, true);
  assert.equal(attempts, 2);
  assert.equal((sync as any).deletedEntityIds.has(id), true);
});

test('successful deletion rejects stale AOI records and in-flight definition downloads instead of resurrecting entities', async () => {
  const { sync, created } = harness('owner-1');
  let release: (bytes: Uint8Array) => void;
  (sync as any).client.getDefinition = () => new Promise(resolve => { release = resolve; });
  (sync as any).client.delete = async () => {};
  const entity = record();
  const pendingLoad = (sync as any).applyRecord(entity);
  await (sync as any).queueDelete(entity.id, true);
  release!(definition);
  await pendingLoad;
  assert.equal(created.length, 0);
  await (sync as any).applyRecord(entity);
  assert.equal(created.length, 0);
});

test('Stop waits for backend acknowledgement and failed control preserves the current live lease and intent', async () => {
  const { sync, created } = harness('owner-1', { can_edit: true });
  await sync.poll();
  const target = created[0];
  const expiry = (sync as any).leasedUntil.get(target.publicId);
  let reject: (error: Error) => void;
  (sync as any).client.setRunState = () => new Promise((_resolve, fail) => { reject = fail; });
  const request = (sync as any).setRunState(target, 'stopped');
  assert.equal(target.serverDesiredRunState, 'running');
  assert.equal((sync as any).leasedUntil.get(target.publicId), expiry);
  assert.equal(target.isPhysicsSimulationEnabled(), true);
  reject!(new Error('offline'));
  await assert.rejects(() => request, /offline/);
  assert.equal(target.serverDesiredRunState, 'running');
  assert.equal((sync as any).leasedUntil.get(target.publicId), expiry);
});

test('an obsolete Stop reply cannot delete a newer Start execution lease', async () => {
  const { sync, created } = harness('owner-1', { can_edit: true });
  await sync.poll();
  const target = created[0];
  const expiry = (sync as any).leasedUntil.get(target.publicId);
  (sync as any).latestRevisions.set(target.publicId, 3);
  (sync as any).client.setRunState = async () => ({ ...record(), revision: 2, desired_run_state: 'stopped' });
  await (sync as any).setRunState(target, 'stopped');
  assert.equal(target.serverDesiredRunState, 'running');
  assert.equal((sync as any).leasedUntil.get(target.publicId), expiry);
});

test('another endpoint keeps an occupied entity in stopped collision state', async () => {
  const { sync, created, actions } = harness('observer-1', {
    execution_user_id: 'owner-1', execution_lease_expires_at: new Date(Date.now() + 8_000).toISOString(),
  });

  await sync.poll();

  assert.equal(created[0].serverExecutesLocally, false);
  assert.equal(created[0].isPhysicsSimulationEnabled(), false);
  assert.deepEqual(actions, [], 'a replica freezes execution without resetting the received child/runtime pose');
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

test('confirmed hosting hands off only our own live executor after acknowledged Stop with its new epoch', async () => {
  const { sync, created } = harness('owner-1', { can_edit: true, execution_epoch: 1 });
  await sync.poll();
  const entity = created[0];
  const calls: string[] = [];
  const client = (sync as any).client;
  client.setRunState = async (_id, state) => {
    calls.push(`browser ${state}`);
    return { ...record(), revision: 2, desired_run_state: 'stopped', execution_epoch: 2 };
  };
  client.setHosting = async (id, enabled, budget, _operation, epoch) => {
    calls.push('hosting');
    assert.equal(entity.serverDesiredRunState, 'stopped');
    assert.equal(epoch, 2);
    assert.equal(budget, 3);
    assert.equal(enabled, true);
    return hostingStatus({ execution_epoch: 3, budget_remaining_credits: 3 });
  };
  client.get = async () => ({ ...record(), revision: 3, execution_epoch: 3, execution_mode: 'hosted',
    hosting_enabled: true, hosting_core_id: 0, can_manage_hosting: true, can_control: false, can_edit: false });
  client.listHosting = async () => hostingList();
  await sync.hostEntity(entity, 3);
  assert.deepEqual(calls, ['browser stopped', 'hosting']);
  assert.equal(entity.serverExecutionMode, 'hosted');
  assert.equal(entity.serverHostingCoreId, 0);
  assert.equal(entity.serverCanManageHosting, true);
  assert.equal(entity.serverExecutesLocally, false);
  assert.equal(entity.isPhysicsSimulationEnabled(), false);
});

test('hosting cannot auto-Stop another endpoint or an entity that has not finished saving', async () => {
  const { sync, created } = harness('observer-1', { execution_user_id: 'owner-1',
    execution_lease_expires_at: new Date(Date.now() + 8_000).toISOString() });
  await sync.poll();
  (sync as any).client.setHosting = () => { throw new Error('hosting request must not be made'); };
  (sync as any).client.setRunState = () => { throw new Error('foreign executor must not be stopped'); };
  await assert.rejects(sync.hostEntity(created[0], 1), /occupied/);
  await assert.rejects(sync.hostEntity({ publicId: 'unsaved' }, 1), /finished saving/);
});

test('off-AOI early Stop uses fresh execution epoch and paid success survives later metadata failure', async () => {
  const { sync } = harness('owner-1');
  const client = (sync as any).client;
  client.getHosting = async () => hostingStatus({ execution_epoch: 7 });
  client.setHosting = async (id, enabled, budget, _operation, epoch) => {
    assert.equal(id, 'outside-aoi');
    assert.equal(enabled, false);
    assert.equal(budget, 0);
    assert.equal(epoch, 7);
    return hostingStatus({ entity_id: id, enabled: false, state: 'paused', execution_mode: 'browser', core_id: null });
  };
  client.get = async () => { throw new Error('metadata offline'); };
  client.listHosting = async () => { throw new Error('list offline'); };
  assert.equal((await sync.stopHosting('outside-aoi')).enabled, false);
});

test('hosting list polling is AOI-independent, coalesces requests, reports failures and stops publishing after teardown', async () => {
  let complete!: (value: any) => void;
  let requests = 0, updates = 0, errors = 0;
  const sync = new SpaceEntitySync({ apiOrigin: 'https://api.test', token: 'token', worldId: 'world-1', currentUserId: 'one',
    controller: {}, world: {}, contraptions: { contraptions: [] }, getPlayerPosition: () => ({ x: 1, z: 2 }),
    onHostingUpdate: () => { updates++; }, onHostingError: () => { errors++; } });
  (sync as any).client.listHosting = () => { requests++; return new Promise(resolve => { complete = resolve; }); };
  const first = sync.pollHosting();
  assert.equal(sync.pollHosting(), first);
  complete(hostingList());
  await first;
  assert.equal(requests, 1);
  assert.equal(updates, 1);
  (sync as any).client.listHosting = async () => { throw new Error('unavailable'); };
  await assert.rejects(sync.pollHosting(), /unavailable/);
  assert.equal(errors, 1);
  (sync as any).client.listHosting = () => new Promise(resolve => { complete = resolve; });
  const late = sync.pollHosting();
  sync.stop();
  complete(hostingList());
  await late;
  assert.equal(updates, 1);
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
  const overrides: Record<string, unknown> = { snapshot_digest: 'a'.repeat(64),
    execution_user_id: 'owner-1', execution_lease_expires_at: new Date(Date.now() + 8_000).toISOString() };
  const { sync, created, removed, restored } = harness('observer', overrides);
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

function savedRecord(entity: any) {
  return { publicId: entity.publicId, slot: {}, serverManaged: true, serverCanEdit: true,
    serverDesiredRunState: entity.serverDesiredRunState, serverRevision: entity.serverRevision,
    serverDefinitionDigest: definitionDigest, position: [1, 32, 2],
    physicsSimulationEnabled: entity.isPhysicsSimulationEnabled(), scriptStatus: entity.scriptStatus };
}

test('browser Start uses the atomically granted epoch without a second claim request', async () => {
  const { sync, created } = harness('owner-1', { desired_run_state: 'stopped', can_edit: true, execution_epoch: 1 });
  await sync.poll();
  const target = created[0];
  let requestedInstance: string | undefined;
  (sync as any).client.claimExecutionLeases = async () => { throw new Error('Start must not make a second claim'); };
  (sync as any).client.setRunState = async (_id, state, _revision, instance) => {
    assert.equal(state, 'running'); requestedInstance = instance;
    return { ...record(), can_edit: true, revision: 2, execution_epoch: 2,
      execution_lease_expires_at: new Date(Date.now() + 8000).toISOString() };
  };
  await (sync as any).setRunState(target, 'running');
  assert.equal(requestedInstance, (sync as any).instanceId);
  assert.equal((sync as any).executionEpochs.get(target.publicId), 2);
  assert.equal(target.serverExecutesLocally, true);
});

test('another tab of the same author account is read-only while a live endpoint occupies the entity', async () => {
  const { sync, created } = harness('owner-1', { can_edit: true, execution_epoch: 2,
    execution_lease_expires_at: new Date(Date.now() + 8000).toISOString() });
  (sync as any).client.claimExecutionLeases = async () => [{ entity_id: record().id, granted: false,
    execution_epoch: 0, lease_expires_at: null }];
  await sync.poll();
  assert.equal(created[0].serverExecutesLocally, false);
  assert.equal(created[0].serverCanEdit, false);
  assert.equal(created[0].serverCanControl, false);
});

test('live pose takeover freezes the old executor and fences delayed older lease grants', async () => {
  const { sync, created } = harness('owner-1', { can_edit: true, execution_epoch: 1 });
  await sync.poll();
  const entity = created[0];
  (sync as any).contraptions.findActiveContraptionByPublicId = () => entity;
  sync.receivePose({ entity_id: entity.publicId, execution_epoch: 2, sequence: 1,
    revision: entity.serverRevision, definition_digest: entity.serverDefinitionDigest,
    lease_expires_at: new Date(Date.now() + 8000).toISOString(), bodies: [{ id: 'root',
      position: [1, 32, 2], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] }] });
  assert.equal(entity.serverExecutesLocally, false);
  assert.equal(entity.isPhysicsSimulationEnabled(), false);
  assert.equal(entity.serverCanControl, false);
  (sync as any).acceptLeases([{ entity_id: entity.publicId, granted: true, execution_epoch: 1,
    lease_expires_at: new Date(Date.now() + 8000).toISOString() }], Date.now());
  assert.equal((sync as any).leasedUntil.has(entity.publicId), false);
});

test('an executor checkpoint echo updates metadata without overwriting its current simulated pose', async () => {
  const overrides = { snapshot_digest: 'a'.repeat(64) };
  const { sync, created, restored } = harness('owner-1', overrides);
  await sync.poll();
  created[0].position.set(9, 40, 10);
  overrides.snapshot_digest = 'b'.repeat(64);
  (sync as any).client.getSnapshot = async () => ({ position: [1, 32, 2] });
  await sync.poll();
  assert.equal(restored.length, 0);
  assert.deepEqual(created[0].position.toArray(), [9, 40, 10]);
});

test('an owner replica without a lease cannot autosave a stopped pose over a running entity', async t => {
  const { sync, created } = harness('owner-1');
  t.after(() => sync.stop());
  await sync.poll();
  const internal = sync as any;
  internal.leasedUntil.clear();
  sync.enforceExecutionLeases();
  let writes = 0;
  internal.client.checkpointBrowser = async () => { writes++; return record(); };
  internal.controller.encodeInventoryItem = () => definition;
  await internal.persistRecord(savedRecord(created[0]), false);
  assert.equal(writes, 0);
  assert.equal(created[0].serverDesiredRunState, 'running');
});

test('a leased executor can publish a script stop with its epoch, while stopped construction edits remain writable', async t => {
  const { sync, created } = harness('owner-1');
  t.after(() => sync.stop());
  await sync.poll();
  const internal = sync as any;
  internal.contraptions.findActiveContraptionByPublicId = () => created[0];
  internal.controller.encodeInventoryItem = () => definition;
  created[0].setPhysicsSimulationEnabled(false); // the script stopped itself
  const writes: any[] = [];
  internal.client.checkpointBrowser = async (_id, _revision, payload) => {
    writes.push(payload);
    return { ...record(), revision: 2, desired_run_state: 'stopped' };
  };
  await internal.persistRecord(savedRecord(created[0]), false);
  assert.equal(writes[0].desired_run_state, 'stopped');
  assert.equal(writes[0].execution_instance_id, internal.instanceId);
  assert.equal(writes[0].execution_epoch, 1);
  internal.leasedUntil.clear();
  const edited = { ...savedRecord(created[0]), position: [1, 33, 2] };
  await internal.persistRecord(edited, true);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].execution_instance_id, undefined);
});

test('a hanging list request cannot extend execution past the lease deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  const { sync, created, actions } = harness('owner-1');
  t.after(() => sync.stop());
  await sync.poll();
  (sync as any).client.list = () => new Promise(() => {});
  void sync.poll();
  const position = created[0].position.clone();
  t.mock.timers.tick(8_001);
  assert.equal(created[0].serverExecutesLocally, false);
  assert.equal(created[0].scriptStatus, 'stopped');
  assert.equal(created[0].isPhysicsSimulationEnabled(), false);
  assert.deepEqual(created[0].position, position);
  assert.deepEqual(actions, [], 'lease expiry freezes without resetting the construction');
});

test('a newly adopted entity waits for its first lease without disabling stopped wrench edits', async t => {
  const { sync, created } = harness('owner-1');
  t.after(() => sync.stop());
  await sync.poll();
  const internal = sync as any;
  internal.leasedUntil.clear();
  internal.contraptions.findActiveContraptionByPublicId = () => created[0];
  const entity = created[0];
  const position = entity.position.clone();
  internal.adoptServerIdentity(entity.publicId, record());
  assert.equal(entity.serverExecutesLocally, false);
  assert.equal(entity.isPhysicsSimulationEnabled(), false);
  assert.deepEqual(entity.position, position);

  entity.serverDesiredRunState = 'stopped';
  entity.isWrenchGrabbed = true;
  entity.setPhysicsSimulationEnabled(true);
  sync.enforceExecutionLeases();
  assert.equal(entity.isPhysicsSimulationEnabled(), true, 'stopped construction editing needs no execution lease');
});

test('stale polls cannot downgrade acknowledged revisions or replace newer definitions', async t => {
  const { sync, created, removed, overrides } = harness('owner-1');
  t.after(() => sync.stop());
  await sync.poll();
  (sync as any).applyServerMetadata(record().id, { ...record(), revision: 3 });
  // The harness looks up active instances through the same array fallback as poll.
  created[0].serverRevision = 3;
  overrides.revision = 2;
  overrides.definition_digest = 'a'.repeat(64);
  await sync.poll();
  assert.equal(created[0].serverRevision, 3);
  assert.equal(removed.length, 0);
});

test('snapshot downloads recheck revision after a newer checkpoint is acknowledged', async t => {
  const { sync, created, restored, overrides } = harness('owner-1');
  t.after(() => sync.stop());
  await sync.poll();
  const internal = sync as any;
  internal.contraptions.findActiveContraptionByPublicId = () => created[0];
  let complete!: (value: any) => void;
  let downloading!: () => void;
  const started = new Promise<void>(resolve => { downloading = resolve; });
  internal.client.getSnapshot = () => { downloading(); return new Promise(resolve => { complete = resolve; }); };
  overrides.revision = 2;
  overrides.snapshot_digest = 'b'.repeat(64);
  const pending = sync.poll();
  await started;
  internal.applyServerMetadata(record().id, { ...record(), revision: 3, snapshot_digest: 'c'.repeat(64) });
  complete({ position: [999, 32, 2] });
  await pending;
  assert.equal(restored.length, 0);
  assert.equal(created[0].serverRevision, 3);
  assert.equal(created[0].serverSnapshotDigest, 'c'.repeat(64));
});

test('failed definition downloads retain the existing entity and its local edits', async t => {
  const { sync, created, removed, overrides } = harness('owner-1');
  t.after(() => sync.stop());
  await sync.poll();
  created[0].position.y = 45;
  overrides.revision = 2;
  overrides.definition_digest = 'b'.repeat(64);
  (sync as any).client.getDefinition = async () => { throw new Error('temporarily unavailable'); };
  await sync.poll();
  assert.equal(removed.length, 0);
  assert.equal(created.length, 1);
  assert.equal(created[0].position.y, 45);
});
