/** Explicit offline software ray experiments. This is a visibility research lab,
 * not a replacement for the game's PBR/MSAA renderer or a game-FPS benchmark. */
import * as THREE from 'three/webgpu';
import { snapshotFar, buildFaceBvh, buildBrickTree, type RayTree } from './SoftwareRayData.ts';
import { computeShader, rasterShader, presentShader } from './SoftwareRayShaders.ts';
import { applyCameraBend, setTorusViewCorrection } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { interceptMethod } from './FrameDiagnostics.ts';
import { summarize } from './MaintenanceBenchmark.ts';

if(import.meta.hot)import.meta.hot.accept();

type Mode='raster'|'bvh'|'brick'|'sdf';
const modes:Mode[]=['raster','bvh','brick','sdf'];
const frame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
function download(name:string,blob:Blob){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}

export async function createSoftwareRayLab(game:any) {
  if(!import.meta.env.DEV||!game.offline)throw new Error('Use the offline development fixture.');
  const scene=game.sceneRenderer,renderer=scene.renderer,device=renderer.backend.device;
  if(!renderer.hasFeature('timestamp-query'))throw new Error('GPU timestamps required.');
  const resource:any[]=[], errors:string[]=[];let suspended=false,closed=false,running=false;
  const resume=interceptMethod(game,'animate',()=>{suspended=true;});
  while(!suspended)await frame();
  await device.queue.onSubmittedWorkDone();
  const onError=(event:any)=>errors.push(event.error.message);device.addEventListener('uncapturederror',onError);
  const root=document.createElement('section');root.id='software-ray-lab';root.style.cssText='position:fixed;inset:0;z-index:10000;background:#101923;color:#e8eef5;padding:16px;overflow:auto;font:13px monospace';
  root.innerHTML='<h2>Software ray visibility lab</h2><p>Actual far terrain snapshot, identical triangles and simple shading, one sample/pixel. No near terrain, PBR, HUD, shadows, post effects or simulation in candidate timings.</p><div id="ray-controls"></div><p id="ray-status">Snapshotting resident geometry…</p><div id="ray-view"></div><pre id="ray-result"></pre>';
  document.body.append(root);
  const status=(s:string)=>{root.querySelector('#ray-status')!.textContent=s;};
  const canvas=document.createElement('canvas');canvas.style.cssText='display:block;width:min(100%,1280px);height:auto';root.querySelector('#ray-view')!.append(canvas);
  const context:any=canvas.getContext('webgpu');const format=navigator.gpu.getPreferredCanvasFormat();context.configure({device,format,alphaMode:'opaque'});
  function buffer(data:ArrayBufferView|number,usage:number,label:string){
    const size=typeof data==='number'?data:Math.max(4,data.byteLength);
    const b=device.createBuffer({size:Math.ceil(size/4)*4,usage,label});resource.push(b);
    if(typeof data!=='number')device.queue.writeBuffer(b,0,data);return b;
  }
  const B=(globalThis as any).GPUBufferUsage,T=(globalThis as any).GPUTextureUsage,M=(globalThis as any).GPUMapMode;
  try {
    await frame();const snapshot=snapshotFar(game);status(`Building SAH BVH for ${snapshot.count.toLocaleString()} far faces…`);await frame();
    const bvh=buildFaceBvh(snapshot);status('Building sparse 64-way hierarchy and nonlinear distance bounds…');await frame();
    const brick=buildBrickTree(snapshot);
    const faces=buffer(snapshot.bent,B.STORAGE|B.COPY_DST,'ray-faces'),params=buffer(176,B.UNIFORM|B.COPY_DST,'ray-params');
    const stats=buffer(32,B.STORAGE|B.COPY_DST|B.COPY_SRC,'ray-counters');
    const trees=new Map<Mode,{tree:RayTree;nodes:any;ids:any;fields:any}>();
    for(const [name,tree] of [['bvh',bvh],['brick',brick]] as const)trees.set(name,{tree,
      nodes:buffer(tree.nodes,B.STORAGE|B.COPY_DST,`${name}-nodes`),ids:buffer(tree.ids,B.STORAGE|B.COPY_DST,`${name}-ids`),
      fields:buffer(tree.fields,B.STORAGE|B.COPY_DST,`${name}-fields`)});
    trees.set('sdf',trees.get('brick')!);
    const rasterIds=buffer(snapshot.count*4,B.STORAGE|B.COPY_DST,'raster-visible-ids');
    trees.set('raster',{...trees.get('bvh')!,ids:rasterIds});
    const layout=device.createBindGroupLayout({entries:[
      {binding:0,visibility:7,buffer:{type:'uniform'}},
      ...[1,2,3,4].map(binding=>({binding,visibility:7,buffer:{type:'read-only-storage'}})),
      {binding:5,visibility:4,storageTexture:{access:'write-only',format:'rgba32float'}},
      {binding:6,visibility:4,buffer:{type:'storage'}},
    ]});
    const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]}),pipelines=new Map<Mode,any>();
    for(const mode of modes){const shader=device.createShaderModule({code:mode==='raster'?rasterShader:computeShader(mode),label:`software-ray-${mode}`});
      const info=await shader.getCompilationInfo();const failed=info.messages.filter((m:any)=>m.type==='error');
      if(failed.length)throw new Error(`${mode}: ${failed.map((m:any)=>`${m.lineNum}:${m.message}`).join('\n')}`);
      pipelines.set(mode,mode==='raster'?await device.createRenderPipelineAsync({layout:pipelineLayout,vertex:{module:shader,entryPoint:'vs'},
        fragment:{module:shader,entryPoint:'fs',targets:[{format:'rgba32float'}]},primitive:{topology:'triangle-list',cullMode:'back'},
        depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less'}}):await device.createComputePipelineAsync({layout:pipelineLayout,compute:{module:shader,entryPoint:'main'}}));
    }
    const ps=device.createShaderModule({code:presentShader});
    const presentLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:2,texture:{sampleType:'unfilterable-float'}}]});
    const present=device.createRenderPipeline({layout:device.createPipelineLayout({bindGroupLayouts:[presentLayout]}),vertex:{module:ps,entryPoint:'vs'},fragment:{module:ps,entryPoint:'fs',targets:[{format}]}});
    const query=device.createQuerySet({type:'timestamp',count:8});resource.push(query);
    const resolve=buffer(64,B.QUERY_RESOLVE|B.COPY_SRC,'ray-timestamp-resolve'),read=buffer(64,B.COPY_DST|B.MAP_READ,'ray-timestamp-read');
    const dummyOutput=device.createTexture({size:[1,1],format:'rgba32float',usage:T.STORAGE_BINDING});resource.push(dummyOutput);
    const camera=new THREE.PerspectiveCamera();let width=640,height=360,output:any,depth:any,binds=new Map<Mode,any>(),presentBind:any,visibleCount=0;
    function resize(w:number,h:number){
      if(output){output.destroy();depth.destroy();}width=w;height=h;canvas.width=w;canvas.height=h;
      output=device.createTexture({size:[w,h],format:'rgba32float',usage:T.STORAGE_BINDING|T.RENDER_ATTACHMENT|T.TEXTURE_BINDING|T.COPY_SRC});
      depth=device.createTexture({size:[w,h],format:'depth32float',usage:T.RENDER_ATTACHMENT});
      for(const mode of modes){const data=trees.get(mode)!;binds.set(mode,device.createBindGroup({layout,entries:[
        {binding:0,resource:{buffer:params}},{binding:1,resource:{buffer:faces}},{binding:2,resource:{buffer:data.nodes}},
        {binding:3,resource:{buffer:data.ids}},{binding:4,resource:{buffer:data.fields}},{binding:5,resource:(mode==='raster'?dummyOutput:output).createView()},{binding:6,resource:{buffer:stats}},
      ]}));}
      presentBind=device.createBindGroup({layout:presentLayout,entries:[{binding:0,resource:output.createView()}]});
    }
    function pose(yaw:number,pitch:number,dx=0,dz=0,countStats=false){
      camera.copy(scene.camera);camera.aspect=width/height;camera.updateProjectionMatrix();
      camera.position.copy(game.playerPhysics.position);camera.position.x+=dx;camera.position.z+=dz;
      camera.rotation.set(pitch,yaw,0,'YXZ');applyCameraBend(camera);
      const vp=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
      const rotation=camera.matrixWorldInverse.clone();rotation.setPosition(0,0,0);
      const relativeVp=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,rotation);
      const values=new Float32Array(44);values.set(relativeVp.elements);values.set(camera.matrixWorld.elements,16);
      values.set([...camera.position.toArray(),1,width,height,16000,0,countStats?1:0,Math.tan(camera.fov*Math.PI/360),camera.aspect,0],32);
      device.queue.writeBuffer(params,0,values);
      const frustum=new THREE.Frustum().setFromProjectionMatrix(vp,THREE.WebGPUCoordinateSystem),box=new THREE.Box3(),visible:number[]=[];
      const u=new Uint32Array(brick.nodes.buffer);
      for(let i=0;i<brick.nodes.length/16;i++){const at=i*16,count=u[at+7];if(!count)continue;
        box.min.fromArray(brick.nodes,at);box.max.fromArray(brick.nodes,at+4);if(!frustum.intersectsBox(box))continue;
        for(let j=0;j<count;j++)visible.push(brick.ids[u[at+11]+j]);}
      visibleCount=visible.length;device.queue.writeBuffer(rasterIds,0,Uint32Array.from(visible));
      return {yaw,pitch,dx,dz,visibleFaces:visibleCount,position:camera.position.toArray()};
    }
    function encode(encoder:any,mode:Mode,slot?:number){
      const timestamps=slot===undefined?{}:{timestampWrites:{querySet:query,beginningOfPassWriteIndex:slot,endOfPassWriteIndex:slot+1}};
      if(mode==='raster'){
        const pass=encoder.beginRenderPass({...timestamps,colorAttachments:[{view:output.createView(),clearValue:{r:.025,g:.04,b:.065,a:1},loadOp:'clear',storeOp:'store'}],
          depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'discard',depthClearValue:1}});
        pass.setPipeline(pipelines.get(mode));pass.setBindGroup(0,binds.get(mode));pass.draw(visibleCount*6);pass.end();
      }else{const pass=encoder.beginComputePass(timestamps);pass.setPipeline(pipelines.get(mode));pass.setBindGroup(0,binds.get(mode));pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(height/8));pass.end();}
    }
    function show(mode:Mode){const e=device.createCommandEncoder();encode(e,mode);const pass=e.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store'}]});
      pass.setPipeline(present);pass.setBindGroup(0,presentBind);pass.draw(3);pass.end();device.queue.submit([e.finish()]);}
    async function pixels(mode:Mode){const stride=Math.ceil(width*16/256)*256,r=buffer(stride*height,B.COPY_DST|B.MAP_READ,'ray-pixel-read');
      const e=device.createCommandEncoder();encode(e,mode);e.copyTextureToBuffer({texture:output},{buffer:r,bytesPerRow:stride},[width,height]);device.queue.submit([e.finish()]);
      await r.mapAsync(M.READ);const padded=new Float32Array(r.getMappedRange()),data=new Float32Array(width*height*4);
      for(let y=0;y<height;y++)data.set(padded.subarray(y*stride/4,y*stride/4+width*4),y*width*4);r.unmap();r.destroy();return data;
    }
    function compare(a:Float32Array,b:Float32Array){let rgb=0,coverage=0,depthErrors=0,maxRgb=0,maxDepth=0,sum=0,lit=0;
      for(let i=0;i<a.length;i+=4){const delta=Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]));
        const dd=Math.abs(a[i+3]-b[i+3]);if(delta>1e-4)rgb++;if((a[i+3]<1)!==(b[i+3]<1))coverage++;
        if(a[i+3]<1&&b[i+3]<1){lit++;maxDepth=Math.max(maxDepth,dd);if(dd>2e-5)depthErrors++;}
        maxRgb=Math.max(maxRgb,delta);sum+=delta;}
      return {pixels:width*height,changedRgb:rgb,coverageMismatch:coverage,depthErrors,maxRgb,maxDepth,meanRgb:sum/(width*height),hitPixels:lit};
    }
    async function measure(candidate:Mode,batches=16){const samples:any[]=[];
      for(let batch=-4;batch<batches;batch++){
        if(document.hidden||closed)throw new Error('Lab is hidden or closed.');
        const order:Mode[]=batch%2===0?['raster',candidate,candidate,'raster']:[candidate,'raster','raster',candidate];
        const gpu:number[]=[],completed:number[]=[],raw:string[][]=[];
        // Drain between treatments. Mixed compute/render pass timestamps can
        // include dependencies on the prior treatment on this tile GPU.
        for(const mode of order){
          const encoder=device.createCommandEncoder();for(let i=0;i<4;i++)encode(encoder,mode,i*2);
          encoder.resolveQuerySet(query,0,8,resolve,0);encoder.copyBufferToBuffer(resolve,0,read,0,64);
          const started=performance.now();device.queue.submit([encoder.finish()]);await read.mapAsync(M.READ);
          const times=new BigUint64Array(read.getMappedRange()).slice();read.unmap();
          if(times[7]<=times[0])throw new Error('Invalid GPU timestamp.');
          gpu.push(Number(times[7]-times[0])/4e6);completed.push((performance.now()-started)/4);raw.push([...times].map(String));
        }
        if(batch>=0)samples.push({order,gpu,completedPerFrame:completed,rawNanoseconds:raw});
      }
      // Preserve role positions even for identical-code raster A/A controls.
      const a:number[]=[],b:number[]=[];
      samples.forEach((s,i)=>s.gpu.forEach((ms:number,j:number)=>{const reference=i%2===0?(j===0||j===3):(j===1||j===2);(reference?a:b).push(ms);}));
      return {candidate,reference:summarize(a),candidateMs:summarize(b),samples};
    }
    const results:any={date:new Date().toISOString(),revision:'cubic-field-camera-relative-drained-treatment-batches',timing:'ABBA/BAAB; four identical passes per treatment; await readback between treatments; first-start to last-end / 4. Pixel readback is outside timings.',scope:'Frozen actual distant faces outside camera correction. Visibility + matched simple shading only; not gameplay FPS or production PBR/MSAA equivalence.',
      userAgent:navigator.userAgent,adapter:Object.fromEntries(['vendor','architecture','device','description'].map(k=>[k,device.adapterInfo?.[k]])),fullSceneBaseline:(window as any).rtBaseline??[],snapshot:{faces:snapshot.count,omittedNear:snapshot.omittedNear,snapshotMs:snapshot.snapshotMs},
      structures:{bvh:{buildMs:bvh.buildMs,nodes:bvh.nodes.length/16,leaves:bvh.leaves,maxDepth:bvh.maxDepth,bytes:bvh.nodes.byteLength+bvh.ids.byteLength},
        brick:{buildMs:brick.buildMs,nodes:brick.nodes.length/16,leaves:brick.leaves,maxDepth:brick.maxDepth,bytes:brick.nodes.byteLength+brick.ids.byteLength,fieldBytes:brick.fields.byteLength},
        sharedBentFaceBytes:snapshot.bent.byteLength},rows:[],errors};
    const views=[{name:'near-facing',yaw:Math.PI/2,pitch:-.85},{name:'across-ring',yaw:Math.PI/2,pitch:1.35},
      {name:'reverse',yaw:Math.PI*1.5,pitch:-.25},{name:'moved',yaw:Math.PI/2+.6,pitch:-.35,dx:64,dz:32}];
    async function run(options:{sizes?:number[][];viewNames?:string[];batches?:number;candidates?:Mode[]}={}){
      if(running||closed)throw new Error('Lab is already running or closed.');
      running=true;
      try {
      for(const [w,h]of options.sizes??[[640,360],[1280,720],[2560,1440]]){
        resize(w,h);
        for(const view of views.filter(v=>!options.viewNames||options.viewNames.includes(v.name))){
          status(`${w}×${h} ${view.name}: checking pixels…`);await frame();const cameraState=pose(view.yaw,view.pitch,view.dx,view.dz);
          const reference=await pixels('raster'), exact=await pixels('bvh');
          const checks:any={bvh:compare(reference,exact)};
          for(const mode of ['brick','sdf'] as const){const value=await pixels(mode);checks[mode]={raster:compare(reference,value),bvh:compare(exact,value)};}
          const rows=[];for(const mode of options.candidates??modes){status(`${w}×${h} ${view.name}: timing ${mode}…`);await frame();rows.push(await measure(mode,options.batches??16));}
          results.rows.push({width:w,height:h,view:view.name,camera:cameraState,checks,timings:rows});
          try{sessionStorage.setItem('space-software-ray-results',JSON.stringify(results));}catch{/* Results remain available in the lab if storage is full. */}
          root.querySelector('#ray-result')!.textContent=JSON.stringify({structures:results.structures,rows:results.rows.map((r:any)=>({size:[r.width,r.height],view:r.view,checks:r.checks,
            gpuMs:r.timings.map((t:any)=>({mode:t.candidate,raster:t.reference.p50,candidate:t.candidateMs.p50}))})),errors},null,2);
          show('bvh');
        }
      }
      await device.queue.onSubmittedWorkDone();status(`Complete: ${results.rows.length} view/resolution cases; GPU errors: ${errors.length}`);return results;
      }finally{running=false;}
    }
    async function diagnostics(mode:Mode){device.queue.writeBuffer(stats,0,new Uint32Array(8));pose(Math.PI/2,1.35,0,0,true);const e=device.createCommandEncoder();encode(e,mode);
      const r=buffer(32,B.COPY_DST|B.MAP_READ,'ray-stat-read');e.copyBufferToBuffer(stats,0,r,0,32);device.queue.submit([e.finish()]);await r.mapAsync(M.READ);
      const v=[...new Uint32Array(r.getMappedRange())];r.unmap();r.destroy();pose(Math.PI/2,1.35);return {mode,pixels:width*height,nodeVisits:v[0],faceTests:v[1],fieldSteps:v[2],fieldFallbacks:v[3],fieldSkips:v[4],hits:v[5]};}
    async function dispose(){if(closed)return;closed=true;await device.queue.onSubmittedWorkDone();output?.destroy();depth?.destroy();resource.reverse().forEach(r=>r.destroy());
      device.removeEventListener('uncapturederror',onError);root.remove();setTorusViewCorrection(game.playerPhysics.position);resume();requestAnimationFrame(game.animate);}
    const controls=root.querySelector('#ray-controls')!;
    function button(label:string,fn:()=>unknown){const b=document.createElement('button');b.textContent=label;b.style.cssText='margin:4px;padding:7px';b.onclick=()=>{if(!running&&!closed)void fn();};controls.append(b);}
    button('Run comparisons',()=>run().catch(e=>{errors.push(String(e));status(String(e));}));
    for(const mode of modes)button(`Show ${mode}`,()=>show(mode));
    button('Download JSON',()=>download('software-ray-results.json',new Blob([JSON.stringify(results,null,2)],{type:'application/json'})));
    button('Download image',()=>{show('bvh');canvas.toBlob(blob=>{if(blob)download('software-ray-preview.png',blob);});});button('Close lab',dispose);
    resize(640,360);pose(Math.PI/2,1.35);show('bvh');status('Ready. All three software pipelines compiled.');
    return {run,results,diagnostics,dispose,show,resize,pose};
  }catch(error){await device.queue.onSubmittedWorkDone();resource.reverse().forEach(r=>r.destroy());root.remove();device.removeEventListener('uncapturederror',onError);resume();requestAnimationFrame(game.animate);throw error;}
}
