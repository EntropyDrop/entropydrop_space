import type { World } from '@entropydrop/space-engine/voxel/World.ts';
import type { SpaceSurfaceSnapshotRemote, SurfaceStreamOptions } from './SpaceSurfaceSnapshot.ts';

interface InitialDistantTerrainOptions {
  remote: SpaceSurfaceSnapshotRemote | null;
  world: Pick<World, 'distantSurface' | 'installSurfaceZone' | 'removeSurfaceZone'
    | 'getDistantSurfaceSettings' | 'finalizeSurfaceConnections'>;
  drawFrame(): void;
  preparePipelines(): Promise<void>;
  waitForGpu(): Promise<void>;
  reportProgress?: (value: number, message: string) => void;
}

function nextLoadingFrame(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function'
      && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 16);
    }
  });
}

/** Prepare resident terrain and its pipelines behind the entry gate. */
export async function preloadInitialDistantTerrain({
  remote, world, drawFrame, preparePipelines, waitForGpu, reportProgress,
}: InitialDistantTerrainOptions): Promise<void> {
  if (!remote) return;
  reportProgress?.(94, 'Loading all distant terrain…');
  // Establish camera demand before the first snapshot pass selects its mips.
  drawFrame();
  let prepared = false, stopped = false, failed = false;
  let failure: unknown;
  const options: SurfaceStreamOptions = {
    getDataBudgetBytes: () => world.getDistantSurfaceSettings().dataBudgetMiB * 1024 * 1024,
    getZoneDemand: (x, z) => world.distantSurface.getZoneDemand(x, z),
    onProgress: ({ loadedZones, totalZones }) => {
      if (stopped) return;
      const ratio = totalZones > 0 ? loadedZones / totalZones : 0;
      reportProgress?.(94 + Math.floor(ratio * 3),
        `Loading all distant terrain (${loadedZones}/${totalZones})…`);
    },
  };
  // Keep rendering while network and connection builders yield. Worker source
  // transfers and bounded GPU publication need these frames to make progress.
  void (async () => {
    let result: Awaited<ReturnType<SpaceSurfaceSnapshotRemote['loadAll']>>;
    do {
      result = await remote.loadAll(
        zone => { if (!stopped) world.installSurfaceZone(zone); },
        (x, z) => { if (!stopped) world.removeSurfaceZone(x, z); },
        options,
      );
      if (stopped) return;
      // A partial manifest means the server is still building missing zones.
      if (!result.complete) await new Promise(resolve => setTimeout(resolve, 1000));
      // A no-install pass confirms that newly decoded bounds/residuals no
      // longer request further refinement within the existing data budget.
    } while (!stopped && (!result.complete || result.loaded > 0));
    if (stopped) return;
    reportProgress?.(98, 'Preparing distant terrain for play…');
    await world.finalizeSurfaceConnections();
    prepared = true;
  })().catch(error => { failure = error; failed = true; });

  let settledFrames = 0;
  try {
    while (true) {
      await nextLoadingFrame();
      if (failed) throw failure;
      drawFrame();
      if (world.distantSurface.preparationError) {
        throw new Error(world.distantSurface.preparationError);
      }
      settledFrames = prepared && !world.distantSurface.hasPendingWork ? settledFrames + 1 : 0;
      if (settledFrames < 2) continue;
      reportProgress?.(99, 'Preparing terrain shaders…');
      await preparePipelines();
      // Submit the restored spawn view after compilation and wait for it too.
      drawFrame();
      reportProgress?.(99, 'Finishing terrain rendering…');
      await waitForGpu();
      if (world.distantSurface.preparationError) {
        throw new Error(world.distantSurface.preparationError);
      }
      if (!world.distantSurface.hasPendingWork) return;
      settledFrames = 0;
    }
  } finally {
    stopped = true;
  }
}
