/** Pass intervals can overlap on the tested GPU backend. Their sum is work
 * attribution, not elapsed GPU frame time. Preserve both measurements. */
export function gpuTimestampSpan(times: BigUint64Array) {
  if (!times.length) return null;
  if (times.length % 2) throw new Error('Expected timestamp start/end pairs.');
  let first = times[0], last = times[1], sum = 0n;
  for (let i = 0; i < times.length; i += 2) {
    const start = times[i], end = times[i + 1];
    if (end < start) throw new Error('GPU timestamp interval is reversed.');
    if (start < first) first = start;
    if (end > last) last = end;
    sum += end - start;
  }
  return { spanMs: Number(last - first) / 1e6, passSumMs: Number(sum) / 1e6, passCount: times.length / 2 };
}
