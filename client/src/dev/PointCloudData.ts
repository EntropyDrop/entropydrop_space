/** Offline surface samples: no Gaussian fitting, transparency or random deletion. */
import { Vector3 } from 'three/webgpu';
import { bendTorusPoint, bendDirection } from '@entropydrop/space-engine/torus/TorusWorld.ts';

export type PointSource = { entry:any; geometry:any; versions:number[]; count:number; start:number; distance:number; bounds:number[];
  ranges:{dense:[number,number];surfel:[number,number]} };
export type PointCloud = { records:Float32Array; count:number; spacingPixels:number; scale:number; bytes:number };
const frame=()=>new Promise<void>(r=>requestAnimationFrame(()=>r()));
const bitFloat=new Float32Array(1),bitWord=new Uint32Array(bitFloat.buffer);
function packedColor(word:number,dir:number,emission:number){
  const light=[.4,.8,.3], brightness=.45+.55*Math.max(0,light[dir>>1]*(dir&1?1:-1)/Math.hypot(...light));
  let value=0;for(let c=0;c<3;c++)value|=Math.round((word>>>(c*8)&255)*(emission?1:brightness))<<(c*8);
  bitWord[0]=(value|(emission?1<<24:0))>>>0;return bitFloat[0];
}
function packedNormal(v:Vector3){bitWord[0]=(Math.round((v.x*.5+.5)*1023)|Math.round((v.y*.5+.5)*1023)<<10|Math.round((v.z*.5+.5)*1023)<<20)>>>0;return bitFloat[0];}

export async function capturePointCloud(game:any,maximumPoints=3_000_000){
  const start=performance.now(),scene=game.sceneRenderer,arena=game.world.distantSurface.voxels.arena;
  const initial=game.playerPhysics.position.clone(),camera=bendTorusPoint(initial.x,initial.y,initial.z);
  const focal=scene.renderer.domElement.height*scene.camera.projectionMatrix.elements[5]/2;
  const sources:PointSource[]=[],records:number[]=[],sizes:number[]=[];
  const p=new Vector3(),q=new Vector3(),r=new Vector3(),s=new Vector3();
  for(const entry of arena.pages.flatMap((p:any)=>[...p.entries])){
    const bounds=entry.geometry.userData.voxelVisibility as Float32Array|undefined;
    if(!bounds||entry.attributes||entry.invalid||entry.copied!==entry.count)continue;
    let distance=Infinity;const box=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
    for(let i=0;i<bounds.length;i+=12){distance=Math.min(distance,Math.hypot(camera.x-bounds[i],camera.y-bounds[i+1],camera.z-bounds[i+2])-bounds[i+3]);
      for(let d=0;d<3;d++){box[d]=Math.min(box[d],bounds[i+d]-bounds[i+3]);box[d+3]=Math.max(box[d+3],bounds[i+d]+bounds[i+3]);}}
    if(distance<768)continue;
    const source=sources.length,at=records.length/8,o=entry.origin,a=entry.page.data.array as Uint32Array;
    for(let i=0;i<entry.count;i++){
      const k=(entry.start+i)*4,dir=a[k+2]>>>16&255,emission=a[k+2]>>>24;
      const flat=[o.x+(a[k]&65535)/8,o.y+(a[k]>>>16)/8,o.z+(a[k+1]&65535)/8];
      const su=(a[k+1]>>>16)/8,sv=(a[k+2]&65535)/8,u=dir<2?1:dir<4?2:0,v=dir<2?2:dir<4?0:1;
      bendTorusPoint(...flat as [number,number,number],p);flat[u]+=su;bendTorusPoint(...flat as [number,number,number],q);
      flat[v]+=sv;bendTorusPoint(...flat as [number,number,number],s);flat[u]-=su;bendTorusPoint(...flat as [number,number,number],r);flat[v]-=sv;
      records.push(...flat,source,su,sv,dir,packedColor(a[k+3],dir,emission));
      sizes.push(Math.max(p.distanceTo(q),r.distanceTo(s)),Math.max(p.distanceTo(r),q.distanceTo(s)));
    }
    sources.push({entry,geometry:entry.geometry,versions:[...entry.versions],count:entry.count,start:at,distance,bounds:box,ranges:{dense:[0,0],surfel:[0,0]}});
    if(source%32===0){(window as any).pointProgress={state:'capturing',sources:sources.length};await frame();}
  }
  if(!sources.length)throw new Error('No settled extreme-far sources.');
  const quads=Float32Array.from(records),lengths=Float32Array.from(sizes);records.length=sizes.length=0;
  maximumPoints=Math.min(maximumPoints,Math.floor(scene.renderer.backend.device.limits.maxStorageBufferBindingSize/32)-32);
  if(quads.length/8>maximumPoints)throw new Error('Source faces exceed point allocation guard.');
  const clouds={} as Record<'dense'|'surfel',PointCloud>;
  for(const [name,spacingPixels]of [['dense',1],['surfel',2]] as const){
    const budget=name==='dense'?maximumPoints:Math.max(Math.ceil(quads.length/8*1.05),Math.floor(maximumPoints*.4));
    let scale=1,count=0;const grid=new Uint16Array(quads.length/4);
    for(let attempt=0;attempt<12;attempt++){
      count=0;for(const source of sources){const spacing=source.distance/focal*spacingPixels*scale;
        for(let i=source.start;i<source.start+source.count;i++){const nu=Math.max(1,Math.ceil(lengths[i*2]/spacing)),nv=Math.max(1,Math.ceil(lengths[i*2+1]/spacing));
          if(nu>65535||nv>65535)throw new Error('Point grid too large.');grid[i*2]=nu;grid[i*2+1]=nv;count+=nu*nv;}}
      if(count<=budget)break;scale*=Math.max(1.1,Math.sqrt(count/budget));
    }
    if(count>budget)throw new Error('Point budget not met.');
    const points=new Float32Array(count*8),direction=new Vector3(),normal=new Vector3();let out=0;
    for(const [si,source] of sources.entries()){
      const begin=out;
      for(let i=source.start;i<source.start+source.count;i++){
        const k=i*8,flat=[quads[k],quads[k+1],quads[k+2]],su=quads[k+4],sv=quads[k+5],dir=quads[k+6];
        const u=dir<2?1:dir<4?2:0,v=dir<2?2:dir<4?0:1,nu=grid[i*2],nv=grid[i*2+1];
        const diameter=Math.max(lengths[i*2]/nu,lengths[i*2+1]/nv);direction.set(0,0,0).setComponent(dir>>1,dir&1?1:-1);
        for(let y=0;y<nv;y++)for(let x=0;x<nu;x++){
          const xyz=[...flat];xyz[u]+=(x+.5)*su/nu;xyz[v]+=(y+.5)*sv/nv;
          bendTorusPoint(...xyz as [number,number,number],p);bendDirection(...xyz as [number,number,number],direction,normal);
          points.set([p.x,p.y,p.z,si,quads[k+7],packedNormal(normal),diameter,0],out++*8);
        }
      }
      source.ranges[name]=[begin,out-begin];
      if(si%32===0){(window as any).pointProgress={state:'sampling',cloud:name,completed:out,total:count};await frame();}
    }
    clouds[name]={records:points,count,spacingPixels,scale,bytes:points.byteLength+count*4};
  }
  return {sources,quads,clouds,initial,focal,minimumDistance:768,maximumPoints,buildMs:performance.now()-start};
}
