import type { Vector3 } from 'three';
import type { Contraption } from '../contraption/Contraption.ts';
import type { World } from '../voxel/World.ts';
import type { ScriptContact } from '../scripting/ScriptProtocol.ts';

type SleepEntity = Pick<Contraption, 'position'> & Partial<Pick<Contraption,
  'publicId' | 'isPhysicsSimulationEnabled' | 'physicsWakeVersion' | 'constraintDefinitions' |
  'getRigidBodies' | 'getNodeGravityEnabled' | 'getNodeCollisionEnabled' | 'entityNodes' |
  'collisionEntries' | 'getPhysicsCollisionWorldAABBs' | 'getCollisionWorldAABBs' |
  'recordScriptContact' | 'pendingScriptContacts'>>;
type SleepWorld = Partial<Pick<World, 'terrainVersion' | 'activeChunkKeys' | 'getTerrainCollisionStamp'>>;

const SETTLE_SECONDS = 1;
const MAX_SPEED_SQ = 0.02 ** 2;
const MAX_POSE_DRIFT = 0.002;
// Contact solvers can leave a supported stack buzzing in place: brief speeds
// above MAX_SPEED_SQ with no net motion. A body whose whole pose stays inside
// this envelope (metres; quaternion/matrix components) for SETTLE_SECONDS is
// at rest as well.
const SETTLED_POSE_ENVELOPE = 0.025;

type Pose = { shape: unknown; values: unknown[] };
type SleepState = {
  sleeping: boolean;
  quietTime: number;
  /** Pose at the start of the current at-rest envelope window. */
  envelopePose: Pose | null;
  envelopeTime: number;
  epoch: number;
  pose: Pose | null;
  startPose: Pose | null;
  terrainVersion: number | undefined;
  terrainStamp: unknown[] | null;
  restingContacts: ScriptContact[];
  chunkWindow: unknown;
  supports: Map<SleepEntity, { pose: Pose; epoch: number }>;
  pendingSupports: Set<SleepEntity>;
  /** Settled long enough; sleeps once its whole contact island has settled. */
  ready: boolean;
  /** Simulated entities touched during this update (contact islands). */
  touching: Set<SleepEntity>;
};

/** Whole contraptions sleep together, including their constrained bodies.
 * Script scheduling is unchanged. Sleeping bodies retain resting contact
 * observations with zero impact impulse, and script forces wake them immediately. */
export class ContraptionSleep {
  private states = new WeakMap<object, SleepState>();
  private activeEntities: Set<SleepEntity> | null = null;
  private stoppedPoses = new WeakMap<object, Pose>();
  private world: SleepWorld;

  constructor(world: SleepWorld) { this.world = world; }

  setActiveEntities(entities: SleepEntity[]) {
    this.activeEntities = new Set(entities);
  }

  private state(entity: SleepEntity): SleepState {
    let state = this.states.get(entity);
    if (!state) {
      state = { sleeping: false, quietTime: 0, envelopePose: null, envelopeTime: 0, epoch: 0, pose: null, startPose: null,
        terrainVersion: 0, terrainStamp: null, restingContacts: [], chunkWindow: null, supports: new Map(), pendingSupports: new Set(),
        ready: false, touching: new Set() };
      this.states.set(entity, state);
    }
    return state;
  }

  isSleeping(entity: SleepEntity): boolean { return this.states.get(entity)?.sleeping === true; }

  wake(entity: SleepEntity) {
    const state = this.states.get(entity);
    if (!state) return;
    state.sleeping = false;
    state.ready = false;
    state.quietTime = 0;
    state.envelopePose = null;
    state.envelopeTime = 0;
    state.epoch++;
    state.supports.clear();
    state.restingContacts = [];
  }

  suspend(entity: SleepEntity) {
    const state = this.states.get(entity);
    if (state && (state.sleeping || state.quietTime > 0)) this.wake(entity);
  }

  private pose(entity: SleepEntity): Pose {
    const values: unknown[] = [entity.isPhysicsSimulationEnabled?.(), entity.physicsWakeVersion,
      JSON.stringify([...(entity.constraintDefinitions?.values?.() || [])])];
    for (const body of entity.getRigidBodies?.() || []) {
      values.push(body, body.type, body.simulationEnabled, body.mass, body.inverseInertia,
        body.friction, body.restitution, body.linearDamping, body.angularDamping,
        entity.getNodeGravityEnabled?.(body.id), entity.getNodeCollisionEnabled?.(body.id),
        body.position.x, body.position.y, body.position.z,
        body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    }
    // Include attached/kinematic geometry, even when it has no dynamic body.
    for (const node of entity.entityNodes?.values?.() || []) {
      values.push(node, ...node.group.matrixWorld.elements);
    }
    return { shape: entity.collisionEntries, values };
  }

  private samePose(a: Pose | null, b: Pose, tolerance = 0): boolean {
    return !!a && a.shape === b.shape && a.values.length === b.values.length
      && a.values.every((value, index) => value === b.values[index]
        || (tolerance > 0 && typeof value === 'number' && typeof b.values[index] === 'number'
          && Math.abs(value - (b.values[index] as number)) <= tolerance));
  }

  private eligible(entity: SleepEntity): boolean {
    // A host without terrain revision notifications must keep polling physics:
    // sleeping there could miss a removed floor or a newly loaded collision chunk.
    if (!Number.isFinite(this.world.terrainVersion)) return false;
    if (entity.isPhysicsSimulationEnabled?.() === false) return false;
    return true;
  }

  private terrainStamp(entity: SleepEntity): unknown[] | null {
    if (typeof this.world.getTerrainCollisionStamp !== 'function') return null;
    const boxes = entity.getPhysicsCollisionWorldAABBs?.() || entity.getCollisionWorldAABBs?.() || [];
    if (!boxes.length) return this.world.getTerrainCollisionStamp({
      minX: entity.position.x - 1, maxX: entity.position.x + 1,
      minZ: entity.position.z - 1, maxZ: entity.position.z + 1,
    });
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const box of boxes) {
      minX = Math.min(minX, box.currentMinX ?? box.minX); maxX = Math.max(maxX, box.currentMaxX ?? box.maxX);
      minZ = Math.min(minZ, box.currentMinZ ?? box.minZ); maxZ = Math.max(maxZ, box.currentMaxZ ?? box.maxZ);
    }
    return this.world.getTerrainCollisionStamp({ minX: minX - 0.1, maxX: maxX + 0.1,
      minZ: minZ - 0.1, maxZ: maxZ + 0.1 });
  }

  private terrainChanged(entity: SleepEntity, state: SleepState): boolean {
    const current = this.terrainStamp(entity);
    if (current === null || state.terrainStamp === null) {
      return state.terrainVersion !== this.world.terrainVersion
        || state.chunkWindow !== this.world.activeChunkKeys;
    }
    return current.length !== state.terrainStamp.length
      || current.some((value, index) => value !== state.terrainStamp![index]);
  }

  begin(entity: SleepEntity) {
    const state = this.state(entity);
    if (!this.eligible(entity)) {
      if (state.sleeping || state.quietTime > 0) this.wake(entity);
      return false;
    }
    if (state.sleeping) {
      const changed = !this.eligible(entity)
        || this.terrainChanged(entity, state)
        || !this.samePose(state.pose, this.pose(entity))
        || (entity.getRigidBodies?.() || []).some(body => (
          body.velocity.lengthSq() > 1e-12 || body.angularVelocity.lengthSq() > 1e-12
          || body.appliedForces.lengthSq() > 1e-12 || body.appliedTorques.lengthSq() > 1e-12
        ))
        || [...state.supports].some(([support, saved]) => (
          (this.activeEntities && !this.activeEntities.has(support))
          || saved.epoch !== (this.states.get(support)?.epoch || 0)
          || !this.samePose(saved.pose, this.pose(support))
        ));
      if (changed) this.wake(entity);
    }
    if (!state.sleeping) {
      state.startPose = this.pose(entity);
      state.pendingSupports.clear();
      state.touching.clear();
      state.ready = false;
    }
    if (state.sleeping) {
      for (const contact of state.restingContacts) entity.recordScriptContact?.(contact);
    }
    return state.sleeping;
  }

  stoppedColliderChanged(entity: SleepEntity): boolean {
    const pose = this.pose(entity);
    const previous = this.stoppedPoses.get(entity);
    this.stoppedPoses.set(entity, pose);
    return !this.samePose(previous || null, pose);
  }

  recordSupport(entity: SleepEntity, support: SleepEntity) {
    this.state(entity).pendingSupports.add(support);
  }

  /** Bodies in contact sleep together. Otherwise the first settled body of a
   * stack is woken by its still-settling neighbour, which then is woken by it,
   * and the stack never sleeps (each body settles on a different tick). */
  recordTouch(a: SleepEntity, b: SleepEntity) {
    this.state(a).touching.add(b);
    this.state(b).touching.add(a);
  }

  finish(entity: SleepEntity, dt: number, frameInputs: ReadonlyMap<unknown, { force: Vector3; torque: Vector3 }>) {
    const state = this.state(entity);
    if (state.sleeping || !this.eligible(entity)) return;
    const bodies = entity.getRigidBodies?.() || [];
    const pose = this.pose(entity);
    const supported = bodies.length > 0
      && bodies.every(body => body.type !== 'dynamic' || body.simulationEnabled === false
        || entity.getNodeGravityEnabled?.(body.id) === false || body.isOnGround)
      && [...frameInputs.values()].every(input => input.force.lengthSq() <= 1e-12 && input.torque.lengthSq() <= 1e-12);
    const quiet = supported
      && this.samePose(state.startPose, pose, MAX_POSE_DRIFT)
      && bodies.every(body => body.velocity.lengthSq() <= MAX_SPEED_SQ && body.angularVelocity.lengthSq() <= MAX_SPEED_SQ);
    state.quietTime = quiet ? state.quietTime + dt : 0;
    if (supported && this.samePose(state.envelopePose, pose, SETTLED_POSE_ENVELOPE)) state.envelopeTime += dt;
    else {
      state.envelopePose = supported ? pose : null;
      state.envelopeTime = 0;
    }
    state.ready = Math.max(state.quietTime, state.envelopeTime) + 1e-9 >= SETTLE_SECONDS;
  }

  /** After every entity of one update finished: put each contact island to
   * sleep at once, but only when all of its simulated members have settled.
   * Entities outside this update (stopped or kinematic-only colliders) are
   * static supports and do not hold an island awake. */
  commit(entities: Iterable<SleepEntity>) {
    const members = new Set(entities);
    const visited = new Set<SleepEntity>();
    for (const start of members) {
      if (visited.has(start)) continue;
      const island: SleepEntity[] = [];
      const queue = [start];
      visited.add(start);
      let settled = true;
      while (queue.length) {
        const entity = queue.pop()!;
        const state = this.states.get(entity);
        if (!state || state.sleeping) continue;
        island.push(entity);
        if (!state.ready) settled = false;
        for (const other of state.touching) {
          if (!members.has(other) || visited.has(other)) continue;
          visited.add(other);
          queue.push(other);
        }
      }
      if (!settled) continue;
      for (const entity of island) this.fallAsleep(entity, this.states.get(entity)!);
    }
  }

  private fallAsleep(entity: SleepEntity, state: SleepState) {
    const bodies = entity.getRigidBodies?.() || [];
    const pose = this.pose(entity);
    state.sleeping = true;
    state.ready = false;
    for (const body of bodies) {
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
    }
    state.pose = pose;
    state.terrainVersion = this.world.terrainVersion;
    state.terrainStamp = this.terrainStamp(entity);
    // ctx.contacts describes contact observations, not discrete collision events.
    // Preserve resting support without replaying the impulse of an old impact.
    const supports = new Set([...state.pendingSupports].map(support => support.publicId));
    state.restingContacts = (entity.pendingScriptContacts || [])
      .filter(contact => contact.kind === 'terrain'
        || (contact.kind === 'entity' && contact.otherEntityId != null && supports.has(contact.otherEntityId)))
      .map(contact => ({ ...contact, relativeVelocity: [0, 0, 0], impulse: 0,
        penetration: 0, sleeping: true }));
    state.chunkWindow = this.world.activeChunkKeys;
    state.supports = new Map([...state.pendingSupports].map(support => [support, {
      pose: this.pose(support), epoch: this.states.get(support)?.epoch || 0,
    }]));
  }
}
