import { interceptMethod, guardTimestampWrites } from './FrameDiagnostics.ts';
import { GpuFrameTimeline } from './GpuFrameTimeline.ts';
const host = (parent as any).torusStressHost, terrain = (parent as any).torusStressTerrain;
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const paired = (parent as any).torusStressPaired;
const pickingExperiment = (parent as any).torusStressPicking;
const order = paired ? ['dense','dense','dense','dense','move','move','move','move'] : (parent as any).torusStressFocus ? ['dense', 'move', 'move', 'dense'] : ['control', 'dense', 'turn', 'move', 'move', 'turn', 'dense', 'control'];
const probes: Record<string, number> = {}, undoProbes: (() => void)[] = [];
let game: any, undoPose = () => {}, undoRender = () => {}, undoTerrain = () => {}, unguard = () => {};
let timeline: GpuFrameTimeline | undefined, mode = 'control', phaseStart = 0, frozen = true, terrainCpu = 0, renderCpu = 0;
try {
  for (let n = 0; !document.querySelector('#dev-render-diagnostics'); n++) {
    if (n % 600 === 0) {
      const world = (window as any).game?.world;
      await host.status({ state: 'initializing', message: document.querySelector('#space-entry-status')?.textContent,
        progress: world?.getTerrainAoiLoadProgress(), streaming: world?.getNearTerrainStreamingStats(),
        jobs: world?.inFlightTerrainJobs.map((job: any) => ({ key: job.key, type: job.type })),
        missing: world ? [...world.activeChunkKeys].filter((key: any) => !world.chunks.get(key)?.mesh).slice(0, 8) : [],
        dirty: world ? [...world.dirtyChunks].map((c: any) => `${c.cx},${c.cz}`).slice(0, 8) : [] });
    }
    if (n > 12000) throw Error('Scene initialization timeout'); await tick();
  }
  if (!/Firefox\//.test(navigator.userAgent)) throw Error('Native Firefox required');
  game = (window as any).game;
  const nearVariant = (parent as any).torusStressNear;
  if (nearVariant) {
    game.world.setNearTerrainStreamingOptions({ cache: nearVariant !== 'baseline', workers: ['workers', 'batch', 'scheduled'].includes(nearVariant) ? 2 : 1, parallelPrefetch: nearVariant !== 'scheduled' });
    game.world.nearTerrainBatches.setEnabled(['batch', 'scheduled'].includes(nearVariant));
  }
  const scene = game.sceneRenderer, renderer = scene.renderer, layer = game.world.distantSurface.voxels, arena = layer.arena;
  if ('incrementalMapUploads' in arena) arena.incrementalMapUploads = (parent as any).torusStressMapUploads;
  if (!game.offline || game.world.terrainGen.version < 11 || innerWidth !== 1280 || innerHeight !== 720) throw Error('Invalid fixture');
  game.uiStore.startGame(false); game.uiStore.setDistantSurfaceEnabled(true, false); game.world.setRenderDistance(8, 8);
  game.world.distantSurface.setSettings({ renderDistanceChunks: 576, subdivisionSizePx2: 64, dataBudgetMiB: 1024, geometryBudgetMiB: 512, torusBackfaceCulling: false });
  game.uiStore.setWorldProjection('torus', false); layer.setFixedCellSizeForBenchmark(1); layer.setIdleMaintenanceEnabled(true); arena.setTightIdleCullingEnabled(false);
  scene.setLightingQuality('medium'); scene.setShadowsEnabled(false); scene.scene.fog.density = 0; scene.setResolutionScale(1);
  scene.camera.far = 16384; scene.camera.updateProjectionMatrix(); game.controller.setFov(70);
  const pose = () => {
    const seconds = frozen ? 0 : (performance.now() - phaseStart) / 1000, phase = seconds * Math.PI / 3;
    const x = 8192.5 + (mode === 'move' ? 64 * Math.sin(phase) : 0), z = 1024.5 + (mode === 'move' ? 32 * Math.sin(phase * 2) : 0);
    game.playerPhysics.isFlying = true; game.playerPhysics.position.set(x, 180 - game.playerPhysics.eyeHeight, z);
    game.playerPhysics.velocity.set(0, 0, 0); game.playerPhysics.resetRenderInterpolation();
    game.controller.yaw = mode === 'turn' ? Math.PI / 2 * Math.sin(phase) : 0;
    game.controller.pitch = -(mode === 'control' ? 18 : 55) * Math.PI / 180;
  };
  undoPose = interceptMethod(game, 'animate', (original, args) => { pose(); return original(...args); });
  undoRender = interceptMethod(scene, 'render', (original, args) => {
    if (scene.playerFirstPersonHand) scene.playerFirstPersonHand.visible = false;
    const start = performance.now(); try { return original(...args); } finally { renderCpu += performance.now() - start; }
  });
  pose();
  for (let n = 0, stable = 0; stable < 180; n++) {
    await tick(); const surface = (window as any).offlineSurfaceStatus;
    if (surface?.error || layer.preparationError) throw Error(surface?.error || layer.preparationError);
    stable = surface?.generated === 8 && surface?.fineZones === 8 && !layer.hasPendingWork && !layer.hasPendingTransitions && game.world.getTerrainAoiLoadProgress().ready ? stable + 1 : 0;
    if (n % 120 === 0) await host.status({ state: 'preparing', surface, stable });
    if (n > 36000) throw Error('Terrain settle timeout');
  }
  await host.status({ state: 'steady warmup' }); const warmUntil = performance.now() + 60000;
  while (performance.now() < warmUntil) await tick();
  document.querySelectorAll<HTMLElement>('#root,#dev-render-diagnostics').forEach(e => e.style.visibility = 'hidden');
  const device = renderer.backend.device, adapter = renderer.backend.adapter;
  const result: any = { schema: 'torus-stress-firefox-v1', terrain, userAgent: navigator.userAgent, width: renderer.domElement.width, height: renderer.domElement.height,
    nearVariant, experiment: pickingExperiment ? 'picking' : 'near-streaming', streamingStart: game.world.getNearTerrainStreamingStats(),
    samples: renderer.samples, settings: game.world.distantSurface.getSettings(), nearChunks: 8, farChunks: 576, fixedCellSize: 1, incrementalMapUploads: arena.incrementalMapUploads ?? false,
    adapter: Object.fromEntries(['vendor','architecture','device','description'].map(k => [k, adapter?.info?.[k] ?? ''])), rows: [], errors: [] };
  if (result.width !== 2560 || result.height !== 1440 || result.samples !== 0) throw Error('Framebuffer mismatch');
  if (!device.features.has('timestamp-query')) throw Error('GPU timestamp-query unavailable');
  device.addEventListener('uncapturederror', (event: any) => result.errors.push(event.error.message));
  undoTerrain = interceptMethod(layer, 'updateView', (original, args) => { const start = performance.now(); try { return original(...args); } finally { terrainCpu += performance.now() - start; } });
  for (const [target, key, name] of [
    [renderer, 'render', 'draw'], [game.world, 'updateChunksAround', 'streamWindow'],
    [game.world, 'processInteractiveTerrainWork', 'publish'], [game.controller, 'updateAimRaycast', 'picking'],
    [arena, 'sync', 'arena'], [game.world.distantSurface, 'updateHandoffs', 'handoff'],
  ] as const) undoProbes.push(interceptMethod(target, key, (original, args) => {
    const start = performance.now(); try { return original(...args); } finally { probes[name] = (probes[name] ?? 0) + performance.now() - start; }
  }));
  renderer.backend.trackTimestamp = false; renderer.info.autoReset = false; unguard = guardTimestampWrites(renderer.backend); timeline = new GpuFrameTimeline(device);
  const canvas = document.createElement('canvas'); canvas.width = 2560; canvas.height = 1440; const ctx = canvas.getContext('2d')!;
  let pending: Promise<void> | undefined, serial = 0;
  for (const [block, nextMode] of order.entries()) {
    const reference = block % 4 === 0 || block % 4 === 3;
    const variant = pickingExperiment ? (reference ? 'reference' : 'discovery') : paired ? (reference ? 'baseline' : 'scheduled') : nearVariant;
    if (pickingExperiment) {
      game.world.aimRaycastDiscoveryOptimized = !reference;
    } else if (paired) {
      game.world.setNearTerrainStreamingOptions({ cache: variant !== 'baseline', workers: variant === 'baseline' ? 1 : 2, parallelPrefetch: false });
      game.world.nearTerrainBatches.setEnabled(variant !== 'baseline');
    }
    mode = nextMode; frozen = false; const fov = mode === 'control' ? 70 : 100; game.controller.setFov(fov);
    await host.status({ state: 'sampling', block, mode, variant });
    const raw: any[] = [], gpu: any[] = []; let previous = 0, started = false, undo = () => {};
    await new Promise<void>((resolve, reject) => {
      undo = interceptMethod(game, 'animate', (original, args) => {
        const now = performance.now(); if (!started) { phaseStart = now; started = true; }
        const elapsed = (now - phaseStart) / 1000, timed = elapsed >= 6 && ++serial % 6 === 0 && !pending;
        terrainCpu = renderCpu = 0; for (const key of Object.keys(probes)) probes[key] = 0;
        renderer.info.reset(); if (timed) timeline!.begin(); original(...args); const cpu = performance.now() - now;
        if (timed) pending = timeline!.end().then(value => { if (value) gpu.push(value); }).finally(() => { pending = undefined; });
        const actualFov = Math.atan(1 / scene.camera.projectionMatrix.elements[5]) * 360 / Math.PI;
        if (document.visibilityState !== 'visible' || renderer.domElement.width !== 2560 || renderer.domElement.height !== 1440 || Math.abs(actualFov - fov) > .001) { reject(Error('Visibility, size or actual FOV changed')); return; }
        if (elapsed >= 6 && previous) raw.push({ frame: now - previous, phaseSeconds: elapsed, cpu, terrainCpu, renderCpu, probes: { ...probes },
          calls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles, visibleFaces: arena.stats.visibleFaces, residentFaces: arena.stats.residentFaces,
          farPending: layer.hasPendingWork || layer.hasPendingTransitions, nearReady: game.world.getTerrainAoiLoadProgress().ready,
          nearProgress: game.world.getTerrainAoiLoadProgress(), streaming: game.world.getNearTerrainStreamingStats(), nearBatch: game.world.nearTerrainBatches.getStats(),
          nearChunks: game.world.chunks.size, arenaMapBytes: arena.stats.mapUploadBytes, arenaMaintenance: arena.stats.maintenancePasses });
        previous = now; if (elapsed >= 18) resolve();
      });
    }).finally(() => undo());
    await pending; frozen = true; pose();
    result.rows.push({ block, mode, variant, fov, effectiveFov: Math.atan(1 / scene.camera.projectionMatrix.elements[5]) * 360 / Math.PI, capturePhaseSeconds: 0, raw, gpu,
      lod: layer.group.userData.voxelLodStats, sourceMips: [...layer.zones.values()].map((z: any) => ({ x: z.snapshot.zoneX, z: z.snapshot.zoneZ, sizes: z.snapshot.voxelMips.map((m: any) => m.cellSize) })) });
    await host.save('result.json', result); for (let i = 0; i < 4; i++) await tick();
    const png = await new Promise<string>(resolve => {
      const undo = interceptMethod(scene, 'render', (original, args) => { const value = original(...args); ctx.drawImage(renderer.domElement, 0, 0); undo(); resolve(canvas.toDataURL()); return value; });
    });
    await host.save(`stress-${block}-${mode}.png`, png);
  }
  // ABBA ends in motion. Returning to phase zero can still be loading chunks
  // and advancing ownership fades; compare pixels only after both settle.
  mode = 'dense'; frozen = true; pose();
  await host.status({ state: 'settling pixel reference' });
  for (let n = 0, stable = 0; stable < 120; n++) {
    await tick();
    stable = game.world.getTerrainAoiLoadProgress().ready && !layer.hasPendingWork
      && !layer.hasPendingTransitions && game.world.distantSurface.handoff.changes.size === 0 ? stable + 1 : 0;
    if (n > 7200) throw Error('Pixel reference failed to settle');
  }
  if (pickingExperiment) {
    const saved = game.world.aimRaycastDiscoveryOptimized;
    const query = (optimized: boolean) => {
      game.world.aimRaycastDiscoveryOptimized = optimized;
      const hit = game.controller.performAimRaycast('all');
      return JSON.stringify({ kind: hit.kind, worldHit: hit.worldHit,
        entityDistance: hit.entityHit?.distance, entityId: hit.entityHit?.entityId });
    };
    result.pickingEquality = query(false) === query(true);
    game.world.aimRaycastDiscoveryOptimized = saved;
    if (!result.pickingEquality) throw Error('Picking reference mismatch');
  }
  if ('incrementalMapUploads' in arena) {
    const saved = arena.incrementalMapUploads;
    const capture = (incremental: boolean) => {
      arena.incrementalMapUploads = incremental; arena.visibilityDirty = true;
      arena.restoreSources(); arena.sync(Infinity);
      scene.render(false, true); scene.render(false, true); ctx.drawImage(renderer.domElement, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const reference = capture(false), optimized = capture(true); let changedPixels = 0;
    for (let i = 0; i < reference.length; i += 4) if (reference[i] !== optimized[i] || reference[i + 1] !== optimized[i + 1] || reference[i + 2] !== optimized[i + 2] || reference[i + 3] !== optimized[i + 3]) changedPixels++;
    result.mapUploadPixelCheck = { changedPixels, pixels: canvas.width * canvas.height, pose: 'settled dense phase 0' };
    arena.incrementalMapUploads = saved;
    await host.save('result.json', result);
    if (changedPixels) throw Error(`Map upload pixel mismatch: ${changedPixels}`);
  }
  result.streamingEnd = game.world.getNearTerrainStreamingStats();
  const batchCapture = (enabled: boolean) => {
    game.world.nearTerrainBatches.setEnabled(enabled);
    scene.render(false, true); scene.render(false, true); ctx.drawImage(renderer.domElement, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  const batchesEnabled = game.world.nearTerrainBatches.getStats().enabled;
  const plain = batchCapture(false), plainPng = canvas.toDataURL();
  const batched = batchCapture(true), batchPng = canvas.toDataURL(); let changed = 0;
  const changedSamples: number[][] = [];
  for (let i = 0; i < plain.length; i += 4) if (plain[i] !== batched[i] || plain[i+1] !== batched[i+1] || plain[i+2] !== batched[i+2] || plain[i+3] !== batched[i+3]) { changed++; if (changedSamples.length < 100) changedSamples.push([i/4 % canvas.width, Math.floor(i/4 / canvas.width), ...plain.slice(i,i+4), ...batched.slice(i,i+4)]); }
  result.nearBatchPixelCheck = { changedPixels: changed, pixels: canvas.width * canvas.height, changedSamples };
  game.world.nearTerrainBatches.setEnabled(batchesEnabled);
  await host.save('near-plain.png', plainPng); await host.save('near-batch.png', batchPng);
  await host.save('result.json', result);
  if (changed) throw Error(`Near bundle pixel mismatch: ${changed}`);
  await host.status({ state: 'complete', blocks: result.rows.length, errors: result.errors });
} catch (error) { await host.status({ state: 'FAILED', error: String(error) }); }
finally { undoPose(); undoRender(); undoTerrain(); undoProbes.reverse().forEach(undo => undo()); timeline?.dispose(); unguard(); }
