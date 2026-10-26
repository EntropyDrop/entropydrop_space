import { interceptMethod } from './FrameDiagnostics.ts';
import { HALF_MODES, type HalfTriangleTrial } from './HalfTriangleTrial.ts';
if (import.meta.hot) import.meta.hot.accept();

/** Frozen control: repeat candidate and restore original exactly. */
export async function captureHalfTrianglePixels(game: any, trial: HalfTriangleTrial) {
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
    for (const mode of HALF_MODES) { trial.set(mode); scene.render(false, true); await renderer.backend.device.queue.onSubmittedWorkDone(); }
    let reference: Uint8ClampedArray | undefined, quantized: Uint8ClampedArray | undefined;
    for (const [index, mode] of (['original', 'half', 'half', 'original'] as const).entries()) {
      trial.set(mode); renderer.info.reset(); scene.render(false, true);
      context.drawImage(renderer.domElement, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      if (!pixels.some((v, i) => i % 4 !== 3 && v > 0)) throw new Error('Empty triangle comparison image.');
      reference ??= pixels;
      if (index === 1) quantized = pixels;
      rows.push({ mode, restored: index === 3, ...compare(pixels, reference),
        ...(index === 2 ? { versusRepeat: compare(pixels, quantized!) } : {}),
        calls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles,
        farCalls: trial.stats.draws, farTriangles: trial.stats.farTriangles, fallbackDraws: trial.stats.fallbackDraws });
      if (index < 2) images[mode] = canvas.toDataURL('image/png');
    }
    if (rows[3].max !== 0 || rows[2].versusRepeat.max !== 0) throw new Error('Restoration or stable triangle choice differs.');
    if (!rows.every(r => r.calls === rows[0].calls && !r.fallbackDraws) || rows[1].farTriangles * 2 !== rows[0].farTriangles
      || rows[0].triangles - rows[1].triangles !== rows[1].farTriangles) throw new Error('Triangle reduction differs: ' + JSON.stringify(rows));
    return { width: canvas.width, height: canvas.height, rows, images };
  } finally {
    trial.set(saved.mode); game.controller.yaw = saved.yaw; game.controller.pitch = saved.pitch;
    game.controller.updateRender(0); resume(); requestAnimationFrame(game.animate);
  }
}
