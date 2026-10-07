import type { DistantChunkSnapshot } from '../voxel/SurfaceZoneSnapshot.ts';

export type AuthoredSurfaceFaces = { quads: Float32Array; colors: Uint8Array; cellSize: number };
export type AuthoredSurfaceGeometry = { positions: Float32Array; normals: Float32Array;
  colors: Float32Array; indices: Uint32Array; cellSize: number; faces: number };
export const AUTHORED_CELL_SIZES = [4, 2, 1, .5, .25, .125] as const;
const LINEAR = Float32Array.from({length:256}, (_, value) => {
  const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
});

/** Occupied-volume filtering preserves floating solids and gaps. Only exposed
 * faces are emitted; no height-field fill or geometry below floating objects. */
export function meshAuthoredSurface(source: DistantChunkSnapshot, cellSize: number): AuthoredSurfaceFaces {
  if (!(AUTHORED_CELL_SIZES as readonly number[]).includes(cellSize)) throw new Error('Unsupported authored surface cell size');
  const step = cellSize * 8, nx = 128 / step;
  let top = 0;
  for (let at = 0; at < source.boxes.length; at += 6) top = Math.max(top, source.boxes[at + 1] + source.boxes[at + 4]);
  const ny = Math.ceil(top / step), dimensions = [nx, ny, nx], strides = [1, nx, nx * ny];
  const cells = new Uint32Array(nx * ny * nx), weights = new Float32Array(cells.length);
  for (let at = 0, c = 0; at < source.boxes.length; at += 6, c += 3) {
    const lo = [source.boxes[at], source.boxes[at + 1], source.boxes[at + 2]];
    const hi = lo.map((value, axis) => value + source.boxes[at + 3 + axis]);
    const start = lo.map(value => Math.floor(value / step)), end = hi.map(value => Math.ceil(value / step));
    for (let z = start[2]; z < end[2]; z++) for (let y = start[1]; y < end[1]; y++) for (let x = start[0]; x < end[0]; x++) {
      const weight = (Math.min(hi[0], (x + 1) * step) - Math.max(lo[0], x * step))
        * (Math.min(hi[1], (y + 1) * step) - Math.max(lo[1], y * step))
        * (Math.min(hi[2], (z + 1) * step) - Math.max(lo[2], z * step));
      const index = x + y * nx + z * nx * ny, previous = cells[index], oldWeight = weights[index];
      const total = oldWeight + weight;
      let color = 0x80000000;
      for (let channel = 0; channel < 3; channel++) {
        const shift = (2 - channel) * 8;
        color |= Math.round((((previous >>> shift) & 255) * oldWeight + source.colors[c + channel] * weight) / total) << shift;
      }
      cells[index] = color; weights[index] = total;
    }
  }
  const quads: number[] = [], colors: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3, width = dimensions[u], height = dimensions[v];
    const mask = new Uint32Array(width * height);
    for (let sign = 0; sign < 2; sign++) for (let plane = 0; plane < dimensions[axis]; plane++) {
      for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
        const index = plane * strides[axis] + i * strides[u] + j * strides[v], neighbor = plane + (sign ? 1 : -1);
        mask[i + j * width] = neighbor < 0 || neighbor >= dimensions[axis]
          || !cells[index + (sign ? strides[axis] : -strides[axis])] ? cells[index] : 0;
      }
      for (let j = 0; j < height; j++) for (let i = 0; i < width;) {
        const value = mask[i + j * width];
        if (!value) { i++; continue; }
        const limit = Math.max(1, (cellSize <= .25 ? 2 : 8) / cellSize);
        let w = 1, h = 1;
        while (w < limit && i + w < width && mask[i + w + j * width] === value) w++;
        outer: while (h < limit && j + h < height) {
          for (let k = 0; k < w; k++) if (mask[i + k + (j + h) * width] !== value) break outer;
          h++;
        }
        const p = [0, 0, 0]; p[axis] = plane + sign; p[u] = i; p[v] = j;
        quads.push(p[0] * cellSize, p[1] * cellSize, p[2] * cellSize, w * cellSize, h * cellSize, axis * 2 + sign);
        colors.push(value >>> 16 & 255, value >>> 8 & 255, value & 255);
        for (let k = 0; k < h; k++) mask.fill(0, i + (j + k) * width, i + w + (j + k) * width);
        i += w;
      }
    }
  }
  return { quads: Float32Array.from(quads), colors: Uint8Array.from(colors), cellSize };
}

/** Construct vertex buffers in the worker too; publication only adopts arrays. */
export function buildAuthoredSurface(source: DistantChunkSnapshot, cellSize: number): AuthoredSurfaceGeometry {
  const mesh = meshAuthoredSurface(source, cellSize), faces = mesh.quads.length / 6;
  const positions = new Float32Array(faces * 12), normals = new Float32Array(faces * 12), colors = new Float32Array(faces * 12);
  const indices = new Uint32Array(faces * 6);
  for (let i = 0; i < faces; i++) {
    const at = i * 6, direction = mesh.quads[at + 5], axis = direction >> 1, u = (axis + 1) % 3, v = (axis + 2) % 3;
    for (let corner = 0; corner < 4; corner++) {
      const vertex = i * 12 + corner * 3;
      positions[vertex] = mesh.quads[at] + source.chunkX * 16;
      positions[vertex + 1] = mesh.quads[at + 1]; positions[vertex + 2] = mesh.quads[at + 2] + source.chunkZ * 16;
      let a = corner === 1 || corner === 2 ? 1 : 0;
      if (!(direction & 1)) a = 1 - a;
      positions[vertex + u] += a * mesh.quads[at + 3];
      positions[vertex + v] += (corner >= 2 ? 1 : 0) * mesh.quads[at + 4];
      normals[vertex + axis] = direction & 1 ? 1 : -1;
      for (let channel = 0; channel < 3; channel++) colors[vertex + channel] = LINEAR[mesh.colors[i * 3 + channel]];
    }
    indices.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  return { positions, normals, colors, indices, cellSize, faces };
}
