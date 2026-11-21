import type * as Rapier from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import type { Contraption } from '../contraption/Contraption.ts';
import type { EntityRigidBody } from '../contraption/EntityTypes.ts';
import { ContraptionPhysics } from '../physics/ContraptionPhysics.ts';
import { collisionBoundsOverlap, type CollisionBounds, type CollisionBox } from '../physics/CollisionGeometry.ts';
import { MICRO_SIZE } from '../voxel/MicroGrid.ts';
import type { World } from '../voxel/World.ts';
import { boxCompound, canPublishTerrain, identity, RapierTerrain, toLocal, zero, type RapierModule } from './RapierTerrain.ts';

type Frame = NonNullable<ReturnType<ContraptionPhysics['prepareContraptionFrame']>>;
type PairFrame = ReturnType<ContraptionPhysics['prepareContraptionPairFrame']>;
type Shape = { source: readonly CollisionBox[] | null; boxes: readonly CollisionBox[]; collider: Rapier.Collider | null };
type Resident = {
  entity: Contraption;
  nodeId: string;
  rigid: Rapier.RigidBody;
  pivot: Rapier.Vector;
  voxel: Shape;
  decoration: Shape;
  settings: number[];
};
type Route = { body: EntityRigidBody; frame: Frame | undefined; bounds: CollisionBounds };
type Contact = { point: Rapier.Vector; normal: Rapier.Vector; distance: number; impulse: number };
const emptyShape = (): Shape => ({ source: null, boxes: [], collider: null });
const noPairs: PairFrame = { colliders: [], collisionCandidates: [] };
const originGrid = 128;

function sameVector(a: Rapier.Vector, b: Rapier.Vector) {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function sameRotation(a: Rapier.Rotation, b: Rapier.Rotation) {
  return sameVector(a, b) && a.w === b.w;
}

/** Shared contraption solver. A fixed update is routed after scripts and before
 * the first substep so contacts between nearby entities have a single owner. */
export class RapierContraptionPhysics extends ContraptionPhysics {
  private readonly module: RapierModule;
  private readonly physics: Rapier.World;
  private readonly terrain: RapierTerrain;
  private readonly residents = new Map<Contraption, Resident>();
  private readonly owners = new Map<number, Resident>();
  private readonly frames = new Map<Contraption, Frame>();
  private readonly routes = new Map<Contraption, Route>();
  private readonly dynamic: { route: Route; resident: Resident }[] = [];
  private origin = zero;
  readonly counts = { steps: 0, bodyCreates: 0, voxelRebuilds: 0, decorationRebuilds: 0 };

  constructor(module: RapierModule, world: World) {
    super(world);
    this.module = module;
    this.physics = new module.World(this.gravity);
    this.terrain = new RapierTerrain(module, this.physics, world, this.origin);
  }

  get terrainRebuilds() { return this.terrain.rebuilt; }

  /** The host owns the lifetime of the native world and all of its colliders. */
  dispose() { this.physics.free(); }

  override beginEntityUpdate(entities: Contraption[]) {
    super.beginEntityUpdate(entities);
    this.frames.clear();
    this.routes.clear();
    this.dynamic.length = 0;
    if (!this.residents.size) return;
    const present = new Set(entities);
    for (const [entity, resident] of this.residents) {
      if (!present.has(entity)) this.remove(resident);
    }
  }

  private remove(resident: Resident) {
    for (const { collider } of [resident.voxel, resident.decoration]) {
      if (collider) this.owners.delete(collider.handle);
    }
    this.physics.removeRigidBody(resident.rigid);
    this.residents.delete(resident.entity);
  }

  override update(entity: Contraption, dt: number) {
    this.beginEntityUpdate([entity]);
    const frame = this.prepareContraptionFrame(entity, dt);
    this.prepareContraptionPairFrame([entity]);
    if (!frame) return;
    for (let step = 0; step < frame.subSteps; step++) this.stepContraptionFrame(frame);
    this.finishContraptionFrame(frame);
    this.commitSleep([entity]);
  }

  override prepareContraptionFrame(entity: Contraption, dt: number) {
    const frame = super.prepareContraptionFrame(entity, dt);
    if (frame) this.frames.set(entity, frame);
    return frame;
  }

  override frameBroadphaseBounds(entity: Contraption, dt: number) {
    const bounds = super.frameBroadphaseBounds(entity, dt);
    const frame = this.frames.get(entity);
    // The base sweep includes current velocity. Include one full tick of linear
    // force and gravity as well, for both tile publication and solver boundaries.
    if (!frame) return bounds;
    let acceleration = this.gravity.length();
    for (const body of frame.dynamicBodies) {
      acceleration = Math.max(acceleration, this.gravity.length() + frame.frameInputs.get(body.id)!.force.length() / body.mass);
    }
    const pad = Number.isFinite(acceleration) ? acceleration * dt * dt : 0;
    return { minX: bounds.minX - pad, minY: bounds.minY - pad, minZ: bounds.minZ - pad,
      maxX: bounds.maxX + pad, maxY: bounds.maxY + pad, maxZ: bounds.maxZ + pad };
  }

  private routeFor(entity: Contraption, candidates: ReadonlyMap<Contraption, CollisionBounds> | null): Route | null {
    const frame = this.frames.get(entity);
    const body = entity.getRigidBody(entity.rootComponentId);
    const root = entity.getEntityNode(entity.rootComponentId);
    if (!body || !root || entity.isWrenchGrabbed || entity.constraintDefinitions.size > 0
      || entity.getRigidBodies().some(other => other !== body && entity.isNodeCollisionEnabled(other.id))) return null;
    if (frame) {
      if (frame.dynamicBodies.length !== 1 || frame.dynamicBodies[0] !== body) return null;
      const { force, torque } = frame.frameInputs.get(body.id)!;
      if (![...force, ...torque, body.mass, body.inverseInertia, body.linearDamping, body.angularDamping,
        body.friction, body.restitution].every(Number.isFinite)
        || body.mass <= 0 || body.linearDamping <= 0 || body.angularDamping <= 0) return null;
    } else if (entity.isPhysicsSimulationEnabled() || body.velocity.lengthSq() > 0 || body.angularVelocity.lengthSq() > 0
      || !sameVector(body.position, entity.previousPosition) || !sameRotation(body.quaternion, entity.previousQuaternion)) {
      // An authored/replicated moving kinematic body keeps its existing sweep and velocity transfer.
      return null;
    }
    if (![...body.position, ...body.quaternion, ...body.velocity, ...body.angularVelocity, ...root.pivotLocal].every(Number.isFinite)) return null;
    const bounds = candidates?.get(entity) ?? this.frameBroadphaseBounds(entity, frame?.dt ?? 0);
    if (!canPublishTerrain(bounds)) return null;
    return { body, frame, bounds };
  }

  override prepareContraptionPairFrame(entities: Contraption[], bounds: ReadonlyMap<Contraption, CollisionBounds> | null = null): PairFrame {
    if (!this.frames.size) {
      this.stageResidents();
      return super.prepareContraptionPairFrame(entities, bounds);
    }
    const fallback = new Set<Contraption>();
    for (const entity of entities) {
      if (!entity.getRigidBodies().length) continue;
      const route = this.routeFor(entity, bounds);
      if (route) this.routes.set(entity, route);
      else fallback.add(entity);
    }
    let pairFrame = noPairs;
    if (fallback.size) {
      const pairs = super.prepareContraptionPairFrame(entities, bounds);
      const edges = pairs.collisionCandidates;
      // Route the whole connected component. A collision can transmit an
      // impulse through several bodies within one fixed update.
      const neighbours = pairs.colliders.map((): number[] => []);
      for (const [a, b] of edges) {
        neighbours[a].push(b);
        neighbours[b].push(a);
      }
      const pending = pairs.colliders.flatMap((entity, i) => fallback.has(entity) ? [i] : []);
      for (let i = 0; i < pending.length; i++) {
        for (const other of neighbours[pending[i]]) {
          const entity = pairs.colliders[other];
          if (fallback.has(entity)) continue;
          fallback.add(entity);
          pending.push(other);
        }
      }
      for (const entity of fallback) this.routes.delete(entity);
      pairFrame = { colliders: pairs.colliders,
        collisionCandidates: edges.filter(([a, b]) => fallback.has(pairs.colliders[a]) && fallback.has(pairs.colliders[b])) };
    }
    this.stageResidents();
    return pairFrame;
  }

  private stageResidents() {
    const anchor = [...this.routes.values()].find(route => route.frame)?.body.position;
    if (anchor && (this.origin === zero || Math.abs(anchor.x - this.origin.x) > 2 * originGrid
      || Math.abs(anchor.z - this.origin.z) > 2 * originGrid)) {
      this.origin = { x: Math.round(anchor.x / originGrid) * originGrid, y: 0,
        z: Math.round(anchor.z / originGrid) * originGrid };
    }
    this.terrain.begin(this.origin);
    for (const [entity, resident] of this.residents) {
      if (!anchor || !this.routes.has(entity)) resident.rigid.setEnabled(false);
    }
    if (!anchor) {
      this.terrain.finish();
      return;
    }

    const edited: CollisionBounds[] = [];
    for (const [entity, route] of this.routes) {
      const resident = this.updateResident(entity, route, edited);
      if (!route.frame) continue;
      this.dynamic.push({ route, resident });
      if (entity.isNodeCollisionEnabled(route.body.id) && (resident.voxel.collider || resident.decoration.collider)
        && this.terrain.publish(route.bounds)) resident.rigid.wakeUp();
    }
    this.physics.timestep = this.dynamic[0].route.frame!.substepDt;
    for (const { route, resident } of this.dynamic) {
      if (resident.rigid.isSleeping() && edited.some(bounds => collisionBoundsOverlap(bounds, route.bounds))) resident.rigid.wakeUp();
    }
    this.terrain.finish();
  }

  private updateResident(entity: Contraption, route: Route, edited: CollisionBounds[]) {
    const { body, frame } = route;
    const dynamic = Boolean(frame);
    const type = dynamic ? this.module.RigidBodyType.Dynamic : this.module.RigidBodyType.Fixed;
    let resident = this.residents.get(entity);
    if (resident && resident.nodeId !== body.id) {
      this.remove(resident);
      resident = undefined;
    }
    if (!resident) {
      const rigid = this.physics.createRigidBody(new this.module.RigidBodyDesc(type).setCcdEnabled(true));
      resident = { entity, nodeId: body.id, rigid, pivot: zero, voxel: emptyShape(), decoration: emptyShape(), settings: [] };
      this.residents.set(entity, resident);
      this.counts.bodyCreates++;
    }

    const { rigid } = resident;
    if (!rigid.isEnabled()) rigid.setEnabled(true);
    if (rigid.bodyType() !== type) rigid.setBodyType(type, true);
    const local = toLocal(body.position, this.origin);
    const position = { x: Math.fround(local.x), y: Math.fround(local.y), z: Math.fround(local.z) };
    const q = body.quaternion;
    const rotation = { x: Math.fround(q.x), y: Math.fround(q.y), z: Math.fround(q.z), w: Math.fround(q.w) };
    const moved = !sameVector(rigid.translation(), position) || !sameRotation(rigid.rotation(), rotation);
    if (moved) {
      rigid.setTranslation(position, true);
      rigid.setRotation(body.quaternion, true);
    }
    const pivot = entity.getEntityNode(body.id)!.pivotLocal;
    const pivotMoved = !sameVector(resident.pivot, pivot);
    if (pivotMoved) {
      resident.pivot = { x: pivot.x, y: pivot.y, z: pivot.z };
      const offset = { x: -pivot.x, y: -pivot.y, z: -pivot.z };
      resident.voxel.collider?.setTranslationWrtParent(offset);
      resident.decoration.collider?.setTranslationWrtParent(offset);
    }
    const enabled = entity.isNodeCollisionEnabled(body.id);
    const voxelChanged = this.updateShape(resident, resident.voxel, entity.getVoxelPhysicsCollisionBoxes(), body);
    const decorChanged = this.updateShape(resident, resident.decoration, entity.getDecorationCollisionBoxes(), body);
    this.counts.voxelRebuilds += Number(voxelChanged);
    this.counts.decorationRebuilds += Number(decorChanged);
    let collisionChanged = false;
    for (const { collider } of [resident.voxel, resident.decoration]) {
      if (!collider || collider.isEnabled() === enabled) continue;
      collider.setEnabled(enabled);
      collisionChanged = true;
    }
    if (voxelChanged || decorChanged || pivotMoved || collisionChanged || (!dynamic && moved)) {
      edited.push(route.bounds);
      if (dynamic) rigid.wakeUp();
    }

    const settings = [body.mass, body.inverseInertia, body.friction, body.restitution, body.linearDamping,
      body.angularDamping, frame?.substepDt ?? 0, Number(entity.getNodeGravityEnabled(body.id))];
    if (settings.some((value, i) => value !== resident.settings[i])) {
      if (frame) {
        const dt = frame.substepDt;
        const inertia = body.inverseInertia > 0 ? 1 / body.inverseInertia : 0;
        rigid.setAdditionalMassProperties(body.mass, zero, { x: inertia, y: inertia, z: inertia }, identity, true);
        rigid.setLinearDamping((body.linearDamping ** (-dt * 60) - 1) / dt);
        rigid.setAngularDamping((body.angularDamping ** (-dt * 60) - 1) / dt);
        rigid.setGravityScale(settings[7], true);
      }
      for (const { collider } of [resident.voxel, resident.decoration]) {
        collider?.setFriction(Math.sqrt(body.friction));
        collider?.setRestitution(body.restitution);
      }
      resident.settings = settings;
    }
    if (frame) {
      this.resetSleep(entity);
      body.isOnGround = false;
      if (!sameVector(rigid.linvel(), body.velocity)) rigid.setLinvel(body.velocity, true);
      if (!sameVector(rigid.angvel(), body.angularVelocity)) rigid.setAngvel(body.angularVelocity, true);
      const { force, torque } = frame.frameInputs.get(body.id)!;
      rigid.resetForces(false);
      rigid.resetTorques(false);
      if (force.lengthSq() > 0.0001) rigid.addForce(force, true);
      if (torque.lengthSq() > 0.0001) rigid.addTorque(torque, true);
    }
    return resident;
  }

  private updateShape(resident: Resident, slot: Shape, source: readonly CollisionBox[], body: EntityRigidBody) {
    if (slot.source === source) return false;
    slot.source = source;
    const boxes = source.filter(box => box.entityId === body.id);
    const previous = slot.boxes;
    slot.boxes = boxes;
    if (previous.length === boxes.length && boxes.every((box, i) => {
      const old = previous[i];
      return box === old || (box.x === old.x && box.y === old.y && box.z === old.z
        && box.spanX === old.spanX && box.spanY === old.spanY && box.spanZ === old.spanZ);
    })) return false;
    if (!boxes.length) {
      if (!slot.collider) return false;
      this.owners.delete(slot.collider.handle);
      this.physics.removeCollider(slot.collider, true);
      slot.collider = null;
      return true;
    }
    const shape = boxCompound(this.module, boxes.map(box => ({
      minX: box.x * MICRO_SIZE, minY: box.y * MICRO_SIZE, minZ: box.z * MICRO_SIZE,
      maxX: (box.x + box.spanX) * MICRO_SIZE, maxY: (box.y + box.spanY) * MICRO_SIZE, maxZ: (box.z + box.spanZ) * MICRO_SIZE,
    })));
    if (slot.collider) slot.collider.setShape(shape);
    else {
      const { x, y, z } = resident.pivot;
      const { Multiply, Max } = this.module.CoefficientCombineRule;
      slot.collider = this.physics.createCollider(new this.module.ColliderDesc(shape)
        .setTranslation(-x, -y, -z).setDensity(0).setFriction(Math.sqrt(body.friction)).setFrictionCombineRule(Multiply)
        .setRestitution(body.restitution).setRestitutionCombineRule(Max), resident.rigid);
      this.owners.set(slot.collider.handle, resident);
    }
    return true;
  }

  override stepContraptionFrame(frame: Frame | null) {
    if (!frame || !this.routes.has(frame.contraption)) return super.stepContraptionFrame(frame);
    if (frame !== this.dynamic[0]?.route.frame) return;
    this.physics.step();
    this.counts.steps++;
    const { normalizedAllowedLinearError, lengthUnit } = this.physics.integrationParameters;
    const contactTolerance = normalizedAllowedLinearError * lengthUnit;
    for (const { route, resident } of this.dynamic) this.publishContacts(route.body, resident, contactTolerance);
    for (const { route, resident } of this.dynamic) {
      const { body } = route;
      const { rigid, entity } = resident;
      const p = rigid.translation(), q = rigid.rotation(), v = rigid.linvel(), w = rigid.angvel();
      body.position.set(p.x + this.origin.x, p.y + this.origin.y, p.z + this.origin.z);
      body.quaternion.set(q.x, q.y, q.z, q.w);
      body.velocity.set(v.x, v.y, v.z);
      body.angularVelocity.set(w.x, w.y, w.z);
      entity.syncAllBodyTransforms();
      entity.syncKinematicBodies(frame.substepDt, true);
    }
  }

  private publishContacts(body: EntityRigidBody, resident: Resident, contactTolerance: number) {
    const sleeping = resident.rigid.isSleeping();
    for (const { collider, boxes } of [resident.voxel, resident.decoration]) {
      if (!collider) continue;
      this.physics.contactPairsWith(collider, other => {
        const owner = this.owners.get(other.handle);
        if (owner === resident) return;
        let geometric: Contact | null = null;
        let reportedSolverContact = false;
        this.physics.contactPair(collider, other, (manifold, flipped) => {
          const sign = flipped ? 1 : -1;
          const n = manifold.normal();
          const normal = { x: n.x * sign, y: n.y * sign, z: n.z * sign };
          const solverPoint = manifold.numSolverContacts() ? manifold.solverContactPoint(0) : null;
          if (solverPoint) {
            reportedSolverContact = true;
            this.recordContact(body, resident, owner, { point: solverPoint, normal,
              distance: manifold.solverContactDist(0), impulse: manifold.numContacts() ? manifold.contactImpulse(0) : 0 }, sleeping);
            return;
          }
          // Compound contact clustering can leave only geometric contacts in the
          // exposed manifold. Keep support and report the deepest of those points.
          for (let i = 0, count = manifold.numContacts(); i < count; i++) {
            const distance = manifold.contactDist(i);
            if (distance > contactTolerance) continue;
            body.isOnGround ||= normal.y > 0.55;
            if (reportedSolverContact || (geometric && geometric.distance <= distance)) continue;
            const box = boxes[flipped ? manifold.subshape2() : manifold.subshape1()];
            const local = flipped ? manifold.localContactPoint2(i) : manifold.localContactPoint1(i);
            if (!box || !local) continue;
            const point = new Vector3(local.x + (box.x + box.spanX / 2) * MICRO_SIZE,
              local.y + (box.y + box.spanY / 2) * MICRO_SIZE, local.z + (box.z + box.spanZ / 2) * MICRO_SIZE)
              .applyQuaternion(collider.rotation()).add(collider.translation());
            geometric = { point, normal, distance, impulse: manifold.contactImpulse(i) };
          }
        });
        if (!reportedSolverContact && geometric) this.recordContact(body, resident, owner, geometric, sleeping);
      });
    }
  }

  private recordContact(body: EntityRigidBody, resident: Resident, owner: Resident | undefined, contact: Contact, sleeping: boolean) {
    const { point, normal, distance, impulse } = contact;
    body.isOnGround ||= normal.y > 0.55;
    const relative = owner ? owner.entity.velocity.clone().sub(body.velocity) : body.velocity;
    resident.entity.recordScriptContact({
      kind: owner ? 'entity' : 'terrain', selfNodeId: body.id,
      otherEntityId: owner?.entity.publicId ?? null, otherNodeId: owner?.nodeId ?? null, playerId: null,
      position: [point.x + this.origin.x, point.y + this.origin.y, point.z + this.origin.z],
      normal: [normal.x, normal.y, normal.z], relativeVelocity: sleeping ? [0, 0, 0] : relative.toArray(),
      penetration: Math.max(0, -distance), impulse: sleeping ? 0 : impulse,
      ...(sleeping ? { sleeping: true } : {}),
    });
  }

  override finishContraptionFrame(frame: Frame | null) {
    if (!frame || !this.routes.has(frame.contraption)) return super.finishContraptionFrame(frame);
    frame.contraption.isOnGround = frame.dynamicBodies[0].isOnGround;
  }

  override isSleeping(entity: Contraption) {
    if (this.routes.get(entity)?.frame) return this.residents.get(entity)?.rigid.isSleeping() ?? false;
    return super.isSleeping(entity);
  }
}
