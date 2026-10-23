/** Explicit local probes; never part of ordinary rendering or the production graph. */
import { sampleTurn, checkTurnPixels, type TurnProbeOptions } from './TurnPerformanceBenchmark.ts';
import { assertGpuBenchmarkEnvironment } from './GpuBenchmarkEnvironment.ts';
import { interceptMethod } from './FrameDiagnostics.ts';
import { gpuTimestampSpan } from './GpuTimestampSpan.ts';
import { summarize } from './MaintenanceBenchmark.ts';

export function setGpuDrawingVariant(game: any, blocks: boolean, faces = 32) {
  const layer = game.world.distantSurface.voxels;
  layer.setBlockInstancingEnabled(blocks, faces);
}

export async function sampleGpuDrawing(game: any, label: string, options: TurnProbeOptions = {}) {
  const layer = game.world.distantSurface.voxels;
  const variant = { blocks: layer.getBlockInstancingEnabled(), instanceFaces: layer.getInstanceFaces(), compactMaps: layer.getCompactMapsEnabled() };
  const result = await sampleTurn(game, label, options);
  const backend = game.sceneRenderer.renderer.backend;
  const buffers = layer.arena.pages.map((p: any) => ({
    index: backend.get(p.mesh.geometry.index).buffer?.size ?? 0,
    data: backend.get(p.data).buffer?.size ?? 0, map: backend.get(p.map).buffer?.size ?? 0,
  }));
  return { ...result, variant, buffers,
    indexBytes: layer.arena.pages.reduce((sum: number, p: any) => sum + p.mesh.geometry.index.array.byteLength, 0) };
}

export async function checkGpuDrawingPixels(game: any) {
  const layer = game.world.distantSurface.voxels;
  const saved = { blocks: layer.getBlockInstancingEnabled(), faces: layer.getInstanceFaces() };
  try {
    return await checkTurnPixels(game, { set: enabled => setGpuDrawingVariant(game, enabled), enabled: saved.blocks });
  } finally { setGpuDrawingVariant(game, saved.blocks, saved.faces); }
}

/** Saturated far-only GPU diagnostic. Replays the renderer's actual bundle into
 * its existing target with a fresh clear per pass. It excludes near occlusion,
 * post-processing, simulation and presentation; never label this as game FPS. */
export type FarReplayVariant = { label: string; blocks: boolean; faces?: number;
  scissor?: boolean; depthClearValue?: number; skipDraws?: boolean };
export async function sampleFarBundle(game: any, variants: FarReplayVariant[] = [
  { label: 'before', blocks: false }, { label: 'after', blocks: true },
  { label: 'before-repeat', blocks: false }, { label: 'after-repeat', blocks: true },
], applyVariant?: (variant: FarReplayVariant) => void) {
  if (!import.meta.env.DEV || !game.offline) throw new Error('Use the local offline fixture.');
  assertGpuBenchmarkEnvironment();
  const scene = game.sceneRenderer, renderer = scene.renderer, backend = renderer.backend, device = backend.device;
  const layer = game.world.distantSurface.voxels;
  if (!renderer.hasFeature('timestamp-query') || layer.hasPendingWork || layer.hasPendingTransitions
    || !layer.getCommandCachingEnabled()) throw new Error('Wait for settled far bundles with timestamp support.');
  const saved = { blocks: layer.getBlockInstancingEnabled(), faces: layer.getInstanceFaces(), tracking: backend.trackTimestamp };
  const passes = 16, rows = [], usage = (globalThis as any).GPUBufferUsage;
  const query = device.createQuerySet({ type: 'timestamp', count: passes * 2 });
  const resolve = device.createBuffer({ size: passes * 16, usage: usage.QUERY_RESOLVE | usage.COPY_SRC });
  const read = device.createBuffer({ size: passes * 16, usage: usage.COPY_DST | usage.MAP_READ });
  let captured: any, suspended = false, scoped = false;
  const resume = interceptMethod(game, 'animate', () => { suspended = true; });
  const restore = interceptMethod(backend, 'addBundle', (original, args) => {
    if (args[1].bundleGroup === layer.group) captured = {
      bundle: backend.get(args[1]).bundleGPU, descriptor: backend.get(args[0]).descriptor,
    };
    return original(...args);
  });
  try {
    while (!suspended) await new Promise<void>(done => requestAnimationFrame(() => done()));
    backend.trackTimestamp = false; device.pushErrorScope('validation'); scoped = true;
    for (const variant of variants) {
      if (document.visibilityState !== 'visible') throw new Error('Keep the benchmark visible.');
      captured = undefined;
      if (applyVariant) applyVariant(variant);
      else setGpuDrawingVariant(game, variant.blocks, variant.faces);
      game.controller.updateRender(0); scene.render(true); scene.render(true);
      await device.queue.onSubmittedWorkDone();
      if (!captured?.bundle) throw new Error('No distant terrain bundle was submitted.');
      const descriptor = { ...captured.descriptor,
        colorAttachments: captured.descriptor.colorAttachments.map((a: any) => a && ({ ...a, loadOp: 'clear' })),
        depthStencilAttachment: captured.descriptor.depthStencilAttachment && {
          ...captured.descriptor.depthStencilAttachment, depthLoadOp: 'clear',
          depthClearValue: variant.depthClearValue ?? captured.descriptor.depthStencilAttachment.depthClearValue,
        }, timestampWrites: undefined, occlusionQuerySet: undefined,
      };
      const samples = [];
      for (let sample = -32; sample < 32; sample++) {
        const started = performance.now(), encoder = device.createCommandEncoder();
        for (let i = 0; i < passes; i++) {
          const pass = encoder.beginRenderPass({ ...descriptor, timestampWrites: {
            querySet: query, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1,
          } });
          if (variant.scissor) pass.setScissorRect(0, 0, 1, 1);
          if (!variant.skipDraws) pass.executeBundles([captured.bundle]);
          pass.end();
        }
        encoder.resolveQuerySet(query, 0, passes * 2, resolve, 0);
        encoder.copyBufferToBuffer(resolve, 0, read, 0, passes * 16);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync((globalThis as any).GPUMapMode.READ);
        const elapsed = performance.now() - started;
        const times = new BigUint64Array(read.getMappedRange()).slice(); read.unmap();
        let span;
        try { span = gpuTimestampSpan(times)!; }
        catch (error) { throw new Error(`${variant.label} batch ${sample}: ${error}; timestamps=${[...times].join(',')}`); }
        if (sample >= 0) samples.push({ gpuPerPass: span.spanMs / passes, completedPerPass: elapsed / passes, ...span });
      }
      rows.push({ ...variant, passesPerBatch: passes, batches: samples.length, samples,
        gpu: summarize(samples.map(s => s.gpuPerPass)), completed: summarize(samples.map(s => s.completedPerPass)),
        quality: scene.getLightingQuality(), shadows: scene.getShadowsEnabled(),
        width: renderer.domElement.width, height: renderer.domElement.height, arena: { ...layer.arena.stats },
      });
    }
    const validation = await device.popErrorScope(); scoped = false;
    if (validation) throw new Error(validation.message);
    return rows;
  } finally {
    await device.queue.onSubmittedWorkDone();
    if (scoped) await device.popErrorScope();
    restore(); query.destroy(); resolve.destroy(); read.destroy();
    setGpuDrawingVariant(game, saved.blocks, saved.faces); backend.trackTimestamp = saved.tracking;
    resume(); if (suspended) requestAnimationFrame(game.animate);
  }
}
