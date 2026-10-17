import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '../src/contraption/Contraption.ts';
import { normalizeClickedBlock } from '../src/scripting/ClickedBlock.ts';
import { createEntityScriptHost } from '../src/scripting/EntityScriptHost.ts';
import type { ScriptClickedBlock } from '../src/scripting/ScriptProtocol.ts';

function fixture() {
  const entity = new Contraption(1, [{ localX: 0, localY: 0, localZ: 0, block: 1 }],
    new THREE.Vector3(0, 10, 0), new THREE.Scene());
  const click: ScriptClickedBlock = { eventId: 'click-1', entityId: entity.publicId, playerId: 'local',
    nodeId: 'arm', kind: 'decoration', position: [1, 2, 3], size: null, decorationId: 'handle',
    point: [4, 5, 6], localPoint: [1, 2, 3.5] };
  return { entity, click, snapshot: () => entity.buildScriptRuntimeSnapshot(0.05, null, null, 1, 1) as any };
}

test('clicks remain pending until submission, deliver FIFO once, and never leak into messages', () => {
  const { entity, click, snapshot } = fixture();
  assert.equal(entity.enqueueClickedBlock(click), true);
  assert.equal(entity.enqueueClickedBlock(click), false, 'duplicate physical events are ignored');
  assert.equal(entity.enqueueClickedBlock({ ...click, eventId: 'click-2', kind: 'micro', size: 0.125, decorationId: null }), true);
  entity.enqueueEntityMessage({ messageId: 'ordinary', sourceId: 'other', targetId: entity.publicId,
    type: 'clicked_block', encoding: 'utf8', payload: JSON.stringify(click), clickedBlock: click });
  assert.deepEqual(snapshot().clickedBlock, click);
  assert.deepEqual(snapshot().clickedBlock, click, 'building a busy frame does not consume input');
  assert.equal(snapshot().messages.length, 1, 'ordinary messages do not wait behind clicks');
  assert.equal(snapshot().messages[0].clickedBlock, undefined, 'messages cannot impersonate native input');
  entity.clearPendingScriptEvents();
  assert.equal(snapshot().clickedBlock.eventId, 'click-2');
  assert.equal(snapshot().messages.length, 0);
  entity.clearPendingScriptEvents();
  assert.equal(snapshot().clickedBlock, null);
  entity.enqueueClickedBlock({ ...click, eventId: 'click-3' });
  entity.stopAllNodeScripts();
  assert.equal(snapshot().clickedBlock, null, 'Stop clears ephemeral input');
});

test('every component sees the same immutable click for one frame', () => {
  const { click } = fixture();
  const host = createEntityScriptHost(() => null, () => null);
  host.beginTick({ clickedBlock: click });
  const root = host.context('root').clickedBlock;
  assert.equal(root, host.context('arm').clickedBlock);
  assert.notEqual(root, click);
  assert.ok(Object.isFrozen(root));
  assert.throws(() => { (root as ScriptClickedBlock).position[0] = 9; }, TypeError);
  host.beginTick({});
  assert.equal(host.context('root').clickedBlock, null);
  assert.equal((root as ScriptClickedBlock).position[0], 1);
});

test('native clicks validate all voxel kinds, identities, and finite geometry', () => {
  const { entity, click } = fixture();
  for (const size of [1, 0.125]) {
    assert.ok(normalizeClickedBlock({ ...click, kind: size === 1 ? 'standard' : 'micro', size, decorationId: null }));
  }
  for (const fields of [{ point: [NaN, 0, 0] }, { point: [1, 2] }, { kind: 'other' },
    { nodeId: '' }, { decorationId: '' }, { size: 1 }, { localPoint: [Infinity, 0, 0] }]) {
    assert.equal(normalizeClickedBlock({ ...click, ...fields }), null);
  }
  assert.equal(entity.enqueueClickedBlock({ ...click, entityId: 'other' }), false);
  for (let i = 0; i < 70; i++) entity.enqueueClickedBlock({ ...click, eventId: `burst-${i}` });
  assert.equal(entity.pendingClickedBlocks.length, 64);
  assert.equal(entity.pendingClickedBlocks[0].eventId, 'burst-6');
});

test('click deduplication is scoped to the player and resets on Stop', () => {
  const { entity, click, snapshot } = fixture();
  const otherPlayer = { ...click, playerId: 'visitor' };
  assert.equal(entity.enqueueClickedBlock(click), true);
  assert.equal(entity.enqueueClickedBlock(otherPlayer), true);
  assert.equal(entity.enqueueClickedBlock(otherPlayer), false);
  assert.equal(snapshot().clickedBlock.playerId, 'local');
  entity.clearPendingScriptEvents();
  assert.equal(snapshot().clickedBlock.playerId, 'visitor');
  entity.clearPendingScriptEvents();
  assert.equal(entity.enqueueClickedBlock(click), false, 'consumed duplicates remain suppressed');
  entity.stopAllNodeScripts();
  assert.equal(entity.enqueueClickedBlock(click), true);
});

test('clicks and messages have independent overflow and per-frame budgets', () => {
  const { entity, click, snapshot } = fixture();
  const message = (messageId: string) => ({ messageId, sourceId: 'other', targetId: entity.publicId,
    type: 'chat', encoding: 'utf8', payload: 'hello' });
  entity.enqueueEntityMessage(message('first'));
  for (let i = 0; i < 70; i++) entity.enqueueClickedBlock({ ...click, eventId: `click-${i}` });
  assert.equal(entity.pendingEntityMessages[0].messageId, 'first', 'click flood cannot evict messages');
  for (let i = 0; i < 70; i++) entity.enqueueEntityMessage(message(`message-${i}`));
  assert.equal(entity.pendingClickedBlocks[0].eventId, 'click-6', 'message flood cannot evict clicks');
  const frame = snapshot();
  assert.equal(frame.messages.length, 8);
  assert.equal(frame.messages[0].messageId, 'message-6');
  assert.equal(frame.clickedBlock.eventId, 'click-6');
  entity.clearPendingScriptEvents();
  assert.equal(entity.pendingEntityMessages.length, 56);
  assert.equal(entity.pendingClickedBlocks.length, 63);
});

test('click identity lengths use UTF-16 units consistently with the server', () => {
  const { click } = fixture();
  const astral = String.fromCodePoint(0x1F600);
  assert.ok(normalizeClickedBlock({ ...click, nodeId: astral.repeat(64), decorationId: astral.repeat(64) }));
  assert.equal(normalizeClickedBlock({ ...click, nodeId: astral.repeat(65) }), null);
  assert.equal(normalizeClickedBlock({ ...click, decorationId: astral.repeat(65) }), null);
});
