import { interceptMethod } from './FrameDiagnostics.ts';
import { COLOR_MODES, type ColorPaletteTrial } from './ColorPaletteTrial.ts';
if (import.meta.hot) import.meta.hot.accept();

/** Keep readback outside frame sampling; compact and unpacked palette must match. */
export async function captureColorPalettePixels(game: any, trial: ColorPaletteTrial) {
  const scene = game.sceneRenderer, renderer = scene.renderer;
  const saved = { yaw: game.controller.yaw, pitch: game.controller.pitch, mode: trial.mode };
  let stopped = false;
  const resume = interceptMethod(game, 'animate', () => { stopped = true; });
  while (!stopped) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const canvas = document.createElement('canvas'); canvas.width = renderer.domElement.width; canvas.height = renderer.domElement.height;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const images: Record<string, string> = {}, rows: any[] = [];
  const compare = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
    let changed = 0, error = 0, max = 0;
    for (let i = 0; i < a.length; i += 4) {
      const difference = Math.max(...[0, 1, 2].map(c => Math.abs(a[i + c] - b[i + c])));
      changed += Number(difference > 2); error += difference; max = Math.max(max, difference);
    }
    return { changedOver2: changed, meanMaxRgb: error / (a.length / 4), max };
  };
  try {
    game.controller.yaw = Math.PI / 2; game.controller.pitch = -.85; game.controller.updateRender(0);
    for (const mode of COLOR_MODES) { trial.set(mode); scene.render(false, true); await renderer.backend.device.queue.onSubmittedWorkDone(); }
    let reference: Uint8ClampedArray | undefined, quantized: Uint8ClampedArray | undefined;
    for (const [index, mode] of [...COLOR_MODES, 'original' as const].entries()) {
      trial.set(mode); renderer.info.reset(); scene.render(false, true);
      context.drawImage(renderer.domElement, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      if (!pixels.some((v, i) => i % 4 !== 3 && v > 0)) throw new Error('Empty color comparison image.');
      reference ??= pixels;
      if (mode === 'palette256') quantized = pixels;
      rows.push({ mode, restored: index === 4, ...compare(pixels, reference),
        ...(mode === 'packed256' ? { versusPalette: compare(pixels, quantized!) } : {}),
        calls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles,
        farCalls: trial.stats.draws, farTriangles: trial.stats.farTriangles });
      if (index !== 4) images[mode] = canvas.toDataURL('image/png');
    }
    if (rows[4].max !== 0 || rows[2].versusPalette.max !== 0) throw new Error('Color restoration or compact decoding differs.');
    if (!rows.every(r => r.calls === rows[0].calls && r.triangles === rows[0].triangles)) throw new Error('Geometry differs.');
    return { width: canvas.width, height: canvas.height, rows, images };
  } finally {
    trial.set(saved.mode); game.controller.yaw = saved.yaw; game.controller.pitch = saved.pitch;
    game.controller.updateRender(0); resume(); requestAnimationFrame(game.animate);
  }
}
