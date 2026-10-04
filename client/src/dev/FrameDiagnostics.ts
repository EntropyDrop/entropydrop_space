/** Development-only measurements. Explicit pixel/completion probes are separate from frame sampling. */
import * as THREE from 'three/webgpu';
import { frameMetrics } from './FrameMetrics.ts';
export class FrameSamples {
  private values: number[] = [];
  private capacity: number;
  constructor(capacity = 2400) { this.capacity = capacity; }
  snapshot() { return [...this.values]; }
  add(value: number) {
    if (!Number.isFinite(value)) return;
    this.values.push(value);
    if (this.values.length > this.capacity) this.values.shift();
  }
  clear() { this.values.length = 0; }
  summary() {
    const sorted = [...this.values].sort((a, b) => a - b);
    return { count: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
      p50: sorted[Math.floor(sorted.length * .5)] ?? 0, p95: sorted[Math.floor(sorted.length * .95)] ?? 0 };
  }
}

/** Restore inherited methods by deleting the temporary own property. */
export function interceptMethod(target: any, key: string, invoke: (original: (...args: any[]) => any, args: any[]) => any) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key), original = target[key];
  if (typeof original !== 'function') return () => {};
  const wrapper = function (...args: any[]) { return invoke(original.bind(this), args); };
  target[key] = wrapper;
  return () => {
    if (target[key] !== wrapper) return;
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete target[key];
  };
}

export function withHiddenObjects(objects: Iterable<any>, draw: () => void) {
  const visibility = new Map<any, boolean>();
  try {
    for (const object of objects) if (object && !visibility.has(object)) {
      visibility.set(object, object.visible); object.visible = false;
    }
    draw();
  } finally {
    for (const [object, visible] of visibility) object.visible = visible;
  }
}

const active = new WeakMap<object, { dispose(): void; panel: HTMLElement }>();
export function installFrameDiagnostics(game: any) {
  if (!import.meta.env.DEV || !game) return;
  const existing = active.get(game);
  if (existing) { existing.panel.hidden = false; return existing; }
  const scene = game.sceneRenderer, renderer = scene.renderer;
  const backend = renderer.backend;
  const timer = renderer.hasFeature('timestamp-query');
  let pending: Promise<void> | null = null;
  const previousTracking = backend.trackTimestamp;
  backend.trackTimestamp = false;
  const flags = { draw: true, far: true, near: true, micro: true, sky: true, post: true };
  const labels = { draw: 'Scene drawing', far: 'Distant LOD', near: 'Near standard terrain',
    micro: 'Micro terrain', sky: 'Sky', post: 'Ultra post-processing' };
  const samples = new Map<string, FrameSamples>();
  const metric = (name: string) => {
    if (!samples.has(name)) samples.set(name, new FrameSamples());
    return samples.get(name)!;
  };
  const stage = new Map<string, number>();
  const undo: (() => void)[] = [];
  const autoReset = renderer.info.autoReset;
  renderer.info.autoReset = false;
  let previous = 0, published = 0, epoch = 0, disposed = false;
  let gpuEnabled = true, gpuFrame = 0;
  let calls = 0, triangles = 0;
  const panel = document.createElement('section');
  panel.id = 'dev-frame-profiler';
  panel.style.cssText = 'position:fixed;right:12px;top:90px;z-index:10010;max-width:560px;max-height:80vh;overflow:auto;background:#101820f5;color:white;padding:12px;font:12px monospace;pointer-events:auto';
  const heading = document.createElement('strong'); heading.textContent = 'FRAME PROFILER · temporary / no world edits';
  const stats = document.createElement('pre'); stats.style.whiteSpace = 'pre-wrap';
  const controls = document.createElement('div');
  const results = document.createElement('pre'); results.style.whiteSpace = 'pre-wrap';
  function showResults(lines: string[]) {
    results.replaceChildren(...lines.map(line => {
      const row = document.createElement('div'); row.textContent = line; return row;
    }));
  }
  panel.append(heading, stats, controls, results); document.body.append(panel);
  function clear() { epoch++; previous = 0; for (const value of samples.values()) value.clear(); }
  const buttons = new Map<keyof typeof flags, HTMLButtonElement>();
  function refreshButtons() {
    for (const [key, button] of buttons) {
      button.textContent = `${labels[key]}: ${flags[key] ? 'ON' : 'OFF'}`;
      button.setAttribute('aria-pressed', String(flags[key]));
    }
  }
  function button(label: string, click: () => void) {
    const element = document.createElement('button'); element.textContent = label;
    element.onclick = () => { if (!probing) click(); }; controls.append(element); return element;
  }
  const reports: any[] = [];
  let probing = false;
  let exportUrl: string | null = null;
  for (const quality of ['medium', 'high', 'ultra'] as const) button(`Profile ${quality}`, () => {
    if (comparison) return;
    scene.setLightingQuality(quality); scene.setShadowsEnabled(true); scene.setResolutionScale(1); clear();
  });
  button('Save profiler results', () => {
    if (comparison) return;
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportUrl = URL.createObjectURL(new Blob([JSON.stringify(reports, null, 2)], { type: 'application/json' }));
    showResults(['Profiler results ready to download.']);
    const a = document.createElement('a'); a.href = exportUrl; a.download = 'space-webgpu-profile.json';
    a.textContent = 'Download profiler JSON'; results.append(a);
  });
  button('Save render PNG', () => {
    if (comparison) return;
    scene.render(true);
    showResults(['Render capture ready to download.']);
    const a = document.createElement('a'); a.href = renderer.domElement.toDataURL('image/png');
    a.download = 'space-webgpu-optimized.png'; a.textContent = 'Download render PNG'; results.append(a);
    const preview = document.createElement('img'); preview.src = a.href; preview.style.width = '100%'; results.append(preview);
  });
  button('Show profiler JSON', () => showResults([JSON.stringify(reports, null, 2)]));
  for (const key of Object.keys(flags) as (keyof typeof flags)[]) {
    buttons.set(key, button('', () => { if (comparison) return; flags[key] = !flags[key]; clear(); refreshButtons(); }));
  }
  refreshButtons();
  const gpuButton = button('GPU timing: ON (1/6 frames)', () => {
    if (comparison) return;
    gpuEnabled = !gpuEnabled; clear();
    gpuButton.textContent = `GPU timing: ${gpuEnabled ? 'ON (1/6 frames)' : 'OFF'}`;
  });
  const capture = () => ({ view: {yaw:game.controller.yaw,pitch:game.controller.pitch}, flags: { ...flags }, quality: scene.getLightingQuality(), shadows: scene.getShadowsEnabled(), resolution: scene.getResolutionScaleState(),
    mergedBuffers: game.world.distantSurface?.voxels.getMergedBuffersEnabled() ?? false,
    commandCaching: game.world.distantSurface?.voxels.getCommandCachingEnabled() ?? false,
    opaqueFastPath: game.world.distantSurface?.voxels.getOpaqueFastPathEnabled() ?? false,
    nearOpaqueFastPath: game.world.distantSurface?.handoff.getOpaqueFastPathEnabled() ?? true,
    nearFrustumCulling: scene.nearFrustumCullingEnabled,
    secondaryScale: scene.cinematicEffects?.getSecondaryResolutionScale() ?? 0.5,
    voxelDrawOptimizations: game.world.distantSurface?.voxels.getDrawOptimizationsEnabled() ?? true });
  const restore = (saved: ReturnType<typeof capture>) => {
    Object.assign(game.controller, saved.view);
    Object.assign(flags, saved.flags); scene.setLightingQuality(saved.quality); scene.setShadowsEnabled(saved.shadows);
    scene.setResolutionScale(saved.resolution.mode === 'auto' ? 'auto' : saved.resolution.fixedScale);
    scene.cinematicEffects?.setSecondaryResolutionScale(saved.secondaryScale);
    game.world.distantSurface?.voxels.setDrawOptimizationsEnabled(saved.voxelDrawOptimizations);
    game.world.distantSurface?.voxels.setOpaqueFastPathEnabled(saved.opaqueFastPath);
    game.world.distantSurface?.handoff.setOpaqueFastPathEnabled(saved.nearOpaqueFastPath);
    scene.nearFrustumCullingEnabled = saved.nearFrustumCulling;
    game.world.distantSurface?.voxels.setCommandCachingEnabled(saved.commandCaching);
    game.world.distantSurface?.voxels.setMergedBuffersEnabled(saved.mergedBuffers);
    refreshButtons(); clear();
  };
  let comparison: { saved: ReturnType<typeof capture>; cases: { label: string; apply(): void }[];
    motion?: boolean; index: number; warmUntil: number; endAt: number; warmed: boolean; rows: string[] } | null = null;
  function beginCase(now: number) {
    const run = comparison!;
    restore(run.saved);
    // Fixed mode also selects full effects. Use this deliberately for every
    // case and label it; an Auto baseline might previously have reduced effects.
    scene.setResolutionScale(run.saved.resolution.scale);
    run.cases[run.index].apply(); clear(); refreshButtons();
    run.warmUntil = now + 1500; run.endAt = now + 5500; run.warmed = false;
  }
  const faceCases = () => [false,true,false].map((enabled,i)=>({
    label:`Opaque terrain ${enabled?'ON':'OFF'}${i===2?' repeat':''}`,
    apply(){game.world.distantSurface.voxels.setOpaqueFastPathEnabled(enabled);}
  }));
  const nearCases = () => [false, true, false].map((enabled, i) => ({
    label: `Opaque near terrain ${enabled ? 'ON' : 'OFF'}${i === 2 ? ' repeat' : ''}`,
    apply() { game.world.distantSurface.handoff.setOpaqueFastPathEnabled(enabled); },
  }));
  const nearDrawCases = () => [false, true, false].map((enabled, i) => ({
    label: `Near draw optimizations ${enabled ? 'ON' : 'OFF'}${i === 2 ? ' repeat' : ''}`,
    apply() {
      game.world.distantSurface.handoff.setOpaqueFastPathEnabled(enabled);
      scene.nearFrustumCullingEnabled = enabled;
    },
  }));
  button('Compare near materials (about 17s)', () => {
    if (!readyForTerrainProbe() || !game.world.getTerrainAoiLoadProgress().ready) return;
    const saved = capture();
    comparison = { saved, cases: nearCases(), index: 0, warmUntil: 0, endAt: 0, warmed: false,
      rows: [`${saved.quality} | same near geometry, camera and resolution | near material only`] };
    beginCase(performance.now());
  });
  button('Compare near drawing (about 17s)', () => {
    if (!readyForTerrainProbe() || !game.world.getTerrainAoiLoadProgress().ready) return;
    const saved = capture();
    comparison = { saved, cases: nearDrawCases(), index: 0, warmUntil: 0, endAt: 0, warmed: false,
      rows: [`${saved.quality} | near materials and shadow-aware culling | same resident terrain`] };
    beginCase(performance.now());
  });
  const commandCases = () => [false,true,false].map((enabled,i)=>({
    label:`Far commands ${enabled?'ON':'OFF'}${i===2?' repeat':''}`,
    apply(){game.world.distantSurface.voxels.setCommandCachingEnabled(enabled);}
  }));
  const mergeCases = () => [false,true,false].map((enabled,i)=>({
    label:`Merged buffers ${enabled?'ON':'OFF'}${i===2?' repeat':''}`,
    apply(){game.world.distantSurface.voxels.setMergedBuffersEnabled(enabled);}
  }));
  button('Compare merged buffers (about 17s)', () => {
    if (!readyForTerrainProbe()) return;
    const saved=capture();
    comparison={saved,cases:mergeCases(),index:0,warmUntil:0,endAt:0,warmed:false,
      rows:[`${saved.quality} | full far terrain and same LOD | shared face arena`]};
    beginCase(performance.now());
  });
  button('Compare merged rotation (about 17s)', () => {
    if (!readyForTerrainProbe()) return;
    const saved=capture();
    comparison={saved,cases:mergeCases(),motion:true,index:0,warmUntil:0,endAt:0,warmed:false,
      rows:[`${saved.quality} | repeated 1.2-radian camera sweep over 4 seconds | full terrain`]};
    beginCase(performance.now());
  });
  button('Merged buffers: toggle', () => {
    if (comparison) return;
    const voxels=game.world.distantSurface?.voxels;
    voxels?.setMergedBuffersEnabled(!voxels.getMergedBuffersEnabled()); clear();
  });
  button('Compare far commands (about 17s)', () => {
    if (!readyForTerrainProbe()) return;
    const saved=capture();
    comparison={saved,cases:commandCases(),index:0,warmUntil:0,endAt:0,warmed:false,
      rows:[`${saved.quality} | complete far terrain, same geometry and resolution | command cache only`]};
    beginCase(performance.now());
  });
  button('Far command cache: toggle', () => {
    if (comparison) return;
    const voxels=game.world.distantSurface?.voxels;
    if (voxels) { voxels.setCommandCachingEnabled(!voxels.getCommandCachingEnabled()); clear(); }
  });
  function readyForTerrainProbe() {
    if (comparison) return false;
    const voxels = game.world.distantSurface?.voxels;
    if (!voxels || voxels.hasPendingWork || game.uiStore?.getSnapshot()?.hasStarted === false
      || voxels.group.children.some((mesh: any) => mesh.name.includes('previous'))) {
      showResults(['Click Play and wait for distant geometry and transitions to settle. Keep the camera fixed.']);
      return false;
    }
    return true;
  }
  button('Compare opaque terrain (about 17s)', () => {
    if (!readyForTerrainProbe()) return;
    const saved=capture();
    comparison={saved,cases:faceCases(),index:0,warmUntil:0,endAt:0,warmed:false,
      rows:[`${saved.quality} | same geometry, camera and image settings | opaque far material only`]};
    beginCase(performance.now());
  });
  async function checkTerrainPixels(label: string, cases: ReturnType<typeof faceCases>) {
    if (!readyForTerrainProbe()) return;
    const saved=capture();
    let suspended=false;
    const resume=interceptMethod(game,'animate',()=>{suspended=true;});
    probing=true;
    try {
      // The already queued callback holds the old animate function. Let it run
      // and reach the interceptor before freezing the first reference image.
      while(!suspended) await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      scene.setResolutionScale(saved.resolution.scale);
      const images: Uint8ClampedArray[]=[];
      for (const item of cases) {
        item.apply(); await settleMergedStorage(); scene.render(true);scene.render(true);
        const canvas=document.createElement('canvas');canvas.width=renderer.domElement.width;canvas.height=renderer.domElement.height;
        const context=canvas.getContext('2d',{willReadFrequently:true})!;context.drawImage(renderer.domElement,0,0);
        images.push(context.getImageData(0,0,canvas.width,canvas.height).data);
      }
      const differences=images.slice(1).map(bytes=>{
        let changed=0,max=0; const peaks: unknown[]=[];
        for(let i=0;i<bytes.length;i+=4){let delta=0;for(let c=0;c<3;c++)delta=Math.max(delta,Math.abs(bytes[i+c]-images[0][i+c]));if(delta)changed++;if(delta>max){max=delta;peaks.push({x:(i/4)%renderer.domElement.width,y:Math.floor(i/4/renderer.domElement.width),delta,before:Array.from(images[0].slice(i,i+3)),after:Array.from(bytes.slice(i,i+3))});}}
        return {changedPixels:changed,maxChannelDelta:max,peaks};
      });
      const result={label,quality:scene.getLightingQuality(),shadows:scene.getShadowsEnabled(),
        width:renderer.domElement.width,height:renderer.domElement.height,
        camera:scene.camera.position.toArray(),rotation:scene.camera.quaternion.toArray(),caseLabels:cases.map(item=>item.label),differences};
      reports.push(result);showResults([JSON.stringify(result,null,2)]);
    } catch(error) {showResults([`Pixel check failed: ${String(error)}`]);}
    finally {resume(); probing=false; restore(saved); if(suspended)requestAnimationFrame(game.animate);}
  }
  async function settleMergedStorage() {
    const until=performance.now()+30000;
    do {
      scene.render(true);
      if(!game.world.distantSurface?.voxels.hasPendingWork) return;
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
    } while(performance.now()<until);
    throw new Error('Terrain publication did not settle in 30 seconds');
  }
  button('Check merged pixels', () => checkTerrainPixels('Merged-buffer pixel check',
    game.world.distantSurface?.voxels.getMergedBuffersEnabled()
      ? [{label:'Retained merged buffers',apply(){}}, ...mergeCases()] : mergeCases()));
  button('Check completed merged work', () => { void checkCompletedWork(mergeCases()); });
  button('Check near material pixels', () => checkTerrainPixels('Near-material pixel check', nearCases()));
  button('Check completed near work', () => { void checkCompletedWork(nearCases()); });
  button('Check near drawing pixels', () => checkTerrainPixels('Near-drawing pixel check', nearDrawCases()));
  button('Check completed near drawing', () => { void checkCompletedWork(nearDrawCases()); });
  button('Check opaque terrain pixels', () => checkTerrainPixels('Opaque-terrain pixel check', faceCases()));
  button('Check far command pixels', () => checkTerrainPixels('Far-command pixel check', [{label:'Retained cache',apply(){}},...commandCases()]));
  button('Check far transparency', () => { void (async () => {
    if (!readyForTerrainProbe()) return;
    const material=new THREE.MeshBasicNodeMaterial({color:0xff4499,transparent:true,opacity:.4,depthWrite:false});
    const geometry=new THREE.PlaneGeometry(20000,20000), probes=new THREE.Group();
    for (const distance of [20,4000]) {
      const mesh=new THREE.Mesh(geometry,material);
      // Camera-local planes are already in render space. Do not let the periodic
      // material scan bend this diagnostic geometry midway through a comparison.
      mesh.userData.torusPreBent = true; mesh.frustumCulled = false;
      mesh.position.z = -distance; probes.add(mesh);
    }
    scene.camera.add(probes);
    try { await checkTerrainPixels('Far-command transparency check', commandCases()); }
    finally { probes.removeFromParent(); geometry.dispose(); material.dispose(); }
  })(); });
  async function checkCompletedWork(cases: ReturnType<typeof faceCases>) {
    if (!readyForTerrainProbe()) return;
    let suspended = false;
    const saved=capture(), tracking=gpuEnabled, resume=interceptMethod(game,'animate',()=>{ suspended=true; });
    probing=true; gpuEnabled=false;
    showResults(['Measuring completed render work; simulation and ordinary frame sampling are paused.']);
    try {
      scene.setResolutionScale(saved.resolution.scale);
      for(const item of cases) {
        item.apply(); await settleMergedStorage();
        await backend.device.queue.onSubmittedWorkDone();
        for(let i=0;i<48;i++)scene.render();
        await backend.device.queue.onSubmittedWorkDone();
        const elapsed=new FrameSamples();
        for(let sample=0;sample<12;sample++) {
          const start=performance.now();
          for(let frame=0;frame<4;frame++)scene.render();
          await backend.device.queue.onSubmittedWorkDone();elapsed.add((performance.now()-start)/4);
        }
        reports.push({label:`Completed work: ${item.label}`,quality:scene.getLightingQuality(),
          width:renderer.domElement.width,height:renderer.domElement.height,completedFrameMs:elapsed.summary(),
          camera:scene.camera.position.toArray(),rotation:scene.camera.quaternion.toArray(),
          mergedBuffers: {...game.world.distantSurface?.voxels.group.userData.voxelArenaStats},
          shadows:scene.getShadowsEnabled(),framesPerBatch:4,batches:12,excludesPresentation:true,excludesSimulation:true});
      }
      showResults([JSON.stringify(reports.slice(-3),null,2)]);
    } catch(error) { showResults([`Completed-work probe failed: ${String(error)}`]); }
    finally {resume();probing=false;gpuEnabled=tracking;restore(saved);if(suspended)requestAnimationFrame(game.animate);}
  }
  button('Check completed GPU work', () => { void checkCompletedWork(faceCases()); });
  button('Check completed far commands', () => { void checkCompletedWork(commandCases()); });
  button('Run render A/B (about 55s)', () => {
    if (comparison) return;
    if (game.uiStore?.getSnapshot()?.hasStarted === false) {
      showResults(['Click Play first to exclude the full-screen startup blur, then Escape to release the pointer.']);
      return;
    }
    const saved = capture();
    const cases = [{ label: 'Baseline', apply() {} },
      ...(['draw', 'far', 'near', 'micro', 'sky', 'post'] as const).map(key => ({
        label: `No ${key}`, apply() { flags[key] = false; },
      })),
      { label: 'No shadows', apply() { scene.setShadowsEnabled(false); } },
      { label: saved.resolution.scale > .5 ? '50% resolution' : '100% resolution',
        apply() { scene.setResolutionScale(saved.resolution.scale > .5 ? .5 : 1); } },
      { label: 'Baseline repeat', apply() {} }];
    comparison = { saved, cases, index: 0, warmUntil: 0, endAt: 0, warmed: false,
      rows: [`${saved.quality} | fixed ${Math.round(saved.resolution.scale * 100)}% | full effects | shadows ${scene.getShadowsEnabled() ? 'ON' : 'OFF'}`] };
    showResults(['Sampling; keep this tab foreground. Settings restore automatically.']);
    beginCase(performance.now());
  });
  button('Compare effect resolution (about 17s)', () => {
    if (comparison) return;
    if (game.uiStore?.getSnapshot()?.hasStarted === false || !scene.cinematicEffects) {
      showResults(['Click Play and select Ultra first. Keep the camera fixed during the comparison.']);
      return;
    }
    const saved = capture();
    comparison = { saved, index: 0, warmUntil: 0, endAt: 0, warmed: false,
      cases: ([0.5, 1, 0.5] as const).map((scale, i) => ({
        label: `${scale * 100}% effect resolution${i === 2 ? ' repeat' : ''}`,
        apply() { scene.cinematicEffects.setSecondaryResolutionScale(scale); },
      })),
      rows: [`Ultra | fixed ${Math.round(saved.resolution.scale * 100)}% scene | full effects | effect resolution only`] };
    beginCase(performance.now());
  });
  button('Compare voxel drawing (about 17s)', () => {
    if (comparison) return;
    const voxels = game.world.distantSurface?.voxels;
    if (!voxels || voxels.hasPendingWork || game.uiStore?.getSnapshot()?.hasStarted === false) {
      showResults(['Click Play and wait for distant terrain to settle. Keep the camera fixed during the comparison.']);
      return;
    }
    const saved = capture();
    comparison = { saved, index: 0, warmUntil: 0, endAt: 0, warmed: false,
      cases: [false, true, false].map((enabled, i) => ({
        label: `${enabled ? 'Optimized voxel drawing' : 'Reference voxel drawing'}${i === 2 ? ' repeat' : ''}`,
        apply() { voxels.setDrawOptimizationsEnabled(enabled); },
      })), rows: [`${saved.quality} | fixed ${Math.round(saved.resolution.scale * 100)}% | same resident geometry`] };
    showResults(['Sampling voxel drawing; keep this tab foreground and the camera fixed.']);
    beginCase(performance.now());
  });
  button('Check voxel pixels', () => {
    if (comparison) return;
    const voxels = game.world.distantSurface?.voxels;
    if (!voxels || voxels.hasPendingWork || game.uiStore?.getSnapshot()?.hasStarted === false
      || voxels.group.children.some((mesh: any) => mesh.name.includes('previous'))) {
      showResults(['Click Play and wait for distant geometry and transitions to settle before checking pixels.']);
      return;
    }
    const saved = capture();
    try {
      // An explicit, development-only readback check. Never part of frame
      // timing: render all captures synchronously at the same camera/time.
      scene.setResolutionScale(saved.resolution.scale);
      const capturePixels = (enabled: boolean, culling = enabled) => {
        voxels.setDrawOptimizationsEnabled(enabled, culling); scene.render(true);
        const canvas = document.createElement('canvas');
        canvas.width = renderer.domElement.width; canvas.height = renderer.domElement.height;
        const context = canvas.getContext('2d', { willReadFrequently: true })!;
        context.drawImage(renderer.domElement, 0, 0);
        return new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data);

      };
      const reference = capturePixels(false), optimized = capturePixels(true),
        shaderOnly = capturePixels(true, false), cullingOnly = capturePixels(false, true), repeat = capturePixels(false);
      const difference = (bytes: Uint8Array) => {
        let changed = 0, max = 0;
        for (let i = 0; i < reference.length; i += 4) {
          const delta = Math.max(...[0, 1, 2].map(c => Math.abs(bytes[i + c] - reference[i + c])));
          if (delta > 2) changed++;
          max = Math.max(max, delta);
        }
        return `${changed} pixels differ by >2/255; max channel delta ${max}/255`;
      };
      showResults([`Voxel pixel check: ${renderer.domElement.width} x ${renderer.domElement.height}`,
        `Optimized: ${difference(optimized)}`, `Shader only: ${difference(shaderOnly)}`,
        `Culling only: ${difference(cullingOnly)}`, `Reference repeat: ${difference(repeat)}`,
        'Synchronous readback; excluded from timing. Original settings restored.']);
    } catch (error) { showResults([`Voxel pixel check failed: ${String(error)}`]); }
    finally { restore(saved); scene.render(true); }
  });
  button('Reset isolation', () => {
    if (comparison) { const saved = comparison.saved; comparison = null; restore(saved); }
    for (const key of Object.keys(flags)) flags[key] = true;
    refreshButtons(); clear();
  });
  const measure = (target: any, key: string, name: string) => {
    if (!target) return;
    undo.push(interceptMethod(target, key, (original, args) => {
      const start = performance.now();
      try { return original(...args); }
      finally { stage.set(name, (stage.get(name) ?? 0) + performance.now() - start); }
    }));
  };
  for (const [target, method, label] of [
    [game.entitySimulationClock, 'advance', 'Simulation'], [game.controller, 'updateAimRaycast', 'Picking'],
    [game.world, 'updateChunksAround', 'Terrain window'], [game.world, 'processInteractiveTerrainWork', 'Terrain publish'],
    [game.uiStore, 'updateHUD', 'HUD'], [game.minimap, 'update', 'Minimap'],
    [game.world.distantSurface, 'updateView', 'LOD view'], [scene, 'update', 'Scene update'],
    [scene, 'render', 'Render total'], [renderer, 'render', 'WebGPU submit'],
  ] as const) measure(target, method, label);
  undo.push(interceptMethod(scene, 'renderWorld', (original, args) => {
    if (!flags.draw) { renderer.clear(); return; }
    const hidden = [];
    if (!flags.sky) hidden.push(scene.skyDome);
    if (!flags.far) hidden.push(game.world.distantSurface?.mesh);
    if (!flags.near) for (const chunk of game.world.chunks.values()) hidden.push(chunk.mesh);
    if (!flags.micro) for (const mesh of game.world.microVoxels.renderMeshes.values()) hidden.push(mesh);
    return withHiddenObjects(hidden, () => {
      if (flags.post) original(...args);
      else renderer.render(scene.scene, scene.camera);
    });
  }));
  undo.push(interceptMethod(scene, 'render', (original, args) => {
    const sample = timer && gpuEnabled && ++gpuFrame % 6 === 0 && !pending;
    const sampleEpoch = epoch;
    const pool = backend.timestampQueryPool.render;
    if (sample) pool?.timestamps.clear();
    backend.trackTimestamp = sample;
    try { return original(...args); }
    finally {
      if (sample) pending = renderer.resolveTimestampsAsync().then(() => {
        // The HDR chain contains several renderer.render calls. Sum all of
        // this sample's passes instead of returning only the last frame ID.
        const times = backend.timestampQueryPool.render?.timestamps;
        let total = 0;
        if (times) for (const value of times.values()) total += value;
        if (!disposed && sampleEpoch === epoch && total > 0) metric('GPU').add(total);
      }).catch(error => showResults([`GPU timer failed: ${String(error)}`])).finally(() => { pending = null; });
      backend.trackTimestamp = false;
    }
  }));
  function publish(now: number) {
    const cadence = metric('Frame').summary(), cpu = metric('CPU').summary(), gpu = metric('GPU').summary();
    const resolution = scene.getResolutionScaleState();
    const fmt = (n: number) => n.toFixed(2);
    const arena=game.world.distantSurface?.voxels.group.userData.voxelArenaStats;
    stats.textContent = `Merged buffers ${game.world.distantSurface?.voxels.getMergedBuffersEnabled() ? 'ON' : 'OFF'}\nFar command cache ${game.world.distantSurface?.voxels.getCommandCachingEnabled() ? 'ON' : 'OFF'}\n${cadence.count ? fmt(1000 / cadence.mean) : 'Warming up'} FPS | frame p50/p95 ${fmt(cadence.p50)}/${fmt(cadence.p95)} ms\nCPU p50/p95 ${fmt(cpu.p50)}/${fmt(cpu.p95)} ms | GPU ${!gpuEnabled ? 'OFF' : timer ? `${fmt(gpu.p50)}/${fmt(gpu.p95)} ms (${gpu.count} samples)` : 'timer unavailable'}\nWhole-frame calls ${calls} | triangles ${triangles}\nCanvas ${renderer.domElement.width} x ${renderer.domElement.height} | ${scene.getLightingQuality()} | scale ${resolution.scale} | effects ${resolution.effectsQuality}\nCPU stages p50/p95 (nested, not additive):\n`;
    for (const [name, values] of samples) {
      if (['Frame', 'CPU', 'GPU'].includes(name)) continue;
      const value = values.summary(); stats.textContent += `${name}: ${fmt(value.p50)}/${fmt(value.p95)} ms\n`;
    }
    if (arena) stats.textContent += `Arena ${arena.pages} pages / ${arena.draws} draws | ${(arena.bytes/1048576).toFixed(1)} MiB | source freed ${(arena.releasedSourceBytes/1048576).toFixed(1)} MiB\nCopy ${arena.copyMs.toFixed(2)} ms (max ${arena.maxCopyMs.toFixed(2)}) | pending ${arena.pendingSources}\n`;
    if (comparison) stats.textContent += `A/B ${comparison.index + 1}/${comparison.cases.length}: ${comparison.cases[comparison.index].label}`;
    published = now;
  }
  undo.push(interceptMethod(game, 'animate', (original, args) => {
    if (disposed) return original(...args);
    const start = performance.now();
    const frameTime = typeof args[0] === 'number' && Number.isFinite(args[0]) ? args[0] : start;
    stage.clear(); renderer.info.reset();
    if (comparison?.motion) {
      const progress=Math.max(0,Math.min(1,(start-comparison.warmUntil)/4000));
      game.controller.yaw=comparison.saved.view.yaw-.6+progress*1.2;
      game.controller.pitch=comparison.saved.view.pitch;
    }
    try { return original(...args); }
    finally {
      const now = performance.now();
      if (document.visibilityState === 'visible') {
        metric('CPU').add(now - start);
        if (previous) metric('Frame').add(frameTime - previous);
        for (const [name, duration] of stage) metric(name).add(duration);
        calls = renderer.info.render.drawCalls; triangles = renderer.info.render.triangles;
        previous = frameTime;
        if (comparison) {
          const run = comparison;
          if (!run.warmed && game.world.distantSurface?.voxels.hasPendingWork) {
            run.warmUntil = now + 1500; run.endAt = run.warmUntil + 4000;
          }
          if (!run.warmed && now >= run.warmUntil) { clear(); run.warmed = true; }
          if (now >= run.endAt) {
            const frame = metric('Frame').summary(), cpu = metric('CPU').summary(), gpu = metric('GPU').summary();
            const timings = Object.fromEntries([...samples].map(([name, values]) => [name, values.summary()]));
            reports.push({time:new Date().toISOString(),label:run.cases[run.index].label,
              motion:run.motion ? {yawStart:run.saved.view.yaw-.6,yawSweep:1.2,durationMs:4000,pitch:run.saved.view.pitch} : null,
              quality:scene.getLightingQuality(),shadows:scene.getShadowsEnabled(),flags:{...flags},gpuTimingEnabled:gpuEnabled,
              width:renderer.domElement.width,height:renderer.domElement.height,camera:scene.camera.position.toArray(),
              rotation:scene.camera.quaternion.toArray(),timings,frame:frameMetrics(metric('Frame').snapshot()),calls,triangles,
              geometry:game.world.distantSurface?.voxels.group.userData.voxelLodStats,
              mergedBuffers: {...game.world.distantSurface?.voxels.group.userData.voxelArenaStats},
              commandCache: {...game.world.distantSurface?.voxels.group.userData.commandCacheStats},
              nearOpaqueFastPath: game.world.distantSurface?.handoff.getOpaqueFastPathEnabled(),
              nearFrustumCulling: scene.nearFrustumCullingEnabled,
              stagesNested:true,gpuExcludesPresentation:true});
            run.rows.push(`${run.cases[run.index].label}: ${(1000 / (frame.mean || 1)).toFixed(1)} FPS | frame ${frame.p50.toFixed(2)}/${frame.p95.toFixed(2)} ms | CPU ${cpu.p50.toFixed(2)}/${cpu.p95.toFixed(2)} ms | GPU ${gpu.count ? gpu.p50.toFixed(2) : 'N/A'} ms | ${calls} calls / ${triangles} tris`);
            showResults(run.rows);
            if (++run.index < run.cases.length) beginCase(now);
            else { comparison = null; restore(run.saved); showResults([...run.rows, 'Done. Original settings restored.']); }
          }
        }
      } else {
        previous = 0;
        if (comparison) { const run = comparison; comparison = null; restore(run.saved); showResults([...run.rows, 'Cancelled: tab hidden; original settings restored.']); }
      }
      if (now - published >= 1000) publish(now);
    }
  }));
  const handle = { panel, dispose() {
    if (disposed) return;
    disposed = true;
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    if (comparison) { restore(comparison.saved); comparison = null; }
    for (const restoreMethod of undo.reverse()) restoreMethod();
    backend.trackTimestamp = previousTracking;
    renderer.info.autoReset = autoReset;
    panel.remove(); active.delete(game);
    window.removeEventListener('pagehide', handle.dispose);
  } };
  button('Close profiler', handle.dispose);
  window.addEventListener('pagehide', handle.dispose, { once: true });
  active.set(game, handle);
  return handle;
}
