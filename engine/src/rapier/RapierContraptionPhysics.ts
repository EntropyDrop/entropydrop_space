import type * as Rapier from '@entropydrop/rapier3d-compat';
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Contraption } from '../contraption/Contraption.ts';
import type { EntityRigidBody, RuntimeConstraint } from '../contraption/EntityTypes.ts';
import { ContraptionPhysics } from '../physics/ContraptionPhysics.ts';
import { collisionBoundsOverlap, type CollisionBounds, type CollisionBox } from '../physics/CollisionGeometry.ts';
import { PHYSICS_SUBSTEPS_PER_ENTITY_UPDATE } from '../simulation/EntitySimulationClock.ts';
import { TORUS_SIZE_X, TORUS_SIZE_Z } from '../torus/TorusWorld.ts';
import { MICRO_SIZE } from '../voxel/MicroGrid.ts';
import type { World } from '../voxel/World.ts';
import { boxCompound, identity, RapierTerrain, toLocal, zero, type RapierModule } from './RapierTerrain.ts';

type Frame = NonNullable<ReturnType<ContraptionPhysics['prepareContraptionFrame']>>;
type PairFrame = ReturnType<ContraptionPhysics['prepareContraptionPairFrame']>;
type Shape = { source: readonly CollisionBox[] | null; boxes: readonly CollisionBox[]; collider: Rapier.Collider | null };
type Resident = {
  entity: Contraption;
  body: EntityRigidBody;
  rigid: Rapier.RigidBody;
  parent: Resident;
  voxel: Shape;
  decoration: Shape;
  settings: number[];
  position: Vector3;
  rotation: Quaternion;
};
type Joint = {
  definition: RuntimeConstraint; a: Resident | undefined; b: Resident; native: Rapier.ImpulseJoint;
  timestep?: number;
  anchorA?: Vector3; frameA?: Quaternion; anchorB?: Vector3; frameB?: Quaternion;
};
type Assembly = {
  bodies: Map<string, Resident>;
  joints: Map<string, Joint>;
  connected: Set<string>;
  sources: { voxel?: readonly CollisionBox[]; decoration?: readonly CollisionBox[] };
  shapes: { voxel: Map<string, CollisionBox[]>; decoration: Map<string, CollisionBox[]> };
};
type KinematicMove = {
  resident: Resident;
  start: Vector3;
  rotation: Quaternion;
  target: Vector3;
  targetRotation: Quaternion;
  replica: boolean;
};
type ShapePose = { shape: Rapier.Shape; position: Rapier.Vector; rotation: Rapier.Rotation };
type Contact = { point: Rapier.Vector; normal: Rapier.Vector; distance: number; impulse: number };
const emptyShape = (): Shape => ({ source: null, boxes: [], collider: null });
const emptyBoxes: readonly CollisionBox[] = [];
const noPairs: PairFrame = { colliders: [], collisionCandidates: [] };
const originGrid = 128;
const unitX = new Vector3(1, 0, 0);
const unitY = new Vector3(0, 1, 0);
const bodyPair = (a: string, b: string) => JSON.stringify(a < b ? [a, b] : [b, a]);

function sameVector(a: Rapier.Vector, b: Rapier.Vector) {
  return a.x === Math.fround(b.x) && a.y === Math.fround(b.y) && a.z === Math.fround(b.z);
}

function sameRotation(a: Rapier.Rotation, b: Rapier.Rotation) {
  return sameVector(a, b) && a.w === Math.fround(b.w);
}

function jointFrame(axis: number[], reference: number[]) {
  const x = new Vector3().fromArray(axis).normalize();
  if (!x.lengthSq()) x.set(0, 0, 1);
  const y = new Vector3().fromArray(reference);
  y.addScaledVector(x, -x.dot(y));
  if (y.lengthSq() < 1e-12) {
    y.copy(Math.abs(x.y) < 0.9 ? unitY : unitX).addScaledVector(x, -x.dot(y));
  }
  y.normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, x.clone().cross(y)));
}

function boxesByBody(source: readonly CollisionBox[]) {
  const grouped = new Map<string, CollisionBox[]>();
  for (const box of source) {
    const boxes = grouped.get(box.entityId);
    if (boxes) boxes.push(box);
    else grouped.set(box.entityId, [box]);
  }
  return grouped;
}

export class RapierContraptionPhysics extends ContraptionPhysics {
  readonly module: RapierModule;
  private readonly physics: Rapier.World;
  private readonly terrain: RapierTerrain;
  private readonly assemblies = new Map<Contraption, Assembly>();
  private readonly owners = new Map<number, Resident>();
  private readonly frames = new Map<Contraption, Frame>();
  private readonly kinematic: KinematicMove[] = [];
  private readonly participants: Resident[] = [];
  private readonly carriers: Resident[] = [];
  private readonly sweptBounds = new Map<Contraption, CollisionBounds>();
  private readonly drivenContacts = new Set<string>();
  private externalAnchor?: Rapier.RigidBody;
  private firstFrame?: Frame;
  private origin = zero;
  private substep = 0;
  readonly counts = { steps: 0, bodyCreates: 0, voxelRebuilds: 0, decorationRebuilds: 0, jointCreates: 0 };

  private readonly hooks: Rapier.PhysicsHooks = {
    filterContactPair: (first, second) => {
      const a = this.owners.get(first), b = this.owners.get(second);
      if (a && b && a.entity === b.entity && !this.assemblies.get(a.entity)?.connected.has(bodyPair(a.body.id, b.body.id))) {
        return null;
      }
      return this.module.SolverFlags.COMPUTE_IMPULSE;
    },
    filterIntersectionPair: () => true,
  };

  constructor(module: RapierModule, world: World) {
    super(world);
    this.module = module;
    this.physics = new module.World(this.gravity);
    this.terrain = new RapierTerrain(module, this.physics, world, this.origin);
  }

  get terrainRebuilds() { return this.terrain.rebuilt; }
  dispose() { this.physics.free(); }

  override beginEntityUpdate(entities: Contraption[]) {
    this.frames.clear();
    this.kinematic.length = 0;
    this.participants.length = 0;
    this.carriers.length = 0;
    this.sweptBounds.clear();
    this.firstFrame = undefined;
    this.substep = 0;

    const present = new Set(entities);
    for (const [entity, assembly] of this.assemblies) {
      if (present.has(entity)) continue;
      for (const resident of assembly.bodies.values()) this.removeBodyShapes(resident);
      for (const resident of assembly.bodies.values()) this.physics.removeRigidBody(resident.rigid);
      this.assemblies.delete(entity);
    }
  }

  private removeShape(slot: Shape) {
    if (!slot.collider) return;
    this.owners.delete(slot.collider.handle);
    this.physics.removeCollider(slot.collider, true);
    slot.collider = null;
    slot.source = null;
    slot.boxes = emptyBoxes;
  }

  private removeBodyShapes(resident: Resident) {
    this.removeShape(resident.voxel);
    this.removeShape(resident.decoration);
  }

  override update(entity: Contraption, dt: number) {
    this.beginEntityUpdate([entity]);
    const frame = this.prepareContraptionFrame(entity, dt);
    this.prepareContraptionPairFrame([entity]);
    if (!frame) return;
    for (let step = 0; step < frame.subSteps; step++) this.stepContraptionFrame(frame);
    this.finishContraptionFrame(frame);
  }

  override prepareContraptionFrame(entity: Contraption, dt: number) {
    const bodies = entity.getRigidBodies();
    if (!(dt > 0) || !bodies.length) return null;
    const enabled = entity.isPhysicsSimulationEnabled();
    const replica = entity.serverManaged === true && entity.serverExecutesLocally !== true
      && entity.serverDesiredRunState === 'running';
    if (!enabled && !replica) return null;
    if (enabled) entity.syncKinematicBodies(dt);
    const dynamicBodies = enabled ? bodies.filter(body => this.isSimulatedDynamicBody(body)) : [];
    if (!this.isSleeping(entity)) entity.groundDistance = this.getGroundDistance(entity.position);
    const frameInputs: Frame['frameInputs'] = new Map();
    for (const body of dynamicBodies) {
      frameInputs.set(body.id, { force: body.appliedForces.clone(), torque: body.appliedTorques.clone() });
      body.appliedForces.set(0, 0, 0);
      body.appliedTorques.set(0, 0, 0);
    }
    const subSteps = PHYSICS_SUBSTEPS_PER_ENTITY_UPDATE;
    const frame: Frame = { contraption: entity, dynamicBodies, frameInputs, dt, subSteps, substepDt: dt / subSteps };
    this.frames.set(entity, frame);
    return frame;
  }

  override frameBroadphaseBounds(entity: Contraption, dt: number) {
    const bounds = super.frameBroadphaseBounds(entity, dt);
    const frame = this.frames.get(entity);
    let acceleration = this.gravity.length();
    for (const body of frame?.dynamicBodies ?? []) {
      acceleration = Math.max(acceleration, this.gravity.length() + frame!.frameInputs.get(body.id)!.force.length() / body.mass);
    }
    const pad = Number.isFinite(acceleration) ? acceleration * dt * dt : 0;
    return { minX: bounds.minX - pad, minY: bounds.minY - pad, minZ: bounds.minZ - pad,
      maxX: bounds.maxX + pad, maxY: bounds.maxY + pad, maxZ: bounds.maxZ + pad };
  }

  override prepareContraptionPairFrame(entities: Contraption[], bounds: ReadonlyMap<Contraption, CollisionBounds> | null = null): PairFrame {
    // Manager visits the frame list in the opposite order from its entity list.
    // The first staged frame is a sentinel; every native body advances together.
    this.firstFrame = this.frames.values().next().value;
    const anchor = this.firstFrame?.contraption.position ?? entities[0]?.position;
    const previousOrigin = this.origin;
    if (anchor && (this.origin === zero || Math.abs(anchor.x - this.origin.x) > 2 * originGrid
      || Math.abs(anchor.z - this.origin.z) > 2 * originGrid)) {
      this.origin = { x: Math.round(anchor.x / originGrid) * originGrid, y: 0,
        z: Math.round(anchor.z / originGrid) * originGrid };
    }
    if (this.origin !== previousOrigin) {
      for (const { bodies } of this.assemblies.values()) {
        for (const { rigid } of bodies.values()) {
          const p = rigid.translation();
          rigid.setTranslation({ x: p.x + previousOrigin.x - this.origin.x, y: p.y, z: p.z + previousOrigin.z - this.origin.z }, false);
        }
      }
      this.externalAnchor?.setTranslation(toLocal(zero, this.origin), false);
    }

    this.terrain.begin(this.origin);
    const edited: CollisionBounds[] = [];
    const sleeping: { bounds: CollisionBounds; resident: Resident }[] = [];
    for (const entity of entities) {
      const frame = this.frames.get(entity);
      const entityBounds = bounds?.get(entity) ?? this.frameBroadphaseBounds(entity, frame?.dt ?? 0);
      this.sweptBounds.set(entity, entityBounds);
      const assembly = this.stageAssembly(entity, frame, entityBounds, edited);
      if (!assembly || !frame) continue;
      if (entity.isCollisionSimulationEnabled() && this.terrain.publish(entityBounds)) edited.push(entityBounds);
      for (const resident of assembly.bodies.values()) {
        if (resident.rigid.isDynamic() && resident.rigid.isSleeping()) sleeping.push({ bounds: entityBounds, resident });
      }
    }
    for (const { bounds: box, resident } of sleeping) {
      if (edited.some(change => collisionBoundsOverlap(change, box))) resident.rigid.wakeUp();
    }
    this.terrain.finish();
    if (this.firstFrame) this.physics.timestep = this.firstFrame.substepDt;
    return noPairs;
  }

  private stageAssembly(entity: Contraption, frame: Frame | undefined, bounds: CollisionBounds, edited: CollisionBounds[]) {
    const bodies = entity.getRigidBodies();
    if (!bodies.length) return null;
    let assembly = this.assemblies.get(entity);
    if (!assembly) {
      assembly = { bodies: new Map(), joints: new Map(), connected: new Set(),
        sources: {}, shapes: { voxel: new Map(), decoration: new Map() } };
      this.assemblies.set(entity, assembly);
    }
    const liveIds = new Set(bodies.map(body => body.id));
    for (const resident of assembly.bodies.values()) {
      if (!liveIds.has(resident.body.id) || !liveIds.has(resident.parent.body.id)) this.removeBodyShapes(resident);
    }
    for (const [id, resident] of assembly.bodies) {
      if (liveIds.has(id)) continue;
      this.physics.removeRigidBody(resident.rigid);
      assembly.bodies.delete(id);
    }
    this.refreshShapes(entity, assembly);
    for (const body of bodies) {
      let resident = assembly.bodies.get(body.id);
      if (!resident) {
        const previous = entity.getEntityNode(body.id)?.previousWorldMatrix;
        const position = body.position.clone();
        const rotation = body.quaternion.clone();
        if (frame && previous && !frame.frameInputs.has(body.id)) {
          if (body.id === entity.rootComponentId) position.setFromMatrixPosition(previous);
          else position.copy(body.centerOfMassLocal).applyMatrix4(previous);
          rotation.setFromRotationMatrix(previous);
        }
        const rigid = this.physics.createRigidBody(this.module.RigidBodyDesc.fixed()
          .setTranslation(position.x - this.origin.x, position.y, position.z - this.origin.z)
          .setRotation(rotation).setCcdEnabled(true));
        resident = { entity, body, rigid, parent: null!, voxel: emptyShape(), decoration: emptyShape(),
          settings: [], position: new Vector3(), rotation: new Quaternion() };
        resident.parent = resident;
        assembly.bodies.set(body.id, resident);
        this.counts.bodyCreates++;
      }
      resident.body = body;
    }
    for (const resident of assembly.bodies.values()) {
      const { body } = resident;
      const input = frame?.frameInputs.get(body.id);
      const carrier = frame && entity.isPhysicsSimulationEnabled() ? this.contactBodyFor(entity, body) : body;
      const parent = frame?.frameInputs.has(carrier.id) ? assembly.bodies.get(carrier.id)! : resident;
      if (parent !== resident.parent) {
        this.removeShape(resident.voxel);
        this.removeShape(resident.decoration);
        resident.parent = parent;
      }
      const movedCollider = this.stageBody(resident, frame, input);
      const voxelChanged = this.updateShape(resident, resident.voxel, assembly.shapes.voxel.get(body.id) ?? emptyBoxes, body);
      const decorChanged = this.updateShape(resident, resident.decoration, assembly.shapes.decoration.get(body.id) ?? emptyBoxes, body);
      this.counts.voxelRebuilds += Number(voxelChanged);
      this.counts.decorationRebuilds += Number(decorChanged);
      const placementChanged = this.placeShapes(resident);
      if (voxelChanged || decorChanged || placementChanged || movedCollider) {
        edited.push(bounds);
        if (parent.rigid.isDynamic()) parent.rigid.wakeUp();
      }
      this.participants.push(resident);
      if (resident !== parent) this.carriers.push(resident);
    }
    this.syncJoints(entity, assembly, frame);
    return assembly;
  }

  private refreshShapes(entity: Contraption, assembly: Assembly) {
    const shapes = { voxel: entity.getVoxelPhysicsCollisionBoxes(), decoration: entity.getDecorationCollisionBoxes() };
    for (const name of ['voxel', 'decoration'] as const) {
      if (assembly.sources[name] === shapes[name]) continue;
      assembly.sources[name] = shapes[name];
      assembly.shapes[name] = boxesByBody(shapes[name]);
    }
  }

  private stageBody(resident: Resident, frame: Frame | undefined, input: { force: Vector3; torque: Vector3 } | undefined) {
    const { body, rigid } = resident;
    const types = this.module.RigidBodyType;
    const position = toLocal(body.position, this.origin);
    const previousPosition = rigid.translation();
    const xWrap = Math.round((position.x - previousPosition.x) / TORUS_SIZE_X) * TORUS_SIZE_X;
    const zWrap = Math.round((position.z - previousPosition.z) / TORUS_SIZE_Z) * TORUS_SIZE_Z;
    if (xWrap || zWrap) {
      previousPosition.x += xWrap;
      previousPosition.z += zWrap;
      rigid.setTranslation(previousPosition, false);
    }
    const previousRotation = rigid.rotation();
    const moved = !sameVector(previousPosition, position) || !sameRotation(previousRotation, body.quaternion);
    const replica = !resident.entity.isPhysicsSimulationEnabled();
    const kinematic = frame && !input && resident.parent === resident && moved;
    const type = input ? types.Dynamic : kinematic ? types.KinematicPositionBased : types.Fixed;
    const changedType = rigid.bodyType() !== type;
    if (changedType) {
      rigid.setBodyType(type, true);
      resident.settings = [];
    }
    rigid.setEnabled(resident.parent === resident);
    if (kinematic) {
      this.kinematic.push({
        resident, start: new Vector3(previousPosition.x, previousPosition.y, previousPosition.z),
        rotation: new Quaternion(previousRotation.x, previousRotation.y, previousRotation.z, previousRotation.w),
        target: new Vector3(position.x, position.y, position.z), targetRotation: body.quaternion.clone(), replica,
      });
    } else if (moved) {
      rigid.setTranslation(position, true);
      rigid.setRotation(body.quaternion, true);
    }

    if (!input || !frame) return moved;
    const dt = frame.substepDt;
    const gravity = Number(resident.entity.getNodeGravityEnabled(body.id));
    const settings = [body.mass, body.inverseInertia, body.linearDamping, body.angularDamping, dt, gravity];
    if (settings.some((value, i) => value !== resident.settings[i])) {
      const inertia = body.inverseInertia > 0 ? 1 / body.inverseInertia : 0;
      rigid.setAdditionalMassProperties(body.mass, zero, { x: inertia, y: inertia, z: inertia }, identity, true);
      const damping = (value: number) => (Math.max(1e-6, Math.min(1, value)) ** (-dt * 60) - 1) / dt;
      rigid.setLinearDamping(damping(body.linearDamping));
      rigid.setAngularDamping(damping(body.angularDamping));
      rigid.setGravityScale(gravity, true);
      resident.settings = settings;
    }
    if (!sameVector(rigid.linvel(), body.velocity)) rigid.setLinvel(body.velocity, true);
    if (!sameVector(rigid.angvel(), body.angularVelocity)) rigid.setAngvel(body.angularVelocity, true);
    rigid.resetForces(false);
    rigid.resetTorques(false);
    if (input.force.lengthSq() > 1e-12) rigid.addForce(input.force, true);
    if (input.torque.lengthSq() > 1e-12) rigid.addTorque(input.torque, true);
    return false;
  }

  private placeShapes(resident: Resident) {
    const { entity, body, parent } = resident;
    const pivot = entity.getEntityNode(body.id)!.pivotLocal;
    const position = pivot.clone().add(body.centerOfMassLocal).negate();
    const rotation = new Quaternion();
    if (parent !== resident) {
      const inverse = parent.body.quaternion.clone().invert();
      rotation.copy(inverse).multiply(body.quaternion);
      position.applyQuaternion(body.quaternion).add(body.position).sub(parent.body.position).applyQuaternion(inverse);
    }
    const moved = !sameVector(resident.position, position) || !sameRotation(resident.rotation, rotation);
    resident.position.set(Math.fround(position.x), Math.fround(position.y), Math.fround(position.z));
    resident.rotation.set(Math.fround(rotation.x), Math.fround(rotation.y), Math.fround(rotation.z), Math.fround(rotation.w));
    const enabled = entity.isNodeCollisionEnabled(body.id);
    const hooks = (this.assemblies.get(entity)?.bodies.size ?? 1) > 1
      ? this.module.ActiveHooks.FILTER_CONTACT_PAIRS : this.module.ActiveHooks.NONE;
    let changed = moved;
    for (const { collider } of [resident.voxel, resident.decoration]) {
      if (!collider) continue;
      if (!sameVector(collider.translationWrtParent() ?? zero, position)) collider.setTranslationWrtParent(position);
      if (!sameRotation(collider.rotationWrtParent() ?? identity, rotation)) collider.setRotationWrtParent(rotation);
      if (collider.activeHooks() !== hooks) collider.setActiveHooks(hooks);
      if (collider.isEnabled() !== enabled) {
        collider.setEnabled(enabled);
        changed = true;
      }
      const friction = Math.sqrt(body.friction);
      if (collider.friction() !== Math.fround(friction)) collider.setFriction(friction);
      if (collider.restitution() !== Math.fround(body.restitution)) collider.setRestitution(body.restitution);
    }
    return changed;
  }

  private *bodyColliders(resident: Resident) {
    for (const { collider } of [resident.voxel, resident.decoration]) {
      if (collider?.isEnabled()) yield collider;
    }
  }

  private bodyShapePose(resident: Resident, collider: Rapier.Collider): ShapePose {
    const rigid = resident.parent.rigid;
    const p = rigid.translation(), q = rigid.rotation();
    const rotation = new Quaternion(q.x, q.y, q.z, q.w);
    return { shape: collider.shape,
      position: resident.position.clone().applyQuaternion(rotation).add(new Vector3(p.x, p.y, p.z)),
      rotation: rotation.multiply(resident.rotation) };
  }

  private nearbyShapes(entity: Contraption, bounds: CollisionBounds, immovableOnly: boolean) {
    const obstacles: ShapePose[] = [];
    for (const tile of this.terrain.collidersIn(bounds)) {
      obstacles.push({ shape: tile.shape, position: tile.translation(), rotation: tile.rotation() });
    }
    for (const other of this.participants) {
      const otherBounds = this.sweptBounds.get(other.entity);
      if (other.entity === entity || !otherBounds || !collisionBoundsOverlap(bounds, otherBounds)
        || (immovableOnly && other.parent.rigid.isDynamic())) continue;
      for (const collider of this.bodyColliders(other)) obstacles.push(this.bodyShapePose(other, collider));
    }
    return obstacles;
  }

  private sweepTranslation(sources: ShapePose[], obstacles: ShapePose[], delta: Vector3) {
    let fraction = 1;
    const normals: Vector3[] = [];
    for (const source of sources) for (const obstacle of obstacles) {
      const impact = source.shape.castShape(source.position, source.rotation, delta,
        obstacle.shape, obstacle.position, obstacle.rotation, zero, 0.001, fraction, false);
      if (!impact) continue;
      const q = obstacle.rotation;
      const n = impact.normal2;
      const normal = new Vector3(n.x, n.y, n.z).applyQuaternion(new Quaternion(q.x, q.y, q.z, q.w));
      if (normal.dot(delta) >= -1e-8) continue;
      fraction = Math.min(fraction, Math.max(0, impact.time_of_impact));
      if (!normals.some(other => other.dot(normal) > 0.999)) normals.push(normal);
    }
    return { fraction, normals };
  }

  override constrainWrenchVelocity(entity: Contraption, body: EntityRigidBody, desiredVelocity: Vector3, dt: number) {
    const resident = this.assemblies.get(entity)?.bodies.get(body.id);
    if (!resident || !entity.isCollisionSimulationEnabled() || !desiredVelocity.lengthSq()) {
      return { velocity: desiredVelocity.clone(), normals: [] };
    }
    const delta = desiredVelocity.clone().multiplyScalar(dt);
    const bounds = this.frameBroadphaseBounds(entity, dt);
    const sources = [...this.bodyColliders(resident)].map(collider => this.bodyShapePose(resident, collider));
    const { fraction, normals } = this.sweepTranslation(sources, this.nearbyShapes(entity, bounds, false), delta);
    return { velocity: desiredVelocity.clone().multiplyScalar(fraction), normals };
  }

  private clampKinematicRotation(resident: Resident, shapes: ShapePose[], obstacles: ShapePose[], target: Vector3, rotation: Quaternion) {
    const q = resident.rigid.rotation();
    const start = new Quaternion(q.x, q.y, q.z, q.w);
    if (start.angleTo(rotation) < 1e-6 || !shapes.length || !obstacles.length) return;
    const contactDepth = (fraction: number) => {
      const pose = start.clone().slerp(rotation, fraction);
      const position = resident.position.clone().applyQuaternion(pose).add(target);
      pose.multiply(resident.rotation);
      let distance = 0;
      for (const { shape } of shapes) for (const obstacle of obstacles) {
        const contact = shape.contactShape(position, pose, obstacle.shape, obstacle.position, obstacle.rotation, 0);
        if (contact) distance = Math.min(distance, contact.distance);
      }
      return distance;
    };
    const minimum = contactDepth(0) - 0.001;
    const samples = Math.max(1, Math.ceil(start.angleTo(rotation) / 0.1));
    for (let step = 1; step <= samples; step++) {
      if (contactDepth(step / samples) >= minimum) continue;
      let low = (step - 1) / samples, high = step / samples;
      for (let refine = 0; refine < 6; refine++) {
        const middle = (low + high) / 2;
        if (contactDepth(middle) >= minimum) low = middle;
        else high = middle;
      }
      rotation.copy(start.slerp(rotation, low));
      return;
    }
  }

  private syncJoints(entity: Contraption, assembly: Assembly, frame: Frame | undefined) {
    const { bodies, joints, connected } = assembly;
    connected.clear();
    for (const [id, joint] of joints) {
      const definition = entity.constraintDefinitions.get(id);
      if (frame && definition === joint.definition && joint.native.isValid()
        && bodies.get(definition.bodyA ?? '')?.parent === joint.a && bodies.get(definition.bodyB)?.parent === joint.b) continue;
      if (joint.native.isValid()) this.physics.removeImpulseJoint(joint.native, true);
      joints.delete(id);
    }
    if (!frame) return;
    for (const def of entity.constraintDefinitions.values()) {
      const first = def.bodyA === null ? undefined : bodies.get(def.bodyA);
      const second = bodies.get(def.bodyB);
      if (!second || (def.bodyA !== null && !first)) continue;
      if (def.collideConnected && first) connected.add(bodyPair(first.body.id, second.body.id));
      const a = first?.parent, b = second.parent;
      if (a === b || !(a?.rigid.isDynamic() || b.rigid.isDynamic()) || def.stiffness <= 0) continue;
      const localA = jointFrame(def.axisA, def.referenceA);
      const localB = jointFrame(def.axisB, def.referenceB);
      const anchorA = new Vector3().fromArray(def.anchorA);
      const anchorB = new Vector3().fromArray(def.anchorB);
      if (first && a && first !== a) this.convertJointFrame(first, a, anchorA, localA);
      if (second !== b) this.convertJointFrame(second, b, anchorB, localB);
      const data = this.module.JointData;
      let existing = joints.get(def.id);
      if (!existing) {
        const joint = def.stiffness < 1 ? data.generic(anchorA, anchorB, unitX, 0 as Rapier.JointAxesMask)
          : def.type === 'point' ? data.spherical(anchorA, anchorB)
            : def.type === 'weld' ? data.fixed(anchorA, localA, anchorB, localB)
              : data.revoluteWithAxes(anchorA, anchorB, unitX.clone().applyQuaternion(localA), unitX.clone().applyQuaternion(localB));
        const fixed = a?.rigid ?? (this.externalAnchor ??= this.physics.createRigidBody(
          this.module.RigidBodyDesc.fixed().setTranslation(-this.origin.x, 0, -this.origin.z)));
        const native = this.physics.createImpulseJoint(joint, fixed, b.rigid, true);
        native.setContactsEnabled(true); // Contact ownership is filtered by component, including attached shapes.
        existing = { definition: def, a, b, native };
        joints.set(def.id, existing);
        this.counts.jointCreates++;
      }
      if (!existing.anchorA?.equals(anchorA) || !existing.frameA?.equals(localA)) {
        existing.native.setLocalFrame1(anchorA, localA);
        existing.anchorA = anchorA;
        existing.frameA = localA;
      }
      if (!existing.anchorB?.equals(anchorB) || !existing.frameB?.equals(localB)) {
        existing.native.setLocalFrame2(anchorB, localB);
        existing.anchorB = anchorB;
        existing.frameB = localB;
      }
      if (existing.timestep !== frame.substepDt) this.configureJoint(existing, frame.substepDt);
    }
  }

  private configureJoint(joint: Joint, dt: number) {
    const { definition: def, native } = joint;
    joint.timestep = dt;
    const raw = this.physics.impulseJoints.raw;
    const axis = this.module.JointAxis;
    type RawAxis = Parameters<typeof raw.jointSetLimits>[1];
    if (def.stiffness < 1) {
      // Map the dimensionless authored stiffness to critically damped native
      // motors scaled to one solver substep. Full stiffness uses hard joints.
      const frequency = Math.sqrt(def.stiffness / Math.max(1e-4, 1 - def.stiffness)) / dt;
      const axes = [axis.LinX, axis.LinY, axis.LinZ];
      if (def.type !== 'point') axes.push(axis.AngY, axis.AngZ);
      if (def.type === 'weld') axes.push(axis.AngX);
      for (const motor of axes) {
        raw.jointConfigureMotorPosition(native.handle, motor as number as RawAxis, 0, frequency ** 2, 2 * frequency);
      }
    }
    if (def.type === 'hinge' && def.limits) {
      raw.jointSetLimits(native.handle, axis.AngX as number as RawAxis, def.limits.min, def.limits.max);
    }
  }

  private convertJointFrame(from: Resident, to: Resident, anchor: Vector3, rotation: Quaternion) {
    const inverse = to.body.quaternion.clone().invert();
    anchor.applyQuaternion(from.body.quaternion).add(from.body.position).sub(to.body.position).applyQuaternion(inverse);
    rotation.premultiply(from.body.quaternion).premultiply(inverse);
  }

  private updateShape(resident: Resident, slot: Shape, source: readonly CollisionBox[], body: EntityRigidBody) {
    if (slot.source === source) return false;
    const boxes = source;
    const previous = slot.boxes;
    if (previous.length === boxes.length && boxes.every((box, i) => {
      const old = previous[i];
      return box === old || (box.x === old.x && box.y === old.y && box.z === old.z
        && box.spanX === old.spanX && box.spanY === old.spanY && box.spanZ === old.spanZ);
    })) {
      slot.source = source;
      return false;
    }
    if (!boxes.length) {
      slot.source = source;
      if (!slot.collider) return false;
      this.owners.delete(slot.collider.handle);
      this.physics.removeCollider(slot.collider, true);
      slot.collider = null;
      slot.source = source;
      slot.boxes = boxes;
      return true;
    }
    const shape = boxCompound(this.module, boxes.map(box => ({
      minX: box.x * MICRO_SIZE, minY: box.y * MICRO_SIZE, minZ: box.z * MICRO_SIZE,
      maxX: (box.x + box.spanX) * MICRO_SIZE, maxY: (box.y + box.spanY) * MICRO_SIZE, maxZ: (box.z + box.spanZ) * MICRO_SIZE,
    })));
    if (slot.collider) slot.collider.setShape(shape);
    else {
      const { Multiply, Max } = this.module.CoefficientCombineRule;
      slot.collider = this.physics.createCollider(new this.module.ColliderDesc(shape)
        .setDensity(0).setFriction(Math.sqrt(body.friction)).setFrictionCombineRule(Multiply)
        .setRestitution(body.restitution).setRestitutionCombineRule(Max), resident.parent.rigid);
      this.owners.set(slot.collider.handle, resident);
    }
    slot.source = source;
    slot.boxes = boxes;
    return true;
  }

  override stepContraptionFrame(frame: Frame | null) {
    if (frame !== this.firstFrame || !frame) return;
    const alpha = ++this.substep / frame.subSteps;
    for (const move of this.kinematic) {
      const { rigid, entity } = move.resident;
      const target = move.start.clone().lerp(move.target, alpha);
      const rotation = move.rotation.clone().slerp(move.targetRotation, alpha);
      const before = rigid.translation();
      const delta = target.clone().sub(new Vector3(before.x, before.y, before.z));
      const bounds = this.sweptBounds.get(entity);
      if (!move.replica && bounds) {
        const shapes = [...this.bodyColliders(move.resident)].map(collider => this.bodyShapePose(move.resident, collider));
        const obstacles = this.nearbyShapes(entity, bounds, true);
        if (delta.lengthSq() > 1e-12) {
          const { fraction } = this.sweepTranslation(shapes, obstacles, delta);
          target.addScaledVector(delta, fraction - 1);
        }
        this.clampKinematicRotation(move.resident, shapes, obstacles, target, rotation);
      }
      rigid.setNextKinematicTranslation(target);
      rigid.setNextKinematicRotation(rotation);
    }
    this.physics.step(undefined, this.hooks);
    this.counts.steps++;
    this.drivenContacts.clear();
    const { normalizedAllowedLinearError, lengthUnit } = this.physics.integrationParameters;
    const tolerance = normalizedAllowedLinearError * lengthUnit;
    for (const { body } of this.participants) body.isOnGround = false;
    for (const resident of this.participants) {
      if (resident.parent.rigid.isDynamic() || resident.rigid.isKinematic()) this.publishContacts(resident.body, resident, tolerance);
      if (resident.body.isOnGround) resident.parent.body.isOnGround = true;
    }
    for (const resident of this.participants) {
      if (!resident.rigid.isDynamic()) continue;
      const { body, rigid } = resident;
      const p = rigid.translation(), q = rigid.rotation(), v = rigid.linvel(), w = rigid.angvel();
      body.position.set(p.x + this.origin.x, p.y, p.z + this.origin.z);
      body.quaternion.set(q.x, q.y, q.z, q.w);
      body.velocity.set(v.x, v.y, v.z);
      body.angularVelocity.set(w.x, w.y, w.z);
    }
    if (this.substep === frame.subSteps) for (const { resident, replica } of this.kinematic) {
      if (replica) continue;
      const { entity, body, rigid } = resident;
      const position = rigid.translation(), rotation = rigid.rotation();
      body.position.set(position.x + this.origin.x, position.y, position.z + this.origin.z);
      body.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      entity.syncBodyToNode(body);
    }
    for (const { contraption } of this.frames.values()) {
      contraption.syncAllBodyTransforms();
      contraption.syncKinematicBodies(frame.substepDt, true);
    }
    for (const resident of this.carriers) this.placeShapes(resident);
  }

  private publishContacts(body: EntityRigidBody, resident: Resident, contactTolerance: number) {
    const sleeping = resident.rigid.isSleeping();
    for (const { collider, boxes } of [resident.voxel, resident.decoration]) {
      if (!collider) continue;
      this.physics.contactPairsWith(collider, other => {
        const owner = this.owners.get(other.handle);
        if (owner?.entity === resident.entity) return;
        let geometric: Contact | null = null;
        let reportedSolverContact = false;
        this.physics.contactPair(collider, other, (manifold, flipped) => {
          const sign = flipped ? 1 : -1;
          const n = manifold.normal();
          const normal = { x: n.x * sign, y: n.y * sign, z: n.z * sign };
          const solverPoint = manifold.numSolverContacts() ? manifold.solverContactPoint(0) : null;
          if (solverPoint) {
            reportedSolverContact = true;
            const impulse = manifold.numContacts() ? manifold.contactImpulse(0) : 0;
            this.applyDrivenFriction(resident, owner, collider, other, solverPoint, normal, impulse);
            this.recordContact(body, resident, owner, { point: solverPoint, normal,
              distance: manifold.solverContactDist(0), impulse }, sleeping);
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

  /** Script-driven child surfaces change relative contact velocity even
   * though their colliders belong to (and react through) the dynamic carrier. */
  private applyDrivenFriction(a: Resident, b: Resident | undefined, first: Rapier.Collider, second: Rapier.Collider,
    point: Rapier.Vector, normal: Rapier.Vector, normalImpulse: number) {
    if (!(normalImpulse > 0) || (a.parent === a && (!b || b.parent === b))) return;
    const key = first.handle < second.handle ? `${first.handle}:${second.handle}` : `${second.handle}:${first.handle}`;
    if (this.drivenContacts.has(key)) return;
    this.drivenContacts.add(key);
    const carrierA = a.parent.rigid, carrierB = b?.parent.rigid;
    const invMass = (carrierA.isDynamic() ? carrierA.invMass() : 0)
      + (carrierB?.isDynamic() ? carrierB.invMass() : 0);
    if (!(invMass > 0)) return;
    const contact = new Vector3(point.x + this.origin.x, point.y, point.z + this.origin.z);
    const speed = a.entity.getKinematicPointVelocityOffset(a.body.id, contact);
    if (b) speed.sub(b.entity.getKinematicPointVelocityOffset(b.body.id, contact));
    const up = new Vector3(normal.x, normal.y, normal.z);
    speed.addScaledVector(up, -speed.dot(up));
    const limit = first.friction() * second.friction() * normalImpulse;
    const impulse = speed.multiplyScalar(-1 / invMass).clampLength(0, limit);
    if (impulse.lengthSq() <= 1e-12) return;
    if (carrierA.isDynamic()) carrierA.applyImpulseAtPoint(impulse, point, true);
    if (carrierB?.isDynamic()) carrierB.applyImpulseAtPoint(impulse.negate(), point, true);
  }

  private recordContact(body: EntityRigidBody, resident: Resident, owner: Resident | undefined, contact: Contact, sleeping: boolean) {
    const { point, normal, distance, impulse } = contact;
    body.isOnGround ||= normal.y > 0.55;
    const velocity = this.bodyPointVelocity(body, new Vector3(point.x + this.origin.x, point.y, point.z + this.origin.z));
    const relative = owner ? this.bodyPointVelocity(owner.body, new Vector3(point.x + this.origin.x, point.y, point.z + this.origin.z)).sub(velocity) : velocity;
    resident.entity.recordScriptContact({
      kind: owner ? 'entity' : 'terrain', selfNodeId: body.id,
      otherEntityId: owner?.entity.publicId ?? null, otherNodeId: owner?.body.id ?? null, playerId: null,
      position: [point.x + this.origin.x, point.y + this.origin.y, point.z + this.origin.z],
      normal: [normal.x, normal.y, normal.z], relativeVelocity: sleeping ? [0, 0, 0] : relative.toArray(),
      penetration: Math.max(0, -distance), impulse: sleeping ? 0 : impulse,
      ...(sleeping ? { sleeping: true } : {}),
    });
  }

  override finishContraptionFrame(frame: Frame | null) {
    if (frame) frame.contraption.isOnGround = frame.contraption.getRigidBody()?.isOnGround ?? false;
  }

  // Pair contacts and sleep were already solved by the shared native step.
  override resolvePreparedContraptionPairs() { return false; }
  override commitSleep() {}

  override isSleeping(entity: Contraption) {
    const assembly = this.assemblies.get(entity);
    if (!assembly) return false;
    let dynamic = false;
    for (const { rigid } of assembly.bodies.values()) {
      if (!rigid.isDynamic()) continue;
      if (!rigid.isSleeping()) return false;
      dynamic = true;
    }
    return dynamic;
  }
}
