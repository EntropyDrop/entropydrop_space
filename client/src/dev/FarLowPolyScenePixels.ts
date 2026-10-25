import { interceptMethod } from './FrameDiagnostics.ts';
import type { createFarLowPolyScene } from './FarLowPolyScene.ts';
if(import.meta.hot)import.meta.hot.accept();

/** Paused readback outside all frame measurements. Includes a restored A control. */
export async function checkFarLowPolyScenePixels(game:any,trial:Awaited<ReturnType<typeof createFarLowPolyScene>>) {
  if(!import.meta.env.DEV||!game.offline)throw new Error('Offline DEV required.');
  const scene=game.sceneRenderer,renderer=scene.renderer,saved={position:game.playerPhysics.position.clone(),yaw:game.controller.yaw,pitch:game.controller.pitch,enabled:trial.enabled};
  let stopped=false;const resume=interceptMethod(game,'animate',()=>{stopped=true;});
  while(!stopped)await new Promise<void>(r=>requestAnimationFrame(()=>r()));
  const canvas=document.createElement('canvas');canvas.width=renderer.domElement.width;canvas.height=renderer.domElement.height;
  const context=canvas.getContext('2d',{willReadFrequently:true})!,rows:any[]=[];
  try{
    for(const [name,yaw,pitch,dx,dz]of [['near',Math.PI/2,-.85,0,0],['across',Math.PI/2,1.35,0,0],['reverse',Math.PI*1.5,-.25,0,0],['moved',Math.PI/2+.6,-.35,16,8]] as const){
      game.playerPhysics.position.copy(saved.position).add({x:dx,y:0,z:dz});game.playerPhysics.resetRenderInterpolation();
      game.controller.yaw=yaw;game.controller.pitch=pitch;game.controller.updateRender(0);
      const images:Uint8ClampedArray[]=[],picks:string[]=[];
      for(const enabled of [false,true,false]){
        // Copy in this task before WebGPU presents/clears the canvas drawing buffer.
        trial.set(enabled);scene.render(true);scene.render(true);
        context.drawImage(renderer.domElement,0,0);images.push(context.getImageData(0,0,canvas.width,canvas.height).data);
        picks.push(JSON.stringify(game.controller.performAimRaycast()));
      }
      const differences=images.slice(1).map(image=>{let changed=0,sum=0,max=0;for(let i=0;i<image.length;i+=4){const d=Math.max(...[0,1,2].map(c=>Math.abs(image[i+c]-images[0][i+c])));if(d>2)changed++;sum+=d;max=Math.max(max,d);}return {changedOver2:changed,meanMaxRgb:sum/(image.length/4),max};});
      const nonempty=images.map(image=>image.some((v,i)=>i%4!==3&&v>0));
      if(nonempty.some(value=>!value))throw new Error('Canvas readback is empty; image comparison is invalid.');
      rows.push({name,width:canvas.width,height:canvas.height,differences,nonempty,identicalPicking:picks.every(p=>p===picks[0]),fallbackSources:trial.stats.fallbackSources});
    }
    sessionStorage.setItem(`full-lowpoly-images-${new URL(location.href).searchParams.get('world')}`,JSON.stringify(rows));
    return rows;
  }finally{
    trial.set(saved.enabled);game.playerPhysics.position.copy(saved.position);game.playerPhysics.resetRenderInterpolation();
    game.controller.yaw=saved.yaw;game.controller.pitch=saved.pitch;game.controller.updateRender(0);resume();requestAnimationFrame(game.animate);
  }
}
