import { warmGaussianPath } from './GaussianFarExperiment.ts';
import { createVisibilityTrial, VISIBILITY_MODES } from './VisibilityTrial.ts';
import { captureVisibilityPixels } from './VisibilityPixels.ts';
import { runVisibilityFrames } from './VisibilityFrames.ts';
if (import.meta.hot) import.meta.hot.accept();
export async function runVisibilityExperiment(game: any, options: { repeat?: boolean; control?: boolean; probeOnly?: boolean; production?: boolean } = {}) {
  await warmGaussianPath(game);
  const trial = await createVisibilityTrial(game); (window as any).visibilityTrial = trial;
  try {
    (window as any).visibilityProgress = { state: 'pixels' };
    const modes = options.production ? ['original', 'fast', 'wide', 'upload'] as const : VISIBILITY_MODES;
    const order = options.production ? ['original','fast','wide','upload','upload','wide','fast','original','wide','original','upload','fast','fast','upload','original','wide'] as const : undefined;
    // Identical-code controls also compare repeated original images. Candidate
    // images belong to the main/repeat captures, not the noise calibration.
    const pixelModes = options.production && options.control ? ['original', 'original', 'original', 'original'] as const : modes;
    const pixels = await captureVisibilityPixels(game, trial, pixelModes);
    if (options.probeOnly) return { pixels };
    if (pixels.rows.some(r => r.changedOver2)) throw Error('Candidate changes visible pixels; inspect before accepting timings.');
    const warmup = await runVisibilityFrames(game, trial, { motions: ['acrossMove'], order: [...modes], warmMs: 600, sampleMs: 900, tag: 'excluded-warmup' });
    const comparison = await runVisibilityFrames(game, trial, {
      ...(order ? { order: [...order], motions: ['acrossMove'] } : {}),
      ...(options.repeat || options.control ? { motions: ['acrossMove'] } : {}),
      ...(options.control ? { control: true, tag: 'identical-code-control' } : options.repeat ? { tag: 'moving-replication' } : {}),
    });
    (window as any).visibilityProgress = { state: 'complete', world: comparison.world, blocks: comparison.rows.length };
    return { pixels, warmup, comparison };
  } finally { trial.dispose(); }
}
