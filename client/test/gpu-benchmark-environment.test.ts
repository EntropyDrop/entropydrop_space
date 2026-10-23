import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkElementVisible, assertGpuBenchmarkEnvironment } from '../src/dev/GpuBenchmarkEnvironment.ts';
import { sceneReplayRoles } from '../src/dev/GpuSceneReplay.ts';

test('GPU guard sees author CSS overriding hidden and rejects a visible start overlay', () => {
  const overlay: any = { hidden: true, parentElement: null };
  const visible = () => ({ display: 'flex', visibility: 'visible', opacity: '1' });
  assert.equal(benchmarkElementVisible(overlay, visible), true);
  assert.equal(benchmarkElementVisible(overlay, () => ({ ...visible(), display: 'none' })), false);
  const parent: any = { parentElement: null };
  overlay.parentElement = parent;
  assert.equal(benchmarkElementVisible(overlay, e => ({ ...visible(), visibility: e === parent ? 'hidden' : 'visible' })), true);
  assert.equal(benchmarkElementVisible(overlay, e => ({ ...visible(), opacity: e === parent ? '0' : '1' })), false);
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      visibilityState: 'visible', querySelector: (selector: string) => selector === '#pause-screen' ? overlay : null,
    } });
    Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: visible });
    assert.throws(assertGpuBenchmarkEnvironment, /Click Play/);
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete (globalThis as any).document;
    if (oldStyle) Object.defineProperty(globalThis, 'getComputedStyle', oldStyle); else delete (globalThis as any).getComputedStyle;
  }
});

test('sham replay keeps two reference and two candidate observations in every quartet', () => {
  const positions = [0, 0, 0, 0];
  for (let batch = 0; batch < 48; batch++) {
    const roles = sceneReplayRoles(batch);
    assert.equal(roles.filter(role => role === 'reference').length, 2);
    assert.equal(roles.filter(role => role === 'candidate').length, 2);
    roles.forEach((role, i) => { if (role === 'candidate') positions[i]++; });
  }
  assert.deepEqual(positions, [24, 24, 24, 24]);
});
