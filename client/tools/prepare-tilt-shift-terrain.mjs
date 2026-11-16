import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { decodeVoxelCache } from '../../native-space/tools/distant-cache.ts';
import { bendTorusPoint, computeBentBoundsSphere } from '../../engine/src/torus/TorusWorld.ts';
import { SURFACE_AREA_HYSTERESIS, surfaceSubdivisionWorldArea } from '../../engine/src/render/SurfaceSubdivision.ts';
import { encodeVoxelLevels, VOXEL_LOD_SIZES } from '../../engine/src/worldgen/VoxelSurfaceGenerator.ts';

const world = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2]) + '/')
  : new URL('../../native-space/data/worlds/aether-archipelago/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', world), 'utf8'));
if (manifest.world !== 'aether-archipelago' || manifest.seed !== 42 || manifest.generator !== 3 ||
    !/^[a-f0-9]{64}$/.test(manifest.source_hash)) throw new Error('Unexpected cache identity.');
const source = new URL('distant/' + manifest.source_hash + '/', world);
const target = new URL('../../.local/aether-tilt-shift/terrain/', import.meta.url);
await mkdir(target, { recursive: true });
const origin = bendTorusPoint(8192.5, 180, 1024.5);
const focalUpperBound = 500;
const motionMargin = 55;
const areaLowerBound = 64 * SURFACE_AREA_HYSTERESIS;
const sizes = [...VOXEL_LOD_SIZES].reverse();

function finestRequired(zoneX, zoneZ) {
  let finest = 64;
  for (let bx = 0; bx < 8; bx++) for (let bz = 0; bz < 8; bz++) for (let by = 0; by < 4; by++) {
    const x = zoneX * 512 + bx * 64, y = by * 64, z = zoneZ * 512 + bz * 64;
    const sphere = computeBentBoundsSphere({ minX: x, maxX: x + 64, minY: y, maxY: y + 64, minZ: z, maxZ: z + 64 }, undefined, 'torus');
    const distance = Math.max(1, origin.distanceTo(sphere.center) - sphere.radius - motionMargin);
    const chosen = sizes.find(size => surfaceSubdivisionWorldArea(size, y + size, y) * (focalUpperBound / distance) ** 2 <= areaLowerBound) ?? 1;
    finest = Math.min(finest, chosen);
    if (finest === 1) return finest;
  }
  return finest;
}

function encodeSnapshot(x, z, levels) {
  const { cellSize, faces } = levels[0];
  const axis = 512 / cellSize;
  const records = new Uint8Array(axis * axis * 8);
  const recordView = new DataView(records.buffer);
  const view = new DataView(faces.buffer, faces.byteOffset, faces.byteLength);
  const unit = cellSize * 8;
  // The height lattice is metadata. Rendered geometry comes from the exact cached faces.
  for (let offset = 0; offset < faces.length; offset += 16) {
    if (faces[offset + 10] !== 3) continue;
    const cx = view.getUint16(offset, true) / unit;
    const cz = view.getUint16(offset + 4, true) / unit;
    const height = view.getUint16(offset + 2, true);
    const width = view.getUint16(offset + 6, true) / unit;
    const length = view.getUint16(offset + 8, true) / unit;
    for (let dx = 0; dx < length; dx++) for (let dz = 0; dz < width; dz++) {
      const at = ((cx + dx) * axis + cz + dz) * 8;
      if (recordView.getUint16(at, true) > height) continue;
      recordView.setUint16(at, height, true);
      records.set(faces.subarray(offset + 12, offset + 15), at + 4);
    }
  }
  const voxel = encodeVoxelLevels(levels);
  const data = new Uint8Array(36 + records.length + voxel.length);
  const header = new DataView(data.buffer);
  data.set([69, 68, 83, 90, 7, cellSize, 32, 8]);
  header.setUint16(8, x, true);
  header.setUint16(10, z, true);
  header.setInt32(12, manifest.seed, true);
  header.setUint32(16, manifest.generator, true);
  header.setUint32(28, axis * axis, true);
  data.set(records, 32);
  data.set(voxel, 36 + records.length);
  return data;
}

const zones = [];
for (let x = 0; x < 32; x++) for (let z = 0; z < 4; z++) {
  const name = x + '_' + z;
  const finest = finestRequired(x, z);
  const all = decodeVoxelCache(gunzipSync(await readFile(new URL(name + '.vxl.gz', source))));
  if (all.map(mip => mip.cellSize).join(',') !== VOXEL_LOD_SIZES.join(','))
    throw new Error('Incomplete mip chain: ' + name);
  const levels = all.filter(mip => mip.cellSize >= finest);
  const data = encodeSnapshot(x, z, levels);
  await writeFile(new URL(name + '.edsz.gz', target), gzipSync(data, { level: 1 }));
  zones.push({ x, z, finest, bytes: data.length, coarsestFaces: levels.at(-1).faces.length / 16 });
  if (zones.length % 16 === 0) console.log(zones.length + '/128 districts prepared');
}
await writeFile(new URL('index.json', target), JSON.stringify({ ...manifest, focalUpperBound, motionMargin, areaLowerBound, zones }, null, 2));
console.log('Retained ' + (zones.reduce((n, z) => n + z.bytes, 0) / 1048576).toFixed(1) + ' MiB of required voxel mips.');
