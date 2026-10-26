import { interceptMethod } from './FrameDiagnostics.ts';
import { POINT_MODES,type PointMode,type PointCloudTrial } from './PointCloudTrial.ts';
if(import.meta.hot)import.meta.hot.accept();
export async function capturePointCloudPixels(game:any,trial:PointCloudTrial){
  const scene=game.sceneRenderer,renderer=scene.renderer,saved={yaw:game.controller.yaw,pitch:game.controller.pitch,mode:trial.mode,autoReset:renderer.info.autoReset};
  let stopped=false;const resume=interceptMethod(game,'animate',()=>{stopped=true;});while(!stopped)await new Promise<void>(r=>requestAnimationFrame(()=>r()));
  const canvas=document.createElement('canvas');canvas.width=renderer.domElement.width;canvas.height=renderer.domElement.height;
  renderer.info.autoReset=false;
  const context=canvas.getContext('2d',{willReadFrequently:true})!,images:Record<string,string>={},views:any[]=[],temporal:any[]=[];
  const errors:string[]=[],onError=(e:any)=>errors.push(e.error.message);renderer.backend.device.addEventListener('uncapturederror',onError);
  const delta=(a:Uint8ClampedArray,b:Uint8ClampedArray,i:number)=>Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]));
  function compare(a:Uint8ClampedArray,b:Uint8ClampedArray){let changed=0,sum=0,max=0;for(let i=0;i<a.length;i+=4){const d=delta(a,b,i);changed+=Number(d>2);sum+=d;max=Math.max(max,d);}return{changedOver2:changed,meanMaxRgb:sum/(a.length/4),max};}
  function holes(a:Uint8ClampedArray,rect:Uint8ClampedArray,omit:Uint8ClampedArray){let referencePixels=0,missing=0,spill=0;const mask=new Uint8Array(a.length/4);
    for(let i=0;i<a.length;i+=4){const ref=delta(rect,omit,i)>6,hit=delta(a,omit,i)>2;referencePixels+=Number(ref);missing+=Number(ref&&!hit);spill+=Number(!ref&&hit);mask[i/4]=Number(ref&&!hit);}return{referencePixels,missing,spill,mask};}
  function render(mode:PointMode){trial.set(mode);scene.render(false,true);renderer.info.reset();scene.render(false,true);context.drawImage(renderer.domElement,0,0);return context.getImageData(0,0,canvas.width,canvas.height).data;}
  try{
    for(const [name,pitch]of [['near',-.85],['across',1.35]] as const){
      game.controller.yaw=Math.PI/2;game.controller.pitch=pitch;game.controller.updateRender(0);
      for(const mode of POINT_MODES){render(mode);await renderer.backend.device.queue.onSubmittedWorkDone();}
      const held=new Map<PointMode,Uint8ClampedArray>(),rows:any[]=[],picks:string[]=[];
      const order:PointMode[]=['original','rect','points','surfel','compute','omit','points','surfel','compute','rect','original'];
      for(const [i,mode]of order.entries()){
        const pixels=render(mode);if(!pixels.some((v,i)=>i%4!==3&&v))throw new Error('Empty point image.');
        const repeat=held.get(mode);if(!repeat)held.set(mode,pixels);
        rows.push({mode,...compare(pixels,held.get('original')!),...(repeat?{repeat:compare(pixels,repeat)}:{}),calls:renderer.info.render.drawCalls,
          triangles:renderer.info.render.triangles,points:renderer.info.render.points,...trial.stats});
        if(i<5)images[`${name}-${mode}`]=canvas.toDataURL('image/png');picks.push(JSON.stringify(game.controller.performAimRaycast()));
      }
      if(rows.at(-1).max!==0||rows.filter(r=>r.repeat).some(r=>r.repeat.max>1)||!picks.every(p=>p===picks[0]))throw new Error('Point repeat/restoration/picking control failed: '+JSON.stringify(rows));
      if(rows.some(r=>r.fallbackSources)||!rows[2].submittedPoints||!rows[5].changedOver2)throw new Error('Point replacement is invalid or not visible.');
      const coverage=Object.fromEntries(['points','surfel','compute'].map(mode=>{const {mask,...metrics}=holes(held.get(mode as PointMode)!,held.get('rect')!,held.get('omit')!);return[mode,metrics];}));
      views.push({name,rows,coverage,identicalPicking:true});
    }
    const previous=new Map<PointMode,Uint8Array>();
    for(let pose=0;pose<4;pose++){
      game.controller.yaw=Math.PI/2+pose*.0007;game.controller.pitch=1.35;game.controller.updateRender(0);
      const rect=render('rect'),omit=render('omit');
      for(const mode of ['points','surfel','compute'] as const){const pixels=render(mode),{mask,...metrics}=holes(pixels,rect,omit),old=previous.get(mode);
        let changed=0;if(old)for(let i=0;i<mask.length;i++)changed+=Number(mask[i]!==old[i]);previous.set(mode,mask);temporal.push({pose,yaw:game.controller.yaw,mode,...metrics,changedHoleMaskPixels:old?changed:null});}
    }
    await renderer.backend.device.queue.onSubmittedWorkDone();if(errors.length)throw new Error(errors.join('\n'));
    return{width:canvas.width,height:canvas.height,views,temporal,images,errors};
  }finally{renderer.backend.device.removeEventListener('uncapturederror',onError);renderer.info.autoReset=saved.autoReset;trial.set(saved.mode);game.controller.yaw=saved.yaw;game.controller.pitch=saved.pitch;game.controller.updateRender(0);resume();requestAnimationFrame(game.animate);}
}
