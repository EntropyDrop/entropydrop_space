import type * as THREE from 'three';
import { createGeometryArena, getGeometryKernels, type GeometryArena } from './GeometryKernels.ts';

// The geometry switch selects the complete reference path. This additional
// override isolates solver costs while leaving collision geometry in WASM.
export type PhysicsSolverMode = 'auto' | 'js';
let mode: PhysicsSolverMode = typeof process !== 'undefined' && process.env.SPACE_PHYSICS_SOLVER_BACKEND === 'js' ? 'js' : 'auto';
let shared: PhysicsSolverKernels | undefined;
export function setPhysicsSolverMode(value: PhysicsSolverMode): PhysicsSolverMode {
  const previous = mode; mode = value; return previous;
}
export function getPhysicsSolverKernels(): PhysicsSolverKernels | null {
  if (mode === 'js' || !getGeometryKernels()) return null;
  return shared ??= new PhysicsSolverKernels(createGeometryArena()!);
}

const BASE = 65536, BODY = 20, JOINT = 24, LIMIT = 32 * 1024 * 1024;
function writeVector(data: Float64Array, offset: number, v: THREE.Vector3) {
  data[offset] = v.x; data[offset + 1] = v.y; data[offset + 2] = v.z;
}
function readVector(data: Float64Array, offset: number, v: THREE.Vector3) {
  v.set(data[offset], data[offset + 1], data[offset + 2]);
}
function dynamic(body): boolean { return body?.type === 'dynamic' && body.simulationEnabled !== false; }
function packBody(data: Float64Array, offset: number, body) {
  if (!body) {
    data.fill(0, offset, offset + BODY); data[offset + 6] = 1; return;
  }
  writeVector(data, offset, body.position);
  const q = body.quaternion;
  data[offset + 3] = q?.x ?? 0; data[offset + 4] = q?.y ?? 0;
  data[offset + 5] = q?.z ?? 0; data[offset + 6] = q?.w ?? 1;
  // Joint-only hosts need only pose and mass; contact callers supply velocities.
  if (body.velocity) writeVector(data, offset + 7, body.velocity);
  else data.fill(0, offset + 7, offset + 10);
  if (body.angularVelocity) writeVector(data, offset + 10, body.angularVelocity);
  else data.fill(0, offset + 10, offset + 13);
  data[offset + 13] = dynamic(body) && body.mass > 0 ? 1 / body.mass : 0;
  data[offset + 14] = body.inverseInertia;
  data[offset + 15] = dynamic(body) ? 1 : 0;
  data[offset + 16] = body.restitution; data[offset + 17] = body.friction;
  data[offset + 18] = body.mass;
}
function unpackVelocity(data: Float64Array, offset: number, body) {
  readVector(data, offset + 7, body.velocity); readVector(data, offset + 10, body.angularVelocity);
}

/** One reusable, bounded arena. No host state is changed until a call completes. */
export class PhysicsSolverKernels {
  private view: Float64Array | undefined;
  private readonly arena: GeometryArena;
  constructor(arena: GeometryArena) { this.arena = arena; }

  private reserve(length: number): Float64Array | null {
    const end = BASE + length * 8;
    if (!Number.isSafeInteger(end) || end > LIMIT) return null;
    this.arena.reserve(end);
    const buffer = this.arena.exports.memory.buffer;
    if (!this.view || this.view.buffer !== buffer) this.view = new Float64Array(buffer, BASE);
    return this.view;
  }

  /** Pack once, retain all mutable poses for every iteration, then publish once. */
  solveConstraints(contraption, constraints: any[], iterations: number): boolean {
    if (!(iterations > 0) || constraints.length === 0) return true;
    if (!Number.isFinite(iterations) || iterations > 0x7fffffff) return false;
    const bodies: any[] = [null], indices = new Map<any, number>();
    const joints: { definition: any; a: number; b: number }[] = [];
    const index = body => {
      if (!body) return 0;
      let i = indices.get(body);
      if (i === undefined) { i = bodies.length; indices.set(body, i); bodies.push(body); }
      return i;
    };
    for (const definition of constraints) {
      const a = definition.bodyA === null ? null : contraption.getRigidBody?.(definition.bodyA);
      const b = contraption.getRigidBody?.(definition.bodyB);
      if (!b || (definition.bodyA !== null && !a)) continue;
      joints.push({ definition, a: index(a), b: index(b) });
    }
    if (!joints.length) return true;
    const jointOffset = bodies.length * BODY;
    const data = this.reserve(jointOffset + joints.length * JOINT);
    if (!data) return false;
    for (let i = 0; i < bodies.length; i++) packBody(data, i * BODY, bodies[i]);
    for (let i = 0; i < joints.length; i++) {
      const { definition: c, a, b } = joints[i], offset = jointOffset + i * JOINT;
      data[offset] = a; data[offset + 1] = b;
      data[offset + 2] = c.type === 'weld' ? 3 : c.type === 'hinge' ? c.limits ? 2 : 1 : 0;
      data[offset + 3] = c.stiffness;
      for (let axis = 0; axis < 3; axis++) {
        data[offset + 4 + axis] = c.anchorA?.[axis] ?? 0;
        data[offset + 7 + axis] = c.anchorB?.[axis] ?? 0;
        data[offset + 10 + axis] = c.axisA?.[axis] ?? 0;
        data[offset + 13 + axis] = c.axisB?.[axis] ?? 0;
        data[offset + 16 + axis] = c.referenceA?.[axis] ?? 0;
        data[offset + 19 + axis] = c.referenceB?.[axis] ?? 0;
      }
      data[offset + 22] = c.limits?.min ?? 0; data[offset + 23] = c.limits?.max ?? 0;
    }
    this.arena.exports.solveJoints(BASE, BASE + jointOffset * 8, joints.length, Math.ceil(iterations));
    for (let i = 1; i < bodies.length; i++) {
      const body = bodies[i];
      if (!dynamic(body)) continue;
      const offset = i * BODY;
      readVector(data, offset, body.position);
      body.quaternion.set(data[offset + 3], data[offset + 4], data[offset + 5], data[offset + 6]);
    }
    return true;
  }

  solvePairImpulse(a, b, ownerA, ownerB, normal: THREE.Vector3, point: THREE.Vector3,
    inverseA: number, inverseB: number, restingVelocity: number): number {
    const data = this.reserve(BODY * 4 + 6)!;
    packBody(data, 0, a); packBody(data, BODY, b);
    // Preserve object aliases, including shared scripted owners/carriers.
    const bIndex = b === a ? 0 : 1;
    const ownerAIndex = ownerA === a ? 0 : ownerA === b ? bIndex : 2;
    const ownerBIndex = ownerB === a ? 0 : ownerB === b ? bIndex : ownerB === ownerA ? ownerAIndex : 3;
    if (ownerAIndex === 2) packBody(data, BODY * 2, ownerA);
    if (ownerBIndex === 3) packBody(data, BODY * 3, ownerB);
    writeVector(data, BODY * 4, normal); writeVector(data, BODY * 4 + 3, point);
    const magnitude = this.arena.exports.solvePairImpulse(BASE, BASE + bIndex * BODY * 8,
      BASE + ownerAIndex * BODY * 8, BASE + ownerBIndex * BODY * 8, BASE + BODY * 4 * 8,
      inverseA, inverseB, restingVelocity);
    unpackVelocity(data, 0, a); unpackVelocity(data, bIndex * BODY, b);
    return magnitude;
  }

  solveTerrainImpulse(body, normal: THREE.Vector3, point: THREE.Vector3, penetration: number,
    points: THREE.Vector3[], dt: number, manifold: THREE.Vector3[], restitution: boolean,
    iterations: number, gravity: number, restingVelocity: number, narrowWidth: number): number | null {
    if (!Number.isFinite(iterations) || iterations > 0x7fffffff) return null;
    const pointCount = points?.length ?? 0, count = manifold.length;
    const pointOffset = BODY + 6, manifoldOffset = pointOffset + pointCount * 3;
    const rowOffset = manifoldOffset + count * 3;
    const data = this.reserve(rowOffset + count * 6);
    if (!data) return null;
    packBody(data, 0, body);
    writeVector(data, BODY, normal); writeVector(data, BODY + 3, point);
    for (let i = 0; i < pointCount; i++) writeVector(data, pointOffset + i * 3, points[i]);
    for (let i = 0; i < count; i++) writeVector(data, manifoldOffset + i * 3, manifold[i]);
    const magnitude = this.arena.exports.solveTerrainImpulse(BASE, BASE + BODY * 8,
      BASE + pointOffset * 8, pointCount, BASE + manifoldOffset * 8, count, BASE + rowOffset * 8,
      penetration, dt, restitution ? 1 : 0, Math.max(0, Math.ceil(iterations)), gravity, restingVelocity, narrowWidth);
    readVector(data, 0, body.position); unpackVelocity(data, 0, body);
    if (normal.y > 0.5) body.isOnGround = true;
    return magnitude;
  }

  toppleSupport(body, normal: THREE.Vector3, dt: number, gravity: number) {
    const data = this.reserve(BODY + 3)!;
    packBody(data, 0, body); writeVector(data, BODY, normal);
    this.arena.exports.toppleSupport(BASE, BASE + BODY * 8, dt, gravity);
    readVector(data, 10, body.angularVelocity);
  }
}
