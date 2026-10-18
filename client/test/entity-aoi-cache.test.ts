import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { SpaceEntitySync } from '../src/engine/network/SpaceEntitySync.ts';

function harness() {
  const scene = new THREE.Scene();
  const world = { renderDistance: 8, activeChunkKeys: new Set(['0,0']) };
  const manager = new ContraptionManager(scene, world as any, null, null);
  manager.entityPersistenceMode = 'none';
  const original = new Contraption(1,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(1, 32, 2), scene, { rootComponentId: 'root' });
  manager.registerContraption(original);
  original.scriptStatus = 'stopped';
  original.setPhysicsSimulationEnabled(false);
  const slot = original.serializeSubtree('root');
  const state = { visible: true, player: { x: 1, z: 2 }, downloads: 0, failDownload: false,
    record: { id: original.publicId, world_id: 'world', owner_user_id: 'owner', name: 'Cached entity',
      definition_digest: 'a'.repeat(64), snapshot_digest: null, revision: 1, execution_epoch: 1,
      desired_run_state: 'stopped', can_edit: true, can_control: true,
      position: { x_cm: 100, y_cm: 3200, z_cm: 200 }, yaw_quarter_turns: 0 } };
  const sync = new SpaceEntitySync({ apiOrigin: 'https://api.example.test', token: 'token', worldId: 'world',
    currentUserId: 'observer', world, contraptions: manager, getPlayerPosition: () => state.player,
    controller: { parseInventoryImport: () => ({ ok: true, item: slot }) } });
  const internal = sync as any;
  internal.client.list = async () => ({ items: state.visible ? [structuredClone(state.record)] : [], truncated: false });
  internal.client.getDefinition = async () => {
    state.downloads++;
    if (state.failDownload) throw new Error('download failed');
    return new Uint8Array();
  };
  internal.client.getSnapshot = async () => null;
  Object.assign(original, internal.metadata(state.record), { serverPlaybackRevision: 1 });
  return { scene, manager, original, state, sync, internal, world };
}

test('network AOI exit freezes the visual and unchanged reentry reuses cached structure without downloading', async t => {
  const { scene, manager, original, state, sync } = harness();
  t.after(() => sync.stop());
  await sync.poll();
  state.visible = false;
  state.player.x = 401;
  await sync.poll();
  const proxy = manager.dormantRenderProxies.get(original.publicId)!;
  assert.ok(scene.children.includes(proxy));
  assert.equal(manager.contraptions.length, 0);
  manager.update(1 / 60, null);
  assert.equal(manager.contraptions.length, 0, 'a stale loaded terrain chunk cannot reactivate the cache');
  state.visible = true;
  state.player.x = 1;
  await sync.poll();
  const restored = manager.findActiveContraptionByPublicId(original.publicId)!;
  assert.ok(restored);
  assert.notEqual(restored, original);
  assert.deepEqual(restored.position.toArray(), proxy.position.toArray());
  assert.equal(restored.serverCanEdit, true);
  assert.equal(state.downloads, 0);
  assert.equal(manager.dormantRenderProxies.size, 0);
});

test('changed definitions keep the old visual through a failed download and replace it only after success', async t => {
  const { scene, manager, original, state, sync } = harness();
  t.after(() => sync.stop());
  await sync.poll();
  state.visible = false;
  state.player.x = 401;
  await sync.poll();
  const proxy = manager.dormantRenderProxies.get(original.publicId)!;
  state.visible = true;
  state.player.x = 1;
  state.record.revision++;
  state.record.definition_digest = 'b'.repeat(64);
  state.failDownload = true;
  await sync.poll();
  assert.equal(manager.contraptions.length, 0);
  assert.ok(scene.children.includes(proxy));
  state.failDownload = false;
  await sync.poll();
  const restored = manager.findActiveContraptionByPublicId(original.publicId)!;
  assert.equal(restored.serverDefinitionDigest, state.record.definition_digest);
  assert.equal(state.downloads, 2);
  assert.equal(manager.dormantRenderProxies.size, 0);
  assert.equal(scene.children.includes(proxy), false);
});

test('fresh placement invalidates a cache even when definition and snapshot digests are unchanged', async t => {
  const { manager, original, state, sync } = harness();
  t.after(() => sync.stop());
  await sync.poll();
  state.visible = false;
  state.player.x = 401;
  await sync.poll();
  state.visible = true;
  state.player.x = 1;
  state.record.position.x_cm = 500;
  state.record.revision++;
  await sync.poll();
  assert.equal(state.downloads, 1);
  assert.equal(manager.findActiveContraptionByPublicId(original.publicId)!.originWorldPos.x, 5);
  assert.equal(manager.dormantRenderProxies.size, 0);
});

test('a delayed realtime metadata reply cannot restore a cache after the player leaves', async t => {
  const { manager, original, state, sync, internal } = harness();
  t.after(() => sync.stop());
  await sync.poll();
  manager.unloadContraption(original, { skipSave: true });
  let resolveMetadata!: (value: unknown) => void;
  internal.client.get = () => new Promise(resolve => { resolveMetadata = resolve; });
  sync.receivePose({ entity_id: original.publicId, execution_epoch: 1, revision: 1, sequence: 1,
    definition_digest: state.record.definition_digest, lease_expires_at: new Date(Date.now() + 8000).toISOString(),
    bodies: [{ id: 'root', position: [1, 32, 2], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] }] });
  state.player.x = 401;
  resolveMetadata(state.record);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(manager.contraptions.length, 0);
  assert.equal(manager.dormantRenderProxies.size, 1);
});

for (const exit of ['network AOI', 'loaded terrain'] as const) {
test(`a definition download completing after exiting ${exit} leaves the cached visual inactive`, async t => {
  const { manager, original, state, sync, internal, world } = harness();
  t.after(() => sync.stop());
  await sync.poll();
  manager.unloadContraption(original, { skipSave: true });
  state.record.definition_digest = 'b'.repeat(64);
  state.record.revision++;
  let completeDownload!: (value: Uint8Array) => void;
  internal.client.getDefinition = () => new Promise(resolve => { completeDownload = resolve; });
  const pending = sync.poll();
  await new Promise<void>(resolve => setImmediate(resolve));
  state.player.x = exit === 'network AOI' ? 401 : 140;
  if (exit === 'loaded terrain') world.activeChunkKeys = new Set(['8,0']);
  completeDownload(new Uint8Array());
  await pending;
  assert.equal(manager.contraptions.length, 0);
  assert.equal(manager.dormantRenderProxies.size, 1);
});
}

test('walking farther keeps the same static proxy while the network AOI still returns changed snapshots', async t => {
  const { manager, original, state, sync, internal, world } = harness();
  t.after(() => sync.stop());
  await sync.poll();
  const snapshot = manager.captureContraptionForStreaming(original, { id: '0,0' });
  state.player.x = 140;
  world.activeChunkKeys = new Set(['8,0']);
  manager.update(1 / 60, null);
  const proxy = manager.dormantRenderProxies.get(original.publicId)!;
  const mesh = original.meshGroup;
  assert.ok(proxy);
  internal.client.getSnapshot = async () => snapshot;
  for (const x of [140, 148, 156]) {
    state.player.x = x;
    Object.assign(state.record, { snapshot_digest: String(x).padStart(64, '0'), revision: state.record.revision + 1 });
    await sync.poll();
    assert.equal(manager.contraptions.length, 0, 'network padding must not reactivate an off-chunk cache');
    manager.update(1 / 60, null);
    assert.equal(manager.dormantRenderProxies.get(original.publicId), proxy);
    assert.equal(proxy.children[0], mesh);
  }
  state.player.x = 180;
  state.visible = false;
  await sync.poll();
  assert.equal(manager.dormantRenderProxies.get(original.publicId), proxy);
  assert.equal(state.downloads, 0, 'walking away must not fetch the entity again');
  state.player.x = 1;
  state.visible = true;
  world.activeChunkKeys = new Set(['0,0']);
  await sync.poll();
  assert.equal(state.downloads, 1, 'returning to the loaded window fetches the latest snapshot');
  assert.equal(manager.dormantRenderProxies.size, 0);
  assert.equal(manager.contraptions.length, 1);
});

test('absence in network padding keeps the frozen visual until its loaded area is revisited', async t => {
  const { manager, original, state, sync, world } = harness();
  t.after(() => sync.stop());
  await sync.poll();
  state.player.x = 140;
  world.activeChunkKeys = new Set(['8,0']);
  manager.update(1 / 60, null);
  const proxy = manager.dormantRenderProxies.get(original.publicId)!;
  state.visible = false;
  await sync.poll();
  assert.equal(manager.dormantRenderProxies.get(original.publicId), proxy);
  state.player.x = 1;
  world.activeChunkKeys = new Set(['0,0']);
  await sync.poll();
  assert.equal(manager.dormantRenderProxies.size, 0);
  assert.equal(state.downloads, 0);
});

test('a cached running entity in network padding does not acquire a browser execution lease', async t => {
  const { manager, state, sync, internal, world } = harness();
  t.after(() => sync.stop());
  await sync.poll();
  state.player.x = 140;
  world.activeChunkKeys = new Set(['8,0']);
  manager.update(1 / 60, null);
  state.record.desired_run_state = 'running';
  let claims = 0;
  internal.client.claimExecutionLeases = async () => { claims++; return []; };
  await sync.poll();
  assert.equal(claims, 0);
  assert.equal(manager.contraptions.length, 0);
  assert.equal(manager.dormantRenderProxies.size, 1);
});

test('an active moving entity can renew execution while its durable position is outside loaded terrain', async t => {
  const { original, state, sync, internal, world } = harness();
  t.after(() => sync.stop());
  await sync.poll();
  state.player.x = original.position.x = 140;
  world.activeChunkKeys = new Set(['8,0']);
  state.record.desired_run_state = 'running';
  let claims = 0;
  internal.client.claimExecutionLeases = async () => { claims++; return []; };
  await sync.poll();
  assert.equal(claims, 1, 'the active simulation can be ahead of its last durable checkpoint');
});
