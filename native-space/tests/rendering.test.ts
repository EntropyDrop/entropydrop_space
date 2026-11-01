import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Chunk} from '../../engine/src/voxel/Chunk.ts';
import {applyDistantEdits} from '../tools/distant-edits.ts';
test('distant meshing receives the same standard/micro overlay after removal and repaint',()=>{
 const chunk=new Chunk(1023,127,null);
 chunk.setLocalBlock(15,20,15,1,0xaabbcc,0);
 chunk.terrainDetails=new Uint32Array([127,160,127,0x123456,126,160,127,0xabcdef]);
 const output=applyDistantEdits(chunk,[
  [{x:16383,y:20,z:2047,micro:false},0],
  [{x:131071,y:160,z:16383,micro:true},0],
  [{x:131070,y:160,z:16383,micro:true},0x0200ff00],
  [{x:16383,y:21,z:2047,micro:false},0x01ff0000],
 ]);
 assert.equal(chunk.blocks[Chunk.getIndex(15,20,15)],0);
 assert.equal(chunk.blocks[Chunk.getIndex(15,21,15)],1);
 assert.equal(chunk.colors[Chunk.getIndex(15,21,15)],0xff0000);
 assert.deepEqual(Array.from(output),[126,160,127,0x0100ff00]);
 assert.equal(chunk.terrainDetails,output);
});
