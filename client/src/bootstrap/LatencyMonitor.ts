export interface LatencyMonitorOptions {
  apiOrigin: string;
  intervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class LatencyMonitor {
  private readonly apiOrigin: string;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private currentPing: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private isRunning: boolean = false;
  private inFlight: boolean = false;

  constructor(options: LatencyMonitorOptions) {
    this.apiOrigin = options.apiOrigin.replace(/\/+$/, '');
    this.intervalMs = Math.max(10, options.intervalMs ?? 2500);
    this.timeoutMs = Math.max(10, options.timeoutMs ?? 4000);
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  start(): this {
    if (this.isRunning) return this;
    this.isRunning = true;
    void this.probe();
    this.scheduleNext();

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
    return this;
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  private handleVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && !document.hidden && this.isRunning) {
      void this.probe();
    }
  };

  private scheduleNext(): void {
    if (!this.isRunning) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(() => {
      void this.probe().finally(() => {
        if (this.isRunning) {
          this.scheduleNext();
        }
      });
    }, this.intervalMs);
  }

  async probe(): Promise<number | null> {
    if (this.inFlight) return this.currentPing;
    if (typeof document !== 'undefined' && document.hidden) return this.currentPing;
    this.inFlight = true;

    const start = performance.now();
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), this.timeoutMs)
      : null;

    try {
      const response = await this.fetchImpl(`${this.apiOrigin}/space/api/v2/ping`, {
        method: 'GET',
        cache: 'no-store',
        signal: controller?.signal,
      });
      if (response.ok) {
        const rtt = Math.max(1, Math.round(performance.now() - start));
        this.recordPing(rtt);
        return this.currentPing;
      } else {
        this.currentPing = null;
        return null;
      }
    } catch {
      this.currentPing = null;
      return null;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      this.inFlight = false;
    }
  }

  recordPing(rttMs: number): void {
    if (!Number.isFinite(rttMs) || rttMs < 0) return;
    const rounded = Math.max(1, Math.round(rttMs));
    if (this.currentPing === null) {
      this.currentPing = rounded;
    } else {
      // Exponential moving average to smooth transient jitters
      this.currentPing = Math.round(this.currentPing * 0.35 + rounded * 0.65);
    }
  }

  getPing(): number | null {
    return this.currentPing;
  }
}
