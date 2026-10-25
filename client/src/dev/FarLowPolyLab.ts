/** Frozen far-only raster experiment. Explicit import from an offline DEV game. */
import * as THREE from 'three/webgpu';
import { captureFarBricks, meshBrick, simplifyMesh, compact, MeshoptSimplifier, distanceToBounds, include, type MeshPart } from './FarLowPolyData.ts';
import { applyCameraBend, setTorusViewCorrection } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { interceptMethod } from './FrameDiagnostics.ts';
import { summarize } from './MaintenanceBenchmark.ts';
import { presentShader } from './SoftwareRayShaders.ts';

if(import.meta.hot)import.meta.hot.accept();
const nextFrame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
const modes=['packed','mesh','prepared','0.5px','1px','2px'] as const;
type Mode=typeof modes[number];
const vertexCommon=/* wgsl */`
struct Params { vp:mat4x4<f32>, camera:vec4<f32>, control:vec4<u32> }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> faces:array<vec4<u32>>;
@group(0) @binding(2) var<storage,read> visible:array<u32>;
@group(0) @binding(3) var<storage,read> angles:array<vec4<f32>>;
struct Vertex { @builtin(position) position:vec4<f32>, @location(0) point:vec3<f32>, @location(1) color:vec3<f32> }
fn outputVertex(point:vec3<f32>,color:vec3<f32>)->Vertex {
  var out:Vertex;out.point=point-p.camera.xyz;out.position=p.vp*vec4<f32>(out.point,1.);out.color=color;return out;
}
struct Fragment { @location(0) color:vec4<f32>, @location(1) depth:f32 }
@fragment fn fs(in:Vertex)->Fragment {
  let n=normalize(cross(dpdx(in.point),dpdy(in.point)));
  let light=.45+.55*abs(dot(n,normalize(vec3<f32>(.4,.8,.3))));
  var out:Fragment;out.color=vec4<f32>(in.color*light,1.);out.depth=length(in.point);return out;
}
`;
const packedShader=vertexCommon+/* wgsl */`
@vertex fn vs(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Vertex {
  let offset=instance*32u+vertex/4u;
  if(offset>=p.control.x){var out:Vertex;out.position=vec4<f32>(2.,2.,2.,1.);out.point=vec3<f32>(0.);out.color=vec3<f32>(0.);return out;}
  let f=faces[visible[offset]];let dir=(f.z>>16u)&255u;let j=vertex%4u;
  var u=select(0.,1.,j==1u||j==2u);let v=select(0.,1.,j>=2u);if((dir&1u)==0u){u=1.-u;}
  let su=f32(f.y>>15u)*.125;let sv=f32(f.z&65535u)*.125;
  var point=vec3<f32>(f32(f.x&262143u),f32(f.x>>18u),f32(f.y&32767u))*.125;
  if(dir<2u){point+=vec3<f32>(0.,u*su,v*sv);}else if(dir<4u){point+=vec3<f32>(v*sv,0.,u*su);}else{point+=vec3<f32>(u*su,v*sv,0.);}
  let ring=angles[u32(point.x)&16383u];let tube=angles[16384u+(u32(point.z)&2047u)];
  let rho=min(325.9493234522+(point.y-16.)*(2607.5945876176+tube.x*325.9493234522)/2607.5945876176,2606.5945876176);
  let radius=2607.5945876176+rho*tube.x;
  return outputVertex(vec3<f32>(radius*ring.x,rho*tube.y,radius*ring.y),unpack4x8unorm(f.w).xyz);
}
`;
const meshShader=vertexCommon+/* wgsl */`
@vertex fn vs(@location(0) position:vec3<f32>,@location(1) color:vec4<f32>)->Vertex {return outputVertex(position,color.xyz);}
`;

export async function createFarLowPolyLab(game:any) {
  if(!import.meta.env.DEV||!game.offline)throw new Error('Offline development fixture required.');
  if(document.getElementById('far-lowpoly-lab'))throw new Error('Close the existing lab first.');
  const renderer=game.sceneRenderer.renderer,device=renderer.backend.device;
  if(!renderer.hasFeature('timestamp-query'))throw new Error('GPU timestamp support required.');
  let stopped=false,closed=false,running=false;
  const resume=interceptMethod(game,'animate',()=>{stopped=true;});
  while(!stopped)await nextFrame();await device.queue.onSubmittedWorkDone();
  const resources:any[]=[],errors:string[]=[];
  const onError=(event:any)=>errors.push(event.error.message);device.addEventListener('uncapturederror',onError);
  const root=document.createElement('section');root.id='far-lowpoly-lab';
  root.style.cssText='position:fixed;inset:0;z-index:12000;background:#101923;color:#e8eef5;padding:16px;overflow:auto;font:14px system-ui';
  root.innerHTML='<h2>Far terrain low-poly experiment</h2><p>Frozen far bricks; matched raster shading. Packed quads → indexed mesh → repaired T-junctions → reduced meshes. Not full-game FPS.</p><div id="lp-controls"></div><p id="lp-status">Preparing…</p><div id="lp-view"></div><table id="lp-table" style="border-spacing:12px 4px"></table><details><summary>Measurement details</summary><pre id="lp-result"></pre></details>';
  document.body.append(root);
  const status=(s:string)=>{root.querySelector('#lp-status')!.textContent=s;};
  const canvas=document.createElement('canvas');canvas.style.cssText='display:block;width:min(100%,1280px);height:auto';root.querySelector('#lp-view')!.append(canvas);
  const context:any=canvas.getContext('webgpu'),format=navigator.gpu.getPreferredCanvasFormat();context.configure({device,format,alphaMode:'opaque'});
  const B=(globalThis as any).GPUBufferUsage,T=(globalThis as any).GPUTextureUsage,M=(globalThis as any).GPUMapMode;
  const buffer=(data:ArrayBufferView|number,usage:number,label:string)=>{
    const b=device.createBuffer({size:Math.max(4,typeof data==='number'?data:data.byteLength),usage,label});resources.push(b);
    if(typeof data!=='number')device.queue.writeBuffer(b,0,data);return b;
  };
  let output:any,depthOutput:any,depth:any;
  const dispose=async()=>{if(closed)return;closed=true;await device.queue.onSubmittedWorkDone();
    output?.destroy();depthOutput?.destroy();depth?.destroy();resources.reverse().forEach(r=>r.destroy());context.unconfigure();
    root.remove();device.removeEventListener('uncapturederror',onError);setTorusViewCorrection(game.playerPhysics.position);resume();requestAnimationFrame(game.animate);};
  try {
    await MeshoptSimplifier.ready;await nextFrame();
    const snapshot=captureFarBricks(game),world=new URL(location.href).searchParams.get('world')??'unknown';
    const focal=1440/(2*Math.tan(game.sceneRenderer.camera.fov*Math.PI/360));
    const levels=[.5,1,2],parts=new Map<Mode,MeshPart[]>(),building:number[]=[],perBrick:any[]=[];
    for(const mode of modes)parts.set(mode,[]);
    const packed=new Uint32Array(snapshot.faces*4),brickRanges:{faceStart:number;faceCount:number;bounds:number[]}[]=[];
    let faceOffset=0,prepareMs=0,simplifyMs=0;
    const buildStarted=performance.now();
    for(let bi=0;bi<snapshot.bricks.length;bi++){
      const brick=snapshot.bricks[bi],start=performance.now();
      for(const q of brick.quads){const [x,y,z,su,sv,dir,color]=q;
        if([x,y,z,su,sv].some(v=>v!==Math.floor(v))||x<0||x>16384||z<0||z>2048||y<0||y>=2048)throw new Error('Packed control requires the integer natural-terrain fixture.');
        packed.set([((x*8)|((y*8)<<18))>>>0,((z*8)|((su*8)<<15))>>>0,((sv*8)|(dir<<16))>>>0,color],faceOffset*4);faceOffset++;
      }
      const original=meshBrick(brick,false),prepared=meshBrick(brick,true);
      const originalPart=compact(original),preparedPart=compact(prepared);parts.get('mesh')!.push(originalPart);parts.get('prepared')!.push(preparedPart);
      for(let i=0;i<prepared.positions.length;i+=3)include(brick.bounds,prepared.positions.subarray(i,i+3));
      brickRanges.push({faceStart:faceOffset-brick.quads.length,faceCount:brick.quads.length,bounds:brick.bounds});
      const beforeSimplify=performance.now();prepareMs+=beforeSimplify-start;
      // Reserve movement margin for the displaced validation camera. This is
      // a nominal QEM error target, not a certified screen-space error bound.
      const distance=Math.max(1,distanceToBounds(snapshot.camera,brick.bounds)-80);
      const reduced=levels.map(px=>simplifyMesh(prepared,px*distance/focal));
      reduced.forEach((part,i)=>parts.get(`${levels[i]}px` as Mode)!.push(part));
      const elapsed=performance.now()-beforeSimplify;simplifyMs+=elapsed;building.push(performance.now()-start);
      perBrick.push({key:brick.key,faces:brick.quads.length,preparedTriangles:prepared.indices.length/3,buildMs:performance.now()-start,
        levels:reduced.map((part,i)=>({px:levels[i],targetMeters:levels[i]*distance/focal,error:part.error,triangles:part.indices.length/3,seamFallback:part.seamFallback}))});
      if(bi%32===0){status(`${world}: building ${bi+1}/${snapshot.bricks.length} bricks…`);await nextFrame();}
    }
    const structures:any={captureMs:snapshot.captureMs,prepareMs,simplifyMs,buildWallMs:performance.now()-buildStarted,perBrickBuild:summarize(building),modes:{}};
    type GpuMesh={vertex:any;index:any;indices:Uint32Array;ranges:{start:number;count:number}[];visibleCount:number};
    const meshes=new Map<Mode,GpuMesh>();
    for(const mode of modes.filter(m=>m!=='packed')){
      const list=parts.get(mode)!,vbytes=list.reduce((n,p)=>n+p.vertices.byteLength,0),icount=list.reduce((n,p)=>n+p.indices.length,0);
      const vertices=new Uint8Array(vbytes),indices=new Uint32Array(icount),ranges:{start:number;count:number}[]=[];
      let vo=0,io=0;for(const part of list){vertices.set(part.vertices,vo);for(let i=0;i<part.indices.length;i++)indices[io+i]=part.indices[i]+vo/16;
        ranges.push({start:io,count:part.indices.length});vo+=part.vertices.byteLength;io+=part.indices.length;}
      meshes.set(mode,{vertex:buffer(vertices,B.VERTEX|B.COPY_DST,`${mode}-vertices`),index:buffer(icount*4,B.INDEX|B.COPY_DST,`${mode}-indices`),indices,ranges,visibleCount:0});
      structures.modes[mode]={vertices:vbytes/16,triangles:icount/3,bytes:vbytes+icount*4,seamFallbacks:list.filter(p=>p.seamFallback).length};
      parts.set(mode,[]);
    }
    structures.modes.packed={faces:snapshot.faces,triangles:snapshot.faces*2,bytes:packed.byteLength+snapshot.faces*4};
    const params=buffer(96,B.UNIFORM|B.COPY_DST,'lowpoly-params'),faces=buffer(packed,B.STORAGE|B.COPY_DST,'packed-control');
    const visible=buffer(snapshot.faces*4,B.STORAGE|B.COPY_DST,'packed-visible');
    const angleData=new Float32Array((16384+2048)*4);
    for(let x=0;x<16384;x++){angleData[x*4]=Math.cos(x*Math.PI*2/16384);angleData[x*4+1]=Math.sin(x*Math.PI*2/16384);}
    for(let z=0;z<2048;z++){const phi=2*Math.atan2(Math.sqrt(9/7)*Math.sin(z*Math.PI/2048),Math.cos(z*Math.PI/2048));angleData[(16384+z)*4]=Math.cos(phi);angleData[(16384+z)*4+1]=Math.sin(phi);}
    const angles=buffer(angleData,B.STORAGE|B.COPY_DST,'torus-angles');
    const quadIndices=Uint16Array.from({length:192},(_,i)=>Math.floor(i/6)*4+[0,1,2,0,2,3][i%6]);
    const quadIndex=buffer(quadIndices,B.INDEX|B.COPY_DST,'quad-indices');
    const layout=device.createBindGroupLayout({entries:[{binding:0,visibility:1,buffer:{type:'uniform'}},...[1,2,3].map(binding=>({binding,visibility:1,buffer:{type:'read-only-storage'}}))]});
    const bind=device.createBindGroup({layout,entries:[params,faces,visible,angles].map((b,binding)=>({binding,resource:{buffer:b}}))});
    const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]}),pipelines:any={};
    for(const kind of ['packed','mesh']){
      const module=device.createShaderModule({code:kind==='packed'?packedShader:meshShader});const info=await module.getCompilationInfo();
      if(info.messages.some((m:any)=>m.type==='error'))throw new Error(info.messages.map((m:any)=>m.message).join('\n'));
      pipelines[kind]=await device.createRenderPipelineAsync({layout:pipelineLayout,vertex:{module,entryPoint:'vs',buffers:kind==='packed'?[]:[{arrayStride:16,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'unorm8x4'}]}]},
        fragment:{module,entryPoint:'fs',targets:[{format:'rgba8unorm'},{format:'r32float'}]},primitive:{topology:'triangle-list',cullMode:'back'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less'}});
    }
    const presentModule=device.createShaderModule({code:presentShader}),presentLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:2,texture:{sampleType:'unfilterable-float'}}]});
    const present=device.createRenderPipeline({layout:device.createPipelineLayout({bindGroupLayouts:[presentLayout]}),vertex:{module:presentModule,entryPoint:'vs'},fragment:{module:presentModule,entryPoint:'fs',targets:[{format}]}});
    const query=device.createQuerySet({type:'timestamp',count:8});resources.push(query);
    const resolved=buffer(64,B.QUERY_RESOLVE|B.COPY_SRC,'lp-resolve'),read=buffer(64,B.MAP_READ|B.COPY_DST,'lp-read');
    const camera=new THREE.PerspectiveCamera();let width=1280,height=720,presentBind:any,visibleFaces=0;
    function resize(w:number,h:number){output?.destroy();depthOutput?.destroy();depth?.destroy();width=w;height=h;canvas.width=w;canvas.height=h;
      output=device.createTexture({size:[w,h],format:'rgba8unorm',usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING|T.COPY_SRC});
      depthOutput=device.createTexture({size:[w,h],format:'r32float',usage:T.RENDER_ATTACHMENT|T.COPY_SRC});depth=device.createTexture({size:[w,h],format:'depth32float',usage:T.RENDER_ATTACHMENT});
      presentBind=device.createBindGroup({layout:presentLayout,entries:[{binding:0,resource:output.createView()}]});}
    const views=[{name:'near-facing',yaw:Math.PI/2,pitch:-.85},{name:'across-ring',yaw:Math.PI/2,pitch:1.35},{name:'reverse',yaw:Math.PI*1.5,pitch:-.25},{name:'moved',yaw:Math.PI/2+.6,pitch:-.35,dx:64,dz:32}];
    function pose(view:typeof views[number]){
      camera.copy(game.sceneRenderer.camera);camera.aspect=width/height;camera.updateProjectionMatrix();camera.position.copy(game.playerPhysics.position);
      camera.position.x+=view.dx??0;camera.position.z+=view.dz??0;camera.rotation.set(view.pitch,view.yaw,0,'YXZ');applyCameraBend(camera);
      const vp=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse),rotation=camera.matrixWorldInverse.clone().setPosition(0,0,0);
      const relative=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,rotation),frustum=new THREE.Frustum().setFromProjectionMatrix(vp,THREE.WebGPUCoordinateSystem),box=new THREE.Box3();
      const ids:number[]=[],selected:number[]=[];
      brickRanges.forEach((b,i)=>{box.min.fromArray(b.bounds);box.max.fromArray(b.bounds,3);if(frustum.intersectsBox(box)){selected.push(i);for(let j=0;j<b.faceCount;j++)ids.push(b.faceStart+j);}});
      visibleFaces=ids.length;device.queue.writeBuffer(visible,0,Uint32Array.from(ids));
      for(const mesh of meshes.values()){
        const count=selected.reduce((n,i)=>n+mesh.ranges[i].count,0),indices=new Uint32Array(count);let at=0;
        for(const i of selected){const r=mesh.ranges[i];indices.set(mesh.indices.subarray(r.start,r.start+r.count),at);at+=r.count;}
        device.queue.writeBuffer(mesh.index,0,indices);mesh.visibleCount=count;
      }
      const uniform=new Float32Array(24);uniform.set(relative.elements);uniform.set([...camera.position.toArray(),1],16);new Uint32Array(uniform.buffer)[20]=visibleFaces;device.queue.writeBuffer(params,0,uniform);
      return {view:view.name,visibleBricks:selected.length,visibleFaces,triangles:Object.fromEntries([...meshes].map(([m,v])=>[m,v.visibleCount/3])),position:camera.position.toArray()};
    }
    function encode(e:any,mode:Mode,slot?:number){
      const pass=e.beginRenderPass({...(slot===undefined?{}:{timestampWrites:{querySet:query,beginningOfPassWriteIndex:slot,endOfPassWriteIndex:slot+1}}),
        colorAttachments:[{view:output.createView(),clearValue:{r:.025,g:.04,b:.065,a:1},loadOp:'clear',storeOp:'store'},{view:depthOutput.createView(),clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}],
        depthStencilAttachment:{view:depth.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'discard'}});
      pass.setBindGroup(0,bind);pass.setPipeline(pipelines[mode==='packed'?'packed':'mesh']);
      if(mode==='packed'){pass.setIndexBuffer(quadIndex,'uint16');pass.drawIndexed(192,Math.ceil(visibleFaces/32));}
      else {const mesh=meshes.get(mode)!;pass.setVertexBuffer(0,mesh.vertex);pass.setIndexBuffer(mesh.index,'uint32');pass.drawIndexed(mesh.visibleCount);}
      pass.end();
    }
    function show(mode:Mode){const e=device.createCommandEncoder();encode(e,mode);const pass=e.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store'}]});
      pass.setPipeline(present);pass.setBindGroup(0,presentBind);pass.draw(3);pass.end();device.queue.submit([e.finish()]);status(`Showing ${mode} at ${width}×${height}`);}
    async function pixels(mode:Mode){const stride=Math.ceil(width*4/256)*256,size=stride*height,r=device.createBuffer({size:size*2,usage:B.COPY_DST|B.MAP_READ});
      const e=device.createCommandEncoder();encode(e,mode);e.copyTextureToBuffer({texture:output},{buffer:r,bytesPerRow:stride},[width,height]);
      e.copyTextureToBuffer({texture:depthOutput},{buffer:r,offset:size,bytesPerRow:stride},[width,height]);device.queue.submit([e.finish()]);await r.mapAsync(M.READ);
      const mapped=new Uint8Array(r.getMappedRange()),color=new Uint8Array(width*height*4),dist=new Float32Array(width*height);
      for(let y=0;y<height;y++){color.set(mapped.subarray(y*stride,y*stride+width*4),y*width*4);dist.set(new Float32Array(mapped.buffer,size+y*stride,width),y*width);}
      r.unmap();r.destroy();return {color,dist};
    }
    function compare(a:Awaited<ReturnType<typeof pixels>>,b:Awaited<ReturnType<typeof pixels>>){
      let coverage=0,rgb=0,sum=0,depthSum=0,depthMax=0,both=0,beyond2=0,beyond4=0;
      for(let i=0;i<a.dist.length;i++){
        const ah=a.dist[i]>0,bh=b.dist[i]>0,delta=Math.max(...[0,1,2].map(c=>Math.abs(a.color[i*4+c]-b.color[i*4+c])));if(delta>2)rgb++;sum+=delta;
        if(ah&&bh){const d=Math.abs(a.dist[i]-b.dist[i]);depthSum+=d;depthMax=Math.max(depthMax,d);both++;}
        if(ah!==bh){coverage++;const other=ah?b.dist:a.dist,x=i%width,y=Math.floor(i/width);let nearest=99;
          for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const xx=x+dx,yy=y+dy;if(xx>=0&&xx<width&&yy>=0&&yy<height&&other[xx+yy*width]>0)nearest=Math.min(nearest,Math.max(Math.abs(dx),Math.abs(dy)));}
          if(nearest>2)beyond2++;if(nearest>4)beyond4++;
        }
      }
      return {pixels:a.dist.length,coverageMismatch:coverage,coverageBeyond2px:beyond2,coverageBeyond4px:beyond4,changedRgbOver2:rgb,meanMaxRgb:sum/a.dist.length,meanDepthMeters:depthSum/Math.max(1,both),maxDepthMeters:depthMax};
    }
    async function measure(reference:Mode,candidate:Mode,batches:number){const samples:any[]=[];
      for(let batch=-4;batch<batches;batch++){
        if(document.hidden||closed)throw new Error('Lab hidden or closed.');
        const order=batch%2===0?[reference,candidate,candidate,reference]:[candidate,reference,reference,candidate],gpu:number[]=[],raw:string[][]=[];
        for(const mode of order){const e=device.createCommandEncoder();for(let i=0;i<4;i++)encode(e,mode,i*2);e.resolveQuerySet(query,0,8,resolved,0);e.copyBufferToBuffer(resolved,0,read,0,64);device.queue.submit([e.finish()]);
          await read.mapAsync(M.READ);const times=new BigUint64Array(read.getMappedRange()).slice();read.unmap();if(times[7]<=times[0])throw new Error('Invalid GPU timestamps.');gpu.push(Number(times[7]-times[0])/4e6);raw.push([...times].map(String));}
        if(batch>=0)samples.push({order,gpu,raw});
      }
      const a:number[]=[],b:number[]=[];samples.forEach((s,i)=>s.gpu.forEach((ms:number,j:number)=>{const isA=i%2===0?(j===0||j===3):(j===1||j===2);(isA?a:b).push(ms);}));
      return {reference,candidate,referenceMs:summarize(a),candidateMs:summarize(b),samples};
    }
    const results:any={date:new Date().toISOString(),world,revision:'far-lowpoly-v1',scope:'Frozen far-only simple flat shading, 1x sampling, two output attachments; not production PBR or gameplay FPS.',
      simplifier:'meshoptimizer 1.0.1; LockBorder, Permissive, ErrorAbsolute; RGB weights 0.25; target 8% indices; no component pruning',
      nominalPixelTargets:levels,targetHeight:1440,minimumDistance:snapshot.minimumDistance,cameraMovementMargin:80,
      adapter:Object.fromEntries(['vendor','architecture','device','description'].map(k=>[k,device.adapterInfo?.[k]])),residentFaces:snapshot.residentFaces,
      selectedFaces:snapshot.faces,bricks:snapshot.bricks.length,structures,perBrick,rows:[],errors};
    async function save(){
      root.querySelector('#lp-result')!.textContent=JSON.stringify({structures,rows:results.rows.map((r:any)=>({...r,timings:r.timings.map(({samples,...t}:any)=>t)})),errors},null,2);
      root.querySelector('#lp-table')!.innerHTML='<tr><th>View</th><th>Size</th><th>Candidate</th><th>Reference ms</th><th>Candidate ms</th></tr>'+results.rows.flatMap((r:any)=>r.timings.map((t:any)=>`<tr><td>${r.view}</td><td>${r.width}×${r.height}</td><td>${t.candidate} vs ${t.reference}</td><td>${t.referenceMs.p50.toFixed(3)}</td><td>${t.candidateMs.p50.toFixed(3)}</td></tr>`)).join('');
      try{
        const bytes=new Uint8Array(await new Response(new Blob([JSON.stringify(results)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
        let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
        sessionStorage.setItem(`far-lowpoly-${world}-gzip`,btoa(binary));
      }catch(error){results.retentionError=String(error);}
    }
    async function run(options:{sizes?:number[][];viewNames?:string[];batches?:number}={}){
      if(running||closed)throw new Error('Lab running or closed.');running=true;
      try{for(const [w,h]of options.sizes??[[1280,720],[2560,1440]]){resize(w,h);for(const view of views.filter(v=>!options.viewNames||options.viewNames.includes(v.name))){
        const cameraState=pose(view);status(`${world} ${w}×${h} ${view.name}: pixel checks`);await nextFrame();
        const reference=await pixels('packed'),plain=await pixels('mesh'),prepared=await pixels('prepared'),checks:any={mesh:compare(reference,plain),prepared:compare(plain,prepared)};
        for(const mode of ['0.5px','1px','2px'] as Mode[]){const candidate=await pixels(mode);checks[mode]={packed:compare(reference,candidate),prepared:compare(prepared,candidate)};}
        const timings=[];for(const mode of modes){status(`${world} ${w}×${h} ${view.name}: timing ${mode}`);await nextFrame();timings.push(await measure('packed',mode,options.batches??12));}
        // Same layout/shader comparison isolates actual reduction from conversion/baking.
        timings.push(await measure('prepared','1px',options.batches??12));
        results.rows.push({width:w,height:h,view:view.name,camera:cameraState,checks,timings});await save();show('1px');
      }}await device.queue.onSubmittedWorkDone();status(`Complete: ${world}, ${results.rows.length} cases, ${errors.length} GPU errors`);await save();return results;
      }finally{running=false;}
    }
    function button(label:string,fn:()=>unknown){const b=document.createElement('button');b.textContent=label;b.style.cssText='padding:7px;margin:4px';b.onclick=()=>{if(!running&&!closed)void fn();};root.querySelector('#lp-controls')!.append(b);}
    button('Run comparisons',()=>run().catch(e=>{errors.push(String(e));status(String(e));}));for(const mode of modes)button(`Show ${mode}`,()=>show(mode));
    for(const view of views)button(`View ${view.name}`,()=>{pose(view);show('1px');});
    button('Download JSON',()=>{const a=document.createElement('a');a.download=`far-lowpoly-${world}.json`;a.href=URL.createObjectURL(new Blob([JSON.stringify(results)],{type:'application/json'}));a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});
    button('Close lab',dispose);resize(1280,720);pose(views[0]);show('1px');status(`Ready: ${snapshot.faces.toLocaleString()} faces in ${snapshot.bricks.length} bricks`);await save();
    return {run,results,show,resize,pose,dispose};
  }catch(error){await dispose();throw error;}
}
