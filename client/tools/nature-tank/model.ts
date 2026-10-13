import type { PortableComponent, PortableEntity, PortableBlockSet } from '../../../engine/src/storage/InventoryTypes.ts';
import { Grid } from './grid.ts';
import { suspensionScript } from './controller.ts';
import { createTracks, parkedLength, wheelZ } from './tracks.ts';

export const anchor = [6491,26.875,623] as const;
export const courseOrigin = [6487,24,615] as const;
export function createCourse(): PortableBlockSet {
  const blocks: PortableBlockSet['blocks'] = [];
  for(let x=0;x<8;x++) for(let z=0;z<40;z++) {
    const border=x===0||x===7;
    blocks.push({dx:x,dy:0,dz:z,color:border?(z%2===0?0xdbb34c:0x303937):0x65716d});
    if(z>=19&&z<=21) blocks.push({dx:x,dy:1,dz:z,color:(x+z)%2?0xd78b32:0xe2b75a});
  }
  return {type:'space-blockset',version:8,name:'Tank proving ground | 1m vertical step',blocks};
}

export function createTank(): PortableEntity {
  const hull=new Grid(), olive=0x798468, dark=0x485443, trim=0xa2a588, rubber=0x252b2b;
  hull.shape([-1.5,-.25,-3.5],[1.5,1.0,3.5],(x,y,z)=>
    Math.abs(x)<1.5-Math.max(0,y-.3)*.3 && z<3.5-Math.max(0,y)*.6,
    (x,y,z)=>y<.05?dark:Math.abs(x)>1.25&&Math.floor(z*1.5)%4===0?trim:olive);
  hull.box([0,1.0,-.1],[2.375,.375,3.5],dark);
  hull.shape([-1.1,1.125,-1.4],[1.1,2.0,1.5],(x,y,z)=>
    Math.abs(x)<1.1-(y-1.125)*.3 && z<1.5-(y-1.125)*.4,olive);
  hull.ellipsoid([-.375,2.0,-.375],[.45,.15,.45],dark);
  hull.box([.65,2.0,.4],[.25,.25,.5],0x273a3d);
  hull.box([.8,2.4,-.8],[.125,1.25,.125],rubber);
  // Open commander's driving position, facing the barrel (+Z).
  hull.box([0,2.1875,-.5],[.75,.125,.75],rubber);
  hull.box([0,2.5,-.95],[.75,.625,.125],dark);
  for(const side of [-1,1]) {
    hull.box([side*1.625,.5,0],[.375,.25,6.75],dark);
    hull.box([side*1.05,.4,3.15],[.25,.25,.125],0xffe6af,0,1);
    hull.box([side*1.15,.4,-3.5],[.25,.125,.125],0xd74b38,0,1);
    hull.box([side*.7,.65,-3.6],[.875,.5,.375],dark);
  }
  for(let z=-3;z<=-1.75;z+=.25) hull.box([0,1.0625,z],[1.5,.125,.125],rubber);
  const root: PortableComponent={id:'hull',name:'TERRA-8 | Tracked Tank',pivot:[0,0,0],
    body:{type:'dynamic',mass:3500,useGravity:true,collisionEnabled:true,friction:.4,restitution:0},
    blocks:hull.blocks(),children:[],seats:[],decorations:createTracks(),scriptLanguage:'assemblyscript',script:suspensionScript};
  for(let i=0;i<8;i++) {
    const grid=new Grid(),side=i<4?-1:1,z=wheelZ[i%4];
    grid.shape([-.3,-.875,-.875],[.3,.875,.875],(_x,y,pz)=>y*y+pz*pz<=.875**2,
      (_x,y,pz)=>Math.floor((Math.atan2(y,pz)+Math.PI)*10)%3===0?0x3c4542:rubber);
    for(const face of [-1,1]) {
      grid.shape([face*.3-.065,-.5,-.5],[face*.3+.065,.5,.5],(_x,y,pz)=>y*y+pz*pz<=.25,trim);
      grid.box([face*.375,0,0],[.125,.25,.25],dark);
      for(let a=0;a<6;a++) grid.box([face*.375,.32*Math.sin(a*Math.PI/3),.32*Math.cos(a*Math.PI/3)],[.125,.125,.125],rubber);
    }
    root.children.push({id:'wheel_'+i,name:'Independent suspension wheel '+(i+1),pivot:[0,0,0],
      localPosition:[side*1.875,-parkedLength,z],body:{type:'kinematic',mass:30,useGravity:false,collisionEnabled:false},
      blocks:grid.blocks(),children:[],seats:[],decorations:[]});
  }
  // Keep the long visual barrel out of the dynamic hull's inertia bounds.
  const barrel=new Grid();
  barrel.box([0,0,0],[.25,.25,5.0],dark);
  barrel.box([0,0,2.75],[.5,.5,.5],rubber);
  barrel.box([0,0,3.0625],[.25,.25,.125],0x101717);
  root.children.push({id:'barrel',name:'Turret barrel',pivot:[0,0,0],localPosition:[0,1.625,3.875],
    body:{type:'kinematic',mass:10,useGravity:false,collisionEnabled:false},
    blocks:barrel.blocks(),children:[],seats:[],decorations:[]});
  // Dynamic root transforms and force lever arms use the engine's flat-storage
  // bounding center. Align the authored root and all child mount frames to it.
  const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
  for(const node of [root,...root.children]) for(const b of node.blocks) {
    const p=[b.dx+(b.mx||0)/8,b.dy+(b.my||0)/8,b.dz+(b.mz||0)/8],s=b.size||1;
    for(let i=0;i<3;i++){lo[i]=Math.min(lo[i],p[i]);hi[i]=Math.max(hi[i],p[i]+s);}
  }
  root.pivot=lo.map((v,i)=>(v+hi[i])/2);
  for(const child of root.children) child.localPosition=child.localPosition!.map((v,i)=>v-root.pivot![i]);
  root.seats=[{position:[-root.pivot[0],2.25-.567-root.pivot[1],-.5-root.pivot[2]],
    rotation:[0,1,0,0],fixedOrientation:true}];
  return {type:'space-entity',version:8,root,constraints:[]};
}
