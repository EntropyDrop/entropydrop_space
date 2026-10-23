/** Explicit offline-only probes. GPU/CPU diagnosis and pixel readback are separate. */
import { interceptMethod, withHiddenObjects, guardTimestampWrites } from './FrameDiagnostics.ts';
import { summarize } from './MaintenanceBenchmark.ts';
import { gpuTimestampSpan } from './GpuTimestampSpan.ts';
import { GpuFrameTimeline } from './GpuFrameTimeline.ts';
import { assertGpuBenchmarkEnvironment } from './GpuBenchmarkEnvironment.ts';
import { gpuTrialTreatment } from './GpuTrialOrder.ts';

export type TurnProbeOptions = { durationMs?: number; gpu?: boolean; motion?: 'sweep' | 'rapid' | 'fixed';
  hide?: 'far' | 'near' | 'sky'; scale?: number; timeline?: boolean;
  /** Only for synchronous render-state switches. CSS/compositor changes have
   * asynchronous effects and must use separate, settled runs instead. */
  variant?: { label: string; enabled: boolean; orderSeed?: number; set(enabled: boolean): void } };

export async function sampleTurn(game: any, label: string, options: TurnProbeOptions = {}) {
  if (!import.meta.env.DEV || !game.offline) throw new Error('Use the local offline development fixture.');
  const environment = assertGpuBenchmarkEnvironment();
  const scene = game.sceneRenderer, renderer = scene.renderer, backend = renderer.backend;
  const layer = game.world.distantSurface.voxels, arena = layer.arena;
  const saved = { yaw: game.controller.yaw, pitch: game.controller.pitch, resolution: scene.getResolutionScaleState(),
    far: game.world.distantSurface.isEnabled(), timestamp: backend.trackTimestamp, autoReset: renderer.info.autoReset };
  const panels = [...document.querySelectorAll<HTMLElement>('#dev-render-diagnostics, #dev-frame-profiler')];
  const display = panels.map(p => [p.style.getPropertyValue('display'), p.style.getPropertyPriority('display')]), undo: (() => void)[] = [];
  const metrics: Record<string, number[]> = { frame: [], cpu: [], gpu: [], gpuPassSum: [], picking: [], lod: [], arena: [],
    render: [], submit: [], matrices: [], simulation: [], hud: [], minimap: [], publish: [], pipeline: [] };
  const stages: Record<string, number> = {}, slowFrames: unknown[] = [], gpuRows: unknown[] = [], pipelines: unknown[] = [];
  let pending: Promise<void> | null = null, previous = 0, readyAt = 0, started = 0, frames = 0, gpuFrame = 0;
  let gpuError = '', maxPending = 0, finished = false;
  let lastGpuSpan: ReturnType<typeof gpuTimestampSpan> = null;
  const readbackBuffers = new WeakSet<object>();
  const gpuAvailable = renderer.hasFeature('timestamp-query');
  if (options.variant && (!options.gpu || !options.timeline || !gpuAvailable))
    throw new Error('Interleaved variants require independent GPU timestamps.');
  if (options.variant) gpuTrialTreatment(0, options.variant.orderSeed);
  let trialIndex = 0, warmTrialIndex = 0;
  const timeline = options.gpu && gpuAvailable && options.timeline ? new GpuFrameTimeline(backend.device) : null;
  try {
    undo.push(guardTimestampWrites(backend));
    panels.forEach(p => p.style.setProperty('display', 'none', 'important'));
    undo.push(interceptMethod(game.uiStore, 'sampleDistantTerrainFrame', () => {}));
    game.uiStore.setDistantSurfaceEnabled(true, false);
    scene.setResolutionScale(options.scale ?? 1); renderer.info.autoReset = false; backend.trackTimestamp = false;
    for (const [target, method, name] of [
      [game.controller, 'updateAimRaycast', 'picking'], [game.world.distantSurface, 'updateView', 'lod'],
      [arena, 'sync', 'arena'], [scene, 'render', 'render'], [renderer, 'render', 'submit'],
      [layer.group, 'updateMatrixWorld', 'matrices'], [game.entitySimulationClock, 'advance', 'simulation'],
      [game.uiStore, 'updateHUD', 'hud'], [game.minimap, 'update', 'minimap'],
      [game.world, 'processInteractiveTerrainWork', 'publish'],
    ]) if (target) undo.push(interceptMethod(target, method, (original, args) => {
      const at = performance.now(); try { return original(...args); }
      finally { stages[name] = (stages[name] ?? 0) + performance.now() - at; }
    }));
    undo.push(interceptMethod(backend, 'createRenderPipeline', (original, args) => {
      const at = performance.now(); try { return original(...args); }
      finally {
        const ms = performance.now() - at; stages.pipeline = (stages.pipeline ?? 0) + ms;
        if (started && pipelines.length < 1000) pipelines.push({ at: at - started, ms,
          async: !!args[1], object: args[0]?.object?.name });
      }
    }));
    if (options.hide) undo.push(interceptMethod(scene, 'renderWorld', (original, args) => {
      const objects = options.hide === 'far' ? [game.world.distantSurface.mesh, game.world.distantSurface.sideMesh]
        : options.hide === 'sky' ? [scene.skyDome] : [
          ...[...game.world.chunks.values()].map((chunk: any) => chunk.mesh),
          ...game.world.microVoxels.renderMeshes.values(),
        ];
      return withHiddenObjects(objects, () => original(...args));
    }));
    const outcome = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const deadline = performance.now() + 180000;
      undo.push(interceptMethod(game, 'animate', (original, args) => {
        if (finished) return original(...args);
        const now = performance.now(), stamp = Number(args[0]) || now, elapsed = started ? now - started : 0;
        if (options.motion !== 'fixed') {
          game.controller.yaw = saved.yaw + (options.motion === 'rapid' ? elapsed * Math.PI * 2 / 4000
            : .6 * Math.sin(elapsed * Math.PI * 2 / 8000));
          if (options.motion === 'rapid') game.controller.pitch = Math.max(-1.5, Math.min(1.5, saved.pitch + .75 * Math.sin(elapsed * Math.PI * 2 / 3000)));
        }
        for (const name in stages) stages[name] = 0;
        const oldEpoch = arena?.viewEpoch, sampleGpu = options.gpu && gpuAvailable && ++gpuFrame % 6 === 0 && !pending;
        const treatment = sampleGpu && options.variant
          ? gpuTrialTreatment(started ? trialIndex++ : warmTrialIndex++, options.variant.orderSeed) : undefined;
        if (treatment) {
          try { options.variant!.set(treatment.role === 'candidate'); }
          catch (error) {
            finished = true; reject(error);
            // The original animation callback has not scheduled its successor.
            // Let cleanup restore hooks before the next frame resumes gameplay.
            requestAnimationFrame(game.animate); return;
          }
        }
        if (sampleGpu) backend.timestampQueryPool.render?.timestamps.clear();
        backend.trackTimestamp = !!sampleGpu && !timeline; renderer.info.reset();
        if (sampleGpu && timeline) timeline.begin();
        try { original(...args); } catch (error) { reject(error); return; }
        const cpu = performance.now() - now;
        if (sampleGpu) {
          const capture = !!started, sampleAt = elapsed, sampleYaw = game.controller.yaw;
          if (timeline) {
            pending = timeline.end().then(row => {
              if (capture && row) {
                metrics.gpu.push(row.spanMs); metrics.gpuPassSum.push(row.passSumMs);
                gpuRows.push({ at: sampleAt, yaw: sampleYaw, ...row, ...(treatment ? { treatment } : {}) });
              }
            }).catch(error => { gpuError = String(error); }).finally(() => { pending = null; });
          } else {
            const buffer = backend.timestampQueryPool.render?.resultBuffer;
            if (buffer && !readbackBuffers.has(buffer)) {
              readbackBuffers.add(buffer);
              undo.push(interceptMethod(buffer, 'getMappedRange', (original, args) => {
                const bytes = original(...args); lastGpuSpan = gpuTimestampSpan(new BigUint64Array(bytes)); return bytes;
              }));
            }
            lastGpuSpan = null;
            pending = renderer.resolveTimestampsAsync().then(() => {
              const passes = [...(backend.timestampQueryPool.render?.timestamps?.entries() ?? [])] as [string, number][];
              if (capture && lastGpuSpan && lastGpuSpan.spanMs > 0) {
                metrics.gpu.push(lastGpuSpan.spanMs); metrics.gpuPassSum.push(lastGpuSpan.passSumMs);
                gpuRows.push({ at: sampleAt, yaw: sampleYaw, ...lastGpuSpan, passes });
              }
            }).catch((e: unknown) => { gpuError = String(e); }).finally(() => { pending = null; });
          }
        }
        backend.trackTimestamp = false;
        if (document.visibilityState !== 'visible' || !game.world.distantSurface.isEnabled()
          || scene.getResolutionScaleState().scale !== (options.scale ?? 1)) { reject(new Error('Benchmark workload changed.')); return; }
        if (!started) {
          if (layer.hasPendingWork || layer.hasPendingTransitions || !game.world.getTerrainAoiLoadProgress().ready
            || arena?.stats.residentFaces !== 2089207) readyAt = 0;
          else if (!readyAt) readyAt = now;
          if (readyAt && now - readyAt >= 3000) started = now;
          if (now > deadline) reject(new Error('Fixture did not settle.'));
          previous = stamp; return;
        }
        const gap = previous ? stamp - previous : 0; previous = stamp;
        if (gap) metrics.frame.push(gap);
        metrics.cpu.push(cpu); for (const name in stages) metrics[name].push(stages[name]);
        frames++; maxPending = Math.max(maxPending, arena?.stats.pendingSources ?? 0);
        if ((cpu > 8 || gap > 16.67) && slowFrames.length < 1000) slowFrames.push({ at: elapsed, gap, cpu,
          stages: { ...stages }, yaw: game.controller.yaw, pitch: game.controller.pitch,
          epochChanged: oldEpoch !== arena?.viewEpoch, arena: { ...arena?.stats },
          calls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles });
        if (elapsed >= (options.durationMs ?? 32000)) { finished = true; resolve({ label, options, time: new Date().toISOString(),
          durationMs: elapsed, frames, maxPending, width: renderer.domElement.width, height: renderer.domElement.height,
          quality: scene.getLightingQuality(), shadows: scene.getShadowsEnabled(), userAgent: navigator.userAgent,
          counters: { arena: { ...arena?.stats }, nearChunks: game.world.chunks.size,
            calls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles },
          slowFrames, pipelines, gpuAvailable, gpuMetric: 'First GPU pass start to last pass end; pass durations may overlap.' }); }
      }));
    });
    await pending;
    assertGpuBenchmarkEnvironment();
    return { ...outcome, environment, gpuError, gpuRows,
      metrics: Object.fromEntries(Object.entries(metrics).map(([name, values]) => [name, summarize(values)])),
      fps: 1000 / summarize(metrics.frame).mean };
  } finally {
    await pending; timeline?.dispose(); undo.reverse().forEach(restore => restore());
    panels.forEach((p, i) => { if (display[i][0]) p.style.setProperty('display', display[i][0], display[i][1]); else p.style.removeProperty('display'); });
    game.controller.yaw = saved.yaw; game.controller.pitch = saved.pitch;
    scene.setResolutionScale(saved.resolution.mode === 'auto' ? 'auto' : saved.resolution.fixedScale);
    game.uiStore.setDistantSurfaceEnabled(saved.far, false);
    backend.trackTimestamp = saved.timestamp; renderer.info.autoReset = saved.autoReset;
    options.variant?.set(options.variant.enabled);
  }
}

/** Fixed-pose comparisons after approaching a guard boundary, outside timing. */
export async function checkTurnPixels(game: any, variant?: { set(enabled: boolean): void; enabled: boolean }) {
  if (!import.meta.env.DEV || !game.offline) throw new Error('Use the local offline fixture.');
  const scene = game.sceneRenderer, renderer = scene.renderer, layer = game.world.distantSurface.voxels;
  if (layer.hasPendingWork || layer.hasPendingTransitions) throw new Error('Wait for settled terrain.');
  const saved = { yaw: game.controller.yaw, pitch: game.controller.pitch, quality: scene.getLightingQuality(),
    shadows: scene.getShadowsEnabled(), optimizations: layer.arena.getViewOptimizations() };
  const setVariant = variant?.set ?? ((enabled: boolean) => layer.setTurnOptimizationsEnabled(enabled));
  let suspended = false;
  const resume = interceptMethod(game, 'animate', () => { suspended = true; });
  const rows = [];
  try {
    while (!suspended) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const canvas = document.createElement('canvas'); canvas.width = renderer.domElement.width; canvas.height = renderer.domElement.height;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    for (const quality of ['medium', 'ultra']) for (const shadows of [false, true])
      for (const [name, yaw, pitch] of [
        ['near', Math.PI / 2, -.85], ['across', Math.PI / 2, 1.35],
        ['turned', Math.PI / 2 + .6, .35], ['reverse', Math.PI * 1.5, .2],
      ] as const) {
        scene.setLightingQuality(quality); scene.setShadowsEnabled(shadows);
        const pixels: Uint8ClampedArray[] = [], hits: string[] = [];
        for (const enabled of [false, true, false]) {
          setVariant(enabled);
          game.controller.yaw = yaw - .019; game.controller.pitch = pitch;
          game.controller.updateRender(0); scene.render(true); scene.render(true);
          game.controller.yaw = yaw; game.controller.updateRender(0); scene.render(true); scene.render(true);
          context.drawImage(renderer.domElement, 0, 0);
          pixels.push(context.getImageData(0, 0, canvas.width, canvas.height).data);
          hits.push(JSON.stringify(game.controller.performAimRaycast()));
        }
        const differences = pixels.slice(1).map(image => {
          let changedPixels = 0, maxChannelDelta = 0;
          for (let i = 0; i < image.length; i += 4) {
            const delta = Math.max(Math.abs(image[i] - pixels[0][i]), Math.abs(image[i + 1] - pixels[0][i + 1]), Math.abs(image[i + 2] - pixels[0][i + 2]));
            if (delta) changedPixels++; maxChannelDelta = Math.max(maxChannelDelta, delta);
          }
          return { changedPixels, maxChannelDelta };
        });
        rows.push({ name, quality, shadows, width: canvas.width, height: canvas.height, differences,
          identicalPicking: hits.every(hit => hit === hits[0]), nonempty: pixels[0].some((v, i) => i % 4 !== 3 && v > 0) });
      }
    return rows;
  } finally {
    setVariant(variant?.enabled ?? saved.optimizations.cached);
    game.controller.yaw = saved.yaw; game.controller.pitch = saved.pitch;
    scene.setLightingQuality(saved.quality); scene.setShadowsEnabled(saved.shadows); game.controller.updateRender(0);
    resume(); if (suspended) requestAnimationFrame(game.animate);
  }
}
