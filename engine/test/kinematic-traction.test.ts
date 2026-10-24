import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { setGeometryKernelMode } from '../src/wasm/GeometryKernels.ts';
import { setTerrainKernelMode } from '../src/wasm/TerrainKernels.ts';
import { setPhysicsSolverMode } from '../src/wasm/PhysicsSolverKernels.ts';

function vehicle(friction = .7, grounded = true, collision = true) {
  const scene = new THREE.Scene();
  const wheelBlocks = [];
  for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
    if ((x - 3.5) ** 2 + (y - 3.5) ** 2 > 3.75 ** 2) continue;
    for (let z = 0; z < 2; z++) wheelBlocks.push({ localX: x / 8, localY: y / 8, localZ: z / 8, size: .125, block: 1 });
  }
  const wheel = new Contraption(1, wheelBlocks, new THREE.Vector3(), scene, { bodyType: 'kinematic', friction, collisionEnabled: collision });
  const slot = wheel.serializeSubtree(wheel.rootComponentId)!;
  const car = new Contraption(2, [0, 1, 2].map(x => ({ localX: x, localY: 0, localZ: 0, block: 1 })),
    new THREE.Vector3(0, 1, 0), scene, { restitution: 0 });
  car.stopAllNodeScripts();
  for (const x of [0, 2]) for (const z of [-.25, 1]) {
    const result = car.installEntitySlot(slot, car.rootComponentId, new THREE.Vector3(x, .25, z));
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  car.setPhysicsSimulationEnabled(true);
  const physics = new ContraptionPhysics({
    getBlock: (_x, y, _z) => grounded && y < 0 ? 1 : 0,
    raycast: () => ({ hit: false, distance: 0 }), raycastMicro: () => ({ hit: false, distance: 0 }),
    terrainVersion: 0,
  });
  const wheels = [...car.entityNodes.values()].filter(node => node.parentId !== null);
  const advance = (spin: number, frames = 100) => {
    for (let i = 0; i < frames; i++) {
      car.update(.05, null, { gravity: [0, -18, 0], world: null });
      for (const node of wheels) {
        node.localQuaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), spin * .05));
        node.group.quaternion.copy(node.localQuaternion);
      }
      car.updateTransform();
      physics.update(car, .05);
    }
  };
  return { car, physics, wheels, advance, dispose: () => { car.dispose(); wheel.dispose(); } };
}

for (const backend of ['js', 'wasm'] as const) {
  test(`${backend}: kinematic wheel traction drives its carrier and reverses with spin`, t => {
    const previousGeometry = setGeometryKernelMode(backend), previousTerrain = setTerrainKernelMode(backend);
    const previousSolver = setPhysicsSolverMode(backend === 'js' ? 'js' : 'auto');
    t.after(() => { setPhysicsSolverMode(previousSolver); setGeometryKernelMode(previousGeometry); setTerrainKernelMode(previousTerrain); });
    const forward = vehicle(), reverse = vehicle();
    t.after(() => { forward.dispose(); reverse.dispose(); });
    const a = forward.car.position.x, b = reverse.car.position.x;
    forward.advance(Math.PI); reverse.advance(-Math.PI);
    assert.ok(forward.car.position.x < a - 1, 'positive wheel spin drives toward -X without any chassis force');
    assert.ok(reverse.car.position.x > b + 1, 'reversed spin reverses traction');
    assert.equal(forward.car.getNodeScript(forward.car.rootComponentId), '');
    assert.ok(forward.car.position.y > .5 && forward.car.position.y < 2, 'the car stays supported');
  });

  test(`${backend}: wheel traction requires friction and an enabled ground contact`, t => {
    const previousGeometry = setGeometryKernelMode(backend), previousTerrain = setTerrainKernelMode(backend);
    const previousSolver = setPhysicsSolverMode(backend === 'js' ? 'js' : 'auto');
    t.after(() => { setPhysicsSolverMode(previousSolver); setGeometryKernelMode(previousGeometry); setTerrainKernelMode(previousTerrain); });
    for (const [label, setup] of [
      ['frictionless', [0, true, true]], ['airborne', [.7, false, true]], ['collision disabled', [.7, true, false]],
    ] as const) {
      const v = vehicle(setup[0], setup[1], setup[2]);
      try {
        const x = v.car.position.x;
        v.advance(Math.PI);
        assert.ok(Math.abs(v.car.position.x - x) < .15, `${label} wheels must not propel the carrier`);
      } finally { v.dispose(); }
    }
  });
}

test('kinematic relative angular velocity survives every physics substep and resumes after sleep', t => {
  const v = vehicle(); t.after(v.dispose);
  v.advance(0, 80);
  assert.equal(v.physics.isSleeping(v.car), true);
  v.advance(Math.PI, 1);
  assert.equal(v.physics.isSleeping(v.car), false);
  for (const node of v.wheels) {
    const body = v.car.getRigidBody(node.id)!;
    const atGround = body.position.clone().add(new THREE.Vector3(0, -.5, 0));
    assert.ok(v.car.getKinematicPointVelocityOffset(node.id, atGround).length() > 1.4);
  }
  const x = v.car.position.x;
  v.advance(Math.PI, 80);
  assert.ok(v.car.position.x < x - 1, 'starting wheel rotation wakes and moves a sleeping carrier');
});
