import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveResolutionController } from '../src/engine/render/AdaptiveResolution.ts';

function sampleFrames(
  controller: AdaptiveResolutionController,
  startAt: number,
  count: number,
  frameMs: number,
  visible = true,
) {
  let now = startAt;
  controller.sampleFrame(now, visible);
  for (let index = 0; index < count; index++) {
    now += frameMs;
    controller.sampleFrame(now, visible);
  }
  return now;
}

test('auto resolution quickly reduces drawing-buffer scale under sustained slow frames', () => {
  const controller = new AdaptiveResolutionController();
  sampleFrames(controller, 0, 8, 125);

  assert.equal(controller.currentScale, 0.5);
  assert.equal(controller.getState().mode, 'auto');
});

test('auto resolution ignores isolated long frames and time spent in a hidden tab', () => {
  const controller = new AdaptiveResolutionController();
  let now = sampleFrames(controller, 0, 30, 8.2);
  now = sampleFrames(controller, now, 1, 250);
  now = sampleFrames(controller, now, 60, 8.2);
  controller.sampleFrame(now + 5_000, false);
  sampleFrames(controller, now + 5_000, 60, 8.2);

  assert.equal(controller.currentScale, 1);
});

test('fixed resolution never changes in response to frame cadence', () => {
  const controller = new AdaptiveResolutionController();
  controller.setSetting(0.67);
  sampleFrames(controller, 0, 60, 100);

  assert.deepEqual(controller.getState(), {
    targetFps: 120,
    mode: 'fixed',
    scale: 0.67,
    fixedScale: 0.67,
    averageFrameMs: 1000 / 120,
    effectsQuality: 'full',
  });
});

test('cinematic quality retains its effects at a healthy 60 FPS and still adapts below target', () => {
  const controller = new AdaptiveResolutionController();
  controller.setTargetFps(60);
  let now = sampleFrames(controller, 0, 600, 1000 / 60);
  assert.equal(controller.currentScale, 1);
  assert.equal(controller.getState().effectsQuality, 'full');
  assert.equal(controller.getState().targetFps, 60);
  sampleFrames(controller, now, 500, 40);
  assert.equal(controller.currentScale, 0.5);
  assert.equal(controller.getState().effectsQuality, 'reduced');
  controller.setTargetFps(120);
  assert.equal(controller.getState().targetFps, 120);
  assert.equal(controller.getState().effectsQuality, 'full');
});

test('auto resolution treats a stable sub-120 cadence as too slow', () => {
  const controller = new AdaptiveResolutionController();
  sampleFrames(controller, 0, 100, 12);

  assert.equal(controller.currentScale, 0.8);
});

test('auto resolution cautiously probes one step upward after a long healthy interval', () => {
  const controller = new AdaptiveResolutionController();
  let now = sampleFrames(controller, 0, 60, 16.5);
  const reducedScale = controller.currentScale;
  now = sampleFrames(controller, now, 1_470, 8.2);

  assert.equal(reducedScale, 0.7);
  assert.ok(controller.currentScale > reducedScale);
  assert.equal(controller.currentScale, 0.8);
});

test('auto resolution drops secondary effects only after reaching its scale floor', () => {
  const controller = new AdaptiveResolutionController();
  let now = sampleFrames(controller, 0, 500, 12);

  assert.equal(controller.currentScale, 0.5);
  assert.equal(controller.getState().effectsQuality, 'reduced');

  now = sampleFrames(controller, now, 1_500, 8.2);
  assert.equal(controller.getState().effectsQuality, 'full');
  assert.equal(controller.currentScale, 0.5);
});
