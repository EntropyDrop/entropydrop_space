// Isolate the solver migration: geometry remains WASM in both modes. Timings
// include packing, all substeps, synchronization and result publication.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption, BodyType } from '../engine/src/contraption/Contraption.ts';
import { ContraptionManager } from '../engine/src/contraption/ContraptionManager.ts';
import { ContraptionPhysics } from '../engine/src/physics/ContraptionPhysics.ts';
import { setGeometryKernelMode } from '../engine/src/wasm/GeometryKernels.ts';
import { getPhysicsSolverKernels, setPhysicsSolverMode, type PhysicsSolverMode } from '../engine/src/wasm/PhysicsSolverKernels.ts';

function fixture(kind: 'joints' | 'dense' | 'terrain' | 'sparse') {
  const scene = new THREE.Scene();
  const world = { getBlock: (_x: number, y: number) => kind !== 'joints' && kind !== 'sparse' && y < 0 ? 1 : 0,
    getMicroBlocksInAABB: () => [], getMicroCollisionBoxesInAABB: () => [],
    raycast: () => ({ hit: false }), raycastMicro: () => ({ hit: false }) } as any;
  const physics = new ContraptionPhysics(world), manager = new ContraptionManager(scene, world, null, null);
  manager.setPhysics(physics);
  if (kind === 'joints') {
    const children = Array.from({ length: 63 }, (_, i) => ({ id: `arm_${i}`, parentId: 'root', bodyType: BodyType.DYNAMIC,
      pivot: [i + 1, .5, .5], blockKeys: [[i + 1, 0, 0]] }));
    const machine = new Contraption('joints', Array.from({ length: 64 }, (_, i) => ({ localX: i, localY: 0, localZ: 0, block: 1 })),
      new THREE.Vector3(0, 20, 0), scene, { bodyType: BodyType.KINEMATIC, childEntities: children,
        constraints: children.map(child => ({ id: `joint_${child.id}`, type: 'hinge', bodyA: 'root', bodyB: child.id,
          axisA: [0, 0, 1], axisB: [0, 0, 1], limits: { min: -.3, max: .3 } })) });
    manager.registerContraption(machine);
    for (const [i, body] of machine.getRigidBodies().entries()) if (body.type === BodyType.DYNAMIC) body.angularVelocity.set(.05, -.03, (i % 7 - 3) * .2);
  } else {
    const blocks = [];
    for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) blocks.push({ localX: x, localY: y, localZ: z, block: 1 });
    const count = kind === 'dense' ? 12 : 32;
    for (let i = 0; i < count; i++) {
      const position = kind === 'dense' ? new THREE.Vector3(i % 4 * 1.85, Math.floor(i / 4) * 1.85 + .01, 0)
        : new THREE.Vector3(i % 8 * 4, kind === 'terrain' ? 0 : 10, Math.floor(i / 8) * 4);
      const entity = new Contraption(`body_${i}`, blocks, position, scene);
      entity.quaternion.setFromEuler(new THREE.Euler(0, i % 2 ? .15 : 0, 0)); entity.updateTransform();
      entity.velocity.set(.2, -.3, -.1); manager.registerContraption(entity);
    }
  }
  return { manager, dispose: () => { for (const c of [...manager.contraptions]) c.dispose(); } };
}

const geometry = setGeometryKernelMode('wasm'), solver = setPhysicsSolverMode('auto');
try {
  getPhysicsSolverKernels();
  for (const kind of ['joints', 'dense', 'terrain', 'sparse'] as const) {
    const values: Record<PhysicsSolverMode, number[]> = { js: [], auto: [] };
    let reference: number[] | undefined;
    for (let round = -5; round < 15; round++) for (const mode of round % 2 ? ['js', 'auto'] as const : ['auto', 'js'] as const) {
      setPhysicsSolverMode(mode);
      const f = fixture(kind);
      try {
        // Identical preceding trajectory, outside the measured update.
        for (let i = 0; i < 5; i++) f.manager.update(.05, null);
        const start = performance.now(); f.manager.update(.05, null); const elapsed = performance.now() - start;
        if (round >= 0) values[mode].push(elapsed);
        const state = f.manager.contraptions.flatMap(c => c.getRigidBodies().flatMap(b =>
          [...b.position.toArray(), ...b.quaternion.toArray(), ...b.velocity.toArray(), ...b.angularVelocity.toArray()]));
        reference ??= state;
        assert.deepEqual(state, reference, `${kind}: trajectory changed`);
      } finally { f.dispose(); }
    }
    const stats = (xs: number[]) => {
      xs.sort((a, b) => a - b);
      return { medianMs: +xs[7].toFixed(4), p95Ms: +xs[14].toFixed(4) };
    };
    const js = stats(values.js), wasm = stats(values.auto);
    console.log(JSON.stringify({ fixture: kind, updateMs: 50, js, wasm, speedup: +(js.medianMs / wasm.medianMs).toFixed(2) }));
  }
  // Focused contact costs explain cases dominated by host collision traversal.
  // State reset is identical and included in both timings.
  const makeBody = (x: number) => ({ type: 'dynamic', simulationEnabled: true,
    position: new THREE.Vector3(x, .5, 0), quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(), angularVelocity: new THREE.Vector3(),
    mass: 2, inverseInertia: .5, restitution: .1, friction: .5, isOnGround: false });
  const a = makeBody(0), b = makeBody(1), physics = new ContraptionPhysics({} as any);
  const normal = new THREE.Vector3(0, 1, 0), pairNormal = new THREE.Vector3(1, 0, 0), point = new THREE.Vector3(.5, 0, 0);
  const manifold = [new THREE.Vector3(), new THREE.Vector3(-.5, 0, -.5), new THREE.Vector3(.5, 0, -.5),
    new THREE.Vector3(.5, 0, .5), new THREE.Vector3(-.5, 0, .5)];
  for (const kind of ['pair', 'terrain'] as const) {
    const values: Record<PhysicsSolverMode, number[]> = { js: [], auto: [] };
    let reference: number[] | undefined;
    for (let round = -5; round < 15; round++) for (const mode of round % 2 ? ['js', 'auto'] as const : ['auto', 'js'] as const) {
      setPhysicsSolverMode(mode);
      let impulse = 0;
      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        a.velocity.set(1, -1, .2); b.velocity.set(-1, -.1, -.3);
        a.angularVelocity.set(.1, .2, -.1); b.angularVelocity.set(-.1, .1, .2);
        impulse = kind === 'pair' ? physics.applyEntityCollisionImpulse(a, b, a, b, pairNormal, point, .5, .5)
          : physics.solveTerrainContact(a, normal, point, 0, manifold, 1 / 60, manifold);
      }
      const elapsed = (performance.now() - start) / 10000;
      if (round >= 0) values[mode].push(elapsed);
      const state = [impulse, ...a.velocity.toArray(), ...a.angularVelocity.toArray(), ...b.velocity.toArray(), ...b.angularVelocity.toArray()];
      reference ??= state; assert.deepEqual(state, reference);
    }
    values.js.sort((a, b) => a - b); values.auto.sort((a, b) => a - b);
    console.log(JSON.stringify({ kernel: kind, jsMicroseconds: +(values.js[7] * 1000).toFixed(3),
      wasmMicroseconds: +(values.auto[7] * 1000).toFixed(3), speedup: +(values.js[7] / values.auto[7]).toFixed(2) }));
  }
} finally { setPhysicsSolverMode(solver); setGeometryKernelMode(geometry); }
