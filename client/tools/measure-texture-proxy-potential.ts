/** Offline geometric potential only: no texture baking, image-quality or GPU/FPS result. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Chunk } from '../../engine/src/voxel/Chunk.ts';
import { TerrainGenerator } from '../../engine/src/worldgen/TerrainGenerator.ts';
import { meshVoxelBrick, reduceVoxelBrick } from '../../engine/src/worldgen/VoxelSurfaceGenerator.ts';
import { bendTorusPoint } from '../../engine/src/torus/TorusWorld.ts';

type Counts = { faces: number; area: number; emissionArea: number };
const empty = (): Counts => ({ faces: 0, area: 0, emissionArea: 0 });
const add = (a: Counts, b: Counts) => { a.faces += b.faces; a.area += b.area; a.emissionArea += b.emissionArea; };
// Preserve emission partitions. Only ignore RGB equality; future textures must restore RGB.
function countMerged(data: Uint32Array, axis: number, size: number, maxEdge: number, ignoreColor: boolean) {
  const result = empty(), strides = [1, axis, axis * axis];
  const mask = new Uint32Array(axis * axis), cap = Math.max(1, Math.floor(maxEdge / size));
  let expectedArea = 0, expectedEmission = 0;
  for (let dim = 0; dim < 3; dim++) {
    const u = (dim + 1) % 3, v = (dim + 2) % 3;
    for (let sign = 0; sign < 2; sign++) for (let plane = 0; plane < axis; plane++) {
      for (let j = 0; j < axis; j++) for (let i = 0; i < axis; i++) {
        const at = plane * strides[dim] + i * strides[u] + j * strides[v];
        const value = data[at], neighbor = plane + (sign ? 1 : -1);
        const exposed = value && (neighbor < 0 || neighbor >= axis || !data[at + (sign ? 1 : -1) * strides[dim]]);
        mask[i + j * axis] = exposed ? (ignoreColor ? (0x80000000 | value & 0x01000000) >>> 0 : value) : 0;
        if (exposed) { expectedArea += size * size; if (value >>> 24 & 1) expectedEmission += size * size; }
      }
      for (let j = 0; j < axis; j++) for (let i = 0; i < axis;) {
        const value = mask[i + j * axis];
        if (!value) { i++; continue; }
        let w = 1, h = 1;
        while (w < cap && i + w < axis && mask[i + w + j * axis] === value) w++;
        outer: while (h < cap && j + h < axis) {
          for (let k = 0; k < w; k++) if (mask[i + k + (j + h) * axis] !== value) break outer;
          h++;
        }
        result.faces++; result.area += w * h * size * size;
        if (value >>> 24 & 1) result.emissionArea += w * h * size * size;
        for (let y = 0; y < h; y++) {
          // Every patch covers only equal nonempty material tokens, exactly once.
          for (let x = 0; x < w; x++) assert.equal(mask[i + x + (j + y) * axis], value);
          mask.fill(0, i + (j + y) * axis, i + w + (j + y) * axis);
        }
        i += w;
      }
      assert.ok(mask.every(v => v === 0));
    }
  }
  assert.equal(result.area, expectedArea);
  assert.equal(result.emissionArea, expectedEmission);
  return result;
}

const samples = [
  [16, 2, 0, 0], [16, 2, 3, 2], [16, 2, 4, 4], [16, 2, 7, 7],
  [8, 1, 1, 1], [8, 1, 6, 5], [24, 3, 2, 6], [24, 3, 5, 2],
];
const worlds = [];
for (const [world, seed, version] of [['aether-archipelago', 42, 3], ['nature', 42, 1], ['copper-metropolis', 20260922, 2]] as const) {
  const generator = new TerrainGenerator(seed, version), chunk = new Chunk(0, 0, null);
  const rows = Array.from({ length: 7 }, (_, level) => ({ cellSize: 2 ** level, bricks: 0, original: empty(),
    colorFree8: empty(), colorFree16: empty(), colorFree32: empty(), colorFree64: empty() }));
  const perSample = [];
  for (const [zx, zz, bx, bz] of samples) {
    const bricks = Array.from({ length: 4 }, () => new Uint32Array(64 ** 3));
    for (let cx = 0; cx < 4; cx++) for (let cz = 0; cz < 4; cz++) {
      chunk.reuseAt(zx * 32 + bx * 4 + cx, zz * 32 + bz * 4 + cz, null);
      generator.generateChunk(chunk);
      for (let y = 0; y <= (chunk.getOccupiedYRange()?.max ?? -1); y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        const at = Chunk.getIndex(x, y, z); if (!chunk.blocks[at]) continue;
        bricks[y >> 6][cx * 16 + x + (y & 63) * 64 + (cz * 16 + z) * 4096] =
          (0x80000000 | chunk.colors[at] | chunk.materials[at] << 24) >>> 0;
      }
      for (let i = 0; i < chunk.terrainDetails.length; i += 4) {
        const [mx, my, mz, value] = chunk.terrainDetails.subarray(i, i + 4), y = my >> 3;
        const at = cx * 16 + (mx >> 3) + (y & 63) * 64 + (cz * 16 + (mz >> 3)) * 4096;
        if (!bricks[y >> 6][at]) bricks[y >> 6][at] = (0x80000000 | value) >>> 0;
      }
    }
    const detail = rows.map(row => ({ cellSize: row.cellSize, original: 0, colorFree8: 0, colorFree16: 0, colorFree32: 0, colorFree64: 0 }));
    for (let by = 0; by < 4; by++) {
      if (!bricks[by].some(Boolean)) continue;
      let data: Uint32Array = bricks[by];
      for (let level = 0, axis = 64; level < 7; level++, axis /= 2) {
        const row = rows[level], size = row.cellSize, production = empty();
        meshVoxelBrick(data, axis, size, [0, 0, 0], (_x, _y, _z, w, h, _dir, value) => {
          production.faces++; production.area += w * h;
          if (value >>> 24 & 1) production.emissionArea += w * h;
        });
        assert.deepEqual(countMerged(data, axis, size, 8, false), production, 'Reference must match production mesher');
        add(row.original, production); detail[level].original += production.faces; row.bricks++;
        for (const cap of [8, 16, 32, 64] as const) {
          const measured = countMerged(data, axis, size, cap, true), key = `colorFree${cap}` as const;
          assert.equal(measured.area, production.area); assert.equal(measured.emissionArea, production.emissionArea);
          add(row[key], measured); detail[level][key] += measured.faces;
        }
        if (axis > 1) data = reduceVoxelBrick(data, axis);
      }
    }
    perSample.push({ zone: [zx, zz], column: [bx, bz], rows: detail });
  }
  worlds.push({ world, seed, version, rows, perSample });
  console.log(JSON.stringify({ world, rows: rows.map(r => ({ size: r.cellSize, original: r.original.faces,
    cap8: r.colorFree8.faces, cap16: r.colorFree16.faces, cap32: r.colorFree32.faces, cap64: r.colorFree64.faces })) }));
}

// Analytic mapping sampled against the two triangles of one horizontal proxy patch.
// Finite samples are a diagnostic, NOT a conservative maximum-error guarantee.
const curvature = [];
for (const height of [16, 128, 255]) for (const edge of [8, 16, 32, 64]) {
  let maxError = 0;
  for (let z = 0; z < 2048; z += 16) {
    const corners = [[0, 0], [edge, 0], [edge, edge], [0, edge]].map(([dx, dz]) => bendTorusPoint(8192 + dx, height, z + dz).toArray());
    for (const u of [.25, .5, .75]) for (const v of [.25, .5, .75]) {
      const weights = u >= v ? [1 - u, u - v, v, 0] : [1 - v, 0, u, v - u];
      const planar = [0, 1, 2].map(d => corners.reduce((sum, p, i) => sum + weights[i] * p[d], 0));
      const exact = bendTorusPoint(8192 + u * edge, height, z + v * edge).toArray();
      maxError = Math.max(maxError, Math.hypot(...exact.map((p, i) => p - planar[i])));
    }
  }
  curvature.push({ height, edge, sampledMaxErrorMeters: maxError });
}
const output = resolve(process.argv[2] ?? 'client/src/dev/results/texture-proxy-study-2026-11-05/meshing.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ date: '2026-11-05', samples, worlds, curvature,
  limitations: [
    'Eight deterministic 64x256x64 columns in three zones per world; not representative of all worlds or camera-selected geometry.',
    'Colors are ignored for counting only. No texture has been baked or rendered; restoration quality and texture costs are unmeasured.',
    'Coplanar occupied coverage and emission partitions are retained in flat coordinates; larger patches alter curved interpolation.',
    'Counts omit UV seams, atlas fragmentation, conforming boundary repair, culling losses and extra curvature subdivision.',
    'Curvature is sampled in the global torus mapping on horizontal patches; not a bound for every orientation or local view correction.',
    'No FPS, GPU, runtime baking, memory residency or loading-speed benchmark is performed.',
  ] }, null, 2) + '\n');
console.log(JSON.stringify({ output, curvature }));
