import * as THREE from 'three';
import { BodyType, Contraption } from '../../engine/src/contraption/Contraption.ts';
import { ContraptionManager } from '../../engine/src/contraption/ContraptionManager.ts';
import { ContraptionPhysics } from '../../engine/src/physics/ContraptionPhysics.ts';
import { setGeometryKernelMode } from '../../engine/src/wasm/GeometryKernels.ts';
import { setPhysicsSolverMode } from '../../engine/src/wasm/PhysicsSolverKernels.ts';
import { BlockTypes } from '../../engine/src/voxel/BlockTypes.ts';
import { Chunk } from '../../engine/src/voxel/Chunk.ts';
import { World } from '../../engine/src/voxel/World.ts';

export type Triple = [number, number, number];
export type Rotation = [number, number, number, number];
export type Box = { center: Triple; half: Triple };
export type Fixture = ReturnType<typeof makeSpace>['fixture'];
export type SceneName = 'hinges' | 'stacks' | 'micro';
export const sceneNames: SceneName[] = ['hinges', 'stacks', 'micro'];
export const timestep = 1 / 60;
export const substeps = 3;
export const warmup = 6;
export const ticks = 12;
export const rounds = 24;
export const qualityTicks = 16;
export const fill = BlockTypes.COLOR_BLOCK;
export const gravity: Triple = [0, -18, 0];
export const padSize = 0.125;
export const stateWidth = 13;

function gridPosition(index: number): [number, number] {
  return [2 + (index % 4) * 3, 2 + Math.floor(index / 4) * 3];
}

export function makeTerrain(name: SceneName, scene = new THREE.Scene()) {
  const world = new World(scene);
  // A headless harness consumes live micro geometry. There are no terrain meshes to publish.
  world.getMicroCollisionBoxesInAABB = bounds => world.microVoxels.getCollisionBoxesInAABB(bounds);
  world.getMicroCollisionBlock = (x, y, z) => {
    const color = world.microVoxels.get(x, y, z);
    return color == null ? null : { block: fill, color };
  };
  world.raycastMicroCollision = (origin, direction, distance = 10) =>
    world.raycastMicro(origin, direction, distance, false);
  const terrain: Box[] = [];
  if (name !== 'hinges') {
    const chunk = new Chunk(0, 0, null);
    chunk.hasGenerated = true;
    world.chunks.set('0,0', chunk);
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) chunk.setLocalBlock(x, 0, z, fill);
    }
    terrain.push({ center: [8, 0.5, 8], half: [8, 0.5, 8] });
  }
  if (name === 'micro') {
    for (let i = 0; i < 16; i++) {
      const [x, z] = gridPosition(i);
      terrain.push({ center: [x + 0.5, 1 + padSize / 2, z + 0.5], half: [0.5, padSize / 2, 0.5] });
      for (let dx = 0; dx < 8; dx++) {
        for (let dz = 0; dz < 8; dz++) world.microVoxels.set(x * 8 + dx, 8, z * 8 + dz, 0xaaaaaa);
      }
    }
  }
  const [x, z] = gridPosition(0);
  return {
    world, terrain,
    edit() {
      for (let dx = 0; dx < 8; dx++) {
        for (let dz = 0; dz < 8; dz++) world.microVoxels.delete(x * 8 + dx, 8, z * 8 + dz);
      }
      world.terrainVersion++;
    },
    editedPadIsEmpty() {
      return world.getMicroCollisionBoxesInAABB({ minX: x, maxX: x + 1,
        minY: 1, maxY: 1 + padSize, minZ: z, maxZ: z + 1 }).length === 0;
    },
  };
}

export function makeSpace(name: SceneName) {
  setGeometryKernelMode('wasm');
  setPhysicsSolverMode('auto');
  const scene = new THREE.Scene();
  const { world, terrain, edit } = makeTerrain(name, scene);
  const manager = new ContraptionManager(scene, world, null, null);
  manager.setPhysics(new ContraptionPhysics(world));
  manager.syncContraptionsToLoadedChunks = () => {};
  const entities: Contraption[] = [];
  const cube = { localX: 0, localY: 0, localZ: 0, block: fill };
  const contact = { restitution: 0, friction: 0.7 };
  const add = (entity: Contraption) => {
    manager.registerContraption(entity);
    entities.push(entity);
  };

  if (name === 'hinges') {
    const arms = Array.from({ length: 63 }, (_, i) => ({
      id: `arm_${i}`, parentId: 'root', bodyType: BodyType.DYNAMIC, collisionEnabled: false,
      useGravity: false, pivot: [i + 1, 0.5, 0.5], blockKeys: [[i + 1, 0, 0]],
    }));
    const machine = new Contraption('hinges',
      Array.from({ length: 64 }, (_, i) => ({ ...cube, localX: i })),
      new THREE.Vector3(0, 20, 0), scene, {
        ...contact, bodyType: BodyType.KINEMATIC, collisionEnabled: false, childEntities: arms,
        constraints: arms.map(arm => ({
          id: `joint_${arm.id}`, type: 'hinge', bodyA: 'root', bodyB: arm.id,
          axisA: [0, 0, 1], axisB: [0, 0, 1], limits: { min: -0.3, max: 0.3 },
        })),
      });
    add(machine);
    for (const [index, arm] of machine.getRigidBodies().entries()) {
      if (arm.type === BodyType.DYNAMIC) arm.angularVelocity.set(0, 0, index % 2 === 0 ? 3 : -3);
    }
  } else {
    const stacks = name === 'stacks';
    for (let i = 0; i < 16; i++) {
      const layer = stacks ? i % 4 : 0;
      const [x, z] = stacks ? [2 + Math.floor(i / 4) * 3, 6] : gridPosition(i);
      const y = stacks ? 1.01 + 1.01 * layer : 1 + padSize;
      const entity = new Contraption(`cube_${i}`, [cube],
        new THREE.Vector3(x + 0.025 * layer, y, z), scene, contact);
      entity.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.035 * layer);
      entity.updateTransform();
      add(entity);
    }
  }

  const bodies = entities.flatMap(entity => entity.getRigidBodies());
  const fixture = {
    name, timestep, substeps, warmup, ticks, rounds, qualityTicks, gravity, terrain,
    removeTerrain: name === 'micro' ? 1 : null,
    bodies: bodies.map(body => ({
      fixed: body.type === BodyType.KINEMATIC, position: body.position.toArray(), rotation: body.quaternion.toArray(),
      velocity: body.velocity.toArray(), angular: body.angularVelocity.toArray(),
      mass: body.mass, inertia: 1 / body.inverseInertia,
      damping: (1 / body.linearDamping - 1) / timestep,
      angularDamping: (1 / body.angularDamping - 1) / timestep,
      friction: body.friction, restitution: body.restitution,
      collider: name !== 'hinges',
    })),
    joints: entities.flatMap(entity => [...entity.constraintDefinitions.values()].map(joint => ({
      a: bodies.indexOf(entity.getRigidBody(joint.bodyA!)!), b: bodies.indexOf(entity.getRigidBody(joint.bodyB)!),
      anchorA: joint.anchorA, anchorB: joint.anchorB, axis: joint.axisA,
      limits: [joint.limits!.min, joint.limits!.max] as [number, number],
    }))),
  };
  return {
    fixture, edit,
    step() { manager.update(timestep * substeps, null); },
    publish(state: Float64Array) {
      for (const [index, body] of bodies.entries()) {
        const offset = index * stateWidth;
        body.position.toArray(state, offset);
        body.quaternion.toArray(state, offset + 3);
        body.velocity.toArray(state, offset + 7);
        body.angularVelocity.toArray(state, offset + 10);
      }
    },
    dispose() {
      for (const entity of entities) entity.dispose();
      scene.clear();
    },
  };
}

export function checkBehavior(fixture: Fixture, frames: number[][]) {
  const last = frames.at(-1)!;
  if (!frames.every(frame => frame.every(Number.isFinite))) throw Error(`${fixture.name} produced non-finite state`);
  const rounded = (n: number) => +n.toFixed(6);
  if (fixture.name === 'hinges') {
    let maxAnchorGap = 0;
    let maxAngle = 0;
    for (const frame of frames) {
      for (const joint of fixture.joints) {
        const a = joint.a * stateWidth, b = joint.b * stateWidth;
        const qa = new THREE.Quaternion().fromArray(frame, a + 3);
        const qb = new THREE.Quaternion().fromArray(frame, b + 3);
        const anchorA = new THREE.Vector3().fromArray(joint.anchorA).applyQuaternion(qa)
          .add(new THREE.Vector3().fromArray(frame, a));
        const anchorB = new THREE.Vector3().fromArray(joint.anchorB).applyQuaternion(qb)
          .add(new THREE.Vector3().fromArray(frame, b));
        maxAnchorGap = Math.max(maxAnchorGap, anchorA.distanceTo(anchorB));
        maxAngle = Math.max(maxAngle, new THREE.Quaternion().angleTo(qa.clone().invert().multiply(qb).normalize()));
      }
    }
    if (maxAnchorGap > 0.04 || maxAngle < 0.05 || maxAngle > 0.35) throw Error('Hinges failed their behavior bounds');
    return { maxAnchorGapMeters: rounded(maxAnchorGap), maxAngleRadians: rounded(maxAngle) };
  }
  if (fixture.name === 'micro') {
    const initial = frames[0];
    const drop = initial[1] - last[1];
    const neighborDrift = Math.max(...fixture.bodies.slice(1).map((_, i) => {
      const offset = (i + 1) * stateWidth;
      return new THREE.Vector3().fromArray(last, offset).distanceTo(new THREE.Vector3().fromArray(initial, offset));
    }));
    if (drop < 0.09 || drop > 0.17 || neighborDrift > 0.04) throw Error('Micro support removal failed its behavior bounds');
    return { dropMeters: rounded(drop), maxNeighborDriftMeters: rounded(neighborDrift) };
  }
  const minBottom = Math.min(...frames.flatMap(frame => fixture.bodies.map((_, index) => {
    const offset = index * stateWidth;
    const e = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().fromArray(frame, offset + 3)).elements;
    return frame[offset + 1] - (Math.abs(e[1]) + Math.abs(e[5]) + Math.abs(e[9])) * 0.5;
  })));
  const minTopCenter = Math.min(...[3, 7, 11, 15].map(i => last[i * stateWidth + 1]));
  if (minBottom < 0.9 || minTopCenter < 4.2) throw Error('Stacks failed their behavior bounds');
  return { minBottomMeters: rounded(minBottom), minTopCenterMeters: rounded(minTopCenter) };
}
