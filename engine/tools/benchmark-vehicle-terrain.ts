/** Compare the legacy per-box terrain path with the regional broadphase.
 * From repository root (Node 24+):
 * node --import ./engine/test/setup.ts engine/tools/benchmark-vehicle-terrain.ts /path/to/entity.json
 * Uses the supplied geometry on a deterministic flat runway, without scripts,
 * rendering, persistence or network. Each sample is one 50 ms entity update
 * (three physics substeps). CPU milliseconds here are not rendered frame times. */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { World } from '../src/voxel/World.ts';
import { Chunk } from '../src/voxel/Chunk.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import type { PhysicsTerrain } from '../src/physics/PhysicsTerrain.ts';

const file = process.argv[2];
if (!file) throw new Error('Supply an exported entity JSON file.');
const definition = JSON.parse(readFileSync(file, 'utf8'));
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted.at(-1) };
};
for (const ground of [true, false]) for (const regional of [false, true]) {
  const scene = new THREE.Scene(), world = new World(scene);
  const manager = new ContraptionManager(scene, world, null, null);
  manager.entityPersistenceMode = 'none';
  const source = structuredClone(definition);
  source.scripts = [];
  const entity = manager.buildFromSlot(source, new THREE.Vector3(128, 64, 128), null, false);
  if (!entity) throw new Error('Unable to load entity geometry.');
  try {
    entity.disableAllNodeScripts(); entity.setPhysicsSimulationEnabled(true);
    entity.quaternion.identity(); entity.syncAllBodyTransforms();
    const reference: PhysicsTerrain = {
      getBlock: world.getBlock.bind(world), raycast: world.raycast.bind(world),
      raycastMicro: world.raycastMicro.bind(world), raycastMicroCollision: world.raycastMicroCollision.bind(world),
      getMicroCollisionBlock: world.getMicroCollisionBlock.bind(world),
      getMicroCollisionBoxesInAABB: world.getMicroCollisionBoxesInAABB.bind(world),
      getTerrainCollisionStamp: world.getTerrainCollisionStamp.bind(world),
    };
    const physics = new ContraptionPhysics(regional ? world : reference);
    const boxes = physics.getBodyCollisionWorldOBBs(entity, entity.getRigidBodies()[0]);
    const minY = Math.min(...boxes.map(box => box.minY));
    const minX = Math.floor(Math.min(...boxes.map(box => box.minX)) / 16) - 1;
    const maxX = Math.floor(Math.max(...boxes.map(box => box.maxX)) / 16) + 1;
    const minZ = Math.floor(Math.min(...boxes.map(box => box.minZ)) / 16) - 1;
    const maxZ = Math.floor(Math.max(...boxes.map(box => box.maxZ)) / 16) + 1;
    for (let cx = minX; cx <= maxX; cx++) for (let cz = minZ; cz <= maxZ; cz++) {
      const chunk = new Chunk(cx, cz, null);
      world.chunks.set(`${cx},${cz}`, chunk);
      for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setLocalBlock(x, 31, z, 1);
      chunk.mesh = new THREE.Group();
    }
    const position = entity.position.clone();
    position.y += 32 - minY + (ground ? -0.002 : 100);
    const times: number[] = [];
    for (let i = 0; i < 100; i++) {
      entity.position.copy(position); entity.quaternion.identity();
      entity.velocity.set(20, 0, 0); entity.angularVelocity.set(0, 0.05, 0); entity.syncAllBodyTransforms();
      const start = performance.now(); physics.update(entity, 0.05);
      if (i >= 20) times.push(performance.now() - start);
    }
    console.log(JSON.stringify({ scenario: ground ? 'taxi' : 'airborne', regional,
      terrainBoxes: boxes.length, samples: times.length, physicsMs: summary(times) }));
  } finally { entity.dispose(); }
}
