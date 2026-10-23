/** Render-only, deterministic angular control. This includes the complete scene
 * and output passes, but excludes simulation/input/presentation. Burst spans can
 * include CPU submission gaps; never report them as GPU busy time or game FPS. */
import { interceptMethod } from './FrameDiagnostics.ts';
import { GpuFrameTimeline } from './GpuFrameTimeline.ts';
import { summarize } from './MaintenanceBenchmark.ts';
import { assertGpuBenchmarkEnvironment } from './GpuBenchmarkEnvironment.ts';

export async function sampleGpuTurnReplay(game: any, variants: { label: string; apply(): void }[],
  options: { framesPerBatch?: number; batches?: number; sweep?: boolean } = {}) {
  if (!import.meta.env.DEV || !game.offline) throw new Error('Use the local offline development fixture.');
  assertGpuBenchmarkEnvironment();
  const scene = game.sceneRenderer, renderer = scene.renderer, layer = game.world.distantSurface.voxels;
  if (layer.hasPendingWork || layer.hasPendingTransitions || !renderer.hasFeature('timestamp-query'))
    throw new Error('Wait for settled geometry and timestamp-query support.');
  const saved = { yaw: game.controller.yaw, pitch: game.controller.pitch, tracking: renderer.backend.trackTimestamp };
  const frames = options.framesPerBatch ?? 4, batches = options.batches ?? 96;
  if (!Number.isInteger(frames) || frames < 1 || frames > 4) throw new Error('Use 1-4 frames per batch.');
  if (!Number.isInteger(batches) || batches < 1 || batches > 2048) throw new Error('Use 1-2048 measured batches.');
  const workload = { width: renderer.domElement.width, height: renderer.domElement.height,
    scale: scene.getResolutionScaleState().scale, quality: scene.getLightingQuality(),
    shadows: scene.getShadowsEnabled(), faces: layer.arena.stats.residentFaces };
  let suspended = false;
  const resume = interceptMethod(game, 'animate', () => { suspended = true; });
  let timer: GpuFrameTimeline | undefined;
  const rows = [];
  try {
    timer = new GpuFrameTimeline(renderer.backend.device);
    while (!suspended) await new Promise<void>(done => requestAnimationFrame(() => done()));
    renderer.backend.trackTimestamp = false;
    for (const variant of variants) {
      variant.apply();
      const samples = [], time = new Date().toISOString();
      for (let i = -32; i < batches; i++) {
        if (document.visibilityState !== 'visible') throw new Error('Benchmark tab became hidden.');
        if (renderer.domElement.width !== workload.width || renderer.domElement.height !== workload.height
          || scene.getResolutionScaleState().scale !== workload.scale || scene.getLightingQuality() !== workload.quality
          || scene.getShadowsEnabled() !== workload.shadows || layer.arena.stats.residentFaces !== workload.faces
          || layer.hasPendingWork || layer.hasPendingTransitions) throw new Error('Replay workload changed.');
        game.controller.yaw = saved.yaw + (options.sweep ? .6 * Math.sin(i * Math.PI * 2 / 32) : 0);
        game.controller.updateRender(0);
        const start = performance.now(); timer.begin();
        for (let f = 0; f < frames; f++) scene.render(true);
        const cpuMs = performance.now() - start, row = await timer.end();
        if (!row) throw new Error('No GPU passes recorded.');
        if (i >= 0) samples.push({ ...row, gpuPerFrame: row.spanMs / frames, cpuPerFrame: cpuMs / frames,
          yaw: game.controller.yaw, visibleFaces: layer.arena.stats.visibleFaces, draws: layer.arena.stats.draws });
      }
      rows.push({ label: variant.label, time, endTime: new Date().toISOString(), framesPerBatch: frames,
        width: renderer.domElement.width, height: renderer.domElement.height, quality: scene.getLightingQuality(),
        shadows: scene.getShadowsEnabled(), samples, gpu: summarize(samples.map(s => s.gpuPerFrame)),
        cpu: summarize(samples.map(s => s.cpuPerFrame)) });
    }
    return rows;
  } finally {
    timer?.dispose(); renderer.backend.trackTimestamp = saved.tracking;
    game.controller.yaw = saved.yaw; game.controller.pitch = saved.pitch; game.controller.updateRender(0);
    resume(); if (suspended) requestAnimationFrame(game.animate);
  }
}
