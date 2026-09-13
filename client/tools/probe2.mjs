// Flexible in-page WebGL readback probe.
// Views are specs: label;yaw;pitch;X;Y;Z;fx;fy;fw;fh
//   yaw/pitch deg (flat camera orientation), X/Y/Z optional flat-space camera
//   position (defaults to player position), fx;fy;fw;fh optional full-res focus
//   region (top-left in image coords) dumped at 1/4 resolution to <label>-focus.json.
// Usage: node tools/probe2.mjs <url> <outDir> "spec" ...
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.SCREENSHOT_PORT || 9321);
const url = process.argv[2] || 'http://127.0.0.1:5180/';
const outDir = process.argv[3] || '/tmp/space-shots';
mkdirSync(outDir, { recursive: true });

// Spec: label|yawDeg|pitchDeg|fx|fy|fw|fh|px|py|pz  (pipe-separated; optional
// trailing fields may be omitted in order).
const views = process.argv.slice(4).map(spec => {
  const p = spec.split('|');
  const [label, yaw, pitch, fx, fy, fw, fh, px, py, pz] = p;
  return {
    label,
    yaw: Number(yaw) || 0,
    pitch: Number(pitch) || 0,
    pos: px !== undefined && px !== '' ? [Number(px), Number(py), Number(pz)] : null,
    focus: fx !== undefined && fx !== '' ? [Number(fx), Number(fy), Number(fw), Number(fh)] : null
  };
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

for (let i = 0; i < 120; i++) {
  const v = await evalInPage(`window.game && window.game.world ? 1 : 0`).catch(() => 0);
  if (v) break;
  await sleep(500);
}
await sleep(15000);

const probeFn = (v) => `
(async () => {
  const g = window.game;
  const deg = Math.PI/180;
  g.controller.yaw = ${v.yaw} * deg;
  g.controller.pitch = ${v.pitch} * deg;
  g.sceneRenderer.camera.rotation.set(g.controller.pitch, g.controller.yaw, 0, 'YXZ');
  ${v.pos ? `g.sceneRenderer.camera.position.set(${v.pos[0]}, ${v.pos[1]}, ${v.pos[2]});` : ''}
  g.sceneRenderer.render();
  const canvas = g.sceneRenderer.renderer.domElement;
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
  const S = 32;
  const buf = new Uint8Array(4);
  const grid = [];
  for (let gy = 0; gy < S; gy++) {
    const row = [];
    for (let gx = 0; gx < S; gx++) {
      const x = Math.floor((gx + 0.5) * width / S);
      const y = Math.floor((gy + 0.5) * height / S);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      row.push((buf[0]<<16)|(buf[1]<<8)|buf[2]);
    }
    grid.push(row);
  }
  let focus = null;
  ${v.focus ? `
  {
    const [fx, fy, fw, fh] = [${v.focus.join(', ')}];
    const full = new Uint8Array(width*height*4);
    gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,full);
    const scale = 4;
    const outRows = Math.floor(fh/scale), outCols = Math.floor(fw/scale);
    const codes = [];
    for (let oy = 0; oy < outRows; oy++) {
      const row = [];
      for (let ox = 0; ox < outCols; ox++) {
        const x = fx + ox*scale, yTop = fy + oy*scale;
        // image coords: y=0 top; readPixels y=0 bottom -> topmost row index
        // py = height - yTop - scale covers [py, py+scale-1] inside the buffer.
        const py = height - yTop - scale;
        let r=0,gg=0,b=0,n=0;
        for (let sy=0; sy<scale; sy++) for (let sx=0; sx<scale; sx++) {
          const i = ((py+sy)*width + (x+sx))*4;
          r+=full[i]; gg+=full[i+1]; b+=full[i+2]; n++;
        }
        row.push(((r/n)>>4)<<10|((gg/n)>>4)<<5|((b/n)>>4));
      }
      codes.push(row);
    }
    focus = { fx, fy, fw, fh, scale, codes };
  }` : ''}
  const full = new Uint8Array(width*height*4);
  gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,full);
  let bright=0, skyish=0, total=width*height;
  for (let i=0;i<full.length;i+=4){
    const r=full[i],gg=full[i+1],b=full[i+2];
    const lum=0.2126*r+0.7152*gg+0.0722*b;
    if(lum>90) bright++;
    if(b-r>60 && b>140) skyish++;
  }
  return {
    width, height, grid, focus,
    stats: { total, brightPct: 100*bright/total, skyPct: 100*skyish/total },
    cameraFlat: g.sceneRenderer.camera.position.toArray(),
    camY: g.sceneRenderer.camera.position.y
  };
})()
`;

for (const view of views) {
  const out = await evalInPage(probeFn(view));
  writeFileSync(`${outDir}/${view.label}-probe.json`, JSON.stringify({ width: out.width, height: out.height, grid: out.grid, stats: out.stats, cameraFlat: out.cameraFlat }));
  if (out.focus) {
    writeFileSync(`${outDir}/${view.label}-focus.json`, JSON.stringify({ ...out.focus, width: out.width, height: out.height }));
  }
  console.log(`== ${view.label} stats=`, JSON.stringify(out.stats), 'camY=', out.cameraFlat?.[1]);
}

chrome.kill('SIGTERM');
process.exit(0);
