/** Development-only measurements. No world writes, persisted settings or gl.finish(). */
export class FrameSamples {
  private values: number[] = [];
  private capacity: number;
  constructor(capacity = 240) { this.capacity = capacity; }
  add(value: number) {
    if (!Number.isFinite(value)) return;
    this.values.push(value);
    if (this.values.length > this.capacity) this.values.shift();
  }
  clear() { this.values.length = 0; }
  summary() {
    const sorted = [...this.values].sort((a, b) => a - b);
    return { count: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
      p50: sorted[Math.floor(sorted.length * .5)] ?? 0, p95: sorted[Math.floor(sorted.length * .95)] ?? 0 };
  }
}

/** Restore inherited methods by deleting the temporary own property. */
export function interceptMethod(target: any, key: string, invoke: (original: (...args: any[]) => any, args: any[]) => any) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key), original = target[key];
  if (typeof original !== 'function') return () => {};
  const wrapper = function (...args: any[]) { return invoke(original.bind(this), args); };
  target[key] = wrapper;
  return () => {
    if (target[key] !== wrapper) return;
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete target[key];
  };
}

export function withHiddenObjects(objects: Iterable<any>, draw: () => void) {
  const visibility = new Map<any, boolean>();
  try {
    for (const object of objects) if (object && !visibility.has(object)) {
      visibility.set(object, object.visible); object.visible = false;
    }
    draw();
  } finally {
    for (const [object, visible] of visibility) object.visible = visible;
  }
}

const active = new WeakMap<object, { dispose(): void; panel: HTMLElement }>();
export function installFrameDiagnostics(game: any) {
  if (!import.meta.env.DEV || !game) return;
  const existing = active.get(game);
  if (existing) { existing.panel.hidden = false; return existing; }
  const scene = game.sceneRenderer, renderer = scene.renderer;
  const gl: WebGL2RenderingContext = renderer.getContext();
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const pending: { query: WebGLQuery; epoch: number }[] = [];
  const flags = { draw: true, far: true, near: true, micro: true, sky: true, post: true };
  const labels = { draw: 'Scene drawing', far: 'Distant LOD', near: 'Near standard terrain',
    micro: 'Micro terrain', sky: 'Sky', post: 'Ultra post-processing' };
  const samples = new Map<string, FrameSamples>();
  const metric = (name: string) => {
    if (!samples.has(name)) samples.set(name, new FrameSamples());
    return samples.get(name)!;
  };
  const stage = new Map<string, number>();
  const undo: (() => void)[] = [];
  const autoReset = renderer.info.autoReset;
  renderer.info.autoReset = false;
  let previous = 0, published = 0, epoch = 0, disposed = false;
  let gpuEnabled = true, gpuFrame = 0;
  let calls = 0, triangles = 0;
  const panel = document.createElement('section');
  panel.id = 'dev-frame-profiler';
  panel.style.cssText = 'position:fixed;right:12px;top:90px;z-index:10010;max-width:560px;max-height:80vh;overflow:auto;background:#101820f5;color:white;padding:12px;font:12px monospace;pointer-events:auto';
  const heading = document.createElement('strong'); heading.textContent = 'FRAME PROFILER · temporary / no world edits';
  const stats = document.createElement('pre'); stats.style.whiteSpace = 'pre-wrap';
  const controls = document.createElement('div');
  const results = document.createElement('pre'); results.style.whiteSpace = 'pre-wrap';
  function showResults(lines: string[]) {
    results.replaceChildren(...lines.map(line => {
      const row = document.createElement('div'); row.textContent = line; return row;
    }));
  }
  panel.append(heading, stats, controls, results); document.body.append(panel);
  function clear() { epoch++; previous = 0; for (const value of samples.values()) value.clear(); }
  const buttons = new Map<keyof typeof flags, HTMLButtonElement>();
  function refreshButtons() {
    for (const [key, button] of buttons) {
      button.textContent = `${labels[key]}: ${flags[key] ? 'ON' : 'OFF'}`;
      button.setAttribute('aria-pressed', String(flags[key]));
    }
  }
  function button(label: string, click: () => void) {
    const element = document.createElement('button'); element.textContent = label;
    element.onclick = click; controls.append(element); return element;
  }
  for (const key of Object.keys(flags) as (keyof typeof flags)[]) {
    buttons.set(key, button('', () => { if (comparison) return; flags[key] = !flags[key]; clear(); refreshButtons(); }));
  }
  refreshButtons();
  const gpuButton = button('GPU timing: ON (1/6 frames)', () => {
    if (comparison) return;
    gpuEnabled = !gpuEnabled; clear();
    gpuButton.textContent = `GPU timing: ${gpuEnabled ? 'ON (1/6 frames)' : 'OFF'}`;
  });
  const capture = () => ({ flags: { ...flags }, quality: scene.getLightingQuality(), resolution: scene.getResolutionScaleState(),
    secondaryScale: scene.cinematicEffects?.getSecondaryResolutionScale() ?? 0.5 });
  const restore = (saved: ReturnType<typeof capture>) => {
    Object.assign(flags, saved.flags); scene.setLightingQuality(saved.quality);
    scene.setResolutionScale(saved.resolution.mode === 'auto' ? 'auto' : saved.resolution.fixedScale);
    scene.cinematicEffects?.setSecondaryResolutionScale(saved.secondaryScale);
    refreshButtons(); clear();
  };
  let comparison: { saved: ReturnType<typeof capture>; cases: { label: string; apply(): void }[];
    index: number; warmUntil: number; endAt: number; warmed: boolean; rows: string[] } | null = null;
  function beginCase(now: number) {
    const run = comparison!;
    restore(run.saved);
    // Fixed mode also selects full effects. Use this deliberately for every
    // case and label it; an Auto baseline might previously have reduced effects.
    scene.setResolutionScale(run.saved.resolution.scale);
    run.cases[run.index].apply(); clear(); refreshButtons();
    run.warmUntil = now + 1500; run.endAt = now + 5500; run.warmed = false;
  }
  button('Run render A/B (about 50s)', () => {
    if (comparison) return;
    if (game.uiStore?.getSnapshot()?.hasStarted === false) {
      showResults(['Click Play first to exclude the full-screen startup blur, then Escape to release the pointer.']);
      return;
    }
    const saved = capture();
    const cases = [{ label: 'Baseline', apply() {} },
      ...(['draw', 'far', 'near', 'micro', 'sky', 'post'] as const).map(key => ({
        label: `No ${key}`, apply() { flags[key] = false; },
      })),
      { label: saved.resolution.scale > .5 ? '50% resolution' : '100% resolution',
        apply() { scene.setResolutionScale(saved.resolution.scale > .5 ? .5 : 1); } },
      { label: 'Baseline repeat', apply() {} }];
    comparison = { saved, cases, index: 0, warmUntil: 0, endAt: 0, warmed: false,
      rows: [`${saved.quality} | fixed ${Math.round(saved.resolution.scale * 100)}% | full effects | shadows ${scene.getShadowsEnabled() ? 'ON' : 'OFF'}`] };
    showResults(['Sampling; keep this tab foreground. Settings restore automatically.']);
    beginCase(performance.now());
  });
  button('Compare effect resolution (about 17s)', () => {
    if (comparison) return;
    if (game.uiStore?.getSnapshot()?.hasStarted === false || !scene.cinematicEffects) {
      showResults(['Click Play and select Ultra first. Keep the camera fixed during the comparison.']);
      return;
    }
    const saved = capture();
    comparison = { saved, index: 0, warmUntil: 0, endAt: 0, warmed: false,
      cases: ([0.5, 1, 0.5] as const).map((scale, i) => ({
        label: `${scale * 100}% effect resolution${i === 2 ? ' repeat' : ''}`,
        apply() { scene.cinematicEffects.setSecondaryResolutionScale(scale); },
      })),
      rows: [`Ultra | fixed ${Math.round(saved.resolution.scale * 100)}% scene | full effects | effect resolution only`] };
    beginCase(performance.now());
  });
  button('Reset isolation', () => {
    if (comparison) { const saved = comparison.saved; comparison = null; restore(saved); }
    for (const key of Object.keys(flags)) flags[key] = true;
    refreshButtons(); clear();
  });
  const measure = (target: any, key: string, name: string) => {
    if (!target) return;
    undo.push(interceptMethod(target, key, (original, args) => {
      const start = performance.now();
      try { return original(...args); }
      finally { stage.set(name, (stage.get(name) ?? 0) + performance.now() - start); }
    }));
  };
  for (const [target, method, label] of [
    [game.entitySimulationClock, 'advance', 'Simulation'], [game.controller, 'updateAimRaycast', 'Picking'],
    [game.world, 'updateChunksAround', 'Terrain window'], [game.world, 'processInteractiveTerrainWork', 'Terrain publish'],
    [game.uiStore, 'updateHUD', 'HUD'], [game.minimap, 'update', 'Minimap'],
    [game.world.distantSurface, 'updateView', 'LOD view'], [scene, 'update', 'Scene update'],
    [scene, 'render', 'Render total'], [renderer, 'render', 'WebGL submit'],
  ] as const) measure(target, method, label);
  undo.push(interceptMethod(scene, 'renderWorld', (original, args) => {
    if (!flags.draw) { renderer.clear(); return; }
    const hidden = [];
    if (!flags.sky) hidden.push(scene.skyDome);
    if (!flags.far) hidden.push(game.world.distantSurface?.mesh);
    if (!flags.near) for (const chunk of game.world.chunks.values()) hidden.push(chunk.mesh);
    if (!flags.micro) for (const mesh of game.world.microVoxels.renderMeshes.values()) hidden.push(mesh);
    return withHiddenObjects(hidden, () => {
      if (flags.post) original(...args);
      else renderer.render(scene.scene, scene.camera);
    });
  }));
  function pollGpu() {
    if (!timer || gl.isContextLost()) return;
    const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT);
    for (let i = pending.length - 1; i >= 0; i--) {
      const entry = pending[i];
      if (!disjoint && !gl.getQueryParameter(entry.query, gl.QUERY_RESULT_AVAILABLE)) continue;
      if (!disjoint && entry.epoch === epoch) metric('GPU').add(gl.getQueryParameter(entry.query, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(entry.query); pending.splice(i, 1);
    }
    if (disjoint) metric('GPU').clear();
  }
  undo.push(interceptMethod(scene, 'render', (original, args) => {
    pollGpu();
    const query = timer && gpuEnabled && ++gpuFrame % 6 === 0 && !gl.isContextLost() && pending.length < 8
      && !gl.getQuery(timer.TIME_ELAPSED_EXT, gl.CURRENT_QUERY) ? gl.createQuery() : null;
    if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
    try { return original(...args); }
    finally {
      if (query) { gl.endQuery(timer.TIME_ELAPSED_EXT); pending.push({ query, epoch }); }
    }
  }));
  function publish(now: number) {
    const cadence = metric('Frame').summary(), cpu = metric('CPU').summary(), gpu = metric('GPU').summary();
    const resolution = scene.getResolutionScaleState();
    const fmt = (n: number) => n.toFixed(2);
    stats.textContent = `${cadence.count ? fmt(1000 / cadence.mean) : 'Warming up'} FPS | frame p50/p95 ${fmt(cadence.p50)}/${fmt(cadence.p95)} ms\nCPU p50/p95 ${fmt(cpu.p50)}/${fmt(cpu.p95)} ms | GPU ${!gpuEnabled ? 'OFF' : timer ? `${fmt(gpu.p50)}/${fmt(gpu.p95)} ms (${gpu.count} samples)` : 'timer unavailable'}\nWhole-frame calls ${calls} | triangles ${triangles}\nCanvas ${renderer.domElement.width} x ${renderer.domElement.height} | ${scene.getLightingQuality()} | scale ${resolution.scale} | effects ${resolution.effectsQuality}\nCPU stages p50/p95 (nested, not additive):\n`;
    for (const [name, values] of samples) {
      if (['Frame', 'CPU', 'GPU'].includes(name)) continue;
      const value = values.summary(); stats.textContent += `${name}: ${fmt(value.p50)}/${fmt(value.p95)} ms\n`;
    }
    if (comparison) stats.textContent += `A/B ${comparison.index + 1}/${comparison.cases.length}: ${comparison.cases[comparison.index].label}`;
    published = now;
  }
  undo.push(interceptMethod(game, 'animate', (original, args) => {
    if (disposed) return original(...args);
    const start = performance.now();
    const frameTime = typeof args[0] === 'number' && Number.isFinite(args[0]) ? args[0] : start;
    stage.clear(); renderer.info.reset();
    try { return original(...args); }
    finally {
      const now = performance.now();
      if (document.visibilityState === 'visible') {
        metric('CPU').add(now - start);
        if (previous) metric('Frame').add(frameTime - previous);
        for (const [name, duration] of stage) metric(name).add(duration);
        calls = renderer.info.render.calls; triangles = renderer.info.render.triangles;
        previous = frameTime;
        if (comparison) {
          const run = comparison;
          if (!run.warmed && now >= run.warmUntil) { clear(); run.warmed = true; }
          if (now >= run.endAt) {
            const frame = metric('Frame').summary(), cpu = metric('CPU').summary(), gpu = metric('GPU').summary();
            run.rows.push(`${run.cases[run.index].label}: ${(1000 / (frame.mean || 1)).toFixed(1)} FPS | CPU ${cpu.p50.toFixed(2)}/${cpu.p95.toFixed(2)} ms | GPU ${gpu.count ? gpu.p50.toFixed(2) : 'N/A'} ms | ${calls} calls / ${triangles} tris`);
            showResults(run.rows);
            if (++run.index < run.cases.length) beginCase(now);
            else { comparison = null; restore(run.saved); showResults([...run.rows, 'Done. Original settings restored.']); }
          }
        }
      } else {
        previous = 0;
        if (comparison) { const run = comparison; comparison = null; restore(run.saved); showResults([...run.rows, 'Cancelled: tab hidden; original settings restored.']); }
      }
      if (now - published >= 1000) publish(now);
    }
  }));
  const handle = { panel, dispose() {
    if (disposed) return;
    disposed = true;
    if (comparison) { restore(comparison.saved); comparison = null; }
    for (const restoreMethod of undo.reverse()) restoreMethod();
    for (const entry of pending) gl.deleteQuery(entry.query);
    renderer.info.autoReset = autoReset;
    panel.remove(); active.delete(game);
    window.removeEventListener('pagehide', handle.dispose);
  } };
  button('Close profiler', handle.dispose);
  window.addEventListener('pagehide', handle.dispose, { once: true });
  active.set(game, handle);
  return handle;
}
