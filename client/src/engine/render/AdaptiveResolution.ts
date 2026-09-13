export const MIN_RESOLUTION_SCALE = 0.5;
export const MAX_RESOLUTION_SCALE = 1;
export const RESOLUTION_SCALE_PRESETS = [1, 0.8, 0.67, 0.5] as const;

const ADAPTIVE_SCALE_STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1] as const;
const TARGET_FRAME_MS = 1000 / 120;
const SLOW_FRAME_MS = 8.8;
const HEALTHY_FRAME_MS = 8.55;
const MIN_VALID_FRAME_MS = 4;
const MAX_VALID_FRAME_MS = 500;
const MAX_SAMPLED_FRAME_MS = 250;
const DOWNSCALE_SAMPLE_COUNT = 6;
const DOWNSCALE_OBSERVATION_MS = 750;
const UPSCALE_SAMPLE_COUNT = 240;
const DOWNSCALE_COOLDOWN_MS = 1_200;
const UPSCALE_COOLDOWN_MS = 12_000;
const FRAME_TIME_WEIGHT = 0.08;
const SLOW_FRAME_WEIGHT = 0.06;

export type ResolutionScaleMode = 'auto' | 'fixed';
export type AdaptiveEffectsQuality = 'full' | 'reduced';

export interface AdaptiveResolutionState {
  targetFps: number;
  mode: ResolutionScaleMode;
  scale: number;
  fixedScale: number;
  averageFrameMs: number;
  effectsQuality: AdaptiveEffectsQuality;
}

function clampScale(value: number): number {
  const finite = Number.isFinite(value) ? value : MAX_RESOLUTION_SCALE;
  return Math.round(Math.max(MIN_RESOLUTION_SCALE, Math.min(MAX_RESOLUTION_SCALE, finite)) * 100) / 100;
}

function lowerAdaptiveStep(current: number, recommended: number): number {
  const ceiling = Math.min(current - 0.001, recommended);
  for (let index = ADAPTIVE_SCALE_STEPS.length - 1; index >= 0; index--) {
    const step = ADAPTIVE_SCALE_STEPS[index];
    if (step <= ceiling) return step;
  }
  return MIN_RESOLUTION_SCALE;
}

function higherAdaptiveStep(current: number): number {
  for (const step of ADAPTIVE_SCALE_STEPS) {
    if (step > current + 0.001) return step;
  }
  return MAX_RESOLUTION_SCALE;
}

/**
 * Chooses a render scale from frame cadence only. The renderer owns applying
 * that scale to its drawing buffer, which keeps this policy deterministic and
 * independently testable without WebGL.
 */
export class AdaptiveResolutionController {
  private mode: ResolutionScaleMode = 'auto';
  private scale = MAX_RESOLUTION_SCALE;
  private fixedScale = MAX_RESOLUTION_SCALE;
  private lastFrameAt: number | null = null;
  private averageFrameMs = TARGET_FRAME_MS;
  private effectsQuality: AdaptiveEffectsQuality = 'full';
  private slowFrameRatio = 0;
  private validSamples = 0;
  private sampledDurationMs = 0;
  private lastAdjustmentAt = -Infinity;
  private targetFps = 120;

  get currentScale(): number {
    return this.scale;
  }

  getState(): AdaptiveResolutionState {
    return {
      targetFps: this.targetFps,
      mode: this.mode,
      scale: this.scale,
      fixedScale: this.fixedScale,
      averageFrameMs: this.averageFrameMs,
      effectsQuality: this.effectsQuality,
    };
  }

  setTargetFps(fps: 60 | 120): void {
    if (fps === this.targetFps) return;
    this.targetFps = fps;
    this.effectsQuality = 'full';
    this.resetMeasurements();
  }

  setSetting(setting: 'auto' | number): number {
    if (setting === 'auto') {
      this.mode = 'auto';
      this.effectsQuality = 'full';
    } else {
      this.mode = 'fixed';
      this.fixedScale = clampScale(Number(setting));
      this.scale = this.fixedScale;
      this.effectsQuality = 'full';
    }
    this.resetMeasurements();
    return this.scale;
  }

  sampleFrame(now: number, visible = true): number {
    if (!Number.isFinite(now)) return this.scale;
    if (!visible) {
      this.resetMeasurements(now);
      return this.scale;
    }

    if (this.lastFrameAt === null) {
      this.lastFrameAt = now;
      return this.scale;
    }

    const frameMs = now - this.lastFrameAt;
    this.lastFrameAt = now;
    if (this.mode !== 'auto' || frameMs < MIN_VALID_FRAME_MS || frameMs > MAX_VALID_FRAME_MS) {
      return this.scale;
    }

    // Keep truly slow visible frames useful to the policy, while limiting how
    // much any one scheduling or GC stall can distort the moving average.
    const sampledFrameMs = Math.min(frameMs, MAX_SAMPLED_FRAME_MS);
    const cadenceRatio = 120 / this.targetFps;
    const slowFrameMs = SLOW_FRAME_MS * cadenceRatio;

    if (this.validSamples === 0) {
      this.averageFrameMs = sampledFrameMs;
      this.slowFrameRatio = sampledFrameMs > slowFrameMs ? 1 : 0;
    } else {
      this.averageFrameMs += (sampledFrameMs - this.averageFrameMs) * FRAME_TIME_WEIGHT;
      const slow = sampledFrameMs > slowFrameMs ? 1 : 0;
      this.slowFrameRatio += (slow - this.slowFrameRatio) * SLOW_FRAME_WEIGHT;
    }
    this.validSamples++;
    this.sampledDurationMs += sampledFrameMs;

    if (
      (this.scale > MIN_RESOLUTION_SCALE || this.effectsQuality === 'full')
      && this.validSamples >= DOWNSCALE_SAMPLE_COUNT
      && this.sampledDurationMs >= DOWNSCALE_OBSERVATION_MS
      && now - this.lastAdjustmentAt >= DOWNSCALE_COOLDOWN_MS
      && this.averageFrameMs > slowFrameMs
      && this.slowFrameRatio > 0.3
    ) {
      if (this.scale > MIN_RESOLUTION_SCALE) {
        // Pixel-bound frame time is approximately proportional to scale squared.
        // Jump near the estimated sustainable level instead of stepping down for
        // several seconds on a clearly underpowered GPU.
        const recommended = this.scale * Math.sqrt((1000 / this.targetFps) / this.averageFrameMs);
        this.scale = lowerAdaptiveStep(this.scale, recommended);
      } else {
        // Resolution is already at its legibility floor. Let the renderer drop
        // expensive secondary effects when still below the preset's target.
        this.effectsQuality = 'reduced';
      }
      this.lastAdjustmentAt = now;
      this.resetMeasurements(now, false);
      return this.scale;
    }

    if (
      (this.scale < MAX_RESOLUTION_SCALE || this.effectsQuality === 'reduced')
      && this.validSamples >= UPSCALE_SAMPLE_COUNT
      && now - this.lastAdjustmentAt >= UPSCALE_COOLDOWN_MS
      && this.averageFrameMs <= HEALTHY_FRAME_MS * cadenceRatio
      && this.slowFrameRatio < 0.08
    ) {
      if (this.effectsQuality === 'reduced') {
        // Restore lighting before probing extra pixels so visual quality returns
        // in the inverse order in which it was reduced.
        this.effectsQuality = 'full';
      } else {
        // Probe upward one step at a time. If the extra pixels are too expensive,
        // the shorter downscale window returns quickly to the sustainable level.
        this.scale = higherAdaptiveStep(this.scale);
      }
      this.lastAdjustmentAt = now;
      this.resetMeasurements(now, false);
    }

    return this.scale;
  }

  private resetMeasurements(now: number | null = null, resetAdjustment = true): void {
    this.lastFrameAt = now;
    this.averageFrameMs = 1000 / this.targetFps;
    this.slowFrameRatio = 0;
    this.validSamples = 0;
    this.sampledDurationMs = 0;
    if (resetAdjustment) this.lastAdjustmentAt = -Infinity;
  }
}
