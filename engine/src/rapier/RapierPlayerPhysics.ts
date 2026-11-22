import type * as Rapier from '@entropydrop/rapier3d-compat';
import { type Matrix4, Quaternion, Vector3 } from 'three';
import type { Contraption, EntityCollisionBounds } from '../contraption/Contraption.ts';
import { collisionBoundsOverlap, type CollisionBounds } from '../physics/CollisionGeometry.ts';
import { PlayerPhysics } from '../physics/PlayerPhysics.ts';
import type { World } from '../voxel/World.ts';
import { MICRO_SIZE } from '../voxel/MicroGrid.ts';
import { identity, zero, type RapierModule } from './RapierTerrain.ts';

type Surface = { shape: Rapier.Cuboid; position: Vector3; rotation: Quaternion; entity?: EntityCollisionBounds };
type Hit = { surface: Surface; time: number; normal: Vector3; point: Vector3 };
const axes = ['y', 'x', 'z'] as const;
const skin = 0.0002;
const floorProbe = 0.01;
const identityRotation = new Quaternion();

function swept(a: CollisionBounds, b: CollisionBounds, margin = skin): CollisionBounds {
  return {
    minX: Math.min(a.minX, b.minX) - margin, minY: Math.min(a.minY, b.minY) - margin, minZ: Math.min(a.minZ, b.minZ) - margin,
    maxX: Math.max(a.maxX, b.maxX) + margin, maxY: Math.max(a.maxY, b.maxY) + margin, maxZ: Math.max(a.maxZ, b.maxZ) + margin,
  };
}

function vector(value: Rapier.Vector) { return new Vector3(value.x, value.y, value.z); }

/** Space owns input, jump rules and platform attachment. Rapier does the
 * continuous casts and penetration queries in a one-way character controller. */
export class RapierPlayerPhysics extends PlayerPhysics {
  private readonly module: RapierModule;
  private readonly terrain: World;
  private readonly observed = new WeakMap<Contraption, Map<string, Matrix4>>();
  private shape?: Rapier.Cuboid;
  private widthAtCast = 0;
  private heightAtCast = 0;

  constructor(module: RapierModule, world: World, manager: ConstructorParameters<typeof PlayerPhysics>[1]) {
    super(world, manager);
    this.module = module;
    this.terrain = world;
  }

  private get castHeight() { return this.isCrouching ? 1.45 : this.height; }

  private playerShape() {
    if (!this.shape || this.width !== this.widthAtCast || this.castHeight !== this.heightAtCast) {
      this.widthAtCast = this.width;
      this.heightAtCast = this.castHeight;
      this.shape = new this.module.Cuboid(this.width / 2, this.castHeight / 2, this.width / 2);
    }
    return this.shape;
  }

  private center() { return this.position.clone().add(new Vector3(0, this.castHeight / 2, 0)); }

  private boxSurface(bounds: CollisionBounds): Surface {
    const size = new Vector3(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ);
    return { shape: new this.module.Cuboid(size.x / 2, size.y / 2, size.z / 2),
      position: size.multiplyScalar(0.5).add(new Vector3(bounds.minX, bounds.minY, bounds.minZ)),
      rotation: identityRotation };
  }

  private entitySurface(box: EntityCollisionBounds, transform?: Matrix4): Surface {
    const node = box.contraption.entityNodes?.get(box.entityId);
    const matrix = transform ?? node?.group.matrixWorld;
    if (!box.cell || !node || !matrix) {
      return { ...this.boxSurface(box), entity: box };
    }
    const cell = box.cell;
    const sx = 'spanX' in cell ? cell.spanX : cell.span;
    const sy = 'spanY' in cell ? cell.spanY : cell.span;
    const sz = 'spanZ' in cell ? cell.spanZ : cell.span;
    const position = new Vector3(cell.x + sx / 2, cell.y + sy / 2, cell.z + sz / 2)
      .multiplyScalar(MICRO_SIZE).sub(node.pivotLocal).applyMatrix4(matrix);
    return { shape: new this.module.Cuboid(sx * MICRO_SIZE / 2, sy * MICRO_SIZE / 2, sz * MICRO_SIZE / 2), position,
      rotation: new Quaternion().setFromRotationMatrix(matrix), entity: box };
  }

  private surfaces(bounds: CollisionBounds, entities: Contraption[], includeTerrain: boolean) {
    const candidates: Surface[] = [];
    if (includeTerrain) {
      for (const box of [...this.terrain.getStandardCollisionBoxesInAABB(bounds),
        ...this.terrain.getMicroCollisionBoxesInAABB(bounds), ...this.terrain.getTerrainDecorationCollisionBoxesInAABB(bounds)]) {
        if (collisionBoundsOverlap(box, bounds)) candidates.push(this.boxSurface(box));
      }
    }
    for (const entity of entities) {
      for (const box of entity.queryCollisionWorldAABBs(bounds)) {
        entity.getEntityNode(box.entityId)?.group.updateWorldMatrix(true, false);
        candidates.push(this.entitySurface(box));
      }
    }
    return candidates;
  }

  protected override spawnBlockingHeight() {
    const shape = this.playerShape(), center = this.center();
    let height = -Infinity;
    for (const surface of this.surfaces(this.getAABB(), [], true)) {
      const contact = shape.contactShape(center, identity, surface.shape, surface.position, surface.rotation, 0);
      if (contact && contact.distance < -1e-5) height = Math.max(height, surface.position.y + surface.shape.halfExtents.y);
    }
    return height;
  }

  private cast(delta: Vector3, surfaces: Surface[]): Hit | null {
    const center = this.center();
    const shape = this.playerShape();
    let hit: Hit | null = null;
    for (const surface of surfaces) {
      const impact = shape.castShape(center, identity, delta, surface.shape, surface.position, surface.rotation, zero,
        skin, hit?.time ?? 1, false);
      if (!impact) continue;
      const normal = vector(impact.normal2).applyQuaternion(surface.rotation);
      if (delta.dot(normal) >= -1e-8) continue;
      hit = { surface, time: Math.max(0, impact.time_of_impact), normal,
        point: vector(impact.witness2).applyQuaternion(surface.rotation).add(surface.position) };
    }
    return hit;
  }

  private land(surface?: Surface) {
    this.isOnGround = true;
    this.ridingContraption = surface?.entity?.contraption ?? null;
    this.ridingBodyId = surface?.entity?.bodyId ?? null;
  }

  private record(hit: Hit) {
    const box = hit.surface.entity;
    if (!box) return;
    const velocity = this.getContraptionBodyPointVelocity(box.contraption, box.bodyId, hit.point);
    const speed = velocity.sub(this.velocity).dot(hit.normal);
    this.recordPlayerContact(box, hit.normal.clone().negate(), speed, hit.point);
  }

  private translate(displacement: Vector3, entities: Contraption[], report: boolean) {
    let moved = false;
    for (const axis of axes) {
      if (Math.abs(displacement[axis]) < 1e-10) continue;
      const delta = new Vector3();
      delta[axis] = displacement[axis];
      const next = this.position.clone().add(delta);
      const hit = this.cast(delta, this.surfaces(swept(this.getAABB(), this.getAABB(next)), entities, true));
      this.position.addScaledVector(delta, hit?.time ?? 1);
      moved = true;
      if (!report || !hit) continue;
      this.record(hit);
      this.velocity[axis] = 0;
      if (axis === 'y' && delta.y < 0 && hit.normal.y > 0.55) this.land(hit.surface);
    }
    if (this.position.y < 0) {
      this.position.y = 0;
      this.velocity.y = 0;
      this.land();
    }
    return moved;
  }

  protected override moveWithExternalDisplacement(displacement: Vector3, carrier: Contraption) {
    this.translate(displacement, this.getNearbyContraptions().filter(entity => entity !== carrier), false);
  }

  override moveWithCollision(dt: number) {
    this.isOnGround = false;
    this.translate(this.velocity.clone().multiplyScalar(dt), this.getNearbyContraptions(), true);
    this.resolveDynamicContraptionOverlaps();
  }

  private carryIntrusions(entities: Contraption[]) {
    let moved = false;
    for (const entity of entities) {
      let known = this.observed.get(entity);
      if (!known) this.observed.set(entity, known = new Map());
      const previous = new Map<string, Matrix4>();
      for (const node of entity.entityNodes.values()) {
        node.group.updateWorldMatrix(true, false);
        const prior = known.get(node.id);
        if (prior && !prior.equals(node.group.matrixWorld) && prior.equals(node.previousWorldMatrix ?? node.group.matrixWorld)) {
          previous.set(node.id, prior);
        }
        known.set(node.id, node.group.matrixWorld.clone());
      }
      if (entity === this.ridingContraption || !previous.size) continue;
      for (const box of entity.queryCollisionWorldAABBs(this.getAABB())) {
        const prior = previous.get(box.entityId);
        if (!prior) continue;
        const start = this.entitySurface(box, prior);
        const end = this.entitySurface(box);
        const delta = end.position.clone().sub(start.position);
        if (delta.lengthSq() < 1e-12) continue;
        const impact = start.shape.castShape(start.position, start.rotation, delta,
          this.playerShape(), this.center(), identity, zero, skin, 1, false);
        if (!impact) continue;
        const normal = vector(impact.normal1).applyQuaternion(start.rotation);
        const distance = delta.dot(normal) * (1 - impact.time_of_impact);
        if (distance <= skin || normal.y < -0.55) continue;
        this.record({ surface: end, time: impact.time_of_impact, normal,
          point: vector(impact.witness1).applyQuaternion(start.rotation).add(start.position).add(delta) });
        this.moveWithExternalDisplacement(normal.multiplyScalar(distance + skin), entity);
        if (normal.y > 0.55) this.land(end);
        moved = true;
      }
    }
    return moved;
  }

  override resolveDynamicContraptionOverlaps(entities: Contraption[] = this.getNearbyContraptions()) {
    let moved = this.followRidingPlatformPose();
    if (!this.isFlying) moved = this.carryIntrusions(entities) || moved;
    const shape = this.playerShape();
    for (let i = 0; i < 6; i++) {
      const center = this.center();
      const bounds = this.getAABB();
      let deepest: { surface: Surface; contact: Rapier.ShapeContact } | undefined;
      for (const surface of this.surfaces(bounds, entities, true)) {
        const contact = shape.contactShape(center, identity, surface.shape, surface.position, surface.rotation, 0);
        if (contact && contact.distance < (deepest?.contact.distance ?? -skin)) deepest = { surface, contact };
      }
      if (!deepest) break;
      const { surface, contact } = deepest;
      const normal = vector(contact.normal2);
      this.position.addScaledVector(normal, skin - contact.distance);
      this.velocity.addScaledVector(normal, -Math.min(0, this.velocity.dot(normal)));
      if (normal.y > 0.55) this.land(surface);
      moved = true;
    }
    const supportDelta = new Vector3(0, -floorProbe, 0);
    const support = !this.isFlying && this.velocity.y <= 0 && this.cast(supportDelta, this.surfaces(
      swept(this.getAABB(), this.getAABB(this.position.clone().add(supportDelta))), entities, true));
    if (support && support.normal.y > 0.55) this.land(support.surface);
    else if (this.position.y !== 0 && !this.isFlying) {
      this.isOnGround = false;
      this.ridingContraption = null;
      this.ridingBodyId = null;
    }
    this.captureRidingPlatformPose();
    return moved;
  }
}
