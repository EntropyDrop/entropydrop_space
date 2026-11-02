import { warmGaussianPath } from './GaussianFarExperiment.ts';
import { createVisibilityTrial, VISIBILITY_MODES } from './VisibilityTrial.ts';
import { captureVisibilityPixels } from './VisibilityPixels.ts';
import { runVisibilityFrames } from './VisibilityFrames.ts';
if (import.meta.hot) import.meta.hot.accept();
export async function runVisibilityExperiment(game: any, options: { repeat?: boolean; control?: boolean; probeOnly?: boolean; production?: boolean; clusters?: boolean; native?: boolean; packed?: boolean } = {}) {
  await warmGaussianPath(game);
  const trial = await createVisibilityTrial(game); (window as any).visibilityTrial = trial;
  try {
    (window as any).visibilityProgress = { state: 'pixels' };
    const modes = options.packed ? ['varyings', 'packed'] as const : options.native ? ['linear', 'hierarchy'] as const : options.clusters ? ['wide', 'cluster16', 'cluster32', 'cluster64'] as const
      : options.production ? ['original', 'fast', 'wide', 'upload'] as const : VISIBILITY_MODES;
    const order = options.native ? [0,1,1,0,1,0,0,1].map(i => modes[i]) : options.clusters || options.production ? [0,1,2,3,3,2,1,0,2,0,3,1,1,3,0,2].map(i => modes[i]) : undefined;
    // Identical-code controls also compare repeated original images. Candidate
    // images belong to the main/repeat captures, not the noise calibration.
    const pixelModes = (options.native || options.production || options.clusters) && options.control ? [modes[0], modes[0], modes[0], modes[0]] : modes;
    const pixels = await captureVisibilityPixels(game, trial, pixelModes);
    if (options.probeOnly) return { pixels };
    if (pixels.rows.some(r => r.changedOver2)) throw Error('Candidate changes visible pixels; inspect before accepting timings.');
    const warmup = await runVisibilityFrames(game, trial, { motions: ['acrossMove'], order: [...modes], warmMs: 600, sampleMs: 900, tag: 'excluded-warmup' });
    const comparison = await runVisibilityFrames(game, trial, {
      ...(order ? { order: [...order], motions: options.native ? ['across', 'acrossMove'] : ['acrossMove'] } : {}),
      ...(options.native ? { reference: options.packed ? 'varyings' : 'linear' } : {}),
      ...(options.clusters ? { reference: 'wide' } : {}),
      ...(options.repeat || options.control ? { motions: ['acrossMove'] } : {}),
      ...(options.control ? { control: true, tag: 'identical-code-control' } : options.repeat ? { tag: 'moving-replication' } : {}),
    });
    (window as any).visibilityProgress = { state: 'complete', world: comparison.world, blocks: comparison.rows.length };
    return { pixels, warmup, comparison };
  } finally { trial.dispose(); }
}
