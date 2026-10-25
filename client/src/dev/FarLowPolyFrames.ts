/** Complete ordinary game-frame comparisons; never imported by production. */
import { interceptMethod, guardTimestampWrites } from './FrameDiagnostics.ts';
import { summarize } from './MaintenanceBenchmark.ts';
import { GpuFrameTimeline } from './GpuFrameTimeline.ts';
import { assertGpuBenchmarkEnvironment } from './GpuBenchmarkEnvironment.ts';
import type { createFarLowPolyScene } from './FarLowPolyScene.ts';

if(import.meta.hot)import.meta.hot.accept();
type Trial=Awaited<ReturnType<typeof createFarLowPolyScene>>;
type Motion='fixed'|'sweep'|'move'|'across';
export async function runFarLowPolyFrames(game:any,trial:Trial,options:{motions?:Motion[];sampleMs?:number;warmMs?:number;order?:boolean[];control?:boolean}={}) {
  if(!import.meta.env.DEV||!game.offline)throw new Error('Offline DEV required.');
  assertGpuBenchmarkEnvironment();
  const scene=game.sceneRenderer,renderer=scene.renderer,layer=game.world.distantSurface.voxels,device=renderer.backend.device;
  if(!renderer.hasFeature('timestamp-query'))throw new Error('GPU timestamps required.');
  const saved={position:game.playerPhysics.position.clone(),yaw:game.controller.yaw,pitch:game.controller.pitch,
    tracking:renderer.backend.trackTimestamp,autoReset:renderer.info.autoReset,resolution:scene.getResolutionScaleState(),enabled:trial.enabled};
  const panels=[...document.querySelectorAll<HTMLElement>('#dev-render-diagnostics,#lowpoly-scene-status')];
  const displays=panels.map(p=>p.style.display);panels.forEach(p=>p.style.display='none');
  const restoreGuard=guardTimestampWrites(renderer.backend),timeline=new GpuFrameTimeline(device);
  renderer.backend.trackTimestamp=false;renderer.info.autoReset=false;scene.setResolutionScale(1);
  let pending:Promise<void>|null=null,gpuTick=0;
  const errors:string[]=[];const onError=(e:any)=>errors.push(e.error.message);device.addEventListener('uncapturederror',onError);
  const result:any={revision:'full-scene-lowpoly-v1',world:new URL(location.href).searchParams.get('world'),time:new Date().toISOString(),
    control:!!options.control,pixels:trial.stats.pixels,width:renderer.domElement.width,height:renderer.domElement.height,
    quality:scene.getLightingQuality(),shadows:scene.getShadowsEnabled(),userAgent:navigator.userAgent,
    adapter:Object.fromEntries(['vendor','architecture','device','description'].map(k=>[k,device.adapterInfo?.[k]])),
    camera:saved.position.toArray(),construction:{...trial.stats},rows:[],errors};
  const sampleMs=options.sampleMs??4000,warmMs=options.warmMs??1500;
  async function save(){
    const key=`full-lowpoly-${result.world}-${options.control?'control':'comparison'}-gzip`;
    const bytes=new Uint8Array(await new Response(new Blob([JSON.stringify(result)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));sessionStorage.setItem(key,btoa(binary));
  }
  function pose(motion:Motion,t:number){
    game.controller.yaw=Math.PI/2+(motion==='sweep'||motion==='move'?.6*Math.sin(t*Math.PI*2):0);
    game.controller.pitch=motion==='across'?1.35:-.85;
    game.playerPhysics.position.copy(saved.position);
    if(motion==='move'){game.playerPhysics.position.x+=16*Math.sin(t*Math.PI*2);game.playerPhysics.position.z+=8*(1-Math.cos(t*Math.PI*2));}
    game.playerPhysics.velocity.set(0,0,0);game.playerPhysics.resetRenderInterpolation();
  }
  try {
    for(const motion of options.motions??['fixed','sweep','move']){
      const order=options.order??[false,true,true,false,true,false,false,true];
      for(let block=0;block<order.length;block++){
        const candidate=order[block];trial.set(!options.control&&candidate);
        const raw:{frame:number;cpu:number;calls:number;triangles:number;pending:boolean;fallback:number}[]=[],gpu:any[]=[];
        const refreshStart={count:trial.stats.refreshes,ms:trial.stats.refreshMs};
        const residentStart=layer.arena.stats.residentFaces;
        let undo=()=>{},previous=0,start=0,finished=false,serial=0;
        await new Promise<void>((resolve,reject)=>{
          undo=interceptMethod(game,'animate',(original,args)=>{
            if(finished)return original(...args);
            const now=performance.now(),stamp=Number(args[0])||now;if(!start)start=now;
            const elapsed=now-start,warm=elapsed<warmMs;
            pose(motion,warm?elapsed/warmMs:(elapsed-warmMs)/sampleMs);
            const timed=!warm&&++gpuTick%6===0&&!pending;
            renderer.info.reset();if(timed)timeline.begin();
            try{original(...args);}catch(error){finished=true;reject(error);return;}
            const cpu=performance.now()-now;
            if(timed){const frameSerial=serial;pending=timeline.end().then(row=>{if(row)gpu.push({frame:frameSerial,...row});}).catch(e=>{errors.push(String(e));}).finally(()=>{pending=null;});}
            if(document.visibilityState!=='visible'||renderer.domElement.width!==result.width||renderer.domElement.height!==result.height
              ||!game.world.distantSurface.isEnabled()){finished=true;reject(new Error('Frame benchmark workload changed.'));return;}
            if(!warm&&previous){raw.push({frame:stamp-previous,cpu,calls:renderer.info.render.drawCalls,triangles:renderer.info.render.triangles,
              pending:layer.hasPendingWork||layer.hasPendingTransitions,fallback:candidate?trial.stats.fallbackSources:0});serial++;}
            previous=stamp;
            if(elapsed>=warmMs+sampleMs){finished=true;resolve();}
          });
        }).finally(()=>undo());
        await pending;
        const metrics=Object.fromEntries(['frame','cpu','calls','triangles'].map(k=>[k,summarize(raw.map(r=>(r as any)[k]))]));
        metrics.gpu=summarize(gpu.map(r=>r.spanMs));
        result.rows.push({motion,block,role:candidate?'candidate':'reference',actual:trial.enabled?'lowpoly':'packed',metrics,
          fps:1000/metrics.frame.mean,pendingFrames:raw.filter(r=>r.pending).length,maxFallback:Math.max(0,...raw.map(r=>r.fallback)),
          residentStart,residentEnd:layer.arena.stats.residentFaces,refreshes:trial.stats.refreshes-refreshStart.count,
          refreshMs:trial.stats.refreshMs-refreshStart.ms,raw,gpu});
        await save();
      }
    }
    assertGpuBenchmarkEnvironment();return result;
  }finally{
    await pending;timeline.dispose();restoreGuard();device.removeEventListener('uncapturederror',onError);
    renderer.backend.trackTimestamp=saved.tracking;renderer.info.autoReset=saved.autoReset;
    game.playerPhysics.position.copy(saved.position);game.playerPhysics.velocity.set(0,0,0);game.playerPhysics.resetRenderInterpolation();
    game.controller.yaw=saved.yaw;game.controller.pitch=saved.pitch;trial.set(saved.enabled);
    scene.setResolutionScale(saved.resolution.mode==='auto'?'auto':saved.resolution.fixedScale);
    panels.forEach((p,i)=>p.style.display=displays[i]);
  }
}
