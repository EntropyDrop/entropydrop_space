import * as THREE from 'three';
import { bendTorusPoint, computeBentBoundsSphere, type WorldProjection } from '../torus/TorusWorld.ts';
import { surfaceSubdivisionWorldArea, SURFACE_AREA_HYSTERESIS } from './SurfaceSubdivision.ts';
import type { VoxelSurfaceMip } from '../voxel/SurfaceZoneSnapshot.ts';
import { voxelFaceVisibility } from './VoxelFaceVisibility.ts';
import { bakeVoxelTile, type BakedVoxelTile, type VoxelTextureBakeSettings } from './VoxelTextureBake.ts';

export type VoxelLodSource = { key: string; x: number; z: number; token: number; mips: VoxelSurfaceMip[] };
export type VoxelLodView = { camera: [number, number, number]; focal: number; area: number;
  distance: number; faceBudget: number; hasView: boolean; projection?: WorldProjection;
  /** Explicit development reference; never silently relax its quality to fit a budget. */
  fixedCellSize?: number; bake?: VoxelTextureBakeSettings; bakeRevision?: number };
export type VoxelLodStats = { faces: number; budget: number; requestedAreaPx2: number; effectiveAreaPx2: number };
export type VoxelLodTile = { key: string; token: number; tile: number; count: number;
  bounds: [number, number, number, number]; offset: Uint16Array; span: Uint16Array;
  flatBounds: [number, number, number, number];
  color: Uint8Array; direction: Uint8Array; emission: Uint8Array; visibility?: Float32Array; projection?: WorldProjection;
  baked?: BakedVoxelTile; bakeRevision?: number };
type Range = { start: number; end: number };
type Brick = { x: number; y: number; z: number; size: number; bounds: THREE.Sphere };
type Zone = { source: VoxelLodSource; mips: Map<number, { faces: Uint8Array; ranges: Map<number, Range> }>;
  sizes: number[]; bricks: Map<number, Brick>; signatures: Map<number, string> };
const LINEAR = Uint8Array.from({ length: 256 }, (_, n) => Math.round(255 * (n / 255 <= .04045
  ? n / 255 / 12.92 : ((n / 255 + .055) / 1.055) ** 2.4)));
export const voxelTileBytes = (tile: VoxelLodTile) => tile.count * 15 + (tile.visibility?.byteLength ?? 0)
  + (tile.baked ? tile.baked.count * 15 + (tile.baked.visibility?.byteLength ?? 0) + tile.baked.pixels.byteLength : 0);
export const voxelTileTransfers = (tile: VoxelLodTile) =>
  [tile.offset.buffer, tile.span.buffer, tile.color.buffer, tile.direction.buffer, tile.emission.buffer,
    ...(tile.visibility ? [tile.visibility.buffer] : []), ...(tile.baked ? [tile.baked.offset.buffer,
      tile.baked.span.buffer, tile.baked.color.buffer, tile.baked.direction.buffer, tile.baked.emission.buffer,
      tile.baked.pixels.buffer, ...(tile.baked.visibility ? [tile.baked.visibility.buffer] : [])] : [])] as ArrayBuffer[];

/** No scene objects or GPU resources. Yield boundaries also serve the cooperative
 * fallback when workers are unavailable. Sources remain immutable after install. */
export class VoxelLodPlanner {
  private projection: WorldProjection = 'torus';
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
            minY: y * 64, maxY: (y + 1) * 64, minZ: source.z * 512 + z * 64, maxZ: source.z * 512 + (z + 1) * 64 }, undefined, this.projection) });
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
            minY: y * 64, maxY: (y + 1) * 64, minZ: source.z * 512 + z * 64, maxZ: source.z * 512 + (z + 1) * 64 }, undefined, this.projection) });
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
      if (view.fixedCellSize !== undefined) {
        // Streaming may temporarily publish a coarse source. The benchmark
        // must wait for all fine sources before accepting samples.
        selected.set(id, zone.mips.has(view.fixedCellSize) ? view.fixedCellSize : Math.min(...zone.sizes)); continue;
      }
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
    // Workers own their projection; never mutate the main thread's global mode
    // from the cooperative backend. Recompute cached bounds before selection.
    const projection = view.projection ?? 'torus';
    if (this.projection !== projection) {
      this.projection = projection;
      for (const zone of this.zones.values()) {
        zone.signatures.clear();
        for (const brick of zone.bricks.values()) {
          const { x, y, z } = brick;
          computeBentBoundsSphere({ minX: zone.source.x * 512 + x * 64, maxX: zone.source.x * 512 + (x + 1) * 64,
            minY: y * 64, maxY: (y + 1) * 64, minZ: zone.source.z * 512 + z * 64,
            maxZ: zone.source.z * 512 + (z + 1) * 64 }, brick.bounds, projection);
        }
        yield;
      }
    }
    // Budget probes must never mutate the hysteresis history.
    let scale = 1, lower = 1, faces = yield* this.measure(view, scale);
    if (view.fixedCellSize !== undefined && faces > view.faceBudget) throw Error(`Fixed LOD reference exceeds face budget: ${faces} > ${view.faceBudget}`);
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
    const ordered = [...this.zones.values()];
    if (view.bake?.textureProxyEnabled) {
      const distances = new Map(ordered.map(zone => [zone, Math.min(...[...zone.bricks.values()].map(brick =>
        Math.hypot(view.camera[0] - brick.bounds.center.x, view.camera[1] - brick.bounds.center.y,
          view.camera[2] - brick.bounds.center.z) - brick.bounds.radius))]));
      ordered.sort((a, b) => distances.get(a)! - distances.get(b)!);
    }
    for (const zone of ordered) {
      const selected = this.selection(zone, view, scale);
      for (const [id, size] of selected) zone.bricks.get(id)!.size = size;
      for (let tx = 0; tx < 4; tx++) for (let tz = 0; tz < 4; tz++) {
        const tile = tx * 4 + tz, ranges: { faces: Uint8Array; start: number; end: number }[] = [];
        let bakeAllowed = false;
        if (view.bake?.textureProxyEnabled && view.hasView) {
          const tileBounds = computeBentBoundsSphere({ minX: zone.source.x * 512 + tx * 128, maxX: zone.source.x * 512 + (tx + 1) * 128,
            minY: 0, maxY: 256, minZ: zone.source.z * 512 + tz * 128, maxZ: zone.source.z * 512 + (tz + 1) * 128 }, undefined, projection);
          bakeAllowed = Math.hypot(view.camera[0] - tileBounds.center.x, view.camera[1] - tileBounds.center.y,
            view.camera[2] - tileBounds.center.z) - tileBounds.radius >= view.bake.textureProxyDistance;
        }
        let count = 0, signature = `${view.bakeRevision ?? 0}:${Number(bakeAllowed)}`;
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
        const bounds = computeBentBoundsSphere({ minX, maxX, minY, maxY, minZ, maxZ }, undefined, projection);
        const project = projection === 'torus' ? bendTorusPoint : (x: number, y: number, z: number, out = new THREE.Vector3()) => out.set(x, y, z);
        const visibility = yield* voxelFaceVisibility({ count, offset, span, direction }, zone.source.x * 512, zone.source.z * 512, project);
        zone.signatures.set(tile, signature);
        const result: VoxelLodTile = { key: zone.source.key, token: zone.source.token, tile, count,
          bounds: [bounds.center.x, bounds.center.y, bounds.center.z, bounds.radius],
          flatBounds: [minX, maxX, minZ, maxZ], offset, span, color, direction, emission, visibility, projection, bakeRevision: view.bakeRevision ?? 0 };
        if (bakeAllowed && count >= 64) {
          let proxy = result, projectionDepth = 0;
          if ((view.bake!.textureProxyLodBias ?? 0) > 0) {
            const coarse: { faces: Uint8Array; start: number; end: number }[] = [];
            let coarseCount = 0;
            for (const [id, brick] of zone.bricks) {
              if ((brick.x >> 1) !== tx || (brick.z >> 1) !== tz) continue;
              const fineSize = selected.get(id)!;
              const size = zone.sizes.find(size => size <= Math.max(fineSize, Math.min(32, fineSize * 2 ** view.bake!.textureProxyLodBias)))!;
              projectionDepth = Math.max(projectionDepth, size);
              const mip = zone.mips.get(size)!, range = mip.ranges.get(id);
              if (range) { coarse.push({ faces: mip.faces, ...range }); coarseCount += (range.end - range.start) / 16; }
            }
            proxy = { ...result, count: coarseCount, offset: new Uint16Array(coarseCount * 3), span: new Uint16Array(coarseCount * 2),
              color: new Uint8Array(coarseCount * 3), direction: new Uint8Array(coarseCount), emission: new Uint8Array(coarseCount) };
            let i = 0;
            for (const range of coarse) {
              const data = new DataView(range.faces.buffer, range.faces.byteOffset, range.faces.byteLength);
              for (let at = range.start; at < range.end; at += 16) {
                for (let d = 0; d < 3; d++) proxy.offset[i * 3 + d] = data.getUint16(at + d * 2, true);
                proxy.span[i * 2] = data.getUint16(at + 6, true); proxy.span[i * 2 + 1] = data.getUint16(at + 8, true);
                proxy.direction[i] = range.faces[at + 10]; proxy.emission[i] = range.faces[at + 11];
                for (let d = 0; d < 3; d++) proxy.color[i * 3 + d] = proxy.emission[i] ? range.faces[at + 12 + d] : LINEAR[range.faces[at + 12 + d]];
                if ((++i & 1023) === 0) yield;
              }
            }
          }
          result.baked = yield* bakeVoxelTile(proxy, view.bake!.textureProxyEdge, view.bake!.textureProxyDensity, result, projectionDepth);
          if (result.baked) result.baked.visibility = yield* voxelFaceVisibility(result.baked, zone.source.x * 512, zone.source.z * 512, project);
          if (result.baked && proxy !== result) {
            // Coarsening can expand a silhouette. Culling must cover the proxy,
            // the reference fallback, and both generations during handoff.
            for (let i = 0; i < result.baked.count; i++) {
              const b = result.baked, axis = (b.direction[i] & 7) >> 1;
              const p = [b.offset[i * 3] / 8 + zone.source.x * 512, b.offset[i * 3 + 1] / 8, b.offset[i * 3 + 2] / 8 + zone.source.z * 512];
              const w = b.span[i * 2] / 8, h = b.span[i * 2 + 1] / 8;
              minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); minZ = Math.min(minZ, p[2]);
              maxX = Math.max(maxX, p[0] + (axis === 0 ? 0 : axis === 1 ? h : w));
              maxY = Math.max(maxY, p[1] + (axis === 1 ? 0 : axis === 0 ? w : h));
              maxZ = Math.max(maxZ, p[2] + (axis === 2 ? 0 : axis === 0 ? h : w));
            }
            computeBentBoundsSphere({ minX, maxX, minY, maxY, minZ, maxZ }, bounds, projection);
            result.bounds = [bounds.center.x, bounds.center.y, bounds.center.z, bounds.radius];
            result.flatBounds = [minX, maxX, minZ, maxZ];
          }
        }
        yield result;
      }
      yield;
    }
    return { faces, budget: view.faceBudget, requestedAreaPx2: view.area, effectiveAreaPx2: view.area * scale };
  }
}
