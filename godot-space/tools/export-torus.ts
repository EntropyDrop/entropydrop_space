import { mkdirSync, readFileSync, writeFileSync, openSync, writeSync, closeSync, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { Chunk } from '../../engine/src/voxel/Chunk.ts';
import { generateCopperMetropolisChunk } from '../../engine/src/worldgen/CopperMetropolisGenerator.ts';
import { AETHER_DEFAULTS, aetherSpawnAnchor, generateAetherRegion } from '../../engine/src/worldgen/AetherArchipelagoGenerator.ts';

const project = resolve(import.meta.dirname, '..');
const root = resolve(project, 'world-data');
const world = process.argv.find(a => a.startsWith('--world='))?.split('=')[1] ?? 'copper-metropolis';
if (!['copper-metropolis', 'aether-archipelago'].includes(world)) throw new Error(`Unknown world: ${world}`);
const seed = world === 'copper-metropolis' ? 20260922 : 42;
const tileSize = 512, sectorSize = 128, height = 256;
const anchor = world === 'aether-archipelago' ? aetherSpawnAnchor(seed) : { x: 0, z: 0 };
const dependencies = world === 'aether-archipelago' ? ['worldgen/AetherArchipelagoGenerator.ts']
  : ['worldgen/CopperMetropolisGenerator.ts', 'voxel/Chunk.ts', 'wasm/TerrainKernels.ts', 'wasm/TerrainKernelBinary.ts', 'torus/TorusWorld.ts'];
const hash = createHash('sha256');
for (const file of dependencies) hash.update(readFileSync(resolve(project, '../engine/src', file)));
const sourceSha256 = hash.digest('hex');
const rgba = (rgb: number, emission: number) => ((rgb << 8) | (emission ? 254 : 255)) >>> 0;
const key = (kind: string, x: number, y: number, z: number) => `${kind}:${x}:${y}:${z}`;

function exportTile(tx: number, tz: number) {
  const tileName = `${tx}_${tz}`, metadata = resolve(root, `tiles/${tileName}.json`);
  if (existsSync(metadata)) {
    const cached = JSON.parse(readFileSync(metadata, 'utf8'));
    if (cached.schema === 3 && cached.world === world && cached.seed === seed && cached.sourceSha256 === sourceSha256) return cached;
  }
  const started = performance.now(), wx = tx * tileSize, wz = tz * tileSize;
  const solid = new Map<number, Uint32Array>(), micro = new Map<number, Uint32Array>();
  const coarse = new Uint32Array(64 * 64 * 32), occupancy = new Uint16Array(coarse.length);
  const coarseTop = new Int16Array(coarse.length).fill(-1);
  let solidCount = 0, microCount = 0;
  const putSolid = (x: number, y: number, z: number, color: number) => {
    solidCount++;
    const k = (x >> 5) + 16 * ((z >> 5) + 16 * (y >> 5));
    let data = solid.get(k); if (!data) { data = new Uint32Array(32 ** 3); solid.set(k, data); }
    data[(y & 31) + 32 * ((x & 31) + 32 * (z & 31))] = color;
    const c = (y >> 3) + 32 * ((x >> 3) + 64 * (z >> 3));
    occupancy[c]++;
    if (y >= coarseTop[c]) { coarseTop[c] = y; coarse[c] = color; }
  };
  const putMicro = (x: number, y: number, z: number, color: number) => {
    const k = (x >> 6) + 64 * ((z >> 6) + 64 * (y >> 6));
    let data = micro.get(k); if (!data) { data = new Uint32Array(64 ** 3); micro.set(k, data); }
    const i = (y & 63) + 64 * ((x & 63) + 64 * (z & 63));
    if (!data[i]) microCount++;
    data[i] = rgba(color & 0xffffff, color >>> 24);
  };
  if (world === 'aether-archipelago') {
    const region = generateAetherRegion({ ...AETHER_DEFAULTS, seed, sizeX: tileSize, sizeZ: tileSize,
      sizeY: height, yCutoff: height, offsetX: wx - 8192 + anchor.x + tileSize / 2,
      offsetZ: wz - 1024 + anchor.z + tileSize / 2 }, true);
    const palette = region.palette.map(p => rgba(p.color, p.emission)); palette[0] = 0;
    for (let y = 0; y < height; y++) for (let z = 0; z < tileSize; z++) {
      const base = (y * tileSize + z) * tileSize;
      for (let x = 0; x < tileSize; x++) {
        const id = region.cells[base + x]; if (id) putSolid(x,y,z,palette[id]);
      }
    }
    for (let i = 0; i < region.details.length; i += 4)
      putMicro(region.details[i], region.details[i+1], region.details[i+2], region.details[i+3]);
  } else {
    // Use the exact production chunk generator, including its WASM rasterizer.
    for (let cz = 0; cz < tileSize / 16; cz++) for (let cx = 0; cx < tileSize / 16; cx++) {
      const chunk = new Chunk(wx / 16 + cx, wz / 16 + cz, null);
      const details = generateCopperMetropolisChunk(chunk, seed, true);
      const bounds = chunk.getOccupiedYRange();
      if (bounds) for (let y = bounds.min; y <= bounds.max; y++) for (let z = 0; z < 16; z++) {
        const base = (y * 16 + z) * 16;
        for (let x = 0; x < 16; x++) if (chunk.blocks[base+x])
          putSolid(cx*16+x,y,cz*16+z,rgba(chunk.colors[base+x],chunk.materials[base+x]));
      }
      for (let i = 0; i < details.length; i += 4)
        putMicro(cx*128+details[i],details[i+1],cz*128+details[i+2],details[i+3]);
    }
  }
  const sectors = new Map<string, any>();
  for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) {
    const sx = tx * 4 + x, sz = tz * 4 + z;
    sectors.set(`${sx}_${sz}`, { x: sx, z: sz, records: [] });
  }
  const archive = `tiles/${tileName}.bin`, fd = openSync(resolve(root, archive), 'w');
  let offset = 0;
  const save = (kind: string, origin: number[], size: number[], scale: number, data: Uint32Array) => {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const packed = gzipSync(bytes, { level: 1 });
    const record = { id: key(kind, ...origin as [number,number,number]), kind, origin, size, scale, archive,
      offset, length: packed.length, rawBytes: bytes.length };
    writeSync(fd, packed); offset += packed.length;
    const sector = sectors.get(`${Math.floor(origin[0] / sectorSize)}_${Math.floor(origin[2] / sectorSize)}`)!;
    if (kind === 'far') sector.far = record; else sector.records.push(record);
  };
  for (const [k, data] of solid) {
    const x = k % 16, z = Math.floor(k / 16) % 16, y = Math.floor(k / 256);
    save('solid', [wx + x * 32, y * 32, wz + z * 32], [32,32,32], 1, data);
  }
  for (const [k, data] of micro) {
    const x = k % 64, z = Math.floor(k / 64) % 64, y = Math.floor(k / 4096);
    save('micro', [wx + x * 8, y * 8, wz + z * 8], [64,64,64], .125, data);
  }
  for (let bz = 0; bz < 4; bz++) for (let bx = 0; bx < 4; bx++) {
    const data = new Uint32Array(16 * 32 * 16);
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) for (let y = 0; y < 32; y++) {
      const i = y + 32 * ((bx * 16 + x) + 64 * (bz * 16 + z));
      if (occupancy[i] >= 4) data[y + 32 * (x + 16 * z)] = coarse[i];
    }
    save('far', [wx + bx * sectorSize, 0, wz + bz * sectorSize], [16,32,16], 8, data);
  }
  closeSync(fd);
  for (const [id, sector] of sectors) writeFileSync(resolve(root, `sectors/${id}.json`), JSON.stringify(sector));
  const result = { schema: 3, world, seed, sourceSha256, tx, tz, solidCount, microCount,
    records: solid.size + micro.size, bytes: offset, seconds: (performance.now() - started) / 1000 };
  writeFileSync(metadata, JSON.stringify(result));
  return result;
}

if (process.argv.includes('--worker')) {
  process.on('message', (tile: [number, number]) => {
    try { process.send!({ result: exportTile(...tile) }); }
    catch (error) { process.send!({ error: String(error) }); }
  });
} else {
  // Keep previous worlds available locally while packaging only the active map.
  const active = resolve(root, 'manifest.json');
  const cache = resolve(project, '../.local/godot-worlds');
  if (existsSync(active)) {
    const previous = JSON.parse(readFileSync(active, 'utf8')).world;
    if (previous !== world) {
      mkdirSync(cache, { recursive: true });
      const destination = resolve(cache, previous);
      if (existsSync(destination)) throw new Error(`Cache already exists: ${destination}`);
      renameSync(root, destination);
    }
  }
  if (!existsSync(root) && existsSync(resolve(cache, world))) renameSync(resolve(cache, world), root);
  mkdirSync(resolve(root, 'tiles'), { recursive: true });
  mkdirSync(resolve(root, 'sectors'), { recursive: true });
  const tiles: [number,number][] = [];
  for (let z = 0; z < 4; z++) for (let x = 0; x < 32; x++) tiles.push([x,z]);
  tiles.sort((a,b) => Math.hypot(a[0]-16,a[1]-2) - Math.hypot(b[0]-16,b[1]-2));
  const results: any[] = [], started = performance.now();
  const workers = Number(process.argv.find(a => a.startsWith('--workers='))?.split('=')[1] ?? 2);
  await Promise.all(Array.from({ length: workers }, () => new Promise<void>((done, fail) => {
    const worker = fork(import.meta.filename, ['--worker', `--world=${world}`], { stdio: ['ignore','ignore','inherit','ipc'] });
    const next = () => { const tile = tiles.shift(); if (tile) worker.send(tile); else { worker.disconnect(); done(); } };
    worker.on('message', (message: any) => {
      if (message.error) { worker.kill(); fail(new Error(message.error)); return; }
      results.push(message.result);
      if (results.length % 4 === 0 || results.length === 1) console.log(`WORLD_EXPORT ${results.length}/128 tiles; ${(performance.now()-started)/1000|0}s`);
      next();
    });
    worker.on('error', fail); worker.on('exit', code => { if (code) fail(new Error(`Worker exited ${code}`)); });
    next();
  })));
  const zones = [];
  for (let z = 0; z < 16; z++) for (let x = 0; x < 128; x++) zones.push({ x, z, index: `sectors/${x}_${z}.json` });
  const manifest = { schema: 3, world, seed, sourceSha256, size: [16384,256,2048],
    spawn: world === 'copper-metropolis' ? [8200,128,1032] : [8192.5,180,1024.5], anchor, sectorSize, farVoxelSize: 8, zones,
    counts: { solid: results.reduce((n,r)=>n+r.solidCount,0), micro: results.reduce((n,r)=>n+r.microCount,0),
      records: results.reduce((n,r)=>n+r.records,0), bytes: results.reduce((n,r)=>n+r.bytes,0) },
    seconds: (performance.now()-started)/1000 };
  writeFileSync(resolve(root, 'manifest.json'), JSON.stringify(manifest));
  console.log('WORLD_EXPORT_COMPLETE', JSON.stringify({...manifest,zones:zones.length}));
}
