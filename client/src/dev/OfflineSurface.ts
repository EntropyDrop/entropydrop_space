import type { World } from '@entropydrop/space-engine/voxel/World.ts';
import { createSpaceSurfaceSnapshotRemote } from '../bootstrap/SpaceSurfaceSnapshot.ts';

/** Real Copper snapshots, real streaming/LOD/disk-cache path, no server calls. */
export function startOfflineSurface(world: World) {
  const status = { generated: 0, downloads: 0, passes: 0, fineZones: 0, error: '' };
  const fineZones = new Set<string>();
  const payloads = new Map<string, Uint8Array>(), zones: any[] = [];
  let stopped = false;
  const worker = new Worker(new URL('./OfflineSurfaceWorker.ts', import.meta.url), { type: 'module' });
  const root = '/__space_offline_surface__/';
  const remote = createSpaceSurfaceSnapshotRemote(location.origin, '', `${root}manifest`, 20260922, 2,
    (async input => {
      const path = new URL(String(input)).pathname;
      if (path === `${root}manifest`) return Response.json({ schema_version: 6, samples_per_chunk_axis: 16,
        zone_size_chunks: 32, width_chunks: 1024, length_chunks: 128, complete: false, zones });
      const bytes = payloads.get(path);
      if (!bytes) return new Response(null, { status: 404 });
      status.downloads++;
      return new Response(bytes.slice().buffer);
    }) as typeof fetch);
  worker.onmessage = ({ data }) => {
    if (data.error) { status.error = data.error; worker.terminate(); return; }
    if (data.complete) { worker.terminate(); return; }
    const entries = data.levels.map(({ size, bytes, digest }) => {
      const url = `${root}${data.zoneX}/${data.zoneZ}/${size}`;
      payloads.set(url, bytes);
      return { sample_size: size, digest, byte_length: bytes.length, url };
    });
    zones.push({ zone_x: data.zoneX, zone_z: data.zoneZ, revision: 1, source_terrain_revision: 0,
      ...entries[0], lods: entries.slice(1) });
    status.generated++;
  };
  worker.onerror = event => { status.error = event.message; worker.terminate(); };
  // Four districts around spawn and four across the hole. Intentionally a
  // bounded test fixture, not a full-world generation benchmark.
  worker.postMessage({ seed: 20260922, zones: [[15,1],[15,2],[16,1],[16,2],[0,1],[0,2],[31,1],[31,2]] });
  const poll = async () => {
    try {
      if (zones.length) {
        await remote.loadAll(zone => {
          world.installSurfaceZone(zone);
          const key = `${zone.zoneX},${zone.zoneZ}`;
          if (zone.sampleSize === 1) fineZones.add(key); else fineZones.delete(key);
          status.fineZones = fineZones.size;
        }, undefined, {
          getZoneDemand: (x, z) => world.distantSurface.getZoneDemand(x, z),
          getDataBudgetBytes: () => world.getDistantSurfaceSettings().dataBudgetMiB * 1024 * 1024,
        });
        await world.finalizeSurfaceConnections(false);
        status.passes++;
        status.error = '';
      }
    } catch (error) { status.error = String(error); }
    if (!stopped) setTimeout(poll, 1000);
  };
  void poll();
  window.addEventListener('pagehide', () => { stopped = true; worker.terminate(); }, { once: true });
  return status;
}
