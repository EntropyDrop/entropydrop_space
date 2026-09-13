// CDP screenshot harness for the Space torus world.
// Usage: node tools/screenshot.mjs <url> <outDir> [label1:yaw,pitch ...]
//   label: name prefix, yaw/pitch in degrees. yaw 0 = flat +X (along the ring).
// Also captures an in-page renderer diagnostics JSON per shot.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.SCREENSHOT_PORT || 9321);
const url = process.argv[2] || `http://127.0.0.1:5180/`;
const outDir = process.argv[3] || '/tmp/space-shots';
mkdirSync(outDir, { recursive: true });

const views = process.argv.slice(4).map(spec => {
  const [label, yaw, pitch] = spec.split(',');
  return { label, yaw: Number(yaw) || 0, pitch: Number(pitch) || 0 };
});

// --- start headless chrome ---
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--remote-debugging-address=127.0.0.1',
  '--user-data-dir=/tmp/space-chrome-profile',
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--window-size=1280,800',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });

let chromeErr = '';
chrome.stderr?.on('data', d => { chromeErr += d.toString(); });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function httpJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return res.json();
}

async function waitForDebugger() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await httpJson('/json/list');
      const page = targets.find(t => t.type === 'page');
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error('chrome devtools not reachable: ' + chromeErr.slice(-500));
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new CDP(ws);
    ws.onmessage = m => {
      const msg = JSON.parse(m.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        cdp.handlers.get(msg.method)?.(msg.params);
      }
    };
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, fn) { this.handlers.set(method, fn); }
}

const page = await waitForDebugger();
const cdp = await CDP.connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1280, height: 800, deviceScaleFactor: 1, mobile: false
});
await cdp.send('Page.navigate', { url });

// Wait for the app boot + chunk generation.
const waitFor = async (expr, ms, name) => {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      const v = r.result?.value;
      if (v !== undefined && v !== null && v !== 'not-ready') return v;
    } catch {}
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${name}`);
    await sleep(500);
  }
};

const t0 = Date.now();
await waitFor(`(() => {
  const g = window.game;
  if (!g) return 'not-ready';
  // allow dirty chunk queue to drain
  return g.world && g.world.distantSurface ? 1 : 'not-ready';
})()`, 30000, 'game boot');
console.log(`game booted after ${Date.now() - t0} ms`);

// Let the 4-chunks-per-frame queue finish + warm shaders (SwiftShader is slow).
await sleep(20000);

const evalInPage = async expression => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails));
  return r.result?.value;
};

const setView = async ({ yaw, pitch }, move = null) => {
  await evalInPage(`(async () => {
    const g = window.game;
    const deg2rad = Math.PI / 180;
    g.controller.yaw = ${yaw} * deg2rad;
    g.controller.pitch = ${pitch} * deg2rad;
    ${move ? move : ''}
    g.sceneRenderer.camera.rotation.set(g.controller.pitch, g.controller.yaw, 0, 'YXZ');
    // force a render frame with the camera already bent
    g.sceneRenderer.render();
    return 'ok';
  })()`);
  await sleep(400);
};

for (const view of views.length ? views : [{ label: 'spawn-ahead', yaw: 0, pitch: 0 }]) {
  await setView(view);
  await sleep(300);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = `${outDir}/${view.label}.png`;
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('wrote', file);
  const diag = await evalInPage(`(() => {
    const g = window.game;
    const r = g.sceneRenderer.renderer.info.render;
    return {
      fps: g.currentFps,
      triangles: r.triangles,
      calls: r.calls,
      programs: g.sceneRenderer.renderer.info.programs?.length,
      chunks: g.world.chunks.size,
      activeChunks: [...g.world.activeChunkKeys].length,
      camera: g.sceneRenderer.camera.position.toArray(),
      pixelRatio: g.sceneRenderer.renderer.getPixelRatio()
    };
  })()`);
  writeFileSync(`${outDir}/${view.label}.json`, JSON.stringify(diag, null, 2));
  console.log(view.label, JSON.stringify(diag));
}

chrome.kill('SIGTERM');
process.exit(0);
