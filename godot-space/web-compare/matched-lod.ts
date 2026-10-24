import * as THREE from 'three/webgpu';
import { attribute, vec4 } from 'three/tsl';
import { applyCameraBend, bendPointForView, setTorusViewCorrection } from '../../engine/src/torus/TorusWorld.ts';

// Capture the existing client's settled DRAW geometry, including its original
// arena block maps and near/micro meshes. No native meshing or LOD approximation.
export async function captureMatchedLod(game:any, status:(s:string)=>void) {
  const profile = new URLSearchParams(location.search).get("lod_profile") === "fine" ? "fine" : "baseline";
  const source=game.sceneRenderer, renderer=source.renderer, world=game.world;
  if(!world.getTerrainAoiLoadProgress().ready || world.distantSurface.hasPendingWork)
    throw new Error('Wait until both near terrain and far LOD settle.');
  (window as any).copperSurfaceStatus.frozen=true;
  game.animate=()=>{};
  await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
  const flatCamera=source.camera.position.clone();
  setTorusViewCorrection(flatCamera);
  const camera=new THREE.PerspectiveCamera(70,1280/720,.1,10000);
  camera.coordinateSystem=THREE.WebGPUCoordinateSystem;
  camera.position.copy(source.camera.position);camera.quaternion.copy(source.camera.quaternion);
  camera.updateProjectionMatrix();applyCameraBend(camera);
  const scene=new THREE.Scene();scene.background=new THREE.Color('#121820');
  const visible=(node:any)=>{for(let n=node;n;n=n.parent)if(!n.visible)return false;return true;};
  const roots:any[]=[world.distantSurface.mesh];
  for(const chunk of world.chunks.values())if(chunk.mesh && visible(chunk.mesh))roots.push(chunk.mesh);
  for(const mesh of world.microVoxels.renderMeshes.values())if(visible(mesh))roots.push(mesh);
  for(const root of roots)scene.attach(root);
  const mats=new Set<any>();scene.traverse((o:any)=>{if(o.material)for(const m of Array.isArray(o.material)?o.material:[o.material])mats.add(m);});
  for(const m of mats){
    // Identical unlit color isolates geometry; retain production deformation,
    // packed arena fetches, mask nodes, draw grouping and draw order.
    const color=m.userData.voxelArenaPosition ? m.colorNode??attribute('color','vec3') : attribute('color','vec3');
    m.lights=false;m.lightsNode=null;m.outputNode=vec4(color,1);m.fog=false;m.toneMapped=false;
    m.transparent=false;m.opacity=1;m.needsUpdate=true;
  }
  renderer.toneMapping=THREE.NoToneMapping;renderer.info.autoReset=true;
  renderer.setPixelRatio(1);renderer.setSize(1280,720,false);
  scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);
  renderer.render(scene,camera);
  const mask=world.distantSurface.handoff.texture.image.data as Uint8Array;
  if(mask.some((n:number)=>n!==0&&n!==255))throw new Error('Handoff has a partial fade; reload and settle before capture.');
  const post=async(name:string,body:Blob|ArrayBuffer|Uint8Array)=>{
    const r=await fetch('/__torus_comparison__/matched/'+profile+'/'+name,{method:'POST',body:body as any});
    if(!r.ok)throw new Error(await r.text());return r.json();
  };
  await post('mask.bin',mask);
  const draws:any[]=[],v=new THREE.Vector3();let totalVertices=0,totalTriangles=0;
  const upload=async(name:string,kind:string,data:Float32Array,indices:Uint32Array,masked:boolean,side:number)=>{
    if(!indices.length)return;
    const header=new Uint32Array([data.length/8,indices.length]);
    const blob=new Blob([header,data,indices]);const id=`mesh-${draws.length}.bin`;
    const saved=await post(id,blob);
    draws.push({file:id,name,kind,vertices:data.length/8,triangles:indices.length/3,masked,side,sha256:saved.sha256});
    totalVertices+=data.length/8;totalTriangles+=indices.length/3;
    status(`Capturing identical LOD: ${draws.length} draws / ${totalTriangles.toLocaleString()} triangles`);
  };
  const vertex=(out:Float32Array,i:number,x:number,y:number,z:number,r:number,g:number,b:number,u:number,w:number)=>{
    bendPointForView(x,y,z,v);out.set([v.x,v.y,v.z,r,g,b,u,w],i*8);
  };
  const layer=world.distantSurface.voxels,arena=layer.arena;
  const farMeshes=new Set<any>();
  for(const page of arena.pages)for(const mesh of page.runs)if(visible(mesh)){
    farMeshes.add(mesh);
    const n=mesh.geometry.instanceCount*arena.getInstanceFaces(),out=new Float32Array(n*4*8),index=new Uint32Array(n*6);
    const map=page.map.array,packed=page.data.array,compact=arena.getCompactMapsEnabled(),stride=compact?4:8;
    const runFaces=mesh.userData.voxelArenaFaces,base=mesh.userData.voxelArenaBase;
    const masked=mesh.material===page.mesh.userData.maskedMaterial;
    for(let i=0;i<n;i++){
      const bounded=Math.min(i,runFaces-1),at=(base+Math.floor(bounded/16))*stride;
      const first=compact?Math.floor(map[at]/32):map[at],count=compact?(map[at]%32):map[at+1];
      const valid=bounded%16<count&&i<runFaces;
      const record=(first+Math.min(bounded%16,count-1))*4;
      const a=packed[record],b=packed[record+1],c=packed[record+2],rgb=packed[record+3];
      const dir=(c>>>16)&255,axis=dir>>1,sign=dir%2?1:-1;
      const origin=[map[at+(compact?1:2)],map[at+(compact?2:3)],map[at+(compact?3:4)]];
      const p=[origin[0]+(a&65535)/8,origin[1]+(a>>>16)/8,origin[2]+(b&65535)/8];
      const span=[(b>>>16)/8,(c&65535)/8];
      for(let k=0;k<4;k++){
        let qx=k===1||k===2?1:0,qy=k>=2?1:0;if(! (dir%2))qx=1-qx;
        const point=p.slice();point[(axis+1)%3]+=qx*span[0];point[(axis+2)%3]+=qy*span[1];
        const wrap=(x:number,size:number)=>((x%size)+size)%size;
        const ux=(Math.floor(wrap(point[0]-(axis===0?sign*.01:0),16384)/16)+.5)/1024;
        const uz=(Math.floor(wrap(point[2]-(axis===2?sign*.01:0),2048)/16)+.5)/128;
        if(valid)vertex(out,i*4+k,...point as [number,number,number],(rgb&255)/255,((rgb>>>8)&255)/255,((rgb>>>16)&255)/255,ux,uz);
        // Invalid block padding collapses exactly as in the original shader.
      }
      index.set([i*4,i*4+1,i*4+2,i*4,i*4+2,i*4+3],i*6);
    }
    await upload(mesh.name,'far-arena',out,index,masked,mesh.material.side);
  }
  // Settled sources must be in the arena. Fail instead of omitting geometry.
  for(const mesh of layer.group.children)if(visible(mesh)&&mesh.geometry?.instanceCount>0&&!farMeshes.has(mesh))
    throw new Error('Unmigrated far source: '+mesh.name);
  for(const root of roots.slice(1)){
    const meshes:any[]=[];root.traverse((o:any)=>{if(o.isMesh&&visible(o))meshes.push(o);});
    for(const mesh of meshes){
      const g=mesh.geometry,p=g.getAttribute('position'),col=g.getAttribute('color'),idx=g.index;
      if(!p||!col||!idx||g.isInstancedBufferGeometry)throw new Error('Unsupported near geometry '+mesh.name);
      const origin=new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
      const owner=((Math.floor((origin.z+.01)/16)%128+128)%128)*1024+((Math.floor((origin.x+.01)/16)%1024+1024)%1024);
      if(mask[owner*2]===0)continue;
      const out=new Float32Array(p.count*8);
      for(let i=0;i<p.count;i++){
        v.set(p.getX(i),p.getY(i),p.getZ(i)).applyMatrix4(mesh.matrixWorld);
        vertex(out,i,v.x,v.y,v.z,col.getX(i),col.getY(i),col.getZ(i),0,0);
      }
      const groups=g.groups.length?g.groups:[{start:0,count:idx.count,materialIndex:0}];
      for(const group of groups){
        const start=Math.max(group.start,g.drawRange.start),end=Math.min(group.start+group.count,idx.count,g.drawRange.start+g.drawRange.count);
        if(end<=start)continue;
        const mat=Array.isArray(mesh.material)?mesh.material[group.materialIndex]:mesh.material;
        await upload(mesh.name,mesh.name.includes('Micro')?'micro':'standard',out,new Uint32Array(idx.array.slice(start,end)),false,mat.side);
      }
    }
  }
  const manifest={schema:1,profile,distantSettings:world.getDistantSurfaceSettings(),detail:world.distantSurface.getDetailStatus(),world:'copper-metropolis',seed:20260922,view:'fixed Web LOD draw snapshot',flatCamera:flatCamera.toArray(),
    cameraPosition:camera.position.toArray(),cameraQuaternion:camera.quaternion.toArray(),fov:70,near:.1,far:10000,
    resolution:[1280,720],background:[18/255,24/255,32/255],msaa:renderer.samples??4,draws,totalVertices,totalTriangles,
    lod:{...layer.group.userData.voxelLodStats},arena:{...arena.stats},nearProgress:world.getTerrainAoiLoadProgress(),
    projection:'Web original camera-local torus correction, captured at fixed position',lighting:'unlit source vertex color, no fog, no tone mapping',
    created:new Date().toISOString()};
  const saved=await post('manifest.json',new TextEncoder().encode(JSON.stringify(manifest,null,2)));
  (manifest as any).sha256=saved.sha256;
  // DOM UI is removed in BOTH replay measurements. Only terrain render commands
  // remain; this is explicitly not a full game or streaming benchmark.
  const hide=document.createElement('style');hide.textContent='#space-react-root,#dev-render-diagnostics{display:none!important}';document.head.append(hide);
  let running=false,start=0,previous=0,raw:number[]=[],unfocused=0,maxDraws=0,maxTriangles=0,minTriangles=Infinity;
  const loop=(now:number)=>{
    renderer.render(scene,camera);
    if(running){
      const gap=now-previous;previous=now;
      if(now-start>=8000){raw.push(gap);if(!document.hasFocus())unfocused++;maxDraws=Math.max(maxDraws,renderer.info.render.drawCalls);
        maxTriangles=Math.max(maxTriangles,renderer.info.render.triangles);minTriangles=Math.min(minTriangles,renderer.info.render.triangles);}
      if(now-start>=32000){running=false;void finish();}
    }
    requestAnimationFrame(loop);
  };
  const summary=(a:number[])=>{const s=[...a].sort((a,b)=>a-b),mean=a.reduce((x,y)=>x+y,0)/a.length,tail=s.slice(-Math.ceil(s.length*.01));return {count:a.length,mean,p50:s[Math.floor((s.length-1)*.5)],p95:s[Math.floor((s.length-1)*.95)],p99:s[Math.floor((s.length-1)*.99)],max:s.at(-1),slowestOnePercentMean:tail.reduce((x,y)=>x+y,0)/tail.length};};
  async function finish(){
    const frameMs=summary(raw),data={backend:'Existing WebGPU renderer / frozen original draw commands',world:'copper-metropolis',seed:20260922,
      mode:'matched-lod-static',profile,distantSettings:manifest.distantSettings,manifestSha256:saved.sha256,resolution:[renderer.domElement.width,renderer.domElement.height],warmupSeconds:8,durationSeconds:24,
      frameMs,fps:1000/frameMs.mean,onePercentLowFps:1000/frameMs.slowestOnePercentMean,unfocusedFrames:unfocused,maxDrawCalls:maxDraws,
      minPrimitives:minTriangles,maxPrimitives:maxTriangles,expectedTriangles:totalTriangles,rawFrameMs:raw,utc:new Date().toISOString(),
      frameMetric:'requestAnimationFrame timestamp intervals',observedDisplayHz:120,msaa:renderer.samples??4};
    const r=await fetch('/__torus_comparison__/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const result=await r.json();status(`SAVED ${result.file}\n${data.fps.toFixed(2)} FPS / p95 ${frameMs.p95.toFixed(2)} ms\nTriangles ${minTriangles}–${maxTriangles} / expected ${totalTriangles}\nFocus lost frames ${unfocused}`);
    document.getElementById('native-comparison')!.style.display='';
  }
  requestAnimationFrame(loop);
  return {manifest,run:(scale=1)=>{renderer.setSize(1280*scale,720*scale,false);raw=[];unfocused=0;maxDraws=maxTriangles=0;minTriangles=Infinity;start=previous=performance.now();running=true;document.getElementById('native-comparison')!.style.display='none';},
    save:async()=>{const blob=await new Promise<Blob|null>(resolve=>renderer.domElement.toBlob(resolve,'image/png'));if(blob)await fetch('/__torus_comparison__/image',{method:'POST',body:blob});}};
}
