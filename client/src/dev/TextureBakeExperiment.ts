/** DEV-only ordinary-frame benchmark. Run from texture-bake-browser.html. */
import {interceptMethod, guardTimestampWrites} from './FrameDiagnostics.ts';
import {GpuFrameTimeline} from './GpuFrameTimeline.ts';
import {assertGpuBenchmarkEnvironment} from './GpuBenchmarkEnvironment.ts';
import {summarize} from './MaintenanceBenchmark.ts';
import {DEFAULT_DISTANT_SURFACE_SETTINGS} from '@entropydrop/space-engine/render/DistantSurfaceLayer.ts';
if (!import.meta.env.DEV || !['localhost','127.0.0.1'].includes(location.hostname)) throw Error('Local DEV required');
const host=(parent as any).textureBakeHost, options=(window as any).textureBakeConfig;
const tick=()=>new Promise<void>(r=>requestAnimationFrame(()=>r()));
let game:any, saved:any, undoPose=()=>{}, restoreGuard=()=>{}, timeline:GpuFrameTimeline|undefined;
let pending:Promise<void>|null=null;
const errors:string[]=[];
try {
  host.note(`${options.world}: loading`);
  const deadline=performance.now()+300000;
  while(!(window as any).game || !document.querySelector('#dev-render-diagnostics')) {
    if(performance.now()>deadline)throw Error('Scene load timeout'); await tick();
  }
  game=(window as any).game; const scene=game.sceneRenderer, renderer=scene.renderer, far=game.world.distantSurface, layer=far.voxels;
  await scene.ready;
  if(!game.offline||innerWidth!==1280||innerHeight!==720||!renderer.backend.isWebGPUBackend||!renderer.hasFeature('timestamp-query'))throw Error('Invalid benchmark fixture');
  saved={settings:far.getSettings(),position:game.playerPhysics.position.clone(),yaw:game.controller.yaw,pitch:game.controller.pitch,
    tracking:renderer.backend.trackTimestamp,autoReset:renderer.info.autoReset,resolution:scene.getResolutionScaleState(),pageFaces:layer.getArenaPageCapacity(),unified:layer.getUnifiedBakedArena()};
  game.uiStore.startGame(false);game.uiStore.setDistantSurfaceEnabled(true,false);scene.setResolutionScale(1);await tick();await tick();
  const panel=document.querySelector<HTMLElement>('#dev-render-diagnostics')!;panel.style.display='none';
  const origin=saved.position.clone();if(options.world==='nature')origin.y=180;
  let view='across',motionTime=0;
  const pose=()=>{game.playerPhysics.position.copy(origin);game.playerPhysics.velocity.set(0,0,0);game.playerPhysics.resetRenderInterpolation();
    game.controller.yaw=Math.PI/2+(['sweep','turn'].includes(view)?.5*Math.sin(motionTime*2*Math.PI):0);
    game.controller.pitch=['horizon','turn'].includes(view)?-.15:view==='near'?-.85:1.35;};
  undoPose=interceptMethod(game,'animate',(original,args)=>{pose();return original(...args);});
  const device=renderer.backend.device;
  device.addEventListener('uncapturederror',(e:any)=>errors.push(e.error.message));
  restoreGuard=guardTimestampWrites(renderer.backend);renderer.backend.trackTimestamp=false;renderer.info.autoReset=false;
  timeline=new GpuFrameTimeline(device);
  const result:any={revision:options.proxy?'texture-bake-v3-proxy':'texture-bake-v2-settled',world:options.world,time:new Date().toISOString(),userAgent:navigator.userAgent,
    probe:!!options.probe,interruptedBlocks:0,shader:'conditional-atlas-uv-v1',
    control:!!options.control,backend:'WebGPU',timestampQuery:renderer.hasFeature('timestamp-query'),
    adapter:Object.fromEntries(['vendor','architecture','device','description'].map(k=>[k,device.adapterInfo?.[k]])),
    width:renderer.domElement.width,height:renderer.domElement.height,quality:scene.getLightingQuality(),shadows:scene.getShadowsEnabled(),settings:DEFAULT_DISTANT_SURFACE_SETTINGS,rows:[],errors};
  const variants:any={off:{textureProxyEnabled:false},edge8:{textureProxyEnabled:true},edge16:{textureProxyEnabled:true,textureProxyEdge:16},smooth:{textureProxyEnabled:true,textureProxyLinear:true},detail2:{textureProxyEnabled:true,textureProxyDensity:2}};
  Object.assign(variants, {batch1024:{textureProxyEnabled:false},surface32:{textureProxyEnabled:true,textureProxyLodBias:0,textureProxyEdge:32},proxy32:{textureProxyEnabled:true,textureProxyLodBias:1,textureProxyEdge:32},
    proxynear:{textureProxyEnabled:true,textureProxyLodBias:1,textureProxyEdge:32,textureProxyDistance:256}});
  variants.unified32=variants.repack32=variants.surface32;
  async function foreground(rewarm=false) {
    if(document.visibilityState==='visible'&&!rewarm)return;
    let until=0;
    while(true){
      if(document.visibilityState!=='visible'){until=0;host.note('Paused: return to the benchmark tab to resume');await new Promise(r=>setTimeout(r,250));continue;}
      if(!until)until=performance.now()+30000;
      host.note(`${options.world}: excluded 30-second foreground warmup`);
      if(performance.now()>=until)return;
      await tick();
    }
  }
  async function settle(name:string) {
    let start=performance.now(),quiet=0,sourceSignature='';
    while(performance.now()-start<180000) {
      if(document.visibilityState!=='visible'){const paused=performance.now();await foreground();start+=performance.now()-paused;quiet=0;}assertGpuBenchmarkEnvironment();
      if(layer.preparationError||errors.length)throw Error(layer.preparationError||errors.join('\n'));
      const source=(window as any).offlineSurfaceStatus;
      if(source?.error)throw Error(source.error);
      const signature=`${source?.generated}/${source?.installed}/${source?.downloads}/${layer.group.userData.voxelLodWorkStats.publications}`;
      if(signature!==sourceSignature){sourceSignature=signature;quiet=0;}
      if(source?.complete&&!far.hasPendingWork&&!layer.hasPendingWork&&!layer.hasPendingTransitions){if(!quiet)quiet=performance.now();if(performance.now()-quiet>8000)return performance.now()-start;}else quiet=0;
      host.note(`${options.world}/${name}: settling · ${layer.group.userData.voxelTextureStats?.used??0} atlases · ${layer.group.userData.voxelLodWorkStats.pendingTiles} tiles`);
      await tick();
    }
    throw Error('LOD did not settle: '+JSON.stringify(layer.group.userData.voxelLodWorkStats));
  }
  const order=options.repack?(options.probe?['off','surface32','repack32','off']:['off','surface32','repack32','repack32','surface32','off']):options.unified?(options.probe?['off','surface32','unified32','off']:['off','surface32','unified32','unified32','surface32','off']):options.proxy?(options.probe?['off','batch1024','surface32','proxy32','off']:['off','batch1024','surface32','proxy32','proxy32','surface32','batch1024','off']):options.probe?['off','edge8']:options.repeat?['off','edge8','edge16','edge16','edge8','off']:['off','edge8','edge16','smooth','detail2','off'];
  let block=0;
  for(const config of order) {
    const settings={...DEFAULT_DISTANT_SURFACE_SETTINGS,textureProxyLodBias:0,textureProxyEdge:8,textureProxyDensity:1,textureProxyDistance:384,textureProxyBudgetMiB:32,textureProxyLinear:false,textureProxyBatching:options.control?0:config==='unified32'?2:1,...variants[options.control?'off':config]};
    far.setSettings(settings);
    layer.setArenaPageCapacity(options.proxy && config!=='off' && !options.control ? 1024*1024 : 256*1024);
    layer.setUnifiedBakedArena(config==='unified32' && !options.control);
    let settleMs=await settle(config);
    if(config==='repack32'&&!options.control){layer.setMergedBuffersEnabled(false);layer.setMergedBuffersEnabled(true);settleMs+=await settle(config+' repacked');}
    if(options.repeat&&block===0){host.note(`${options.world}: excluded 30-second warmup`);const until=performance.now()+30000;while(performance.now()<until){await foreground();assertGpuBenchmarkEnvironment();await tick();}}
    for(view of options.proxy?(options.probe?['horizon','near']:['horizon','turn','near']):options.probe?['across']:options.repeat?['horizon','turn']:['across','near','sweep']) {
      let completed=false;
      while(!completed){
      await foreground();
      const raw:any[]=[],gpu:any[]=[];let previous=0,start=0,serial=0,finished=false;
      host.note(`${options.world}/${config}/${view}: measuring`);
      let undo=()=>{};
      try { await new Promise<void>((resolve,reject)=>{
        undo=interceptMethod(game,'animate',(original,args)=>{
          if(finished)return original(...args);
          const now=performance.now();if(!start)start=now;const elapsed=now-start,warm=elapsed<1500;
          motionTime=Math.max(0,elapsed-1500)/6000;
          const timed=!warm&&serial%6===0&&!pending;
          renderer.info.reset();if(timed)timeline!.begin();
          try{original(...args);}catch(e){finished=true;reject(e);return;}
          const cpu=performance.now()-now;
          if(timed)pending=timeline!.end().then(row=>{if(row)gpu.push(row);}).catch(e=>{errors.push(String(e));}).finally(()=>pending=null);
          if(document.visibilityState!=='visible'||errors.length){finished=true;reject(Error(errors.join('\n')||'Page hidden'));return;}
          const stamp=Number(args[0])||now;
          if(!warm&&previous){raw.push({frame:stamp-previous,cpu,calls:renderer.info.render.drawCalls,triangles:renderer.info.render.triangles,pending:layer.hasPendingWork||layer.hasPendingTransitions});serial++;}
          previous=stamp;if(elapsed>=(options.probe?2500:7500)){finished=true;resolve();}
        });
      }).finally(()=>undo());
      } catch(error){
        await pending;
        if(String(error).includes('Page hidden')){result.interruptedBlocks++;await foreground(true);continue;}
        throw error;
      }
      await pending;
      const metrics:any=Object.fromEntries(['frame','cpu','calls','triangles'].map(k=>[k,summarize(raw.map(r=>r[k]))]));metrics.gpu=summarize(gpu.map(r=>r.spanMs));
      result.rows.push({config,view,block:block++,settings,pageFaces:layer.getArenaPageCapacity(),unified:layer.getUnifiedBakedArena(),settleMs,metrics,fps:1000/metrics.frame.mean,
        texture:{...layer.group.userData.voxelTextureStats},arena:{...layer.group.userData.voxelArenaStats},arenaPages:(layer as any).arena?.pages.map((p:any)=>({baked:p.baked,faces:[...p.entries].reduce((s:number,e:any)=>s+e.count,0),entries:p.entries.size,free:p.free.reduce((s:number,r:any)=>s+r.count,0)})),pendingFrames:raw.filter(r=>r.pending).length,raw,gpu});
      await host.accept(options.world,result);
      if(!['sweep','turn'].includes(view)) {
        let stopped=false;const resume=interceptMethod(game,'animate',()=>{stopped=true;});while(!stopped)await tick();
        try{pose();game.controller.updateRender(0);scene.render(true);scene.render(true);
          const canvas=document.createElement('canvas');canvas.width=renderer.domElement.width;canvas.height=renderer.domElement.height;
          canvas.getContext('2d')!.drawImage(renderer.domElement,0,0);
          const image=await new Promise<Blob>(resolve=>canvas.toBlob(b=>resolve(b!)));
          await host.image(options.world,`${config}-${view}-${block}`,image);
        }finally{resume();requestAnimationFrame(game.animate);}
      }
      completed=true;
      }
    }
  }
  await foreground();assertGpuBenchmarkEnvironment();host.complete();
}catch(error){host.fail(String(error));}
finally{
  await pending;timeline?.dispose();restoreGuard();undoPose();
  if(saved){const scene=game.sceneRenderer;game.world.distantSurface.setSettings(saved.settings);game.world.distantSurface.voxels.setArenaPageCapacity(saved.pageFaces);game.world.distantSurface.voxels.setUnifiedBakedArena(saved.unified);game.playerPhysics.position.copy(saved.position);game.controller.yaw=saved.yaw;game.controller.pitch=saved.pitch;
    scene.renderer.backend.trackTimestamp=saved.tracking;scene.renderer.info.autoReset=saved.autoReset;scene.setResolutionScale(saved.resolution.mode==='auto'?'auto':saved.resolution.fixedScale);}
}
