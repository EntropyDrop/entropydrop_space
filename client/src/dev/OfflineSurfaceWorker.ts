import { TerrainGenerator } from '@entropydrop/space-engine/worldgen/TerrainGenerator.ts';
import { generateVoxelSurfaceZone, encodeVoxelLevels } from '@entropydrop/space-engine/worldgen/VoxelSurfaceGenerator.ts';
import { getTerrainKernels } from '@entropydrop/space-engine/wasm/TerrainKernels.ts';

self.onmessage = async ({ data: { seed, version, zones, repeatWorld } }) => {
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
      if (repeatWorld) {
        // One real district repeated over all 128 locations exposes global
        // budgeting regressions without retaining 128 full generation buffers.
        self.postMessage({ template: levels });
        for (let x = 0; x < 32; x++) for (let z = 0; z < 4; z++) {
          const entries = [];
          for (const level of levels) {
            const bytes = level.bytes.slice(), view = new DataView(bytes.buffer);
            view.setUint16(8, x, true); view.setUint16(10, z, true);
            const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
            entries.push({ size: level.size, byteLength: bytes.length,
              digest: Array.from(hash, b => b.toString(16).padStart(2, '0')).join('') });
          }
          self.postMessage({ zoneX: x, zoneZ: z, levels: entries });
        }
      } else self.postMessage({ zoneX, zoneZ, levels }, { transfer: levels.map(level => level.bytes.buffer) });
    }
    self.postMessage({ complete: true });
  } catch (error) { self.postMessage({ error: String(error) }); }
};
