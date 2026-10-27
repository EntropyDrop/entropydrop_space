import test from 'node:test';
import assert from 'node:assert/strict';
import {Chunk} from '../src/voxel/Chunk.ts';
import {TerrainGenerator} from '../src/worldgen/TerrainGenerator.ts';
for(const version of [1,2,3])test(`torus comparison fixture ${version} preserves original standard cells and sparse boundaries`,()=>{
 const seed=version===2?20260922:42,original=new TerrainGenerator(seed,version),comparison=new TerrainGenerator(seed,version+10);
 for(const [cx,cz] of [[0,32],[31,95],[480,32],[511,95],[512,32],[543,95],[992,32],[1023,95]]){
  const a=new Chunk(cx,cz,null),b=new Chunk(cx,cz,null);original.generateChunk(a,false);comparison.generateChunk(b,true);
  assert.deepEqual(b.blocks,a.blocks);assert.deepEqual(b.colors,a.colors);assert.deepEqual(b.materials,a.materials);assert.equal(b.terrainDetails.length,0);
 }
 for(const [cx,cz] of [[32,32],[479,32],[544,95],[991,32],[0,31],[512,96]]){
  const c=new Chunk(cx,cz,null);comparison.generateChunk(c);assert.ok(c.blocks.every(v=>v===0));assert.equal(c.terrainDetails.length,0);
 }
});
