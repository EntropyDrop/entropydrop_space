import { interceptMethod, guardTimestampWrites } from './FrameDiagnostics.ts';
import { GpuFrameTimeline } from './GpuFrameTimeline.ts';
import { getWorldProjection } from '@entropydrop/space-engine/torus/TorusWorld.ts';
const host=(parent as any).matchedHost;
const tick=()=>new Promise<void>(r=>requestAnimationFrame(()=>r()));
const fullOrder=['wide','near','near','wide','near','wide','wide','near','wide','flat','flat','wide','flat','wide','wide','flat'] as const;
const moving=(parent as any).matchedTrial==='flat-moving';
const order=(parent as any).matchedTrial?.startsWith('flat')?fullOrder.slice(8):fullOrder.slice(0,8);
let poseX=0,poseZ=0,poseYaw=0;
let game:any, undoPose=()=>{}, undoRender=()=>{}, timeline:GpuFrameTimeline|undefined, unguard=()=>{};
try {
  for(let n=0;!document.querySelector('#dev-render-diagnostics');n++) {if(n>6000)throw Error('Scene load timeout');await tick();}
  game=(window as any).game;
  const scene=game.sceneRenderer, renderer=scene.renderer, layer=game.world.distantSurface.voxels, arena=layer.arena;
  if(!game.offline || getWorldProjection()!=='flat' || innerWidth!==1280 || innerHeight!==720)throw Error('Invalid matched scene');
  game.uiStore.startGame(false);game.uiStore.setDistantSurfaceEnabled(true,false);
  game.world.setRenderDistance(8,8);
  game.world.distantSurface.setSettings({renderDistanceChunks:64});
  scene.camera.fov=70;scene.camera.far=1024;scene.camera.updateProjectionMatrix();
  scene.setResolutionScale(1);
  const pose=()=>{game.playerPhysics.position.set(8192.5+poseX,96-game.playerPhysics.eyeHeight,1024.5+poseZ);game.playerPhysics.velocity.set(0,0,0);game.playerPhysics.resetRenderInterpolation();game.controller.yaw=poseYaw;game.controller.pitch=-Math.PI/10;};
  undoPose=interceptMethod(game,'animate',(original,args)=>{pose();return original(...args);});
  undoRender=interceptMethod(scene,'render',(original,args)=>{if(scene.playerFirstPersonHand)scene.playerFirstPersonHand.visible=false;return original(...args);});
  pose();
  for(let n=0,stable=0;stable<180;n++){
    await tick();const surface=(window as any).offlineSurfaceStatus;
    if(surface?.error)throw Error(surface.error);
    stable=surface?.generated===4 && !layer.hasPendingWork && !layer.hasPendingTransitions && game.world.getTerrainAoiLoadProgress().ready?stable+1:0;
    if(n%120===0)await host.status({state:'warming',surface,stable,pending:layer.hasPendingWork});
    if(n>30000)throw Error('Terrain failed to settle');
  }
  document.querySelectorAll<HTMLElement>('#dev-render-diagnostics, #root').forEach(e=>e.style.visibility='hidden');
  const result:any={schema:'matched-space-v1',moving,terrainCrc32:'bef315c8',width:renderer.domElement.width,height:renderer.domElement.height,
    samples:renderer.samples,fov:scene.camera.fov,cameraEye:[512.5,96,512.5],yawDegrees:180,pitchDownDegrees:18,
    nearChunks:8,farChunks:64,settings:game.world.distantSurface.getSettings(),userAgent:navigator.userAgent,rows:[],pixels:[],errors:[]};
  if(result.width!==1280 || result.height!==720 || renderer.samples!==0)throw Error('Framebuffer / MSAA mismatch: '+JSON.stringify(result));
  const device=renderer.backend.device;renderer.backend.trackTimestamp=false;renderer.info.autoReset=false;
  unguard=guardTimestampWrites(renderer.backend);timeline=new GpuFrameTimeline(device);
  device.addEventListener('uncapturederror',(e:any)=>result.errors.push(e.error.message));
  const set=(mode:string)=>{game.uiStore.setDistantSurfaceEnabled(mode!=='near',false);layer.setFlatBlockCullingEnabled(mode==='flat');};
  const canvas=document.createElement('canvas');canvas.width=result.width;canvas.height=result.height;const ctx=canvas.getContext('2d')!;
  let reference:Uint8ClampedArray|undefined;
  for(const mode of ['wide','flat','restored','near']){
    set(mode);for(let i=0;i<120;i++)await tick();
    const png=await new Promise<string>(resolve=>{
      const undo=interceptMethod(scene,'render',(original,args)=>{const value=original(...args);ctx.drawImage(renderer.domElement,0,0);undo();resolve(canvas.toDataURL());return value;});
    });
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;reference??=pixels;
    let max=0,changed=0;for(let i=0;i<pixels.length;i+=4){const d=Math.max(...[0,1,2].map(k=>Math.abs(pixels[i+k]-reference![i+k])));max=Math.max(max,d);changed+=+(d>2);}
    result.pixels.push({mode,max,changedOver2:changed,visibleFaces:arena.stats.visibleFaces});await host.save(mode+'.png',png);
    if(mode==='flat' && arena.stats.visibleFaces>=result.pixels[0].visibleFaces)throw Error('Flat candidate did not reduce submitted faces');
    if(['flat','restored'].includes(mode) && changed)throw Error('Conservative culling changed pixels');
  }
  if(moving) {
    const views=[{x:0,z:0,yaw:0},{x:18,z:8,yaw:.07},{x:0,z:0,yaw:Math.PI/2},{x:0,z:0,yaw:Math.PI},{x:0,z:0,yaw:0}];
    const references:Uint8ClampedArray[]=[],picks:string[]=[];
    let stopped=false;const resume=interceptMethod(game,'animate',()=>{stopped=true;});
    while(!stopped)await tick();
    const publication=[interceptMethod(layer,'buildSynchronously',()=>{}),interceptMethod(layer,'processPending',()=>{})];
    try {
      for(const mode of ['wide','flat','restored']) {
        set(mode);
        for(const [index,view] of views.entries()) {
          poseX=view.x;poseZ=view.z;poseYaw=view.yaw;pose();game.controller.updateRender(0);
          scene.render(false,true);scene.render(false,true);ctx.drawImage(renderer.domElement,0,0);
          const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
          const pick=JSON.stringify(game.controller.performAimRaycast());
          if(mode==='wide'){references[index]=pixels;picks[index]=pick;}
          let max=0,changed=0;for(let i=0;i<pixels.length;i+=4){const d=Math.max(...[0,1,2].map(k=>Math.abs(pixels[i+k]-references[index][i+k])));max=Math.max(max,d);changed+=+(d>2);}
          result.pixels.push({mode,view,max,changedOver2:changed,identicalPicking:pick===picks[index],visibleFaces:arena.stats.visibleFaces});
          await host.save('view-'+index+'-'+mode+'.png',canvas.toDataURL());
          if(changed || pick!==picks[index]){await host.save('result.json',result);throw Error('Frozen moving-view correctness failed: '+JSON.stringify({mode,view,max,changed}));}
        }
      }
    } finally {publication.reverse().forEach(undo=>undo());resume();requestAnimationFrame(game.animate);}
  }
  let pending:Promise<void>|undefined,serial=0;
  for(const [block,mode] of order.entries()){
    set(mode);await host.status({state:'sampling',block,mode});
    const raw:any[]=[],gpu:any[]=[];let start=0,previous=0,undo=()=>{};
    await new Promise<void>((resolve,reject)=>{
      undo=interceptMethod(game,'animate',(original,args)=>{
        const now=performance.now();start ||= now;const elapsed=now-start,timed=elapsed>=5000 && ++serial%6===0 && !pending;
        if(moving){const phase=(elapsed<5000?elapsed/5000:(elapsed-5000)/10000)*Math.PI*2;
          poseX=16*Math.sin(phase);poseZ=8*(1-Math.cos(phase));poseYaw=.6*Math.sin(phase);}
        renderer.info.reset();if(timed)timeline!.begin();original(...args);const cpu=performance.now()-now;
        if(timed)pending=timeline!.end().then(r=>{if(r)gpu.push(r);}).finally(()=>{pending=undefined;});
        if(document.visibilityState!=='visible'||renderer.domElement.width!==1280||renderer.domElement.height!==720){reject(Error('Visibility or size changed'));return;}
        if(elapsed>=5000 && previous)raw.push({frame:now-previous,cpu,calls:renderer.info.render.drawCalls,triangles:renderer.info.render.triangles,visibleFaces:arena.stats.visibleFaces,drawnFaces:arena.stats.drawnFaces,pending:layer.hasPendingWork||layer.hasPendingTransitions});
        previous=now;if(elapsed>=15000)resolve();
      });
    }).finally(()=>undo());
    await pending;result.rows.push({block,mode,raw,gpu});await host.save('result.json',result);
  }
  set('wide');await host.status({state:'complete',blocks:result.rows.length,errors:result.errors});
}catch(error){await host.status({state:'FAILED',error:String(error)});}
finally{undoPose();undoRender();timeline?.dispose();unguard();}
