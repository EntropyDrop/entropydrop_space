import './controls.ts';
import { createSpaceSurfaceSnapshotRemote } from '../../client/src/bootstrap/SpaceSurfaceSnapshot.ts';

export function startComparisonSurface(world: any) {
  const status = { generated: 128, total: 128, downloads: 0, passes: 0, fineZones: 0, error: '', progress: 'Loading actual Copper districts', ready: false };
  const fine = new Set<string>(), installed = new Set<string>();
  const remote = createSpaceSurfaceSnapshotRemote(location.origin, '', '/__torus_comparison__/manifest', 20260922, 2);
  let stopped = false;
  const poll = async () => {
    try {
      if ((status as any).frozen) return;
      await remote.loadAll(zone => {
        world.installSurfaceZone(zone);
        const key = `${zone.zoneX},${zone.zoneZ}`;
        installed.add(key);
        if (zone.sampleSize === 1) fine.add(key); else fine.delete(key);
        status.fineZones = fine.size;
        status.downloads++;
      }, undefined, {
        getZoneDemand: (x,z) => world.distantSurface.getZoneDemand(x,z),
        getDataBudgetBytes: () => world.getDistantSurfaceSettings().dataBudgetMiB * 1024 * 1024,
      });
      await world.finalizeSurfaceConnections(false);
      status.passes++;
      status.ready = installed.size === 128;
      status.progress = `Actual Copper districts: ${installed.size}/128`;
      status.error = '';
    } catch(error) { status.error = String(error); }
    if(!stopped) setTimeout(poll,1000);
  };
  void poll();
  (window as any).copperSurfaceStatus = status;
  window.addEventListener('pagehide',()=>{stopped=true;},{once:true});
  return status;
}
