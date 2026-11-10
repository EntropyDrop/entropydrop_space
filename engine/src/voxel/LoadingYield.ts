/** Yield between loading slices without depending only on animation frames.
 * Browsers pause requestAnimationFrame in background tabs, and some embedders
 * pause it for occluded windows that still report a visible document. Entry
 * loading must keep progressing there instead of stalling until refocused. */
const OCCLUDED_FRAME_TIMEOUT_MS = 100;
const HIDDEN_WAKE_TIMEOUT_MS = 50;

export function nextLoadingTurn(wake?: () => Promise<unknown>): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    const hidden = (globalThis as { document?: { visibilityState?: string } }).document?.visibilityState === 'hidden';
    if (!hidden && typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(done);
      timer = setTimeout(done, OCCLUDED_FRAME_TIMEOUT_MS);
      return;
    }
    if (wake) {
      // Background timers are throttled; a worker result wakes us immediately.
      void wake().then(done, done);
      timer = setTimeout(done, HIDDEN_WAKE_TIMEOUT_MS);
      return;
    }
    if (hidden && typeof MessageChannel === 'function') {
      // Unlike timers, message tasks are not throttled in background tabs.
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); done(); };
      channel.port2.postMessage(null);
      return;
    }
    timer = setTimeout(done, 0);
  });
}
