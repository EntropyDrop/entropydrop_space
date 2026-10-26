/** Procedural Gaussian hierarchy from voxel surface moments; no image training. */
import { Vector3 } from 'three/webgpu';
import { bendTorusPoint, bendDirection } from '@entropydrop/space-engine/torus/TorusWorld.ts';

export type Moment = { cell: number; dir: number; emission: number; tint: number; w: number; p: number[]; m: number[]; rgb: number[] };
export type GaussianSource = { entry: any; geometry: any; count: number; versions: number[]; distance: number; levels: Moment[][] };
const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
const key = (p: number[], cell: number, dir: number, emission: number, tint: number) =>
  `${Math.floor(p[0]/cell)},${Math.floor(p[1]/cell)},${Math.floor(p[2]/cell)}/${dir}/${emission}/${tint}`;
const channels = (word: number) => [word & 255, word >>> 8 & 255, word >>> 16 & 255];

function merge(map: Map<string, Moment>, item: Moment, cell: number) {
  const center = item.p.map(v => v/item.w), k = key(center,cell,item.dir,item.emission,item.tint);
  let target = map.get(k);
  if (!target) { target = { ...item, cell, p:[...item.p], m:[...item.m], rgb:[...item.rgb] }; map.set(k,target); }
  else { target.w += item.w; for(let i=0;i<3;i++){target.p[i]+=item.p[i];target.rgb[i]+=item.rgb[i];} for(let i=0;i<6;i++)target.m[i]+=item.m[i]; }
}

export async function captureGaussianSources(game: any, minimumDistance=768) {
  const arena=game.world.distantSurface.voxels.arena, initial=game.playerPhysics.position.clone();
  const camera=bendTorusPoint(initial.x,initial.y,initial.z), sources: GaussianSource[]=[];
  const start=performance.now(); let selectedFaces=0;
  const entries=arena.pages.flatMap((p:any)=>[...p.entries]);
  for(let ei=0;ei<entries.length;ei++) {
    const entry=entries[ei], bounds=entry.geometry.userData.voxelVisibility as Float32Array|undefined;
    if(!bounds || entry.attributes || entry.invalid || entry.copied!==entry.count)continue;
    let distance=Infinity;
    for(let i=0;i<bounds.length;i+=12)distance=Math.min(distance,Math.hypot(camera.x-bounds[i],camera.y-bounds[i+1],camera.z-bounds[i+2])-bounds[i+3]);
    if(distance<minimumDistance)continue;
    const bins=new Map<string,Moment>(), a=entry.page.data.array as Uint32Array, o=entry.origin;
    for(let i=0;i<entry.count;i++) {
      const at=(entry.start+i)*4, dir=a[at+2]>>>16&255, emission=a[at+2]>>>24;
      const p=[o.x+(a[at]&65535)/8,o.y+(a[at]>>>16)/8,o.z+(a[at+1]&65535)/8];
      const su=(a[at+1]>>>16)/8,sv=(a[at+2]&65535)/8,w=su*sv;
      const u=dir<2?1:dir<4?2:0,v=dir<2?2:dir<4?0:1;
      p[u]+=su/2;p[v]+=sv/2;
      // Local moments avoid catastrophic cancellation around the 16 km world coordinates.
      const q=p.map((x,d)=>x-[o.x,o.y,o.z][d]), variance=[.0025,.0025,.0025];variance[u]+=su*su/12;variance[v]+=sv*sv/12;
      const rgb=channels(a[at+3]),tint=(rgb[0]>>6)|((rgb[1]>>6)<<2)|((rgb[2]>>6)<<4);
      const item:Moment={cell:8,dir,emission,tint,w,p:q.map(x=>x*w),
        m:[q[0]*q[0]+variance[0],q[0]*q[1],q[0]*q[2],q[1]*q[1]+variance[1],q[1]*q[2],q[2]*q[2]+variance[2]].map(x=>x*w),rgb:rgb.map(x=>x*w)};
      merge(bins,item,8);
    }
    const levels=[...bins.values()].length?[Array.from(bins.values())]:[];
    for(const cell of [16,32,64,128,256]){const parent=new Map<string,Moment>();for(const m of levels.at(-1)??[])merge(parent,m,cell);levels.push([...parent.values()]);}
    sources.push({entry,geometry:entry.geometry,count:entry.count,versions:[...entry.versions],distance,levels});selectedFaces+=entry.count;
    if(ei%24===0){(window as any).gaussianProgress={state:'building',sources:sources.length,visited:ei,total:entries.length};await frame();}
  }
  return {sources,initial,selectedFaces,minimumDistance,captureMs:performance.now()-start};
}

/** Select whole hierarchy levels; the budget never drops arbitrary surfaces. */
export function selectGaussianBudget(sources:GaussianSource[],budget:number) {
  const levels=new Uint8Array(sources.length);let count=sources.reduce((sum,s)=>sum+s.levels[0].length,0);
  while(count>budget){let chosen=-1,nextLevel=0,score=Infinity;
    for(let i=0;i<sources.length;i++){const l=levels[i],s=sources[i];let next=l+1;
      while(next<s.levels.length&&s.levels[next].length>=s.levels[l].length)next++;if(next>=s.levels.length)continue;
      const projected=Math.pow(2,next+3)/s.distance;if(projected<score){score=projected;chosen=i;nextLevel=next;}}
    if(chosen<0)break;const s=sources[chosen],l=levels[chosen];levels[chosen]=nextLevel;count-=s.levels[l].length-s.levels[nextLevel].length;
  }
  const records=new Float32Array(count*24),sourceIds=new Uint32Array(count),radii=new Float32Array(count);
  const p=new Vector3(),q=new Vector3(),normal=new Vector3(),dir=new Vector3();let out=0;
  for(let si=0;si<sources.length;si++)for(const m of sources[si].levels[levels[si]]) {
    const center=m.p.map(v=>v/m.w), c=m.m.map(v=>v/m.w), o=sources[si].entry.origin;
    c[0]-=center[0]*center[0];c[1]-=center[0]*center[1];c[2]-=center[0]*center[2];c[3]-=center[1]*center[1];c[4]-=center[1]*center[2];c[5]-=center[2]*center[2];
    // Cholesky factor, then local torus Jacobian. Inflation closes seams between sampled surfaces.
    const a=Math.sqrt(Math.max(c[0],.0025)),b=c[1]/a,d=c[2]/a,e=Math.sqrt(Math.max(c[3]-b*b,.0025)),f=(c[4]-d*b)/e,g=Math.sqrt(Math.max(c[5]-d*d-f*f,.0025));
    const flat=[center[0]+o.x,center[1]+o.y,center[2]+o.z];bendTorusPoint(flat[0],flat[1],flat[2],p);
    const jac=flat.map((_,i)=>{const plus=[...flat],minus=[...flat];plus[i]+=.05;minus[i]-=.05;bendTorusPoint(...plus as [number,number,number],q);const v=q.clone();bendTorusPoint(...minus as [number,number,number],q);return v.sub(q).multiplyScalar(10);});
    const axes=[[a,b,d],[0,e,f],[0,0,g]].map(v=>new Vector3().addScaledVector(jac[0],v[0]).addScaledVector(jac[1],v[1]).addScaledVector(jac[2],v[2]).multiplyScalar(1.8));
    dir.set(0,0,0).setComponent(m.dir>>1,m.dir&1?1:-1);bendDirection(flat[0],flat[1],flat[2],dir,normal);
    const at=out*24;records.set([p.x,p.y,p.z,.995],at);
    for(let i=0;i<3;i++)records.set([axes[i].x,axes[i].y,axes[i].z,0],at+4+i*4);
    records.set([normal.x,normal.y,normal.z,m.emission],at+16);records.set([...m.rgb.map(v=>v/m.w/255),si],at+20);
    sourceIds[out]=si;radii[out]=3*Math.sqrt(axes.reduce((s,v)=>s+v.lengthSq(),0));out++;
  }
  return {records,sourceIds,radii,count,budget,levels:Array.from(levels),budgetMet:count<=budget,bytes:records.byteLength+count*4};
}

/** Stable 24-bit depth radix ordering; positive camera depth, far to near. */
export function radixDepthOrder(ids:Uint32Array, scratch:Uint32Array, keys:Uint32Array, count:number, bins:Uint32Array) {
  let src=ids,dst=scratch;
  for(let shift=0;shift<24;shift+=8){bins.fill(0);for(let i=0;i<count;i++)bins[(keys[src[i]]>>>shift)&255]++;
    let offset=0;for(let i=0;i<256;i++){const size=bins[i];bins[i]=offset;offset+=size;}
    for(let i=0;i<count;i++){const id=src[i];dst[bins[(keys[id]>>>shift)&255]++]=id;}[src,dst]=[dst,src];}
  for(let i=0;i<count;i++)ids[i]=src[count-1-i];
}
