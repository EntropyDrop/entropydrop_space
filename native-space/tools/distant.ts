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
import {DistantCoverageCache,decodeVoxelCache,MAX_SOURCE_BYTES} from './distant-cache.ts';
import {packDistantTile} from './distant-packing.ts';
const root=resolve(process.argv[2]);
const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
const dir=join(root,'distant',manifest.source_hash);mkdirSync(dir,{recursive:true});
const planner=new VoxelLodPlanner(),generator=new TerrainGenerator(manifest.seed,manifest.generator);
const legacyLoading=process.argv.includes('--legacy-loading') || process.env.SPACE_NATIVE_LEGACY_LOD==='1';
const coverage=new DistantCoverageCache(dir,manifest),restored=new Set<string>();
let restoredOnce=process.argv.includes('--skip-coverage'),cacheErrors=0,lastView='',lastStats:unknown;
let editsByChunk=new Map<string,Edit[]>(),editsByZone=new Map<string,string>();
const dirty=new Set<string>();
const originalGenerate=generator.generateChunk.bind(generator);
generator.generateChunk=(chunk,includeDetails=true)=>{originalGenerate(chunk,includeDetails);const edits=editsByChunk.get(`${chunk.cx},${chunk.cz}`);return edits?applyDistantEdits(chunk,edits):chunk.terrainDetails;};
const temporaryTiles=new Set<string>();
process.once('SIGTERM',()=>process.exit(0));
process.once('exit',()=>{for(const path of temporaryTiles){try{unlinkSync(path);}catch{}}});
const sources=new Map<string,VoxelLodSource>();let token=0;
function install(x:number,z:number) {
  const key=`${x},${z}`,path=join(dir,`${x}_${z}.vxl.gz`);let mips;
  if(!editsByZone.has(key)&&existsSync(path)){
    try {mips=decodeVoxelCache(gunzipSync(readFileSync(path),{maxOutputLength:MAX_SOURCE_BYTES}));}
    catch {cacheErrors++;}
  }
  if(!mips){mips=generateVoxelSurfaceZone(generator,x,z).levels;
    if(!editsByZone.has(key))try{const temporary=path+`.${process.pid}.tmp`;writeFileSync(temporary,gzipSync(encodeVoxelLevels(mips),{level:1}));renameSync(temporary,path);}catch{/* Source caching is optional. */}}
  if(!legacyLoading&&!editsByZone.has(key))coverage.store(x,z,mips);
  const source={key,x,z,token:++token,mips};sources.set(key,source);dirty.delete(key);for(const _ of planner.install(source)){/* worker thread */}
}
function bytes(source:VoxelLodSource){return source.mips.reduce((n,m)=>n+m.faces.byteLength,0);}
function writeTile(tile:VoxelLodTile) {
  const [x,z]=tile.key.split(',').map(Number),data=packDistantTile(tile,legacyLoading);
  const file=`tile-${process.pid}-${x}_${z}_${tile.tile}.bin`;writeFileSync(join(dir,file),data);temporaryTiles.add(join(dir,file));
  return {key:`far:${tile.key}:${tile.tile}`,file,format:2,origin:[x*512,0,z*512],bounds:tile.bounds,faces:tile.count};
}
for await(const line of createInterface({input:process.stdin})) {
 try {
  const started=performance.now();let packingMs=0;
  const request=JSON.parse(line),camera=request.camera as [number,number,number];
  if(!Array.isArray(camera)||camera.length!==3||!camera.every(Number.isFinite))throw Error('Invalid LOD camera');
  const previous=editsByZone;editsByChunk=new Map();const zoneEdits=new Map<string,Edit[]>();
  for(const edit of (request.edits??[]) as Edit[]){const cell=edit[0],size=cell.micro?128:16,x=Math.floor(cell.x/size),z=Math.floor(cell.z/size),chunkKey=`${x},${z}`,zoneKey=`${Math.floor(x/32)},${Math.floor(z/32)}`;
    const list=editsByChunk.get(chunkKey)??[];list.push(edit);editsByChunk.set(chunkKey,list);const zone=zoneEdits.get(zoneKey)??[];zone.push(edit);zoneEdits.set(zoneKey,zone);}
  editsByZone=new Map([...zoneEdits].map(([key,edits])=>[key,JSON.stringify(edits)]));
  for(const key of new Set([...previous.keys(),...editsByZone.keys()])){if(previous.get(key)!==editsByZone.get(key))dirty.add(key);}
  const torus=request.torus!==false,bent=torus?bendTorusPoint(...camera):{x:camera[0],y:camera[1],z:camera[2]};
  const distance=(x:number,z:number)=>{const p=torus?bendTorusPoint(x*512+256,128,z*512+256):{x:x*512+256,y:128,z:z*512+256};return Math.hypot(p.x-bent.x,p.y-bent.y,p.z-bent.z);};
  const zones:Array<[number,number]>=[];for(let x=0;x<32;x++)for(let z=0;z<4;z++)zones.push([x,z]);
  const distances=new Map(zones.map(([x,z])=>[`${x},${z}`,distance(x,z)]));
  zones.sort((a,b)=>distances.get(a.join(','))!-distances.get(b.join(','))!);
  const view={camera:[bent.x,bent.y,bent.z] as [number,number,number],focal:Math.max(1,request.height)/(2*Math.tan(35*Math.PI/180)),area:1,distance:2048*16,faceBudget:Math.floor(512*1024*1024/48),hasView:true,projection:torus?'torus' as const:'flat' as const};
  if(!legacyLoading&&!restoredOnce){
    restoredOnce=true;
    // Coverage gets its own planner. Refinement keeps the original source
    // order, budgets and hysteresis history, so cache arrival cannot lower
    // the settled quality or flash an already refined zone back to an overview.
    const preview=new VoxelLodPlanner();let sourceBytes=0;
    for(const [x,z] of zones){const key=`${x},${z}`;if(editsByZone.has(key))continue;
      const mips=coverage.read(x,z);if(!mips)continue;
      for(const _ of preview.install({key,x,z,token:0,mips})){}restored.add(key);sourceBytes+=mips[0].faces.byteLength;}
    if(restored.size){const tiles=[];const build=preview.build(view);let stats;
      for(;;){const result=build.next();if(result.done){stats=result.value;break;}if(result.value)tiles.push(writeTile(result.value));}
      process.stdout.write(JSON.stringify({ok:true,tiles,stats,zones:restored.size,refinedZones:0,ready:false,pendingSources:128,
        sourceBytes,cacheRestoredZones:restored.size,cacheErrors,torus,sourceLimitedZones:restored.size,phase:'cached-coverage',totalMs:performance.now()-started})+'\n');continue;}
  }
  const next=zones.find(([x,z])=>dirty.has(`${x},${z}`))??zones.find(([x,z])=>!sources.has(`${x},${z}`));if(next)install(...next);
  // Rehydrate the nearest zone before evicting fine mips from the farthest zones.
  const nearest=zones.slice(0,4).map(([x,z])=>sources.get(`${x},${z}`)).find(s=>s&&s.mips[0].cellSize>1);
  if(nearest&&nearest.mips[0].cellSize>1)install(nearest.x,nearest.z);
  let resident=[...sources.values()].reduce((n,s)=>n+bytes(s),0);
  const farthest=[...sources.values()].sort((a,b)=>distance(b.x,b.z)-distance(a.x,a.z));
  for(const source of farthest){while(resident>1024*1024*1024&&source.mips.length>1){resident-=source.mips[0].faces.byteLength;source.mips=source.mips.slice(1);source.token=++token;for(const _ of planner.install(source)){}}}
  const viewKey=JSON.stringify(view),unchanged=!next&&!nearest&&!legacyLoading&&viewKey===lastView&&lastStats!==undefined;
  const tiles=[];let stats=lastStats;const planningStarted=performance.now();
  if(!unchanged){const build=planner.build(view);for(;;){const result=build.next();if(result.done){stats=result.value;break;}if(result.value){const start=performance.now();tiles.push(writeTile(result.value));packingMs+=performance.now()-start;}}}
  lastView=viewKey;lastStats=stats;
  process.stdout.write(JSON.stringify({ok:true,dir,tiles,stats,zones:new Set([...restored,...sources.keys()]).size,refinedZones:sources.size,
    ready:sources.size===128&&dirty.size===0,pendingSources:128-sources.size+dirty.size,total:128,sourceBytes:resident,pendingEdits:dirty.size,torus,
    cacheRestoredZones:restored.size,cacheErrors,sourceLimitedZones:[...sources.values()].filter(s=>s.mips[0].cellSize>1).length,
    phase:sources.size===128?'ready':'refining',planningMs:performance.now()-planningStarted-packingMs,packingMs,totalMs:performance.now()-started,unchanged})+'\n');
 }catch(error){process.stdout.write(JSON.stringify({ok:false,error:String(error)})+'\n');}
}
