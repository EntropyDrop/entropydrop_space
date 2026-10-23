export const DISTANT_TERRAIN_FPS_SAMPLE_MS = 2_000;
export const DISTANT_TERRAIN_MIN_FPS = 60;
export const DISTANT_TERRAIN_LOW_FPS_SAMPLES = 3;

/** Measures complete foreground frame windows, independently of HUD smoothing. */
export class DistantTerrainFpsGuard {
  private windowStartedAt: number | null = null;
  private lastFrameAt: number | null = null;
  private frameCount = 0;
  private lowFpsSamples = 0;

  reset(): void {
    this.windowStartedAt = null;
    this.lastFrameAt = null;
    this.frameCount = 0;
    this.lowFpsSamples = 0;
  }

  /** Returns true after three consecutive two-second windows below 60 FPS. */
  sampleFrame(now: number, visible = true): boolean {
    if (!visible || !Number.isFinite(now)) {
      this.reset();
      return false;
    }
    if (this.lastFrameAt !== null && now <= this.lastFrameAt) {
      this.reset();
    }
    this.lastFrameAt = now;
    if (this.windowStartedAt === null) {
      this.windowStartedAt = now;
      return false;
    }

    this.frameCount++;
    const elapsed = now - this.windowStartedAt;
    if (elapsed < DISTANT_TERRAIN_FPS_SAMPLE_MS) return false;

    const fps = this.frameCount * 1000 / elapsed;
    this.lowFpsSamples = fps < DISTANT_TERRAIN_MIN_FPS ? this.lowFpsSamples + 1 : 0;
    this.windowStartedAt = now;
    this.frameCount = 0;
    return this.lowFpsSamples >= DISTANT_TERRAIN_LOW_FPS_SAMPLES;
  }
}
