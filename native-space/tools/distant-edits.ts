import {Chunk} from '../../engine/src/voxel/Chunk.ts';
export type Edit = [{x:number;y:number;z:number;micro:boolean},number];
/** Apply the same final overlay as Rust World::insert before volumetric meshing. */
export function applyDistantEdits(chunk:Chunk,edits:Edit[]) {
  const details=new Map<string,number[]>();
  for(let i=0;i<chunk.terrainDetails.length;i+=4){const cell=Array.from(chunk.terrainDetails.subarray(i,i+4));details.set(cell.slice(0,3).join(','),cell);}
  for(const [cell,value] of edits){
    if(cell.micro){const x=((cell.x%128)+128)%128,z=((cell.z%128)+128)%128,key=`${x},${cell.y},${z}`;
      if(value)details.set(key,[x,cell.y,z,((value&0xffffff)|(((value>>>24)-1)<<24))>>>0]);else details.delete(key);
    }else{chunk.setLocalBlock(((cell.x%16)+16)%16,cell.y,((cell.z%16)+16)%16,value?1:0,value&0xffffff,value?(value>>>24)-1:0);}
  }
  chunk.terrainDetails=new Uint32Array([...details.values()].flat());return chunk.terrainDetails;
}
