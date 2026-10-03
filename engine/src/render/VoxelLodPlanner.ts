import * as THREE from 'three';
import { computeBentBoundsSphere } from '../torus/TorusWorld.ts';
import { surfaceSubdivisionWorldArea, SURFACE_AREA_HYSTERESIS } from './SurfaceSubdivision.ts';
import type { VoxelSurfaceMip } from '../voxel/SurfaceZoneSnapshot.ts';

export type VoxelLodSource = { key: string; x: number; z: number; token: number; mips: VoxelSurfaceMip[] };
export type VoxelLodView = { camera: [number, number, number]; focal: number; area: number;
  distance: number; faceBudget: number; hasView: boolean };
export type VoxelLodStats = { faces: number; budget: number; requestedAreaPx2: number; effectiveAreaPx2: number };
export type VoxelLodTile = { key: string; token: number; tile: number; count: number;
  bounds: [number, number, number, number]; offset: Uint16Array; span: Uint16Array;
  flatBounds: [number, number, number, number];
  color: Uint8Array; direction: Uint8Array; emission: Uint8Array };
type Range = { start: number; end: number };
type Brick = { x: number; y: number; z: number; size: number; bounds: THREE.Sphere };
type Zone = { source: VoxelLodSource; mips: Map<number, { faces: Uint8Array; ranges: Map<number, Range> }>;
  sizes: number[]; bricks: Map<number, Brick>; signatures: Map<number, string> };
const LINEAR = Uint8Array.from({ length: 256 }, (_, n) => Math.round(255 * (n / 255 <= .04045
  ? n / 255 / 12.92 : ((n / 255 + .055) / 1.055) ** 2.4)));
export const voxelTileBytes = (tile: VoxelLodTile) => tile.count * 15;
export const voxelTileTransfers = (tile: VoxelLodTile) =>
  [tile.offset.buffer, tile.span.buffer, tile.color.buffer, tile.direction.buffer, tile.emission.buffer] as ArrayBuffer[];

/** No scene objects or GPU resources. Yield boundaries also serve the cooperative
 * fallback when workers are unavailable. Sources remain immutable after install. */
export class VoxelLodPlanner {
  private readonly zones = new Map<string, Zone>();
  private readonly indices = new WeakMap<VoxelSurfaceMip[], { mips: Zone['mips'];
    bricks: { id: number; x: number; y: number; z: number }[] }>();

  *install(source: VoxelLodSource): Generator<void> {
    const previous = this.zones.get(source.key), mips: Zone['mips'] = new Map(), bricks = new Map<number, Brick>();
    const cached = this.indices.get(source.mips);
    if (cached) {
      for (const { id, x, y, z } of cached.bricks) {
        bricks.set(id, { x, y, z, size: previous?.bricks.get(id)?.size ?? 64,
          bounds: computeBentBoundsSphere({ minX: source.x * 512 + x * 64, maxX: source.x * 512 + (x + 1) * 64,
            minY: y * 64, maxY: (y + 1) * 64, minZ: source.z * 512 + z * 64, maxZ: source.z * 512 + (z + 1) * 64 }) });
        if (bricks.size % 64 === 0) yield;
      }
      this.zones.set(source.key, { source, mips: cached.mips, sizes: [...cached.mips.keys()].sort((a, b) => b - a),
        bricks, signatures: new Map() });
      return;
    }
    for (const mip of source.mips) {
      const view = new DataView(mip.faces.buffer, mip.faces.byteOffset, mip.faces.byteLength);
      const ranges = new Map<number, Range>();
      for (let at = 0; at < mip.faces.length; at += 16) {
        const direction = mip.faces[at + 10], axis = direction >> 1, adjust = direction & 1 ? -.5 : .5;
        const x = Math.floor((view.getUint16(at, true) + (axis === 0 ? adjust : 0)) / 512);
        const y = Math.floor((view.getUint16(at + 2, true) + (axis === 1 ? adjust : 0)) / 512);
        const z = Math.floor((view.getUint16(at + 4, true) + (axis === 2 ? adjust : 0)) / 512);
        const id = x * 32 + y * 8 + z, range = ranges.get(id);
        if (range) range.end = at + 16; else ranges.set(id, { start: at, end: at + 16 });
        if (!bricks.has(id)) bricks.set(id, { x, y, z, size: previous?.bricks.get(id)?.size ?? 64,
          bounds: computeBentBoundsSphere({ minX: source.x * 512 + x * 64, maxX: source.x * 512 + (x + 1) * 64,
            minY: y * 64, maxY: (y + 1) * 64, minZ: source.z * 512 + z * 64, maxZ: source.z * 512 + (z + 1) * 64 }) });
        if ((at & 16383) === 16368) yield;
      }
      mips.set(mip.cellSize, { faces: mip.faces, ranges });
      yield;
    }
    this.zones.set(source.key, { source, mips, sizes: [...mips.keys()].sort((a, b) => b - a), bricks, signatures: new Map() });
    this.indices.set(source.mips, { mips, bricks: [...bricks].map(([id, { x, y, z }]) => ({ id, x, y, z })) });
  }

  remove(key: string) { this.zones.delete(key); }

  private selection(zone: Zone, view: VoxelLodView, scale: number) {
    const selected = new Map<number, number>();
    for (const [id, brick] of zone.bricks) {
      const center = brick.bounds.center;
      const distance = Math.max(1, Math.hypot(view.camera[0] - center.x, view.camera[1] - center.y,
        view.camera[2] - center.z) - brick.bounds.radius);
      let size = 64;
      if (view.hasView && distance <= view.distance) for (const candidate of zone.sizes) {
        size = candidate;
        const area = surfaceSubdivisionWorldArea(size, brick.y * 64 + size, brick.y * 64);
        if (area * (view.focal / distance) ** 2 <= view.area * scale * (size > brick.size ? SURFACE_AREA_HYSTERESIS : 1)) break;
      }
      selected.set(id, size);
    }
    return selected;
  }

  private *measure(view: VoxelLodView, scale: number): Generator<void, number> {
    let count = 0;
    for (const zone of this.zones.values()) {
      for (const [id, size] of this.selection(zone, view, scale)) {
        const range = zone.mips.get(size)!.ranges.get(id);
        if (range) count += (range.end - range.start) / 16;
      }
      yield;
    }
    return count;
  }

  *build(view: VoxelLodView): Generator<VoxelLodTile | void, VoxelLodStats> {
    // Budget probes must never mutate the hysteresis history.
    let scale = 1, lower = 1, faces = yield* this.measure(view, scale);
    while (faces > view.faceBudget && scale < 65536) {
      lower = scale; scale *= 2; faces = yield* this.measure(view, scale);
    }
    if (scale > 1) {
      let upper = scale;
      for (let attempt = 0; attempt < 8; attempt++) {
        scale = (lower + upper) / 2;
        if ((yield* this.measure(view, scale)) > view.faceBudget) lower = scale;
        else upper = scale;
      }
      scale = upper; faces = yield* this.measure(view, scale);
    }
    for (const zone of this.zones.values()) {
      const selected = this.selection(zone, view, scale);
      for (const [id, size] of selected) zone.bricks.get(id)!.size = size;
      for (let tx = 0; tx < 4; tx++) for (let tz = 0; tz < 4; tz++) {
        const tile = tx * 4 + tz, ranges: { faces: Uint8Array; start: number; end: number }[] = [];
        let count = 0, signature = '';
        for (const [id, brick] of zone.bricks) {
          if ((brick.x >> 1) !== tx || (brick.z >> 1) !== tz) continue;
          signature += `/${id}:${selected.get(id)}`;
          const mip = zone.mips.get(selected.get(id)!)!, range = mip.ranges.get(id);
          if (range) { ranges.push({ faces: mip.faces, ...range }); count += (range.end - range.start) / 16; }
        }
        if (zone.signatures.get(tile) === signature) continue;
        const offset = new Uint16Array(count * 3), span = new Uint16Array(count * 2);
        const color = new Uint8Array(count * 3), direction = new Uint8Array(count), emission = new Uint8Array(count);
        let index = 0, minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const range of ranges) {
          const data = new DataView(range.faces.buffer, range.faces.byteOffset, range.faces.byteLength);
          for (let at = range.start; at < range.end; at += 16) {
            offset[index * 3] = data.getUint16(at, true);
            offset[index * 3 + 1] = data.getUint16(at + 2, true);
            offset[index * 3 + 2] = data.getUint16(at + 4, true);
            span[index * 2] = data.getUint16(at + 6, true); span[index * 2 + 1] = data.getUint16(at + 8, true);
            direction[index] = range.faces[at + 10]; emission[index] = range.faces[at + 11];
            // Include all four corners of every selected quad, including cave
            // ceilings and vertical walls. Curvature is bounded after packing.
            const x = offset[index * 3] / 8, y = offset[index * 3 + 1] / 8, z = offset[index * 3 + 2] / 8;
            const u = span[index * 2] / 8, v = span[index * 2 + 1] / 8, axis = direction[index] >> 1;
            minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
            maxX = Math.max(maxX, x + (axis === 0 ? 0 : axis === 1 ? v : u));
            maxY = Math.max(maxY, y + (axis === 1 ? 0 : axis === 0 ? u : v));
            maxZ = Math.max(maxZ, z + (axis === 2 ? 0 : axis === 0 ? v : u));
            for (let channel = 0; channel < 3; channel++) {
              const value = range.faces[at + 12 + channel];
              color[index * 3 + channel] = emission[index] ? value : LINEAR[value];
            }
            if ((++index & 2047) === 0) yield;
          }
        }
        if (!count) { minX = maxX = tx * 128; minY = maxY = 0; minZ = maxZ = tz * 128; }
        minX += zone.source.x * 512; maxX += zone.source.x * 512;
        minZ += zone.source.z * 512; maxZ += zone.source.z * 512;
        const bounds = computeBentBoundsSphere({ minX, maxX, minY, maxY, minZ, maxZ });
        zone.signatures.set(tile, signature);
        yield { key: zone.source.key, token: zone.source.token, tile, count,
          bounds: [bounds.center.x, bounds.center.y, bounds.center.z, bounds.radius],
          flatBounds: [minX, maxX, minZ, maxZ], offset, span, color, direction, emission };
      }
      yield;
    }
    return { faces, budget: view.faceBudget, requestedAreaPx2: view.area, effectiveAreaPx2: view.area * scale };
  }
}
