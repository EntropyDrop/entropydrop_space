// In-page WebGL readback probe: render a frame, then readPixels the back buffer
// in the SAME task (before compositing clears it) to get true fragment colors.
// Usage: node tools/probe-pixels.mjs <url> <outDir> "label:yaw,pitch" ...
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.SCREENSHOT_PORT || 9321);
const url = process.argv[2] || 'http://127.0.0.1:5180/';
const outDir = process.argv[3] || '/tmp/space-shots';
mkdirSync(outDir, { recursive: true });

const views = process.argv.slice(4).map(spec => {
  const [label, yaw, pitch] = spec.split(',');
  return { label, yaw: Number(yaw) || 0, pitch: Number(pitch) || 0 };
});

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--remote-debugging-address=127.0.0.1',
  '--user-data-dir=/tmp/space-chrome-profile',
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
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
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
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
      }
    };
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const page = await waitForDebugger();
const cdp = await CDP.connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url });

async function evalInPage(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

// Wait for boot.
for (let i = 0; i < 120; i++) {
  const v = await evalInPage(`window.game && window.game.world ? 1 : 0`).catch(() => 0);
  if (v) break;
  await sleep(500);
}
await sleep(15000); // chunk queue + shader warmup

// Readback helper defined in-page.
const probeFn = `
(async () => {
  const g = window.game;
  const deg = Math.PI/180;
  g.controller.yaw = ${'__YAW__'} * deg;
  g.controller.pitch = ${'__PITCH__'} * deg;
  g.sceneRenderer.camera.rotation.set(g.controller.pitch, g.controller.yaw, 0, 'YXZ');
  g.sceneRenderer.render();
  const canvas = g.sceneRenderer.renderer.domElement;
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
  const S = 32; // sample grid
  const buf = new Uint8Array(4);
  const samples = [];
  for (let gy = 0; gy < S; gy++) {
    const row = [];
    for (let gx = 0; gx < S; gx++) {
      const x = Math.floor((gx + 0.5) * width / S);
      const y = Math.floor((gy + 0.5) * height / S); // note: readPixels origin is bottom-left
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      row.push((buf[0]<<16)|(buf[1]<<8)|buf[2]);
    }
    samples.push(row);
  }
  // Also full-image stats
  const full = new Uint8Array(width*height*4);
  gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,full);
  let bright=0, skyish=0, green=0, total=width*height;
  for (let i=0;i<full.length;i+=4){
    const r=full[i],gg=full[i+1],b=full[i+2];
    const lum=0.2126*r+0.7152*gg+0.0722*b;
    if(lum>90) bright++;
    if(b-r>60 && b>140) skyish++;
    if(gg-r>15 && gg-b>15) green++;
  }
  return { width, height, grid: samples, stats: { total, brightPct: 100*bright/total, skyPct: 100*skyish/total, greenPct: 100*green/total } };
})()
`;

for (const view of views.length ? views : [{ label: 'probe', yaw: 0, pitch: 0 }]) {
  const expr = probeFn.replace('__YAW__', String(view.yaw)).replace('__PITCH__', String(view.pitch));
  const out = await evalInPage(expr);
  writeFileSync(`${outDir}/${view.label}-probe.json`, JSON.stringify(out, null, 1));
  console.log(`== ${view.label} ${out.width}x${out.height} stats=`, JSON.stringify(out.stats));
}

chrome.kill('SIGTERM');
process.exit(0);
