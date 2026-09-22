import type { ReadySpaceSession } from '../bootstrap/SpaceBootstrap.ts';
import { DEFAULT_PLAYER_SKIN_URL } from '../bootstrap/SpaceBootstrap.ts';
import type { SpaceStorage } from '../engine/storage/BrowserStorage.ts';
import type { World } from '@entropydrop/space-engine/voxel/World.ts';

interface OfflineGame {
  world: World;
  sceneRenderer: any;
  playerPhysics: any;
  controller: any;
  currentFps: number;
  animate(): void;
  preloadInitialTerrain(report?: (value: number, message: string) => void): Promise<unknown>;
  start(): void;
}

/** No token, account requests, persistent world writes, or network adapters. */
export function offlineSession(world = 'copper-metropolis'): ReadySpaceSession {
  const session: ReadySpaceSession = {
    protocol_version: 2, max_online_players: 32, queue_enabled: true,
    mode: 'online', api_origin: '', token: '', websocket_url: '',
    world: { id: 'dev-offline-copper', name: 'Offline Copper (development only)',
      seed: 20260922, terrain_generator_version: 2, terrain_revision: 0, surface_snapshot_url: '' },
    player: { user_id: 'dev-local', username: 'Local developer', player_entity_id: 'dev-player',
      skin_url: DEFAULT_PLAYER_SKIN_URL, skin_type: 'strong', is_admin: false,
      start_x_cm: 820000, start_y_cm: 12800, start_z_cm: 103200,
      start_yaw_q15: 16384, resumed: true },
    skin_object_url: DEFAULT_PLAYER_SKIN_URL, entry_warning: null,
    terrain_edit_remote: null, surface_snapshot_remote: null, latency_monitor: null,
    player_position_remote: { async save() {} },
  };
  if (world === 'aether-archipelago') {
    session.world = { ...session.world, id: 'dev-offline-aether', name: 'Offline Aether (development only)',
      seed: 42, terrain_generator_version: 3 };
    Object.assign(session.player, { start_x_cm: 819250, start_y_cm: 18000, start_z_cm: 102450 });
  }
  return session;
}

export function ephemeralStorage(): SpaceStorage {
  const data = new Map<string, string>();
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: key => { data.delete(key); },
  };
}

export async function startOfflineSpace(create: (session: ReadySpaceSession, storage: SpaceStorage) => OfflineGame) {
  if (!import.meta.env.DEV || !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    throw new Error('Offline development entry is only available on loopback in Vite development mode.');
  }
  const parameters = new URLSearchParams(location.search);
  const baseline = parameters.get('dev_baseline') === '1';
  const busyStreaming = parameters.get('dev_stream_busy') === '1';
  const game = create(offlineSession(parameters.get('world') ?? undefined), ephemeralStorage());
  (window as any).game = game;
  game.world.setRenderDistance(8, baseline ? 8 : undefined);
  game.world.microVoxels.setRenderBatchingEnabled(!baseline);
  // Fixed, identical render settings make A/B results comparable. Do not write
  // these choices into the regular user's persisted graphics preferences.
  game.sceneRenderer.setLightingQuality('medium');
  game.sceneRenderer.setResolutionScale(1);
  game.sceneRenderer.setShadowsEnabled(true);
  game.playerPhysics.isFlying = true;
  game.controller.pitch = -0.85;
  const gate = document.getElementById('space-entry-gate');
  const status = document.getElementById('space-entry-status');
  try {
    await game.preloadInitialTerrain((_value, message) => {
      if (status) status.textContent = `Offline development: ${message}`;
    });
    if (gate) { gate.hidden = true; gate.style.display = 'none'; }
    if (busyStreaming) {
      // Deterministic busy-browser fixture: no idle opportunity is available,
      // so only requests with an explicit timeout will ever receive a slice.
      globalThis.requestIdleCallback = (callback, options) => options?.timeout === undefined ? 0
        : window.setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), options.timeout);
      globalThis.cancelIdleCallback = id => window.clearTimeout(id);
    }
    game.start();
    const surface = ['1', 'world'].includes(parameters.get('dev_lod') ?? '')
      ? (await import('./OfflineSurface.ts')).startOfflineSurface(game.world, parameters.get('dev_lod') === 'world') : null;
    installDiagnostics(game, baseline, surface, busyStreaming);
  } catch (error) {
    if (status) status.textContent = `Offline development failed: ${String(error)}`;
    console.error(error);
  }
}

function installDiagnostics(game: OfflineGame, baseline: boolean,
  surface: { generated: number; total: number; downloads: number; passes: number; fineZones: number; error: string; progress?: string } | null,
  busyStreaming = false) {
  const panel = document.createElement('section');
  panel.id = 'dev-render-diagnostics';
  panel.style.cssText = 'position:fixed;top:210px;left:12px;z-index:10000;background:#101820ed;color:#fff;padding:12px;font:12px monospace;pointer-events:auto;max-width:420px';
  const title = document.createElement('strong');
  title.textContent = `LOCAL OFFLINE · ${baseline ? 'Baseline' : 'Optimized'} · no account / no sync`;
  const stats = document.createElement('pre');
  stats.style.whiteSpace = 'pre-wrap';
  panel.append(title, stats);
  for (const [name, before] of [['Optimized', false], ['Baseline', true]] as const) {
    const button = document.createElement('button');
    button.textContent = name;
    button.onclick = () => {
      const url = new URL(location.href);
      url.searchParams.set('dev_baseline', before ? '1' : '0');
      location.assign(url);
    };
    panel.append(button);
  }
  const rotate = document.createElement('button');
  rotate.textContent = 'Rotate camera';
  let rotating = false;
  rotate.onclick = () => { rotating = !rotating; rotate.textContent = rotating ? 'Stop rotation' : 'Rotate camera'; };
  panel.append(rotate);
  const lod = document.createElement('button');
  lod.textContent = 'Test distant terrain';
  lod.onclick = () => {
    const url = new URL(location.href); url.searchParams.set('dev_lod', '1'); location.assign(url);
  };
  panel.append(lod);
  let movedAt = 0, readyAfterMoveMs = 0;
  const move = document.createElement('button');
  move.textContent = 'Move to new chunks';
  move.onclick = () => {
    game.playerPhysics.position.x = (game.playerPhysics.position.x + 256) % 16384;
    game.playerPhysics.velocity.set(0, 0, 0);
    game.playerPhysics.resetRenderInterpolation();
    movedAt = performance.now(); readyAfterMoveMs = 0;
  };
  panel.append(move);
  const traffic = document.createElement('button');
  traffic.textContent = 'Test download bandwidth';
  traffic.onclick = () => {
    void fetch(new URL('../style.css', import.meta.url), { cache: 'no-store' })
      .then(response => response.arrayBuffer()).catch(console.error);
  };
  panel.append(traffic);
  if (surface) {
    const across = document.createElement('button');
    across.textContent = 'Across ring';
    across.onclick = () => { game.controller.pitch = 1.35; game.controller.yaw = Math.PI / 2; };
    const whip = document.createElement('button');
    whip.textContent = 'Turn 180 degrees';
    whip.onclick = () => { game.controller.yaw += Math.PI; };
    const skyline = document.createElement('button');
    skyline.textContent = 'Distant skyline';
    skyline.onclick = () => { game.controller.pitch = .1; game.controller.yaw = Math.PI / 2; };
    panel.append(across, whip, skyline);
  }
  document.body.append(panel);
  let last = performance.now(), updated = last;
  const frames: number[] = [];
  const cpuFrames: number[] = [];
  const animate = game.animate.bind(game);
  game.animate = () => {
    const start = performance.now();
    animate();
    cpuFrames.push(performance.now() - start);
    if (cpuFrames.length > 240) cpuFrames.shift();
  };
  const sample = (now: number) => {
    if (document.visibilityState === 'visible') {
      frames.push(now - last);
      if (frames.length > 240) frames.shift();
      if (rotating) game.controller.yaw += Math.min(0.05, (now - last) / 1000) * 0.4;
      if (now - updated >= 500) {
        const ordered = [...frames].sort((a, b) => a - b);
        const cpu = [...cpuFrames].sort((a, b) => a - b);
        const info = game.sceneRenderer.renderer.info;
        stats.textContent = `FPS ${game.currentFps.toFixed(1)} | frame p50 ${(ordered[Math.floor(ordered.length * .5)] ?? 0).toFixed(1)} ms | p95 ${(ordered[Math.floor(ordered.length * .95)] ?? 0).toFixed(1)} ms\nMain CPU p50 ${(cpu[Math.floor(cpu.length * .5)] ?? 0).toFixed(1)} ms | p95 ${(cpu[Math.floor(cpu.length * .95)] ?? 0).toFixed(1)} ms\nDraw calls ${info.render.calls} | triangles ${info.render.triangles}\nActive chunks ${game.world.activeChunkKeys.size} (X ±${game.world.renderDistance}, Z ±${game.world.renderDistanceZ})\nMicro partitions ${game.world.microVoxels.meshChunks.size} → draw meshes ${game.world.microVoxels.renderMeshes.size}\nFixed medium lighting / 100% resolution / shadows on\nLocal near terrain only; not a live-server FPS measurement.`;
        stats.textContent = stats.textContent.replace('Local near terrain only; not a live-server FPS measurement.',
          surface ? 'Local near + distant fixture; not a live-server FPS measurement.'
            : 'Local near terrain only; not a live-server FPS measurement.');
        const near = game.world.getTerrainAoiLoadProgress();
        if (movedAt && near.ready && !readyAfterMoveMs) readyAfterMoveMs = now - movedAt;
        stats.textContent += `\nNear detail: ${near.readyChunks}/${near.totalChunks} | ${near.ready ? 'ready' : 'loading standard/micro meshes'}${busyStreaming ? ' | zero idle time' : ''}`;
        if (movedAt) stats.textContent += `\nLast move: ${((readyAfterMoveMs || now - movedAt) / 1000).toFixed(1)}s${readyAfterMoveMs ? ' to ready' : ' loading'}`;
        if (surface) {
          const layer = game.world.distantSurface, build = layer.mesh.userData.lodBuildStats;
          const voxel = layer.voxels.group.userData.voxelLodStats;
          stats.textContent += `\nLOD fixture: ${surface.generated}/${surface.total} districts${surface.total === 128 ? ' (repeated district stress test)' : ''} | 1m sources ${surface.fineZones} | passes ${surface.passes} | source reads ${surface.downloads}\nLOD publications ${build?.publications ?? 0} | faces ${voxel?.faces ?? layer.mesh.geometry.instanceCount} | subdivision ${(voxel?.effectiveAreaPx2 ?? layer.mesh.userData.lodEffectiveSubdivisionPx2 ?? 16).toFixed(2)}px^2\n${surface.error || surface.progress || 'Local far terrain enabled; not a live-server measurement.'}`;
        }
        updated = now;
      }
    } else frames.length = 0;
    last = now;
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}
