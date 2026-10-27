import { interceptMethod, guardTimestampWrites } from './FrameDiagnostics.ts';
import { summarize } from './MaintenanceBenchmark.ts';
import { GpuFrameTimeline } from './GpuFrameTimeline.ts';
import { assertGpuBenchmarkEnvironment } from './GpuBenchmarkEnvironment.ts';
import { type VisibilityMode, type VisibilityTrial } from './VisibilityTrial.ts';
const VISIBILITY_ORDER: VisibilityMode[] = ['original','fast','wide','gpu','gpu','wide','fast','original','wide','original','gpu','fast','fast','gpu','original','wide'];

if (import.meta.hot) import.meta.hot.accept();
type Motion = 'fixed' | 'sweep' | 'move' | 'across' | 'acrossMove';
export async function runVisibilityFrames(game: any, trial: VisibilityTrial,
  options: { motions?: Motion[]; order?: VisibilityMode[]; warmMs?: number; sampleMs?: number; control?: boolean; reference?: VisibilityMode; tag?: string } = {}) {
  if (!import.meta.env.DEV || !game.offline) throw new Error('Offline DEV required.');
  assertGpuBenchmarkEnvironment();
  const scene = game.sceneRenderer, renderer = scene.renderer, layer = game.world.distantSurface.voxels, device = renderer.backend.device;
  if (!renderer.hasFeature('timestamp-query')) throw new Error('GPU timestamps required.');
  const saved = { position: game.playerPhysics.position.clone(), yaw: game.controller.yaw, pitch: game.controller.pitch,
    tracking: renderer.backend.trackTimestamp, autoReset: renderer.info.autoReset, resolution: scene.getResolutionScaleState(), mode: trial.mode };
  const panels = [...document.querySelectorAll<HTMLElement>('#dev-render-diagnostics')], displays = panels.map(p => p.style.display);
  panels.forEach(p => p.style.display = 'none');
  const guard = guardTimestampWrites(renderer.backend), timeline = new GpuFrameTimeline(device);
  renderer.backend.trackTimestamp = false; renderer.info.autoReset = false; scene.setResolutionScale(1);
  const errors: string[] = [], onError = (event: any) => errors.push(event.error.message);
  device.addEventListener('uncapturederror', onError);
  let pending: Promise<void> | null = null, gpuTick = 0;
  const sampleMs = options.sampleMs ?? 2500, warmMs = options.warmMs ?? 1000;
  const result: any = { revision: 'visibility-frames-v1', world: new URL(location.href).searchParams.get('world'), time: new Date().toISOString(),
    tag: options.tag ?? (options.control ? 'control' : 'comparison'), control: !!options.control, reference: options.reference ?? 'original', warmMs, sampleMs,
    width: renderer.domElement.width, height: renderer.domElement.height, cssWidth: innerWidth, cssHeight: innerHeight,
    quality: scene.getLightingQuality(), shadows: scene.getShadowsEnabled(), samples: renderer.samples,
    commandCaching: layer.getCommandCachingEnabled(), distantSettings: game.world.distantSurface.getSettings(),
    trial: { ...trial.metadata, activeModes: [...new Set(options.order ?? VISIBILITY_ORDER)] },
    indirectStatsWarning: 'Three reports nominal geometry triangle counts; GPU-written instance counts are separately verified in frozen captures.', camera: saved.position.toArray(), fov: scene.camera.fov, userAgent: navigator.userAgent,
    adapter: Object.fromEntries(['vendor','architecture','device','description'].map(k => [k, device.adapterInfo?.[k]])),
    rows: [], errors };
  (window as any).visibilityProgress = { state: 'running', world: result.world, tag: result.tag, block: 0 };
  function pose(motion: Motion, t: number) {
    game.controller.yaw = Math.PI / 2 + (motion === 'sweep' || motion === 'move' || motion === 'across' || motion === 'acrossMove' ? .6 * Math.sin(t * Math.PI * 2) : 0);
    game.controller.pitch = motion === 'across' || motion === 'acrossMove' ? 1.35 : -.85;
    game.playerPhysics.position.copy(saved.position);
    if (motion === 'move' || motion === 'acrossMove') { game.playerPhysics.position.x += 16 * Math.sin(t * Math.PI * 2); game.playerPhysics.position.z += 8 * (1 - Math.cos(t * Math.PI * 2)); }
    game.playerPhysics.velocity.set(0, 0, 0); game.playerPhysics.resetRenderInterpolation();
  }
  try {
    for (const motion of options.motions ?? ['across', 'acrossMove']) {
      for (const [block, role] of (options.order ?? VISIBILITY_ORDER).entries()) {
        assertGpuBenchmarkEnvironment(); trial.set(options.control ? options.reference ?? 'original' : role);
        (window as any).visibilityProgress = { state: 'running', world: result.world, tag: result.tag, motion, block, role, completed: result.rows.length };
        const raw: any[] = [], gpu: any[] = [];
        const residentStart = layer.arena.stats.residentFaces;
        let previous = 0, start = 0, finished = false, serial = 0, undo = () => {};
        await new Promise<void>((resolve, reject) => {
          undo = interceptMethod(game, 'animate', (original, args) => {
            if (finished) return original(...args);
            const now = performance.now(), stamp = Number(args[0]) || now;
            if (!start) start = now;
            const elapsed = now - start, warm = elapsed < warmMs;
            pose(motion, warm ? elapsed / warmMs : (elapsed - warmMs) / sampleMs);
            const timed = !warm && ++gpuTick % 6 === 0 && !pending;
            trial.beginFrame(); renderer.info.reset(); if (timed) timeline.begin();
            try { original(...args); } catch (error) { finished = true; reject(error); return; }
            const cpu = performance.now() - now;
            if (timed) { const frame = serial; pending = timeline.end().then(row => { if (row) gpu.push({ frame, ...row }); })
              .catch(error => { errors.push(String(error)); }).finally(() => { pending = null; }); }
            if (document.visibilityState !== 'visible' || renderer.domElement.width !== result.width || renderer.domElement.height !== result.height
              || !game.world.distantSurface.isEnabled()) { finished = true; reject(new Error('Benchmark workload changed.')); return; }
            if (!warm && previous) { raw.push({ frame: stamp - previous, cpu, calls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles,
              ...trial.stats, mapUploadBytes: layer.arena.stats.mapUploadBytes, pending: layer.hasPendingWork || layer.hasPendingTransitions }); serial++; }
            previous = stamp;
            if (elapsed >= warmMs + sampleMs) { finished = true; resolve(); }
          });
        }).finally(() => undo());
        await pending;
        const metrics: any = Object.fromEntries(['frame','cpu','calls','triangles','computePasses','indirectDraws','gpuEncodeMs','gpuBytes','arenaMs','arenaCalls','visibilityQueries','mapUploadBytes','newGpuPages'].map(key => [key, summarize(raw.map(row => row[key]))]));
        metrics.gpu = summarize(gpu.map(row => row.spanMs));
        result.rows.push({ motion, block, role, actual: trial.mode, metrics, fps: 1000 / metrics.frame.mean,
          residentStart, residentEnd: layer.arena.stats.residentFaces,
          pendingFrames: raw.filter(row => row.pending).length, raw, gpu });
      }
    }
    assertGpuBenchmarkEnvironment();
    (window as any).visibilityProgress = { state: 'complete', world: result.world, tag: result.tag, blocks: result.rows.length, errors };
    return result;
  } finally {
    await pending; timeline.dispose(); guard(); device.removeEventListener('uncapturederror', onError);
    renderer.backend.trackTimestamp = saved.tracking; renderer.info.autoReset = saved.autoReset;
    game.playerPhysics.position.copy(saved.position); game.playerPhysics.velocity.set(0, 0, 0); game.playerPhysics.resetRenderInterpolation();
    game.controller.yaw = saved.yaw; game.controller.pitch = saved.pitch; trial.set(saved.mode);
    scene.setResolutionScale(saved.resolution.mode === 'auto' ? 'auto' : saved.resolution.fixedScale);
    panels.forEach((panel, i) => panel.style.display = displays[i]);
  }
}
