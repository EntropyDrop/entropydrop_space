import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { generateAetherRegion } from '../../engine/src/worldgen/AetherArchipelagoGenerator.ts';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path));
const manifest = JSON.parse(read('data/manifest.json').toString());
assert.equal(createHash('sha256').update(read('../engine/src/worldgen/AetherArchipelagoGenerator.ts')).digest('hex'), manifest.sourceSha256);
const source = generateAetherRegion(manifest.config, true);
const { sizeX: sx, sizeZ: sz, sizeY: sy } = manifest.config;
const rgba = (color: number, emission: number) => ((color << 8) | (emission ? 254 : 255)) >>> 0;
const palette = source.palette.map(p => rgba(p.color, p.emission)); palette[0] = 0;
const micro = new Map<number, number>();
const key = (x: number, y: number, z: number) => y + sy * 8 * (x + sx * 8 * z);
for (let i = 0; i < source.details.length; i += 4) {
  const [x, y, z, color] = source.details.subarray(i, i + 4);
  micro.set(key(x, y, z), rgba(color & 0xffffff, color >>> 24));
}
let samples = 0, random = 42;
const next = (n: number) => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % n; };
for (const record of manifest.records) {
  const raw = gunzipSync(read(`data/${record.file}`));
  assert.equal(raw.length, record.rawBytes);
  assert.equal(createHash('sha256').update(raw).digest('hex'), record.sha256);
  const n = record.padded;
  const origin = [(record.origin[0] + sx / 2) / record.scale, record.origin[1] / record.scale, (record.origin[2] + sz / 2) / record.scale];
  // Sample interiors and all six neighbour halos against a fresh canonical map.
  for (let i = 0; i < 96; i++) {
    const point = [next(n), next(n), next(n)];
    if (i < 6) point[i % 3] = i < 3 ? 0 : n - 1;
    const [x, y, z] = point.map((v, axis) => origin[axis] + v - 1);
    let expected = 0;
    if (record.kind === 'solid') {
      if (x >= 0 && x < sx && y >= 0 && y < sy && z >= 0 && z < sz) expected = palette[source.cells[x + sx * (z + sz * y)]];
    } else if (x >= 0 && x < sx * 8 && y >= 0 && y < sy * 8 && z >= 0 && z < sz * 8) {
      expected = micro.get(key(x, y, z)) ?? 0;
    }
    assert.equal(raw.readUInt32LE(4 * (point[1] + n * (point[0] + n * point[2]))), expected, `${record.file}: ${point}`);
    samples++;
  }
}
const baked = JSON.parse(read('baked/manifest.json').toString());
assert.equal(baked.sourceSha256, manifest.sourceSha256);
const binary = read('baked/surfaces.bin');
let cursor = 0, triangles = 0;
for (const surface of baked.surfaces) {
  assert.equal(surface.offset, cursor);
  assert.equal(surface.indices % 3, 0);
  for (let i = 0; i < surface.vertices * 7; i++) assert(Number.isFinite(binary.readFloatLE(cursor + i * 4)));
  cursor += surface.vertices * 28;
  for (let i = 0; i < surface.indices; i++) assert(binary.readUInt32LE(cursor + i * 4) < surface.vertices);
  cursor += surface.indices * 4;
  triangles += surface.indices / 3;
}
assert.equal(cursor, binary.length);
assert.equal(triangles, baked.triangles);
console.log(JSON.stringify({ chunks: manifest.records.length, canonicalVoxelSamples: samples, uniqueMicroVoxels: micro.size,
  triangles, binaryBytes: binary.length, sourceSha256: manifest.sourceSha256, result: 'PASS' }, null, 2));
