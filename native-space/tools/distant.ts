// Temporary production-engine adapter. No browser, renderer, or repeated-world shortcut.
import {applyDistantEdits,type Edit} from './distant-edits.ts';
import {readFileSync,writeFileSync,mkdirSync,existsSync,renameSync,unlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createInterface} from 'node:readline';
import {TerrainGenerator} from '../../engine/src/worldgen/TerrainGenerator.ts';
import {generateVoxelSurfaceZone,encodeVoxelLevels} from '../../engine/src/worldgen/VoxelSurfaceGenerator.ts';
import {VoxelLodPlanner,type VoxelLodSource,type VoxelLodTile} from '../../engine/src/render/VoxelLodPlanner.ts';
import {bendTorusPoint} from '../../engine/src/torus/TorusWorld.ts';
const root=resolve(process.argv[2]);
const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
const dir=join(root,'distant',manifest.source_hash);mkdirSync(dir,{recursive:true});
const planner=new VoxelLodPlanner(),generator=new TerrainGenerator(manifest.seed,manifest.generator);
let editsByChunk=new Map<string,Edit[]>(),editsByZone=new Map<string,string>();
const dirty=new Set<string>();
const originalGenerate=generator.generateChunk.bind(generator);
generator.generateChunk=(chunk,includeDetails=true)=>{originalGenerate(chunk,includeDetails);const edits=editsByChunk.get(`${chunk.cx},${chunk.cz}`);return edits?applyDistantEdits(chunk,edits):chunk.terrainDetails;};
const temporaryTiles=new Set<string>();
process.once('SIGTERM',()=>process.exit(0));
process.once('exit',()=>{for(const path of temporaryTiles){try{unlinkSync(path);}catch{}}});
const sources=new Map<string,VoxelLodSource>();let token=0;
function decode(bytes:Uint8Array) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(Buffer.from(bytes.subarray(0,4)).toString()!=='VXL7')throw Error('Invalid voxel surface cache');
  let at=8;const levels=[];
  for(let i=0;i<bytes[4];i++) {const cellSize=bytes[at],length=view.getUint32(at+4,true)*16;at+=8;
    if(length%16||at+length>bytes.length)throw Error('Invalid voxel mip length');
    levels.push({cellSize,faces:bytes.slice(at,at+length)});at+=length;}
  if(at!==bytes.length)throw Error('Unexpected voxel cache bytes');return levels;
}
function install(x:number,z:number) {
  const key=`${x},${z}`,path=join(dir,`${x}_${z}.vxl.gz`);let mips;
  if(!editsByZone.has(key)&&existsSync(path))mips=decode(gunzipSync(readFileSync(path)));
  else {const volume=generateVoxelSurfaceZone(generator,x,z);mips=volume.levels;const temporary=path+`.${process.pid}.tmp`;if(!editsByZone.has(key)){writeFileSync(temporary,gzipSync(encodeVoxelLevels(mips),{level:1}));renameSync(temporary,path);}}
  const source={key,x,z,token:++token,mips};sources.set(key,source);dirty.delete(key);for(const _ of planner.install(source)){/* worker thread */}
}
function bytes(source:VoxelLodSource){return source.mips.reduce((n,m)=>n+m.faces.byteLength,0);}
function writeTile(tile:VoxelLodTile) {
  const source=sources.get(tile.key)!;
  if(!tile.visibility||tile.visibility.length!==Math.ceil(tile.count/16)*12)throw Error('Missing face visibility metadata');
  const data=Buffer.alloc(tile.count*16+tile.visibility.byteLength);
  for(let i=0;i<tile.count;i++){const at=i*16;
    data.writeUInt32LE((tile.offset[i*3]|tile.offset[i*3+1]<<16)>>>0,at);
    data.writeUInt32LE((tile.offset[i*3+2]|tile.span[i*2]<<16)>>>0,at+4);
    data.writeUInt32LE((tile.span[i*2+1]|tile.direction[i]<<16|3<<19)>>>0,at+8);
    data.writeUInt32LE(((tile.emission[i]?2:1)<<24)|(tile.color[i*3]<<16)|(tile.color[i*3+1]<<8)|tile.color[i*3+2],at+12);}
  for(let i=0;i<tile.visibility.length;i++)data.writeFloatLE(tile.visibility[i],tile.count*16+i*4);
  const file=`tile-${process.pid}-${source.x}_${source.z}_${tile.tile}.bin`;writeFileSync(join(dir,file),data);temporaryTiles.add(join(dir,file));
  return {key:`far:${source.key}:${tile.tile}`,file,format:2,origin:[source.x*512,0,source.z*512],bounds:tile.bounds,faces:tile.count};
}
for await(const line of createInterface({input:process.stdin})) {
 try {
  const request=JSON.parse(line),camera=request.camera as [number,number,number];
  if(!Array.isArray(camera)||camera.length!==3||!camera.every(Number.isFinite))throw Error('Invalid LOD camera');
  const previous=editsByZone;editsByChunk=new Map();const zoneEdits=new Map<string,Edit[]>();
  for(const edit of (request.edits??[]) as Edit[]){const cell=edit[0],size=cell.micro?128:16,x=Math.floor(cell.x/size),z=Math.floor(cell.z/size),chunkKey=`${x},${z}`,zoneKey=`${Math.floor(x/32)},${Math.floor(z/32)}`;
    const list=editsByChunk.get(chunkKey)??[];list.push(edit);editsByChunk.set(chunkKey,list);const zone=zoneEdits.get(zoneKey)??[];zone.push(edit);zoneEdits.set(zoneKey,zone);}
  editsByZone=new Map([...zoneEdits].map(([key,edits])=>[key,JSON.stringify(edits)]));
  for(const key of new Set([...previous.keys(),...editsByZone.keys()])){if(previous.get(key)!==editsByZone.get(key)&&sources.has(key))dirty.add(key);}
  const torus=request.torus!==false,bent=torus?bendTorusPoint(...camera):{x:camera[0],y:camera[1],z:camera[2]};
  const distance=(x:number,z:number)=>{const p=torus?bendTorusPoint(x*512+256,128,z*512+256):{x:x*512+256,y:128,z:z*512+256};return Math.hypot(p.x-bent.x,p.y-bent.y,p.z-bent.z);};
  const zones:Array<[number,number]>=[];for(let x=0;x<32;x++)for(let z=0;z<4;z++)zones.push([x,z]);zones.sort((a,b)=>distance(...a)-distance(...b));
  const next=zones.find(([x,z])=>dirty.has(`${x},${z}`))??zones.find(([x,z])=>!sources.has(`${x},${z}`));if(next)install(...next);
  // Rehydrate the nearest zone before evicting fine mips from the farthest zones.
  const nearest=zones.slice(0,4).map(([x,z])=>sources.get(`${x},${z}`)).find(s=>s&&s.mips[0].cellSize>1);
  if(nearest&&nearest.mips[0].cellSize>1)install(nearest.x,nearest.z);
  let resident=[...sources.values()].reduce((n,s)=>n+bytes(s),0);
  const farthest=[...sources.values()].sort((a,b)=>distance(b.x,b.z)-distance(a.x,a.z));
  for(const source of farthest){while(resident>1024*1024*1024&&source.mips.length>1){resident-=source.mips[0].faces.byteLength;source.mips=source.mips.slice(1);source.token=++token;for(const _ of planner.install(source)){}}}
  const build=planner.build({camera:[bent.x,bent.y,bent.z],focal:Math.max(1,request.height)/(2*Math.tan(35*Math.PI/180)),area:1,distance:2048*16,faceBudget:Math.floor(512*1024*1024/48),hasView:true,projection:torus?'torus':'flat'});
  const tiles=[];let stats;for(;;){const result=build.next();if(result.done){stats=result.value;break;}if(result.value)tiles.push(writeTile(result.value));}
  process.stdout.write(JSON.stringify({ok:true,dir,tiles,stats,zones:sources.size,total:128,sourceBytes:resident,pendingEdits:dirty.size,torus,sourceLimitedZones:[...sources.values()].filter(s=>s.mips[0].cellSize>1).length})+'\n');
 }catch(error){process.stdout.write(JSON.stringify({ok:false,error:String(error)})+'\n');}
}
