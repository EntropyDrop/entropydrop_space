import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthoredSurface, meshAuthoredSurface } from '../src/render/AuthoredSurfaceMesher.ts';
import type { DistantChunkSnapshot } from '../src/voxel/SurfaceZoneSnapshot.ts';

const snapshot = (boxes: number[], colors: number[]): DistantChunkSnapshot => ({chunkX:0,chunkZ:0,revision:1,
  boxes:Uint16Array.from(boxes),colors:Uint8Array.from(colors)});

test('adjacent solids produce only their exterior, with outward winding on every axis', () => {
  const source = snapshot([0,0,0,8,8,8, 8,0,0,8,8,8], [255,0,0,255,0,0]);
  const data = buildAuthoredSurface(source, 1);
  assert.equal(data.faces, 6);
  for (let face = 0; face < data.faces; face++) {
    const a = data.positions.subarray(face*12,face*12+3), b = data.positions.subarray(face*12+3,face*12+6), c = data.positions.subarray(face*12+6,face*12+9);
    const ab = b.map((n,i)=>n-a[i]), ac = c.map((n,i)=>n-a[i]);
    const cross = [ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
    assert.ok(cross.reduce((n,v,i)=>n+v*data.normals[face*12+i],0)>0);
  }
});

test('floating blocks and separated floors do not acquire a filled column', () => {
  const data = meshAuthoredSurface(snapshot([0,80,0,8,8,8,0,112,0,8,8,8], [255,0,0,0,0,255]), .5);
  assert.equal(data.quads.length / 6, 12);
  for (let at = 0; at < data.quads.length; at += 6) {
    const y = data.quads[at + 1]; assert.ok((y>=10&&y<=11)||(y>=14&&y<=15));
  }
});

test('thin micro solids survive coarse filtering and contribute volume-weighted color', () => {
  const data = meshAuthoredSurface(snapshot([0,80,0,1,1,1,1,80,0,3,1,1], [255,0,0,0,0,255]), 1);
  assert.equal(data.quads.length / 6, 6);
  assert.deepEqual([...data.colors.slice(0,3)],[64,0,191]);
  assert.ok(data.quads[1]>=10);
});

test('finest proxies preserve micro extents, wrapped chunk origins and source buffers', () => {
  const source = snapshot([1,5,3,1,1,1],[17,128,255]);source.chunkX=1023;source.chunkZ=127;
  const before = source.boxes.slice(), data = buildAuthoredSurface(source,.125);
  const xs = [], ys = [], zs = [];
  for(let i=0;i<data.positions.length;i+=3){xs.push(data.positions[i]);ys.push(data.positions[i+1]);zs.push(data.positions[i+2]);}
  assert.equal(Math.min(...xs),1023*16+.125);assert.equal(Math.max(...xs),1023*16+.25);
  assert.equal(Math.min(...ys),.625);assert.equal(Math.max(...ys),.75);
  assert.equal(Math.min(...zs),127*16+.375);assert.equal(Math.max(...zs),127*16+.5);
  assert.deepEqual(source.boxes,before);
  assert.equal(data.colors[2],1);assert.ok(data.colors[0]>0&&data.colors[0]<17/255);
});

test('empty authored chunks remain empty at every supported proxy size', () => {
  for(const size of [.125,.25,.5,1,2,4])assert.equal(buildAuthoredSurface(snapshot([],[]),size).faces,0);
});
