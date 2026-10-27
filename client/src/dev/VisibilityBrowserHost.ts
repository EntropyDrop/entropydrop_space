/** Browser-neutral native-UI launcher. No debugger, console, or browser flags. */
import { gzipSync, zipSync, strToU8 } from 'fflate';
if (!import.meta.env.DEV || !['localhost', '127.0.0.1'].includes(location.hostname)) throw Error('Loopback DEV required.');
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const frame = element<HTMLIFrameElement>('fixture'), status = element('status'), log = element('log');
const files: Record<string, Uint8Array> = {}, events: unknown[] = [];
const browser = /Firefox\//.test(navigator.userAgent) ? 'firefox' : 'chromium';
const query = new URL(location.href).searchParams;
const autoRun = query.get('autorun') === '1';
const captureId = `${browser}-${Date.now()}`;
const receiver = 'http://127.0.0.1:54379';
let localCapture = false;
let active = false, resolveWorld: (() => void) | undefined, rejectWorld: ((reason: Error) => void) | undefined;
let progressTimer = 0;
const info: any = { userAgent: navigator.userAgent, browser, time: new Date().toISOString(),
  fixtureCss: [1280, 720], framebuffer: [2560, 1440], harness: 'visibility-browser-v3', requestedWorld: query.get('world'), onlyControl: query.get('run') === 'control', captureId, experiment: query.get('trial') === 'clusters' ? 'visibility-clusters' : query.get('trial') === 'production' ? 'production-wide-upload' : 'visibility' };
async function saveLocal(name: string, bytes: Uint8Array) {
  if (!localCapture) return;
  const response = await fetch(`${receiver}/${captureId}/${name}`, { method: 'POST', body: bytes as BodyInit });
  if (!response.ok) throw Error(`Local capture failed: ${response.status}`);
}
async function saveInfo() { await saveLocal('browser.json', strToU8(JSON.stringify({ ...info, events }, null, 2))); }
function note(value: string) { status.textContent = value; document.title = `${browser}: ${value}`; events.push({ time: new Date().toISOString(), value }); }
function controls(enabled: boolean) { element<HTMLButtonElement>('probe').disabled = element<HTMLButtonElement>('run').disabled = !enabled; }
function finishWorld() { clearInterval(progressTimer); resolveWorld?.(); }
(window as any).visibilityBrowserHost = {
  note,
  async checkpoint(world: string, details: any) {
    await saveLocal(`${world}/diagnostics.json`, strToU8(JSON.stringify(details, null, 2)));
    await saveLocal('status.json', strToU8(JSON.stringify({ world, ...details })));
  },
  async accept(world: string, name: string, result: any) {
    const { images, ...pixels } = result.pixels;
    files[`${world}/${name}.json.gz`] = gzipSync(strToU8(JSON.stringify({ ...result, pixels })));
    await saveLocal(`${world}/${name}.json.gz`, files[`${world}/${name}.json.gz`]);
    if (name === 'raw' || name === 'probe') for (const [key, value] of Object.entries(images)) {
      files[`${world}/${key}.png`] = Uint8Array.from(atob((value as string).split(',')[1]), c => c.charCodeAt(0));
      await saveLocal(`${world}/${key}.png`, files[`${world}/${key}.png`]);
    }
    const run = result.comparison;
    log.textContent += `${world} / ${name}: ${run?.rows.length ?? 0} blocks; pixel max ${Math.max(...pixels.rows.map((r: any) => r.max))}\n`;
    if (run) for (const mode of ['original', 'fast', 'wide', 'gpu', 'upload', 'cluster16', 'cluster32', 'cluster64']) {
      const rows = run.rows.filter((r: any) => r.motion === 'acrossMove' && r.role === mode);
      if (rows.length) {
        const raw = rows.flatMap((r: any) => r.raw), mean = (key: string) => raw.reduce((n: number, r: any) => n + r[key], 0) / raw.length;
        log.textContent += `  ${mode}: ${(1000 / mean('frame')).toFixed(1)} FPS / ${mean('cpu').toFixed(2)} ms CPU\n`;
      }
    }
    element<HTMLButtonElement>('save').disabled = false;
    await saveLocal('status.json', strToU8(JSON.stringify({ world, state: `${name}-saved`, blocks: run?.rows.length ?? 0 })));
  },
  complete: finishWorld,
  fail(message: string) { clearInterval(progressTimer); rejectWorld?.(new Error(message)); },
};
async function load(world: string, probeOnly: boolean) {
  note(`Loading ${world}`);
  await new Promise<void>((resolve, reject) => {
    resolveWorld = resolve; rejectWorld = reject;
    const timeout = window.setTimeout(() => reject(new Error('Fixture did not load within 120 seconds.')), 120000);
    frame.onload = () => {
      clearTimeout(timeout);
      const win = frame.contentWindow as any;
      note(`${world}: page loaded; visibility ${win.document.visibilityState}; loading benchmark module`);
      const script = win.document.createElement('script'); script.type = 'module';
      script.src = new URL('../src/dev/VisibilityBrowserChild.ts', location.href).href;
      win.visibilityBrowserConfig = { world, probeOnly, production: query.get('trial') === 'production', clusters: query.get('trial') === 'clusters', onlyControl: query.get('run') === 'control' };
      script.onerror = () => reject(new Error('Child module failed to load.'));
      win.document.body.append(script);
      progressTimer = window.setInterval(() => {
        const p = win.visibilityProgress;
        if (p) {
          status.textContent = `${world} / ${p.tag ?? p.state} / ${p.motion ?? ''} / block ${p.completed ?? p.blocks ?? 0}`;
          document.title = `${browser}: ${status.textContent}`;
        } else {
          const message = win.document.querySelector('#space-entry-status')?.textContent ?? 'Waiting for scene';
          document.title = `${browser}: ${world} / ${win.document.visibilityState} / ${message}`;
        }
      }, 1000);
    };
    frame.src = `/space/app/?world=${world}&dev_offline=1&dev_lod=world&dev_dpr=2`;
  });
  frame.onload = null; frame.src = 'about:blank';
}
async function run(probeOnly: boolean) {
  if (active) return;
  if (document.visibilityState !== 'visible') { note('The benchmark tab must be visible before starting.'); return; }
  if (innerWidth < 1280 || innerHeight < 844) { note('Resize the browser viewport to at least 1280 × 844 so the full fixture is visible.'); return; }
  active = true; controls(false); log.textContent = '';
  try {
    const worlds = ['aether-archipelago', 'nature', 'copper-metropolis'];
    const selected = query.get('world');
    const targets = selected && worlds.includes(selected) ? [selected] : probeOnly ? [worlds[0]] : worlds;
    for (const world of targets) await load(world, probeOnly);
    note(probeOnly ? 'Probe complete.' : query.get('run') === 'control' ? 'Complete: selected identical-code control.' : `Complete: ${targets.length} world(s), main runs, moving repeats, and identical-code controls.`);
  } catch (error) { note(`FAILED: ${String(error)}`); files['failure.txt'] = strToU8(String(error)); await saveLocal('failure.txt', files['failure.txt']); }
  finally {
    active = false; controls(true); clearInterval(progressTimer); element<HTMLButtonElement>('save').disabled = false;
    await saveInfo();
    if (autoRun && !localCapture) element('save').click();
  }
}
if (query.get('world')) { element('run').textContent = query.get('run') === 'control' ? 'Run identical-code control' : 'Run selected world'; element('probe').textContent = 'Probe selected world'; }
element('probe').onclick = () => void run(true);
element('run').onclick = () => void run(false);
element('save').onclick = () => {
  files['browser.json'] = strToU8(JSON.stringify({ ...info, events }, null, 2));
  const bytes = zipSync(files, { level: 0 });
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }));
  const link = document.createElement('a'); link.href = url; link.download = `visibility-${browser}-2026-10-27.zip`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
};
try {
  try { localCapture = (await (await fetch(`${receiver}/health`, { signal: AbortSignal.timeout(2000) })).text()) === 'visibility-results-v1'; } catch { /* ZIP export remains available. */ }
  const adapter = await (navigator as any).gpu?.requestAdapter();
  if (!adapter) throw Error('No WebGPU adapter available.');
  info.adapter = Object.fromEntries(['vendor', 'architecture', 'device', 'description'].map(k => [k, adapter.info?.[k]]));
  info.features = [...adapter.features];
  element('capability').textContent = `${navigator.userAgent} | WebGPU available | timestamp-query: ${adapter.features.has('timestamp-query')}`;
  if (!adapter.features.has('timestamp-query')) throw Error('The matched GPU-timed experiment requires timestamp-query.');
  controls(true); note('Ready. The iframe fixes the game viewport at 1280 × 720 CSS, DPR 2.');
  await saveInfo();
  if (autoRun) void run(query.get('probe') === '1');
} catch (error) { note(String(error)); }
