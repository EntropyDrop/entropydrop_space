import type { World } from '@entropydrop/space-engine/voxel/World.ts';
import type { SpaceSurfaceSnapshotRemote, SurfaceStreamOptions, SurfaceStreamProgress } from './SpaceSurfaceSnapshot.ts';

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

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${(bytes / 1024).toFixed(1)} KiB`;
}

function describeDataProgress({ loadedZones, totalZones, details }: SurfaceStreamProgress): string {
  if (!details) return `Zones ready: ${loadedZones}/${totalZones}`;
  return `Zones ready: ${loadedZones}/${totalZones}`
    + `\nData: ${formatBytes(details.processedBytes)} / ${formatBytes(details.totalBytes)}`
    + `\nCache: ${details.cacheHits} files (${formatBytes(details.cacheBytes)})`
    + ` · Download: ${details.downloadedFiles} files (${formatBytes(details.downloadedBytes)})`
    + `\nReading cache: ${details.reading} · Downloading: ${details.downloading}`
    + ` · Verifying: ${details.verifying} · Preparing: ${details.preparing}`;
}

function describeProgress(progress: SurfaceStreamProgress, pass: number): string {
  const { loadedZones, totalZones, details } = progress;
  if (!details) return `Loading distant terrain (${loadedZones}/${totalZones} zones)…`;
  if (details.phase === 'manifest') return 'Fetching distant terrain list…';
  if (details.phase === 'complete' || details.totalFiles === 0) {
    return `Checking distant terrain readiness (${loadedZones}/${totalZones} zones)…`;
  }
  const percent = Math.floor(details.completedFiles / details.totalFiles * 100);
  const title = details.phase === 'overview' ? 'Loading distant terrain overview'
    : `Loading distant terrain detail · pass ${pass}`;
  const files = ` (${details.completedFiles}/${details.totalFiles} files · ${percent}%)`;
  return `${title}${files}…\n${describeDataProgress(progress)}`;
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
  const startedAt = performance.now();
  let pass = 0, value = 94, message = 'Loading distant terrain…', lastReportAt = -Infinity;
  let lastDataSummary = '';
  let latestProgress: SurfaceStreamProgress | undefined;
  const report = (force = false) => {
    if (stopped || (!force && performance.now() - lastReportAt < 150)) return;
    lastReportAt = performance.now();
    reportProgress?.(value, `${message}\nElapsed: ${Math.floor((lastReportAt - startedAt) / 1000)}s`);
  };
  const setStage = (nextValue: number, title: string) => {
    value = Math.max(value, nextValue);
    message = title + (lastDataSummary ? `\n${lastDataSummary}` : '');
    report(true);
  };
  const options: SurfaceStreamOptions = {
    getDataBudgetBytes: () => world.getDistantSurfaceSettings().dataBudgetMiB * 1024 * 1024,
    getZoneDemand: (x, z) => world.distantSurface.getZoneDemand(x, z),
    onProgress: progress => {
      if (stopped) return;
      const { loadedZones, totalZones, details } = progress;
      const ratio = totalZones > 0 ? loadedZones / totalZones : 0;
      value = Math.max(value, 94 + Math.min(1, ratio) * 3);
      message = describeProgress(progress, pass);
      if (details?.totalFiles && (details.phase === 'overview' || details.phase === 'detail')) {
        lastDataSummary = describeDataProgress(progress);
      } else if (details && lastDataSummary) {
        message += `\n${lastDataSummary}`;
      }
      const phaseChanged = latestProgress?.details?.phase !== details?.phase;
      latestProgress = progress;
      report(phaseChanged);
    },
  };
  // Refresh elapsed time even while cache I/O, server retries or shaders wait.
  const progressTimer = setInterval(() => report(), 250);
  // Keep rendering while network and connection builders yield. Worker source
  // transfers and bounded GPU publication need these frames to make progress.
  void (async () => {
    let result: Awaited<ReturnType<SpaceSurfaceSnapshotRemote['loadAll']>>;
    do {
      pass++;
      result = await remote.loadAll(
        zone => { if (!stopped) world.installSurfaceZone(zone); },
        (x, z) => { if (!stopped) world.removeSurfaceZone(x, z); },
        options,
      );
      if (stopped) return;
      // A partial manifest means the server is still building missing zones.
      if (!result.complete) {
        const available = latestProgress?.details?.availableZones ?? latestProgress?.loadedZones ?? 0;
        setStage(value, `Waiting for server terrain (${available}/${latestProgress?.totalZones ?? 0} zones available)…`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      // A no-install pass confirms that newly decoded bounds/residuals no
      // longer request further refinement within the existing data budget.
    } while (!stopped && (!result.complete || result.loaded > 0));
    if (stopped) return;
    setStage(98, 'Preparing distant terrain for play…');
    await world.finalizeSurfaceConnections();
    prepared = true;
    setStage(98, 'Finishing distant terrain meshes and uploads…');
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
      setStage(99, 'Preparing terrain shaders…');
      await preparePipelines();
      // Submit the restored spawn view after compilation and wait for it too.
      drawFrame();
      setStage(99, 'Finishing terrain rendering…');
      await waitForGpu();
      if (world.distantSurface.preparationError) {
        throw new Error(world.distantSurface.preparationError);
      }
      if (!world.distantSurface.hasPendingWork) return;
      setStage(99, 'Finishing distant terrain meshes and uploads…');
      settledFrames = 0;
    }
  } finally {
    stopped = true;
    clearInterval(progressTimer);
  }
}
