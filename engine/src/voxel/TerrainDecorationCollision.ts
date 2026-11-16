import { CHUNK_SIZE_X, CHUNK_SIZE_Z } from './Chunk.ts';
import { MICRO_SIZE } from './MicroGrid.ts';
import { TORUS_SIZE_X, TORUS_SIZE_Z, unwrapPeriodicNear, wrapChunkX, wrapChunkZ } from '../torus/TorusWorld.ts';
import { CollisionBoxIndex, collisionBoundsOf, type CollisionBounds } from '../physics/CollisionGeometry.ts';
import { voxelizeDecorations } from '../physics/DecorationCollision.ts';
import { anchoredDecorationCenter } from '../contraption/Decorations.ts';
import type { TerrainDecorationLayer } from './TerrainDecorationLayer.ts';

type Footprint = {
  /** World-space boxes in the anchor chunk's canonical (wrapped) frame. */
  index: CollisionBoxIndex<CollisionBounds>;
  originX: number;
  originZ: number;
  covers: string[];
};
export type TerrainDecorationRayHit = { hit: false } | {
  hit: true; distance: number;
  hitPos: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number };
};

const chunkKey = (cx: number, cz: number) => `${wrapChunkX(cx)},${wrapChunkZ(cz)}`;

/**
 * Terrain decorations collide as their 0.125 m world-grid footprint (see
 * DecorationCollision). Footprints are indexed by the chunk of their anchor
 * voxel and found through every chunk they reach, which can be a few chunks
 * away. Queries use the caller's unwrapped frame, so torus seams are seamless.
 */
export class TerrainDecorationCollision {
  private readonly layer: TerrainDecorationLayer;
  private readonly footprints = new Map<string, Footprint>();
  /** Chunk key -> anchor chunk keys whose footprints reach into it. */
  private readonly coverage = new Map<string, Set<string>>();
  private readonly coverageVersions = new Map<string, number>();
  /** Increments whenever any footprint changes. */
  version = 0;

  constructor(layer: TerrainDecorationLayer) {
    this.layer = layer;
    layer.onChange(key => this.rebuild(key));
    for (const key of [...layer.chunkKeys()]) this.rebuild(key);
  }

  get size() { return this.footprints.size; }

  private touch(key: string) {
    this.coverageVersions.set(key, (this.coverageVersions.get(key) ?? 0) + 1);
  }

  private rebuild(anchorKey: string) {
    const previous = this.footprints.get(anchorKey);
    if (previous) {
      for (const key of previous.covers) {
        const anchors = this.coverage.get(key);
        anchors?.delete(anchorKey);
        if (anchors?.size === 0) this.coverage.delete(key);
        this.touch(key);
      }
      this.footprints.delete(anchorKey);
    }
    // Ids order the shapes identically on every host, whatever the arrival order.
    const values = [...this.layer.forChunkKey(anchorKey)].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (values.length) {
      const boxes = voxelizeDecorations(values.map(value => ({
        position: anchoredDecorationCenter([value.x, value.y, value.z], value.position),
        rotation: value.rotation, scale: value.scale,
      })), 'terrain').map(box => ({
        minX: box.x * MICRO_SIZE, maxX: (box.x + box.spanX) * MICRO_SIZE,
        minY: box.y * MICRO_SIZE, maxY: (box.y + box.spanY) * MICRO_SIZE,
        minZ: box.z * MICRO_SIZE, maxZ: (box.z + box.spanZ) * MICRO_SIZE,
      }));
      const [cx, cz] = anchorKey.split(',').map(Number);
      const bounds = collisionBoundsOf(boxes);
      const covers = new Set<string>();
      for (let x = Math.floor(bounds.minX / CHUNK_SIZE_X); x <= Math.floor(bounds.maxX / CHUNK_SIZE_X); x++) {
        for (let z = Math.floor(bounds.minZ / CHUNK_SIZE_Z); z <= Math.floor(bounds.maxZ / CHUNK_SIZE_Z); z++) {
          covers.add(chunkKey(x, z));
        }
      }
      const footprint = { index: new CollisionBoxIndex(boxes), originX: cx * CHUNK_SIZE_X, originZ: cz * CHUNK_SIZE_Z, covers: [...covers] };
      this.footprints.set(anchorKey, footprint);
      for (const key of footprint.covers) {
        let anchors = this.coverage.get(key);
        if (!anchors) this.coverage.set(key, anchors = new Set());
        anchors.add(anchorKey);
        this.touch(key);
      }
    }
    if (previous || values.length) this.version++;
  }

  /** Visit each footprint reaching `bounds`, with its shift into that frame. */
  private visit(bounds: CollisionBounds, visit: (footprint: Footprint, offsetX: number, offsetZ: number) => boolean | void) {
    if (this.footprints.size === 0) return false;
    const centerX = (bounds.minX + bounds.maxX) / 2, centerZ = (bounds.minZ + bounds.maxZ) / 2;
    const seen = new Set<string>();
    for (let x = Math.floor(bounds.minX / CHUNK_SIZE_X); x <= Math.floor(bounds.maxX / CHUNK_SIZE_X); x++) {
      for (let z = Math.floor(bounds.minZ / CHUNK_SIZE_Z); z <= Math.floor(bounds.maxZ / CHUNK_SIZE_Z); z++) {
        const anchors = this.coverage.get(chunkKey(x, z));
        if (!anchors) continue;
        for (const anchor of anchors) {
          if (seen.has(anchor)) continue;
          seen.add(anchor);
          const footprint = this.footprints.get(anchor)!;
          const offsetX = unwrapPeriodicNear(footprint.originX, centerX, TORUS_SIZE_X) - footprint.originX;
          const offsetZ = unwrapPeriodicNear(footprint.originZ, centerZ, TORUS_SIZE_Z) - footprint.originZ;
          if (visit(footprint, offsetX, offsetZ)) return true;
        }
      }
    }
    return false;
  }

  /** Footprint boxes overlapping `bounds`, expressed in the query's frame. */
  boxesInAABB(bounds: CollisionBounds): CollisionBounds[] {
    const result: CollisionBounds[] = [];
    if (!Object.values(bounds).every(Number.isFinite)) return result;
    this.visit(bounds, (footprint, offsetX, offsetZ) => {
      const local = { ...bounds, minX: bounds.minX - offsetX, maxX: bounds.maxX - offsetX,
        minZ: bounds.minZ - offsetZ, maxZ: bounds.maxZ - offsetZ };
      for (const box of footprint.index.query(local)) {
        result.push(offsetX === 0 && offsetZ === 0 ? box : { ...box,
          minX: box.minX + offsetX, maxX: box.maxX + offsetX, minZ: box.minZ + offsetZ, maxZ: box.maxZ + offsetZ });
      }
    });
    return result;
  }

  /** Whether the micro cell's centre lies in any footprint. */
  hasMicroCell(mx: number, my: number, mz: number): boolean {
    const x = (mx + 0.5) * MICRO_SIZE, y = (my + 0.5) * MICRO_SIZE, z = (mz + 0.5) * MICRO_SIZE;
    const point = { minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z };
    return this.visit(point, (footprint, offsetX, offsetZ) => footprint.index.intersects({
      ...point, minX: x - offsetX, maxX: x - offsetX, minZ: z - offsetZ, maxZ: z - offsetZ,
    }));
  }

  /** Nearest footprint face along a ray. A ray starting inside reports
   * distance 0 without a normal, like the voxel raycasts. */
  raycast(origin: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }, maxDistance: number): TerrainDecorationRayHit {
    if (this.footprints.size === 0 || !(maxDistance >= 0)) return { hit: false };
    const end = { x: origin.x + direction.x * maxDistance, y: origin.y + direction.y * maxDistance, z: origin.z + direction.z * maxDistance };
    const bounds = { minX: Math.min(origin.x, end.x), maxX: Math.max(origin.x, end.x),
      minY: Math.min(origin.y, end.y), maxY: Math.max(origin.y, end.y),
      minZ: Math.min(origin.z, end.z), maxZ: Math.max(origin.z, end.z) };
    let best: TerrainDecorationRayHit = { hit: false };
    let bestDistance = Infinity;
    const axes = [['x', 'minX', 'maxX'], ['y', 'minY', 'maxY'], ['z', 'minZ', 'maxZ']] as const;
    for (const box of this.boxesInAABB(bounds)) {
      let entry = -Infinity, exit = Infinity, entryAxis = -1;
      for (let axis = 0; axis < 3; axis++) {
        const [key, min, max] = axes[axis];
        const o = origin[key], d = direction[key];
        if (Math.abs(d) < 1e-12) {
          if (o < box[min] || o > box[max]) { entry = Infinity; break; }
          continue;
        }
        const t0 = (box[min] - o) / d, t1 = (box[max] - o) / d;
        const near = Math.min(t0, t1), far = Math.max(t0, t1);
        if (near > entry) { entry = near; entryAxis = axis; }
        exit = Math.min(exit, far);
      }
      // Leaving through a face is not a hit; entering from a face is, at distance 0.
      if (!(entry <= exit) || exit <= 1e-12 || entry > maxDistance) continue;
      const inside = entry < -1e-9 || entryAxis < 0;
      const distance = Math.max(0, entry);
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      const normal = { x: 0, y: 0, z: 0 };
      if (!inside && entryAxis >= 0) normal[axes[entryAxis][0]] = -Math.sign(direction[axes[entryAxis][0]]);
      best = { hit: true, distance, normal, hitPos: {
        x: origin.x + direction.x * distance, y: origin.y + direction.y * distance, z: origin.z + direction.z * distance,
      } };
    }
    return best;
  }

  /** Changes whenever a footprint reaching this chunk changes. */
  stamp(cx: number, cz: number): number {
    return this.coverageVersions.get(chunkKey(cx, cz)) ?? 0;
  }
}
