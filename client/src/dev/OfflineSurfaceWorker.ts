import { TerrainGenerator } from '@entropydrop/space-engine/worldgen/TerrainGenerator.ts';
import { generateVoxelSurfaceZone, encodeVoxelLevels } from '@entropydrop/space-engine/worldgen/VoxelSurfaceGenerator.ts';
import { getTerrainKernels } from '@entropydrop/space-engine/wasm/TerrainKernels.ts';

self.onmessage = async ({ data: { seed, version, zones } }) => {
  try {
    const generator = new TerrainGenerator(seed, version);
    const kernels = getTerrainKernels();
    if (!kernels) throw new Error('The local LOD fixture requires the terrain WASM kernel.');
    for (const [zoneX, zoneZ] of zones) {
      const volume = generateVoxelSurfaceZone(generator, zoneX, zoneZ, completed => self.postMessage({ progress: `${zoneX},${zoneZ}: ${completed}/64` }));
      let records: Uint8Array = volume.records;
      const levels = [];
      for (let size = 1; size <= 64; size *= 2) {
        const voxel = encodeVoxelLevels(volume.levels.filter(level => level.cellSize >= size));
        const bytes = new Uint8Array(36 + records.length + voxel.length), view = new DataView(bytes.buffer);
        bytes.set([69, 68, 83, 90, 7, size, 32, 8]);
        view.setUint16(8, zoneX, true); view.setUint16(10, zoneZ, true);
        view.setInt32(12, seed, true); view.setUint32(16, version, true);
        view.setUint32(28, (512 / size) ** 2, true);
        bytes.set(records, 32);
        bytes.set(voxel, 36 + records.length);
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        const digest = Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
        levels.push({ size, bytes, digest });
        if (size < 64) records = kernels.reduceSurfaceRecords(records, 512 / size);
      }
      self.postMessage({ zoneX, zoneZ, levels }, { transfer: levels.map(level => level.bytes.buffer) });
    }
    self.postMessage({ complete: true });
  } catch (error) { self.postMessage({ error: String(error) }); }
};
