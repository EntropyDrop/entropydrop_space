import { interceptMethod, guardTimestampWrites } from './FrameDiagnostics.ts';
import { GpuFrameTimeline } from './GpuFrameTimeline.ts';
const host=(parent as any).torusHost,terrain=(parent as any).torusTerrain;
const tick=()=>new Promise<void>(r=>requestAnimationFrame(()=>r()));
const order=['flat','torus','across','across','torus','flat'];
let game:any,undoPose=()=>{},undoRender=()=>{},timeline:GpuFrameTimeline|undefined,unguard=()=>{},across=false;
try{
 for(let n=0;!document.querySelector('#dev-render-diagnostics');n++){if(n>6000)throw Error('Scene load timeout');await tick();}
 game=(window as any).game;
 const scene=game.sceneRenderer,renderer=scene.renderer,layer=game.world.distantSurface.voxels,arena=layer.arena;
 if(!game.offline||game.world.terrainGen.version<11||innerWidth!==1280||innerHeight!==720)throw Error('Invalid fixture');
 game.uiStore.startGame(false);game.uiStore.setDistantSurfaceEnabled(true,false);game.world.setRenderDistance(8,8);game.world.distantSurface.setSettings({renderDistanceChunks:576});
 scene.camera.fov=70;scene.camera.far=16384;scene.camera.updateProjectionMatrix();scene.setResolutionScale(1);
 const pose=()=>{game.playerPhysics.position.set(8192.5,180-game.playerPhysics.eyeHeight,1024.5);game.playerPhysics.velocity.set(0,0,0);game.playerPhysics.resetRenderInterpolation();game.controller.yaw=0;game.controller.pitch=(across?85:-18)*Math.PI/180;};
 undoPose=interceptMethod(game,'animate',(original,args)=>{pose();return original(...args);});
 undoRender=interceptMethod(scene,'render',(original,args)=>{if(scene.playerFirstPersonHand)scene.playerFirstPersonHand.visible=false;return original(...args);});pose();
 for(let n=0,stable=0;stable<180;n++){
  await tick();const surface=(window as any).offlineSurfaceStatus;if(surface?.error)throw Error(surface.error);
  stable=surface?.generated===8&&!layer.hasPendingWork&&!layer.hasPendingTransitions&&game.world.getTerrainAoiLoadProgress().ready?stable+1:0;
  if(n%120===0)await host.status({state:'warming',surface,stable,pending:layer.hasPendingWork});if(n>30000)throw Error('Terrain settle timeout');
 }
 document.querySelectorAll<HTMLElement>('#dev-render-diagnostics,#root').forEach(e=>e.style.visibility='hidden');
 const result:any={schema:'torus-space-v1',terrain,width:renderer.domElement.width,height:renderer.domElement.height,samples:renderer.samples,fov:70,cameraEye:[8192.5,180,1024.5],nearChunks:8,farChunks:576,settings:game.world.distantSurface.getSettings(),userAgent:navigator.userAgent,rows:[],errors:[]};
 if(result.width!==1280||result.height!==720||renderer.samples!==0)throw Error('Framebuffer mismatch');
 const device=renderer.backend.device;renderer.backend.trackTimestamp=false;renderer.info.autoReset=false;unguard=guardTimestampWrites(renderer.backend);timeline=new GpuFrameTimeline(device);device.addEventListener('uncapturederror',(e:any)=>result.errors.push(e.error.message));
 const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const ctx=canvas.getContext('2d')!;
 let pending:Promise<void>|undefined,serial=0;
 for(const [block,mode] of order.entries()){
  across=mode==='across';game.uiStore.setWorldProjection(mode==='flat'?'flat':'torus',false);pose();
  await host.status({state:'sampling',block,mode});
  const raw:any[]=[],gpu:any[]=[];let start=0,previous=0,undo=()=>{};
  await new Promise<void>((resolve,reject)=>{undo=interceptMethod(game,'animate',(original,args)=>{
   const now=performance.now();start ||= now;const elapsed=now-start,timed=elapsed>=5000&&++serial%6===0&&!pending;
   renderer.info.reset();if(timed)timeline!.begin();original(...args);const cpu=performance.now()-now;
   if(timed)pending=timeline!.end().then(r=>{if(r)gpu.push(r);}).finally(()=>{pending=undefined;});
   if(document.visibilityState!=='visible'||renderer.domElement.width!==1280||renderer.domElement.height!==720){reject(Error('Visibility or size changed'));return;}
   if(elapsed>=5000&&previous)raw.push({frame:now-previous,cpu,calls:renderer.info.render.drawCalls,triangles:renderer.info.render.triangles,visibleFaces:arena.stats.visibleFaces,drawnFaces:arena.stats.drawnFaces,pending:layer.hasPendingWork||layer.hasPendingTransitions});
   previous=now;if(elapsed>=15000)resolve();
  });}).finally(()=>undo());await pending;
  result.rows.push({block,mode,raw,gpu});await host.save('result.json',result);
  const png=await new Promise<string>(resolve=>{const undo=interceptMethod(scene,'render',(original,args)=>{const value=original(...args);ctx.drawImage(renderer.domElement,0,0);undo();resolve(canvas.toDataURL());return value;});});await host.save(mode+'.png',png);
 }
 await host.status({state:'complete',blocks:result.rows.length,errors:result.errors});
}catch(error){await host.status({state:'FAILED',error:String(error)});}
finally{undoPose();undoRender();timeline?.dispose();unguard();}
