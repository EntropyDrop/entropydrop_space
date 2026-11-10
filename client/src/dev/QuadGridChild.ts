import { interceptMethod, guardTimestampWrites } from './FrameDiagnostics.ts';
import { GpuFrameTimeline } from './GpuFrameTimeline.ts';
import { createQuadGridTrial, QUAD_GRID_MODES, type QuadGridMode } from './QuadGridTrial.ts';

const host = (parent as any).torusStressHost, terrain = (parent as any).torusStressTerrain;
const options = (parent as any).quadGridOptions;
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
let game: any, trial: ReturnType<typeof createQuadGridTrial> | undefined, timeline: GpuFrameTimeline | undefined;
const undo: (() => void)[] = [];
let motion = 'dense', frozen = true, phaseStart = 0, nearView = false, nearEye = 150;
let pending: Promise<void> | undefined;
const errors: string[] = [], result: any = { schema: 'quad-grid-firefox-v1', experiment: 'quad-grid', terrain, options, rows: [], checks: {}, errors };
const failed = (event: ErrorEvent) => { errors.push(event.message); };
window.addEventListener('error', failed);
undo.push(interceptMethod(console, 'error', (original, args) => {
  errors.push(args.map(String).join(' ')); return original(...args);
}));
try {
  for (let n = 0; !document.querySelector('#dev-render-diagnostics'); n++) {
    if (n % 300 === 0) await host.status({ state: 'initializing', message: document.querySelector('#space-entry-status')?.textContent,
      progress: (window as any).game?.world?.getTerrainAoiLoadProgress() });
    if (n > 18000) throw Error('Scene initialization timed out'); await tick();
  }
  game = (window as any).game;
  if (!/Firefox\//.test(navigator.userAgent) || !game.offline || terrain !== 'aether-archipelago' || innerWidth !== 1280 || innerHeight !== 720)
    throw Error('Native Firefox / offline Aether / 1280 x 720 required');
  const world = game.world, scene = game.sceneRenderer, renderer = scene.renderer, layer = world.distantSurface.voxels, arena = layer.arena;
  const device = renderer.backend.device;
  device.addEventListener('uncapturederror', (event: any) => errors.push(event.error.message));
  game.uiStore.startGame(false); game.uiStore.setDistantSurfaceEnabled(true, false);
  world.setRenderDistance(8, 8);
  world.setNearTerrainStreamingOptions({ cache: true, workers: 2, parallelPrefetch: false });
  world.nearTerrainBatches.setEnabled(true);
  world.distantSurface.setSettings({ renderDistanceChunks: 576, subdivisionSizePx2: 64, dataBudgetMiB: 1024,
    geometryBudgetMiB: 512, torusBackfaceCulling: false, textureProxyEnabled: false });
  game.uiStore.setWorldProjection('torus', false);
  layer.setFixedCellSizeForBenchmark(options.fixedLod ? 1 : undefined);
  scene.setLightingQuality('medium'); scene.setShadowsEnabled(false); scene.scene.fog.density = 0; scene.setResolutionScale(1);
  scene.camera.far = 16384; scene.camera.updateProjectionMatrix(); game.controller.setFov(100);
  function pose() {
    const phase = (frozen ? 0 : (performance.now() - phaseStart) / 1000) * Math.PI / 3;
    const x = 8192.5 + (motion === 'move' ? 64 * Math.sin(phase) : 0), z = 1024.5 + (motion === 'move' ? 32 * Math.sin(phase * 2) : 0);
    game.playerPhysics.isFlying = true; game.playerPhysics.position.set(x, (nearView ? nearEye : 180) - game.playerPhysics.eyeHeight, z);
    game.playerPhysics.velocity.set(0, 0, 0); game.playerPhysics.resetRenderInterpolation();
    game.controller.yaw = 0; game.controller.pitch = -(nearView ? 35 : 55) * Math.PI / 180;
  }
  undo.push(interceptMethod(game, 'animate', (original, args) => { pose(); return original(...args); }));
  undo.push(interceptMethod(scene, 'render', (original, args) => {
    if (scene.playerFirstPersonHand) scene.playerFirstPersonHand.visible = false;
    return original(...args);
  }));
  async function settle() {
    for (let n = 0, stable = 0; stable < 120; n++) {
      await tick(); const surface = (window as any).offlineSurfaceStatus;
      if (surface?.error || layer.preparationError || errors.length) throw Error(errors.join('\n') || surface?.error || layer.preparationError);
      stable = surface?.generated === 8 && (!options.fixedLod || surface?.fineZones === 8) && !layer.hasPendingWork && !layer.hasPendingTransitions
        && world.getTerrainAoiLoadProgress().ready && !world.distantSurface.handoff.changes.size ? stable + 1 : 0;
      if (n % 300 === 0) await host.status({ state: 'settling', stable, surface, progress: world.getTerrainAoiLoadProgress() });
      if (n > 24000) throw Error('Terrain settle timeout');
    }
  }
  await settle();
  // The old fixed low pose can enter an island building. Place the close view
  // twelve metres above the highest solid cell in the already resident column.
  for (let y = 255; y >= 0; y--) if (world.getBlock(8192, y, 1024)) { nearEye = y + 13; break; }
  document.querySelectorAll<HTMLElement>('#root,#dev-render-diagnostics').forEach(e => e.style.visibility = 'hidden');
  Object.assign(result, { userAgent: navigator.userAgent, width: renderer.domElement.width, height: renderer.domElement.height,
    samples: renderer.samples, settings: world.distantSurface.getSettings(), nearChunks: 8, fixedCellSize: layer.getFixedCellSizeForBenchmark() ?? null,
    fov: 100, warmupSeconds: 6, sampleSeconds: 6, streaming: world.getNearTerrainStreamingStats(),
    adapter: Object.fromEntries(['vendor','architecture','device','description'].map(k => [k, renderer.backend.adapter?.info?.[k] ?? ''])) });
  if (result.width !== 2560 || result.height !== 1440 || result.samples !== 0 || !device.features.has('timestamp-query')) throw Error('Framebuffer or timestamp mismatch');
  trial = createQuadGridTrial(game);
  const canvas = document.createElement('canvas'); canvas.width = result.width; canvas.height = result.height;
  const ctx = canvas.getContext('2d')!;
  function capture() {
    scene.render(false, true); scene.render(false, true); ctx.drawImage(renderer.domElement, 0, 0);
    return { pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data, png: canvas.toDataURL(), stats: { ...trial!.stats } };
  }
  function differences(a: Uint8ClampedArray, b: Uint8ClampedArray) {
    let exact = 0, visible = 0;
    for (let i = 0; i < a.length; i += 4) {
      const difference = Math.max(Math.abs(a[i]-b[i]), Math.abs(a[i+1]-b[i+1]), Math.abs(a[i+2]-b[i+2]), Math.abs(a[i+3]-b[i+3]));
      if (difference) exact++; if (difference > 2) visible++;
    }
    return { exact, visible, pixels: canvas.width * canvas.height };
  }
  async function images(name: 'dense' | 'near') {
    await host.status({ state: 'image validation', view: name });
    nearView = name === 'near'; frozen = true; pose(); await settle();
    // Stop animation only outside timing; both ends of restoration share every
    // uniform and the same published terrain/ownership generation.
    let paused = false;
    const resume = interceptMethod(game, 'animate', () => { paused = true; });
    while (!paused) await tick();
    try {
      // Compile every pipeline and rebuild each bundle before the reference.
      // The initial production bundle predates the experiment's edge resources.
      for (const variant of QUAD_GRID_MODES) { trial!.set(variant); capture(); }
      trial!.set('original'); capture();
      const captures: Record<string, ReturnType<typeof capture>> = {};
      for (const variant of QUAD_GRID_MODES) {
        trial!.set(variant); captures[variant] = capture();
        await host.save(`grid-${name}-${variant}.png`, captures[variant].png);
      }
      trial!.setDepthEnabled(false); captures['no-depth'] = capture();
      await host.save(`grid-${name}-no-depth.png`, captures['no-depth'].png);
      trial!.setDepthEnabled(true); const restoredGrid = capture();
      trial!.set('original'); const restoredOriginal = capture();
      const repeatedOriginal = capture();
      const check = { eye: [8192.5, nearView ? nearEye : 180, 1024.5], pitch: nearView ? 35 : 55,
        restoration: differences(captures.original.pixels, restoredOriginal.pixels),
        originalRepeat: differences(restoredOriginal.pixels, repeatedOriginal.pixels),
        depthRestoration: differences(captures.grid.pixels, restoredGrid.pixels),
        occlusionEffect: differences(captures.grid.pixels, captures['no-depth'].pixels),
        unlitDifference: differences(captures.original.pixels, captures.unlit.pixels),
        gridDifference: differences(captures.original.pixels, captures.grid.pixels),
        variants: Object.fromEntries(QUAD_GRID_MODES.map(v => [v, captures[v].stats])),
        lod: layer.group.userData.voxelLodStats };
      result.checks[name] = check; await host.save('result.json', result);
      if (check.restoration.exact || check.depthRestoration.exact) throw Error('Frozen image restoration mismatch');
      if (check.occlusionEffect.visible < 100) throw Error('Depth hiding had no measurable image effect');
      if (!check.variants.original.nearDraws || !check.variants.original.farDraws) throw Error('Missing near/far terrain');
      if (!QUAD_GRID_MODES.every(v => check.variants[v].terrainTriangles === check.variants.original.terrainTriangles)) throw Error('Changed terrain geometry');
      if (errors.length) throw Error(errors.join('\n'));
    } finally { resume(); requestAnimationFrame(game.animate); }
  }
  await images('dense'); await images('near'); nearView = false; await settle();
  if (!options.preview) {
    // Precompile each role, then exercise the complete moving path before timing.
    motion = 'move'; frozen = false; phaseStart = performance.now();
    for (const variant of QUAD_GRID_MODES) {
      trial.set(variant); await host.status({ state: 'warming moving path', variant });
      const until = performance.now() + 18000; while (performance.now() < until) await tick();
    }
    renderer.backend.trackTimestamp = false; renderer.info.autoReset = false;
    undo.push(guardTimestampWrites(renderer.backend)); timeline = new GpuFrameTimeline(device);
    const probes: Record<string, number> = {};
    for (const [target, key, name] of [[renderer, 'render', 'draw'], [world, 'updateChunksAround', 'stream'],
      [game.controller, 'updateAimRaycast', 'picking'], [layer, 'updateView', 'far']] as const)
      undo.push(interceptMethod(target, key, (original, args) => {
        const start = performance.now(); try { return original(...args); } finally { probes[name] = (probes[name] ?? 0) + performance.now() - start; }
      }));
    const permutations = [[0,1,2],[2,1,0],[1,2,0],[0,2,1],[2,0,1],[1,0,2]];
    let serial = 0, block = 0;
    for (const nextMotion of options.movingOnly ? ['move'] : ['dense', 'move']) {
      motion = nextMotion;
      for (const permutation of permutations) for (const index of permutation) {
        const variant: QuadGridMode = QUAD_GRID_MODES[index]; trial.set(variant); frozen = false;
        await host.status({ state: 'sampling', block, blocks: options.movingOnly ? 18 : 36, motion, variant });
        const raw: any[] = [], gpu: any[] = []; let previous = 0, started = false, endBlock = () => {};
        await new Promise<void>((resolve, reject) => {
          endBlock = interceptMethod(game, 'animate', (original, args) => {
            try {
              const now = performance.now(); if (!started) { phaseStart = now; started = true; }
              const elapsed = (now - phaseStart) / 1000, sampled = elapsed >= 6, timed = sampled && ++serial % 6 === 0 && !pending;
              for (const key of Object.keys(probes)) probes[key] = 0;
              renderer.info.reset(); if (timed) timeline!.begin(); original(...args); const cpu = performance.now() - now;
              if (timed) pending = timeline!.end().then(value => { if (value) gpu.push(value); }).finally(() => { pending = undefined; });
              const fov = Math.atan(1 / scene.camera.projectionMatrix.elements[5]) * 360 / Math.PI;
              const focused = parent.document.hasFocus();
              if (document.visibilityState !== 'visible' || !focused || renderer.domElement.width !== 2560 || renderer.domElement.height !== 1440 || Math.abs(fov - 100) > .001 || errors.length)
                throw Error(`Visibility/focus, dimensions, FOV, or errors changed: focused=${focused}; ${errors.join('\n')}`);
              if (sampled && previous) raw.push({ frame: now - previous, cpu, phaseSeconds: elapsed, probes: { ...probes },
                focused,
                calls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles, trial: { ...trial!.stats },
                visibleFaces: arena.stats.visibleFaces, residentFaces: arena.stats.residentFaces,
                progress: world.getTerrainAoiLoadProgress(), streaming: world.getNearTerrainStreamingStats(),
                farPending: layer.hasPendingWork || layer.hasPendingTransitions, nearBatch: world.nearTerrainBatches.getStats() });
              previous = now; if (elapsed >= 12) resolve();
            } catch (error) { reject(error); }
          });
        }).finally(() => endBlock());
        await pending; frozen = true;
        result.rows.push({ block: block++, motion, variant, raw, gpu, lod: layer.group.userData.voxelLodStats,
          sourceMips: [...layer.zones.values()].map((z: any) => ({ x: z.snapshot.zoneX, z: z.snapshot.zoneZ, sizes: z.snapshot.voxelMips.map((m: any) => m.cellSize) })) });
        await host.save('result.json', result);
      }
    }
  }
  trial.set('original');
  await host.save('result.json', result);
  await host.status({ state: 'complete', preview: options.preview, blocks: result.rows.length, errors });
} catch (error) {
  result.failure = String(error); await host.save('result.json', result);
  await host.status({ state: 'FAILED', error: String(error), errors });
} finally {
  await pending; timeline?.dispose(); undo.reverse().forEach(fn => fn()); trial?.dispose();
  window.removeEventListener('error', failed);
}
