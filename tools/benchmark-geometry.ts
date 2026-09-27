// End-to-end CPU calls include packing, copies and result objects. No GPU/FPS claims.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { getGeometryKernels, setGeometryKernelMode, type GeometryKernelMode } from '../engine/src/wasm/GeometryKernels.ts';
import { setPhysicsSolverMode } from '../engine/src/wasm/PhysicsSolverKernels.ts';
import { ContraptionPhysics } from '../engine/src/physics/ContraptionPhysics.ts';
import { Contraption, BodyType } from '../engine/src/contraption/Contraption.ts';
import { ContraptionManager } from '../engine/src/contraption/ContraptionManager.ts';
import { World } from '../engine/src/voxel/World.ts';
import { bendPointForView } from '../engine/src/torus/TorusWorld.ts';
import { geometryCube, geometryObb } from '../engine/test/geometry-fixtures.ts';
import { voxelizeModel } from '../client/src/engine/voxel/ModelVoxelizer.ts';

const samples = 11;
function report(name: string, values: Record<string, number[]>) {
  const stats = (xs: number[]) => { xs.sort((a, b) => a - b); return { medianMs: +xs[xs.length >> 1].toFixed(4), p95Ms: +xs[Math.floor(xs.length * .95)].toFixed(4) }; };
  const js = stats(values.js), wasm = stats(values.wasm);
  console.log(JSON.stringify({ name, js, wasm, speedup: +(js.medianMs / wasm.medianMs).toFixed(2) }));
}
function bench(name: string, run: (mode: GeometryKernelMode) => unknown, repetitions = 1) {
  const values = { js: [] as number[], wasm: [] as number[] };
  for (let round = -3; round < samples; round++) {
    for (const mode of round % 2 ? ['js', 'wasm'] as const : ['wasm', 'js'] as const) {
      setGeometryKernelMode(mode);
      const start = performance.now();
      for (let i = 0; i < repetitions; i++) run(mode);
      if (round >= 0) values[mode].push((performance.now() - start) / repetitions);
    }
  }
  report(name, values);
}

const previous = setGeometryKernelMode('wasm');
const previousSolver = setPhysicsSolverMode('auto');
try {
  getGeometryKernels(); // Exclude first module initialization from steady-state results.
  const physics = new ContraptionPhysics({} as any) as any;
  physics.entityCollisionObb = (box: any) => box;
  for (const count of [1, 16, 1024]) {
    const a = Array.from({ length: count }, (_, i) => geometryObb(i));
    const b = a.map((_, i) => geometryObb(i + 3, .1));
    bench(`SAT ${count} pairs including packing`, mode => mode === 'wasm'
      ? getGeometryKernels()!.obbContacts(a, b) : a.map((box, i) => physics.orientedBoxPairContact(box, b[i])), count < 100 ? 100 : 5);
  }

  const rayHost = { rayBentPoint: new THREE.Vector3(), rayFlatPoint: new THREE.Vector3() };
  for (const grazing of [false, true]) {
    const origin = bendPointForView(100.05, grazing ? 35.09 : 45, 100.05);
    const direction = bendPointForView(grazing ? 114 : 100.05, 35.01, 100.05).sub(origin).normalize();
    const read = (x: number, y: number, z: number) => y === 280 && z === 800 && (!grazing || x % 2 === 0) ? 0 : null;
    bench(`Micro picking ${grazing ? 'grazing checkerboard' : 'downward'}`, () => World.prototype.raycastBentVoxelFaces.call(
      rayHost, origin, direction, 16, 8, read, value => value !== null), 30);
  }

  for (const [size, angle] of [[32, 0], [64, 0], [24, .37]]) {
    const triangles = geometryCube(size, angle).map((t, i) => ({ ...t, color: i % 2 ? 0x87aaff : 0x334455 }));
    setGeometryKernelMode('js'); const reference = voxelizeModel(triangles);
    setGeometryKernelMode('wasm'); assert.deepEqual(voxelizeModel(triangles), reference);
    bench(`Model cube ${size}, angle ${angle}`, () => voxelizeModel(triangles));
  }

  function scene() {
    const scene = new THREE.Scene();
    const world = { getBlock: (_x: number, y: number) => y < 0 ? 1 : 0,
      getMicroBlocksInAABB: () => [], getMicroCollisionBoxesInAABB: () => [],
      raycast: () => ({ hit: false }), raycastMicro: () => ({ hit: false }) } as any;
    const physics = new ContraptionPhysics(world), manager = new ContraptionManager(scene, world, null, null);
    manager.setPhysics(physics);
    const blocks = [];
    for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) blocks.push({ localX: x, localY: y, localZ: z, entityId: 'root', block: 1 });
    for (let i = 0; i < 12; i++) {
      const entity = new Contraption(`dense_${i}`, blocks, new THREE.Vector3((i % 4) * 1.85, Math.floor(i / 4) * 1.85 + .01, 0), scene);
      entity.quaternion.setFromEuler(new THREE.Euler(0, i % 2 ? .15 : 0, 0)); entity.updateTransform();
      manager.registerContraption(entity);
    }
    return { physics, manager, dispose: () => { for (const entity of [...manager.contraptions]) entity.dispose(); } };
  }

  const dense = { js: [] as number[], wasm: [] as number[] };
  let reference: number[] | undefined;
  for (let round = -2; round < samples; round++) for (const mode of round % 2 ? ['js', 'wasm'] as const : ['wasm', 'js'] as const) {
    setGeometryKernelMode(mode);
    const s = scene();
    const start = performance.now(); s.manager.update(.05, null); const elapsed = performance.now() - start;
    if (round >= 0) dense[mode].push(elapsed);
    const poses = s.manager.contraptions.flatMap(c => [...c.position.toArray(), ...c.quaternion.toArray(), ...c.velocity.toArray(), ...c.angularVelocity.toArray()]);
    reference ??= poses;
    assert.ok(poses.every((value, i) => Math.abs(value - reference![i]) < 1e-8), 'Dense physics trajectory changed');
    s.dispose();
  }
  report('12 interpenetrating rotated bodies, complete 50ms update', dense);

  setGeometryKernelMode('wasm');
  const s = scene(), stages: Record<string, { ms: number; calls: number }> = {};
  for (const name of ['integrateBody', 'solveConstraints', 'resolveContraptionPair', 'exactTerrainContacts', 'terrainBoxesOverlapping', 'solveTerrainContact']) {
    const method = (s.physics as any)[name].bind(s.physics), entry = stages[name] = { ms: 0, calls: 0 };
    (s.physics as any)[name] = (...args: unknown[]) => { const start = performance.now(); try { return method(...args); } finally { entry.ms += performance.now() - start; entry.calls++; } };
  }
  s.manager.update(.05, null); s.dispose();
  for (const entry of Object.values(stages)) entry.ms = +entry.ms.toFixed(3);
  console.log(JSON.stringify({ name: 'Dense WASM stages (inclusive; nested; instrumentation overhead)', stages }));

  const jointScene = new THREE.Scene();
  const jointWorld = { getBlock: () => 0, getMicroBlocksInAABB: () => [], getMicroCollisionBoxesInAABB: () => [],
    raycast: () => ({ hit: false }), raycastMicro: () => ({ hit: false }) } as any;
  const jointPhysics = new ContraptionPhysics(jointWorld), jointManager = new ContraptionManager(jointScene, jointWorld, null, null);
  jointManager.setPhysics(jointPhysics);
  const children = Array.from({ length: 63 }, (_, i) => ({ id: `arm_${i}`, parentId: 'root', bodyType: BodyType.DYNAMIC,
    pivot: [i + 1, .5, .5], blockKeys: [[i + 1, 0, 0]] }));
  const machine = new Contraption('hinge_benchmark', Array.from({ length: 64 }, (_, i) => ({ localX: i, localY: 0, localZ: 0, block: 1 })),
    new THREE.Vector3(0, 20, 0), jointScene, { bodyType: BodyType.KINEMATIC, childEntities: children,
      constraints: children.map(child => ({ id: `joint_${child.id}`, type: 'hinge', bodyA: 'root', bodyB: child.id, axisA: [0, 0, 1], axisB: [0, 0, 1], limits: { min: -.3, max: .3 } })) });
  jointManager.registerContraption(machine);
  for (let i = 0; i < 5; i++) jointManager.update(.05, null);
  let constraintMs = 0;
  const solve = jointPhysics.solveConstraints.bind(jointPhysics);
  jointPhysics.solveConstraints = (...args) => { const start = performance.now(); try { return solve(...args); } finally { constraintMs += performance.now() - start; } };
  const jointTimes: number[] = [], constraintTimes: number[] = [];
  for (let i = 0; i < 11; i++) {
    constraintMs = 0; const start = performance.now(); jointManager.update(.05, null);
    jointTimes.push(performance.now() - start); constraintTimes.push(constraintMs);
  }
  jointTimes.sort((a, b) => a - b); constraintTimes.sort((a, b) => a - b);
  console.log(JSON.stringify({ name: '63 hinges, complete 50ms update; WASM solver', medianMs: +jointTimes[5].toFixed(3),
    constraintsMedianMs: +constraintTimes[5].toFixed(3), note: 'Constraint stage is included in total; no terrain or entity contacts.' }));
  machine.dispose();
} finally { setPhysicsSolverMode(previousSolver); setGeometryKernelMode(previous); }
