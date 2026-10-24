import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { AETHER_DEFAULTS, aetherSpawnAnchor, generateAetherRegion } from '../../engine/src/worldgen/AetherArchipelagoGenerator.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const size = Number(process.argv.find(a => a.startsWith('--size='))?.split('=')[1] ?? 512);
if (!Number.isInteger(size) || size < 64 || size > 1024 || size % 32) throw new Error('Size must be a multiple of 32 from 64 to 1024.');
const seed = 42, height = 192, anchor = aetherSpawnAnchor(seed), half = size / 2;
const config = { ...AETHER_DEFAULTS, seed, sizeX: size, sizeZ: size, sizeY: height,
  yCutoff: height, offsetX: anchor.x, offsetZ: anchor.z };
const started = performance.now();
console.log(`Generating canonical Aether seed ${seed}, ${size} x ${height} x ${size}, with all micro details.`);
const region = generateAetherRegion(config, true);
const out = resolve(root, 'data');
mkdirSync(out, { recursive: true });
const records: any[] = [];
const rgba = (rgb: number, emission: number) => ((rgb << 8) | (emission ? 254 : 255)) >>> 0;
const palette = region.palette.map(p => rgba(p.color, p.emission > 0 ? 1 : 0));
palette[0] = 0;
const get = (x: number, y: number, z: number) => x < 0 || x >= size || z < 0 || z >= size || y < 0 || y >= height
  ? 0 : palette[region.cells[x + z * size + y * size * size]];
let solidCount = 0, solidEmission = 0;
for (const id of region.cells) if (id) { solidCount++; if (region.palette[id].emission) solidEmission++; }

function save(name: string, kind: string, origin: number[], scale: number, inner: number, bytes: Buffer, count: number) {
  const file = `${name}.rgba.gz`;
  const compressed = gzipSync(bytes, { level: 6 });
  writeFileSync(resolve(out, file), compressed);
  records.push({ file, kind, origin, scale, inner, padded: inner + 2, rawBytes: bytes.length, occupied: count,
    sha256: createHash('sha256').update(bytes).digest('hex') });
}

// VoxelBuffer stores Y fastest, then X, then Z. Preserve neighbour halos.
for (let bz = 0; bz < size; bz += 32) for (let by = 0; by < height; by += 32) for (let bx = 0; bx < size; bx += 32) {
  const n = 34, raw = Buffer.alloc(n * n * n * 4);
  let count = 0;
  for (let z = -1; z <= 32; z++) for (let x = -1; x <= 32; x++) for (let y = -1; y <= 32; y++) {
    const color = get(bx + x, by + y, bz + z);
    if (!color) continue;
    raw.writeUInt32LE(color, ((y + 1) + n * ((x + 1) + n * (z + 1))) * 4);
    if (x >= 0 && x < 32 && y >= 0 && y < 32 && z >= 0 && z < 32) count++;
  }
  if (count) save(`solid_${bx}_${by}_${bz}`, 'solid', [bx - half, by, bz - half], 1, 32, raw, count);
}
console.log(`Exported ${solidCount.toLocaleString()} solid voxels in ${records.length} chunks.`);

type Point = [number, number, number, number];
const groups = new Map<string, Point[]>();
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
for (let i = 0; i < region.details.length; i += 4) {
  const x = region.details[i], y = region.details[i + 1], z = region.details[i + 2], packed = region.details[i + 3];
  const k = key(x >> 6, y >> 6, z >> 6);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push([x, y, z, rgba(packed & 0xffffff, packed >>> 24)]);
}
let microEmission = 0;
for (let i = 3; i < region.details.length; i += 4) if (region.details[i] >>> 24) microEmission++;
for (const [k, points] of groups) {
  const [gx, gy, gz] = k.split(',').map(Number), bx = gx * 64, by = gy * 64, bz = gz * 64;
  const n = 66, raw = Buffer.alloc(n * n * n * 4);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    for (const [wx, wy, wz, color] of groups.get(key(gx + dx, gy + dy, gz + dz)) ?? []) {
      const x = wx - bx + 1, y = wy - by + 1, z = wz - bz + 1;
      if (x >= 0 && x < n && y >= 0 && y < n && z >= 0 && z < n)
        raw.writeUInt32LE(color, (y + n * (x + n * z)) * 4);
    }
  }
  save(`micro_${gx}_${gy}_${gz}`, 'micro', [bx / 8 - half, by / 8, bz / 8 - half], .125, 64, raw, points.length);
}
const source = resolve(root, '../engine/src/worldgen/AetherArchipelagoGenerator.ts');
const manifest = {
  schema: 1, world: 'aether-archipelago', generatorVersion: 3, seed, config, anchor,
  source: 'engine/src/worldgen/AetherArchipelagoGenerator.ts', sourceSha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
  bounds: { min: [-half, 0, -half], max: [half, height, half] },
  counts: { solid: solidCount, micro: region.details.length / 4, solidEmission, microEmission, chunks: records.length },
  projection: 'flat crop around the canonical spawn; no torus bending',
  colorEncoding: 'uint32 little-endian 0xRRGGBBAA; A=255 solid, A=254 opaque emissive, A=0 air',
  voxelOrder: 'y + padded * (x + padded * z)', records,
};
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ ...manifest.counts, seconds: (performance.now() - started) / 1000 }));
