/** Three opaque point paths and a matching rectangle control, explicit offline DEV only. */
import * as THREE from 'three/webgpu';
import { storage,vertexIndex,instanceIndex,uint,float,vec2,vec3,vec4,uniform,varying,positionGeometry,
  cameraViewMatrix,cameraProjectionMatrix,screenCoordinate,wgslFn,mix,exp,min } from 'three/tsl';
import { getWorldProjection,torusBendNode } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { capturePointCloud } from './PointCloudData.ts';
import { interceptMethod } from './FrameDiagnostics.ts';
if(import.meta.hot)import.meta.hot.accept();
export const POINT_MODES=['original','rect','points','surfel','compute'] as const;
export type PointMode=typeof POINT_MODES[number]|'omit';
const decodeColor=wgslFn(`fn pointColor(value:f32)->vec3<f32>{let word=bitcast<u32>(value);let c=unpack4x8unorm(word).xyz;
  if((word>>24u)==0u){return c;}let linear=select(pow((c+vec3<f32>(0.055))/1.055,vec3<f32>(2.4)),c/12.92,c<=vec3<f32>(0.04045));
  return linear*0.65/max(dot(linear,vec3<f32>(0.2126,0.7152,0.0722)),0.000001);}`);
const normalCode=`fn pointNormal(word:u32)->vec3<f32>{return normalize(vec3<f32>(f32(word&1023u),f32((word>>10u)&1023u),f32((word>>20u)&1023u))/511.5-vec3<f32>(1.0));}`;
const clipPoint=wgslFn(`fn pointClip(p:vec3<f32>,normal:f32,diameter:f32,camera:vec3<f32>,view:mat4x4<f32>,projection:mat4x4<f32>)->vec4<f32>{
  let word=bitcast<u32>(normal);let n=normalize(vec3<f32>(f32(word&1023u),f32((word>>10u)&1023u),f32((word>>20u)&1023u))/511.5-vec3<f32>(1.0));
  if(dot(n,camera-p)<-diameter){return vec4<f32>(2.0,2.0,2.0,1.0);}return projection*view*vec4<f32>(p,1.0);}`);
const bitDepth=wgslFn('fn pointDepth(value:u32)->f32{return bitcast<f32>(value);}');
const computeCode=normalCode+`
struct Params{projection:mat4x4<f32>,view:mat4x4<f32>,camera:vec4<f32>,screen:vec4<u32>};
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> points:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read> order:array<u32>;
@group(0) @binding(3) var<storage,read_write> depths:array<atomic<u32>>;
@group(0) @binding(4) var<storage,read_write> winners:array<atomic<u32>>;
@compute @workgroup_size(256) fn clear(@builtin(global_invocation_id) id:vec3<u32>){if(id.x<p.screen.x*p.screen.y){atomicStore(&depths[id.x],0x3f800000u);atomicStore(&winners[id.x],0xffffffffu);}}
fn project(i:u32)->vec3<u32>{
  if(i>=p.screen.z){return vec3<u32>(0xffffffffu);}let id=order[i];let a=points[id*2u];let b=points[id*2u+1u];
  if(dot(pointNormal(bitcast<u32>(b.y)),p.camera.xyz-a.xyz)<-b.z){return vec3<u32>(0xffffffffu);}
  let c=p.projection*p.view*vec4<f32>(a.xyz,1.0);if(c.w<=0.0){return vec3<u32>(0xffffffffu);}let n=c.xyz/c.w;
  if(n.z<0.0||n.z>=1.0||abs(n.x)>=1.0||abs(n.y)>=1.0){return vec3<u32>(0xffffffffu);}
  let pixel=vec2<u32>(floor((n.xy*vec2<f32>(0.5,-0.5)+vec2<f32>(0.5))*vec2<f32>(p.screen.xy)));
  return vec3<u32>(pixel.y*p.screen.x+pixel.x,bitcast<u32>(n.z),id);
}
@compute @workgroup_size(256) fn depthPass(@builtin(global_invocation_id) id:vec3<u32>){let a=project(id.x);if(a.x!=0xffffffffu){atomicMin(&depths[a.x],a.y);}}
@compute @workgroup_size(256) fn winnerPass(@builtin(global_invocation_id) id:vec3<u32>){let a=project(id.x);if(a.x!=0xffffffffu&&atomicLoad(&depths[a.x])==a.y){atomicMin(&winners[a.x],a.z);}}
`;

export async function createPointCloudTrial(game:any){
  if(!import.meta.env.DEV||!game.offline)throw new Error('Offline DEV required.');
  const scene=game.sceneRenderer,renderer=scene.renderer,device=renderer.backend.device,layer=game.world.distantSurface.voxels,arena=layer.arena;
  if(!game.world.distantSurface.isEnabled()||layer.hasPendingWork||layer.hasPendingTransitions||getWorldProjection()!=='torus'
    ||layer.getTorusBackfaceCullingEnabled()||scene.getLightingQuality()!=='medium')throw new Error('Settled Medium torus fixture required.');
  let paused=false;const resume=interceptMethod(game,'animate',()=>{paused=true;});while(!paused)await new Promise<void>(r=>requestAnimationFrame(()=>r()));
  const resources:any[]=[],attributes:any[]=[],gpuResources:any[]=[],undo:(()=>void)[]=[];
  const group=new THREE.Group();group.name='PointCloudTrial';group.visible=false;let mode:PointMode='original',closed=false;
  const stats={materials:4,draws:0,farTriangles:0,fallbackSources:0,submittedPoints:0,cullMs:0,uploadBytes:0,computePasses:0};
  const width=renderer.domElement.width,height=renderer.domElement.height;
  try{
    const data=await capturePointCloud(game),sources=data.sources,selected=new Map(sources.map((s,i)=>[s.entry,i]));
    const validSource=(i:number)=>{const s=sources[i],e=s.entry;return !e.invalid&&!e.releasing&&e.page.entries.has(e)&&e.geometry===s.geometry
      &&e.count===s.count&&e.mesh.material===e.mesh.userData.opaqueMaterial&&e.versions.length===s.versions.length&&e.versions.every((v:number,j:number)=>v===s.versions[j]);};
    const blank={map:new Float32Array(0),blocks:0,faces:0,back:0,outside:0,covered:0};
    undo.push(interceptMethod(arena,'visibleBlocks',(original,args)=>mode!=='original'&&selected.has(args[0])&&validSource(selected.get(args[0])!)?blank:original(...args)));
    const validity=new Uint8Array(sources.length);validity.fill(1);
    undo.push(interceptMethod(layer,'updateView',(original,args)=>{
      if(mode!=='original'){if(game.playerPhysics.position.distanceTo(data.initial)>64)throw new Error('Point snapshot exceeded 64 m motion guard.');
        for(let i=0;i<sources.length;i++){const v=Number(validSource(i));if(validity[i]!==v){validity[i]=v;arena.visibilityDirty=true;layer.arenaDirty=true;}}}
      return original(...args);
    }));
    const viewport=uniform(new THREE.Vector2(width,height)),cameraPosition=uniform(new THREE.Vector3()),fogColor=uniform(new THREE.Color()),fogDensity=uniform(0);
    function shade(color:any,depth:any){return mix(color,fogColor,float(1).sub(exp(depth.mul(depth).mul(fogDensity).mul(fogDensity).negate())));}
    function attr(array:Float32Array|Uint32Array,itemSize:number,name:string){const a=new THREE.StorageBufferAttribute(array,itemSize);a.name=name;attributes.push(a);renderer._attributes.update(a,3);return a;}
    function bank(array:Float32Array,name:string){const count=array.length/8,record=attr(array,4,`point-${name}-records`),order=attr(new Uint32Array(count),1,`point-${name}-order`);
      const sequence=Uint32Array.from({length:count},(_,i)=>i);return{record,order,count,sequence,countVisible:0,
        records:storage(record,'vec4',record.count).toReadOnly(),ids:storage(order,'uint',count).toReadOnly()};}
    const banks={rect:bank(data.quads,'rect'),dense:bank(data.clouds.dense.records,'dense'),surfel:bank(data.clouds.surfel.records,'surfel')};
    const rectangleGeometry=new THREE.InstancedBufferGeometry();rectangleGeometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,1,0,0,1,1,0,0,1,0],3));rectangleGeometry.setIndex([0,1,2,0,2,3]);
    const rectBank=banks.rect,ri=uint(rectBank.ids.element(instanceIndex)).mul(2),qa=rectBank.records.element(ri),qb=rectBank.records.element(ri.add(1));
    const dir=qb.z,uv=vec2(dir.mod(2).lessThan(.5).select(positionGeometry.x.oneMinus(),positionGeometry.x),positionGeometry.y).mul(qb.xy);
    const flat=qa.xyz.add(dir.lessThan(2).select(vec3(0,uv.x,uv.y),dir.lessThan(4).select(vec3(uv.y,0,uv.x),vec3(uv.x,uv.y,0))));
    const bent=torusBendNode(flat).position,view=cameraViewMatrix.mul(vec4(bent,1));
    const rectMaterial=new THREE.MeshBasicNodeMaterial({fog:false});rectMaterial.vertexNode=cameraProjectionMatrix.mul(view);
    rectMaterial.colorNode=shade(varying(decodeColor(qb.w)),varying(view.z.negate()));
    const rect=new THREE.Mesh(rectangleGeometry,rectMaterial);resources.push(rectangleGeometry,rectMaterial);
    function pointMesh(name:'dense'|'surfel'){
      const b=banks[name],id=uint(b.ids.element(name==='dense'?vertexIndex:instanceIndex)).mul(2),a=b.records.element(id),c=b.records.element(id.add(1));
      const clip:any=clipPoint(a.xyz,c.y,c.z,cameraPosition,cameraViewMatrix,cameraProjectionMatrix),depth=cameraViewMatrix.mul(vec4(a.xyz,1)).z.negate();
      const material:any=name==='dense'?new THREE.PointsNodeMaterial({fog:false,alphaToCoverage:false}):new THREE.MeshBasicNodeMaterial({fog:false,side:THREE.DoubleSide});
      material.vertexNode=clip;material.colorNode=shade(varying(decodeColor(c.x)),varying(depth));
      let geometry:THREE.BufferGeometry;
      if(name==='dense'){
        geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(data.clouds.dense.records,8),3,0));
      }else{
        geometry=rectangleGeometry.clone();const size=c.z.mul(data.focal).div(depth).mul(1.15).clamp(1,6);
        material.vertexNode=clip.add(vec4(positionGeometry.xy.sub(.5).mul(size).mul(2).div(viewport).mul(clip.w),0,0));
      }
      const mesh=name==='dense'?new THREE.Points(geometry,material):new THREE.Mesh(geometry,material);resources.push(geometry,material);return mesh;
    }
    const points=pointMesh('dense'),surfel=pointMesh('surfel');
    const depths=attr(new Uint32Array(width*height),1,'point-compute-depth'),winners=attr(new Uint32Array(width*height),1,'point-compute-winner');
    const dnode=storage(depths,'uint',width*height).toReadOnly(),wnode=storage(winners,'uint',width*height).toReadOnly();
    const pixel=uint(screenCoordinate.y).mul(width).add(uint(screenCoordinate.x)),winner=wnode.element(pixel),safe=uint(min(float(winner),banks.dense.count-1)).mul(2);
    const cp=banks.dense.records.element(safe),cc=banks.dense.records.element(safe.add(1));
    const composeMaterial=new THREE.MeshBasicNodeMaterial({fog:false,side:THREE.DoubleSide});
    composeMaterial.vertexNode=vec4(positionGeometry.xy.mul(2).sub(1),0,1);composeMaterial.depthNode=bitDepth(uint(dnode.element(pixel)));
    composeMaterial.maskNode=uint(winner).notEqual(uint(0xffffffff));composeMaterial.colorNode=shade(decodeColor(cc.x),cameraViewMatrix.mul(vec4(cp.xyz,1)).z.negate());
    const composeGeometry=rectangleGeometry.clone();composeGeometry.instanceCount=1;
    const compose=new THREE.Mesh(composeGeometry,composeMaterial);compose.renderOrder=2;resources.push(composeGeometry,composeMaterial);
    const meshes={rect,points,surfel,compute:compose};for(const [name,mesh]of Object.entries(meshes)){mesh.name=`PointCloud.${name}`;mesh.userData.torusPreBent=true;mesh.frustumCulled=false;mesh.visible=false;group.add(mesh);}
    scene.scene.add(group);
    const B=(globalThis as any).GPUBufferUsage,params=device.createBuffer({size:160,usage:B.UNIFORM|B.COPY_DST,label:'point-params'});gpuResources.push(params);
    const layout=device.createBindGroupLayout({entries:[{binding:0,visibility:4,buffer:{type:'uniform'}},
      ...[1,2].map(binding=>({binding,visibility:4,buffer:{type:'read-only-storage'}})),...[3,4].map(binding=>({binding,visibility:4,buffer:{type:'storage'}}))]});
    const shader=device.createShaderModule({code:computeCode,label:'point-raster-compute'}),info=await shader.getCompilationInfo();
    if(info.messages.some((m:any)=>m.type==='error'))throw new Error(info.messages.map((m:any)=>m.message).join('\n'));
    const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]}),pipelines:any={};
    for(const entryPoint of ['clear','depthPass','winnerPass'])pipelines[entryPoint]=await device.createComputePipelineAsync({layout:pipelineLayout,compute:{module:shader,entryPoint}});
    const bind=device.createBindGroup({layout,entries:[{binding:0,resource:{buffer:params}},...[banks.dense.record,banks.dense.order,depths,winners].map((a,i)=>({binding:i+1,resource:{buffer:renderer.backend.get(a).buffer}}))]});
    const uniforms=new Float32Array(40),uniformWords=new Uint32Array(uniforms.buffer),vp=new THREE.Matrix4(),frustum=new THREE.Frustum();
    function refresh(){
      stats.cullMs=stats.uploadBytes=stats.submittedPoints=stats.computePasses=stats.fallbackSources=0;
      if(mode==='original'||mode==='omit')return;
      if(renderer.domElement.width!==width||renderer.domElement.height!==height)throw new Error('Point viewport changed.');
      cameraPosition.value.copy(scene.camera.position);fogColor.value.copy(scene.scene.fog.color);fogDensity.value=scene.scene.fog.density;
      const begin=performance.now(),name=mode==='rect'?'rect':mode==='surfel'?'surfel':'dense',b=banks[name];
      vp.multiplyMatrices(scene.camera.projectionMatrix,scene.camera.matrixWorldInverse);frustum.setFromProjectionMatrix(vp,THREE.WebGPUCoordinateSystem);let count=0;
      for(let i=0;i<sources.length;i++){
        if(!validSource(i)){stats.fallbackSources++;continue;}const s=sources[i],box=s.bounds;let visible=true;
        for(const plane of frustum.planes){const n=plane.normal;if(n.x*box[n.x>0?3:0]+n.y*box[n.y>0?4:1]+n.z*box[n.z>0?5:2]+plane.constant<0){visible=false;break;}}
        if(!visible)continue;const [start,size]=name==='rect'?[s.start,s.count]:s.ranges[name];
        b.order.array.set(b.sequence.subarray(start,start+size),count);count+=size;
      }
      b.countVisible=count;b.order.clearUpdateRanges();if(count)b.order.addUpdateRange(0,count);b.order.needsUpdate=true;renderer._attributes.update(b.order,3);
      stats.cullMs=performance.now()-begin;stats.uploadBytes=count*4;if(mode!=='rect')stats.submittedPoints=count;
      if(mode==='rect')rectangleGeometry.instanceCount=count;
      if(mode==='points')points.geometry.setDrawRange(0,count);
      if(mode==='surfel')(surfel.geometry as THREE.InstancedBufferGeometry).instanceCount=count;
      if(mode==='compute'){
        uniforms.set(scene.camera.projectionMatrix.elements);uniforms.set(scene.camera.matrixWorldInverse.elements,16);uniforms.set([...scene.camera.position.toArray(),0],32);uniformWords.set([width,height,count,0],36);device.queue.writeBuffer(params,0,uniforms);
        const encoder=device.createCommandEncoder({label:'point-cloud-compute'});
        for(const key of ['clear','depthPass','winnerPass']){const pass=encoder.beginComputePass({label:`point-${key}`});pass.setPipeline(pipelines[key]);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(Math.ceil((key==='clear'?width*height:count)/256));pass.end();}
        device.queue.submit([encoder.finish()]);stats.computePasses=3;
      }
    }
    undo.push(interceptMethod(renderer,'render',(original,args)=>{
      if(args[0]!==scene.scene)return original(...args);refresh();stats.draws=stats.farTriangles=0;
      for(const mesh of layer.group.children)if(mesh.visible&&mesh.isMesh){stats.draws++;stats.farTriangles+=Math.min(mesh.geometry.index?.count??0,mesh.geometry.drawRange.count)/3*(mesh.geometry.instanceCount??1);}
      if(mode!=='original'&&mode!=='omit'){stats.draws++;stats.farTriangles+=mode==='rect'?banks.rect.countVisible*2:mode==='surfel'?banks.surfel.countVisible*2:mode==='compute'?2:0;}
      return original(...args);
    }));
    function set(next:PointMode){if(closed||![...POINT_MODES,'omit'].includes(next))throw new Error('Invalid point mode.');
      if(next!==mode){arena.visibilityDirty=true;layer.arenaDirty=true;layer.group.needsUpdate=true;}mode=next;group.visible=next!=='original'&&next!=='omit';for(const [name,m]of Object.entries(meshes))m.visible=name===next;}
    function dispose(){if(closed)return;set('original');closed=true;undo.reverse().forEach(fn=>fn());scene.scene.remove(group);resources.forEach(r=>r.dispose());attributes.forEach(a=>renderer._attributes.delete(a));gpuResources.forEach(r=>r.destroy());}
    const metadata={minimumDistance:768,movementLimit:64,faces:data.quads.length/8,sources:sources.length,buildMs:data.buildMs,maximumPoints:data.maximumPoints,
      clouds:Object.fromEntries(Object.entries(data.clouds).map(([name,c])=>[name,{count:c.count,spacingPixels:c.spacingPixels,scale:c.scale,bytes:c.bytes}])),
      rectangleRecordBytes:32,pointRecordBytes:32,computeScreenBytes:width*height*8,lighting:'quantized flat-face brightness + original exponential fog; emission preserved; Medium only',
      compute:'1 pixel; clear + depth atomicMin + deterministic ID atomicMin + depth-writing fullscreen resolve',surfel:'2-pixel nominal sampling, projected opaque square diameter 1.15x spacing, clamped to 1..6 physical pixels'};
    resume();requestAnimationFrame(game.animate);return{metadata,stats,set,dispose,get mode(){return mode;}};
  }catch(error){undo.reverse().forEach(fn=>fn());scene.scene.remove(group);resources.forEach(r=>r.dispose());attributes.forEach(a=>renderer._attributes.delete(a));gpuResources.forEach(r=>r.destroy());resume();requestAnimationFrame(game.animate);throw error;}
}
export type PointCloudTrial=Awaited<ReturnType<typeof createPointCloudTrial>>;
