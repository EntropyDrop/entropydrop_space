/** Reversible, offline-only attribution of local-avatar update and draw costs. */
import { interceptMethod, withHiddenObjects, guardTimestampWrites } from './FrameDiagnostics.ts';
import { GpuFrameTimeline } from './GpuFrameTimeline.ts';
import { assertGpuBenchmarkEnvironment } from './GpuBenchmarkEnvironment.ts';
import { summarize } from './MaintenanceBenchmark.ts';

if (import.meta.hot) import.meta.hot.accept();
type Role = 'reference' | 'hidden' | 'disabled';
const ORDER: Role[] = ['reference','hidden','disabled', 'disabled','hidden','reference',
  'hidden','disabled','reference', 'reference','disabled','hidden',
  'disabled','reference','hidden', 'hidden','reference','disabled'];
type Case = { perspective: 'first_person' | 'third_person'; motion: 'fixed' | 'move' };
const CASES: Case[] = [{ perspective: 'first_person', motion: 'fixed' },
  { perspective: 'first_person', motion: 'move' }, { perspective: 'third_person', motion: 'move' }];

export async function runCharacterFrames(game: any, options: { cases?: Case[]; order?: Role[]; warmMs?: number; sampleMs?: number; tag?: string } = {}) {
  if (!import.meta.env.DEV || !game.offline) throw new Error('Offline DEV required.');
  assertGpuBenchmarkEnvironment();
  const scene = game.sceneRenderer, renderer = scene.renderer, layer = game.world.distantSurface.voxels;
  const device = renderer.backend.device, roots = [scene.playerAvatar, scene.playerFirstPersonHand].filter(Boolean);
  if (!scene.playerAvatarCharacter || scene.remotePlayers.size || !renderer.hasFeature('timestamp-query')
    || !game.world.distantSurface.isEnabled() || game.world.getDistantSurfaceSettings().torusBackfaceCulling)
    throw new Error('Loaded local avatar, no remote players, original far terrain and GPU timestamps required.');
  const saved = { position: game.playerPhysics.position.clone(), yaw: game.controller.yaw, pitch: game.controller.pitch,
    perspective: game.controller.perspective, autoReset: renderer.info.autoReset, track: renderer.backend.trackTimestamp,
    resolution: scene.getResolutionScaleState() };
  const panels = [...document.querySelectorAll<HTMLElement>('#dev-render-diagnostics')], displays = panels.map(p => p.style.display);
  panels.forEach(p => p.style.display = 'none');
  const undo = [guardTimestampWrites(renderer.backend)], timeline = new GpuFrameTimeline(device);
  let role: Role = 'reference', avatarMs = 0, avatarCalls = 0, tick = 0, pending: Promise<void> | null = null;
  renderer.info.autoReset = false; renderer.backend.trackTimestamp = false; scene.setResolutionScale(1);
  undo.push(interceptMethod(scene, 'updatePlayerAvatar', (original, args) => {
    if (role === 'disabled') return;
    const start = performance.now();
    try { return original(...args); } finally { avatarMs += performance.now() - start; avatarCalls++; }
  }));
  undo.push(interceptMethod(scene, 'renderWorld', (original, args) => role === 'reference'
    ? original(...args) : withHiddenObjects(roots, () => original(...args))));
  // Invisible Three groups still update their descendants' world matrices.
  // The disabled role also removes that work without reparenting each frame.
  for (const root of roots) undo.push(interceptMethod(root, 'updateMatrixWorld', (original, args) =>
    role === 'disabled' ? undefined : original(...args)));
  const errors: string[] = [], onError = (event: any) => errors.push(event.error.message);
  device.addEventListener('uncapturederror', onError);
  const inventory = roots.map(root => {
    const row = { name: root.name, objects: 0, meshes: 0, skinnedMeshes: 0, materialSlots: 0 };
    root.traverse((object: any) => { row.objects++; if (object.isMesh) {
      row.meshes++; row.skinnedMeshes += Number(!!object.isSkinnedMesh);
      row.materialSlots += Array.isArray(object.material) ? object.material.length : 1;
    } }); return row;
  });
  const warmMs = options.warmMs ?? 1000, sampleMs = options.sampleMs ?? 2500;
  const result: any = { revision: 'character-frames-v1', tag: options.tag ?? 'comparison', time: new Date().toISOString(),
    world: new URL(location.href).searchParams.get('world'), width: renderer.domElement.width, height: renderer.domElement.height,
    quality: scene.getLightingQuality(), shadows: scene.getShadowsEnabled(), samples: renderer.samples,
    camera: saved.position.toArray(), tool: game.controller.activeTool, inventory, remotePlayers: scene.remotePlayers.size,
    warmMs, sampleMs, adapter: Object.fromEntries(['vendor','architecture','device','description'].map(k => [k, device.adapterInfo?.[k]])),
    commandCaching: layer.getCommandCachingEnabled(), rows: [], errors };
  try {
    for (const config of options.cases ?? CASES) {
      game.controller.setPerspective(config.perspective, false);
      for (const [block, next] of (options.order ?? ORDER).entries()) {
        assertGpuBenchmarkEnvironment(); role = next;
        (window as any).characterProgress = { tag: result.tag, ...config, block, role, completed: result.rows.length };
        const raw: any[] = [], gpu: any[] = [], residentStart = layer.arena.stats.residentFaces;
        let previous = 0, start = 0, finished = false, restore = () => {};
        await new Promise<void>((resolve, reject) => {
          restore = interceptMethod(game, 'animate', (original, args) => {
            if (finished) return original(...args);
            const now = performance.now(), elapsed = start ? now - start : 0, warm = elapsed < warmMs;
            if (!start) start = now;
            const phase = (warm ? elapsed / warmMs : (elapsed - warmMs) / sampleMs) * Math.PI * 2;
            game.controller.yaw = saved.yaw + (config.motion === 'move' ? .6 * Math.sin(phase) : 0);
            game.controller.pitch = saved.pitch; game.playerPhysics.position.copy(saved.position);
            if (config.motion === 'move') { game.playerPhysics.position.x += 16 * Math.sin(phase); game.playerPhysics.position.z += 8 * (1 - Math.cos(phase)); }
            game.playerPhysics.velocity.set(0, 0, 0); game.playerPhysics.resetRenderInterpolation();
            avatarMs = avatarCalls = 0; renderer.info.reset();
            const timed = !warm && ++tick % 6 === 0 && !pending;
            if (timed) timeline.begin();
            try { original(...args); } catch (error) { finished = true; reject(error); return; }
            const cpu = performance.now() - now;
            if (timed) pending = timeline.end().then(row => { if (row) gpu.push(row); })
              .catch(error => { errors.push(String(error)); }).finally(() => { pending = null; });
            if (document.visibilityState !== 'visible' || renderer.domElement.width !== result.width || renderer.domElement.height !== result.height
              || scene.remotePlayers.size || !game.world.distantSurface.isEnabled()) {
              finished = true; reject(new Error('Character benchmark workload changed.')); return;
            }
            if (!warm && previous) raw.push({ frame: now - previous, cpu, avatarMs, avatarCalls,
              calls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles,
              farTriangles: layer.arena.stats.drawnFaces * 2, pending: layer.hasPendingWork || layer.hasPendingTransitions });
            previous = now;
            if (elapsed >= warmMs + sampleMs) { finished = true; resolve(); }
          });
        }).finally(() => restore());
        await pending;
        const metrics = Object.fromEntries(['frame','cpu','avatarMs','calls','triangles','farTriangles']
          .map(key => [key, summarize(raw.map(row => row[key]))]));
        metrics.gpu = summarize(gpu.map(row => row.spanMs));
        result.rows.push({ ...config, block, role, fps: 1000 / metrics.frame.mean, metrics, raw, gpu,
          residentStart, residentEnd: layer.arena.stats.residentFaces, pendingFrames: raw.filter(row => row.pending).length });
      }
    }
    assertGpuBenchmarkEnvironment();
    (window as any).characterProgress = { state: 'complete', tag: result.tag, blocks: result.rows.length, errors };
    return result;
  } finally {
    await pending; role = 'reference'; timeline.dispose(); undo.reverse().forEach(restore => restore());
    device.removeEventListener('uncapturederror', onError);
    renderer.info.autoReset = saved.autoReset; renderer.backend.trackTimestamp = saved.track;
    game.controller.setPerspective(saved.perspective, false);
    game.controller.yaw = saved.yaw; game.controller.pitch = saved.pitch;
    game.playerPhysics.position.copy(saved.position); game.playerPhysics.velocity.set(0, 0, 0); game.playerPhysics.resetRenderInterpolation();
    scene.setResolutionScale(saved.resolution.mode === 'auto' ? 'auto' : saved.resolution.fixedScale);
    panels.forEach((panel, i) => panel.style.display = displays[i]);
  }
}
