import type * as Rapier from '@dimforge/rapier3d-compat';
import { mergeCollisionBoxes, type CollisionBounds } from '@entropydrop/space-engine/physics/CollisionGeometry.ts';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z } from '@entropydrop/space-engine/voxel/Chunk.ts';
import type { World } from '@entropydrop/space-engine/voxel/World.ts';

export type RapierModule = typeof Rapier;
export const zero = { x: 0, y: 0, z: 0 };
export const identity = { ...zero, w: 1 };
const sliceHeight = 16;

export function toLocal(point: Rapier.Vector, origin: Rapier.Vector) {
  return { x: point.x - origin.x, y: point.y - origin.y, z: point.z - origin.z };
}

export function boxCompound(module: RapierModule, boxes: readonly CollisionBounds[]) {
  return new module.Compound(
    boxes.map(b => new module.Cuboid((b.maxX - b.minX) / 2, (b.maxY - b.minY) / 2, (b.maxZ - b.minZ) / 2)),
    boxes.map(b => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, z: (b.minZ + b.maxZ) / 2 })),
    boxes.map(() => identity), module.CompoundFlags.FIX_INTERNAL_EDGES,
  );
}

function tileRange(bounds: CollisionBounds) {
  return {
    x0: Math.floor(bounds.minX / CHUNK_SIZE_X), x1: Math.floor(bounds.maxX / CHUNK_SIZE_X),
    y0: Math.floor(bounds.minY / sliceHeight), y1: Math.floor(bounds.maxY / sliceHeight),
    z0: Math.floor(bounds.minZ / CHUNK_SIZE_Z), z1: Math.floor(bounds.maxZ / CHUNK_SIZE_Z),
  };
}

export function canPublishTerrain(bounds: CollisionBounds) {
  if (!Object.values(bounds).every(Number.isFinite)) return false;
  const { x0, x1, y0, y1, z0, z1 } = tileRange(bounds);
  return x0 <= x1 && y0 <= y1 && z0 <= z1 && (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) <= 128;
}

function sameGeometry(a: readonly CollisionBounds[], b: readonly CollisionBounds[]) {
  return a.length === b.length && a.every((box, i) => {
    const other = b[i];
    return box.minX === other.minX && box.minY === other.minY && box.minZ === other.minZ
      && box.maxX === other.maxX && box.maxY === other.maxY && box.maxZ === other.maxZ;
  });
}

type Tile = {
  stamp: unknown[];
  boxes: CollisionBounds[];
  collider: Rapier.Collider | null;
  position: Rapier.Vector;
};

/** Resident collision tiles in unwrapped Space coordinates. The world already
 * resolves torus wrapping and microvoxel publication for these queries. */
export class RapierTerrain {
  private readonly module: RapierModule;
  private readonly physics: Rapier.World;
  private readonly world: World;
  private origin: Rapier.Vector;
  private readonly tiles = new Map<string, Tile>();
  private readonly visited = new Map<string, boolean>();
  private readonly stamps = new Map<string, unknown[]>();
  rebuilt = 0;

  constructor(module: RapierModule, physics: Rapier.World, world: World, origin: Rapier.Vector) {
    this.module = module;
    this.physics = physics;
    this.world = world;
    this.origin = origin;
  }

  begin(origin: Rapier.Vector) {
    this.visited.clear();
    this.stamps.clear();
    if (this.origin === origin) return;
    this.origin = origin;
    for (const tile of this.tiles.values()) tile.collider?.setTranslation(toLocal(tile.position, origin));
  }

  publish(bounds: CollisionBounds) {
    const { x0, x1, y0, y1, z0, z1 } = tileRange(bounds);
    let changed = false;
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) changed = this.publishTile(x, y, z) || changed;
    }
    return changed;
  }

  finish() {
    for (const [key, tile] of this.tiles) {
      if (this.visited.has(key)) continue;
      if (tile.collider) this.physics.removeCollider(tile.collider, true);
      this.tiles.delete(key);
    }
  }

  private publishTile(x: number, y: number, z: number) {
    const key = `${x},${y},${z}`;
    const visited = this.visited.get(key);
    if (visited !== undefined) return visited;
    const position = { x: x * CHUNK_SIZE_X, y: y * sliceHeight, z: z * CHUNK_SIZE_Z };
    const bounds = { minX: position.x, maxX: position.x + CHUNK_SIZE_X,
      minY: position.y, maxY: position.y + sliceHeight, minZ: position.z, maxZ: position.z + CHUNK_SIZE_Z };
    const column = `${x},${z}`;
    let stamp = this.stamps.get(column);
    if (!stamp) {
      // The stamp includes the chunk at both ends, so sample inside its upper edge.
      stamp = this.world.getTerrainCollisionStamp({ ...bounds, maxX: bounds.maxX - 0.5, maxZ: bounds.maxZ - 0.5 });
      this.stamps.set(column, stamp);
    }
    const old = this.tiles.get(key);
    if (old && stamp.length === old.stamp.length && stamp.every((value, i) => value === old.stamp[i])) {
      this.visited.set(key, false);
      return false;
    }

    const solids = mergeCollisionBoxes(this.world.getStandardCollisionBoxesInAABB(bounds).map(box => ({
      x: box.minX, y: box.minY, z: box.minZ, spanX: 1, spanY: 1, spanZ: 1, entityId: 'terrain',
    }))).map(box => ({ minX: box.x, maxX: box.x + box.spanX, minY: box.y, maxY: box.y + box.spanY,
      minZ: box.z, maxZ: box.z + box.spanZ }));
    const boxes = [...solids, ...this.world.getMicroCollisionBoxesInAABB(bounds),
      ...this.world.getTerrainDecorationCollisionBoxesInAABB(bounds)].map(box => ({
      minX: Math.max(box.minX, bounds.minX) - position.x, maxX: Math.min(box.maxX, bounds.maxX) - position.x,
      minY: Math.max(box.minY, bounds.minY) - position.y, maxY: Math.min(box.maxY, bounds.maxY) - position.y,
      minZ: Math.max(box.minZ, bounds.minZ) - position.z, maxZ: Math.min(box.maxZ, bounds.maxZ) - position.z,
    })).filter(box => box.maxX > box.minX && box.maxY > box.minY && box.maxZ > box.minZ);
    let collider = old?.collider ?? null;
    const changed = !sameGeometry(old?.boxes ?? [], boxes);
    if (changed) {
      this.rebuilt++;
      if (boxes.length && collider) collider.setShape(boxCompound(this.module, boxes));
      else if (boxes.length) {
        const local = toLocal(position, this.origin);
        collider = this.physics.createCollider(new this.module.ColliderDesc(boxCompound(this.module, boxes))
          .setTranslation(local.x, local.y, local.z).setFriction(Math.sqrt(0.65))
          .setFrictionCombineRule(this.module.CoefficientCombineRule.Multiply));
      } else if (collider) {
        this.physics.removeCollider(collider, true);
        collider = null;
      }
    }
    this.tiles.set(key, { stamp, collider, boxes, position });
    this.visited.set(key, changed);
    return changed;
  }
}
