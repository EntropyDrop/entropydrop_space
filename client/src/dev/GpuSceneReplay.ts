/** Offline-only complete-scene command replay. Captures real WebGPU commands;
 * submits each ABBA quartet in ONE command buffer, with no JS submission gaps.
 * This isolates rendering stages, not simulation, presentation or game FPS. */
import { interceptMethod, guardTimestampWrites } from './FrameDiagnostics.ts';
import { gpuTimestampSpan } from './GpuTimestampSpan.ts';
import { summarize } from './MaintenanceBenchmark.ts';
import { assertGpuBenchmarkEnvironment, suppressGpuBenchmarkUi } from './GpuBenchmarkEnvironment.ts';

type Command = { method: string; args: any[]; object?: string; sky?: boolean };
type CapturedPass = { descriptor: any; commands: Command[]; canvas: boolean };
export type SceneIsolation = 'reference' | 'main-scissor' | 'no-far' | 'no-direct' | 'no-sky' | 'discard-private';
const commandMethods = ['setPipeline', 'setBindGroup', 'setVertexBuffer', 'setIndexBuffer', 'setViewport',
  'setScissorRect', 'setBlendConstant', 'setStencilReference', 'draw', 'drawIndexed', 'drawIndirect',
  'drawIndexedIndirect', 'executeBundles', 'insertDebugMarker', 'pushDebugGroup', 'popDebugGroup'];

/** The role stays distinct for sham A/A comparisons too. */
export function sceneReplayRoles(batch: number) {
  return batch % 2 === 0 ? ['reference', 'candidate', 'candidate', 'reference'] as const
    : ['candidate', 'reference', 'reference', 'candidate'] as const;
}

export async function sampleGpuSceneReplay(game: any, options: { batches?: number; frames?: number;
  candidates?: SceneIsolation[]; isolateUi?: boolean } = {}) {
  if (!import.meta.env.DEV || !game.offline) throw new Error('Use the local offline fixture.');
  const environment = assertGpuBenchmarkEnvironment();
  const scene = game.sceneRenderer, renderer = scene.renderer, backend = renderer.backend, device = backend.device;
  const layer = game.world.distantSurface.voxels;
  if (scene.getLightingQuality() !== 'medium' || scene.getShadowsEnabled() || layer.hasPendingWork
    || layer.hasPendingTransitions || layer.arena.stats.residentFaces !== 2089207
    || !renderer.hasFeature('timestamp-query')) throw new Error('Use the settled Medium fixture without shadows.');
  const batches = options.batches ?? 48, frames = options.frames ?? 4;
  if (!Number.isInteger(batches) || batches < 1 || batches > 512 || !Number.isInteger(frames) || frames < 1 || frames > 4)
    throw new Error('Use 1-512 batches and 1-4 frames per group.');
  const candidates = options.candidates ?? ['main-scissor', 'no-far', 'no-direct', 'no-sky', 'discard-private'];
  const allowed: SceneIsolation[] = ['reference', 'main-scissor', 'no-far', 'no-direct', 'no-sky', 'discard-private'];
  if (!candidates.length || candidates.some(c => !allowed.includes(c))) throw new Error('Unknown isolation mode.');
  const width = renderer.domElement.width, height = renderer.domElement.height;
  const savedTracking = backend.trackTimestamp, undo: (() => void)[] = [];
  const resources: any[] = [], passes: CapturedPass[] = [], farBundles = new Set<any>();
  const usage = (globalThis as any).GPUBufferUsage, textureUsage = (globalThis as any).GPUTextureUsage;
  let suspended = false, capturing = false, currentContext: any, currentObject: any, scoped = false;
  const resume = interceptMethod(game, 'animate', () => { suspended = true; });
  try {
    while (!suspended) await new Promise<void>(done => requestAnimationFrame(() => done()));
    if (options.isolateUi !== false) {
      undo.push(suppressGpuBenchmarkUi());
      for (let i = 0; i < 2; i++) await new Promise<void>(done => requestAnimationFrame(() => done()));
    }
    backend.trackTimestamp = false; undo.push(guardTimestampWrites(backend));
    device.pushErrorScope('validation'); scoped = true;
    const canvasFormat = backend.utils.getPreferredCanvasFormat();
    if (!['bgra8unorm', 'rgba8unorm'].includes(canvasFormat)) throw new Error('Unsupported canvas pixel format.');
    const output = device.createTexture({ label: 'offline-scene-replay-output', size: [width, height], format: canvasFormat,
      usage: textureUsage.RENDER_ATTACHMENT | textureUsage.COPY_SRC }); resources.push(output);
    const outputView = output.createView();
    undo.push(interceptMethod(backend, 'beginRender', (original, args) => {
      currentContext = args[0]; try { return original(...args); } finally { currentContext = undefined; }
    }));
    undo.push(interceptMethod(backend, 'draw', (original, args) => {
      currentObject = args[0]?.object; try { return original(...args); } finally { currentObject = undefined; }
    }));
    undo.push(interceptMethod(backend, 'addBundle', (original, args) => {
      const value = original(...args);
      if (args[1].bundleGroup === layer.group) farBundles.add(backend.get(args[1]).bundleGPU);
      return value;
    }));
    undo.push(interceptMethod(device, 'createCommandEncoder', (original, args) => {
      const encoder = original(...args);
      if (!capturing) return encoder;
      interceptMethod(encoder, 'beginComputePass', () => { throw new Error('Compute capture is unsupported.'); });
      for (const method of ['copyBufferToBuffer', 'copyBufferToTexture', 'copyTextureToBuffer', 'copyTextureToTexture', 'clearBuffer'])
        interceptMethod(encoder, method, () => { throw new Error(`Unexpected capture operation: ${method}`); });
      interceptMethod(encoder, 'beginRenderPass', (begin, passArgs) => {
        const live = passArgs[0];
        if (!currentContext || live.occlusionQuerySet) throw new Error('Unsupported render context or occlusion query.');
        const canvas = currentContext.textures === null;
        const descriptor = { ...live, timestampWrites: undefined, occlusionQuerySet: undefined,
          colorAttachments: live.colorAttachments.map((a: any) => a && ({ ...a, ...(canvas ? { view: outputView } : {}) })),
          depthStencilAttachment: live.depthStencilAttachment && { ...live.depthStencilAttachment } };
        const captured: CapturedPass = { descriptor, commands: [], canvas }; passes.push(captured);
        const pass = begin(...passArgs);
        for (const method of commandMethods) interceptMethod(pass, method, (call, callArgs) => {
          const args = callArgs.map((v: any) => Array.isArray(v) ? [...v] : ArrayBuffer.isView(v) ? (v as any).slice() : v);
          captured.commands.push({ method, args, object: currentObject?.name, sky: currentObject === scene.skyDome });
          return call(...callArgs);
        });
        return pass;
      });
      return encoder;
    }));
    game.controller.updateRender(0); scene.render(true); scene.render(true);
    await device.queue.onSubmittedWorkDone();
    capturing = true; scene.render(true); capturing = false;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(renderer.domElement, 0, 0);
    const reference = context.getImageData(0, 0, width, height).data;
    await device.queue.onSubmittedWorkDone();
    if (passes.length !== 2 || passes[0].canvas || !passes[1].canvas || !farBundles.size
      || !passes[0].descriptor.colorAttachments[0]?.resolveTarget
      || passes[0].descriptor.depthStencilAttachment?.depthLoadOp !== 'clear') throw new Error('Unexpected main/output frame structure.');
    const count = frames * 4 * passes.length * 2;
    const query = device.createQuerySet({ type: 'timestamp', count, label: 'offline-scene-replay' }); resources.push(query);
    const resolve = device.createBuffer({ size: count * 8, usage: usage.QUERY_RESOLVE | usage.COPY_SRC }); resources.push(resolve);
    const read = device.createBuffer({ size: count * 8, usage: usage.MAP_READ | usage.COPY_DST }); resources.push(read);
    function encode(encoder: any, mode: SceneIsolation, firstSlot?: number) {
      for (let index = 0; index < passes.length; index++) {
        const captured = passes[index], main = !captured.canvas;
        const descriptor = { ...captured.descriptor,
          colorAttachments: captured.descriptor.colorAttachments.map((a: any) => a && ({ ...a })),
          depthStencilAttachment: captured.descriptor.depthStencilAttachment && { ...captured.descriptor.depthStencilAttachment } };
        if (firstSlot !== undefined) descriptor.timestampWrites = { querySet: query,
          beginningOfPassWriteIndex: firstSlot + index * 2, endOfPassWriteIndex: firstSlot + index * 2 + 1 };
        if (main && mode === 'discard-private') {
          descriptor.colorAttachments[0].storeOp = 'discard'; descriptor.depthStencilAttachment.depthStoreOp = 'discard';
        }
        const pass = encoder.beginRenderPass(descriptor);
        if (main && mode === 'main-scissor') pass.setScissorRect(0, 0, 1, 1);
        for (const command of captured.commands) {
          if (main && mode === 'main-scissor' && command.method === 'setScissorRect') continue;
          if (main && command.method.startsWith('draw') && (mode === 'no-direct' || (mode === 'no-sky' && command.sky))) continue;
          if (main && mode === 'no-far' && command.method === 'executeBundles') {
            const bundles = command.args[0].filter((b: any) => !farBundles.has(b));
            // executeBundles resets bindings even when the list is empty.
            pass.executeBundles(bundles); continue;
          }
          pass[command.method](...command.args);
        }
        pass.end();
      }
    }
    // Verify capture fidelity before any measurements; padding is excluded.
    const stride = Math.ceil(width * 4 / 256) * 256;
    const pixels = device.createBuffer({ size: stride * height, usage: usage.MAP_READ | usage.COPY_DST }); resources.push(pixels);
    const pixelEncoder = device.createCommandEncoder(); encode(pixelEncoder, 'reference');
    pixelEncoder.copyTextureToBuffer({ texture: output }, { buffer: pixels, bytesPerRow: stride }, [width, height]);
    device.queue.submit([pixelEncoder.finish()]); await pixels.mapAsync((globalThis as any).GPUMapMode.READ);
    const data = new Uint8Array(pixels.getMappedRange()); let changedPixels = 0, maxChannelDelta = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let delta = 0; const src = y * stride + x * 4, dst = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(data[src + (canvasFormat.startsWith('bgra') ? 2-c : c)] - reference[dst+c]));
      if (delta) changedPixels++; maxChannelDelta = Math.max(maxChannelDelta, delta);
    }
    pixels.unmap();
    if (changedPixels) throw new Error(`Replay differs from live frame: ${changedPixels} pixels, max ${maxChannelDelta}.`);
    const rows = [];
    for (const candidate of candidates) {
      const samples = [];
      for (let batch = -16; batch < batches; batch++) {
        if (document.visibilityState !== 'visible' || renderer.domElement.width !== width || renderer.domElement.height !== height
          || layer.hasPendingWork || layer.hasPendingTransitions) throw new Error('Replay workload changed.');
        // Reverse order on alternate batches: both treatments occupy every position.
        const roles = sceneReplayRoles(batch);
        const modes: SceneIsolation[] = roles.map(role => role === 'reference' ? 'reference' : candidate);
        const wallTimeMs = Date.now(), encoder = device.createCommandEncoder();
        modes.forEach((mode, group) => { for (let frame = 0; frame < frames; frame++)
          encode(encoder, mode, (group * frames + frame) * passes.length * 2); });
        encoder.resolveQuerySet(query, 0, count, resolve, 0); encoder.copyBufferToBuffer(resolve, 0, read, 0, count * 8);
        device.queue.submit([encoder.finish()]); await read.mapAsync((globalThis as any).GPUMapMode.READ);
        const times = new BigUint64Array(read.getMappedRange()).slice(); read.unmap();
        if (batch >= 0) samples.push({ wallTimeMs, endWallTimeMs: Date.now(), roles, modes, gpu: modes.map((_, i) =>
          gpuTimestampSpan(times.slice(i * frames * 4, (i+1) * frames * 4))!.spanMs / frames), rawNanoseconds: [...times].map(String) });
      }
      const before = samples.flatMap(s => s.gpu.filter((_, i) => s.roles[i] === 'reference'));
      const after = samples.flatMap(s => s.gpu.filter((_, i) => s.roles[i] === 'candidate'));
      const pairedChanges = samples.map(s => {
        const a = s.gpu.filter((_, i) => s.roles[i] === 'reference').reduce((a, b) => a + b) / 2;
        const b = s.gpu.filter((_, i) => s.roles[i] === 'candidate').reduce((a, b) => a + b) / 2;
        return (b / a - 1) * 100;
      });
      rows.push({ candidate, before: summarize(before), after: summarize(after), pairedChangePercent: summarize(pairedChanges), samples });
    }
    const error = await device.popErrorScope(); scoped = false;
    if (error) throw new Error(error.message);
    assertGpuBenchmarkEnvironment();
    return { time: new Date().toISOString(), environment, uiIsolated: options.isolateUi !== false,
      captureEnvironment: assertGpuBenchmarkEnvironment(), width, height, framesPerGroup: frames, batches, rows,
      capturePixels: { changedPixels, maxChannelDelta }, yaw: game.controller.yaw, pitch: game.controller.pitch,
      arena: { ...layer.arena.stats }, passes: passes.map(p => ({ canvas: p.canvas, commandCount: p.commands.length,
        draws: p.commands.filter(c => c.method.startsWith('draw')).length,
        bundles: p.commands.filter(c => c.method === 'executeBundles').reduce((n, c) => n + c.args[0].length, 0) })) };
  } finally {
    capturing = false; await device.queue.onSubmittedWorkDone();
    if (scoped) await device.popErrorScope();
    undo.reverse().forEach(restore => restore()); resources.reverse().forEach(r => r.destroy());
    backend.trackTimestamp = savedTracking; resume(); if (suspended) requestAnimationFrame(game.animate);
  }
}
