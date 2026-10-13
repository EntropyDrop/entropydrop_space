import { createNatureOrb } from './model.ts';
import { encodeInventoryResource } from '../../../engine/src/storage/InventoryProtobuf.ts';

export const createdEntityId = 'a9398ea9-3c55-45f7-8b59-08c67180add3';
export const anchor = [6512, 25, 620.5];
export function definition() { return encodeInventoryResource('entity', createNatureOrb()); }

export function configure(game: any) {
  const s = game.sceneRenderer;
  const saved = { yaw: game.controller.yaw, pitch: game.controller.pitch,
    quality: s.getLightingQuality(), shadows: s.getShadowsEnabled(), resolution: s.getResolutionScaleState() };
  s.setResolutionScale(1);
  // Same player position for all samples; view includes the complete future model.
  const eye = game.playerPhysics.getEyePosition();
  const dx = anchor[0] - eye.x, dy = anchor[1] - eye.y, dz = anchor[2] - eye.z;
  game.controller.yaw = Math.atan2(-dx, -dz);
  game.controller.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  return saved;
}

export async function getCreatedEntity(game: any) {
  if (location.hostname !== 'localhost' || game.entitySync.apiOrigin !== 'http://localhost:8000'
    || game.contraptionManager.getWorldInfo().slug !== 'nature') throw new Error('Local Nature only.');
  const world = await game.entitySync.client.request('/../../nature');
  if (world.id !== game.contraptionManager.getWorldInfo().id) throw new Error('World mismatch.');
  return game.entitySync.client.get(createdEntityId);
}

// No GPU stalls or screenshot readbacks during sampling. CPU and RAF cadence
// are separate measurements; CPU excludes other tasks and GPU completion.
export async function sample(game: any, label: string, durationMs = 8000, warmupMs = 2000) {
  const scene = game.sceneRenderer, renderer = scene.renderer;
  const cpu: number[] = [], cadence: number[] = [], calls: number[] = [], triangles: number[] = [];
  const original = game.animate, oldAutoReset = renderer.info.autoReset;
  const startAt = performance.now() + warmupMs;
  let previous = 0, hidden = false;
  const onVisibility = () => { if (document.hidden) hidden = true; };
  document.addEventListener('visibilitychange', onVisibility);
  renderer.info.autoReset = false;
  game.animate = function (...args: any[]) {
    const start = performance.now(), raf = typeof args[0] === 'number' ? args[0] : start;
    renderer.info.reset();
    try { return original.apply(this, args); }
    finally {
      if (start >= startAt) {
        cpu.push(performance.now() - start);
        if (previous) cadence.push(raf - previous);
        previous = raf;
        calls.push(renderer.info.render.drawCalls); triangles.push(renderer.info.render.triangles);
      }
    }
  };
  try {
    await new Promise(resolve => setTimeout(resolve, warmupMs + durationMs));
    if (hidden || document.hidden) throw new Error('Sampling invalid: tab hidden.');
    const summarize = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
      return { count: n, mean: values.reduce((a, b) => a + b, 0) / n,
        p50: sorted[Math.floor(n * .5)], p95: sorted[Math.floor(n * .95)], max: sorted[n - 1] };
    };
    const frames = summarize(cadence), tail = [...cadence].sort((a, b) => b - a).slice(0, Math.max(1, Math.ceil(cadence.length * .01)));
    return { label, time: new Date().toISOString(), durationMs, warmupMs, cpu: summarize(cpu), frame: frames,
      fps: 1000 / frames.mean, onePercentLow: 1000 / (tail.reduce((a,b) => a+b,0) / tail.length),
      calls: summarize(calls), triangles: summarize(triangles),
      canvas: [renderer.domElement.width, renderer.domElement.height], quality: scene.getLightingQuality(),
      shadows: scene.getShadowsEnabled(), resolution: scene.getResolutionScaleState(),
      position: game.playerPhysics.position.toArray(), camera: scene.camera.position.toArray(),
      yaw: game.controller.yaw, pitch: game.controller.pitch, world: game.contraptionManager.getWorldInfo(),
      chunks: game.world.chunks.size, entities: game.contraptionManager.contraptions.length,
      userAgent: navigator.userAgent, visibility: document.visibilityState,
      gpuTiming: false, stagesNested: true, cpuExcludesGpuAndOtherTasks: true };
  } finally {
    game.animate = original; renderer.info.autoReset = oldAutoReset;
    document.removeEventListener('visibilitychange', onVisibility);
  }
}
