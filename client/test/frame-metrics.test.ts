import test from 'node:test';
import assert from 'node:assert/strict';
import { frameMetrics } from '../src/dev/FrameMetrics.ts';

test('cadence uses total elapsed time rather than the average of instantaneous FPS', () => {
  const result = frameMetrics([10, 30])!;
  assert.equal(result.averageFps, 50);
  assert.equal(result.onePercentLowFps, 1000 / 30);
  assert.equal(result.over16_67Percent, 50);
});

test('one percent low includes the slowest one percent and retains stalls', () => {
  const result = frameMetrics([...Array(198).fill(8), 40, 80])!;
  assert.equal(result.onePercentLowFps, 1000 / 60);
  assert.equal(result.maxMs, 80);
  assert.equal(result.over33_33ms, 2);
  assert.equal(result.over50ms, 1);
});

test('unavailable cadence is not reported as zero FPS', () => {
  assert.equal(frameMetrics([NaN, Infinity, 0, -1]), null);
  assert.equal(frameMetrics([NaN, 10])!.averageFps, 100);
});
