export const WORLD_PROJECTION_SETTING_KEY = 'space_setting_world_projection';
export const WORLD_PROJECTION_AUTO_SETTING_KEY = 'space_setting_world_projection_auto';
export const PROJECTION_SAMPLE_INTERVAL_MS = 5_000;
export const PROJECTION_FPS_THRESHOLD = 60;

/** Two consecutive five-second foreground frame-rate samples trigger a one-way
 * fallback. The owner resets this policy after any manual setting change. */
export class WorldProjectionFallback {
  private startedAt: number | null = null;
  private lastFrameAt: number | null = null;
  private frames = 0;
  private lowSamples = 0;

  reset(): void {
    this.startedAt = this.lastFrameAt = null;
    this.frames = this.lowSamples = 0;
  }

  sampleFrame(now: number, active: boolean): boolean {
    if (!active || !Number.isFinite(now)) { this.reset(); return false; }
    if (this.lastFrameAt !== null && now < this.lastFrameAt) this.reset();
    this.lastFrameAt = now;
    if (this.startedAt === null) { this.startedAt = now; return false; }
    const elapsed = now - this.startedAt;
    this.frames++;
    if (elapsed < PROJECTION_SAMPLE_INTERVAL_MS) return false;
    const fps = this.frames * 1000 / elapsed;
    this.lowSamples = fps < PROJECTION_FPS_THRESHOLD ? this.lowSamples + 1 : 0;
    this.startedAt = now;
    this.frames = 0;
    if (this.lowSamples < 2) return false;
    this.reset();
    return true;
  }
}
