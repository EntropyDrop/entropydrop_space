import { REVISION } from 'three/webgpu';
import { sampleTurn, checkTurnPixels } from './TurnPerformanceBenchmark.ts';

/** Explicit development experiment, never imported by production.
 * r183 adapter for the private, cleared output-conversion framebuffer only.
 * Its resolved color is sampled by the output quad; its MSAA color and private
 * depth are never consumed by this application's following passes. */
export function installTransientFrameAttachments(renderer: any, mode: () => number) {
  const backend = renderer.backend;
  if (REVISION !== '183' || !backend?.isWebGPUBackend || typeof backend._getRenderPassDescriptor !== 'function') return false;
  const get = backend._getRenderPassDescriptor;
  const states = new Map<Record<string, any>, { discard: boolean; value: string; property: string;
    original?: PropertyDescriptor; getter: () => string }>();
  const configure = (attachment: any, property: string, discard: boolean) => {
    let state = states.get(attachment);
    if (!state) {
      const current = { discard, value: attachment[property] ?? 'store', property,
        original: Object.getOwnPropertyDescriptor(attachment, property), getter: () => '' };
      current.getter = () => current.discard ? 'discard' : current.value;
      state = current; states.set(attachment, state);
      Object.defineProperty(attachment, property, { configurable: true, enumerable: true,
        get: current.getter,
        set: (value: string) => { current.value = value; } });
    }
    state.discard = discard;
  };
  const wrapped = backend._getRenderPassDescriptor = function(context: any, ...args: any[]) {
    const descriptor = get.call(this, context, ...args), target = context.renderTarget;
    const eligible = target === renderer._frameBufferTarget && !!target && target.samples > 1
      && !target.depthTexture && context.clearColor && context.clearDepth && renderer.autoClear
      && renderer.autoClearColor && renderer.autoClearDepth;
    const flags = eligible ? mode() : 0;
    for (const attachment of descriptor.colorAttachments) if (attachment)
      configure(attachment, 'storeOp', !!(flags & 1) && !!attachment.resolveTarget);
    if (descriptor.depthStencilAttachment) configure(descriptor.depthStencilAttachment, 'depthStoreOp', !!(flags & 2));
    return descriptor;
  };
  return () => {
    if (backend._getRenderPassDescriptor === wrapped) backend._getRenderPassDescriptor = get;
    for (const [attachment, state] of states) {
      if (Object.getOwnPropertyDescriptor(attachment, state.property)?.get !== state.getter) continue;
      if (state.original) Object.defineProperty(attachment, state.property, 'value' in state.original
        ? { ...state.original, value: state.value } : state.original);
      else { delete attachment[state.property]; attachment[state.property] = state.value; }
    }
    states.clear();
  };
}

/** ABBA comparison with the ordinary frame loop. No persistent renderer switch. */
export async function sampleGpuAttachments(game: any, durationMs = 24000) {
  if (!import.meta.env.DEV || !game.offline) throw new Error('Use the local offline development fixture.');
  let mode = 0;
  const restore = installTransientFrameAttachments(game.sceneRenderer.renderer, () => mode);
  if (!restore) throw new Error('Unsupported renderer version.');
  try {
    const pixels = await checkTurnPixels(game, { enabled: false, set: v => { mode = v ? 3 : 0; } });
    const rows = [];
    for (const flags of [0, 3, 3, 0]) {
      mode = flags;
      rows.push(await sampleTurn(game, `attachments-${mode}`, { gpu: true, timeline: true, motion: 'sweep', durationMs }));
    }
    return { pixels, rows };
  } finally { restore(); }
}
