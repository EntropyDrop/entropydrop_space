import { interceptMethod } from './FrameDiagnostics.ts';
import { BACKFACE_MODES, saveBackfaceAsset, type TorusBackfaceTrial } from './TorusBackfaceTrial.ts';
if (import.meta.hot) import.meta.hot.accept();

/** Immediate canvas copies, separate from timing; restored PBR is an exact image control. */
export async function captureTorusBackfacePixels(game: any, trial: TorusBackfaceTrial) {
  if (!import.meta.env.DEV || !game.offline) throw new Error('Offline DEV required.');
  const scene = game.sceneRenderer, renderer = scene.renderer;
  const saved = { position: game.playerPhysics.position.clone(), yaw: game.controller.yaw, pitch: game.controller.pitch, mode: trial.mode };
  let stopped = false;
  const resume = interceptMethod(game, 'animate', () => { stopped = true; });
  while (!stopped) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const world = new URL(location.href).searchParams.get('world'), rows: any[] = [];
  const canvas = document.createElement('canvas'); canvas.width = renderer.domElement.width; canvas.height = renderer.domElement.height;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  try {
    for (const [name, yaw, pitch] of [['terrain', Math.PI / 2, -.85], ['across', Math.PI / 2, 1.35], ['reverse', Math.PI * 1.5, -.25]] as const) {
      game.playerPhysics.position.copy(saved.position); game.playerPhysics.resetRenderInterpolation();
      game.controller.yaw = yaw; game.controller.pitch = pitch; game.controller.updateRender(0);
      // Warm the exact pose and all material pipelines before the frozen comparison.
      for (const mode of BACKFACE_MODES) { trial.set(mode); scene.render(true); await renderer.backend.device.queue.onSubmittedWorkDone(); }
      let reference: Uint8ClampedArray | undefined;
      const picks: string[] = [], captures: any[] = [];
      const strip = document.createElement('canvas'); strip.width = 1280; strip.height = 392;
      const stripContext = strip.getContext('2d')!;
      stripContext.fillStyle = '#101923'; stripContext.fillRect(0, 0, 1280, 392);
      stripContext.fillStyle = '#fff'; stripContext.font = '18px sans-serif';
      for (const [index, mode] of [...BACKFACE_MODES, 'reference' as const].entries()) {
        trial.set(mode); renderer.info.reset(); scene.render(true);
        context.drawImage(renderer.domElement, 0, 0);
        const image = context.getImageData(0, 0, canvas.width, canvas.height).data;
        if (!image.some((value, i) => i % 4 !== 3 && value > 0)) throw new Error('Empty canvas readback.');
        reference ??= image;
        let changed = 0, error = 0, maximum = 0;
        for (let i = 0; i < image.length; i += 4) {
          const d = Math.max(Math.abs(image[i] - reference[i]), Math.abs(image[i+1] - reference[i+1]), Math.abs(image[i+2] - reference[i+2]));
          changed += Number(d > 2); error += d; maximum = Math.max(maximum, d);
        }
        const restored = index === 2;
        captures.push({ mode, restored, changedOver2: changed, meanMaxRgb: error / (image.length / 4), max: maximum,
          calls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles, farCalls: trial.stats.draws, farTriangles: trial.stats.farTriangles });
        picks.push(JSON.stringify(game.controller.performAimRaycast()));
        if (!restored) {
          stripContext.fillText(`${world} / ${name} / ${mode}`, index * 640 + 12, 23);
          stripContext.drawImage(canvas, index * 640, 32, 640, 360);
          const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG encoding failed.')), 'image/png'));
          await saveBackfaceAsset(`${world}/${name}-${mode}.png`, png);
        }
      }
      if (captures[2].max !== 0) throw new Error('Restored PBR image differs; comparison is not frozen.');
      if (captures[1].triangles > captures[0].triangles || captures[2].triangles !== captures[0].triangles)
        throw new Error('Culling increased geometry or failed to restore it.');
      rows.push({ name, width: canvas.width, height: canvas.height, captures, identicalPicking: picks.every(pick => pick === picks[0]) });
      const stripPng = await new Promise<Blob>(resolve => strip.toBlob(value => resolve(value!), 'image/png'));
      await saveBackfaceAsset(`${world}/${name}-comparison.png`, stripPng);
    }
    await saveBackfaceAsset(`${world}/images.json`, new Blob([JSON.stringify(rows)], { type: 'application/json' }));
    return rows;
  } finally {
    trial.set(saved.mode); game.playerPhysics.position.copy(saved.position); game.playerPhysics.resetRenderInterpolation();
    game.controller.yaw = saved.yaw; game.controller.pitch = saved.pitch; game.controller.updateRender(0);
    resume(); requestAnimationFrame(game.animate);
  }
}
