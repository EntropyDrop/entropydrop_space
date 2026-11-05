if (!import.meta.env.DEV || !['localhost', '127.0.0.1'].includes(location.hostname)) throw Error('Local DEV required');
const frame = document.querySelector<HTMLIFrameElement>('#fixture')!;
const status = document.querySelector('#status')!, log = document.querySelector('#log')!;
const query = new URL(location.href).searchParams, capture = `bake-${Date.now()}`;
const receiver = 'http://127.0.0.1:54389';
let resolveWorld: (() => void) | undefined, rejectWorld: ((e: Error) => void) | undefined;
async function save(name: string, value: string | Blob) {
  const response = await fetch(`${receiver}/${capture}/${name}`, {method:'POST', body:value});
  if (!response.ok) throw Error(`Capture failed: ${response.status}`);
}
(window as any).textureBakeHost = {
  note(message: string) { status.textContent = message; document.title = message; },
  async accept(world: string, result: any) {
    await save(`${world}.json`, JSON.stringify(result));
    const row = result.rows.at(-1);
    if (row) log.textContent = `${world}\n${result.rows.map((r: any) => `${r.config}/${r.view}: ${r.fps.toFixed(1)} FPS; GPU ${r.metrics.gpu.mean.toFixed(2)} ms; triangles ${Math.round(r.metrics.triangles.mean)}; atlas ${r.texture?.used ?? 0}`).join('\n')}`;
  },
  async image(world: string, name: string, image: Blob) { await save(`${world}-${name}.png`, image); },
  complete() { resolveWorld?.(); },
  fail(error: string) { rejectWorld?.(new Error(error)); },
};
document.querySelector<HTMLButtonElement>('#run')!.onclick = async () => {
  const button = document.querySelector<HTMLButtonElement>('#run')!; button.disabled = true;
  try {
    if (document.visibilityState !== 'visible' || innerWidth < 1280 || innerHeight < 810) throw Error('Keep the 1280 × 810 fixture visible.');
    for (const world of query.has('world') ? [query.get('world')!] : query.has('proxy') ? ['aether-archipelago'] : ['aether-archipelago', 'nature', 'copper-metropolis']) {
      await new Promise<void>((resolve, reject) => {
        resolveWorld = resolve; rejectWorld = reject;
        frame.onload = () => {
          const win = frame.contentWindow as any;
          win.textureBakeConfig = {world, probe:query.has('probe'), repeat:query.has('repeat'), control:query.has('control'), proxy:query.has('proxy'), unified:query.has('unified'), repack:query.has('repack')};
          const script = win.document.createElement('script'); script.type='module';
          script.src = new URL('../src/dev/TextureBakeExperiment.ts', location.href).href; win.document.body.append(script);
        };
        frame.src = `/space/app/?dev_offline=1&dev_lod=world&dev_dpr=2&world=${world}`;
      });
    }
    await save('complete.json',JSON.stringify({capture,completedAt:new Date().toISOString()}));
    status.textContent = `Complete · ${capture}`;
  } catch(error) { status.textContent = `FAILED: ${String(error)}`; await save('failure.txt', String(error)); }
  finally { button.disabled = false; }
};
