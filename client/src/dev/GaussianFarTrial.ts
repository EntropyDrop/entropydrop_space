/** Optional offline hybrid renderer: original near/mid terrain plus sorted 3D Gaussians. */
import * as THREE from 'three/webgpu';
import { storage, instanceIndex, uint, vec2, vec3, vec4, uniform, cameraViewMatrix, cameraWorldMatrix,
  cameraProjectionMatrix, positionGeometry, varying, exp, dot, wgslFn, output } from 'three/tsl';
import { voxelEmissionColor } from '@entropydrop/space-engine/render/VoxelEmission.ts';
import { getWorldProjection } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { captureGaussianSources, selectGaussianBudget, radixDepthOrder } from './GaussianFarData.ts';
import { interceptMethod } from './FrameDiagnostics.ts';

if(import.meta.hot)import.meta.hot.accept();
export const GAUSSIAN_MODES=['original','fine','coarse'] as const;
export type GaussianMode=typeof GAUSSIAN_MODES[number]|'omit';
// Project a full 3D covariance through the perspective Jacobian, then rasterize its 3-sigma ellipse.
const project=wgslFn(`fn gaussianFarProject(center:vec3<f32>, b0:vec3<f32>, b1:vec3<f32>, b2:vec3<f32>,
  view:mat4x4<f32>, world:mat4x4<f32>, projection:mat4x4<f32>, viewport:vec2<f32>, corner:vec2<f32>) -> vec3<f32> {
  let p=(view*vec4<f32>(center,1.0)).xyz; let depth=max(-p.z,0.01);
  let focal=vec2<f32>(projection[0][0],projection[1][1])*viewport*0.5;
  let jx=vec3<f32>(focal.x/depth,0.0,focal.x*p.x/(depth*depth));
  let jy=vec3<f32>(0.0,focal.y/depth,focal.y*p.y/(depth*depth));
  let v0=(view*vec4<f32>(b0,0.0)).xyz; let v1=(view*vec4<f32>(b1,0.0)).xyz; let v2=(view*vec4<f32>(b2,0.0)).xyz;
  let dx=vec3<f32>(dot(jx,v0),dot(jx,v1),dot(jx,v2)); let dy=vec3<f32>(dot(jy,v0),dot(jy,v1),dot(jy,v2));
  let a=dot(dx,dx)+0.3; let b=dot(dx,dy); let c=dot(dy,dy)+0.3;
  let mid=(a+c)*0.5; let delta=sqrt(max(0.0,(a-c)*(a-c)*0.25+b*b));
  let l1=max(mid+delta,0.3); let l2=max(mid-delta,0.3);
  var axis=vec2<f32>(1.0,0.0);
  if(abs(b)>0.00001){axis=normalize(vec2<f32>(b,l1-a));}else if(c>a){axis=vec2<f32>(0.0,1.0);}
  let offset=3.0*(axis*sqrt(l1)*corner.x+vec2<f32>(-axis.y,axis.x)*sqrt(l2)*corner.y);
  return center+(world*vec4<f32>(offset/focal*depth,0.0,0.0)).xyz;
}`);

export async function createGaussianFarTrial(game:any,options:{minimumDistance?:number;fineBudget?:number;coarseBudget?:number}={}) {
  if(!import.meta.env.DEV||!game.offline)throw new Error('Offline DEV required.');
  const scene=game.sceneRenderer,renderer=scene.renderer,layer=game.world.distantSurface.voxels,arena=layer.arena;
  if(!game.world.distantSurface.isEnabled()||!arena?.stats.residentFaces||layer.hasPendingWork||layer.hasPendingTransitions
    ||getWorldProjection()!=='torus'||layer.getTorusBackfaceCullingEnabled())throw new Error('Wait for original settled torus far terrain.');
  let suspended=false;const resume=interceptMethod(game,'animate',()=>{suspended=true;});
  while(!suspended)await new Promise<void>(r=>requestAnimationFrame(()=>r()));
  const undo:(()=>void)[]=[],resources:any[]=[],buffers:any[]=[];
  const group=new THREE.Group();group.name='GaussianFarTrial';group.visible=false;
  let mode:GaussianMode='original',closed=false;
  const stats={materials:2,draws:0,farTriangles:0,fallbackDraws:0,fallbackSources:0,visibleSplats:0,sortMs:0,cullMs:0,
    sortTotalMs:0,sorts:0,uploadBytes:0,selectedFaces:0};
  try {
    const start=performance.now(),snapshot=await captureGaussianSources(game,options.minimumDistance??768),{sources}=snapshot;
    if(!sources.length)throw new Error('No eligible extreme-far sources.');stats.selectedFaces=snapshot.selectedFaces;
    const selected=new Map(sources.map((s,i)=>[s.entry,i])),validity=new Uint8Array(sources.length),previous=new Uint8Array(sources.length);
    const builds={fine:selectGaussianBudget(sources,options.fineBudget??160000),coarse:selectGaussianBudget(sources,options.coarseBudget??80000)};
    const variants:any={};
    const viewport=uniform(new THREE.Vector2(renderer.domElement.width,renderer.domElement.height));
    for(const name of ['fine','coarse'] as const){
      const data=builds[name],attribute=new THREE.StorageBufferAttribute(data.records,4),order=new THREE.StorageBufferAttribute(new Uint32Array(data.count),1);
      const records=storage(attribute,'vec4',attribute.count).toReadOnly(),ids=storage(order,'uint',order.count).toReadOnly();buffers.push(attribute,order);
      const at=uint(ids.element(instanceIndex)).mul(6),center=records.element(at),b0=records.element(at.add(1)),b1=records.element(at.add(2)),b2=records.element(at.add(3));
      const normal=records.element(at.add(4)),color=varying(records.element(at.add(5)).xyz),uv=varying(positionGeometry.xy.mul(3));
      const alpha=exp(dot(uv,uv).mul(-.5)).mul(varying(center.w));
      const material=new THREE.MeshStandardNodeMaterial({roughness:.65,metalness:.15,transparent:true,depthWrite:false,depthTest:true,side:THREE.DoubleSide});
      material.name=`GaussianFar.${name}`;material.forceSinglePass=true;
      material.positionNode=vec3(project(center.xyz,b0.xyz,b1.xyz,b2.xyz,cameraViewMatrix,cameraWorldMatrix,cameraProjectionMatrix,viewport,positionGeometry.xy));
      material.normalNode=varying(cameraViewMatrix.mul(vec4(normal.xyz,0)).xyz).normalize();material.colorNode=color;
      material.opacityNode=alpha;material.maskNode=alpha.greaterThan(1/255);
      material.outputNode=varying(normal.w).greaterThan(.5).select(vec4(voxelEmissionColor(color),alpha),output);
      const geometry=new THREE.InstancedBufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,1,-1,0,1,1,0,-1,1,0],3));
      geometry.setAttribute('normal',new THREE.Float32BufferAttribute([0,0,1,0,0,1,0,0,1,0,0,1],3));geometry.setIndex([0,1,2,0,2,3]);geometry.instanceCount=0;
      const mesh=new THREE.Mesh(geometry,material);mesh.userData.torusPreBent=true;mesh.frustumCulled=false;mesh.visible=false;mesh.renderOrder=1;group.add(mesh);
      const sourceBounds=new Float32Array(sources.length*6);for(let i=0;i<sources.length;i++)sourceBounds.set([Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity],i*6);
      for(let i=0;i<data.count;i++){const at=data.sourceIds[i]*6,r=data.radii[i];for(let d=0;d<3;d++){
        sourceBounds[at+d]=Math.min(sourceBounds[at+d],data.records[i*24+d]-r);sourceBounds[at+d+3]=Math.max(sourceBounds[at+d+3],data.records[i*24+d]+r);}}
      variants[name]={data,mesh,order,sourceBounds,visibleSources:new Uint8Array(sources.length),ids:order.array,
        scratch:new Uint32Array(data.count),keys:new Uint32Array(data.count),bins:new Uint32Array(256),last:new Float64Array(16).fill(NaN)};
      resources.push(geometry,material);
    }
    // Release construction moments; source guards and packed candidates remain.
    sources.forEach(s=>s.levels=[]);scene.scene.add(group);
    function valid(i:number){const s=sources[i],e=s.entry;
      return !e.invalid&&!e.releasing&&e.page.entries.has(e)&&e.geometry===s.geometry&&e.count===s.count
        &&e.mesh.material===e.mesh.userData.opaqueMaterial&&e.versions.length===s.versions.length&&e.versions.every((v:number,j:number)=>v===s.versions[j]);}
    const blank={map:new Float32Array(0),blocks:0,faces:0,back:0,outside:0,covered:0};
    undo.push(interceptMethod(arena,'visibleBlocks',(original,args)=>{const i=selected.get(args[0]);
      return mode!=='original'&&i!==undefined&&valid(i)?blank:original(...args);}));
    undo.push(interceptMethod(layer,'updateView',(original,args)=>{
      if(mode!=='original'){
        if(game.playerPhysics.position.distanceTo(snapshot.initial)>64)throw new Error('Gaussian snapshot exceeded 64 m motion guard.');
        for(let i=0;i<sources.length;i++){const v=Number(valid(i));if(v!==previous[i]){previous[i]=v;arena.visibilityDirty=true;layer.arenaDirty=true;}}
      }
      return original(...args);
    }));
    const vp=new THREE.Matrix4(),frustum=new THREE.Frustum();
    function refresh(){
      stats.sortMs=stats.cullMs=stats.uploadBytes=stats.visibleSplats=stats.fallbackSources=0;
      if(mode==='original'||mode==='omit')return;
      const variant=variants[mode],{data,mesh,order,ids,keys,scratch,bins,last,sourceBounds,visibleSources}=variant;
      const view=scene.camera.matrixWorldInverse.elements,cam=scene.camera.position;
      let changed=false;for(let i=0;i<sources.length;i++){const v=Number(valid(i));changed ||= validity[i]!==v;validity[i]=v;stats.fallbackSources+=Number(!v);}
      if(!changed&&view.every((v:number,i:number)=>v===last[i])){stats.visibleSplats=mesh.geometry.instanceCount;return;}
      last.set(view);viewport.value.set(renderer.domElement.width,renderer.domElement.height);
      vp.multiplyMatrices(scene.camera.projectionMatrix,scene.camera.matrixWorldInverse);frustum.setFromProjectionMatrix(vp,THREE.WebGPUCoordinateSystem);
      const t=performance.now(),a=data.records;let count=0;
      for(let i=0;i<sources.length;i++){let visible=validity[i];const at=i*6;
        if(visible)for(const p of frustum.planes){const n=p.normal;
          if(n.x*sourceBounds[at+(n.x>0?3:0)]+n.y*sourceBounds[at+(n.y>0?4:1)]+n.z*sourceBounds[at+(n.z>0?5:2)]+p.constant<0){visible=0;break;}}
        visibleSources[i]=visible;}
      for(let i=0;i<data.count;i++){
        if(!visibleSources[data.sourceIds[i]])continue;const at=i*24,x=a[at],y=a[at+1],z=a[at+2],radius=data.radii[i];
        const depth=-(view[2]*x+view[6]*y+view[10]*z+view[14]);if(depth<=.1)continue;
        // Keep a conservative normal tolerance for curved clusters.
        if(a[at+16]*(cam.x-x)+a[at+17]*(cam.y-y)+a[at+18]*(cam.z-z)<-radius)continue;
        let outside=false;for(const p of frustum.planes)if(p.normal.x*x+p.normal.y*y+p.normal.z*z+p.constant < -radius){outside=true;break;}if(outside)continue;
        ids[count++]=i;keys[i]=Math.min(16777215,Math.max(0,Math.round(depth*1024)));
      }
      stats.cullMs=performance.now()-t;const sort=performance.now();radixDepthOrder(ids,scratch,keys,count,bins);stats.sortMs=performance.now()-sort;
      stats.sortTotalMs+=stats.sortMs;stats.sorts++;stats.visibleSplats=count;stats.uploadBytes=count*4;
      order.clearUpdateRanges();if(count)order.addUpdateRange(0,count);order.needsUpdate=true;mesh.geometry.instanceCount=count;
    }
    undo.push(interceptMethod(renderer,'render',(original,args)=>{
      if(args[0]!==scene.scene)return original(...args);refresh();stats.draws=stats.farTriangles=stats.fallbackDraws=0;
      for(const mesh of layer.group.children){if(!mesh.visible||!mesh.isMesh)continue;stats.draws++;
        if(!mesh.userData.voxelArena)stats.fallbackDraws++;
        stats.farTriangles+=Math.min(mesh.geometry.index?.count??0,mesh.geometry.drawRange.count)/3*(mesh.geometry.instanceCount??1);}
      if(mode==='fine'||mode==='coarse'){stats.draws++;stats.farTriangles+=stats.visibleSplats*2;}
      return original(...args);
    }));
    const metadata={minimumDistance:snapshot.minimumDistance,movementLimit:64,selectedFaces:snapshot.selectedFaces,sources:sources.length,
      captureMs:snapshot.captureMs,buildMs:performance.now()-start,recordBytes:96,sort:'CPU 24-bit radix, per changed view',
      modes:Object.fromEntries(Object.entries(builds).map(([name,b])=>[name,{count:b.count,budget:b.budget,budgetMet:b.budgetMet,bytes:b.bytes,levels:b.levels}]))};
    function set(next:GaussianMode){if(closed||![...GAUSSIAN_MODES,'omit'].includes(next))throw new Error('Invalid Gaussian mode.');
      if(next!==mode){arena.visibilityDirty=true;layer.arenaDirty=true;layer.group.needsUpdate=true;Object.values(variants).forEach((v:any)=>v.last.fill(NaN));}
      mode=next;group.visible=next!=='original'&&next!=='omit';for(const [name,v]of Object.entries(variants) as [string,any][])v.mesh.visible=name===next;}
    function dispose(){if(closed)return;set('original');closed=true;undo.reverse().forEach(fn=>fn());scene.scene.remove(group);resources.forEach(r=>r.dispose());for(const b of buffers)renderer._attributes.delete(b);}
    resume();requestAnimationFrame(game.animate);
    return {metadata,stats,group,set,dispose,get mode(){return mode;}};
  }catch(error){undo.reverse().forEach(fn=>fn());scene.scene.remove(group);resources.forEach(r=>r.dispose());for(const b of buffers)renderer._attributes.delete(b);resume();requestAnimationFrame(game.animate);throw error;}
}
export type GaussianFarTrial=Awaited<ReturnType<typeof createGaussianFarTrial>>;
