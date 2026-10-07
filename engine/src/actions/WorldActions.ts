import { readRecord } from '../contraption/EntityInput.ts';
import { BlockTypes, DEFAULT_BLOCK_COLOR } from '../voxel/BlockTypes.ts';
import { CHUNK_SIZE_Y } from '../voxel/Chunk.ts';
import { MICRO_DIVISIONS } from '../voxel/MicroGrid.ts';
import type { ActionOutcome, ActionPayload, BasicActionContext, WorldActionCommand, WorldVoxelView } from './ActionContracts.ts';
import { actionResult, commandMaterialId, finiteCell, finiteMicro, resolveColor } from './ActionValues.ts';

export function executeWorldAction(context: BasicActionContext, command: { action: Exclude<WorldActionCommand['action'], 'get-standard' | 'get-micro'> } & Record<string, unknown>): ActionOutcome;

export function executeWorldAction(context: BasicActionContext, command: ActionPayload): ActionOutcome | WorldVoxelView;

export function executeWorldAction(context: BasicActionContext, command: ActionPayload): ActionOutcome | WorldVoxelView {
  const options = readRecord(command.options);
  const world = context?.world || context?.manager?.world;
  if (!world) return actionResult(command.action, 0, 'world_unavailable');
  const cell = finiteCell(command.cell ?? command.position, true);
  const micro = finiteMicro(command.micro);

  switch (command.action) {
    case 'get-standard': {
      if (!cell) return { block: BlockTypes.AIR, color: 0x000000 };
      const block = world.getBlock?.(cell.x, cell.y, cell.z) ?? BlockTypes.AIR;
      return {
        block,
        color: block === BlockTypes.AIR ? 0x000000 : (world.getBlockColor?.(cell.x, cell.y, cell.z) ?? DEFAULT_BLOCK_COLOR),
        materialId: block === BlockTypes.AIR ? 0 : (world.getBlockMaterial?.(cell.x, cell.y, cell.z) ?? 0),
      };
    }
    case 'get-micro': {
      if (!micro) return { block: BlockTypes.AIR, color: 0x000000, materialId: 0 };
      const value = world.getMicroBlock?.(micro.x, micro.y, micro.z);
      return value
        ? { ...value, materialId: value.materialId ?? 0 }
        : { block: BlockTypes.AIR, color: 0x000000, materialId: 0 };
    }
    case 'place-standard': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { placed: 0 });
      const occupied = (world.getBlock?.(cell.x, cell.y, cell.z) ?? BlockTypes.AIR) !== BlockTypes.AIR
        || !!world.hasMicroInStandardCell?.(cell.x, cell.y, cell.z);
      if (occupied && !command.replace) return actionResult(command.action, 0, 'occupied', { placed: 0 });
      if (command.replace) {
        world.clearMicroStandardCell?.(cell.x, cell.y, cell.z);
      }
      const result = world.setBlock?.(
        cell.x, cell.y, cell.z,
        Number(command.block) || BlockTypes.COLOR_BLOCK,
        command.updateMesh !== false,
        resolveColor(command.options ?? command.color),
        commandMaterialId(command.options)
      );
      // A few lightweight adapters intentionally return void after performing the write.
      const placed = result === false ? 0 : 1;
      return actionResult(command.action, placed, placed ? 'placed' : 'out_of_bounds', { placed });
    }
    case 'remove-standard': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { removed: 0 });
      if (world.getBlock && world.getBlock(cell.x, cell.y, cell.z) === BlockTypes.AIR) {
        return actionResult(command.action, 0, 'not_found', { removed: 0 });
      }
      const result = world.setBlock?.(cell.x, cell.y, cell.z, BlockTypes.AIR, command.updateMesh !== false);
      const removed = result === false ? 0 : 1;
      return actionResult(command.action, removed, removed ? 'removed' : 'not_found', { removed });
    }
    case 'paint-standard': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { painted: 0 });
      const currentMaterial = world.getBlockMaterial?.(cell.x, cell.y, cell.z) ?? 0;
      const materialId = options.materialId === undefined
        ? currentMaterial
        : commandMaterialId(command.options);
      const painted = world.setBlockAppearance?.(
        cell.x, cell.y, cell.z,
        resolveColor(command.options ?? command.color),
        materialId,
      ) ? 1 : 0;
      return actionResult(command.action, painted, painted ? 'painted' : 'not_found', { painted });
    }
    case 'place-micro': {
      if (!micro || micro.y < 0 || micro.y >= CHUNK_SIZE_Y * MICRO_DIVISIONS) {
        return actionResult(command.action, 0, 'invalid_position', { placed: 0 });
      }
      const parent = { x: Math.floor(micro.x / MICRO_DIVISIONS), y: Math.floor(micro.y / MICRO_DIVISIONS), z: Math.floor(micro.z / MICRO_DIVISIONS) };
      const occupied = (world.getBlock?.(parent.x, parent.y, parent.z) ?? BlockTypes.AIR) !== BlockTypes.AIR
        || !!world.getMicroBlock?.(micro.x, micro.y, micro.z);
      if (occupied && !command.replace) return actionResult(command.action, 0, 'occupied', { placed: 0 });
      const result = world.setMicroBlock?.(
        micro.x, micro.y, micro.z,
        resolveColor(command.options ?? command.color),
        typeof command.part === 'string' ? command.part : null,
        commandMaterialId(command.options)
      );
      const placed = result === false ? 0 : 1;
      return actionResult(command.action, placed, placed ? 'placed' : 'out_of_bounds', { placed });
    }
    case 'remove-micro': {
      if (!micro) return actionResult(command.action, 0, 'invalid_position', { removed: 0 });
      const removed = world.removeMicroBlock?.(micro.x, micro.y, micro.z) ? 1 : 0;
      return actionResult(command.action, removed, removed ? 'removed' : 'not_found', { removed });
    }
    case 'paint-micro': {
      if (!micro) return actionResult(command.action, 0, 'invalid_position', { painted: 0 });
      if (world.getMicroBlock && !world.getMicroBlock(micro.x, micro.y, micro.z)) {
        return actionResult(command.action, 0, 'not_found', { painted: 0 });
      }
      const existing = world.getMicroBlock?.(micro.x, micro.y, micro.z);
      const materialId = options.materialId === undefined
        ? (existing?.materialId ?? 0)
        : commandMaterialId(command.options);
      const painted = world.setMicroBlock?.(
        micro.x, micro.y, micro.z,
        resolveColor(command.options ?? command.color),
        world.getMicroBlockPart?.(micro.x, micro.y, micro.z) ?? null,
        materialId,
      ) ? 1 : 0;
      return actionResult(command.action, painted, painted ? 'painted' : 'not_found', { painted });
    }
    case 'clear-cell': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { removed: 0, standard: 0, micro: 0 });
      let standard = 0;
      if (!command.microOnly && (!world.getBlock || world.getBlock(cell.x, cell.y, cell.z) !== BlockTypes.AIR)) {
        const removed = world.setBlock?.(cell.x, cell.y, cell.z, BlockTypes.AIR, command.updateMesh !== false);
        standard = removed === false ? 0 : 1;
      }
      const microCount = Number(world.clearMicroStandardCell?.(cell.x, cell.y, cell.z)) || 0;
      const removed = standard + microCount;
      return actionResult(command.action, removed, removed ? 'removed' : 'not_found', {
        removed,
        standard,
        micro: microCount
      });
    }
    case 'subdivide-standard': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { subdivided: 0, removed: 0 });
      const subdivided = Number(world.subdivideBlock?.(cell.x, cell.y, cell.z)) || 0;
      let removed = 0;
      if (subdivided > 0 && micro) removed = world.removeMicroBlock?.(micro.x, micro.y, micro.z) ? 1 : 0;
      return actionResult(command.action, subdivided, subdivided ? 'subdivided' : 'not_found', { subdivided, removed });
    }
    case 'remove-cells': {
      const cells = Array.isArray(command.cells) ? command.cells.map((item: unknown) => finiteCell(item, true)).filter(item => item !== null) : [];
      let standard = 0;
      let microCount = 0;
      for (const item of cells) {
        const result = executeWorldAction(context, { action: 'clear-cell', cell: item, updateMesh: command.updateMesh });
        standard += result.standard || 0;
        microCount += result.micro || 0;
      }
      const removed = standard + microCount;
      return actionResult(command.action, removed, removed ? 'removed' : 'not_found', {
        removed,
        standard,
        micro: microCount
      });
    }
    case 'paint-cells': {
      const cells = Array.isArray(command.cells) ? command.cells.map((item: unknown) => finiteCell(item, true)).filter(item => item !== null) : [];
      const color = resolveColor(command.options ?? command.color);
      const changesMaterial = options.materialId !== undefined;
      const materialId = commandMaterialId(command.options);
      let standard = 0;
      let microCount = 0;
      for (const item of cells) {
        if (world.getBlock?.(item.x, item.y, item.z) !== BlockTypes.AIR) {
          const nextMaterial = changesMaterial
            ? materialId
            : (world.getBlockMaterial?.(item.x, item.y, item.z) ?? 0);
          if (world.setBlockAppearance?.(item.x, item.y, item.z, color, nextMaterial)) {
            standard++;
          }
        }
        for (let dx = 0; dx < MICRO_DIVISIONS; dx++) {
          for (let dy = 0; dy < MICRO_DIVISIONS; dy++) {
            for (let dz = 0; dz < MICRO_DIVISIONS; dz++) {
              const mx = item.x * MICRO_DIVISIONS + dx;
              const my = item.y * MICRO_DIVISIONS + dy;
              const mz = item.z * MICRO_DIVISIONS + dz;
              const existing = world.getMicroBlock?.(mx, my, mz);
              if (existing) {
                if (world.setMicroBlock?.(
                  mx, my, mz, color, world.getMicroBlockPart?.(mx, my, mz) ?? null,
                  changesMaterial ? materialId : (existing.materialId ?? 0),
                )) {
                  microCount++;
                }
              }
            }
          }
        }
      }
      const painted = standard + microCount;
      return actionResult(command.action, painted, painted ? 'painted' : 'not_found', {
        painted,
        standard,
        micro: microCount,
        color
      });
    }
    default:
      return actionResult(command.action, 0, 'unsupported_action');
  }
}
