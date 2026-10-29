import { interceptMethod, guardTimestampWrites } from './FrameDiagnostics.ts';
import { GpuFrameTimeline } from './GpuFrameTimeline.ts';
const host=(parent as any).torusHost,terrain=(parent as any).torusTerrain;
const tick=()=>new Promise<void>(r=>requestAnimationFrame(()=>r()));
const profile=(parent as any).torusProfile;
const order=(profile==='fixed'?['torus','across']:profile==='maintenance'?['torus','turn']:['torus','across','turn']).flatMap(mode=>(profile==='maintenance'?['reference','cpu','cpu','reference']:['reference','tight','tight','reference']).map(variant=>({mode,variant})));
let game:any,undoPose=()=>{},undoRender=()=>{},timeline:GpuFrameTimeline|undefined,unguard=()=>{},undoTerrain=()=>{},terrainCpu=0,across=false,turning=false,poseStart=0;
try{
 for(let n=0;!document.querySelector('#dev-render-diagnostics');n++){if(n>6000)throw Error('Scene load timeout');await tick();}
 game=(window as any).game;
 const scene=game.sceneRenderer,renderer=scene.renderer,layer=game.world.distantSurface.voxels,arena=layer.arena;
 if(!game.offline||game.world.terrainGen.version<11||innerWidth!==1280||innerHeight!==720)throw Error('Invalid fixture');
 game.uiStore.startGame(false);game.uiStore.setDistantSurfaceEnabled(true,false);game.world.setRenderDistance(8,8);game.world.distantSurface.setSettings({renderDistanceChunks:576,subdivisionSizePx2:64,dataBudgetMiB:profile==='fixed'?1024:512,geometryBudgetMiB:profile==='fixed'?512:160,torusBackfaceCulling:false});
 scene.setLightingQuality('medium');scene.setShadowsEnabled(false);scene.scene.fog.density=0;
 if(profile==='fixed')layer.setFixedCellSizeForBenchmark(1);
 game.controller.setFov(70);scene.camera.fov=70;scene.camera.far=16384;scene.camera.updateProjectionMatrix();scene.setResolutionScale(1);
 const pose=()=>{game.playerPhysics.isFlying=true;game.playerPhysics.position.set(8192.5,180-game.playerPhysics.eyeHeight,1024.5);game.playerPhysics.velocity.set(0,0,0);game.playerPhysics.resetRenderInterpolation();game.controller.yaw=turning?Math.sin((performance.now()-poseStart)*Math.PI/1000)*.35:0;game.controller.pitch=(across?85:-18)*Math.PI/180;};
 undoPose=interceptMethod(game,'animate',(original,args)=>{pose();return original(...args);});
 undoRender=interceptMethod(scene,'render',(original,args)=>{if(scene.playerFirstPersonHand)scene.playerFirstPersonHand.visible=false;return original(...args);});pose();
 for(let n=0,stable=0;stable<180;n++){
  await tick();const surface=(window as any).offlineSurfaceStatus;if(surface?.error)throw Error(surface.error);
  if(layer.preparationError)throw Error(layer.preparationError);
  stable=surface?.generated===8&&(profile!=='fixed'||surface?.fineZones===8)&&!layer.hasPendingWork&&!layer.hasPendingTransitions&&game.world.getTerrainAoiLoadProgress().ready?stable+1:0;
  if(n%120===0)await host.status({state:'warming',surface,stable,pending:layer.hasPendingWork});if(n>30000)throw Error('Terrain settle timeout');
 }
 if(profile==='maintenance'){const until=performance.now()+30000;await host.status({state:'steady warmup'});while(performance.now()<until)await tick();}
 document.querySelectorAll<HTMLElement>('#dev-render-diagnostics,#root').forEach(e=>e.style.visibility='hidden');
 const result:any={schema:'torus-lod-alignment-v1',profile,terrain,width:renderer.domElement.width,height:renderer.domElement.height,samples:renderer.samples,fov:scene.camera.fov,projectionY:scene.camera.projectionMatrix.elements[5],cameraEye:[8192.5,180,1024.5],nearChunks:8,farChunks:576,settings:game.world.distantSurface.getSettings(),userAgent:navigator.userAgent,rows:[],errors:[]};
 if(result.width!==1280||result.height!==720||renderer.samples!==0)throw Error('Framebuffer mismatch');
 if(profile==='maintenance')undoTerrain=interceptMethod(layer,'updateView',(original,args)=>{const start=performance.now();try{return original(...args);}finally{terrainCpu+=performance.now()-start;}});
 const device=renderer.backend.device;renderer.backend.trackTimestamp=false;renderer.info.autoReset=false;unguard=guardTimestampWrites(renderer.backend);timeline=new GpuFrameTimeline(device);device.addEventListener('uncapturederror',(e:any)=>result.errors.push(e.error.message));
 const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const ctx=canvas.getContext('2d')!;
 let pending:Promise<void>|undefined,serial=0;
 for(const [block,{mode,variant}] of order.entries()){
  arena.setTightIdleCullingEnabled(variant==='tight');layer.setIdleMaintenanceEnabled(variant==='cpu');
  across=mode==='across';turning=mode==='turn';poseStart=performance.now();game.uiStore.setWorldProjection(mode==='flat'?'flat':'torus',false);pose();
  await host.status({state:'sampling',block,mode,variant});
  const raw:any[]=[],gpu:any[]=[];let start=0,previous=0,undo=()=>{};
  await new Promise<void>((resolve,reject)=>{undo=interceptMethod(game,'animate',(original,args)=>{
   const now=performance.now();start ||= now;const elapsed=now-start,timed=elapsed>=5000&&++serial%6===0&&!pending;
   terrainCpu=0;renderer.info.reset();if(timed)timeline!.begin();original(...args);const cpu=performance.now()-now;
   if(timed)pending=timeline!.end().then(r=>{if(r)gpu.push(r);}).finally(()=>{pending=undefined;});
   if(Math.abs(scene.camera.fov-70)>.00001)throw Error('Effective FOV changed');
   if(document.visibilityState!=='visible'||renderer.domElement.width!==1280||renderer.domElement.height!==720){reject(Error('Visibility or size changed'));return;}
   if(elapsed>=5000&&previous)raw.push({frame:now-previous,cpu,terrainCpu,calls:renderer.info.render.drawCalls,triangles:renderer.info.render.triangles,visibleFaces:arena.stats.visibleFaces,drawnFaces:arena.stats.drawnFaces,tightIdle:arena.stats.tightIdle,residentFaces:arena.stats.residentFaces,backFaces:arena.stats.backFaces,outsideFaces:arena.stats.outsideFaces,pending:layer.hasPendingWork||layer.hasPendingTransitions});
   previous=now;if(elapsed>=15000)resolve();
  });}).finally(()=>undo());await pending;
  result.rows.push({block,mode,variant,raw,gpu,lod:layer.group.userData.voxelLodStats,arena:{...arena.stats},sourceMips:[...layer.zones.values()].map((z:any)=>({x:z.snapshot.zoneX,z:z.snapshot.zoneZ,sizes:z.snapshot.voxelMips.map((m:any)=>m.cellSize)}))});await host.save('result.json',result);
  const png=await new Promise<string>(resolve=>{const undo=interceptMethod(scene,'render',(original,args)=>{const value=original(...args);ctx.drawImage(renderer.domElement,0,0);undo();resolve(canvas.toDataURL());return value;});});await host.save(variant+'-'+mode+'.png',png);
 }
 await host.status({state:'complete',blocks:result.rows.length,errors:result.errors});
}catch(error){await host.status({state:'FAILED',error:String(error)});}
finally{undoPose();undoRender();undoTerrain();timeline?.dispose();unguard();}
