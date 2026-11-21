import { Vector3 } from 'three';
import { BodyType, Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import type { PhysicsTrialGame, PhysicsTrialMode } from './PhysicsVehicleTrial.ts';
import { interceptMethod } from './FrameDiagnostics.ts';
import { loadRapierPhysics } from '@entropydrop/space-engine/rapier/loadRapierPhysics.ts';

type RigidBodyLoadLayout = 'spread' | 'stack' | 'stack-agitated';
const floor = { x: 5370, y: 64, z: 812, size: 44 };
const top = floor.y + 1;
const warmupTicks = 10;
const sampleTicks = 48;
export const loadSpawn = { start_x_cm: (floor.x + 22) * 100, start_y_cm: 11100, start_z_cm: (floor.z + 22) * 100 };

function position(layout: RigidBodyLoadLayout, index: number, count: number) {
  const columns = layout === 'spread' ? Math.ceil(Math.sqrt(count)) : Math.ceil(Math.sqrt(count / 4));
  const layer = layout === 'spread' ? 0 : index % 4;
  const column = layout === 'spread' ? index : Math.floor(index / 4);
  const gap = layout === 'spread' ? 3.25 : 3.4;
  const row = Math.floor(column / columns);
  return new Vector3(
    floor.x + 22 + (column % columns - (columns - 1) / 2) * gap + layer * 0.025,
    layout === 'spread' ? top + 2 : top + 0.03 + layer * 1.02,
    floor.z + 22 + (row - (columns - 1) / 2) * gap - layer * 0.015,
  );
}

export async function installRigidBodyLoad(game: PhysicsTrialGame, mode: PhysicsTrialMode, layout: RigidBodyLoadLayout, count: number) {
  const { world, contraptionManager: manager } = game;
  const stacked = layout !== 'spread';
  game.controller.pitch = -1.46;
  for (let x = floor.x; x < floor.x + floor.size; x++) {
    for (let z = floor.z; z < floor.z + floor.size; z++) {
      world.setBlock(x, floor.y, z, BlockTypes.COLOR_BLOCK, true, (x + z) % 2 ? 0x627b87 : 0x5c727e);
    }
  }
  const entities: { entity: Contraption; origin: Vector3; phase: number }[] = [];
  for (let i = 0; i < count; i++) {
    const origin = position(layout, i, count);
    const entity = new Contraption(`load_${i}`, [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK,
        color: [0xfaba5e, 0x47c7d5, 0xe76964, 0xd9e491][i % 4] },
    ], origin, manager.scene, {
      bodyType: BodyType.DYNAMIC, useGravity: stacked, restitution: 0, friction: 0.55,
    });
    entity.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), stacked ? (i % 4) * 0.028 : 0);
    entity.updateTransform();
    entity.setPhysicsSimulationEnabled(false);
    manager.registerContraption(entity);
    entities.push({ entity, origin: entity.position.clone(), phase: i * 2.399963 });
  }

  const candidate = mode === 'rapier' ? await loadRapierPhysics(world) : null;
  if (candidate) {
    game.contraptionPhysics = candidate;
    manager.setPhysics(candidate);
  }

  let tick = -1;
  let startedAt = 0, endedAt = 0, previousFrame = 0;
  let finalCounts: (NonNullable<typeof candidate>['counts'] & { terrainRebuilds: number }) | null = null;
  const updateMs: number[] = [], frameCpuMs: number[] = [], frameIntervalsMs: number[] = [];
  const longFrames: { startTime: number; duration: number }[] = [];
  const readings: { tick: number; moving: number; sleeping: number; contacts: number; minBottom: number; maxY: number; finite: boolean }[] = [];
  const observer = PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')
    ? new PerformanceObserver(list => {
        for (const entry of list.getEntries()) longFrames.push({ startTime: entry.startTime, duration: entry.duration });
      }) : null;

  const inputs = new Map(entities.map(entry => [entry.entity, entry]));
  const force = { spread: 16, stack: 145, 'stack-agitated': 420 }[layout];
  const lift = stacked ? 12 : 0;
  const torque = stacked ? 4 : 2;
  interceptMethod(game.contraptionPhysics, 'prepareContraptionFrame', (run, args) => {
    const [entity] = args;
    const input = inputs.get(entity);
    if (input && tick >= 0 && tick < warmupTicks + sampleTicks) {
      const { origin, phase } = input;
      const p = entity.position;
      const theta = phase + tick * 0.16;
      const fx = Math.sin(theta), fz = Math.cos(theta);
      // The inactive script controller clears forces before frame preparation.
      entity.appliedForces.set(force * fx + (origin.x - p.x) * 8, lift, force * fz + (origin.z - p.z) * 8);
      entity.appliedTorques.set(0, torque * fx, 0);
    }
    return run(...args);
  });

  const sampleBodies = () => {
    let moving = 0, sleeping = 0, contacts = 0, minBottom = Infinity, maxY = -Infinity, finite = true;
    for (const { entity } of entities) {
      const p = entity.position, q = entity.quaternion, v = entity.velocity;
      if (v.lengthSq() > 0.05 ** 2 || entity.angularVelocity.lengthSq() > 0.05 ** 2) moving++;
      if (game.contraptionPhysics.isSleeping(entity)) sleeping++;
      if (entity.pendingScriptContacts.some(contact => contact.kind === 'entity')) contacts++;
      const boundY = (Math.abs(2 * (q.x * q.y + q.z * q.w))
        + Math.abs(1 - 2 * (q.x * q.x + q.z * q.z))
        + Math.abs(2 * (q.y * q.z - q.x * q.w))) / 2;
      minBottom = Math.min(minBottom, p.y - boundY);
      maxY = Math.max(maxY, p.y);
      finite &&= p.toArray().every(Number.isFinite) && q.toArray().every(Number.isFinite) && v.toArray().every(Number.isFinite);
    }
    readings.push({ tick, moving, sleeping, contacts, minBottom, maxY, finite });
  };

  interceptMethod(manager, 'update', (run, args) => {
    if (tick < 0 || tick >= warmupTicks + sampleTicks) return run(...args);
    for (const { entity } of entities) entity.pendingScriptContacts.length = 0;
    const start = performance.now();
    if (tick === warmupTicks) startedAt = start;
    const result = run(...args);
    if (tick >= warmupTicks) {
      updateMs.push(performance.now() - start);
      sampleBodies();
    }
    tick++;
    if (tick === warmupTicks + sampleTicks && candidate) {
      finalCounts = { ...candidate.counts, terrainRebuilds: candidate.terrainRebuilds };
    }
    return result;
  });

  interceptMethod(game, 'animate', (run, args) => {
    const start = performance.now();
    const recording = startedAt > 0 && !endedAt;
    const result = run(...args);
    const end = performance.now();
    if (recording) {
      frameCpuMs.push(end - start);
      if (previousFrame) frameIntervalsMs.push(start - previousFrame);
      previousFrame = start;
    } else if (startedAt && !endedAt) {
      frameCpuMs.push(end - start);
      previousFrame = start;
    }
    if (startedAt && tick >= warmupTicks + sampleTicks && !endedAt) {
      endedAt = end;
    }
    return result;
  });

  return {
    start() {
      if (tick !== -1) throw Error('The load trial has already started');
      observer?.observe({ type: 'long-animation-frame' });
      for (const { entity, phase } of entities) {
        entity.setPhysicsSimulationEnabled(true);
        entity.velocity.set(Math.sin(phase) * 0.45, 0, Math.cos(phase) * 0.45);
      }
      tick = 0;
    },
    done: () => endedAt > 0,
    result() {
      if (!endedAt) throw Error('The load trial is still running');
      for (const entry of observer?.takeRecords() || []) {
        longFrames.push({ startTime: entry.startTime, duration: entry.duration });
      }
      observer?.disconnect();
      return {
        count, layout, mode, floorTop: top, updateMs, frameCpuMs, frameIntervalsMs, readings, sampleTicks,
        longFrames: longFrames.filter(entry => entry.startTime + entry.duration >= startedAt && entry.startTime < endedAt),
        elapsedMs: endedAt - startedAt, active: manager.contraptions.length, warmupTicks,
        rapier: finalCounts,
      };
    },
  };
}
