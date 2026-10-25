/** Offline research data. No production renderer imports this module. */
import { Vector3 } from 'three/webgpu';
import { bendTorusPoint } from '@entropydrop/space-engine/torus/TorusWorld.ts';

export type RayData = { bent: Float32Array; flat: Float32Array; count: number; snapshotMs: number; omittedNear: number };
export type RayTree = { nodes: Float32Array; ids: Uint32Array; fields: Uint32Array; buildMs: number; leaves: number; maxDepth: number };
type Bounds = number[];
const empty = () => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
function include(out: Bounds, b: ArrayLike<number>, at = 0) {
  for (let d = 0; d < 3; d++) { out[d] = Math.min(out[d], b[at+d]); out[d+3] = Math.max(out[d+3], b[at+d+3]); }
}

/** Immutable settled Arena records; keep geometry outside the camera correction.
 * Snapshot includes all directions, not just the current view's visibility map. */
export function snapshotFar(game: any, minDistance = 320): RayData {
  const started = performance.now(), arena = game.world.distantSurface.voxels.arena;
  if (!arena?.stats.residentFaces || arena.hasPendingWork) throw new Error('Wait for resident far geometry.');
  const capacity = arena.stats.residentFaces, bent = new Float32Array(capacity * 16), flat = new Float32Array(capacity * 6);
  const colors = new Uint32Array(bent.buffer), camera = bendTorusPoint(...game.playerPhysics.position.toArray() as [number, number, number]);
  const p = new Vector3(), corners: number[] = [], bounds = empty(); let count = 0, omittedNear = 0;
  for (const page of arena.pages) for (const entry of page.entries) {
    if (entry.copied !== entry.count) throw new Error('Incomplete Arena source.');
    const data = page.data.array as Uint32Array, o = entry.origin;
    for (let i = 0; i < entry.count; i++) {
      const at = (entry.start+i)*4, a=data[at], b=data[at+1], c=data[at+2];
      const x=o.x+(a&65535)*.125, y=o.y+(a>>>16)*.125, z=o.z+(b&65535)*.125;
      const su=(b>>>16)*.125, sv=(c&65535)*.125, dir=(c>>>16)&255;
      bounds.splice(0, 6, ...empty()); corners.length=0;
      let nearest=Infinity;
      for (let j=0;j<4;j++) {
        let u=j===1||j===2?1:0; const v=j>=2?1:0; if (!(dir&1)) u=1-u;
        const q=dir<2?[x,y+u*su,z+v*sv]:dir<4?[x+v*sv,y,z+u*su]:[x+u*su,y+v*sv,z];
        for(let d=0;d<3;d++){bounds[d]=Math.min(bounds[d],q[d]);bounds[d+3]=Math.max(bounds[d+3],q[d]);}
        bendTorusPoint(q[0],q[1],q[2],p); nearest=Math.min(nearest,p.distanceTo(camera));
        corners.push(p.x,p.y,p.z,0);
      }
      // Every point of a triangle lies within its longest edge of a corner.
      if(nearest-Math.hypot(su,sv)*2<minDistance){omittedNear++;continue;}
      bent.set(corners,count*16); colors[count*16+3]=data[at+3];
      flat.set(bounds,count*6); count++;
    }
  }
  return {bent:bent.slice(0,count*16),flat:flat.slice(0,count*6),count,snapshotMs:performance.now()-started,omittedNear};
}

export function faceBounds(data: RayData) {
  const out=new Float32Array(data.count*6);
  for(let i=0;i<data.count;i++)for(let d=0;d<3;d++){
    let lo=Infinity,hi=-Infinity;
    for(let c=0;c<4;c++){const v=data.bent[i*16+c*4+d];lo=Math.min(lo,v);hi=Math.max(hi,v);}
    out[i*6+d]=lo-.002;out[i*6+d+3]=hi+.002;
  }
  return out;
}
function area(b: Bounds) {const x=b[3]-b[0],y=b[4]-b[1],z=b[5]-b[2];return 2*(x*y+x*z+y*z);}
/** 64-byte threaded node. Escape supports stackless wide traversal; 'field' is
 * the binary right child or the brick distance-field offset. */
function pack(rows: number[][], ids: Uint32Array, fields: Uint32Array, started: number, leaves: number, maxDepth: number): RayTree {
  const nodes=new Float32Array(rows.length*16), u=new Uint32Array(nodes.buffer);
  rows.forEach((r,i)=>{nodes.set(r,i*16);for(const k of [3,7,11,15])u[i*16+k]=r[k];});
  return {nodes,ids,fields,buildMs:performance.now()-started,leaves,maxDepth};
}

/** Binned SAH over bent quads, eight faces per leaf, with a median fallback. */
export function buildFaceBvh(data: RayData): RayTree {
  const started=performance.now(), bounds=faceBounds(data), ids=Uint32Array.from({length:data.count},(_,i)=>i), rows:number[][]=[];
  let leaves=0,maxDepth=0;
  function build(start:number,end:number,depth:number):number {
    maxDepth=Math.max(maxDepth,depth); const b=empty(), f=empty(), cb=empty(), index=rows.length;
    for(let j=start;j<end;j++){const id=ids[j],at=id*6;include(b,bounds,at);include(f,data.flat,at);
      for(let d=0;d<3;d++){const c=(bounds[at+d]+bounds[at+d+3])*.5;cb[d]=Math.min(cb[d],c);cb[d+3]=Math.max(cb[d+3],c);}}
    rows.push([b[0],b[1],b[2],0,b[3],b[4],b[5],0,f[0],f[1],f[2],start,f[3],f[4],f[5],0]);
    if(end-start<=8||depth>=48){rows[index][7]=end-start;leaves++;}
    else {
      let best=Infinity,axis=0,cut=0;
      for(let d=0;d<3;d++){
        const extent=cb[d+3]-cb[d];if(extent<1e-6)continue;
        const bs=Array.from({length:12},empty),counts=new Uint32Array(12);
        for(let j=start;j<end;j++){const at=ids[j]*6,c=(bounds[at+d]+bounds[at+d+3])*.5;
          const bin=Math.min(11,Math.floor((c-cb[d])*12/extent));counts[bin]++;include(bs[bin],bounds,at);}
        const lb=empty(),leftArea:number[]=[],leftCount:number[]=[];let n=0;
        for(let k=0;k<11;k++){if(counts[k])include(lb,bs[k]);n+=counts[k];leftArea.push(n?area(lb):0);leftCount.push(n);}
        const rb=empty();n=0;
        for(let k=11;k>0;k--){if(counts[k])include(rb,bs[k]);n+=counts[k];const cost=leftArea[k-1]*leftCount[k-1]+(n?area(rb)*n:0);
          if(n&&leftCount[k-1]&&cost<best){best=cost;axis=d;cut=cb[d]+extent*k/12;}}
      }
      let middle=start;
      if(Number.isFinite(best))for(let j=start;j<end;j++){const at=ids[j]*6;if((bounds[at+axis]+bounds[at+axis+3])*.5<cut){const t=ids[j];ids[j]=ids[middle];ids[middle++]=t;}}
      if(middle===start||middle===end)middle=(start+end)>>>1;
      build(start,middle,depth+1);rows[index][15]=build(middle,end,depth+1);
    }
    rows[index][3]=rows.length;return index;
  }
  if(data.count)build(0,data.count,0);
  return pack(rows,ids,new Uint32Array(1),started,leaves,maxDepth);
}

/** Chebyshev distance to occupied grid cells. Its metric underestimates Euclidean
 * distance, so (value-1)*smallestCellEdge is a lower bound anywhere in a cell. */
export function brickDistances(occupied: Uint8Array, size=8) {
  const dist=new Uint32Array(occupied.length).fill(0xffff), queue=new Uint32Array(occupied.length);let head=0,tail=0;
  for(let i=0;i<occupied.length;i++)if(occupied[i]){dist[i]=0;queue[tail++]=i;}
  while(head<tail){const i=queue[head++],x=i%size,y=Math.floor(i/size)%size,z=Math.floor(i/(size*size));
    for(let dz=-1;dz<=1;dz++)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const a=x+dx,b=y+dy,c=z+dz;if(a<0||b<0||c<0||a>=size||b>=size||c>=size)continue;
      const j=a+size*(b+size*c);if(dist[j]>dist[i]+1){dist[j]=dist[i]+1;queue[tail++]=j;}}
  }
  return dist;
}

/** Sparse 4x4x4 hierarchy in flat space. Bounds are unions of actual bent
 * triangles, so a straight ray traverses a curved grid without a wrong flat DDA.
 * Leaves are 32m bricks holding compact references to the same rendered faces. */
export function buildBrickTree(data: RayData, makeFields=true): RayTree {
  const started=performance.now(), bounds=faceBounds(data), groups=new Map<string,{xyz:number[];ids:number[]}>();
  for(let i=0;i<data.count;i++){const xyz=[0,1,2].map(d=>Math.floor((data.flat[i*6+d]+data.flat[i*6+d+3])*.5/32));
    const key=xyz.join(',');let g=groups.get(key);if(!g){g={xyz,ids:[]};groups.set(key,g);}g.ids.push(i);}
  const rows:number[][]=[], order:number[]=[], fields:number[]=[], all=[...groups.values()];let leaves=0,maxDepth=0;
  function detail(ids:number[],span:number,depth:number):number {
    maxDepth=Math.max(maxDepth,depth);const index=rows.length,b=empty(),f=empty();
    for(const id of ids){include(b,bounds,id*6);include(f,data.flat,id*6);}
    rows.push([b[0],b[1],b[2],0,b[3],b[4],b[5],0,f[0],f[1],f[2],order.length,f[3],f[4],f[5],0]);
    if(ids.length<=16||span<.125){rows[index][7]=ids.length;order.push(...ids);leaves++;}
    else {const children=new Map<string,number[]>();for(const id of ids){const key=[0,1,2].map(d=>Math.floor((data.flat[id*6+d]+data.flat[id*6+d+3])*.5/span)).join(',');let list=children.get(key);if(!list){list=[];children.set(key,list);}list.push(id);}
      for(const list of children.values())detail(list,span/4,depth+1);}
    rows[index][3]=rows.length;return index;
  }
  function build(gs:typeof all,scale:number,depth:number):number {
    maxDepth=Math.max(maxDepth,depth);const index=rows.length,b=empty(),f=empty();
    for(const g of gs)for(const id of g.ids){include(b,bounds,id*6);include(f,data.flat,id*6);}
    rows.push([b[0],b[1],b[2],0,b[3],b[4],b[5],0,f[0],f[1],f[2],order.length,f[3],f[4],f[5],0]);
    if(gs.length===1||scale<1){
      const ids=gs.flatMap(g=>g.ids);rows[index][15]=makeFields?fields.length+1:0;
      if(makeFields){
        // A deliberately generous chord/deformation allowance. This is an
        // experimental bound, verified against triangles, not a general proof.
        const pad=Math.max(.04,Math.max(...ids.map(id=>{const a=id*6;return ((data.flat[a+3]-data.flat[a])**2+(data.flat[a+4]-data.flat[a+1])**2+(data.flat[a+5]-data.flat[a+2])**2)/200;})));
        // Thin surface bounds otherwise make the minimum cell edge nearly
        // zero, defeating empty-space steps along the other two axes.
        const side=Math.max(32,...[0,1,2].map(d=>f[d+3]-f[d]+2*pad));
        for(let d=0;d<3;d++){const center=(f[d]+f[d+3])*.5;f[d]=center-side*.5;f[d+3]=center+side*.5;rows[index][8+d]=f[d];rows[index][12+d]=f[d+3];}
        const occupied=new Uint8Array(512), step=[0,1,2].map(d=>(f[d+3]-f[d])/8);
        for(const id of ids){const a=id*6,lo=[0,1,2].map(d=>Math.max(0,Math.floor((data.flat[a+d]-pad-f[d])/step[d]))),
          hi=[0,1,2].map(d=>Math.min(7,Math.floor((data.flat[a+d+3]+pad-f[d])/step[d])));
          for(let z=lo[2];z<=hi[2];z++)for(let y=lo[1];y<=hi[1];y++)for(let x=lo[0];x<=hi[0];x++)occupied[x+8*(y+8*z)]=1;}
        const dist=brickDistances(occupied);
        for(let k=0;k<512;k+=8){let word=0;for(let j=0;j<8;j++)word|=Math.min(15,dist[k+j])<<(j*4);fields.push(word>>>0);}
      }
      if(ids.length<=32){rows[index][7]=ids.length;order.push(...ids);leaves++;}else detail(ids,8,depth+1);
    } else {
      const children=new Map<string,typeof all>();for(const g of gs){const key=g.xyz.map(v=>Math.floor(v/scale)).join(',');let list=children.get(key);if(!list){list=[];children.set(key,list);}list.push(g);}
      for(const list of children.values())build(list,scale/4,depth+1);
    }
    rows[index][3]=rows.length;return index;
  }
  if(all.length)build(all,256,0);
  return pack(rows,Uint32Array.from(order),fields.length?Uint32Array.from(fields):new Uint32Array(1),started,leaves,maxDepth);
}
