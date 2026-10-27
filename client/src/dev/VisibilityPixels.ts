import { verifyVisibilityMaps } from './VisibilityUploadTrial.ts';
import { interceptMethod } from './FrameDiagnostics.ts';
import { VISIBILITY_MODES, type VisibilityMode, type VisibilityTrial } from './VisibilityTrial.ts';
import { assertGpuBenchmarkEnvironment } from './GpuBenchmarkEnvironment.ts';
if (import.meta.hot) import.meta.hot.accept();
export async function captureVisibilityPixels(game: any, trial: VisibilityTrial, modes: readonly VisibilityMode[] = VISIBILITY_MODES) {
  assertGpuBenchmarkEnvironment();
  const scene = game.sceneRenderer, renderer = scene.renderer, layer = game.world.distantSurface.voxels;
  const saved = { position: game.playerPhysics.position.clone(), yaw: game.controller.yaw, pitch: game.controller.pitch,
    mode: trial.mode, autoReset: renderer.info.autoReset };
  let stopped = false; const resume = interceptMethod(game, 'animate', () => { stopped = true; });
  while (!stopped) await new Promise<void>(r => requestAnimationFrame(() => r()));
  // Scene.render still calls updateView while simulation is paused. Freeze
  // publication, not culling, so readback awaits cannot swap terrain generations
  // between reference and candidate images. Timed ordinary frames stay live.
  const publication = [interceptMethod(layer, 'buildSynchronously', () => {}),
    interceptMethod(layer, 'processPending', () => {})];
  const residentFaces = layer.arena.stats.residentFaces;
  const canvas = document.createElement('canvas'); canvas.width = renderer.domElement.width; canvas.height = renderer.domElement.height;
  renderer.info.autoReset = false;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const images: Record<string, string> = {}, rows: any[] = [], errors: string[] = [];
  const onError = (event: any) => errors.push(event.error.message); renderer.backend.device.addEventListener('uncapturederror', onError);
  const poses = [{ name: 'near', yaw: 0, pitch: -.85, x: 0, z: 0 },
    { name: 'across', yaw: 0, pitch: 1.35, x: 0, z: 0 },
    { name: 'cached-step', yaw: .025, pitch: 1.35, x: 8, z: 4 },
    { name: 'guard-step', yaw: .07, pitch: 1.35, x: 18, z: 8 },
    { name: 'return', yaw: 0, pitch: 1.35, x: 0, z: 0 }];
  const reference: Uint8ClampedArray[] = [], picks: string[] = [];
  function compare(a: Uint8ClampedArray, b: Uint8ClampedArray) {
    let changed = 0, max = 0, sum = 0;
    for (let i = 0; i < a.length; i += 4) {
      const delta = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      changed += Number(delta > 2); max = Math.max(max, delta); sum += delta;
    }
    return { changedOver2: changed, max, meanMaxRgb: sum / (a.length / 4) };
  }
  try {
    // Compile indirect/direct variants outside both capture comparisons and timings.
    for (const mode of modes) { trial.set(mode); scene.render(false, true); scene.render(false, true); await renderer.backend.device.queue.onSubmittedWorkDone(); }
    for (const [order, mode] of [...modes, modes[0]].entries()) {
      trial.set(mode);
      for (const [index, pose] of poses.entries()) {
        game.playerPhysics.position.copy(saved.position); game.playerPhysics.position.x += pose.x; game.playerPhysics.position.z += pose.z;
        game.playerPhysics.velocity.set(0, 0, 0); game.playerPhysics.resetRenderInterpolation();
        game.controller.yaw = Math.PI / 2 + pose.yaw; game.controller.pitch = pose.pitch; game.controller.updateRender(0);
        trial.beginFrame(); scene.render(false, true); renderer.info.reset(); scene.render(false, true);
        context.drawImage(renderer.domElement, 0, 0); const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        if (!pixels.some((v, i) => i % 4 !== 3 && v)) throw Error('Empty visibility capture.');
        if (order === 0) reference[index] = pixels;
        const pick = JSON.stringify(game.controller.performAimRaycast()); if (order === 0) picks[index] = pick;
        const row = { mode, pose: pose.name, restored: order === modes.length, ...compare(pixels, reference[index]),
          identicalPicking: pick === picks[index], nominalTriangles: renderer.info.render.triangles, draws: renderer.info.render.drawCalls,
          ...trial.stats, residentFaces: layer.arena.stats.residentFaces,
          uploadValidation: modes.includes('upload') ? await verifyVisibilityMaps(game) : undefined, gpuValidation: mode === 'gpu' ? await trial.verify() : undefined };
        rows.push(row);
        if (row.residentFaces !== residentFaces) throw Error('Frozen visibility geometry changed during image capture.');
        if (order < modes.length && index < 2) images[`${pose.name}-${mode}`] = canvas.toDataURL('image/png');
      }
    }
    await renderer.backend.device.queue.onSubmittedWorkDone();
    if (errors.length || rows.some(r => !r.identicalPicking) || rows.filter(r => r.restored).some(r => r.max !== 0))
      throw Error('Visibility restore/picking/GPU control failed: ' + JSON.stringify({ errors, rows }));
    return { width: canvas.width, height: canvas.height, poses, rows, errors, images, frozenPublication: true, modeOrder: modes };
  } finally {
    renderer.backend.device.removeEventListener('uncapturederror', onError); renderer.info.autoReset = saved.autoReset;
    game.playerPhysics.position.copy(saved.position); game.playerPhysics.velocity.set(0, 0, 0); game.playerPhysics.resetRenderInterpolation();
    trial.set(saved.mode); game.controller.yaw = saved.yaw; game.controller.pitch = saved.pitch; game.controller.updateRender(0);
    publication.reverse().forEach(restore => restore());
    resume(); requestAnimationFrame(game.animate);
  }
}
