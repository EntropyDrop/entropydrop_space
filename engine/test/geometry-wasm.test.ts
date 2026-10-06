import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { getGeometryKernels, setGeometryKernelMode, createGeometryArena } from '../src/wasm/GeometryKernels.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { Contraption, BodyType } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { World } from '../src/voxel/World.ts';
import { bendPointForView, setTorusViewCorrection } from '../src/torus/TorusWorld.ts';
import { geometryObb } from './geometry-fixtures.ts';

function near(actual: any, expected: any, path = '') {
  if (typeof expected === 'number') {
    assert.ok(Math.abs(actual - expected) <= 2e-11 * Math.max(1, Math.abs(expected)), `${path}: ${actual} != ${expected}`);
  } else if (expected && typeof expected === 'object') {
    assert.ok(actual, path); assert.deepEqual(Object.keys(actual), Object.keys(expected), path);
    for (const key of Object.keys(expected)) near(actual[key], expected[key], `${path}.${key}`);
  } else assert.equal(actual, expected, path);
}

test('batched f64 SAT preserves oriented contacts, terrain support and batch boundaries', () => {
  const previous = setGeometryKernelMode('wasm');
  try {
    const kernels = getGeometryKernels()!, physics = new ContraptionPhysics({} as any) as any;
    physics.entityCollisionObb = (box: any) => box;
    const a = Array.from({ length: 2053 }, (_, i) => i % 61 ? geometryObb(i) : null);
    const b = a.map((_, i) => geometryObb(i + 3, i % 9 === 0 ? 12 : .1));
    a[1]!.halfExtents = [0, 0, 0];
    a[2]!.axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    const center = a[2]!.center;
    b[2] = { center: new THREE.Vector3(center.x, center.y, center.z),
      axes: a[2]!.axes.map(axis => new THREE.Vector3(axis.x, axis.y, axis.z)), halfExtents: [...a[2]!.halfExtents] };
    b[2].center.x += a[2]!.halfExtents[0] * 2;
    const actual = kernels.obbContacts(a, b);
    for (let i = 0; i < a.length; i++) near(actual[i], physics.orientedBoxPairContact(a[i], b[i]), `pair ${i}`);
    const terrain = a.map((_, i) => ({ minX: (i % 5) - 2, minY: -.5, minZ: -1, maxX: (i % 5) - 1, maxY: 0, maxZ: 1 }));
    const terrainContacts = kernels.obbContacts(a, terrain, true);
    for (let i = 0; i < a.length; i++) near(terrainContacts[i], a[i] ? physics.orientedBoxAabbContact(a[i], terrain[i]) : null, `terrain ${i}`);
    assert.throws(() => kernels.obbContacts(a, []), /Invalid collision/);
  } finally { setGeometryKernelMode(previous); }
});

test('entity contact collection preserves ordering across candidate batches', () => {
  const run = (mode: 'js' | 'wasm') => {
    setGeometryKernelMode(mode);
    const blocks = [];
    for (let x = 0; x < 33; x++) for (let z = 0; z < 33; z++) if ((x + z) % 2 === 0) blocks.push({ localX: x, localY: 0, localZ: z, block: 1 });
    const scene = new THREE.Scene(), physics = new ContraptionPhysics({ getBlock: () => 0, raycast: () => ({ hit: false as const }), raycastMicro: () => ({ hit: false as const }) } as any);
    const a = new Contraption('batch_a', blocks, new THREE.Vector3(0, 10, 0), scene);
    const b = new Contraption('batch_b', blocks, new THREE.Vector3(.5, 10.5, .5), scene);
    try {
      physics.resolveContraptionPair(a, b);
      return [a, b].flatMap(c => [...c.position.toArray(), ...c.velocity.toArray(), ...c.angularVelocity.toArray()]);
    } finally { a.dispose(); b.dispose(); }
  };
  const previous = setGeometryKernelMode('js');
  try { near(run('wasm'), run('js')); }
  finally { setGeometryKernelMode(previous); }
});

test('air and solid discovery reads each numeric cell once, without caching across rays', () => {
  const host = { rayBentPoint: new THREE.Vector3(), rayFlatPoint: new THREE.Vector3() };
  const origin = bendPointForView(100, 40, 100), direction = bendPointForView(100, 24, 100).sub(origin).normalize();
  for (const divisions of [1, 8]) {
    let calls = 0; const cells = new Set<string>();
    const read = (x: number, y: number, z: number) => { calls++; cells.add(`${x},${y},${z}`); return 0; };
    for (let ray = 1; ray <= 2; ray++) {
      World.prototype.raycastBentVoxelFaces.call(host, origin, direction, 16, divisions, read, v => v !== 0);
      assert.equal(calls, cells.size * ray);
    }
  }
});

test('WASM picks preserve seams, edges, view correction, micro black and published values', () => {
  const previous = setGeometryKernelMode('js');
  const host = { rayBentPoint: new THREE.Vector3(), rayFlatPoint: new THREE.Vector3() };
  try {
    for (const corrected of [false, true]) for (const divisions of [1, 8]) for (const [x, z] of [[100, 100], [16383, 2047], [0, 0]]) {
      const y = 35, cellSize = 1 / divisions;
      const cell = { x: x * divisions, y: y * divisions, z: z * divisions };
      setTorusViewCorrection(corrected ? new THREE.Vector3(x, y + 3, z) : null);
      const read = (a: number, b: number, c: number) => a === cell.x && b === cell.y && c === cell.z ? 0 : null;
      for (const edge of [0, .001, .5, .999, 1]) {
        const origin = bendPointForView(x + edge * cellSize, y + 3, z + .5 * cellSize);
        const direction = bendPointForView(x + edge * cellSize, y + .5 * cellSize, z + .5 * cellSize).sub(origin).normalize();
        setGeometryKernelMode('js');
        const expected = World.prototype.raycastBentVoxelFaces.call(host, origin, direction, 6, divisions, read, v => v !== null);
        setGeometryKernelMode('wasm');
        const actual = World.prototype.raycastBentVoxelFaces.call(host, origin, direction, 6, divisions, read, v => v !== null);
        near(actual, expected, `${corrected}/${divisions}/${x}/${edge}`);
      }
    }
  } finally { setTorusViewCorrection(null); setGeometryKernelMode(previous); }
});

test('quad batches retain last-hit ties and do not leak scratch views', () => {
  const previous = setGeometryKernelMode('wasm');
  try {
    const kernels = getGeometryKernels()!, quads = new Float64Array(4100 * 12);
    for (let i = 0; i < 4100; i++) quads.set([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], i * 12);
    const ray = new THREE.Vector3(.5, 2, .5), dir = new THREE.Vector3(0, -1, 0);
    const result = kernels.rayQuads(quads, ray, dir, 3)!;
    assert.equal(result[0], 4099); assert.equal(result[1], 1); assert.equal(result[5], 2);
    assert.equal(kernels.rayQuads(quads, ray, dir, 1), null);
    assert.equal(result[0], 4099);
    assert.throws(() => kernels.rayQuads(new Float64Array(1), ray, dir, 3), /Invalid picking/);
    assert.equal(kernels.rayQuads(new Float64Array(12), ray, dir, 3), null, 'degenerate faces are ignored');
    const arena = createGeometryArena(65536)!;
    assert.throws(() => arena.reserve(65537), /budget/);
  } finally { setGeometryKernelMode(previous); }
});

test('continuous contact, hinge motion, impulses and terrain edits preserve trajectories', () => {
  const run = (mode: 'js' | 'wasm') => {
    setGeometryKernelMode(mode);
    let floor = 1;
    const scene = new THREE.Scene(), world = { terrainVersion: 0,
      getBlock: (_x: number, y: number) => y < floor ? 1 : 0,
      getMicroCollisionBoxesInAABB: () => [], getMicroBlocksInAABB: () => [],
      raycast: () => ({ hit: false as const }), raycastMicro: () => ({ hit: false as const }) };
    const physics = new ContraptionPhysics(world as any), manager = new ContraptionManager(scene, world as any, null, null);
    manager.setPhysics(physics);
    for (let i = 0; i < 3; i++) {
      const blocks = [0, 1].map(x => ({ localX: x, localY: 0, localZ: 0, block: 1, entityId: 'root' }));
      const c = new Contraption(`trajectory_${i}`, blocks, new THREE.Vector3(i * 1.7, i * .9 + 2, 0), scene,
        i === 1 ? { childEntities: [{ id: 'arm', parentId: 'root', bodyType: BodyType.DYNAMIC, pivot: [1, .5, .5], blockKeys: [[1, 0, 0]] }],
          constraints: [{ id: 'joint', type: 'hinge', bodyA: 'root', bodyB: 'arm', axisA: [0, 0, 1], axisB: [0, 0, 1], limits: { min: -.3, max: .3 } }] } : {});
      c.quaternion.setFromEuler(new THREE.Euler(.03 * i, .1 * i, .04 * i)); c.updateTransform();
      manager.registerContraption(c);
    }
    const history: number[][] = [];
    try {
      for (let tick = 0; tick < 120; tick++) {
        if (tick === 40) physics.applyImpulse(manager.contraptions[0], new THREE.Vector3(1, 2, 0));
        if (tick === 80) { floor = 0; world.terrainVersion++; }
        manager.update(.05, null);
        history.push(manager.contraptions.flatMap(c => c.getRigidBodies().flatMap(body => (
          [...body.position.toArray(), ...body.quaternion.toArray(), ...body.velocity.toArray(), ...body.angularVelocity.toArray()]
        ))));
      }
    } finally { for (const c of [...manager.contraptions]) c.dispose(); }
    return history;
  };
  const previous = setGeometryKernelMode('js');
  try {
    const expected = run('js'), actual = run('wasm');
    for (let tick = 0; tick < expected.length; tick++) for (let value = 0; value < expected[tick].length; value++) {
      assert.ok(Math.abs(actual[tick][value] - expected[tick][value]) < 1e-8,
        `trajectory ${tick}/${value}: ${actual[tick][value]} != ${expected[tick][value]}`);
    }
  } finally { setGeometryKernelMode(previous); }
});
