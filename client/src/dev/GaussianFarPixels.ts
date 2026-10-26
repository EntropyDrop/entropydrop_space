import { interceptMethod } from './FrameDiagnostics.ts';
import { GAUSSIAN_MODES, type GaussianMode, type GaussianFarTrial } from './GaussianFarTrial.ts';
if(import.meta.hot)import.meta.hot.accept();

export async function captureGaussianFarPixels(game:any,trial:GaussianFarTrial) {
  const scene=game.sceneRenderer,renderer=scene.renderer,saved={yaw:game.controller.yaw,pitch:game.controller.pitch,mode:trial.mode};
  let stopped=false;const resume=interceptMethod(game,'animate',()=>{stopped=true;});
  while(!stopped)await new Promise<void>(r=>requestAnimationFrame(()=>r()));
  const canvas=document.createElement('canvas');canvas.width=renderer.domElement.width;canvas.height=renderer.domElement.height;
  const context=canvas.getContext('2d',{willReadFrequently:true})!,images:Record<string,string>={},views:any[]=[];
  const compare=(a:Uint8ClampedArray,b:Uint8ClampedArray)=>{let changed=0,sum=0,max=0;for(let i=0;i<a.length;i+=4){
    const d=Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]));changed+=Number(d>2);sum+=d;max=Math.max(max,d);}
    return {changedOver2:changed,meanMaxRgb:sum/(a.length/4),max};};
  const errors:string[]=[],onError=(e:any)=>errors.push(e.error.message);renderer.backend.device.addEventListener('uncapturederror',onError);
  try {
    for(const [name,pitch]of [['near',-.85],['across',1.35]] as const){
      game.controller.yaw=Math.PI/2;game.controller.pitch=pitch;game.controller.updateRender(0);
      for(const mode of GAUSSIAN_MODES){trial.set(mode);scene.render(false,true);scene.render(false,true);await renderer.backend.device.queue.onSubmittedWorkDone();}
      let reference:Uint8ClampedArray|undefined,fine:Uint8ClampedArray|undefined;const rows:any[]=[],picks:string[]=[];
      const order:GaussianMode[]=['original','fine','coarse','omit','fine','original'];
      for(const [i,mode]of order.entries()){
        trial.set(mode);scene.render(false,true);renderer.info.reset();scene.render(false,true);
        context.drawImage(renderer.domElement,0,0);const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
        if(!pixels.some((v,i)=>i%4!==3&&v>0))throw new Error('Empty Gaussian image.');reference??=pixels;if(i===1)fine=pixels;
        rows.push({mode,restored:i===5,...compare(pixels,reference),...(i===4?{versusRepeat:compare(pixels,fine!)}:{}),
          calls:renderer.info.render.drawCalls,triangles:renderer.info.render.triangles,farCalls:trial.stats.draws,farTriangles:trial.stats.farTriangles,
          splats:trial.stats.visibleSplats,fallback:trial.stats.fallbackSources});
        picks.push(JSON.stringify(game.controller.performAimRaycast()));
        if(i<4)images[`${name}-${mode}`]=canvas.toDataURL('image/png');
      }
      if(rows[5].max!==0||rows[4].versusRepeat.max>1||!picks.every(p=>p===picks[0]))throw new Error('Gaussian restoration, repeatability or picking differs: '+JSON.stringify(rows));
      if(rows.some(r=>r.fallback)||!rows[1].splats||!rows[3].changedOver2)throw new Error('Gaussian candidate is not visibly replacing eligible far terrain.');
      views.push({name,rows,identicalPicking:true});
    }
    await renderer.backend.device.queue.onSubmittedWorkDone();if(errors.length)throw new Error(errors.join('\n'));
    return {width:canvas.width,height:canvas.height,views,images,errors};
  }finally{renderer.backend.device.removeEventListener('uncapturederror',onError);trial.set(saved.mode);game.controller.yaw=saved.yaw;game.controller.pitch=saved.pitch;game.controller.updateRender(0);resume();requestAnimationFrame(game.animate);}
}
