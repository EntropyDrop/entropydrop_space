import { parseSurfaceZoneSnapshot } from '../bootstrap/SpaceSurfaceSnapshot.ts';

const source = '/space/app/__dev/tilt-shift/terrain/';
type District = { x: number; z: number; finest: number; bytes: number; coarsestFaces: number };
type Manifest = { world: string; seed: number; generator: number; zones: District[] };

export async function loadTiltShiftFullWorld(game: any, status: (label: string, detail: unknown) => Promise<void>) {
  const manifestResponse = await fetch(source + 'index.json');
  if (!manifestResponse.ok) throw new Error('Prepare the cached Aether terrain before opening the full-world benchmark.');
  const manifest: Manifest = await manifestResponse.json();
  if (manifest.world !== 'aether-archipelago' || manifest.seed !== 42 || manifest.generator !== 3 ||
      manifest.zones.length !== 128 || new Set(manifest.zones.map(({ x, z }) => x + '/' + z)).size !== 128)
    throw new Error('Invalid Aether terrain manifest.');
  const distant = game.world.distantSurface;
  game.uiStore.setDistantSurfaceEnabled(false, false);
  for (let start = 0; start < manifest.zones.length; start += 8) {
    const batch = manifest.zones.slice(start, start + 8);
    const snapshots = await Promise.all(batch.map(async ({ x, z, finest, bytes, coarsestFaces }) => {
      if (!Number.isInteger(x) || !Number.isInteger(z) || x < 0 || x >= 32 || z < 0 || z >= 4)
        throw new Error('Invalid terrain district coordinates.');
      const response = await fetch(source + x + '_' + z + '.edsz.gz');
      if (!response.ok || !response.body) throw new Error('Could not load cached district ' + x + '/' + z);
      const content = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      const snapshot = parseSurfaceZoneSnapshot(content);
      const last = snapshot.voxelMips?.at(-1);
      if (content.byteLength !== bytes || snapshot.seed !== manifest.seed ||
          snapshot.terrainGeneratorVersion !== manifest.generator || snapshot.zoneX !== x || snapshot.zoneZ !== z ||
          snapshot.sampleSize !== finest || last?.cellSize !== 64 || last.faces.length !== coarsestFaces * 16)
        throw new Error('Cached district does not match manifest: ' + x + '/' + z);
      return snapshot;
    }));
    for (const snapshot of snapshots) game.world.installSurfaceZone(snapshot);
    await status('Loading real Aether districts', { installed: distant.loadedZones.size, total: 128 });
  }
  game.uiStore.setDistantSurfaceEnabled(true, false);
  await game.world.finalizeSurfaceConnections();
  if (distant.loadedZones.size !== 128 || !distant.isEnabled()) throw new Error('Aether coverage is incomplete.');
  return { generated: 128, installed: 128, total: 128, mode: 'coordinate-specific-cache', downloads: 128,
    sourceBytes: manifest.zones.reduce((sum, zone) => sum + zone.bytes, 0),
    coarsestFaces: manifest.zones.reduce((sum, zone) => sum + zone.coarsestFaces, 0) };
}
