import { interceptMethod, guardTimestampWrites } from './FrameDiagnostics.ts';
import { GpuFrameTimeline } from './GpuFrameTimeline.ts';
import { assertGpuBenchmarkEnvironment } from './GpuBenchmarkEnvironment.ts';
import { createTiltShiftRenderer } from './TiltShiftRenderer.ts';

type Mode = 'baseline' | 'blur' | 'lod' | 'tilt';
type Quality = 'medium' | 'low';
const cameraViews = ['ring', 'skyline', 'overlook'] as const;
type CameraView = typeof cameraViews[number];
type CaptureHost = {
  captureOnly: boolean;
  fullCoarse: boolean;
  save(name: string, payload: unknown): Promise<void>;
  status(state: string, details?: unknown): Promise<void>;
};
type SurfaceProgress = {
  generated: number; total: number; installed: number; mode: string; downloads: number;
  sourceBytes?: number; coarsestFaces?: number;
};
const orders: Mode[][] = [
  ['baseline', 'blur', 'lod', 'tilt'],
  ['tilt', 'lod', 'blur', 'baseline'],
  ['blur', 'baseline', 'tilt', 'lod'],
  ['lod', 'tilt', 'baseline', 'blur'],
];
const warmMs = 1200;
const sampleMs = 3000;
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const loop = Math.PI * 2;
const areaFor = (mode: Mode) => mode === 'lod' || mode === 'tilt' ? 256 : 64;
const blurFor = (mode: Mode) => mode === 'blur' || mode === 'tilt';

export async function runTiltShiftTrial(game: any, host: CaptureHost, surface: SurfaceProgress) {
  const scene = game.sceneRenderer;
  const renderer = scene.renderer;
  const device = renderer.backend.device;
  const distant = game.world.distantSurface;
  const layer = distant.voxels;
  const seenErrors: string[] = [];
  const testOrders: Mode[][] = host.fullCoarse
    ? [['baseline', 'tilt'], ['tilt', 'baseline'], ['tilt', 'baseline'], ['baseline', 'tilt']]
    : orders;
  if (!game.offline || game.world.terrainGen.version !== 3 || game.world.terrainGen.seed !== 42 ||
      !renderer.backend.isWebGPUBackend || !renderer.hasFeature('timestamp-query') ||
      surface.installed !== surface.total || (host.fullCoarse && surface.installed !== 128))
    throw new Error('Aether seed 42, complete fixture coverage and native WebGPU timestamp queries are required.');
  assertGpuBenchmarkEnvironment();

  const saved = {
    camera: game.playerPhysics.position.clone(), yaw: game.controller.yaw, pitch: game.controller.pitch,
    quality: scene.getLightingQuality(), shadows: scene.getShadowsEnabled(), resolution: scene.getResolutionScaleState(),
    settings: distant.getSettings(), fixedSize: layer.getFixedCellSizeForBenchmark(), tracking: renderer.backend.trackTimestamp, autoReset: renderer.info.autoReset,
  };
  const panel = document.querySelector<HTMLElement>('#dev-render-diagnostics');
  const display = panel?.style.display;
  if (panel) panel.style.display = 'none';
  scene.setResolutionScale(1);
  scene.setShadowsEnabled(false);
  renderer.backend.trackTimestamp = false;
  renderer.info.autoReset = false;
  const guard = guardTimestampWrites(renderer.backend);
  const timeline = new GpuFrameTimeline(device);
  const tilt = createTiltShiftRenderer(scene);
  const gpuError = (event: any) => seenErrors.push(event.error.message);
  device.addEventListener('uncapturederror', gpuError);

  function pose(phase: number, view: CameraView = host.fullCoarse ? 'ring' : 'overlook') {
    const theta = Math.min(1, Math.max(0, phase)) * loop;
    game.playerPhysics.position.copy(saved.camera);
    game.playerPhysics.position.x += 12 * Math.sin(theta);
    game.playerPhysics.position.z += 6 * (1 - Math.cos(theta));
    game.playerPhysics.velocity.set(0, 0, 0);
    game.playerPhysics.resetRenderInterpolation();
    const camera = {
      ring: { pitch: 1.22, pitchTravel: 0.10, yawTravel: 0.25 },
      skyline: { pitch: 0.18, pitchTravel: 0, yawTravel: 0.18 },
      overlook: { pitch: -0.63, pitchTravel: 0.12, yawTravel: 0.48 },
    }[view];
    game.controller.yaw = Math.PI / 2 + camera.yawTravel * Math.sin(theta);
    game.controller.pitch = camera.pitch + camera.pitchTravel * Math.sin(theta * 2);
  }

  function terrain() {
    return { detail: distant.getDetailStatus(), resident: layer.arena?.stats.residentFaces ?? 0,
      plannerFaces: layer.group.userData.voxelLodStats?.faces, coverage: distant.loadedZones.size,
      fixedSize: layer.getFixedCellSizeForBenchmark() ?? null,
      pending: distant.hasPendingWork, downloads: surface.downloads, preparationError: distant.preparationError };
  }

  async function settle(mode: Mode) {
    const area = host.fullCoarse ? 64 : areaFor(mode);
    const fixed = host.fullCoarse && mode === 'tilt' ? 64 : undefined;
    layer.setFixedCellSizeForBenchmark(fixed);
    if (distant.getSettings().subdivisionSizePx2 !== area) distant.setSettings({ subdivisionSizePx2: area });
    pose(0);
    let stableSince = 0;
    const deadline = performance.now() + 90000;
    while (performance.now() < deadline) {
      await tick();
      const { detail, resident, pending, plannerFaces, preparationError } = terrain();
      if (preparationError) throw new Error(preparationError);
      if (document.visibilityState !== 'visible') throw new Error('Firefox benchmark became hidden.');
      const expectedPlan = !host.fullCoarse || (fixed === 64
        ? plannerFaces === surface.coarsestFaces
        : plannerFaces > (surface.coarsestFaces ?? 0));
      if (resident > 0 && !pending && detail.effectiveAreaPx2 >= area && expectedPlan) {
        stableSince ||= performance.now();
        if (performance.now() - stableSince >= 500) return;
      } else stableSince = 0;
    }
    throw new Error('Far terrain did not settle: ' + JSON.stringify(terrain()));
  }

  function capture(view: CameraView = 'overlook') {
    return new Promise<Blob>((resolve, reject) => {
      const undo = interceptMethod(game, 'animate', (original, args) => {
        undo();
        try {
          pose(0.125, view);
          original(...args);
          const source = renderer.domElement as HTMLCanvasElement;
          const canvas = document.createElement('canvas');
          canvas.width = source.width;
          canvas.height = source.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(source, 0, 0);
          const sample = context.getImageData(0, 0, 32, 32).data;
          if (!sample.some((value, i) => i % 4 !== 3 && value))
            throw new Error('Screenshot is blank.');
          canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Screenshot encoding failed.')), 'image/png');
        } catch (error) { reject(error); }
      });
    });
  }

  await tick();
  const width = renderer.domElement.width;
  const height = renderer.domElement.height;
  type Frame = { frameMs: number; cpuMs: number; draws: number; triangles: number; farFaces: number;
    residentFaces: number; pending: boolean };
  type Gpu = NonNullable<Awaited<ReturnType<GpuFrameTimeline['end']>>> & { frame: number };
  type Block = { quality: Quality; mode: Mode; round: number; area: number; start: ReturnType<typeof terrain>;
    end: ReturnType<typeof terrain>; frames: Frame[]; gpu: Gpu[] };
  const results = {
    started: new Date().toISOString(), userAgent: navigator.userAgent, renderer: 'Three r183 WebGPU',
    world: 'aether-archipelago', seed: 42, generator: 3,
    surface: { ...surface },
    width, height, css: [innerWidth, innerHeight], samples: renderer.samples,
    shadows: scene.getShadowsEnabled(), resolutionScale: scene.getResolutionScaleState(),
    initialDistantSettings: saved.settings, cameraOrigin: saved.camera.toArray(), fov: scene.camera.fov,
    cameraPath: host.fullCoarse
      ? 'Across the ring: 12 m x amplitude, 6 m z amplitude, yaw pi/2 ± .25, pitch 1.22 ± .10, one cycle per block'
      : '12 m x amplitude, 6 m z amplitude, yaw pi/2 ± .48, pitch -.63 ± .12, one cycle per block',
    blur: 'Quarter width/height, two five-tap separable passes, blended into the existing output conversion',
    warmMs, sampleMs, rows: [] as Block[], errors: seenErrors,
  };
  const expectedDpr = Number(new URL(location.href).searchParams.get('dev_dpr'));
  let pending: Promise<void> | undefined;
  const captures = new Set<string>();

  function checkFrame() {
    if (document.visibilityState !== 'visible' || renderer.domElement.width !== width ||
        renderer.domElement.height !== height || !distant.isEnabled())
      throw new Error('Firefox visibility, framebuffer size or terrain state changed.');
    if (host.fullCoarse && distant.loadedZones.size !== 128) throw new Error('Full-world coverage changed.');
    if (seenErrors.length) throw new Error(seenErrors.join('; '));
  }

  async function block(quality: Quality, mode: Mode, round: number) {
    const area = host.fullCoarse ? 64 : areaFor(mode);
    tilt.setEnabled(blurFor(mode));
    await host.status('Preparing ' + quality + ' / ' + mode, { round, completed: results.rows.length, terrain: terrain() });
    await settle(mode);
    const frames: Frame[] = [];
    const gpu: Gpu[] = [];
    const startTerrain = terrain();
    let started = -1, previous = -1, frameCount = 0, finished = false;
    let undo = () => {};
    await new Promise<void>((resolve, reject) => {
      undo = interceptMethod(game, 'animate', (original, args) => {
        if (finished) return original(...args);
        try {
          checkFrame();
          const now = performance.now();
          if (started < 0) started = now;
          const elapsed = now - started;
          const measured = elapsed >= warmMs && previous >= 0;
          pose(measured ? (elapsed - warmMs) / sampleMs : elapsed / warmMs);
          renderer.info.reset();
          const timeGpu = measured && ++frameCount % 6 === 0 && !pending;
          if (timeGpu) timeline.begin();
          const cpuStart = performance.now();
          original(...args);
          const cpuMs = performance.now() - cpuStart;
          if (timeGpu) {
            const frame = frames.length;
            pending = timeline.end().then(row => { if (row) gpu.push({ frame, ...row }); })
              .catch(error => { seenErrors.push(String(error)); }).finally(() => { pending = undefined; });
          }
          if (measured) frames.push({ frameMs: now - previous, cpuMs,
            draws: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles,
            farFaces: layer.arena.stats.visibleFaces, residentFaces: layer.arena.stats.residentFaces,
            pending: distant.hasPendingWork });
          previous = now;
          if (elapsed >= warmMs + sampleMs) { finished = true; resolve(); }
        } catch (error) { finished = true; reject(error); }
      });
    }).finally(() => undo());
    await pending;
    checkFrame();
    if (gpu.length < 10) throw new Error('Insufficient accepted GPU timestamps: ' + gpu.length);
    results.rows.push({ quality, mode, round, area, start: startTerrain, end: terrain(), frames, gpu });
    await captureComparison(quality, mode);
    await host.status('Measured ' + quality + ' / ' + mode, { round, completed: results.rows.length,
      frames: frames.length, gpuSamples: gpu.length, terrain: terrain() });
  }

  async function captureComparison(quality: Quality, mode: Mode) {
    const key = quality + '-' + mode;
    if (captures.has(key)) return;
    if (host.fullCoarse) {
      for (const view of cameraViews) await host.save(key + '-' + view + '.png', await capture(view));
    } else await host.save(key + '.png', await capture());
    captures.add(key);
  }

  try {
    if (width !== innerWidth * expectedDpr || height !== innerHeight * expectedDpr)
      throw new Error('Unexpected framebuffer dimensions: ' + width + ' x ' + height);
    if (host.captureOnly) {
      for (const quality of ['medium', 'low'] as const) {
        scene.setLightingQuality(quality);
        for (const mode of testOrders[0]) {
          await host.status('Capturing ' + quality + ' / ' + mode);
          tilt.setEnabled(blurFor(mode));
          await settle(mode);
          await captureComparison(quality, mode);
          checkFrame();
        }
      }
      await host.status('Complete: ' + (host.fullCoarse ? 12 : 8) + ' visual captures', { errors: seenErrors });
      return;
    }
    for (const [round, order] of testOrders.entries()) {
      for (const quality of (round % 2 === 0 ? ['medium', 'low'] : ['low', 'medium']) as Quality[]) {
        scene.setLightingQuality(quality);
        for (const mode of order) await block(quality, mode, round + 1);
      }
    }
    assertGpuBenchmarkEnvironment();
    await host.save('results.json', { ...results, finished: new Date().toISOString() });
    await host.status('Complete: ' + results.rows.length + ' Firefox benchmark blocks', {
      frames: results.rows.reduce((count, row) => count + row.frames.length, 0),
      gpuSamples: results.rows.reduce((count, row) => count + row.gpu.length, 0),
      errors: seenErrors,
    });
  } finally {
    await pending;
    tilt.dispose();
    timeline.dispose();
    guard();
    device.removeEventListener('uncapturederror', gpuError);
    renderer.backend.trackTimestamp = saved.tracking;
    renderer.info.autoReset = saved.autoReset;
    scene.setLightingQuality(saved.quality);
    scene.setShadowsEnabled(saved.shadows);
    scene.setResolutionScale(saved.resolution.mode === 'auto' ? 'auto' : saved.resolution.fixedScale);
    distant.setSettings(saved.settings);
    layer.setFixedCellSizeForBenchmark(saved.fixedSize);
    game.playerPhysics.position.copy(saved.camera);
    game.playerPhysics.resetRenderInterpolation();
    game.controller.yaw = saved.yaw;
    game.controller.pitch = saved.pitch;
    if (panel && display !== undefined) panel.style.display = display;
  }
}
