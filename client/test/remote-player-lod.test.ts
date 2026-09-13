import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isProjectedPlayerVisible,
  resolveRemotePlayerLod,
} from '../src/engine/render/RemotePlayerLod.ts';
import { wrappedAxisDelta } from '../src/engine/render/RemotePlayerMotion.ts';

test('remote player distance LOD selects full, simplified, billboard, and hidden modes', () => {
  assert.equal(resolveRemotePlayerLod(10), 'full');
  assert.equal(resolveRemotePlayerLod(40), 'simplified');
  assert.equal(resolveRemotePlayerLod(100), 'billboard');
  assert.equal(resolveRemotePlayerLod(241), 'hidden');
});

test('remote player distance LOD uses hysteresis at every transition', () => {
  assert.equal(resolveRemotePlayerLod(23, 'full'), 'full');
  assert.equal(resolveRemotePlayerLod(25, 'full'), 'simplified');
  assert.equal(resolveRemotePlayerLod(17, 'simplified'), 'simplified');
  assert.equal(resolveRemotePlayerLod(15, 'simplified'), 'full');
  assert.equal(resolveRemotePlayerLod(85, 'simplified'), 'simplified');
  assert.equal(resolveRemotePlayerLod(91, 'simplified'), 'billboard');
  assert.equal(resolveRemotePlayerLod(75, 'billboard'), 'billboard');
  assert.equal(resolveRemotePlayerLod(69, 'billboard'), 'simplified');
  assert.equal(resolveRemotePlayerLod(250, 'billboard'), 'billboard');
  assert.equal(resolveRemotePlayerLod(261, 'billboard'), 'hidden');
  assert.equal(resolveRemotePlayerLod(230, 'hidden'), 'hidden');
  assert.equal(resolveRemotePlayerLod(219, 'hidden'), 'billboard');
});

test('remote player helpers handle torus seams and conservative projected culling', () => {
  assert.equal(wrappedAxisDelta(3195, 5, 3200), 10);
  assert.equal(wrappedAxisDelta(5, 3195, 3200), -10);
  assert.equal(wrappedAxisDelta(5, 6405, 3200), 0);
  assert.equal(isProjectedPlayerVisible({ x: 1.15, y: -1.15, z: 0.5 }), true);
  assert.equal(isProjectedPlayerVisible({ x: 1.3, y: 0, z: 0.5 }), false);
  assert.equal(isProjectedPlayerVisible({ x: 0, y: 0, z: 1.2 }), false);
});
