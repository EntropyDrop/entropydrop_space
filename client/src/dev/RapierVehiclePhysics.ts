import type * as Rapier from '@dimforge/rapier3d-compat';
import type { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import type { EntityRigidBody } from '@entropydrop/space-engine/contraption/EntityTypes.ts';
import { ContraptionPhysics } from '@entropydrop/space-engine/physics/ContraptionPhysics.ts';
import { mergeCollisionBoxes, type CollisionBounds, type CollisionBox } from '@entropydrop/space-engine/physics/CollisionGeometry.ts';
import type { World } from '@entropydrop/space-engine/voxel/World.ts';
import { MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';

type Frame = ReturnType<ContraptionPhysics['prepareContraptionFrame']>;
type RapierModule = typeof Rapier;
type HullShape = { source: readonly CollisionBox[]; boxes: CollisionBox[]; collider: Rapier.Collider | null };
type Hull = {
  entity: Contraption;
  body: Rapier.RigidBody;
  nodeId: string;
  pivot: Rapier.Vector | null;
  voxel: HullShape;
  decorations: HullShape;
  configuration: number[];
};
const zero = { x: 0, y: 0, z: 0 };
const identity = { ...zero, w: 1 };
const emptyHullShape = (): HullShape => ({ source: [], boxes: [], collider: null });

/** Development adapter for the vehicle course and rigid-body load fixture. */
export class RapierVehiclePhysics extends ContraptionPhysics {
  private readonly physics: Rapier.World;
  private readonly origin: Rapier.Vector;
  private readonly module: RapierModule;
  private readonly terrain: World;
  private readonly bounds: CollisionBounds;
  private readonly batch: boolean;
  private terrainStamp: unknown[] = [];
  private terrainCollider: Rapier.Collider | null = null;
  private eligible = false;
  private readonly hulls = new Map<Contraption, Hull>();
  private readonly owners = new Map<number, Contraption>();
  private frames: { frame: NonNullable<Frame>; hull: Hull }[] = [];
  readonly counts = { steps: 0, terrainRebuilds: 0, hullRebuilds: 0, bodyCreates: 0,
    voxelRebuilds: 0, decorationRebuilds: 0, contacts: 0, publishedMicroBoxes: 0 };
  readonly rebuildMs: number[] = [];
  readonly hullRebuildMs: number[] = [];

  constructor(module: RapierModule, terrain: World, bounds: CollisionBounds, batch = false) {
    super(terrain);
    this.module = module;
    this.terrain = terrain;
    this.bounds = bounds;
    this.batch = batch;
    this.origin = { x: bounds.minX, y: bounds.minY, z: bounds.minZ };
    this.physics = new module.World(this.gravity);
  }

  override beginEntityUpdate(entities: Contraption[]) {
    super.beginEntityUpdate(entities);
    this.frames.length = 0;
    this.eligible = entities.length > 0 && (this.batch || entities.length === 1);
    if (this.hulls.size > 0) {
      const active = new Set(entities);
      for (const [entity, hull] of this.hulls) if (!active.has(entity)) this.removeHull(hull);
    }
  }

  private removeHull(hull: Hull) {
    for (const { collider } of [hull.voxel, hull.decorations]) {
      if (collider) this.owners.delete(collider.handle);
    }
    this.physics.removeRigidBody(hull.body);
    this.hulls.delete(hull.entity);
  }

  private refreshTerrain() {
    const stamp = this.terrain.getTerrainCollisionStamp(this.bounds);
    if (stamp.length === this.terrainStamp.length && stamp.every((value, i) => value === this.terrainStamp[i])) return;
    const start = performance.now();
    const standard = mergeCollisionBoxes(this.terrain.getStandardCollisionBoxesInAABB(this.bounds).map(box => ({
      x: box.minX, y: box.minY, z: box.minZ, spanX: 1, spanY: 1, spanZ: 1, entityId: 'terrain',
    })));
    const micro = this.terrain.getMicroCollisionBoxesInAABB(this.bounds);
    const boxes = [...standard.map(({ x, y, z, spanX, spanY, spanZ }) => ({
      minX: x, minY: y, minZ: z, maxX: x + spanX, maxY: y + spanY, maxZ: z + spanZ,
    })), ...micro, ...this.terrain.getTerrainDecorationCollisionBoxesInAABB(this.bounds)];
    if (this.terrainCollider) this.physics.removeCollider(this.terrainCollider, true);
    this.terrainCollider = boxes.length ? this.physics.createCollider(this.module.ColliderDesc.compound(
      boxes.map(b => new this.module.Cuboid((b.maxX - b.minX) / 2, (b.maxY - b.minY) / 2, (b.maxZ - b.minZ) / 2)),
      boxes.map(b => ({ x: (b.minX + b.maxX) / 2 - this.origin.x, y: (b.minY + b.maxY) / 2 - this.origin.y,
        z: (b.minZ + b.maxZ) / 2 - this.origin.z })),
      boxes.map(() => identity), this.module.CompoundFlags.FIX_INTERNAL_EDGES,
    ).setFriction(0.7).setFrictionCombineRule(this.module.CoefficientCombineRule.Multiply)) : null;
    this.terrainStamp = stamp;
    this.counts.terrainRebuilds++;
    this.counts.publishedMicroBoxes = micro.length;
    if (this.rebuildMs.length < 2048) this.rebuildMs.push(performance.now() - start);
  }

  private toLocal(p: Rapier.Vector) {
    return { x: p.x - this.origin.x, y: p.y - this.origin.y, z: p.z - this.origin.z };
  }

  private updateShape(slot: HullShape, source: readonly CollisionBox[], hull: Hull,
    body: EntityRigidBody, offset: Rapier.Vector) {
    if (slot.source === source) return false;
    const boxes = source.filter(box => box.entityId === hull.nodeId);
    const previous = slot.boxes;
    if (previous.length === boxes.length && boxes.every((box, index) => {
      const old = previous[index];
      return box === old || (box.x === old.x && box.y === old.y && box.z === old.z
        && box.spanX === old.spanX && box.spanY === old.spanY && box.spanZ === old.spanZ);
    })) {
      slot.source = source;
      return false;
    }

    if (!boxes.length) {
      if (!slot.collider) return false;
      this.owners.delete(slot.collider.handle);
      this.physics.removeCollider(slot.collider, true);
      slot.collider = null;
      slot.source = source;
      slot.boxes = boxes;
      return true;
    }
    const shape = new this.module.Compound(
      boxes.map(b => new this.module.Cuboid(b.spanX * MICRO_SIZE / 2, b.spanY * MICRO_SIZE / 2, b.spanZ * MICRO_SIZE / 2)),
      boxes.map(b => ({ x: (b.x + b.spanX / 2) * MICRO_SIZE, y: (b.y + b.spanY / 2) * MICRO_SIZE,
        z: (b.z + b.spanZ / 2) * MICRO_SIZE })),
      boxes.map(() => identity), this.module.CompoundFlags.FIX_INTERNAL_EDGES,
    );
    if (slot.collider) {
      slot.collider.setShape(shape);
    } else {
      // Space uses the body's friction directly for terrain contacts.
      slot.collider = this.physics.createCollider(new this.module.ColliderDesc(shape)
        .setTranslation(offset.x, offset.y, offset.z)
        .setDensity(0).setFriction(body.friction / 0.7)
        .setFrictionCombineRule(this.module.CoefficientCombineRule.Multiply)
        .setRestitution(body.restitution).setRestitutionCombineRule(this.module.CoefficientCombineRule.Max), hull.body);
      this.owners.set(slot.collider.handle, hull.entity);
    }
    slot.source = source;
    slot.boxes = boxes;
    return true;
  }

  private updateHull(entity: Contraption, body: EntityRigidBody, dt: number) {
    const node = entity.getEntityNode(body.id);
    if (!node) return null;
    let hull = this.hulls.get(entity);
    if (!hull || hull.nodeId !== body.id) {
      if (hull) this.removeHull(hull);
      const pose = this.toLocal(body.position);
      const rigid = this.physics.createRigidBody(this.module.RigidBodyDesc.dynamic()
        .setTranslation(pose.x, pose.y, pose.z).setRotation(body.quaternion).setCanSleep(false).setCcdEnabled(true));
      hull = {
        entity, nodeId: body.id, body: rigid, pivot: null,
        voxel: emptyHullShape(), decorations: emptyHullShape(), configuration: [],
      };
      this.hulls.set(entity, hull);
      this.counts.bodyCreates++;
    }
    const pivot = node.pivotLocal;
    const oldPivot = hull.pivot;
    const offset = { x: -pivot.x, y: -pivot.y, z: -pivot.z };
    if (!oldPivot || pivot.x !== oldPivot.x || pivot.y !== oldPivot.y || pivot.z !== oldPivot.z) {
      // Shape coordinates are in the construction frame. A pivot edit shifts
      // their attachment without changing the shape of either collider.
      hull.voxel.collider?.setTranslationWrtParent(offset);
      hull.decorations.collider?.setTranslationWrtParent(offset);
      hull.pivot = { x: pivot.x, y: pivot.y, z: pivot.z };
    }
    const voxels = entity.getVoxelTerrainCollisionBoxes();
    const decorations = entity.getDecorationTerrainCollisionBoxes();
    const start = performance.now();
    const voxelsChanged = this.updateShape(hull.voxel, voxels, hull, body, offset);
    const decorationsChanged = this.updateShape(hull.decorations, decorations, hull, body, offset);
    if (voxelsChanged || decorationsChanged) {
      this.counts.voxelRebuilds += Number(voxelsChanged);
      this.counts.decorationRebuilds += Number(decorationsChanged);
      this.counts.hullRebuilds++;
      if (this.hullRebuildMs.length < 2048) this.hullRebuildMs.push(performance.now() - start);
    }
    const configuration = [body.mass, body.inverseInertia, body.friction, body.restitution,
      body.linearDamping, body.angularDamping, dt];
    if (configuration.some((value, i) => value !== hull.configuration[i])) {
      const inertia = body.inverseInertia > 0 ? 1 / body.inverseInertia : 0;
      hull.body.setLinearDamping((body.linearDamping ** (-dt * 60) - 1) / dt);
      hull.body.setAngularDamping((body.angularDamping ** (-dt * 60) - 1) / dt);
      hull.body.setAdditionalMassProperties(body.mass, zero, { x: inertia, y: inertia, z: inertia }, identity, true);
      for (const { collider } of [hull.voxel, hull.decorations]) {
        collider?.setFriction(body.friction / 0.7);
        collider?.setRestitution(body.restitution);
      }
      hull.configuration = configuration;
    }
    return hull.voxel.collider || hull.decorations.collider ? hull : null;
  }

  override prepareContraptionFrame(entity: Contraption, delta: number): Frame {
    const frame = super.prepareContraptionFrame(entity, delta);
    if (!this.eligible) return frame;
    if (!frame || this.isSleeping(entity) || frame.dynamicBodies.length !== 1 || entity.constraintDefinitions.size > 0) {
      this.eligible = false;
      return frame;
    }
    const body = frame.dynamicBodies[0];
    if (body.id !== entity.rootComponentId || !entity.isNodeCollisionEnabled(body.id)
      || entity.getRigidBodies().some(other => other !== body && entity.isNodeCollisionEnabled(other.id))) {
      this.eligible = false;
      return frame;
    }
    const { x, y, z } = body.position;
    const b = this.bounds;
    if (x < b.minX + 4 || x > b.maxX - 4 || z < b.minZ + 4 || z > b.maxZ - 4
      || y < b.minY + 1 || y > b.maxY - 1) {
      this.eligible = false;
      return frame;
    }

    if (this.frames.length === 0) this.refreshTerrain();
    const hull = this.updateHull(entity, body, frame.substepDt);
    if (!hull) {
      this.eligible = false;
      return frame;
    }
    const local = this.toLocal(body.position), previous = hull.body.translation(), rotation = hull.body.rotation();
    if (local.x !== previous.x || local.y !== previous.y || local.z !== previous.z) hull.body.setTranslation(local, true);
    if (rotation.x !== body.quaternion.x || rotation.y !== body.quaternion.y
      || rotation.z !== body.quaternion.z || rotation.w !== body.quaternion.w) hull.body.setRotation(body.quaternion, true);
    hull.body.setLinvel(body.velocity, true);
    hull.body.setAngvel(body.angularVelocity, true);
    hull.body.setGravityScale(entity.getNodeGravityEnabled(body.id) ? 1 : 0, true);
    const input = frame.frameInputs.get(body.id)!;
    hull.body.resetForces(false);
    hull.body.resetTorques(false);
    if (input.force.lengthSq() > 0.0001) hull.body.addForce(input.force, true);
    if (input.torque.lengthSq() > 0.0001) hull.body.addTorque(input.torque, true);
    this.physics.timestep = frame.substepDt;
    this.frames.push({ frame, hull });
    return frame;
  }

  override prepareContraptionPairFrame(...args: Parameters<ContraptionPhysics['prepareContraptionPairFrame']>) {
    if (this.batch && this.eligible) return { colliders: [], collisionCandidates: [] };
    return super.prepareContraptionPairFrame(...args);
  }

  override stepContraptionFrame(frame: Frame) {
    if (!this.eligible) return super.stepContraptionFrame(frame);
    // The manager visits each entity per substep. One Rapier step advances all of them.
    if (!frame || this.frames[0]?.frame !== frame) return;
    this.physics.step();
    this.counts.steps++;
    for (const pending of this.frames) this.reportContacts(pending.frame, pending.hull);
    for (const pending of this.frames) this.publishPose(pending.frame, pending.hull);
  }

  private reportContacts(frame: NonNullable<Frame>, hull: Hull) {
    const [body] = frame.dynamicBodies;
    for (const { collider } of [hull.voxel, hull.decorations]) {
      if (!collider) continue;
      if (this.batch) {
        this.physics.contactPairsWith(collider, other => {
          const entity = this.owners.get(other.handle);
          if (entity === frame.contraption) return;
          this.recordPair(frame.contraption, body, collider, other, entity);
        });
      } else if (this.terrainCollider) {
        this.recordPair(frame.contraption, body, collider, this.terrainCollider);
      }
    }
  }

  private recordPair(entity: Contraption, body: EntityRigidBody, collider: Rapier.Collider, other: Rapier.Collider,
    otherEntity?: Contraption) {
    this.physics.contactPair(collider, other, (manifold, flipped) => {
      if (!manifold.numSolverContacts()) return;
      const point = manifold.solverContactPoint(0), normal = manifold.normal();
      if (!point) return;
      const sign = flipped ? 1 : -1;
      body.isOnGround ||= sign * normal.y > 0.55;
      this.counts.contacts++;
      const relative = body.velocity.toArray();
      const otherVelocity = otherEntity?.velocity;
      if (otherVelocity) {
        relative[0] -= otherVelocity.x;
        relative[1] -= otherVelocity.y;
        relative[2] -= otherVelocity.z;
      }
      entity.recordScriptContact({
        kind: otherEntity ? 'entity' : 'terrain', selfNodeId: body.id,
        otherEntityId: otherEntity ? String(otherEntity.publicId || otherEntity.id) : null,
        otherNodeId: otherEntity?.rootComponentId ?? null, playerId: null,
        position: [point.x + this.origin.x, point.y + this.origin.y, point.z + this.origin.z],
        normal: [sign * normal.x, sign * normal.y, sign * normal.z],
        relativeVelocity: relative, penetration: Math.max(0, -manifold.solverContactDist(0)),
        impulse: manifold.numContacts() ? manifold.contactImpulse(0) : 0,
      });
    });
  }

  private publishPose(frame: NonNullable<Frame>, hull: Hull) {
    const [body] = frame.dynamicBodies;
    const rigid = hull.body;
    const p = rigid.translation(), q = rigid.rotation(), v = rigid.linvel(), w = rigid.angvel();
    body.position.set(p.x + this.origin.x, p.y + this.origin.y, p.z + this.origin.z);
    body.quaternion.set(q.x, q.y, q.z, q.w);
    body.velocity.set(v.x, v.y, v.z);
    body.angularVelocity.set(w.x, w.y, w.z);
    frame.contraption.syncAllBodyTransforms();
    frame.contraption.syncKinematicBodies(frame.substepDt, true);
  }
}
