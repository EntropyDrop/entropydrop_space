import type { VoxelLodTile } from './VoxelLodPlanner.ts';

export const VOXEL_BAKE_SIZE = 256;
export const VOXEL_BAKE_FLAG = 128;
export interface VoxelTextureBakeSettings {
  textureProxyEnabled: boolean;
  textureProxyEdge: number;
  textureProxyDensity: number;
  textureProxyDistance: number;
  textureProxyBudgetMiB: number;
  textureProxyLinear: boolean;
  /** Extra geometry LOD levels; texture detail stays at the selected source LOD. */
  textureProxyLodBias: number;
}
export const DEFAULT_VOXEL_TEXTURE_BAKE: Readonly<VoxelTextureBakeSettings> = Object.freeze({
  // Browser measurements reduce residency but do not establish a consistent
  // frame-time benefit. Opt in with a source-topology-preserving 32 m preset.
  textureProxyEnabled: false, textureProxyEdge: 32, textureProxyDensity: 1,
  textureProxyDistance: 384, textureProxyBudgetMiB: 32, textureProxyLinear: false,
  textureProxyLodBias: 0,
});
export type BakedVoxelTile = Pick<VoxelLodTile, 'count' | 'offset' | 'span' | 'direction' | 'emission' | 'color' | 'visibility'>
  & { pixels: Uint8Array; atlasSize: number; patches: number; originalFaces: number };
type Face = { p: number[]; w: number; h: number; dir: number; emission: number; rgb: number };
type Plane = { p: number[]; dir: number; cells: Uint32Array; };

/** Coplanar color baking in flat coordinates. Occupancy, emission and holes are
 * preserved. A bounded atlas and a net face reduction are required; otherwise
 * callers retain the complete original tile. No source snapshot is mutated. */
export function* bakeVoxelTile(tile: VoxelLodTile, edge = 8, density = 1, detail = tile, projectionDepth = 0): Generator<void, BakedVoxelTile | undefined> {
  if (![8, 16, 24, 32].includes(edge) || ![1, 2].includes(density)) throw new Error('Invalid voxel bake dimensions');
  // One texel per selected voxel cell is lossless. Distant 4/8 m cells must
  // not consume 16/64 duplicate texels merely because near cells use 1 m.
  let cell = 8;
  for (let i = 0; i < detail.count; i++) {
    const dim = detail.direction[i] >> 1;
    const values = [detail.span[i * 2] / 8, detail.span[i * 2 + 1] / 8,
      detail.offset[i * 3 + (dim + 1) % 3] / 8, detail.offset[i * 3 + (dim + 2) % 3] / 8];
    while (cell > 1 && values.some(v => v % cell)) cell /= 2;
    if ((i & 255) === 255) yield;
  }
  // Six orthographic projections preserve source color detail independently of
  // proxy geometry. Keep depth layers: an island's roof must not paint its cave.
  const rays = new Map<number, number[]>(), rayKey = (dir: number, u: number, v: number) => (dir * 1024 + u / cell) * 1024 + v / cell;
  if (detail !== tile) for (let i = 0; i < detail.count; i++) {
    const dir = detail.direction[i], dim = dir >> 1, u = (dim + 1) % 3, v = (dim + 2) % 3;
    const p = [detail.offset[i * 3] / 8, detail.offset[i * 3 + 1] / 8, detail.offset[i * 3 + 2] / 8];
    const value = (0x80000000 | detail.emission[i] << 24 | detail.color[i * 3] | detail.color[i * 3 + 1] << 8 | detail.color[i * 3 + 2] << 16) >>> 0;
    for (let y = p[v]; y < p[v] + detail.span[i * 2 + 1] / 8; y += cell) {
      for (let x = p[u]; x < p[u] + detail.span[i * 2] / 8; x += cell) {
        const key = rayKey(dir, x, y), ray = rays.get(key);
        if (ray) ray.push(p[dim], value); else rays.set(key, [p[dim], value]);
      }
      yield;
    }
  }
  const side = edge / cell;
  const planes = new Map<string, Plane>(), retained: Face[] = [];
  for (let i = 0; i < tile.count; i++) {
    const p = Array.from(tile.offset.subarray(i * 3, i * 3 + 3), v => v / 8);
    const w = tile.span[i * 2] / 8, h = tile.span[i * 2 + 1] / 8, dir = tile.direction[i];
    const emission = tile.emission[i], rgb = tile.color[i * 3] | tile.color[i * 3 + 1] << 8 | tile.color[i * 3 + 2] << 16;
    if (dir > 5 || p.some(v => !Number.isInteger(v)) || !Number.isInteger(w) || !Number.isInteger(h)) return;
    if (w > edge || h > edge) { retained.push({ p, w, h, dir, emission, rgb }); continue; }
    const dim = dir >> 1, u = (dim + 1) % 3, v = (dim + 2) % 3;
    for (let y = p[v]; y < p[v] + h; y += cell) for (let x = p[u]; x < p[u] + w; x += cell) {
      const gx = Math.floor(x / edge) * edge, gy = Math.floor(y / edge) * edge;
      const key = `${dir}/${p[dim]}/${gx}/${gy}`;
      let plane = planes.get(key);
      if (!plane) {
        const origin = [...p]; origin[u] = gx; origin[v] = gy;
        plane = { p: origin, dir, cells: new Uint32Array(side * side) }; planes.set(key, plane);
      }
      const at = (x - gx) / cell + (y - gy) / cell * side;
      // A malformed/overlapping source must never silently lose a face.
      if (plane.cells[at]) return;
      let value = (0x80000000 | emission << 24 | rgb) >>> 0;
      const ray = rays.get(rayKey(dir, x, y));
      if (ray) {
        let distance = projectionDepth + .001;
        for (let k = 0; k < ray.length; k += 2) {
          const next = Math.abs(ray[k] - p[dim]);
          if (next < distance && (ray[k + 1] >>> 24 & 1) === emission) { distance = next; value = ray[k + 1]; }
        }
      }
      plane.cells[at] = value;
    }
    if ((i & 255) === 255) yield;
  }
  const faces = retained, charts: { face: Face; plane: Plane; x: number; y: number; w: number; h: number; ox: number; oy: number }[] = [];
  for (const plane of planes.values()) {
    const cells = plane.cells, visited = new Uint8Array(cells.length), dim = plane.dir >> 1;
    const u = (dim + 1) % 3, v = (dim + 2) % 3;
    for (let y = 0; y < side; y++) for (let x = 0; x < side;) {
      const value = cells[x + y * side];
      if (!value || visited[x + y * side]) { x++; continue; }
      const token = value & 0xff000000;
      const matches = (px: number, py: number) => !visited[px + py * side] && (cells[px + py * side] & 0xff000000) === token;
      let w = 1, h = 1;
      while (x + w < side && matches(x + w, y)) w++;
      outer: while (y + h < side) {
        for (let k = 0; k < w; k++) if (!matches(x + k, y + h)) break outer;
        h++;
      }
      let uniform = true;
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
        uniform &&= cells[x + dx + (y + dy) * side] === value;
        visited[x + dx + (y + dy) * side] = 1;
      }
      const p = [...plane.p]; p[u] += x * cell; p[v] += y * cell;
      const face: Face = { p, w: w * cell, h: h * cell, dir: plane.dir, emission: value >>> 24 & 1, rgb: value & 0xffffff };
      if (!uniform) {
        face.dir |= VOXEL_BAKE_FLAG;
        charts.push({face, plane, x, y, w, h, ox: 0, oy: 0});
      }
      faces.push(face);
      x += w;
    }
    yield;
  }
  if (!charts.length || faces.length > detail.count * .8) return;
  // Pack charts first, then lease only a 64/128/256 square. Small far tiles
  // share array layers instead of exhausting one whole 256-square layer each.
  charts.sort((a, b) => b.h - a.h || b.w - a.w);
  let atlasSize = 0;
  for (const size of [64, 128, VOXEL_BAKE_SIZE]) {
    let sx = 0, sy = 0, height = 0, fits = true;
    for (const chart of charts) {
      const w = chart.w * density + 2, h = chart.h * density + 2;
      if (sx + w > size) { sy += height; sx = height = 0; }
      if (w > size || sy + h > size) { fits = false; break; }
      chart.ox = sx + 1; chart.oy = sy + 1; sx += w; height = Math.max(height, h);
    }
    if (fits) { atlasSize = size; break; }
  }
  if (!atlasSize) return;
  const pixels = new Uint8Array(atlasSize * atlasSize * 4);
  for (const {face, plane, x, y, w, h, ox, oy} of charts) {
    const pw = w * density, ph = h * density;
    // Replicated borders isolate level-zero bilinear samples between charts.
    for (let py = -1; py <= ph; py++) for (let px = -1; px <= pw; px++) {
      const sx = Math.min(w - 1, Math.max(0, Math.floor(px / density)));
      const sy = Math.min(h - 1, Math.max(0, Math.floor(py / density)));
      const color = plane.cells[x + sx + (y + sy) * side], at = ((oy + py) * atlasSize + ox + px) * 4;
      pixels.set([color & 255, color >>> 8 & 255, color >>> 16 & 255, 255], at);
    }
    face.rgb = ox | oy << 8 | (density * 8 / cell) << 16;
    yield;
  }
  const count = faces.length, offset = new Uint16Array(count * 3), span = new Uint16Array(count * 2);
  const direction = new Uint8Array(count), emission = new Uint8Array(count), color = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    const f = faces[i]; offset.set(f.p.map(v => v * 8), i * 3); span.set([f.w * 8, f.h * 8], i * 2);
    direction[i] = f.dir; emission[i] = f.emission; color.set([f.rgb & 255, f.rgb >>> 8 & 255, f.rgb >>> 16 & 255], i * 3);
  }
  return { count, offset, span, direction, emission, color, pixels, atlasSize, patches: charts.length, originalFaces: detail.count };
}
