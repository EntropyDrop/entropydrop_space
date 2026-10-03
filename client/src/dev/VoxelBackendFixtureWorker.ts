import { TerrainGenerator } from '@entropydrop/space-engine/worldgen/TerrainGenerator.ts';
import { generateVoxelSurfaceZone } from '@entropydrop/space-engine/worldgen/VoxelSurfaceGenerator.ts';
import { VoxelLodPlanner, voxelTileTransfers, type VoxelLodTile } from '@entropydrop/space-engine/render/VoxelLodPlanner.ts';
import { bendPoint } from '@entropydrop/space-engine/torus/TorusWorld.ts';

self.onmessage = ({ data: { area = 64, replay = false } }) => {
  try {
    const volume = generateVoxelSurfaceZone(new TerrainGenerator(42, 3), 16, 2,
      n => self.postMessage({ progress: `Generating Aether district: ${n}/64` }));
    const planner = new VoxelLodPlanner();
    for (let x = 0; x < 32; x++) for (let z = 0; z < 4; z++) {
      for (const _ of planner.install({ key: `${x},${z}`, x, z, token: 1, mips: volume.levels })) { /* Untimed fixture. */ }
    }
    const view = { camera: bendPoint(8192, 180, 1024).toArray() as [number, number, number],
      focal: 720 / (2 * Math.tan(75 * Math.PI / 360)), area, distance: 32768,
      faceBudget: 160 * 1024 * 1024 / 16, hasView: true };
    const build = planner.build(view), tiles: VoxelLodTile[] = [];
    for (;;) {
      const next = build.next();
      if (next.done === true) {
        const packets: { x: number; tiles: VoxelLodTile[]; workerMs: number; faces: number }[] = [];
        if (replay) for (let step = 1; step <= 12; step++) {
          self.postMessage({ progress: `Preparing deterministic LOD update ${step}/12` });
          const started = performance.now(), x = 8192 + step * 16;
          const updates: VoxelLodTile[] = [];
          const update = planner.build({ ...view, camera: bendPoint(x, 180, 1024).toArray() as [number, number, number] });
          for (;;) {
            const result = update.next();
            if (result.done === true) {
              packets.push({ x, tiles: updates, workerMs: performance.now() - started, faces: result.value.faces });
              break;
            }
            if (result.value) updates.push(result.value);
          }
        }
        self.postMessage({ tiles, stats: next.value, replay: packets,
          uniqueSourceBytes: volume.levels.reduce((n, m) => n + m.faces.byteLength, 0) },
          { transfer: [...tiles, ...packets.flatMap(packet => packet.tiles)].flatMap(voxelTileTransfers) });
        break;
      }
      if (next.value && next.value.count) tiles.push(next.value);
    }
  } catch (error) { self.postMessage({ error: String(error) }); }
};
