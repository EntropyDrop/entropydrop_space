/** Read computed visibility, not the hidden attribute: author CSS can override
 * the user-agent [hidden] rule. HMR can also reopen the full-screen start page. */
export function benchmarkElementVisible(element: Element | null,
  style: (element: Element) => Pick<CSSStyleDeclaration, 'display' | 'visibility' | 'opacity'> = getComputedStyle) {
  if (!element) return false;
  const own = style(element);
  if (own.visibility === 'hidden' || own.visibility === 'collapse') return false;
  for (let current: Element | null = element; current; current = current.parentElement) {
    const value = style(current);
    // A descendant can explicitly override an ancestor's visibility:hidden,
    // but cannot override its display:none or zero group opacity.
    if (value.display === 'none' || Number(value.opacity) === 0) return false;
  }
  return true;
}

export function assertGpuBenchmarkEnvironment() {
  if (document.visibilityState !== 'visible') throw new Error('Keep the benchmark document visible.');
  const overlay = document.querySelector('#pause-screen');
  if (benchmarkElementVisible(overlay)) throw new Error('Click Play before measuring: the start overlay adds GPU compositor load.');
  if (benchmarkElementVisible(document.querySelector('#dev-frame-profiler')))
    throw new Error('Close the frame profiler before running an independent GPU benchmark.');
  return { visibility: document.visibilityState, startOverlayVisible: false, frameProfilerVisible: false,
    hudVisible: benchmarkElementVisible(document.querySelector('#hud-overlay')),
    diagnosticsVisible: benchmarkElementVisible(document.querySelector('#dev-render-diagnostics')) };
}

/** Only for paused, offscreen command replay. Ordinary game-frame benchmarks
 * must retain the HUD. Do not suppress the start overlay: the guard must see it. */
export function suppressGpuBenchmarkUi() {
  const style = document.createElement('style');
  style.dataset.gpuBenchmarkUi = 'suppressed';
  style.textContent = '#hud-overlay,#nav-system-container,#crosshair,#toast,#dev-render-diagnostics,#dev-frame-profiler{display:none!important}';
  document.head.append(style);
  return () => style.remove();
}
