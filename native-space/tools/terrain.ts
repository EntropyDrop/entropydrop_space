import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { TerrainGenerator } from '../../engine/src/worldgen/TerrainGenerator.ts';
import { Chunk } from '../../engine/src/voxel/Chunk.ts';

const root=resolve(import.meta.dirname,'..');
const worlds:Record<string,{seed:number;generator:number;spawn:number[]}>= {
  nature:{seed:42,generator:1,spawn:[8192.5,24,1024.5]},
  'copper-metropolis':{seed:20260922,generator:2,spawn:[8200,128,1032]},
  'aether-archipelago':{seed:42,generator:3,spawn:[8192.5,180,1024.5]},
};
const name=process.argv.find(a=>a.startsWith('--world='))?.slice(8)??'aether-archipelago';
if(!worlds[name])throw Error(`Unknown world: ${name}`);
const config=worlds[name];const dir=resolve(root,'data/worlds',name);
const hash=createHash('sha256');
for(const part of ['worldgen','wasm','voxel','torus']) {
  const parent=resolve(root,'../engine/src',part);
  for(const file of readdirSync(parent).filter(n=>n.endsWith('.ts')).sort())hash.update(file).update(readFileSync(join(parent,file)));
}
const source_hash=hash.digest('hex');
mkdirSync(join(dir,'chunks'),{recursive:true});
const manifest={schema:1,world:name,...config,source_hash};
const manifestPath=join(dir,'manifest.json');
if(existsSync(manifestPath)&&JSON.parse(readFileSync(manifestPath,'utf8')).source_hash!==source_hash)
  throw Error('Generator changed. Move the old data/worlds directory aside and migrate saves before regenerating.');
writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
const generator=new TerrainGenerator(config.seed,config.generator);
const chunk=new Chunk(0,0,null);
function generate(cx:number,cz:number) {
  if(!Number.isInteger(cx)||!Number.isInteger(cz))throw Error('Integer chunk coordinates required');
  cx=((cx%1024)+1024)%1024;cz=((cz%128)+128)%128;
  const path=join(dir,'chunks',`${cx}_${cz}.bin.gz`);if(existsSync(path))return;
  chunk.reuseAt(cx,cz,null);const details=generator.generateChunk(chunk,true);
  const bytes=Buffer.alloc(16+65536*4+details.length*4);bytes.write('SPC1');bytes.writeUInt32LE(cx,4);bytes.writeUInt32LE(cz,8);bytes.writeUInt32LE(details.length/4,12);
  for(let i=0;i<65536;i++)bytes.writeUInt32LE(chunk.blocks[i]?((chunk.colors[i]&0xffffff)|((chunk.materials[i]+1)<<24))>>>0:0,16+i*4);
  const base=16+65536*4;
  for(let i=0;i<details.length;i+=4){for(let j=0;j<3;j++)bytes.writeUInt32LE(details[i+j],base+(i+j)*4);
    const value=details[i+3];bytes.writeUInt32LE(((value&0xffffff)|(((value>>>24)+1)<<24))>>>0,base+(i+3)*4);}
  const temporary=path+`.${process.pid}.tmp`;writeFileSync(temporary,gzipSync(bytes,{level:1}));renameSync(temporary,path);
}
if(process.argv.includes('--worker')) {
  const reader=createInterface({input:process.stdin});
  for await(const line of reader){try{const {x,z}=JSON.parse(line);generate(x,z);process.stdout.write(JSON.stringify({ok:true,x,z})+'\n');}
    catch(error){process.stdout.write(JSON.stringify({ok:false,error:String(error)})+'\n');}}
} else {
  const radius=Number(process.argv.find(a=>a.startsWith('--radius='))?.slice(9)??4);
  if(!Number.isInteger(radius)||radius<0||radius>32)throw Error('Radius must be in 0..32');
  const cx=Math.floor(config.spawn[0]/16),cz=Math.floor(config.spawn[2]/16);let count=0;
  const keys:Array<[number,number]>=[];for(let z=-radius;z<=radius;z++)for(let x=-radius;x<=radius;x++)keys.push([cx+x,cz+z]);
  keys.sort((a,b)=>Math.hypot(a[0]-cx,a[1]-cz)-Math.hypot(b[0]-cx,b[1]-cz));
  for(const [x,z] of keys){generate(x,z);if(++count%16===0)console.log(`${name}: ${count}/${keys.length} chunks`);}
  console.log(`${name}: prepared ${keys.length} chunks in ${dir}`);
}
