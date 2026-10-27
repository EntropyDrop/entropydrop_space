/** Stable three-dispatch compaction: no cross-workgroup spin waits or readback. */
export const visibilityGpuShader = /* wgsl */`
struct Params { camera:vec4<f32>, planes:array<vec4<f32>,6>, counts:vec4<u32> };
struct Meta { sphere:vec4<f32>, cone:vec4<f32>, valid:vec4<f32> };
struct Scratch { local:u32, count:u32, offset:u32, total:u32 };
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> inputMap:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read> boundsData:array<Meta>;
@group(0) @binding(3) var<storage,read> groups:array<vec4<u32>>;
@group(0) @binding(4) var<storage,read> runs:array<vec4<u32>>;
@group(0) @binding(5) var<storage,read_write> scratch:array<Scratch>;
@group(0) @binding(6) var<storage,read_write> outputMap:array<vec4<f32>>;
@group(0) @binding(7) var<storage,read_write> indirect:array<u32>;
var<workgroup> scan:array<u32,256>;
fn visible(block:u32)->bool {
  if(p.counts.w==0u){return true;}
  // Masked handoff blocks retain the existing CPU coverage and culling result.
  if(inputMap[block*2u+1u].y==0.0){return true;}
  let m=boundsData[u32(inputMap[block*2u].x)/16u];
  if(m.valid.x==0.0){return true;}
  if(p.counts.z==1u){return false;}
  let delta=p.camera.xyz-m.sphere.xyz;let distance=length(delta);let radius=m.sphere.w;
  if(distance-radius<=274.0){return true;}
  // Conservative slack accounts for Float32 versus the CPU Float64 reference.
  let epsilon=0.002+distance*0.000002;
  if(dot(m.cone.xyz,delta)+distance*m.cone.w+radius+18.0 < -epsilon){return false;}
  let limit=-radius-18.0-distance*0.061-epsilon;
  for(var i=0u;i<6u;i++){if(dot(p.planes[i].xyz,m.sphere.xyz)+p.planes[i].w<limit){return false;}}
  return true;
}
@compute @workgroup_size(256) fn classify(@builtin(workgroup_id) wid:vec3<u32>,@builtin(local_invocation_id) lid:vec3<u32>){
  let g=groups[wid.x];let block=g.x+lid.x;let live=lid.x<g.y && visible(block);
  scan[lid.x]=select(0u,1u,live);workgroupBarrier();
  for(var offset=1u;offset<256u;offset*=2u){
    var add=0u;if(lid.x>=offset){add=scan[lid.x-offset];}workgroupBarrier();
    scan[lid.x]+=add;workgroupBarrier();
  }
  if(lid.x<g.y){scratch[block].local=select(0xffffffffu,scan[lid.x]-1u,live);}
  if(lid.x==255u){scratch[wid.x].count=scan[255u];}
}
@compute @workgroup_size(64) fn prefix(@builtin(global_invocation_id) id:vec3<u32>){
  if(id.x>=p.counts.y){return;}let r=runs[id.x];var total=0u;
  for(var i=0u;i<r.w;i++){let group=r.z+i;scratch[group].offset=total;total+=scratch[group].count;}
  scratch[id.x].total=total;let a=id.x*5u;
  indirect[a]=192u;indirect[a+1u]=(total+1u)/2u;indirect[a+2u]=0u;indirect[a+3u]=0u;indirect[a+4u]=0u;
}
@compute @workgroup_size(256) fn scatter(@builtin(workgroup_id) wid:vec3<u32>,@builtin(local_invocation_id) lid:vec3<u32>){
  let g=groups[wid.x];if(lid.x>=g.y){return;}let block=g.x+lid.x;let rank=scratch[block].local;
  if(rank==0xffffffffu){return;}let r=runs[g.z];let dst=scratch[wid.x].offset+rank;
  outputMap[(r.x+dst)*2u]=inputMap[block*2u];outputMap[(r.x+dst)*2u+1u]=inputMap[block*2u+1u];
  let total=scratch[g.z].total;
  // Original batches draw 32 faces per instance / 16 per visibility block.
  // Duplicate the last opaque block for odd compacted counts, inside this run.
  // At full capacity the original bounded-face shader already handles the tail.
  if((total&1u)==1u && dst==total-1u && total<r.y){
    outputMap[(r.x+dst+1u)*2u]=inputMap[block*2u];outputMap[(r.x+dst+1u)*2u+1u]=inputMap[block*2u+1u];
  }
}
`;
