import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const assets = process.argv[2]
  ? pathToFileURL(`${resolve(process.argv[2])}/`) : new URL('../dist/assets/', import.meta.url);
for (const file of await readdir(assets)) {
  if (!file.endsWith('.js')) continue;
  const source = await readFile(new URL(file, assets), 'utf8');
  if (/dev_offline|dev-offline-copper|dev-render-diagnostics|dev-frame-profiler|FrameDiagnostics|OfflineEntry|OfflineSurface|__space_offline_surface__|WebGPUMigrationSmoke|dev-webgpu-migration|VoxelBackendBenchmark|VoxelBackendFixtureWorker|Settled Aether terrain only|TutorialLevelWriter|__dev\/tutorial-level/.test(source)
    || (!process.argv.includes('--offline') && /OfflineSpace-|offline-local-player/.test(source))) {
    throw new Error(`Development-only offline entry leaked into production asset: ${file}`);
  }
}
console.log('Production bundle excludes the development-only offline entry.');
