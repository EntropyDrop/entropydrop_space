import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFaceBvh, buildBrickTree, brickDistances, type RayData, type RayTree } from '../src/dev/SoftwareRayData.ts';

function fixture():RayData {
  const count=385,bent=new Float32Array(count*16),flat=new Float32Array(count*6);
  for(let i=0;i<count;i++){
    // Deterministic disjoint and coplanar rectangles across multiple hierarchy levels.
    const x=(i%17)*3,z=Math.floor(i/17)*2,y=i%5;
    bent.set([x,y,z,0,x+1,y,z,0,x+1,y,z+1,0,x,y,z+1,0],i*16);
    flat.set([x,y,z,x+1,y,z+1],i*6);
  }
  return {bent,flat,count,snapshotMs:0,omittedNear:0};
}
function audit(tree:RayTree,data:RayData){
  const u=new Uint32Array(tree.nodes.buffer),seen=new Uint8Array(data.count);
  assert.equal(tree.ids.length,data.count);assert.equal(u[3],tree.nodes.length/16);
  for(let n=0;n<tree.nodes.length/16;n++){
    const at=n*16,escape=u[at+3],count=u[at+7],start=u[at+11];assert.ok(escape>n&&escape<=tree.nodes.length/16);
    if(count){for(let j=0;j<count;j++){const id=tree.ids[start+j];assert.ok(id<data.count);seen[id]++;
      for(let k=0;k<4;k++)for(let d=0;d<3;d++)assert.ok(data.bent[id*16+k*4+d]>=tree.nodes[at+d]&&data.bent[id*16+k*4+d]<=tree.nodes[at+4+d]);}}
    else for(let child=n+1;child<escape;child=u[child*16+3])for(let d=0;d<3;d++){
      assert.ok(tree.nodes[child*16+d]>=tree.nodes[at+d]-1e-5);assert.ok(tree.nodes[child*16+4+d]<=tree.nodes[at+4+d]+1e-5);}
  }
  assert.ok(seen.every(v=>v===1),'each source face appears in exactly one leaf');
}
test('software ray hierarchies conservatively contain every source face once',()=>{
  const data=fixture();audit(buildFaceBvh(data),data);audit(buildBrickTree(data),data);
});
test('brick field is a lower bound on distance to occupied cell boxes',()=>{
  const occupied=new Uint8Array(512);occupied[0]=occupied[5+8*(4+8*3)]=occupied[511]=1;
  const dist=brickDistances(occupied);
  for(let z=0;z<8;z++)for(let y=0;y<8;y++)for(let x=0;x<8;x++){
    let closest=Infinity;
    for(let j=0;j<512;j++)if(occupied[j])closest=Math.min(closest,Math.max(Math.abs(x-j%8),Math.abs(y-Math.floor(j/8)%8),Math.abs(z-Math.floor(j/64))));
    assert.equal(dist[x+8*(y+8*z)],closest);
  }
});
test('threaded and binary BVH ray candidate sets match brute-force box intersections',()=>{
  const data=fixture(),tree=buildFaceBvh(data),u=new Uint32Array(tree.nodes.buffer);
  const intersects=(n:number,x:number,z:number)=>{const a=n*16;return x>=tree.nodes[a]&&x<=tree.nodes[a+4]&&z>=tree.nodes[a+2]&&z<=tree.nodes[a+6];};
  for(let q=0;q<100;q++){
    const x=q*.513,z=(q*7%47)+.3;const threaded:number[]=[],binary:number[]=[];
    function leaf(n:number,out:number[]){const a=n*16;for(let j=0;j<u[a+7];j++)out.push(tree.ids[u[a+11]+j]);}
    for(let n=0;n<tree.nodes.length/16;){if(!intersects(n,x,z)){n=u[n*16+3];continue;}if(u[n*16+7])leaf(n,threaded);n++;}
    const stack=[0];while(stack.length){const n=stack.pop()!;if(!intersects(n,x,z))continue;if(u[n*16+7])leaf(n,binary);else stack.push(n+1,u[n*16+15]);}
    assert.deepEqual(threaded.sort((a,b)=>a-b),binary.sort((a,b)=>a-b));
    for(let i=0;i<data.count;i++){const a=i*6;if(x>=data.flat[a]&&x<=data.flat[a+3]&&z>=data.flat[a+2]&&z<=data.flat[a+5])assert.ok(threaded.includes(i));}
  }
});
