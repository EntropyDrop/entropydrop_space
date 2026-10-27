import { getWorldProjection } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { interceptMethod } from './FrameDiagnostics.ts';
import { installVisibilityUploadTrial } from './VisibilityUploadTrial.ts';
import { installVisibilityCpuTrial } from './VisibilityCpuTrial.ts';
import { installVisibilityGpuTrial } from './VisibilityGpuTrial.ts';
export const VISIBILITY_MODES = ['original', 'fast', 'wide', 'gpu'] as const;
export type VisibilityMode = typeof VISIBILITY_MODES[number] | 'upload' | 'cluster16' | 'cluster32' | 'cluster64';
if (import.meta.hot) import.meta.hot.accept();
export async function createVisibilityTrial(game: any) {
  if (!import.meta.env.DEV || !game.offline) throw Error('Offline DEV required.');
  const layer = game.world.distantSurface.voxels, arena = layer.arena;
  if (getWorldProjection() !== 'torus' || !game.world.distantSurface.isEnabled() || layer.getTorusBackfaceCullingEnabled()
    || !arena.getBlockInstancingEnabled() || arena.getInstanceFaces() !== 32 || arena.getCompactMapsEnabled()
    || !arena.getViewOptimizations().cached) throw Error('Default packed torus arena required, surface backface filter off.');
  let mode: VisibilityMode = 'original', closed = false;
  const savedClusterSize = arena.visibilityClusterSize;
  arena.visibilityClusterSize = 0;
  const stats = { computePasses: 0, indirectDraws: 0, gpuEncodeMs: 0, newGpuPages: 0, gpuBytes: 0,
    arenaMs: 0, arenaCalls: 0, visibilityQueries: 0 };
  const undoCpu = installVisibilityCpuTrial(arena, () => mode);
  let gpu: Awaited<ReturnType<typeof installVisibilityGpuTrial>>;
  try { gpu = await installVisibilityGpuTrial(game, () => mode, stats); } catch (error) { undoCpu.dispose(); throw error; }
  const undo = [installVisibilityUploadTrial(arena, () => mode === 'upload'), interceptMethod(arena, 'sync', (original, args) => { const t = performance.now(); const result = original(...args);
    stats.arenaMs += performance.now() - t; stats.arenaCalls++; return result; }),
  interceptMethod(arena, 'setView', (original, args) => { const epoch = arena.viewEpoch; const result = original(...args);
    stats.visibilityQueries += Number(arena.viewEpoch !== epoch); return result; })];
  function set(next: VisibilityMode) {
    if (closed || ![...VISIBILITY_MODES, 'upload', 'cluster16', 'cluster32', 'cluster64'].includes(next)) throw Error('Invalid visibility mode.');
    if (next === mode) return;
    if (mode === 'gpu') gpu.restoreIndirect();
    mode = next; undoCpu.update(); arena.resetView = arena.visibilityDirty = true; arena.positionEpoch++; arena.viewEpoch++;
    arena.visibilityClusterSize = next.startsWith('cluster') ? Number(next.slice(7)) : 0;
    for (const page of arena.pages) for (const entry of page.entries) {
      entry.visibility = undefined; if (entry.blockTests) { entry.blockTests.position = -1; entry.blockTests.view = -1; }
    }
    gpu.invalidate(); layer.arenaDirty = true; layer.group.needsUpdate = true;
  }
  return { stats, set, get mode() { return mode; }, verify: gpu.verify,
    metadata: { revision: 'visibility-v2-production-wide', modes: VISIBILITY_MODES, scope: 'All settled packed distant arena pages; original PBR and records',
      fast: 'One Float64 sqrt per position block, reused for distance and normal cone',
      wide: 'Fast math plus 32 m / .12 plane-normal reuse guards, 34 m / .121 conservative rejection margins',
      gpu: 'Stable classify / per-run prefix / scatter; existing page order; indirect indexed draws; masked CPU fallback',
      upload: 'Production wide CPU plus exact map comparison and changed-range uploads; DEV only',
      clusters: 'Production wide CPU plus order-preserving sphere groups of 16/32/64 visibility blocks; exact plane masks',
      originalGuards: { translation: 16, rotation: .06, padding: 18, angularPadding: .061 } },
    beginFrame() { stats.arenaMs = stats.arenaCalls = stats.visibilityQueries = 0; },
    dispose() { if (closed) return; set('original'); closed = true; undo.reverse().forEach(f => f()); gpu.dispose(); undoCpu.dispose(); arena.visibilityClusterSize = savedClusterSize; }
  };
}
export type VisibilityTrial = Awaited<ReturnType<typeof createVisibilityTrial>>;
