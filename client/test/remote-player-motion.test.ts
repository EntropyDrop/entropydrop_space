import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateRemotePlayerMotion,
  remoteMotionFreshness,
} from '../src/engine/render/RemotePlayerMotion.ts';

const at = (milliseconds: number) => new Date(1_700_000_000_000 + milliseconds).toISOString();

test('remote walking velocity uses network sample time rather than render-frame time', () => {
  const motion = estimateRemotePlayerMotion(
    { x: 10, y: 20, z: 10, updatedAt: at(0) },
    { x: 11.5, y: 20, z: 10, updatedAt: at(300) },
    3200,
    800,
  );

  assert.ok(motion);
  assert.equal(motion.intervalSeconds, 0.3);
  assert.equal(motion.vx, 5);
  assert.equal(motion.horizontalSpeed, 5);
  assert.notEqual(motion.horizontalSpeed, 1.5 / (1 / 60));
});

test('remote velocity follows the shortest path across torus seams', () => {
  const motion = estimateRemotePlayerMotion(
    { x: 3199, y: 20, z: 799, updatedAt: at(0) },
    { x: 0.5, y: 20.6, z: 0.5, updatedAt: at(300) },
    3200,
    800,
  );

  assert.ok(motion);
  assert.equal(motion.vx, 5);
  assert.equal(motion.vz, 5);
  assert.ok(Math.abs(motion.vy - 2) < 1e-9);
});

test('remote velocity falls back to receipt time, clamps teleports, and expires', () => {
  const motion = estimateRemotePlayerMotion(
    { x: 0, y: 0, z: 0, updatedAt: null },
    { x: 100, y: 100, z: 0, updatedAt: null },
    3200,
    800,
    0.3,
  );

  assert.ok(motion);
  assert.equal(motion.horizontalSpeed, 30);
  assert.equal(motion.vy, 30);
  assert.equal(remoteMotionFreshness(0.75), 1);
  assert.ok(remoteMotionFreshness(0.9) > 0 && remoteMotionFreshness(0.9) < 1);
  assert.equal(remoteMotionFreshness(1.2), 0);
});
