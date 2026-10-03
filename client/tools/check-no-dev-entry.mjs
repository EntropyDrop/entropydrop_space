import { readdir, readFile } from 'node:fs/promises';

const assets = new URL('../dist/assets/', import.meta.url);
for (const file of await readdir(assets)) {
  if (!file.endsWith('.js')) continue;
  const source = await readFile(new URL(file, assets), 'utf8');
  if (/dev_offline|dev-offline-copper|dev-render-diagnostics|dev-frame-profiler|FrameDiagnostics|OfflineEntry|OfflineSurface|__space_offline_surface__|WebGPUMigrationSmoke|dev-webgpu-migration|VoxelBackendBenchmark|VoxelBackendFixtureWorker|Settled Aether terrain only/.test(source)) {
    throw new Error(`Development-only offline entry leaked into production asset: ${file}`);
  }
}
console.log('Production bundle excludes the development-only offline entry.');
