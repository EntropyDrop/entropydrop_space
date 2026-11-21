import { Vector3 } from 'three';
import type { World } from '@entropydrop/space-engine/voxel/World.ts';
import type { PlayerPhysics } from '@entropydrop/space-engine/physics/PlayerPhysics.ts';
import type { ContraptionPhysics } from '@entropydrop/space-engine/physics/ContraptionPhysics.ts';
import type { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { portableEntityToRuntime } from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';
import { preloadRapierPhysics } from '@entropydrop/space-engine/rapier/loadRapierPhysics.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import type { PlayerController } from '../engine/controls/PlayerController.ts';
import { createCourse, createTank } from '../../tools/nature-tank/model.ts';
import { interceptMethod } from './FrameDiagnostics.ts';

export type PhysicsTrialMode = 'space' | 'rapier';
export type PhysicsTrialCourse = 'vertical' | 'ramp' | 'flat';
export interface PhysicsTrialGame {
  world: World;
  playerPhysics: PlayerPhysics;
  controller: PlayerController;
  contraptionManager: ContraptionManager;
  contraptionPhysics: ContraptionPhysics;
  animate(): void;
}

const x = 5374, y = 64, z = 810;
export const trialSpawn = { start_x_cm: (x + 1) * 100, start_y_cm: (y + 8) * 100, start_z_cm: (z + 4) * 100 };

export async function installPhysicsVehicleTrial(game: PhysicsTrialGame, mode: PhysicsTrialMode, course: PhysicsTrialCourse) {
  const started = performance.now();
  const candidate = mode === 'rapier' ? await import('./RapierVehiclePhysics.ts').then(async ({ RapierVehiclePhysics }) => {
    const rapier = await preloadRapierPhysics();
    return new RapierVehiclePhysics(rapier, game.world,
      { minX: x - 6, maxX: x + 14, minY: y - 8, maxY: y + 12, minZ: z - 6, maxZ: z + 46 });
  }) : null;
  const initMs = candidate ? performance.now() - started : 0;
  const world = game.world;
  const stepZ = z + 19;
  for (const block of createCourse().blocks) {
    if (course === 'flat' && block.dy > 0) continue;
    world.setBlock(x + block.dx, y + block.dy, z + block.dz, BlockTypes.COLOR_BLOCK, true, block.color);
  }
  if (course === 'ramp') {
    for (let mx = (x + 1) * 8; mx < (x + 7) * 8; mx++) {
      for (let dz = 0; dz < 32; dz++) {
        world.setMicroBlock(mx, (y + 1) * 8 + Math.floor(dz / 4), (stepZ - 4) * 8 + dz, 0x748b92);
      }
    }
  }
  const slot = portableEntityToRuntime(createTank());
  const blocks = slot.blocks.map(block => ({
    ...block, localX: block.dx + (block.mx ?? 0) / 8, localY: block.dy + (block.my ?? 0) / 8,
    localZ: block.dz + (block.mz ?? 0) / 8, size: block.mx == null ? 1 : 0.125,
  }));
  const tank = game.contraptionManager.buildFromSlot(slot, new Vector3(x + 4, y + 2.875, z + 10), null, false, blocks);
  if (!tank) throw Error('The TERRA-8 trial entity could not be placed');
  const probeBlock = tank.blocks.filter(block => block.entityId === tank.rootComponentId)
    .reduce((top, block) => block.localY + (block.size || 1) > top.localY + (top.size || 1) ? block : top);
  tank.enableAllNodeScripts();
  await tank.scriptRuntimeClient.ready();
  if (candidate) {
    game.contraptionPhysics = candidate;
    game.contraptionManager.setPhysics(candidate);
  }

  // On the flat control, the edit is placed on the shoulder of the course.
  const editX = course === 'flat' ? x + 7 : x + 2;
  const editY = y + (course === 'flat' ? 1 : 2);
  const edit = (fill: boolean) => {
    let changed = 0;
    for (let dx = 0; dx < 8; dx++) for (let dz = 0; dz < 8; dz++) {
      const coords = [editX * 8 + dx, editY * 8, (stepZ + 1) * 8 + dz] as const;
      const result = fill ? world.setMicroBlock(...coords, 0xd94b52) : world.removeMicroBlock(...coords);
      if (result) changed++;
    }
    return changed;
  };
  const editedBounds = {
    minX: editX, minY: editY, minZ: stepZ + 1, maxX: editX + 1, maxY: editY + 0.125, maxZ: stepZ + 2,
  };
  const latest = () => {
    const seat = game.controller.drivenSeat;
    const seatPos = seat && tank.getSeatWorldPosition(seat.componentId, seat.seatIndex);
    const state = tank.getComponentState(tank.rootComponentId) as Record<string, unknown>;
    return {
      tick: tank.tickCount, position: tank.position.toArray(), velocity: tank.velocity.toArray(),
      quaternion: tank.quaternion.toArray(), groundedWheels: Number(state.grounded ?? 0),
      scriptStatus: tank.scriptStatus, scriptError: tank.scriptError, isDriving: game.controller.isDriving,
      seatError: seatPos ? game.playerPhysics.position.distanceTo(seatPos) : null,
    };
  };

  const update: number[] = [], frame: number[] = [], frameCpu: number[] = [], readings: ReturnType<typeof latest>[] = [];
  let capture = false, lastFrame: number | null = null, lastTick = -1, terrainReports = 0;
  interceptMethod(tank, 'recordScriptContact', (run, args) => {
    if (capture && args[0]?.kind === 'terrain') terrainReports++;
    return run(...args);
  });
  interceptMethod(game.contraptionManager, 'update', (run, args) => {
    if (!capture) return run(...args);
    const start = performance.now();
    const result = run(...args);
    update.push(performance.now() - start);
    return result;
  });
  interceptMethod(game, 'animate', (run, args) => {
    if (!capture) return run(...args);
    const start = performance.now();
    const result = run(...args);
    frameCpu.push(performance.now() - start);
    if (lastFrame !== null) frame.push(start - lastFrame);
    lastFrame = start;
    if (tank.tickCount !== lastTick) {
      readings.push(latest());
      lastTick = tank.tickCount;
    }
    return result;
  });

  return {
    mode, initMs, stepZ, latest,
    mount() {
      game.controller.hoveredContraptionHit = null;
      game.controller.hoveredContraption = tank;
      const seat = tank.getSeatWorldPosition(tank.rootComponentId, 0);
      if (!seat) throw Error('The test vehicle has no seat');
      game.controller.hoveredContraptionHit = {
        contraption: tank, point: seat, entityId: tank.rootComponentId,
      };
      game.controller.toggleDriveVehicle();
    },
    key(code: 'KeyW' | 'Space', down: boolean) {
      const event = new KeyboardEvent(down ? 'keydown' : 'keyup', { code });
      if (down) game.controller.handleKeyDown(event);
      else game.controller.handleKeyUp(event);
    },
    edit, publishedEdit: () => world.getMicroCollisionBoxesInAABB(editedBounds).length,
    counts: () => candidate ? { ...candidate.counts } : null,
    pauseTrialScripts: () => tank.disableAllNodeScripts(),
    editResidentShapes(edit: 'add-decoration' | 'paint-decoration' | 'remove-decoration' | 'remove-voxel' | 'restore-voxel') {
      const root = tank.rootComponentId;
      const id = 'resident-shape-probe';
      if (edit === 'add-decoration') {
        return tank.editRuntimeDecoration(root, id, { position: [0, 4, 0], scale: [.125, .125, .125] }).ok;
      }
      if (edit === 'paint-decoration') return tank.editRuntimeDecoration(root, id, { color: 0xff0000 }).ok;
      if (edit === 'remove-decoration') return tank.editRuntimeDecoration(root, id, undefined, true).ok;
      const index = tank.blocks.indexOf(probeBlock);
      if (edit === 'remove-voxel') {
        if (index < 0) return false;
        tank.blocks.splice(index, 1);
        tank.rebuildAfterBlockChange('remove', root, null, { added: [], removed: [probeBlock] });
      } else {
        if (index >= 0) return false;
        tank.blocks.push(probeBlock);
        tank.rebuildAfterBlockChange('place', root, null, { added: [probeBlock], removed: [] });
      }
      return true;
    },
    startCapture() {
      update.length = frame.length = frameCpu.length = readings.length = 0;
      lastFrame = null;
      lastTick = -1;
      terrainReports = 0;
      capture = true;
    },
    stopCapture() {
      capture = false;
      return { update, frame, frameCpu, readings, terrainReports, rapier: candidate ? {
        ...candidate.counts, terrainRebuildMs: candidate.rebuildMs, hullRebuildMs: candidate.hullRebuildMs,
      } : null };
    },
  };
}
