import * as THREE from 'three';
import type { RuntimeVoxel } from '../contraption/EntityTypes.ts';
import { BlockTypes } from '../voxel/BlockTypes.ts';
import { CHUNK_SIZE_Y } from '../voxel/Chunk.ts';
import { MICRO_DIVISIONS } from '../voxel/MicroGrid.ts';
import type { BasicActionContext } from './ActionContracts.ts';
import { actionResult, blockOwnerId, commandMaterialId, entityRootId, finiteCell, requestedNodeId, resolveColor, resolveContraption, toPoint } from './ActionValues.ts';
import { executeEntityAction } from './EntityActions.ts';
import { entityBoxMatches } from './EntityBoxSelection.ts';
import { canEditInternalSelection, clearEntitySelection, invalidateInternalEntitySelections, selectionSnapshot } from './SelectionState.ts';
import { executeWorldAction } from './WorldActions.ts';

export function executeSelectionAction(context: BasicActionContext, command: any) {
  const manager = context?.manager;
  const owner = manager || context?.selectionHost;
  if (!owner) return actionResult(command.action, 0, 'selection_unavailable');

  switch (command.action) {
    case 'get':
      return selectionSnapshot(owner);
    case 'clear':
      clearEntitySelection(owner);
      manager?.clearSelection?.();
      return actionResult(command.action, 1, 'cleared', { cleared: 1 });
    case 'corner-a':
      if (!manager) return actionResult(command.action, 0, 'selection_unavailable');
      clearEntitySelection(owner);
      manager.setCornerA?.(toPoint(command.point), { micro: command.micro === true });
      return actionResult(command.action, 1, 'selected', { selected: 1 });
    case 'corner-b': {
      if (!manager) return actionResult(command.action, 0, 'selection_unavailable');
      clearEntitySelection(owner);
      const cornerInfo = manager.setCornerB?.(toPoint(command.point), { micro: command.micro === true });
      return actionResult(command.action, 1, 'selected', {
        selected: 1,
        clamped: !!cornerInfo?.clamped,
        materialized: cornerInfo?.materialized
      });
    }
    case 'box': {
      if (!manager) return actionResult(command.action, 0, 'selection_unavailable');
      const a = toPoint(command.a ?? command.cornerA);
      const b = toPoint(command.b ?? command.cornerB);
      if (!a || !b) return actionResult(command.action, 0, 'invalid_position', { selected: 0 });
      clearEntitySelection(owner);
      manager.setCornerA?.(a, { micro: command.micro === true });
      const boxInfo = manager.setCornerB?.(b, { micro: command.micro === true });
      const selected = manager.getSelectionBlockCount?.() || 0;
      return actionResult(command.action, 1, 'selected', { selected, clamped: !!boxInfo?.clamped, selection: selectionSnapshot(manager) });
    }
    case 'cells': {
      if (!manager) return actionResult(command.action, 0, 'selection_unavailable');
      const cells = Array.isArray(command.cells) ? command.cells.map((item: unknown) => finiteCell(item, true)).filter(Boolean) : [];
      clearEntitySelection(owner);
      const accepted = manager.setConnectedSelection?.(cells) !== false;
      if (!accepted) return actionResult(command.action, 0, 'bounds_exceeded', { selected: 0 });
      return actionResult(command.action, cells.length, cells.length ? 'selected' : 'empty', { selected: cells.length });
    }
    case 'toggle-cell': {
      if (!manager) return actionResult(command.action, 0, 'selection_unavailable');
      clearEntitySelection(owner);
      const point = toPoint(command.point);
      if (!point) return actionResult(command.action, 0, 'invalid_position', { selection: null });
      const info = command.micro === true
        ? manager.toggleMicroCell?.(point)
        : manager.toggleWorldGlueCell?.(point);
      if (!info) return actionResult(command.action, 0, 'invalid_position', { selection: null });
      if (info.rejected) return actionResult(command.action, 0, 'bounds_exceeded', { selection: info });
      return actionResult(command.action, 1, 'selected', { selection: info });
    }
    case 'entity-subtree': {
      const contraption = resolveContraption(context, command.target || { entityId: command.entityId });
      const nodeId = requestedNodeId(contraption, command.nodeId);
      if (!contraption?.entityNodes?.has(nodeId)) return actionResult(command.action, 0, 'entity_not_found', { selected: 0 });
      if (nodeId !== entityRootId(contraption) && !canEditInternalSelection(contraption)) {
        invalidateInternalEntitySelections(context, contraption);
        return actionResult(command.action, 0, 'entity_not_stopped', { selected: 0 });
      }
      clearEntitySelection(owner);
      manager?.clearSelection?.();
      const nodeIds = contraption.collectSubtreeNodeIds?.(nodeId) || new Set([nodeId]);
      contraption.clearSubtreeHighlight?.();
      contraption.highlightSubtree?.([...nodeIds]);
      owner.entitySelection = { kind: 'entity-subtree', contraption, rootId: nodeId, nodeId, nodeIds };
      const selected = contraption.blocks.filter(block => nodeIds.has(blockOwnerId(contraption, block))).length;
      return actionResult(command.action, selected || 1, 'selected', { selected, selection: owner.entitySelection });
    }
    case 'entity-box': {
      const contraption = resolveContraption(context, command.target || { entityId: command.entityId });
      const nodeId = requestedNodeId(contraption, command.nodeId);
      if (!contraption) return actionResult(command.action, 0, 'entity_not_found', { selected: 0, components: [] });
      if (!canEditInternalSelection(contraption)) {
        invalidateInternalEntitySelections(context, contraption);
        return actionResult(command.action, 0, 'entity_not_stopped', { selected: 0, components: [] });
      }
      const matches = entityBoxMatches(
        contraption,
        nodeId,
        command.a,
        command.b,
        command.space,
        command.micro === true,
        command.allComponents !== false
      );
      if (matches.selected.length === 0) {
        return actionResult(command.action, 0, 'not_found', { selected: 0, components: matches.components });
      }
      clearEntitySelection(owner);
      manager?.clearSelection?.();
      contraption.clearSubtreeHighlight?.();
      contraption.highlightBlocks?.(matches.selected);
      owner.entitySelection = {
        kind: 'entity-blocks',
        contraption,
        nodeId: matches.components.length === 1 ? matches.components[0] : nodeId,
        blocks: matches.selected,
        components: matches.components
      };
      return actionResult(command.action, matches.selected.length, 'selected', {
        selected: matches.selected.length,
        selection: owner.entitySelection,
        components: matches.components
      });
    }
    case 'toggle-entity-block': {
      const contraption = resolveContraption(context, command.target || { entityId: command.entityId });
      const nodeId = requestedNodeId(contraption, command.nodeId);
      const block = command.block;
      if (!contraption) return actionResult(command.action, 0, 'entity_not_found', { selected: 0 });
      if (!canEditInternalSelection(contraption)) {
        invalidateInternalEntitySelections(context, contraption);
        return actionResult(command.action, 0, 'entity_not_stopped', { selected: 0 });
      }
      if (!block) return actionResult(command.action, 0, 'invalid_block', { selected: 0 });

      // If existing selection is on a different contraption, clear it first
      if (owner.entitySelection && owner.entitySelection.contraption !== contraption) {
        clearEntitySelection(owner);
      }
      manager?.clearSelection?.();

      let currentBlocks: RuntimeVoxel[] = [];
      const currentSelection = owner.entitySelection?.kind === 'entity-blocks' && owner.entitySelection?.contraption === contraption
        ? owner.entitySelection
        : (context?.selectionHost?.selectedBlockSelection?.contraption === contraption
          ? context.selectionHost.selectedBlockSelection
          : null);
      if (currentSelection && Array.isArray(currentSelection.blocks)) {
        currentBlocks = [...currentSelection.blocks];
      }

      const isSameBlock = (b1: RuntimeVoxel, b2: RuntimeVoxel) => {
        if (b1 === b2) return true;
        const e1 = blockOwnerId(contraption, b1);
        const e2 = blockOwnerId(contraption, b2);
        return e1 === e2
          && Math.abs(b1.localX - b2.localX) < 1e-4
          && Math.abs(b1.localY - b2.localY) < 1e-4
          && Math.abs(b1.localZ - b2.localZ) < 1e-4
          && Math.abs((b1.size || 1) - (b2.size || 1)) < 1e-4;
      };

      const existingIndex = currentBlocks.findIndex(b => isSameBlock(b, block));
      if (existingIndex >= 0) {
        currentBlocks.splice(existingIndex, 1);
      } else {
        const targetBlock = contraption.blocks.find((b: RuntimeVoxel) => isSameBlock(b, block)) || block;
        currentBlocks.push(targetBlock);
      }

      contraption.clearSubtreeHighlight?.();
      if (currentBlocks.length > 0) {
        contraption.highlightBlocks?.(currentBlocks);
        owner.entitySelection = { kind: 'entity-blocks', contraption, nodeId, blocks: currentBlocks };
        return actionResult(command.action, currentBlocks.length, 'selected', {
          selected: currentBlocks.length,
          selection: owner.entitySelection
        });
      } else {
        owner.entitySelection = null;
        return actionResult(command.action, 0, 'empty', { selected: 0, selection: null });
      }
    }
    case 'delete': {
      const selected = command.selection || owner.entitySelection;
      if (selected?.kind === 'entity-subtree' && selected?.contraption) {
        const nodeId = requestedNodeId(selected.contraption, selected.nodeId, selected.rootId);
        if (nodeId !== entityRootId(selected.contraption) && !canEditInternalSelection(selected.contraption)) {
          invalidateInternalEntitySelections(context, selected.contraption);
          return actionResult(command.action, 0, 'entity_not_stopped', {
            removed: 0,
            standard: 0,
            micro: 0,
            entities: 0,
            components: 0
          });
        }
        const result = executeEntityAction(context, {
          action: 'remove-subtree',
          target: { contraption: selected.contraption },
          nodeId,
          actor: command.actor
        });
        selected.contraption?.clearSubtreeHighlight?.();
        owner.entitySelection = null;
        return result;
      }
      if (selected?.kind === 'entity-blocks' || (selected?.contraption && Array.isArray(selected?.blocks))) {
        if (!canEditInternalSelection(selected.contraption)) {
          invalidateInternalEntitySelections(context, selected.contraption);
          return actionResult(command.action, 0, 'entity_not_stopped', {
            removed: 0,
            standard: 0,
            micro: 0,
            entities: 0,
            components: 0
          });
        }
        const result = executeEntityAction(context, {
          action: 'remove-blocks',
          target: { contraption: selected.contraption },
          nodeId: selected.nodeId,
          blocks: selected.blocks,
          actor: command.actor
        });
        selected.contraption?.clearSubtreeHighlight?.();
        owner.entitySelection = null;
        return result;
      }
      if (!manager?.hasValidSelection?.()) return actionResult(command.action, 0, 'no_selection', { removed: 0 });
      if (manager.microSelection !== null || manager.microBounds) {
        const world = context?.world;
        const partition = manager.partitionMicroSelection ? manager.partitionMicroSelection() : null;
        let removedStandard = 0;
        let removedMicro = 0;

        if (partition && (partition.standardCells.length > 0 || partition.microCells.length > 0)) {
          // 1. Process merged standard cells directly without subdivision
          for (const cell of partition.standardCells) {
            const res = executeWorldAction(context, { action: 'clear-cell', cell });
            removedStandard += res.standard || 0;
            removedMicro += res.micro || 0;
          }

          // 2. Subdivide partially covered cells and remove targeted micro cells
          const partialCells = new Set<string>();
          for (const cell of partition.microCells) {
            const wx = Math.floor(cell.x / MICRO_DIVISIONS);
            const wy = Math.floor(cell.y / MICRO_DIVISIONS);
            const wz = Math.floor(cell.z / MICRO_DIVISIONS);
            const cellKey = `${wx},${wy},${wz}`;
            if (!partialCells.has(cellKey)) {
              if (world?.getBlock && world.getBlock(wx, wy, wz) !== BlockTypes.AIR) {
                world.subdivideBlock?.(wx, wy, wz);
              }
              partialCells.add(cellKey);
            }
          }

          for (const cell of partition.microCells) {
            if (cell.y < 0 || cell.y >= CHUNK_SIZE_Y * MICRO_DIVISIONS) continue;
            removedMicro += executeWorldAction(context, { action: 'remove-micro', micro: cell }).removed || 0;
          }
        } else {
          // Fallback if no partition available
          const cells = manager.microSelection || [];
          const subdividedStandardCells = new Set<string>();
          for (const cell of cells) {
            const wx = Math.floor(cell.x / MICRO_DIVISIONS);
            const wy = Math.floor(cell.y / MICRO_DIVISIONS);
            const wz = Math.floor(cell.z / MICRO_DIVISIONS);
            const cellKey = `${wx},${wy},${wz}`;
            if (!subdividedStandardCells.has(cellKey)) {
              if (world?.getBlock && world.getBlock(wx, wy, wz) !== BlockTypes.AIR) {
                world.subdivideBlock?.(wx, wy, wz);
              }
              subdividedStandardCells.add(cellKey);
            }
          }
          for (const cell of cells) {
            if (cell.y < 0 || cell.y >= CHUNK_SIZE_Y * MICRO_DIVISIONS) continue;
            removedMicro += executeWorldAction(context, { action: 'remove-micro', micro: cell }).removed || 0;
          }
        }

        manager.clearSelection?.();
        const totalRemoved = removedStandard + removedMicro;
        return actionResult(command.action, totalRemoved, totalRemoved ? 'removed' : 'not_found', {
          removed: totalRemoved,
          standard: removedStandard,
          micro: removedMicro,
          entities: 0,
          components: 0
        });
      }
      const bounds = manager.getSelectionBounds?.();
      const cells = manager.connectedSelection !== null
        ? [...(manager.connectedSelection || [])]
        : bounds
          ? (() => {
              const result: { x: number; y: number; z: number }[] = [];
              for (let x = bounds.minX; x <= bounds.maxX; x++) {
                for (let y = bounds.minY; y <= bounds.maxY; y++) {
                  for (let z = bounds.minZ; z <= bounds.maxZ; z++) result.push({ x, y, z });
                }
              }
              return result;
            })()
          : [];
      const result = executeWorldAction(context, { action: 'remove-cells', cells });
      manager.clearSelection?.();
      return result;
    }
    case 'paint': {
      const color = resolveColor(command.options?.color ?? command.color ?? command.options);
      const fromColor = command.options?.fromColor !== undefined || command.fromColor !== undefined
        ? resolveColor(command.options?.fromColor ?? command.fromColor)
        : null;
      const options = {
        ...(command.options || {}),
        color,
        ...(fromColor !== null ? { fromColor } : {})
      };
      const selected = command.selection || owner.entitySelection;
      if (selected?.kind === 'entity-subtree' && selected?.contraption) {
        const nodeId = requestedNodeId(selected.contraption, selected.nodeId, selected.rootId);
        if (nodeId !== entityRootId(selected.contraption) && !canEditInternalSelection(selected.contraption)) {
          invalidateInternalEntitySelections(context, selected.contraption);
          return actionResult(command.action, 0, 'entity_not_stopped', { painted: 0 });
        }
        const nodeIds = selected.contraption.collectSubtreeNodeIds?.(nodeId) || new Set([nodeId]);
        const blocks = selected.contraption.blocks.filter((block: RuntimeVoxel) => nodeIds.has(blockOwnerId(selected.contraption, block)));
        return executeEntityAction(context, {
          action: 'paint-blocks',
          target: { contraption: selected.contraption },
          nodeId,
          blocks,
          color,
          options,
          actor: command.actor
        });
      }
      if (selected?.kind === 'entity-blocks' || (selected?.contraption && Array.isArray(selected?.blocks))) {
        if (!canEditInternalSelection(selected.contraption)) {
          invalidateInternalEntitySelections(context, selected.contraption);
          return actionResult(command.action, 0, 'entity_not_stopped', { painted: 0 });
        }
        return executeEntityAction(context, {
          action: 'paint-blocks',
          target: { contraption: selected.contraption },
          nodeId: selected.nodeId,
          blocks: selected.blocks,
          color,
          options,
          actor: command.actor
        });
      }
      if (!manager?.hasValidSelection?.()) return actionResult(command.action, 0, 'no_selection', { painted: 0 });
      if (manager.microSelection !== null || manager.microBounds) {
        const world = context?.world;
        const partition = manager.partitionMicroSelection ? manager.partitionMicroSelection() : null;
        let paintedStandard = 0;
        let paintedMicro = 0;

        if (partition && (partition.standardCells.length > 0 || partition.microCells.length > 0)) {
          // 1. Process merged standard cells
          for (const cell of partition.standardCells) {
            if (world?.getBlock && world.getBlock(cell.x, cell.y, cell.z) !== BlockTypes.AIR) {
              const currentColor = world.getBlockColor ? world.getBlockColor(cell.x, cell.y, cell.z) : null;
              if (fromColor === null || currentColor === fromColor) {
                if (executeWorldAction(context, { action: 'paint-standard', cell, color, options }).painted) {
                  paintedStandard++;
                }
              }
            } else if (world?.microVoxels?.hasAnyInStandardCell?.(cell.x, cell.y, cell.z)) {
              let cellCount = 0;
              let matchCount = 0;
              const baseX = cell.x * MICRO_DIVISIONS;
              const baseY = cell.y * MICRO_DIVISIONS;
              const baseZ = cell.z * MICRO_DIVISIONS;
              for (let dx = 0; dx < MICRO_DIVISIONS; dx++) {
                for (let dy = 0; dy < MICRO_DIVISIONS; dy++) {
                  for (let dz = 0; dz < MICRO_DIVISIONS; dz++) {
                    const mBlock = world.getMicroBlock?.(baseX + dx, baseY + dy, baseZ + dz);
                    if (mBlock) {
                      cellCount++;
                      if (fromColor === null || mBlock.color === fromColor) matchCount++;
                    }
                  }
                }
              }
              if (cellCount === MICRO_DIVISIONS ** 3 && matchCount === cellCount) {
                // All 512 microblocks match: coalesce directly into 1 standard block!
                world.clearMicroStandardCell?.(cell.x, cell.y, cell.z);
                world.setBlock?.(cell.x, cell.y, cell.z, BlockTypes.COLOR_BLOCK, true, color, commandMaterialId(options));
                paintedStandard++;
              } else {
                for (let dx = 0; dx < MICRO_DIVISIONS; dx++) {
                  for (let dy = 0; dy < MICRO_DIVISIONS; dy++) {
                    for (let dz = 0; dz < MICRO_DIVISIONS; dz++) {
                      const mx = baseX + dx;
                      const my = baseY + dy;
                      const mz = baseZ + dz;
                      const mBlock = world.getMicroBlock?.(mx, my, mz);
                      if (mBlock && (fromColor === null || mBlock.color === fromColor)) {
                        if (executeWorldAction(context, { action: 'paint-micro', micro: { x: mx, y: my, z: mz }, color, options }).painted) {
                          paintedMicro++;
                        }
                      }
                    }
                  }
                }
              }
            }
          }

          // 2. Process boundary / residual micro cells
          const partialCells = new Set<string>();
          for (const cell of partition.microCells) {
            const wx = Math.floor(cell.x / MICRO_DIVISIONS);
            const wy = Math.floor(cell.y / MICRO_DIVISIONS);
            const wz = Math.floor(cell.z / MICRO_DIVISIONS);
            const cellKey = `${wx},${wy},${wz}`;
            if (!partialCells.has(cellKey)) {
              if (world?.getBlock && world.getBlock(wx, wy, wz) !== BlockTypes.AIR) {
                world.subdivideBlock?.(wx, wy, wz);
              }
              partialCells.add(cellKey);
            }
          }

          for (const cell of partition.microCells) {
            if (cell.y < 0 || cell.y >= CHUNK_SIZE_Y * MICRO_DIVISIONS) continue;
            const mBlock = world?.getMicroBlock?.(cell.x, cell.y, cell.z);
            if (mBlock && (fromColor === null || mBlock.color === fromColor)) {
              if (executeWorldAction(context, { action: 'paint-micro', micro: cell, color, options }).painted) {
                paintedMicro++;
              }
            }
          }
        } else {
          // Fallback
          const cells = manager.microSelection || [];
          for (const cell of cells) {
            if (cell.y < 0 || cell.y >= CHUNK_SIZE_Y * MICRO_DIVISIONS) continue;
            if (executeWorldAction(context, { action: 'paint-micro', micro: cell, color, options }).painted) {
              paintedMicro++;
            }
          }
        }

        const totalPainted = paintedStandard + paintedMicro;
        return actionResult(command.action, totalPainted, totalPainted ? 'painted' : 'not_found', {
          painted: totalPainted,
          standard: paintedStandard,
          micro: paintedMicro,
          color
        });
      }
      const bounds = manager.getSelectionBounds?.();
      const cells = manager.connectedSelection !== null
        ? [...(manager.connectedSelection || [])]
        : bounds
          ? (() => {
              const result: { x: number; y: number; z: number }[] = [];
              for (let x = bounds.minX; x <= bounds.maxX; x++) {
                for (let y = bounds.minY; y <= bounds.maxY; y++) {
                  for (let z = bounds.minZ; z <= bounds.maxZ; z++) result.push({ x, y, z });
                }
              }
              return result;
            })()
          : [];
      const worldResult = executeWorldAction(context, { action: 'paint-cells', cells, color, options });
      let totalPainted = worldResult.painted || 0;
      if (bounds && Array.isArray(manager?.contraptions)) {
        for (const c of manager.contraptions) {
          if (!canEditInternalSelection(c) || !Array.isArray(c.blocks)) continue;
          const insideBlocks: RuntimeVoxel[] = [];
          for (const block of c.blocks) {
            const worldPos = c.entityLocalToWorld?.(
              blockOwnerId(c, block),
              new THREE.Vector3(block.localX + 0.5 * (block.size || 1), block.localY + 0.5 * (block.size || 1), block.localZ + 0.5 * (block.size || 1))
            );
            if (worldPos && worldPos.x >= bounds.minX && worldPos.x <= bounds.maxX + 1
              && worldPos.y >= bounds.minY && worldPos.y <= bounds.maxY + 1
              && worldPos.z >= bounds.minZ && worldPos.z <= bounds.maxZ + 1) {
              insideBlocks.push(block);
            }
          }
          if (insideBlocks.length > 0) {
            const entityPaint = executeEntityAction(context, {
              action: 'paint-blocks',
              target: { contraption: c },
              nodeId: entityRootId(c),
              blocks: insideBlocks,
              color,
              options,
              actor: command.actor
            });
            totalPainted += entityPaint.painted || 0;
          }
        }
      }
      return actionResult(command.action, totalPainted, totalPainted ? 'painted' : 'not_found', {
        painted: totalPainted,
        color
      });
    }
    case 'fill': {
      const color = resolveColor(command.options?.color ?? command.color ?? command.options);
      const options = { ...(command.options || {}), color };
      const selected = command.selection || owner.entitySelection;
      if (selected?.kind === 'entity-blocks' && selected?.contraption) {
        return executeEntityAction(context, {
          action: 'paint-blocks',
          target: { contraption: selected.contraption },
          nodeId: selected.nodeId,
          blocks: selected.blocks,
          color,
          options,
          actor: command.actor
        });
      }
      if (!manager?.hasValidSelection?.()) return actionResult(command.action, 0, 'no_selection', { placed: 0 });

      if (manager.microSelection !== null || manager.microBounds) {
        const world = context?.world;
        const partition = manager.partitionMicroSelection ? manager.partitionMicroSelection() : null;
        let placedStandard = 0;
        let placedMicro = 0;

        if (partition && (partition.standardCells.length > 0 || partition.microCells.length > 0)) {
          // 1. Process merged standard cells as solid standard blocks
          for (const cell of partition.standardCells) {
            const res = executeWorldAction(context, { action: 'place-standard', cell, color, options, replace: true });
            if (res.placed) placedStandard++;
          }

          // 2. Process boundary microcells
          const partialCells = new Set<string>();
          for (const cell of partition.microCells) {
            const wx = Math.floor(cell.x / MICRO_DIVISIONS);
            const wy = Math.floor(cell.y / MICRO_DIVISIONS);
            const wz = Math.floor(cell.z / MICRO_DIVISIONS);
            const cellKey = `${wx},${wy},${wz}`;
            if (!partialCells.has(cellKey)) {
              if (world?.getBlock && world.getBlock(wx, wy, wz) !== BlockTypes.AIR) {
                world.subdivideBlock?.(wx, wy, wz);
              }
              partialCells.add(cellKey);
            }
          }

          for (const cell of partition.microCells) {
            if (cell.y < 0 || cell.y >= CHUNK_SIZE_Y * MICRO_DIVISIONS) continue;
            const res = executeWorldAction(context, { action: 'place-micro', micro: cell, color, options, replace: true });
            if (res.placed) placedMicro++;
          }
        } else {
          const cells = manager.microSelection || [];
          for (const cell of cells) {
            if (cell.y < 0 || cell.y >= CHUNK_SIZE_Y * MICRO_DIVISIONS) continue;
            const res = executeWorldAction(context, { action: 'place-micro', micro: cell, color, options, replace: true });
            if (res.placed) placedMicro++;
          }
        }

        const totalPlaced = placedStandard + placedMicro;
        return actionResult(command.action, totalPlaced, totalPlaced ? 'placed' : 'out_of_bounds', {
          placed: totalPlaced,
          standard: placedStandard,
          micro: placedMicro,
          color
        });
      }

      // Standard box or connected cells fill
      const bounds = manager.getSelectionBounds?.();
      const cells = manager.connectedSelection !== null
        ? [...(manager.connectedSelection || [])]
        : bounds
          ? (() => {
              const result: { x: number; y: number; z: number }[] = [];
              for (let x = bounds.minX; x <= bounds.maxX; x++) {
                for (let y = bounds.minY; y <= bounds.maxY; y++) {
                  for (let z = bounds.minZ; z <= bounds.maxZ; z++) result.push({ x, y, z });
                }
              }
              return result;
            })()
          : [];
      let totalPlaced = 0;
      for (const cell of cells) {
        const res = executeWorldAction(context, { action: 'place-standard', cell, color, options, replace: true });
        if (res.placed) totalPlaced++;
      }
      return actionResult(command.action, totalPlaced, totalPlaced ? 'placed' : 'out_of_bounds', {
        placed: totalPlaced,
        standard: totalPlaced,
        micro: 0,
        color
      });
    }
    case 'assemble': {
      const mode = manager?.normalizeAssemblyMode?.(command.mode);
      if (!mode) {
        return actionResult(command.action, 0, 'invalid_mode', {
          assembled: 0,
          entity: null,
          entityId: null,
          runtimeId: null
        });
      }
      const prepared = command.prepared;
      if (!prepared && !manager?.hasValidSelection?.()) {
        return actionResult(command.action, 0, 'no_selection', {
          assembled: 0,
          entity: null,
          entityId: null,
          runtimeId: null
        });
      }
      const entity = prepared
        ? manager?.commitPreparedAssembly?.(
            prepared.blocks,
            new THREE.Vector3(
              Number(prepared.origin?.x) || 0,
              Number(prepared.origin?.y) || 0,
              Number(prepared.origin?.z) || 0
            ),
            mode,
            command.options || {}
          )
        : manager?.assembleSelection?.(mode, command.options || {});
      return actionResult(command.action, entity ? 1 : 0, entity ? 'assembled' : 'empty', {
        assembled: entity ? 1 : 0,
        entity,
        entityId: entity?.publicId ?? null,
        runtimeId: entity?.id ?? null
      });
    }
    case 'create-child': {
      const selected = command.selection || owner.entitySelection;
      const legacyContraption = manager?.childSelection?.contraption;
      const targetContraption = selected?.contraption || legacyContraption;
      if (targetContraption && !canEditInternalSelection(targetContraption)) {
        invalidateInternalEntitySelections(context, targetContraption);
        return actionResult(command.action, 0, 'entity_not_stopped', { child: null, childId: null });
      }
      if ((!selected?.contraption || !Array.isArray(selected.blocks) || selected.blocks.length === 0)
        && manager?.hasReadyChildSelection?.()) {
        const legacyResult = manager.createChildFromSelection?.(command.id || null);
        const child = legacyResult?.child || null;
        return actionResult(command.action, child ? 1 : 0, child ? 'created' : 'not_found', {
          child,
          childId: child?.id ?? null,
          contraption: legacyResult?.contraption || null
        });
      }
      if (!selected?.contraption || !Array.isArray(selected.blocks) || selected.blocks.length === 0) {
        return actionResult(command.action, 0, 'no_selection', { child: null });
      }

      const componentSet = new Set<string>();
      for (const b of selected.blocks) {
        const ownerId = blockOwnerId(selected.contraption, b);
        if (ownerId) componentSet.add(ownerId);
      }
      if (componentSet.size > 1) {
        return actionResult(command.action, 0, 'multiple_components', {
          child: null,
          childId: null,
          components: Array.from(componentSet).sort()
        });
      }
      const targetNodeId = componentSet.size === 1
        ? [...componentSet][0]
        : requestedNodeId(selected.contraption, selected.nodeId);

      const child = selected.preparedBounds
        ? selected.contraption.createChildEntityFromPrepared?.(
            targetNodeId,
            selected.blocks,
            selected.preparedBounds,
            command.id || null
          )
        : selected.contraption.createChildEntity?.(
            targetNodeId,
            selected.blocks,
            command.id || null
          );
      if (child) {
        selected.contraption.clearSubtreeHighlight?.();
        owner.entitySelection = null;
      }
      return actionResult(command.action, child ? 1 : 0, child ? 'created' : 'not_found', { child, childId: child?.id ?? null });
    }
    default:
      return actionResult(command.action, 0, 'unsupported_action');
  }
}
