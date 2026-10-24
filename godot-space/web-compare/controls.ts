import { captureMatchedLod } from './matched-lod.ts';
import { assertGpuBenchmarkEnvironment } from '../../client/src/dev/GpuBenchmarkEnvironment.ts';

if (new URLSearchParams(location.search).has('native_comparison')) install();
function install() {
  const profile = new URLSearchParams(location.search).get("lod_profile") === "fine" ? "fine" : "baseline";
  const game = (window as any).game;
  if (!game?.sceneRenderer?.renderer || !(window as any).copperSurfaceStatus) { setTimeout(install,250); return; }
  const scene=game.sceneRenderer, renderer=scene.renderer, camera=scene.camera;
  const panel=document.createElement('section');panel.id='native-comparison';
  panel.style.cssText='position:fixed;right:12px;top:12px;z-index:9999;background:#101820ee;color:white;padding:14px;font:13px monospace;max-width:330px';
  panel.innerHTML='<strong>Copper · actual Web client comparison</strong><p>Seed 20260922 · 128 real districts<br>1280 × 720 · Medium · shadows off</p>';
  const status=document.createElement('pre');status.style.whiteSpace='pre-wrap';panel.append(status);
  const button=(name:string,fn:()=>void)=>{const b=document.createElement('button');b.textContent=name;b.onclick=fn;b.style.margin='4px';panel.append(b);return b;};
  document.body.append(panel);
  let prepared=false, running=false, readyAt=0, started=0, previous=0, requestAt=0, t=0;
  let raw:number[]=[],cpu:number[]=[],maxCalls=0,maxTriangles=0,unfocused=0,hidden=false;
  let originalAnimate=game.animate,originalCamera=game.controller.updateCameraPosition;
  const savedAutoReset=renderer.info.autoReset;
  const pose=()=>{
    const p=[8402+60*Math.sin(t*Math.PI*2/24),240+15*Math.sin(t*Math.PI*2/16),1234+30*Math.cos(t*Math.PI*2/24)];
    const d=[8200-p[0],70-p[1],1032-p[2]];
    game.playerPhysics.position.set(p[0],p[1]-game.playerPhysics.eyeHeight,p[2]);
    game.playerPhysics.velocity.set(0,0,0);game.playerPhysics.isFlying=true;
    game.controller.yaw=Math.atan2(-d[0],-d[2]);
    game.controller.pitch=Math.atan2(d[1],Math.hypot(d[0],d[2]));
    camera.position.set(...p);camera.rotation.set(game.controller.pitch,game.controller.yaw,0,'YXZ');
    camera.fov=70;camera.aspect=1280/720;camera.updateProjectionMatrix();
  };
  const settled=()=>{
    const surface=(window as any).copperSurfaceStatus,layer=game.world.distantSurface.voxels;
    return game.world.distantSurface.isEnabled() && layer.arena.stats.residentFaces > 0
      && surface.ready && surface.passes>0 && !surface.error && game.world.getTerrainAoiLoadProgress().ready
      && !layer.hasPendingWork && !layer.hasPendingTransitions;
  };
  function prepare() {
    if(running)return;
    try{assertGpuBenchmarkEnvironment();}catch(e){status.textContent=String(e);return;}
    if(prepared)return;
    prepared=true;t=0;
    const old=document.getElementById('dev-render-diagnostics');if(old)old.style.display='none';
    scene.cappedDevicePixelRatio=()=>1;
    scene.setLightingQuality('medium');scene.setResolutionScale(1);scene.setShadowsEnabled(false);
    renderer.setPixelRatio(1);renderer.setSize(1280,720,false);
    // Freeze the production auto-disable guard, as the client's own GPU benchmarks do.
    // Otherwise startup streaming below 60 FPS silently removes all far geometry.
    game.uiStore.sampleDistantTerrainFrame=()=>{};
    game.uiStore.setDistantSurfaceEnabled(true,false);
    game.world.setDistantSurfaceSettings(profile === "fine"
      ? {subdivisionSizePx2:1, geometryBudgetMiB:512, dataBudgetMiB:1024, renderDistanceChunks:2048}
      : {subdivisionSizePx2:64, geometryBudgetMiB:160, dataBudgetMiB:512, renderDistanceChunks:2048});
    game.controller.updateCameraPosition=function(...args:any[]){originalCamera.apply(this,args);pose();};
    game.animate=function(...args:any[]){
      const now=performance.now();
      t=running && started ? Math.max(0,(now-started)/1000-8):0;
      pose();
      if(running)renderer.info.reset();
      const before=performance.now();originalAnimate.apply(this,args);const duration=performance.now()-before;
      if(!running)return;
      if(document.visibilityState!=='visible')hidden=true;
      if(!started){
        if(settled()){if(!readyAt)readyAt=now;if(now-readyAt>=2000){started=now;previous=now;}}
        else readyAt=0;
        if(now-requestAt>180000)finish('Terrain did not settle within 180 seconds');
        return;
      }
      const elapsed=(now-started)/1000,gap=now-previous;previous=now;
      if(elapsed>=8){raw.push(gap);cpu.push(duration);if(!document.hasFocus())unfocused++;
        maxCalls=Math.max(maxCalls,renderer.info.render.drawCalls);maxTriangles=Math.max(maxTriangles,renderer.info.render.triangles);}
      if(elapsed>=32)void finish();
    };
  }
  const summary=(values:number[])=>{
    const a=[...values].sort((a,b)=>a-b),mean=values.reduce((a,b)=>a+b,0)/values.length;
    const tail=a.slice(-Math.max(1,Math.ceil(a.length*.01)));
    return {count:a.length,mean,p50:a[Math.floor((a.length-1)*.5)],p95:a[Math.floor((a.length-1)*.95)],
      p99:a[Math.floor((a.length-1)*.99)],max:a.at(-1),slowestOnePercentMean:tail.reduce((a,b)=>a+b,0)/tail.length};
  };
  async function finish(error?:string) {
    running=false;renderer.info.autoReset=savedAutoReset;panel.style.display='';
    if(error){status.textContent=error;return;}
    const frameMs=summary(raw),layer=game.world.distantSurface.voxels;
    const data={backend:'Existing Space WebGPU client',world:'copper-metropolis',seed:20260922,
      utc:new Date().toISOString(),userAgent:navigator.userAgent,resolution:[renderer.domElement.width,renderer.domElement.height],
      quality:scene.getLightingQuality(),shadows:scene.getShadowsEnabled(),fov:70,
      warmupSeconds:8,durationSeconds:24,view:'terrain orbit',orbitCenter:[8402,240,1234],orbitTarget:[8200,70,1032],
      frameMs,fps:1000/frameMs.mean,onePercentLowFps:1000/frameMs.slowestOnePercentMean,
      cpuMs:summary(cpu),maxDrawCalls:maxCalls,maxPrimitives:maxTriangles,unfocusedFrames:unfocused,documentHidden:hidden,
      surface:{...(window as any).copperSurfaceStatus},near:game.world.getTerrainAoiLoadProgress(),
      distantSettings:game.world.getDistantSurfaceSettings(),arena:{...layer.arena.stats},lod:layer.group.userData.voxelLodStats,
      hudVisible:true,distantTerrainFpsGuardDisabled:true,farEnabled:game.world.distantSurface.isEnabled(),frameMetric:'Monotonic wall-clock animation callback intervals; not compositor presentation',rawFrameMs:raw};
    try {
      const response=await fetch('/__torus_comparison__/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
      if(!response.ok)throw new Error(await response.text());
      const saved=await response.json();
      status.textContent=`SAVED ${saved.file}\n${data.fps.toFixed(2)} FPS / p95 ${frameMs.p95.toFixed(2)} ms\n1% low ${data.onePercentLowFps.toFixed(2)} FPS\nUnfocused ${unfocused}, hidden ${hidden}`;
    } catch(e){status.textContent=String(e);}
  }
  let matched:any;
  button('Capture identical Web LOD',async()=>{try{prepare();if(!prepared||running)return;if(!settled())throw new Error('Wait for terrain to settle');
    matched=await captureMatchedLod(game,s=>status.textContent=s);
    panel.querySelector('strong')!.textContent='Copper · identical Web LOD replay';
    panel.querySelector('p')!.textContent='Fixed Web geometry · unlit source color · 4× MSAA · terrain only';
    for(const item of panel.querySelectorAll('button')) {
      if(!item.textContent?.startsWith('Run matched LOD') && item.textContent!=='Save matched image') item.hidden=true;
    }
    status.textContent=`SAVED identical LOD: ${matched.manifest.totalTriangles} triangles, ${matched.manifest.draws.length} draws`;
  }catch(e){status.textContent='SAVED ERROR '+String(e);}});
  button('Run matched LOD 720p',()=>matched?.run(1));
  button('Run matched LOD 1440p',()=>matched?.run(2));
  button('Run matched LOD 4K',()=>matched?.run(3));
  button('Run matched LOD 5K',()=>matched?.run(4));
  button('Save matched image',()=>matched?.save());
  button('Prepare city orbit',prepare);
  button('Inspect renderer',()=>{
    const layer=game.world.distantSurface;
    status.textContent='SAVED diagnostic '+JSON.stringify({enabled:layer.isEnabled(),zones:layer.loadedZones.size,
      hasView:layer.hasView,fixed:game.world.fixedTerrainCenter,settings:layer.getSettings(),detail:layer.getDetailStatus(),
      sources:layer.voxels.group.userData.voxelLodStats,arena:layer.voxels.arena.stats,
      position:camera.position.toArray(),rotation:camera.rotation.toArray(),surface:(window as any).copperSurfaceStatus},null,2);
  });
  button('Run 32-second comparison',()=>{
    if(running)return;prepare();if(!prepared)return;
    try{assertGpuBenchmarkEnvironment();}catch(e){status.textContent=String(e);return;}
    raw=[];cpu=[];maxCalls=0;maxTriangles=0;unfocused=0;hidden=false;readyAt=0;started=0;requestAt=performance.now();t=0;
    renderer.info.autoReset=false;running=true;panel.style.display='none';
  });
  button('Save scene PNG',async()=>{
    panel.style.display='none';
    await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
    const blob=await new Promise<Blob|null>(resolve=>renderer.domElement.toBlob(resolve,'image/png'));
    if(blob){const response=await fetch('/__torus_comparison__/image',{method:'POST',body:blob});status.textContent=await response.text();}
    panel.style.display='';
  });
  setInterval(()=>{
    if(!prepared||running){if(!running&&!status.textContent)status.textContent='Click Play, Escape, then Prepare city orbit.';return;}
    if(status.textContent?.startsWith('SAVED'))return;
    const s=(window as any).copperSurfaceStatus,n=game.world.getTerrainAoiLoadProgress();
    status.textContent=`${settled()?'READY':'LOADING'} · ${s.progress}\nNear ${n.readyChunks}/${n.totalChunks} · far passes ${s.passes}\n${s.error||''}`;
  },500);
}
