import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '../src/contraption/Contraption.ts';

const jsonCopy = (value: unknown) => JSON.parse(JSON.stringify(value));

test('physics contacts are recorded exactly as their JSON-normalized copy', () => {
  const entity = new Contraption('contacts', [{ localX: 0, localY: 0, localZ: 0, block: 1 }], new THREE.Vector3(), new THREE.Scene());
  const source: Record<string, unknown> = {
    kind: 'entity', selfNodeId: 'root', otherEntityId: 'other', otherNodeId: undefined, playerId: null,
    position: [1.234, -0, 3], normal: [0, Number.NaN, -1], relativeVelocity: [Infinity, -Infinity, 0.5],
    penetration: -0, impulse: Number.NaN, sleeping: true, ignored: () => 1,
  };
  assert.equal(entity.recordScriptContact(source), true);
  const recorded = entity.pendingScriptContacts.at(-1)!;
  assert.ok(Object.isFrozen(recorded));
  const { key, ...rest } = recorded;
  assert.deepEqual(rest, jsonCopy(source));
  assert.deepEqual(Object.keys(rest), Object.keys(jsonCopy(source)));
  assert.equal(key, 'entity|root|other|||1.23|0.00|3.00|0.00|0.00|-1.00');
  // Unusual shapes keep the exact general-purpose copy.
  const nested = { kind: 'terrain', position: [1, 2, 3], detail: { a: [1, null], at: new Date(0) } };
  entity.recordScriptContact(nested as never);
  const { key: _nestedKey, ...nestedCopy } = entity.pendingScriptContacts.at(-1)!;
  assert.deepEqual(nestedCopy, jsonCopy(nested));
  // Re-recording the same observation replaces it instead of growing the list.
  entity.recordScriptContact(source);
  assert.equal(entity.pendingScriptContacts.filter(contact => contact.key === key).length, 1);
  entity.dispose();
});
