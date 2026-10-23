/** Explicit fourth-batch probes; never imported by production. */
import { checkTurnPixels } from './TurnPerformanceBenchmark.ts';
import { sampleFarBundle } from './GpuDrawingBenchmark.ts';

export async function checkGpuExecutionPixels(game: any) {
  const layer = game.world.distantSurface.voxels;
  return checkTurnPixels(game, { set: enabled => layer.setCompactMapsEnabled(enabled), enabled: layer.getCompactMapsEnabled() });
}

export async function sampleGpuExecution(game: any) {
  const layer = game.world.distantSurface.voxels, saved = layer.getCompactMapsEnabled();
  const blocks = layer.getBlockInstancingEnabled(), faces = layer.getInstanceFaces();
  try {
    return await sampleFarBundle(game, ['before', 'after', 'before-repeat', 'after-repeat'].map(label => ({ label, blocks, faces })),
      variant => layer.setCompactMapsEnabled(variant.label.startsWith('after')));
  } finally { layer.setCompactMapsEnabled(saved); }
}
