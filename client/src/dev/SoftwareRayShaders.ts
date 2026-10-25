/** WGSL for three software visibility experiments and their shared raster control. */
export const common = /* wgsl */`
struct Face { a:vec4<f32>, b:vec4<f32>, c:vec4<f32>, d:vec4<f32> }
struct Node { lo:vec3<f32>, escape:u32, hi:vec3<f32>, count:u32,
  flo:vec3<f32>, start:u32, fhi:vec3<f32>, aux:u32 }
struct Params { vp:mat4x4<f32>, inverse:mat4x4<f32>, camera:vec4<f32>, size:vec4<f32>, controls:vec4<f32> }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> faces:array<Face>;
@group(0) @binding(2) var<storage,read> nodes:array<Node>;
@group(0) @binding(3) var<storage,read> ids:array<u32>;
@group(0) @binding(4) var<storage,read> fields:array<u32>;
@group(0) @binding(5) var output:texture_storage_2d<rgba32float,write>;
@group(0) @binding(6) var<storage,read_write> counters:array<atomic<u32>>;
fn shade(f:Face)->vec3<f32> {
  let n=normalize(cross(f.b.xyz-f.a.xyz,f.c.xyz-f.a.xyz));
  let light=.45+.55*abs(dot(n,normalize(vec3<f32>(.4,.8,.3))));
  return unpack4x8unorm(bitcast<u32>(f.a.w)).xyz*light;
}
fn slab(o:vec3<f32>,inv:vec3<f32>,lo:vec3<f32>,hi:vec3<f32>,end:f32)->vec2<f32>{
  let a=(lo-o)*inv;let b=(hi-o)*inv;let v=min(a,b);let w=max(a,b);
  return vec2<f32>(max(.01,max(v.x,max(v.y,v.z))),min(end,min(w.x,min(w.y,w.z))));
}
fn triangle(o:vec3<f32>,d:vec3<f32>,a:vec3<f32>,b:vec3<f32>,c:vec3<f32>)->f32{
  let e1=b-a;let e2=c-a;let h=cross(d,e2);let det=dot(e1,h);
  if(det<=1e-8){return 1e20;}let s=o-a;let u=dot(s,h)/det;
  if(u<0.||u>1.){return 1e20;}let q=cross(s,e1);let v=dot(d,q)/det;
  if(v<0.||u+v>1.){return 1e20;}let t=dot(e2,q)/det;
  return select(1e20,t,t>.01);
}
fn faceHit(o:vec3<f32>,d:vec3<f32>,f:Face)->f32{
  return min(triangle(o,d,f.a.xyz,f.b.xyz,f.c.xyz),triangle(o,d,f.a.xyz,f.c.xyz,f.d.xyz));
}
fn unbend(b:vec3<f32>,anchor:vec3<f32>)->vec3<f32>{
  let R=2607.5945876176133;let r=325.94932345220167;
  let radial=length(b.xz);let v=radial-R;let rho=length(vec2<f32>(v,b.y));
  let phi=atan2(b.y,v);let theta=atan2(b.z,b.x);
  let tube=2.*atan2(sqrt(7./9.)*sin(phi*.5),cos(phi*.5));
  var x=theta*R;var z=tube*r;
  x+=round((anchor.x-x)/16384.)*16384.;z+=round((anchor.z-z)/2048.)*2048.;
  return vec3<f32>(x,(rho-r)/(1.+.125*cos(phi))+16.,z);
}
fn boxDistance(q:vec3<f32>,lo:vec3<f32>,hi:vec3<f32>)->f32{
  return length(max(max(lo-q,q-hi),vec3<f32>(0.)));
}
// Nonlinear, local unsigned distance-bound tracing. The field is conservative
// in its flat chart; 1/8 scaling and inflated occupancy guard deformation.
// It is an empirical prototype, not a certified global deformation bound.
fn fieldSkip(o:vec3<f32>,d:vec3<f32>,n:Node,range:vec2<f32>)->vec2<u32>{
  var t=range.x;let anchor=(n.flo+n.fhi)*.5;let cell=(n.fhi-n.flo)/8.;
  for(var step=0u;step<64u;step++){
    if(t>range.y){return vec2<u32>(1u,step);}
    let q=unbend(o+d*t,anchor);var distance=boxDistance(q,n.flo,n.fhi);
    if(distance<.001){
      let c=vec3<u32>(clamp(floor((q-n.flo)/cell),vec3<f32>(0.),vec3<f32>(7.)));
      let index=c.x+8u*(c.y+8u*c.z);
      let v=(fields[n.aux-1u+(index>>3u)]>>((index&7u)*4u))&15u;
      distance=max(0.,f32(v)-1.)*min(cell.x,min(cell.y,cell.z));
    }
    if(distance<.02){return vec2<u32>(0u,step+1u);}
    t+=distance*.125;
  }
  return vec2<u32>(2u,64u); // Explicit exact fallback, never an unreported miss.
}
`;

export function computeShader(mode:'bvh'|'brick'|'sdf') {return common+/* wgsl */`
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) pixel:vec3<u32>){
  if(pixel.x>=u32(p.size.x)||pixel.y>=u32(p.size.y)){return;}
  let uv=(vec2<f32>(pixel.xy)+.5)/p.size.xy;
  let direction=p.inverse*vec4<f32>((uv.x*2.-1.)*p.controls.y*p.controls.z,(1.-uv.y*2.)*p.controls.y,-1.,0.);
  let o=p.camera.xyz;let d=normalize(direction.xyz);
  let inv=1./select(d,vec3<f32>(1e-20),abs(d)<vec3<f32>(1e-20));
  var closest=p.size.z;var hit=0xffffffffu;var visits=0u;var tests=0u;var steps=0u;var fallbacks=0u;var skipped=0u;
  ${mode==='bvh'?/* wgsl */`
  var stack:array<u32,64>;var top=1u;stack[0]=0u;
  while(top>0u){
    top--;let ni=stack[top];let n=nodes[ni];visits++;
    let r=slab(o,inv,n.lo,n.hi,closest);if(r.x>r.y){continue;}
    if(n.count>0u){
      for(var j=0u;j<n.count;j++){let id=ids[n.start+j];tests++;let t=faceHit(o,d,faces[id]);if(t<closest){closest=t;hit=id;}}
    }else{
      let a=nodes[ni+1u];let b=nodes[n.aux];let ra=slab(o,inv,a.lo,a.hi,closest);let rb=slab(o,inv,b.lo,b.hi,closest);
      if(top+2u>64u){textureStore(output,vec2<i32>(pixel.xy),vec4<f32>(10.,0.,10.,1.));return;}
      if(ra.x<rb.x){if(rb.x<=rb.y){stack[top]=n.aux;top++;}if(ra.x<=ra.y){stack[top]=ni+1u;top++;}}
      else{if(ra.x<=ra.y){stack[top]=ni+1u;top++;}if(rb.x<=rb.y){stack[top]=n.aux;top++;}}
    }
  }
  `:/* wgsl */`
  var ni=0u;let end=nodes[0].escape;
  while(ni<end){let n=nodes[ni];visits++;let r=slab(o,inv,n.lo,n.hi,closest);
    if(r.x>r.y){ni=n.escape;continue;}
    ${mode==='sdf'?`if(n.aux>0u){let result=fieldSkip(o,d,n,r);steps+=result.y;if(result.x==1u){skipped++;ni=n.escape;continue;}if(result.x==2u){fallbacks++;}}`:''}
    if(n.count>0u){
      for(var j=0u;j<n.count;j++){let id=ids[n.start+j];tests++;let t=faceHit(o,d,faces[id]);if(t<closest){closest=t;hit=id;}}
    }
    ni++;
  }
  `}
  var color=vec3<f32>(.025,.04,.065);var depth=1.;
  if(hit!=0xffffffffu){color=shade(faces[hit]);let clip=p.vp*vec4<f32>(d*closest,1.);depth=clip.z/clip.w;}
  textureStore(output,vec2<i32>(pixel.xy),vec4<f32>(color,depth));
  if(p.controls.x>0.){atomicAdd(&counters[0],visits);atomicAdd(&counters[1],tests);atomicAdd(&counters[2],steps);
    atomicAdd(&counters[3],fallbacks);atomicAdd(&counters[4],skipped);atomicAdd(&counters[5],select(0u,1u,hit!=0xffffffffu));}
}
`;}

export const rasterShader=common+/* wgsl */`
struct Vertex { @builtin(position) position:vec4<f32>, @location(0) @interpolate(flat) face:u32 }
@vertex fn vs(@builtin(vertex_index) vertex:u32)->Vertex{
  let id=ids[vertex/6u];let f=faces[id];let corner=array<u32,6>(0u,1u,2u,0u,2u,3u)[vertex%6u];
  let v=array<vec4<f32>,4>(f.a,f.b,f.c,f.d)[corner];
  var out:Vertex;out.position=p.vp*vec4<f32>(v.xyz-p.camera.xyz,1.);out.face=id;return out;
}
@fragment fn fs(in:Vertex)->@location(0) vec4<f32>{return vec4<f32>(shade(faces[in.face]),in.position.z);}
`;

export const presentShader=/* wgsl */`
@group(0) @binding(0) var source:texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{
  let v=array<vec2<f32>,3>(vec2<f32>(-1.,-1.),vec2<f32>(3.,-1.),vec2<f32>(-1.,3.));return vec4<f32>(v[i],0.,1.);}
@fragment fn fs(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32>{
  let rgb=textureLoad(source,vec2<i32>(p.xy),0).xyz;return vec4<f32>(pow(rgb,vec3<f32>(1./2.2)),1.);}
`;
