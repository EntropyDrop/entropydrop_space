import { runTiltShiftTrial } from './TiltShiftTrial.ts';

const host = (parent as any).tiltShiftHost;
const win = window as any;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function main() {
  if (!import.meta.env.DEV || !host || !/Firefox\//.test(navigator.userAgent) ||
      location.hostname !== '127.0.0.1' || innerWidth !== 1280 || innerHeight !== 720)
    throw new Error('Native Firefox and the fixed-size loopback fixture are required.');
  const deadline = performance.now() + 600000;
  if (host.fullCoarse) {
    while (!document.querySelector('#dev-render-diagnostics')) {
      const gate = document.querySelector('#space-entry-status')?.textContent;
      if (gate?.startsWith('Offline development failed:')) throw new Error(gate);
      if (performance.now() > deadline) throw new Error('The offline fixture did not initialize.');
      await delay(250);
    }
    const game = win.game;
    game.uiStore.startGame(false);
    const { loadTiltShiftFullWorld } = await import('./TiltShiftFullWorld.ts');
    const coverage = await loadTiltShiftFullWorld(game, host.status);
    await host.status('All 128 Aether districts installed', { coverage });
    await runTiltShiftTrial(game, host, coverage);
    return;
  }
  let last = 0;
  while (performance.now() < deadline) {
    const progress = win.offlineSurfaceStatus;
    const gate = document.querySelector('#space-entry-status')?.textContent;
    if (gate?.startsWith('Offline development failed:')) throw new Error(gate);
    if (progress?.error) throw new Error(progress.error);
    if (progress && win.game) {
      win.game.uiStore.startGame(false);
      win.game.uiStore.setDistantSurfaceEnabled(true, false);
      if (progress.complete) break;
    }
    if (performance.now() > last) {
      await host.status('Loading Aether terrain', { progress, gate, visible: document.visibilityState });
      last = performance.now() + 4000;
    }
    await delay(250);
  }
  if (!win.offlineSurfaceStatus?.complete) throw new Error('Aether terrain did not load.');
  await host.status('Aether terrain ready', { progress: win.offlineSurfaceStatus });
  await runTiltShiftTrial(win.game, host, win.offlineSurfaceStatus);
}
void main().catch(error => host.status('FAILED: ' + String(error), { stack: error.stack }));
