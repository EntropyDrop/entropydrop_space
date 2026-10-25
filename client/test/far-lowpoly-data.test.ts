import test from 'node:test';
import assert from 'node:assert/strict';
import { meshBrick, simplifyMesh, compact, corners, MeshoptSimplifier, type Brick } from '../src/dev/FarLowPolyData.ts';

const brick=(quads:Brick['quads']):Brick=>({key:'0,0,0',origin:[0,0,0],bounds:[0,0,0,64,64,64],quads});
// Inspect all open edges independently of the implementation's brick locks.
function openEdges(positions:Float32Array,indices:Uint32Array,stride:number) {
  const counts=new Map<string,number>();
  for(let i=0;i<indices.length;i+=3)for(let j=0;j<3;j++){
    const a=indices[i+j]*stride,b=indices[i+(j+1)%3]*stride;
    const ends=[positions.subarray(a,a+3).join(','),positions.subarray(b,b+3).join(',')].sort();
    const key=ends.join('/');counts.set(key,(counts.get(key)??0)+1);
  }
  return [...counts].filter(([,count])=>count===1).map(([key])=>key).sort();
}
test('greedy T junctions receive matching edge vertices without degenerate triangles',()=>{
  const b=brick([[1,4,1,4,4,3,0xff445566],[5,4,1,2,2,3,0xff445566]]);
  const raw=meshBrick(b,false),prepared=meshBrick(b,true);
  assert.ok(prepared.indices.length>raw.indices.length);
  for(let i=0;i<prepared.indices.length;i+=3)assert.equal(new Set(prepared.indices.subarray(i,i+3)).size,3);
  for(const q of b.quads)assert.equal(corners(q).length,4);
});
test('compact mesh preserves every indexed vertex and packed color',async()=>{
  await MeshoptSimplifier.ready;
  const mesh=meshBrick(brick([[1,4,1,4,4,3,0xff445566],[5,4,1,2,2,3,0xff445566]]),false),packed=compact(mesh);
  const positions=new Float32Array(packed.vertices.buffer),colors=new Uint32Array(packed.vertices.buffer);
  for(let i=0;i<mesh.indices.length;i++){
    const a=mesh.indices[i],b=packed.indices[i];
    for(let d=0;d<3;d++)assert.equal(positions[b*4+d],mesh.positions[a*3+d]);
    assert.equal(colors[b*4+3],mesh.colors[a]);
  }
});
test('simplification reduces a curved patch while preserving open boundary edges',async()=>{
  await MeshoptSimplifier.ready;
  const quads:Brick['quads']=[];
  for(let x=8;x<24;x++)for(let z=8;z<24;z++)quads.push([x,4,z,1,1,3,0xff556677]);
  const mesh=meshBrick(brick(quads),true),part=simplifyMesh(mesh,.5);
  assert.ok(part.indices.length<mesh.indices.length);
  assert.equal(part.seamFallback,false);
  const boundary=openEdges(mesh.positions,mesh.indices,3);
  assert.equal(boundary.length,64);
  assert.deepEqual(openEdges(new Float32Array(part.vertices.buffer),part.indices,4),boundary);
  assert.ok([...part.indices].every(i=>i<part.vertices.byteLength/16));
});

test('brick boundary positions remain present after simplification',async()=>{
  await MeshoptSimplifier.ready;
  const quads:Brick['quads']=[];
  for(let x=0;x<64;x+=4)for(let z=0;z<64;z+=4)quads.push([x,12,z,4,4,3,0xff556677]);
  const mesh=meshBrick(brick(quads),true),part=simplifyMesh(mesh,2),positions=new Float32Array(part.vertices.buffer);
  const retained=new Set<string>();
  for(let i=0;i<positions.length;i+=4)retained.add([...positions.subarray(i,i+3)].join(','));
  for(let i=0;i<mesh.locked.length;i++)if(mesh.locked[i])assert.ok(retained.has([...mesh.positions.subarray(i*3,i*3+3)].join(',')));
});
