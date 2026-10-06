import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameSamples, interceptMethod, withHiddenObjects } from '../src/dev/FrameDiagnostics.ts';

test('frame samples are bounded, ignore invalid input and reset between comparisons', () => {
  const samples = new FrameSamples(4);
  for (const value of [100, 4, 1, 3, 2, NaN, Infinity]) samples.add(value);
  assert.deepEqual(samples.summary(), { count: 4, mean: 2.5, p50: 3, p95: 4 });
  samples.clear();
  assert.deepEqual(samples.summary(), { count: 0, mean: 0, p50: 0, p95: 0 });
});

test('method instrumentation preserves receiver, return values and inherited ownership', () => {
  const prototype = { work(this: { offset: number }, n: number): number { return this.offset + n; } };
  const target = Object.assign(Object.create(prototype), { offset: 4 });
  let calls = 0;
  const restore = interceptMethod(target, 'work', (original, args) => { calls++; return original(...args); });
  assert.equal(target.work(2), 6);
  assert.equal(calls, 1);
  restore(); restore();
  assert.equal(Object.hasOwn(target, 'work'), false);
  assert.equal(target.work, prototype.work);
});

test('nested instrumentation restores in reverse order without clobbering newer wrappers', () => {
  const target = { work() { return 3; } }, original = target.work;
  const first = interceptMethod(target, 'work', fn => fn() + 1);
  const second = interceptMethod(target, 'work', fn => fn() * 2);
  assert.equal(target.work(), 8);
  first();
  assert.equal(target.work(), 8);
  second(); first();
  assert.equal(target.work, original);
});

test('render isolation restores visibility after exceptions and duplicate objects', () => {
  const visible = { visible: true }, hidden = { visible: false };
  assert.throws(() => withHiddenObjects([visible, hidden, visible, undefined], () => {
    assert.equal(visible.visible, false);
    throw new Error('draw failed');
  }), /draw failed/);
  assert.equal(visible.visible, true);
  assert.equal(hidden.visible, false);
});
