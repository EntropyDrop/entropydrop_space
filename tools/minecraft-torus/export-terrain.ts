/** Export exact standard cells from the existing three generators, not a Java reimplementation. */
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {deflateSync,crc32} from 'node:zlib';
import {createHash} from 'node:crypto';
import {TerrainGenerator} from '../../engine/src/worldgen/TerrainGenerator.ts';
import {Chunk} from '../../engine/src/voxel/Chunk.ts';
const root=resolve(process.argv[2]??'tools/minecraft-torus/data');await mkdir(root,{recursive:true});
const zones=[[15,1],[15,2],[16,1],[16,2],[0,1],[0,2],[31,1],[31,2]];
const palette:number[]=[0],ids=new Map<number,number>();
const worlds=[{name:'nature',version:1,seed:42},{name:'copper-metropolis',version:2,seed:20260922},{name:'aether-archipelago',version:3,seed:42}];
const manifest:any={schema:1,zones,extent:[16384,256,2048],unit:1,details:false,worlds:[]};
for(const world of worlds){
 const generator=new TerrainGenerator(world.seed,world.version),chunk=new Chunk(0,0,null),hash=createHash('sha256');
 const output=resolve(root,world.name);await mkdir(output,{recursive:true});
 const records:any[]=[];let solids=0;
 for(const [zx,zz] of zones)for(let cx=zx*32;cx<(zx+1)*32;cx++)for(let cz=zz*32;cz<(zz+1)*32;cz++){
  chunk.reuseAt(cx,cz,null);generator.generateChunk(chunk,false);
  const bytes=Buffer.alloc(65536*2),canonical=Buffer.alloc(65536*4);let count=0;
  for(let i=0;i<65536;i++)if(chunk.blocks[i]){
   const value=(chunk.colors[i]|chunk.materials[i]<<24)>>>0;
   let id=ids.get(value);if(id===undefined){id=palette.length;if(id>65535)throw Error('Palette exceeds uint16');ids.set(value,id);palette.push(value);}
   bytes.writeUInt16LE(id,i*2);canonical.writeUInt32LE((value|0x80000000)>>>0,i*4);count++;
  }
  hash.update(canonical);const packed=deflateSync(bytes,{level:3});await writeFile(resolve(output,`${cx}-${cz}.bin`),packed);
  records.push({x:cx,z:cz,crc32:crc32(canonical),solids:count});solids+=count;
  if(records.length%512===0)console.log(world.name,records.length,'/8192',palette.length,'colors');
 }
 const info={...world,chunks:records,solidBlocks:solids,sha256:hash.digest('hex')};
 await writeFile(resolve(output,'manifest.json'),JSON.stringify(info));manifest.worlds.push({...world,solidBlocks:solids,sha256:info.sha256,chunks:records.length});
}
manifest.palette=palette.length-1;await writeFile(resolve(root,'palette.json'),JSON.stringify(palette));await writeFile(resolve(root,'manifest.json'),JSON.stringify(manifest,null,2));console.log(manifest);
