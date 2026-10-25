/** Offline mesh simplification research; no production entry imports this. */
import { Vector3 } from 'three';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { bendTorusPoint } from '@entropydrop/space-engine/torus/TorusWorld.ts';

export type Quad = [number, number, number, number, number, number, number];
export type Brick = { key: string; origin: number[]; quads: Quad[]; bounds: number[] };
export type Mesh = { positions: Float32Array; colors: Uint32Array; indices: Uint32Array; locked: Uint8Array };
export type MeshPart = { vertices: Uint8Array; indices: Uint32Array; error: number; seamFallback: boolean };
const blankBounds = () => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
export function corners(q: Quad) {
  const [x,y,z,su,sv,dir] = q;
  return [0,1,2,3].map(j => {
    let u = j===1||j===2 ? 1:0; const v = j>=2 ? 1:0;
    if (!(dir&1)) u=1-u;
    return dir<2 ? [x,y+u*su,z+v*sv] : dir<4 ? [x+v*sv,y,z+u*su] : [x+u*su,y+v*sv,z];
  });
}
export function include(bounds: number[], p: ArrayLike<number>) {
  for(let d=0;d<3;d++){bounds[d]=Math.min(bounds[d],p[d]);bounds[d+3]=Math.max(bounds[d+3],p[d]);}
}
export function distanceToBounds(p: ArrayLike<number>, b: number[]) {
  return Math.hypot(...[0,1,2].map(d=>Math.max(0,b[d]-p[d],p[d]-b[d+3])));
}

/** Whole 64 m bricks are retained/excluded, including their existing caps. */
export function captureFarBricks(game:any, minimumDistance=384) {
  const start=performance.now(), arena=game.world.distantSurface.voxels.arena;
  if(!arena?.stats.residentFaces||arena.hasPendingWork)throw new Error('Wait for settled far geometry.');
  const groups=new Map<string,Brick>(), point=new Vector3();
  for(const page of arena.pages)for(const entry of page.entries){
    if(entry.copied!==entry.count)throw new Error('Incomplete Arena publication.');
    const a=page.data.array as Uint32Array,o=entry.origin;
    for(let i=0;i<entry.count;i++){
      const at=(entry.start+i)*4,dir=(a[at+2]>>>16)&255;
      const q:Quad=[o.x+(a[at]&65535)/8,o.y+(a[at]>>>16)/8,o.z+(a[at+1]&65535)/8,(a[at+1]>>>16)/8,(a[at+2]&65535)/8,dir,a[at+3]];
      const cs=corners(q),axis=dir>>1,sign=(dir&1)?1:-1;
      const origin=[0,1,2].map(d=>Math.floor(((cs[0][d]+cs[2][d])*.5-(d===axis?sign*.001:0))/64)*64);
      const key=origin.join(',');let brick=groups.get(key);
      if(!brick){brick={key,origin,quads:[],bounds:blankBounds()};groups.set(key,brick);}
      brick.quads.push(q);
      for(const c of cs){bendTorusPoint(c[0],c[1],c[2],point);include(brick.bounds,point.toArray());}
    }
  }
  const camera=bendTorusPoint(...game.playerPhysics.position.toArray() as [number,number,number]).toArray();
  const bricks=[...groups.values()].filter(b=>distanceToBounds(camera,b.bounds)>=minimumDistance);
  return {bricks,camera,residentFaces:arena.stats.residentFaces,faces:bricks.reduce((n,b)=>n+b.quads.length,0),captureMs:performance.now()-start,minimumDistance};
}

const pointKey=(p:number[])=>p.join(',');
const lineKey=(axis:number,p:number[])=>`${axis}/${p[(axis+1)%3]}/${p[(axis+2)%3]}`;

/** Weld position/color vertices, optionally split greedy T-junction edges.
 * Inserting true bent vertices changes the original chord surface slightly;
 * the separate prepared-mesh control measures that change explicitly. */
export function meshBrick(brick:Brick, conforming:boolean):Mesh {
  const lines=new Map<string,Set<number>>();
  if(conforming)for(const q of brick.quads)for(const p of corners(q))for(let d=0;d<3;d++){
    const key=lineKey(d,p);let values=lines.get(key);if(!values){values=new Set();lines.set(key,values);}values.add(p[d]);
  }
  const sorted=new Map([...lines].map(([key,set])=>[key,[...set].sort((a,b)=>a-b)]));
  const positions:number[]=[],colors:number[]=[],indices:number[]=[],locked:number[]=[],map=new Map<string,number>(),point=new Vector3();
  function vertex(p:number[],color:number){
    const key=`${pointKey(p)}/${color}`;const prior=map.get(key);if(prior!==undefined)return prior;
    const id=colors.length;map.set(key,id);bendTorusPoint(p[0],p[1],p[2],point);
    positions.push(point.x,point.y,point.z);colors.push(color);
    locked.push(p.some((v,d)=>Math.abs(v-brick.origin[d])<1e-6||Math.abs(v-brick.origin[d]-64)<1e-6)?1:0);
    return id;
  }
  for(const q of brick.quads){const cs=corners(q),polygon:number[]=[];
    for(let j=0;j<4;j++){
      const a=cs[j],b=cs[(j+1)%4];polygon.push(vertex(a,q[6]));
      if(conforming){const axis=a.findIndex((v,d)=>v!==b[d]);if(axis<0)continue;
        let points=(sorted.get(lineKey(axis,a))??[]).filter(v=>v>Math.min(a[axis],b[axis])&&v<Math.max(a[axis],b[axis]));
        if(b[axis]<a[axis])points=points.reverse();
        for(const v of points){const p=[...a];p[axis]=v;polygon.push(vertex(p,q[6]));}
      }
    }
    if(polygon.length===4)indices.push(polygon[0],polygon[1],polygon[2],polygon[0],polygon[2],polygon[3]);
    else {const center=vertex(cs[0].map((v,d)=>(v+cs[2][d])*.5),q[6]);
      for(let j=0;j<polygon.length;j++)indices.push(center,polygon[j],polygon[(j+1)%polygon.length]);}
  }
  return {positions:Float32Array.from(positions),colors:Uint32Array.from(colors),indices:Uint32Array.from(indices),locked:Uint8Array.from(locked)};
}

/** Boundary edge multiset in geometric coordinates, independent of color seams. */
export function boundaryEdges(mesh:Mesh,indices=mesh.indices) {
  const edges=new Map<string,number>();
  for(let i=0;i<indices.length;i+=3)for(let j=0;j<3;j++){
    const a=indices[i+j],b=indices[i+(j+1)%3];if(!mesh.locked[a]||!mesh.locked[b])continue;
    const pa=[...mesh.positions.subarray(a*3,a*3+3)].join(','),pb=[...mesh.positions.subarray(b*3,b*3+3)].join(',');
    const key=pa<pb?`${pa}/${pb}`:`${pb}/${pa}`;edges.set(key,(edges.get(key)??0)+1);
  }
  // Interior triangulation edges cancel; retain the geometric boundary.
  return [...edges].filter(([,n])=>n%2).map(([key])=>key).sort().join(';');
}
export function compact(mesh:Mesh,indices=mesh.indices,error=0,seamFallback=false):MeshPart {
  const copy=indices.slice(),[remap,count]=MeshoptSimplifier.compactMesh(copy);
  const vertices=new Uint8Array(count*16),floats=new Float32Array(vertices.buffer),words=new Uint32Array(vertices.buffer);
  for(let old=0;old<remap.length;old++){const next=remap[old];if(next===0xffffffff)continue;
    floats.set(mesh.positions.subarray(old*3,old*3+3),next*4);words[next*4+3]=mesh.colors[old];}
  return {vertices,indices:copy,error,seamFallback};
}
export function simplifyMesh(mesh:Mesh,error:number):MeshPart {
  const attributes=new Float32Array(mesh.colors.length*3);
  for(let i=0;i<mesh.colors.length;i++)for(let d=0;d<3;d++)attributes[i*3+d]=((mesh.colors[i]>>>(d*8))&255)/255;
  // Permissive allows color seams to collapse, with weighted color error.
  // Do not prune components: floating islands and thin bridges are meaningful.
  const [indices,achieved]=MeshoptSimplifier.simplifyWithAttributes(mesh.indices,mesh.positions,3,attributes,3,[.25,.25,.25],mesh.locked,
    Math.max(3,Math.floor(mesh.indices.length*.08/3)*3),error,['ErrorAbsolute','LockBorder','Permissive']);
  const seamFallback=boundaryEdges(mesh)!==boundaryEdges(mesh,indices);
  return seamFallback?compact(mesh,mesh.indices,0,true):compact(mesh,indices,achieved);
}
export { MeshoptSimplifier };
