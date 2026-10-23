import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuTimestampSpan } from '../src/dev/GpuTimestampSpan.ts';

test('overlapping GPU passes do not inflate elapsed frame time', () => {
  const offset = 1234567890123456n;
  const times = new BigUint64Array([0n, 3000000n, 500000n, 3200000n, 3200000n, 4500000n].map(v => offset + v));
  assert.deepEqual(gpuTimestampSpan(times), { spanMs: 4.5, passSumMs: 7, passCount: 3 });
});
test('GPU span handles gaps, unordered passes, quantized zeros and absent samples', () => {
  assert.deepEqual(gpuTimestampSpan(new BigUint64Array([7000000n, 7000000n, 1000000n, 2000000n])),
    { spanMs: 6, passSumMs: 1, passCount: 2 });
  assert.equal(gpuTimestampSpan(new BigUint64Array()), null);
  assert.throws(() => gpuTimestampSpan(new BigUint64Array([1n])));
  assert.throws(() => gpuTimestampSpan(new BigUint64Array([2n, 1n])));
});
