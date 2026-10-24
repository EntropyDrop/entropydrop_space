import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { TerrainGenerator } from '../../engine/src/worldgen/TerrainGenerator.ts';
import { generateVoxelSurfaceZone, encodeVoxelLevels } from '../../engine/src/worldgen/VoxelSurfaceGenerator.ts';
import { getTerrainKernels } from '../../engine/src/wasm/TerrainKernels.ts';

// Actual Copper districts through the existing web snapshot/LOD generation path.
// No repeated district fixture and no replacement renderer.
const seed = 20260922, version = 2;
const root = resolve(import.meta.dirname, '../../.local/godot-web-surfaces/copper-metropolis');
mkdirSync(root, { recursive: true });
const hash = createHash('sha256');
for (const file of ['worldgen/CopperMetropolisGenerator.ts','worldgen/VoxelSurfaceGenerator.ts',
  'wasm/TerrainKernels.ts','wasm/TerrainKernelBinary.ts','wasm/VoxelSurfaceKernels.ts'])
  hash.update(readFileSync(resolve(import.meta.dirname, '../../engine/src', file)));
const sourceSha256 = hash.digest('hex');
const generator = new TerrainGenerator(seed,version), kernels = getTerrainKernels()!;
const zones: any[] = [], started = performance.now();
const coordinates: number[][] = [];
for(let z=0;z<4;z++) for(let x=0;x<32;x++) coordinates.push([x,z]);
coordinates.sort((a,b)=>Math.hypot(a[0]-16,a[1]-2)-Math.hypot(b[0]-16,b[1]-2));
for(const [zoneX,zoneZ] of coordinates) {
  const indexFile=resolve(root,`${zoneX}_${zoneZ}.json`);
  let entry=existsSync(indexFile)?JSON.parse(readFileSync(indexFile,'utf8')):null;
  if(entry?.sourceSha256!==sourceSha256) {
    const volume=generateVoxelSurfaceZone(generator,zoneX,zoneZ);
    let records=volume.records; const entries=[];
    for(let size=1;size<=64;size*=2) {
      const voxel=encodeVoxelLevels(volume.levels.filter(level=>level.cellSize>=size));
      const bytes=new Uint8Array(36+records.length+voxel.length),view=new DataView(bytes.buffer);
      bytes.set([69,68,83,90,7,size,32,8]);
      view.setUint16(8,zoneX,true);view.setUint16(10,zoneZ,true);
      view.setInt32(12,seed,true);view.setUint32(16,version,true);view.setUint32(28,(512/size)**2,true);
      bytes.set(records,32);bytes.set(voxel,36+records.length);
      const digest=createHash('sha256').update(bytes).digest('hex');
      const name=`${zoneX}_${zoneZ}_${size}.bin.gz`;
      writeFileSync(resolve(root,name),gzipSync(bytes,{level:1}));
      entries.push({sample_size:size,digest,byte_length:bytes.length,url:`/__torus_comparison__/surface/${name}`});
      if(size<64)records=kernels.reduceSurfaceRecords(records,512/size);
    }
    entry={sourceSha256,zone_x:zoneX,zone_z:zoneZ,revision:1,source_terrain_revision:0,...entries[0],lods:entries.slice(1)};
    writeFileSync(indexFile,JSON.stringify(entry));
  }
  zones.push(entry);
  console.log(`WEB_SURFACE ${zones.length}/128 ${(performance.now()-started)/1000|0}s`);
}
const manifest={schema_version:7,samples_per_chunk_axis:16,zone_size_chunks:32,width_chunks:1024,
  length_chunks:128,complete:true,zones,sourceSha256,seed,terrain_generator_version:version};
writeFileSync(resolve(root,'manifest.json'),JSON.stringify(manifest));
console.log('WEB_SURFACE_COMPLETE',JSON.stringify({zones:zones.length,seconds:(performance.now()-started)/1000,sourceSha256}));
