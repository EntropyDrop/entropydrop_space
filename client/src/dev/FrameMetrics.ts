/** Callback cadence is not a measurement of compositor presentation. */
export function frameMetrics(intervals: readonly number[]) {
  const valid = intervals.filter(value => Number.isFinite(value) && value > 0);
  if (!valid.length) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const sum = valid.reduce((a, b) => a + b, 0);
  const tail = sorted.slice(-Math.max(1, Math.ceil(sorted.length * .01)));
  const above = (ms: number) => valid.filter(value => value > ms).length;
  return { count: valid.length, elapsedMs: sum, averageFps: valid.length * 1000 / sum,
    onePercentLowFps: 1000 / (tail.reduce((a, b) => a + b, 0) / tail.length),
    p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)],
    p99Ms: sorted[Math.floor(sorted.length * .99)], maxMs: sorted.at(-1)!,
    over16_67ms: above(1000 / 60), over33_33ms: above(1000 / 30), over50ms: above(50),
    over16_67Percent: 100 * above(1000 / 60) / valid.length };
}
