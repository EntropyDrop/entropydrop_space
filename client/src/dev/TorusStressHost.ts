if (!import.meta.env.DEV || location.hostname !== 'localhost') throw Error('Local DEV only');
const query = new URL(location.href).searchParams;
// Current performance work deliberately uses one terrain and native Firefox.
const worlds = ['aether-archipelago'];
const run = query.get('run') ?? '';
if (run && !/^(baseline|seam|optimized|repeat|cache|workers|batch|paired)$/.test(run)) throw Error('Unknown capture run');
(window as any).torusStressFocus = query.get('focus') === '1';
(window as any).torusStressPaired = query.get('paired') === '1';
(window as any).torusStressNear = query.get('near');
(window as any).torusStressMapUploads = query.get('maps') !== 'full';
const frame = document.querySelector<HTMLIFrameElement>('#fixture')!;
const status = document.querySelector('#status')!, button = document.querySelector<HTMLButtonElement>('#run')!;
let completeWorld: (() => void) | undefined, failWorld: ((error: Error) => void) | undefined, world = '';
async function save(name: string, body: BodyInit) {
  const response = await fetch(`http://127.0.0.1:54388/firefox/${world}/${run ? run + '/' : ''}${name}`, { method: 'POST', body });
  if (!response.ok) throw Error(`Capture failed: ${response.status}`);
}
(window as any).torusStressHost = {
  async status(value: any) {
    status.textContent = `${world}: ${JSON.stringify(value)}`; document.title = `Firefox stress: ${world} / ${value.state}`;
    await save('status.json', JSON.stringify(value));
    if (value.state === 'complete') completeWorld?.();
    if (value.state === 'FAILED') failWorld?.(Error(value.error));
  },
  async save(name: string, value: any) {
    await save(name, name.endsWith('.png') ? Uint8Array.from(atob(value.split(',')[1]), c => c.charCodeAt(0)) : JSON.stringify(value));
  },
};
button.onclick = async () => {
  button.disabled = true;
  try {
    if (!/Firefox\//.test(navigator.userAgent)) throw Error('Run this matched suite in native Firefox.');
    if (innerWidth < 1280 || innerHeight < 780) throw Error(`Viewport too small: ${innerWidth} x ${innerHeight}; need 1280 x 780.`);
    if (await (await fetch('http://127.0.0.1:54388/health')).text() !== 'torus-stress-v1') throw Error('Result receiver unavailable.');
    const selected = query.get('world');
    if (selected && !worlds.includes(selected)) throw Error('Unknown terrain');
    for (world of selected ? [selected] : worlds) {
      (window as any).torusStressTerrain = world;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('World timed out')), 900000);
        completeWorld = () => { clearTimeout(timer); resolve(); };
        failWorld = error => { clearTimeout(timer); reject(error); };
        frame.onload = () => {
          const script = frame.contentDocument!.createElement('script'); script.type = 'module';
          script.src = new URL('../src/dev/TorusStressChild.ts', location.href).href;
          script.onerror = () => failWorld?.(Error('Benchmark module failed to load'));
          frame.contentDocument!.body.append(script);
        };
        frame.src = `/space/app/?world=torus-compare-${world}&dev_offline=1&dev_lod=world&dev_dpr=2&dev_msaa=0`;
      });
      frame.onload = null; frame.src = 'about:blank';
    }
    status.textContent = 'Complete. All matched stress captures were saved locally.';
  } catch (error) { status.textContent = `FAILED: ${String(error)}`; }
  finally { frame.onload = null; frame.src = 'about:blank'; button.disabled = false; }
};
if (query.get('autorun') === '1') button.click();
