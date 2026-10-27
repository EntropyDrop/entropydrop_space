/** Runs in the fixture's own realm so timing/DOM hooks target its window. */
import { runVisibilityExperiment } from './VisibilityExperiment.ts';
if (!import.meta.env.DEV || !['localhost', '127.0.0.1'].includes(location.hostname)) throw Error('Loopback DEV required.');
const host = (parent as any).visibilityBrowserHost, config = (window as any).visibilityBrowserConfig;
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
let game: any, saved: any;
function diagnostic(state: string) {
  const current = (window as any).game;
  return { state, time: new Date().toISOString(), visibility: document.visibilityState, hasGame: !!current,
    gate: document.querySelector('#space-entry-status')?.textContent,
    diagnostics: !!document.querySelector('#dev-render-diagnostics'),
    deviceLost: current?.sceneRenderer?.renderer?.backend?.device?.isLost ?? null };
}
try {
  const deadline = performance.now() + 300000;
  let nextCheckpoint = 0;
  while (!(window as any).game || !document.querySelector('#dev-render-diagnostics')) {
    const details = diagnostic('loading');
    if (performance.now() > nextCheckpoint) { await host.checkpoint?.(config.world, details); nextCheckpoint = performance.now() + 5000; }
    if (details.gate?.startsWith('Offline development failed:')) throw Error(details.gate);
    if (performance.now() > deadline) throw Error('Offline scene did not become ready: ' + JSON.stringify(details));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  game = (window as any).game; await game.sceneRenderer.ready;
  if (!game.offline || innerWidth !== 1280 || innerHeight !== 720) throw Error('Invalid fixture environment.');
  saved = { far: game.world.distantSurface.isEnabled(), position: game.playerPhysics.position.clone() };
  game.uiStore.startGame(false); await tick(); await tick();
  game.uiStore.setDistantSurfaceEnabled(true, false);
  if (config.world === 'nature') game.playerPhysics.position.y = 180;
  game.playerPhysics.velocity.set(0, 0, 0); game.playerPhysics.resetRenderInterpolation();
  await host.checkpoint?.(config.world, diagnostic('ready'));
  if (config.probeOnly) await host.accept(config.world, 'probe', await runVisibilityExperiment(game, { probeOnly: true, production: !!config.production, clusters: !!config.clusters }));
  else for (const [name, options] of config.onlyControl ? [['control', { control: true }]] as const
    : [['raw', {}], ['repeat', { repeat: true }], ['control', { control: true }]] as const) {
    await host.checkpoint?.(config.world, diagnostic(`running-${name}`));
    await host.accept(config.world, name, await runVisibilityExperiment(game, { ...options, production: !!config.production, clusters: !!config.clusters }));
  }
  host.complete();
} catch (error) { host.fail(String(error)); }
finally {
  if (saved) {
    game.uiStore.setDistantSurfaceEnabled(saved.far, false); game.playerPhysics.position.copy(saved.position);
    game.playerPhysics.velocity.set(0, 0, 0); game.playerPhysics.resetRenderInterpolation();
  }
}
