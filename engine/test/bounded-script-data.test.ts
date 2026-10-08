import test from 'node:test';
import assert from 'node:assert/strict';
import { copyScriptData, validateScriptData, validateScriptDataWrite,
  SCRIPT_DATA_LIMIT_BYTES, ScriptBudgetError } from '../src/scripting/BoundedScriptData.ts';

test('write validation preserves exact byte limits without mutating the original record', () => {
  const exact = 'x'.repeat((SCRIPT_DATA_LIMIT_BYTES - 10) / 2); // root + key "a" + UTF-16 value
  const target = { a: exact };
  assert.doesNotThrow(() => validateScriptData(target));
  assert.doesNotThrow(() => validateScriptDataWrite(target, 'a', exact));
  assert.throws(() => validateScriptDataWrite(target, 'a', exact + 'x'), ScriptBudgetError);
  assert.throws(() => validateScriptDataWrite(target, 'b', 0), ScriptBudgetError);
  assert.equal(target.a, exact);
  assert.deepEqual(Object.keys(target), ['a']);
  // Replacement validates the resulting record, so shrinking an existing
  // value is allowed even when adding a second value of that size is not.
  assert.doesNotThrow(() => validateScriptDataWrite(target, 'a', 0));
});

test('copy-free validation still counts aliased values, nesting and array appends', () => {
  const shared = Array(8191).fill(0);
  assert.throws(() => validateScriptData({ a: shared, b: shared }), /structural limits/);
  assert.throws(() => validateScriptDataWrite({ a: shared }, 'b', shared), /structural limits/);
  const array = Array(16383).fill(0);
  assert.doesNotThrow(() => validateScriptDataWrite(array, '0', 1));
  assert.throws(() => validateScriptDataWrite(array, '16383', 1), /structural limits/);
  let nested: unknown = 0;
  for (let i = 0; i < 32; i++) nested = { child: nested };
  assert.doesNotThrow(() => validateScriptData(nested));
  assert.throws(() => validateScriptDataWrite({}, 'nested', nested), /structural limits/);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => validateScriptData(cycle), /structural limits/);
});

test('validation rejects reserved keys and capabilities; copying retains isolation and normalization', () => {
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    assert.throws(() => validateScriptDataWrite({}, key, 1), /Reserved/);
    const value = Object.fromEntries([[key, 1]]);
    assert.throws(() => validateScriptData(value), /Reserved/);
    assert.throws(() => copyScriptData(value), /Reserved/);
  }
  assert.throws(() => validateScriptDataWrite({}, 'call', () => 1), /Only JSON data/);
  const original = { nested: { a: 1 }, values: [NaN, Infinity, undefined] };
  const copy = copyScriptData(original);
  assert.equal(Object.getPrototypeOf(copy), null);
  assert.notEqual(copy.nested, original.nested);
  copy.nested.a = 2;
  assert.equal(original.nested.a, 1);
  assert.deepEqual(copy.values, [null, null, null]);
  assert.doesNotThrow(() => validateScriptData(original));
});
