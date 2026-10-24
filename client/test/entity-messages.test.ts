import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { EntityOutputBuffer } from '@entropydrop/space-engine/contraption/EntityOutput.ts';
import { EntityOutputCollector, filterEntityOutput } from '../src/ui/react/utils/entityOutput.ts';

function entity(id: number, name: string) {
  return new Contraption(id, [{ localX: 0, localY: 0, localZ: 0, block: 1 }], new THREE.Vector3(), new THREE.Scene(), { rootComponentName: name });
}

test('nearby output preserves repeated logs, supports combined filters and clears without replaying old buffers', () => {
  const first = entity(1, 'Sender'), second = entity(2, 'Receiver');
  const collector = new EntityOutputCollector();
  try {
    first.log('same line', 'console', 'root');
    first.log('same line', 'console', 'root');
    second.log('[ERR] Example failure');
    first.recordScriptCommandResult({ scope: 'messages', path: 'send', commandId: 'send-1', nodeId: 'root',
      args: [second.publicId, 'chat', 'Hello', 'utf8'] }, { ok: true, messageId: 'message-1', deliveryStatus: 'routed' });
    second.enqueueEntityMessage({ messageId: 'message-1', sourceId: first.publicId, targetId: second.publicId,
      type: 'chat', encoding: 'utf8', payload: 'Hello' });
    const entries = collector.collect([first, second]);
    assert.equal(entries.length, 4, 'observing both send and receive does not duplicate one message');
    assert.equal(filterEntityOutput(entries, first.publicId, 'console').length, 2);
    assert.equal(filterEntityOutput(entries, first.publicId, 'message:chat')[0].text, 'Hello');
    assert.equal(filterEntityOutput(entries, second.publicId, 'error').length, 1);
    assert.equal(filterEntityOutput(entries, second.publicId, 'console').length, 0);
    assert.equal(collector.collect([first, second]), entries, 'unchanged output retains its snapshot identity');
    assert.deepEqual(collector.clear([first, second]), []);
    assert.deepEqual(collector.collect([first, second]), []);
    first.log('same line', 'console');
    assert.equal(collector.collect([first, second]).length, 1);
    assert.deepEqual(collector.collect([]), [], 'leaving the nearby loaded set removes its output');
  } finally { first.dispose(); second.dispose(); }
});

test('binary messages, rejected sends, invalid input and bounded log history', () => {
  const target = entity(1, 'Target');
  try {
    assert.equal(target.enqueueEntityMessage({ messageId: 'bytes', sourceId: 'sender', targetId: target.publicId,
      type: 'radar.v1', encoding: 'protobuf', payload: [0, 15, 255] }), true);
    assert.equal(target.output.entries.at(-1)?.text, 'Protobuf (3 bytes): 00 0f ff');
    const before = target.output.entries.length;
    assert.equal(target.enqueueEntityMessage({ messageId: 'bad', sourceId: 'sender', targetId: target.publicId,
      type: 'chat', encoding: 'protobuf', payload: [1] }), false);
    assert.equal(target.output.entries.length, before);
    target.recordScriptCommandResult({ scope: 'messages', path: 'send', commandId: 'failed', nodeId: 'root',
      args: ['receiver', 'chat', 'hello', 'utf8'] }, { ok: false, reason: 'source_inactive' });
    assert.equal(target.output.entries.at(-1)?.status, 'source_inactive');
    const collector = new EntityOutputCollector();
    for (let i = 0; i < 5; i++) {
      for (let n = 0; n < 180; n++) target.log('burst', 'console');
      collector.collect([target]);
    }
    assert.equal(target.output.entries.length, 200);
    assert.equal(collector.collect([target]).length, 500);
    const buffer = new EntityOutputBuffer();
    assert.equal(buffer.append({ kind: 'console', text: 'x'.repeat(5000) }).text.length, 4096);
  } finally { target.dispose(); }
});
