import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { setGeometryKernelMode } from '../src/wasm/GeometryKernels.ts';
import { getPhysicsSolverKernels, setPhysicsSolverMode } from '../src/wasm/PhysicsSolverKernels.ts';

function random(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}
function body(seed: number): import('../src/contraption/EntityTypes.ts').EntityRigidBody {
  const r = random(seed), v = (scale = 1) => new THREE.Vector3(r() - .5, r() - .5, r() - .5).multiplyScalar(scale);
  return { id: String(seed), nodeId: String(seed), appliedForces: new THREE.Vector3(), appliedTorques: new THREE.Vector3(),
    linearDamping: 0, angularDamping: 0, centerOfMassLocal: new THREE.Vector3(),
    previousKinematicPosition: new THREE.Vector3(), previousKinematicQuaternion: new THREE.Quaternion(), type: seed % 9 === 0 ? 'kinematic' : 'dynamic', simulationEnabled: seed % 11 !== 0,
    position: v(10), quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(...v(4).toArray())),
    velocity: v(5), angularVelocity: v(2), mass: seed % 17 ? .1 + r() * 10 : 0,
    inverseInertia: seed % 13 ? r() * 2 : 0, restitution: r(), friction: r(), isOnGround: false };
}
function state(b: ReturnType<typeof body>) {
  return [...b.position.toArray(), ...b.quaternion.toArray(), ...b.velocity.toArray(), ...b.angularVelocity.toArray(), +b.isOnGround];
}
function near(actual: number[], expected: number[], label: string, epsilon = 2e-11) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= epsilon * Math.max(1, Math.abs(expected[i])), `${label}/${i}: ${actual[i]} != ${expected[i]}`);
  }
}
function modes(work: () => void) {
  const geometry = setGeometryKernelMode('wasm'), solver = setPhysicsSolverMode('auto');
  try { assert.ok(getPhysicsSolverKernels()); work(); }
  finally { setPhysicsSolverMode(solver); setGeometryKernelMode(geometry); }
}

test('WASM joint iterations preserve ordered point, hinge, limited hinge and weld corrections', () => modes(() => {
  const physics = new ContraptionPhysics({} as any);
  for (let seed = 1; seed <= 300; seed++) {
    const run = (mode: 'js' | 'auto') => {
      setPhysicsSolverMode(mode);
      const bodies = Array.from({ length: 6 }, (_, i) => body(seed + i));
      const r = random(seed), vector = () => [r() - .5, r() - .5, r() - .5];
      const definitions = Array.from({ length: 8 }, (_, i) => ({
        id: String(i), collideConnected: false, bodyA: i === 0 ? null : String((i - 1) % 6), bodyB: String(i % 6),
        type: (['point', 'hinge', 'weld'] as const)[i % 3], stiffness: .1 + r() * .9,
        anchorA: vector(), anchorB: vector(), axisA: vector(), axisB: vector(),
        referenceA: vector(), referenceB: vector(), limits: i % 2 ? { min: -.3, max: .2 } : null
      }));
      // Invalid references and self constraints must retain reference behavior.
      definitions.push({ ...definitions[0], bodyA: '999' }, { ...definitions[1], bodyA: '2', bodyB: '2' });
      const host = { constraintDefinitions: new Map(definitions.map((c, i) => [String(i), c])), getRigidBody: (id: string | number) => bodies[Number(id)] ?? null };
      physics.solveConstraints(host, 1 / 60, 10);
      return bodies.flatMap(state);
    };
    near(run('auto'), run('js'), `joints ${seed}`);
  }
}));

test('WASM entity impulses preserve friction, restitution, resting thresholds and carrier aliases', () => modes(() => {
  const physics = new ContraptionPhysics({} as any);
  for (let seed = 1; seed <= 1200; seed++) {
    const run = (mode: 'js' | 'auto') => {
      setPhysicsSolverMode(mode);
      const a = body(seed), b = seed % 23 ? body(seed + 1) : a;
      const oa = seed % 3 ? a : body(seed + 2), ob = seed % 5 ? b : oa;
      const r = random(seed), normal = new THREE.Vector3(r() - .5, r() - .5, r() - .5).normalize();
      const point = new THREE.Vector3(r(), r(), r());
      const impulse = physics.applyEntityCollisionImpulse(a, b, oa, ob, normal, point,
        physics.inverseMass(a), physics.inverseMass(b));
      return [impulse, ...[a, b, oa, ob].flatMap(state)];
    };
    near(run('auto'), run('js'), `pair ${seed}`);
  }
}));

test('WASM terrain manifolds preserve accumulated impulses, friction and narrow support toppling', () => modes(() => {
  const physics = new ContraptionPhysics({} as any);
  for (let seed = 1; seed <= 600; seed++) {
    const run = (mode: 'js' | 'auto') => {
      setPhysicsSolverMode(mode);
      const b = body(seed); b.mass = Math.max(.1, b.mass);
      const r = random(seed), normal = seed % 3 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(r() - .5, r() - .5, r() - .5).normalize();
      const hit = b.position.clone().addScaledVector(normal, -.5);
      const points = Array.from({ length: seed % 7 }, () => hit.clone().add(new THREE.Vector3(r() - .5, 0, r() - .5)));
      const manifold = seed % 2 ? [hit, ...points] : [hit];
      const impulse = physics.solveTerrainContact(b, normal, hit, r() * .1, points, 1 / 60, manifold, seed % 3 !== 0, seed % 2 ? 32 : 10);
      return [impulse, ...state(b)];
    };
    near(run('auto'), run('js'), `terrain ${seed}`);
  }
}));

test('solver arenas grow without retaining stale views or state across calls', () => modes(() => {
  const physics = new ContraptionPhysics({} as any);
  const run = (mode: 'js' | 'auto') => {
    setPhysicsSolverMode(mode);
    const b = body(1), hit = b.position.clone().add(new THREE.Vector3(0, -.5, 0));
    b.velocity.set(1, -2, 0);
    const manifold = Array.from({ length: 1800 }, (_, i) => hit.clone().add(new THREE.Vector3((i % 11) * .01, 0, (i % 13) * .01)));
    const impulse = physics.solveTerrainContact(b, new THREE.Vector3(0, 1, 0), hit, .05, manifold, 1 / 60, manifold);
    physics.toppleNarrowSupport(b, new THREE.Vector3(0, 1, 0), 1 / 60);
    return [impulse, ...state(b)];
  };
  const expected = run('js'); near(run('auto'), expected, 'grown'); near(run('auto'), expected, 'reused');
}));

test('world anchors, antiparallel hinges and locked limits retain degenerate-case behavior', () => modes(() => {
  const physics = new ContraptionPhysics({} as any);
  for (const type of ['point', 'hinge', 'weld'] as const) for (const sign of [-1, 0, 1]) {
    const run = (mode: 'js' | 'auto') => {
      setPhysicsSolverMode(mode);
      const b = body(1); b.position.set(0, 0, 0); b.quaternion.identity();
      const definition = { id: 'joint', collideConnected: false, bodyA: null, bodyB: 'body', type, stiffness: 1,
        anchorA: [-0, 0, 0], anchorB: [0, 0, 0], axisA: [0, 0, 1], axisB: [0, 0, sign],
        referenceA: [-1, 0, 0], referenceB: [1, -0, 0], limits: { min: 0, max: 0 } };
      const host = { constraintDefinitions: new Map([['joint', definition]]), getRigidBody: () => b };
      physics.solveConstraints(host, 1 / 60, 10);
      return state(b);
    };
    near(run('auto'), run('js'), `${type}/${sign}`);
  }
}));

test('oversized solver arenas request fallback before mutating host state', () => modes(() => {
  const kernels = getPhysicsSolverKernels()!, b = body(1), before = state(b);
  const definition = { bodyA: null, bodyB: 'body', type: 'point', stiffness: 1, anchorA: [0, 0, 0], anchorB: [0, 0, 0] };
  assert.equal(kernels.solveConstraints({ getRigidBody: () => b }, Array(175000).fill(definition), 1), false);
  assert.deepEqual(state(b), before);
  const points = Array(500000).fill(new THREE.Vector3());
  assert.equal(kernels.solveTerrainImpulse(b, new THREE.Vector3(0, 1, 0), new THREE.Vector3(), .1,
    points, 1 / 60, points, true, 10, 18, .2, .05), null);
  assert.deepEqual(state(b), before);
  setPhysicsSolverMode('js'); assert.equal(getPhysicsSolverKernels(), null);
  setPhysicsSolverMode('auto'); setGeometryKernelMode('js'); assert.equal(getPhysicsSolverKernels(), null);
}));
