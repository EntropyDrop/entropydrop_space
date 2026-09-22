import { TerrainGenerator } from '@entropydrop/space-engine/worldgen/TerrainGenerator.ts';
import { generateSurfaceZoneRecords } from '@entropydrop/space-engine/worldgen/SurfaceZoneGenerator.ts';
import { getTerrainKernels } from '@entropydrop/space-engine/wasm/TerrainKernels.ts';

self.onmessage = async ({ data: { seed, zones } }) => {
  try {
    const generator = new TerrainGenerator(seed, 2);
    const kernels = getTerrainKernels();
    if (!kernels) throw new Error('The local LOD fixture requires the terrain WASM kernel.');
    for (const [zoneX, zoneZ] of zones) {
      let records = generateSurfaceZoneRecords(generator, zoneX, zoneZ);
      const levels = [];
      for (let size = 1; size <= 64; size *= 2) {
        const bytes = new Uint8Array(36 + records.length), view = new DataView(bytes.buffer);
        bytes.set([69, 68, 83, 90, 6, size, 32, 8]);
        view.setUint16(8, zoneX, true); view.setUint16(10, zoneZ, true);
        view.setInt32(12, seed, true); view.setUint32(16, 2, true);
        view.setUint32(28, (512 / size) ** 2, true);
        bytes.set(records, 32);
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
