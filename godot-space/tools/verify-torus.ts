import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Chunk } from '../../engine/src/voxel/Chunk.ts';
import { generateCopperMetropolisChunk } from '../../engine/src/worldgen/CopperMetropolisGenerator.ts';
import { AETHER_DEFAULTS, aetherSpawnAnchor, generateAetherRegion } from '../../engine/src/worldgen/AetherArchipelagoGenerator.ts';
import { bendPoint, bendDirection } from '../../engine/src/torus/TorusWorld.ts';

const project = resolve(import.meta.dirname, '..'), root = resolve(project, 'world-data');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const sectors = new Map<string, any>(), dataCache = new Map<string, Buffer>();
const sector = (x: number, z: number) => {
  const key = `${x}_${z}`;
  if (!sectors.has(key)) sectors.set(key, JSON.parse(readFileSync(resolve(root, `sectors/${key}.json`), 'utf8')));
  return sectors.get(key);
};
const data = (record: any) => {
  if (!record) return null;
  if (!dataCache.has(record.id)) {
    const fd = openSync(resolve(root, record.archive), 'r'), bytes = Buffer.alloc(record.length);
    assert.equal(readSync(fd, bytes, 0, bytes.length, record.offset), bytes.length); closeSync(fd);
    const raw = gunzipSync(bytes); assert.equal(raw.length, record.rawBytes);
    dataCache.set(record.id, raw);
  }
  return dataCache.get(record.id)!;
};
let records = 0;
for (const zone of manifest.zones) {
  const s = sector(zone.x, zone.z);
  assert.deepEqual(s.far.origin, [zone.x * 128, 0, zone.z * 128]);
  for (const record of [...s.records, s.far]) {
    assert(record.offset >= 0 && record.offset + record.length <= statSync(resolve(root, record.archive)).size);
    assert.equal(record.rawBytes, record.size.reduce((n: number, v: number) => n * v, 4));
  }
  records += s.records.length;
}
assert.equal(records, manifest.counts.records);
const anchor = aetherSpawnAnchor(manifest.seed), rgba = (c: number, e: number) => ((c << 8) | (e ? 254 : 255)) >>> 0;
let checked = 0, checkedMicro = 0;
for (const [wx, wz] of [[0,0],[0,1024],[16352,0],[16352,2016],[8192,1024],[8128,992],[4096,512],[12288,1536]]) {
  dataCache.clear();
  let source: {cells: Uint32Array | Uint8Array | Uint16Array; palette: {color:number; emission:number}[]; details: Uint32Array};
  if (manifest.world === 'copper-metropolis') {
    const cells = new Uint32Array(32*32*256), details: number[] = [], palette=[{color:0,emission:0}];
    const colors = new Map<number,number>();
    for (let cz=0;cz<2;cz++) for(let cx=0;cx<2;cx++) {
      const chunk = new Chunk(wx/16+cx,wz/16+cz,null);
      const micro = generateCopperMetropolisChunk(chunk,manifest.seed,true);
      for(let y=0;y<256;y++) for(let z=0;z<16;z++) for(let x=0;x<16;x++) {
        const i=(y*16+z)*16+x; if(!chunk.blocks[i])continue;
        const color=chunk.colors[i], emission=chunk.materials[i], key=rgba(color,emission);
        if(!colors.has(key)){colors.set(key,palette.length);palette.push({color,emission});}
        cells[x+cx*16+32*(z+cz*16+32*y)]=colors.get(key)!;
      }
      for(let i=0;i<micro.length;i+=4) details.push(micro[i]+cx*128,micro[i+1],micro[i+2]+cz*128,micro[i+3]);
    }
    source={cells,palette,details:Uint32Array.from(details)};
  } else source = generateAetherRegion({ ...AETHER_DEFAULTS, seed: manifest.seed, sizeX: 32, sizeZ: 32, sizeY: 256, yCutoff: 256,
    offsetX: wx - 8192 + anchor.x + 16, offsetZ: wz - 1024 + anchor.z + 16 }, true);
  const index = new Map(sector(Math.floor(wx / 128), Math.floor(wz / 128)).records.map((r: any) => [r.id, r]));
  const palette = source.palette.map(p => rgba(p.color, p.emission)); palette[0] = 0;
  for (let by = 0; by < 256; by += 32) {
    const raw = data(index.get(`solid:${wx}:${by}:${wz}`));
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) {
      assert.equal(raw?.readUInt32LE(4 * (y + 32 * (x + 32 * z))) ?? 0,
        palette[source.cells[x + 32 * (z + 32 * (by + y))]], `Canonical voxel ${wx+x},${by+y},${wz+z}`);
      checked++;
    }
  }
  // Production micro installation is last-write-wins for overlapping ornaments.
  const expectedMicro = new Map<string, number>();
  for (let i=0;i<source.details.length;i+=4)
    expectedMicro.set(`${source.details[i]},${source.details[i+1]},${source.details[i+2]}`,source.details[i+3]);
  let sample=0;
  for (const [position,color] of expectedMicro) {
    if(sample++ % 13)continue;
    const local=position.split(',').map(Number),x=local[0]+wx*8,y=local[1],z=local[2]+wz*8;
    const raw = data(index.get(`micro:${Math.floor(x/64)*8}:${Math.floor(y/64)*8}:${Math.floor(z/64)*8}`));
    assert.equal(raw?.readUInt32LE(4 * ((y&63)+64*((x&63)+64*(z&63)))) ?? 0, rgba(color&0xffffff,color>>>24));
    checkedMicro++;
  }
}
const points = [[0,16,0],[8192.5,180,1024.5],[16383.9,70,2047.9],[.1,70,.1],[4096,256,512],[12288,120,1536],[-1,32,-1],[16385,32,2049]];
const fixtures = points.map(([x,y,z]) => ({point:[x,y,z], bent:bendPoint(x,y,z).toArray(),
  axes:[[1,0,0],[0,1,0],[0,0,1]].map(([a,b,c])=>bendDirection(x,y,z,{x:a,y:b,z:c}).toArray())}));
writeFileSync(resolve(project, 'results/torus-reference.json'), JSON.stringify(fixtures));
console.log(JSON.stringify({ result:'PASS', world:manifest.world, seed:manifest.seed, sectors:manifest.zones.length, records, canonicalSolidVoxels:checked,
  canonicalMicroSamples:checkedMicro, projectionReferencePoints:fixtures.length },null,2));
