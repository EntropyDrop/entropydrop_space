/** Explicit local development probes; never imported by production. */
import { interceptMethod } from './FrameDiagnostics.ts';

export function setMaintenanceVariant(game: any, matrix: boolean, arena = matrix, picking = matrix) {
  game.world.distantSurface.voxels.setMaintenanceOptimizationsEnabled(matrix, arena);
  game.world.aimRaycastCachingEnabled = picking;
}

export function summarize(values: number[]) {
  const ordered = values.slice().sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / (values.length || 1);
  return { count: values.length, mean, p50: ordered[Math.floor(ordered.length * .5)] ?? 0,
    p95: ordered[Math.floor(ordered.length * .95)] ?? 0, p99: ordered[Math.floor(ordered.length * .99)] ?? 0,
    max: ordered.at(-1) ?? 0, over16ms: values.filter(v => v > 16.67).length,
    over33ms: values.filter(v => v > 33.3).length };
}

export async function sampleMaintenance(game: any, label: string, motion = false, durationMs = 32000) {
  if (!import.meta.env.DEV || !game.offline) throw new Error('Use the local offline development fixture.');
  const scene = game.sceneRenderer, renderer = scene.renderer, voxels = game.world.distantSurface.voxels;
  const saved = { resolution: scene.getResolutionScaleState(), far: game.world.distantSurface.isEnabled(),
    yaw: game.controller.yaw, pitch: game.controller.pitch, timestamp: renderer.backend.trackTimestamp,
    autoReset: renderer.info.autoReset };
  const undo: (() => void)[] = [];
  const panels = [...document.querySelectorAll<HTMLElement>('#dev-render-diagnostics, #dev-frame-profiler')];
  const hidden = panels.map(panel => panel.hidden);
  const metrics: Record<string, number[]> = { frame: [], cpu: [], picking: [], lod: [], render: [], matrices: [], arena: [] };
  const stages: Record<string, number> = {};
  let previous = 0, readyAt = 0, started = 0, frames = 0, maxPending = 0;
  const counters = () => ({ calls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles,
    arena: { ...voxels.group.userData.voxelArenaStats }, lod: { ...voxels.group.userData.voxelLodStats },
    nearChunks: game.world.chunks.size, far: game.world.distantSurface.isEnabled(),
    pickingCache: game.world.getAimRaycastCacheStats?.() });
  try {
    panels.forEach(panel => { panel.hidden = true; });
    game.uiStore.setDistantSurfaceEnabled(true, false);
    scene.setResolutionScale(1); renderer.backend.trackTimestamp = false; renderer.info.autoReset = false;
    for (const [target, method, name] of [
      [game.controller, 'updateAimRaycast', 'picking'], [game.world.distantSurface, 'updateView', 'lod'],
      [scene, 'render', 'render'], [voxels.group, 'updateMatrixWorld', 'matrices'], [voxels.arena, 'sync', 'arena'],
    ]) if (target) undo.push(interceptMethod(target, method, (original, args) => {
      const at = performance.now(); try { return original(...args); }
      finally { stages[name] = (stages[name] ?? 0) + performance.now() - at; }
    }));
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const deadline = performance.now() + 180000;
      undo.push(interceptMethod(game, 'animate', (original, args) => {
        const now = performance.now(), stamp = Number(args[0]) || now;
        if (motion) game.controller.yaw = saved.yaw + .6 * Math.sin((started ? now - started : 0) * Math.PI * 2 / 8000);
        for (const key in stages) stages[key] = 0;
        renderer.info.reset();
        try { original(...args); } catch (error) { reject(error); return; }
        const cpu = performance.now() - now;
        if (document.visibilityState !== 'visible') { reject(new Error('Benchmark cancelled: tab hidden.')); return; }
        if (!game.world.distantSurface.isEnabled() || scene.getResolutionScaleState().scale !== 1) {
          reject(new Error('Benchmark workload changed.')); return;
        }
        if (!started) {
          if (voxels.hasPendingWork || voxels.hasPendingTransitions || !game.world.getTerrainAoiLoadProgress().ready) readyAt = 0;
          else if (!readyAt) readyAt = now;
          if (readyAt && now - readyAt >= 3000) started = now;
          if (now > deadline) reject(new Error('Terrain did not settle within 180 seconds.'));
          previous = stamp; return;
        }
        if (previous) metrics.frame.push(stamp - previous);
        previous = stamp; metrics.cpu.push(cpu);
        for (const key in stages) metrics[key].push(stages[key]);
        frames++; maxPending = Math.max(maxPending, voxels.group.userData.voxelArenaStats?.pendingSources ?? 0);
        if (now - started >= durationMs) resolve({ label, motion, durationMs: now - started, frames,
          time: new Date().toISOString(), userAgent: navigator.userAgent, width: renderer.domElement.width,
          height: renderer.domElement.height, quality: scene.getLightingQuality(), shadows: scene.getShadowsEnabled(),
          view: { yaw: saved.yaw, pitch: saved.pitch, position: scene.camera.position.toArray() },
          metrics: Object.fromEntries(Object.entries(metrics).map(([key, values]) => [key, summarize(values)])),
          fps: 1000 / summarize(metrics.frame).mean, maxPending, counters: counters(),
          notes: 'RAF cadence, nested CPU stages; GPU timestamps off; fixed resolution and far terrain; offline fixture.' });
      }));
    });
  } finally {
    undo.reverse().forEach(restore => restore());
    panels.forEach((panel, i) => { panel.hidden = hidden[i]; });
    game.controller.yaw = saved.yaw; game.controller.pitch = saved.pitch;
    scene.setResolutionScale(saved.resolution.mode === 'auto' ? 'auto' : saved.resolution.fixedScale);
    game.uiStore.setDistantSurfaceEnabled(saved.far, false);
    renderer.backend.trackTimestamp = saved.timestamp; renderer.info.autoReset = saved.autoReset;
  }
}

/** Readback and stopped simulation are intentionally separate from all timings. */
export async function checkMaintenancePixels(game: any) {
  if (!import.meta.env.DEV || !game.offline) throw new Error('Use the local offline development fixture.');
  const scene = game.sceneRenderer, renderer = scene.renderer, layer = game.world.distantSurface.voxels;
  if (layer.hasPendingWork || layer.hasPendingTransitions) throw new Error('Wait for terrain to settle.');
  const saved = { yaw: game.controller.yaw, pitch: game.controller.pitch, quality: scene.getLightingQuality(),
    matrix: layer.group.matrixCachingEnabled, arena: layer.arena.incrementalMaintenance,
    picking: game.world.aimRaycastCachingEnabled };
  let suspended = false;
  const resume = interceptMethod(game, 'animate', () => { suspended = true; });
  const rows = [];
  try {
    while (!suspended) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const canvas = document.createElement('canvas'); canvas.width = renderer.domElement.width; canvas.height = renderer.domElement.height;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    for (const quality of ['medium', 'ultra']) for (const [name, yaw, pitch] of [
      ['near', Math.PI / 2, -.85], ['across', Math.PI / 2, 1.35], ['turned', Math.PI / 2 + .6, .35],
    ] as const) {
      scene.setLightingQuality(quality); game.controller.yaw = yaw; game.controller.pitch = pitch;
      game.controller.updateRender(0); game.controller.updateAimRaycast();
      const images: Uint8ClampedArray[] = [], hits: string[] = [];
      for (const enabled of [false, true, false]) {
        setMaintenanceVariant(game, enabled);
        scene.render(true); scene.render(true);
        context.drawImage(renderer.domElement, 0, 0);
        images.push(context.getImageData(0, 0, canvas.width, canvas.height).data);
        const hit = game.controller.performAimRaycast();
        hits.push(JSON.stringify({ kind: hit.kind, worldHit: hit.worldHit, distance: hit.entityHit?.distance,
          entityId: hit.entityHit?.entityId }));
      }
      const differences = images.slice(1).map(pixels => {
        let changed = 0, max = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const delta = Math.max(Math.abs(pixels[i] - images[0][i]), Math.abs(pixels[i + 1] - images[0][i + 1]), Math.abs(pixels[i + 2] - images[0][i + 2]));
          if (delta) changed++; max = Math.max(max, delta);
        }
        return { changedPixels: changed, maxChannelDelta: max };
      });
      const nonempty = images[0].some((v, i) => i % 4 !== 3 && v > 0);
      rows.push({ name, quality, width: canvas.width, height: canvas.height, differences, nonempty,
        identicalPicking: hits.every(hit => hit === hits[0]), residentFaces: layer.group.userData.voxelArenaStats.residentFaces });
    }
    return rows;
  } finally {
    setMaintenanceVariant(game, saved.matrix, saved.arena, saved.picking);
    game.controller.yaw = saved.yaw; game.controller.pitch = saved.pitch;
    scene.setLightingQuality(saved.quality); game.controller.updateRender(0);
    resume(); if (suspended) requestAnimationFrame(game.animate);
  }
}
