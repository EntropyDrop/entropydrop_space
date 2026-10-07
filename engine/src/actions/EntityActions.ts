import { MAX_ENTITY_BOUNDS } from '../constants/SpaceConstants.ts';
import type { Contraption } from '../contraption/Contraption.ts';
import type { RuntimeVoxel } from '../contraption/EntityTypes.ts';
import { BlockTypes, DEFAULT_BLOCK_COLOR, normalizeColor } from '../voxel/BlockTypes.ts';
import { MICRO_CELLS_PER_BLOCK, MICRO_DIVISIONS, MICRO_SIZE } from '../voxel/MicroGrid.ts';
import { normalizeVoxelMaterialId } from '../voxel/VoxelMaterials.ts';
import type { BasicActionContext } from './ActionContracts.ts';
import { actionResult, blockCell, blockInCell, blockOwnerId, commandMaterialId, entityRootId, finiteCell, finiteMicro, requestedNodeId, resolveColor, resolveContraption } from './ActionValues.ts';
import { canEditInternalSelection, invalidateInternalEntitySelections } from './SelectionState.ts';

export function entityAABBAllows(contraption: Contraption, x: number, y: number, z: number, size = 1) {
  const min = contraption.minLocal;
  const max = contraption.maxLocal;
  if (!min || !max) return true;
  return (
    Math.max(x + size, max.x) - Math.min(x, min.x) <= MAX_ENTITY_BOUNDS
    && Math.max(y + size, max.y) - Math.min(y, min.y) <= MAX_ENTITY_BOUNDS
    && Math.max(z + size, max.z) - Math.min(z, min.z) <= MAX_ENTITY_BOUNDS
  );
}

export function entityNodeColor(contraption: Contraption, nodeId: string, options: unknown) {
  const inherited = contraption.blocks?.find(block => blockOwnerId(contraption, block) === nodeId)?.color
    ?? DEFAULT_BLOCK_COLOR;
  return resolveColor(options, normalizeColor(inherited));
}

export function finishEntityMutation(context: BasicActionContext, contraption: Contraption, type: string, nodeId: string, event: Parameters<Contraption['rebuildAfterBlockChange']>[2] = null, changes: Parameters<Contraption['rebuildAfterBlockChange']>[3] = null) {
  const empty = !contraption.blocks || contraption.blocks.length === 0;
  const manager = context?.manager || contraption?.actionContext?.manager;
  if (empty && manager?.contraptions?.includes(contraption)) {
    manager.removeContraption?.(contraption);
  } else {
    contraption.rebuildAfterBlockChange?.(type, nodeId, event, changes);
  }
  return empty;
}

export const PLAYER_STOPPED_ONLY_ENTITY_ACTIONS = new Set([
  'place-standard', 'remove-standard', 'paint-standard',
  'place-micro', 'remove-micro', 'paint-micro',
  'clear-cell', 'subdivide-standard', 'subdivide-cells',
  'fill-blocks', 'paint-blocks', 'remove-blocks', 'remove-subtree'
]);

export function entityMutationEvent(command: any, extra: any = {}) {
  const source = String(command?.actor?.source || 'system');
  return {
    source,
    playerId: command?.actor?.playerId ?? (source === 'player' ? 'local' : null),
    ...extra
  };
}

export function executeEntityAction(context: BasicActionContext, command: any): ReturnType<typeof actionResult> {
  const contraption = resolveContraption(context, command.target);
  if (!contraption || !Array.isArray(contraption.blocks)) {
    return actionResult(command.action, 0, 'entity_not_found');
  }
  if (
    contraption.serverManaged === true
    && contraption.serverCanEdit !== true
    && command.actor?.source !== 'script'
    && command.actor?.source !== 'server-sync'
  ) {
    return actionResult(command.action, 0, 'server_entity_read_only');
  }
  // Player editing always targets the authored construction grid. That grid is
  // stable only after Stop has restored the entity pose and disabled physics.
  // Runtime scripts keep their existing self-modifying voxel API; this guard is
  // specifically for manual/editor mutations dispatched with actor=player.
  if (command.actor?.source === 'player'
    && PLAYER_STOPPED_ONLY_ENTITY_ACTIONS.has(command.action)
    && !canEditInternalSelection(contraption)) {
    return actionResult(command.action, 0, 'entity_not_stopped', {
      placed: 0,
      removed: 0,
      painted: 0,
      subdivided: 0,
      added: 0,
      recolored: 0
    });
  }
  const nodeId = requestedNodeId(contraption, command.nodeId, command.target?.nodeId);
  if (contraption.entityNodes?.has && !contraption.entityNodes.has(nodeId)) {
    return actionResult(command.action, 0, 'component_not_found');
  }
  const cell = finiteCell(command.cell ?? command.position);
  const micro = finiteMicro(command.micro);

  switch (command.action) {
    case 'place-standard': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { placed: 0 });
      if (contraption.blocks.some(block => blockInCell(block, cell))) {
        return actionResult(command.action, 0, 'occupied', { placed: 0 });
      }
      if (!entityAABBAllows(contraption, cell.x, cell.y, cell.z)) {
        return actionResult(command.action, 0, 'bounds_exceeded', { placed: 0 });
      }
      const placedBlock = {
        localX: cell.x,
        localY: cell.y,
        localZ: cell.z,
        size: 1,
        color: entityNodeColor(contraption, nodeId, command.options ?? command.color),
        materialId: commandMaterialId(command.options),
        block: command.block || BlockTypes.COLOR_BLOCK,
        entityId: nodeId
      };
      contraption.blocks.push(placedBlock);
      finishEntityMutation(context, contraption, 'place', nodeId, entityMutationEvent(command, {
        cell: [cell.x, cell.y, cell.z],
        size: 1,
        block: placedBlock.block,
        color: placedBlock.color,
        materialId: placedBlock.materialId
      }));
      return actionResult(command.action, 1, 'placed', { placed: 1, empty: false });
    }
    case 'remove-standard': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { removed: 0 });
      const index = contraption.blocks.findIndex(block => (
        blockOwnerId(contraption, block) === nodeId
        && (block.size || 1) >= 1
        && blockInCell(block, cell)
      ));
      if (index < 0) return actionResult(command.action, 0, 'not_found', { removed: 0 });
      const removedBlock = contraption.blocks[index];
      contraption.blocks.splice(index, 1);
      const empty = finishEntityMutation(context, contraption, 'remove', nodeId, entityMutationEvent(command, {
        cell: [cell.x, cell.y, cell.z],
        size: removedBlock.size || 1,
        block: removedBlock.block,
        color: removedBlock.color
      }));
      return actionResult(command.action, 1, 'removed', { removed: 1, empty });
    }
    case 'paint-standard': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { painted: 0 });
      const block = contraption.blocks.find(item => (
        blockOwnerId(contraption, item) === nodeId
        && (item.size || 1) >= 1
        && blockInCell(item, cell)
      ));
      if (!block) return actionResult(command.action, 0, 'not_found', { painted: 0 });
      block.color = resolveColor(command.options ?? command.color, normalizeColor(block.color));
      if (command.options?.materialId !== undefined) {
        block.materialId = commandMaterialId(command.options);
      }
      finishEntityMutation(context, contraption, 'color', nodeId, entityMutationEvent(command, {
        cell: [cell.x, cell.y, cell.z],
        size: block.size || 1,
        block: block.block,
        color: block.color,
        materialId: normalizeVoxelMaterialId(block.materialId)
      }));
      return actionResult(command.action, 1, 'painted', {
        painted: 1,
        color: block.color,
        materialId: normalizeVoxelMaterialId(block.materialId)
      });
    }
    case 'place-micro': {
      if (!micro) return actionResult(command.action, 0, 'invalid_position', { placed: 0 });
      const localX = micro.x / MICRO_DIVISIONS;
      const localY = micro.y / MICRO_DIVISIONS;
      const localZ = micro.z / MICRO_DIVISIONS;
      const parent = finiteCell([localX, localY, localZ])!;
      const standardOccupied = contraption.blocks.some(block => (block.size || 1) >= 1 && blockInCell(block, parent));
      const microOccupied = contraption.blocks.some(block => (
        (block.size || 1) < 1
        && Math.abs(block.localX - localX) < 1e-3
        && Math.abs(block.localY - localY) < 1e-3
        && Math.abs(block.localZ - localZ) < 1e-3
      ));
      if (standardOccupied || microOccupied) {
        return actionResult(command.action, 0, 'occupied', { placed: 0 });
      }
      // A micro voxel extends the entity AABB through its parent standard cell.
      if (!entityAABBAllows(contraption, parent.x, parent.y, parent.z)) {
        return actionResult(command.action, 0, 'bounds_exceeded', { placed: 0 });
      }
      const placedBlock = {
        localX,
        localY,
        localZ,
        size: MICRO_SIZE,
        color: entityNodeColor(contraption, nodeId, command.options ?? command.color),
        materialId: commandMaterialId(command.options),
        block: command.block || BlockTypes.COLOR_BLOCK,
        entityId: nodeId,
        ...(command.part ? { part: command.part } : {})
      };
      contraption.blocks.push(placedBlock);
      finishEntityMutation(context, contraption, 'place', nodeId, entityMutationEvent(command, {
        cell: [parent.x, parent.y, parent.z],
        microOffset: [
          ((micro.x % MICRO_DIVISIONS) + MICRO_DIVISIONS) % MICRO_DIVISIONS,
          ((micro.y % MICRO_DIVISIONS) + MICRO_DIVISIONS) % MICRO_DIVISIONS,
          ((micro.z % MICRO_DIVISIONS) + MICRO_DIVISIONS) % MICRO_DIVISIONS
        ],
        size: MICRO_SIZE,
        block: placedBlock.block,
        color: placedBlock.color,
        materialId: placedBlock.materialId
      }));
      return actionResult(command.action, 1, 'placed', { placed: 1, empty: false });
    }
    case 'remove-micro':
    case 'paint-micro': {
      if (!micro) {
        const field = command.action === 'paint-micro' ? 'painted' : 'removed';
        return actionResult(command.action, 0, 'invalid_position', { [field]: 0 });
      }
      const localX = micro.x / MICRO_DIVISIONS;
      const localY = micro.y / MICRO_DIVISIONS;
      const localZ = micro.z / MICRO_DIVISIONS;
      const index = contraption.blocks.findIndex(block => (
        blockOwnerId(contraption, block) === nodeId
        && (block.size || 1) < 1
        && Math.abs(block.localX - localX) < 1e-3
        && Math.abs(block.localY - localY) < 1e-3
        && Math.abs(block.localZ - localZ) < 1e-3
      ));
      if (index < 0) {
        const field = command.action === 'paint-micro' ? 'painted' : 'removed';
        return actionResult(command.action, 0, 'not_found', { [field]: 0 });
      }
      if (command.action === 'paint-micro') {
        const block = contraption.blocks[index];
        block.color = resolveColor(command.options ?? command.color, normalizeColor(block.color));
        if (command.options?.materialId !== undefined) {
          block.materialId = commandMaterialId(command.options);
        }
        finishEntityMutation(context, contraption, 'color', nodeId, entityMutationEvent(command, {
          cell: [Math.floor(localX), Math.floor(localY), Math.floor(localZ)],
          microOffset: [
            ((micro.x % MICRO_DIVISIONS) + MICRO_DIVISIONS) % MICRO_DIVISIONS,
            ((micro.y % MICRO_DIVISIONS) + MICRO_DIVISIONS) % MICRO_DIVISIONS,
            ((micro.z % MICRO_DIVISIONS) + MICRO_DIVISIONS) % MICRO_DIVISIONS
          ],
          size: MICRO_SIZE,
          block: block.block,
          color: block.color,
          materialId: normalizeVoxelMaterialId(block.materialId)
        }));
        return actionResult(command.action, 1, 'painted', {
          painted: 1,
          color: block.color,
          materialId: normalizeVoxelMaterialId(block.materialId)
        });
      }
      const removedBlock = contraption.blocks[index];
      contraption.blocks.splice(index, 1);
      const empty = finishEntityMutation(context, contraption, 'remove', nodeId, entityMutationEvent(command, {
        cell: [Math.floor(localX), Math.floor(localY), Math.floor(localZ)],
        microOffset: [
          ((micro.x % MICRO_DIVISIONS) + MICRO_DIVISIONS) % MICRO_DIVISIONS,
          ((micro.y % MICRO_DIVISIONS) + MICRO_DIVISIONS) % MICRO_DIVISIONS,
          ((micro.z % MICRO_DIVISIONS) + MICRO_DIVISIONS) % MICRO_DIVISIONS
        ],
        size: MICRO_SIZE,
        block: removedBlock.block,
        color: removedBlock.color
      }));
      return actionResult(command.action, 1, 'removed', { removed: 1, empty });
    }
    case 'clear-cell': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { removed: 0 });
      const removedBlocks = contraption.blocks.filter(block => (
        blockOwnerId(contraption, block) === nodeId
        && blockInCell(block, cell)
        && (!command.microOnly || (block.size || 1) < 1)
      ));
      const before = contraption.blocks.length;
      contraption.blocks = contraption.blocks.filter(block => {
        if (blockOwnerId(contraption, block) !== nodeId || !blockInCell(block, cell)) return true;
        if (command.microOnly && (block.size || 1) >= 1) return true;
        return false;
      });
      const removed = before - contraption.blocks.length;
      if (!removed) return actionResult(command.action, 0, 'not_found', { removed: 0 });
      const empty = finishEntityMutation(context, contraption, 'remove', nodeId, entityMutationEvent(command, {
        cell: [cell.x, cell.y, cell.z],
        cells: removedBlocks.slice(0, 64).map(block => [block.localX, block.localY, block.localZ]),
        truncated: removedBlocks.length > 64
      }));
      return actionResult(command.action, removed, 'removed', { removed, empty });
    }
    case 'subdivide-standard': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { subdivided: 0, removed: 0 });
      const index = contraption.blocks.findIndex(block => (
        blockOwnerId(contraption, block) === nodeId
        && (block.size || 1) >= 1
        && blockInCell(block, cell)
      ));
      if (index < 0) return actionResult(command.action, 0, 'not_found', { subdivided: 0, removed: 0 });
      const original = contraption.blocks[index];
      contraption.blocks.splice(index, 1);
      for (let ix = 0; ix < MICRO_DIVISIONS; ix++) {
        for (let iy = 0; iy < MICRO_DIVISIONS; iy++) {
          for (let iz = 0; iz < MICRO_DIVISIONS; iz++) {
            contraption.blocks.push({
              localX: cell.x + ix * MICRO_SIZE,
              localY: cell.y + iy * MICRO_SIZE,
              localZ: cell.z + iz * MICRO_SIZE,
              size: MICRO_SIZE,
              color: original.color ?? DEFAULT_BLOCK_COLOR,
              materialId: normalizeVoxelMaterialId(original.materialId),
              block: original.block || BlockTypes.COLOR_BLOCK,
              entityId: original.entityId ?? nodeId,
              ...(original.part ? { part: original.part } : {})
            });
          }
        }
      }
      let removed = 0;
      if (micro) {
        const localX = micro.x / MICRO_DIVISIONS;
        const localY = micro.y / MICRO_DIVISIONS;
        const localZ = micro.z / MICRO_DIVISIONS;
        const carveIndex = contraption.blocks.findIndex(block => (
          blockOwnerId(contraption, block) === String(original.entityId ?? nodeId)
          && (block.size || 1) < 1
          && Math.abs(block.localX - localX) < 1e-3
          && Math.abs(block.localY - localY) < 1e-3
          && Math.abs(block.localZ - localZ) < 1e-3
        ));
        if (carveIndex >= 0) {
          contraption.blocks.splice(carveIndex, 1);
          removed = 1;
        }
      }
      finishEntityMutation(context, contraption, 'subdivide', String(original.entityId ?? nodeId), entityMutationEvent(command, {
        cell: [cell.x, cell.y, cell.z],
        microOffset: micro ? [
          ((micro.x % MICRO_DIVISIONS) + MICRO_DIVISIONS) % MICRO_DIVISIONS,
          ((micro.y % MICRO_DIVISIONS) + MICRO_DIVISIONS) % MICRO_DIVISIONS,
          ((micro.z % MICRO_DIVISIONS) + MICRO_DIVISIONS) % MICRO_DIVISIONS
        ] : null,
        size: MICRO_SIZE,
        block: original.block,
        color: original.color,
        materialId: normalizeVoxelMaterialId(original.materialId)
      }));
      return actionResult(command.action, MICRO_CELLS_PER_BLOCK, 'subdivided', { subdivided: MICRO_CELLS_PER_BLOCK, removed, empty: false });
    }
    case 'subdivide-cells': {
      // Batched sibling of subdivide-standard: convert every standard block that
      // covers one of `cells` into its 512 micro voxels with a SINGLE entity
      // rebuild. A micro edit over N standard blocks would otherwise run the
      // collision/picking/chunk-mesh rebuild N times, which dominated Del/F/P.
      const list = Array.isArray(command.cells) ? command.cells : [];
      if (list.length === 0) return actionResult(command.action, 0, 'invalid_position', { subdivided: 0, removed: 0 });
      const sourceBlocks: RuntimeVoxel[] = [];
      for (const item of list) {
        const cell = finiteCell(item);
        if (!cell) continue;
        const block = contraption.blocks.find(candidate => (
          blockOwnerId(contraption, candidate) === nodeId
          && (candidate.size || 1) >= 1
          && blockInCell(candidate, cell)
        ));
        if (block && !sourceBlocks.includes(block)) sourceBlocks.push(block);
      }
      if (sourceBlocks.length === 0) return actionResult(command.action, 0, 'not_found', { subdivided: 0, removed: 0 });

      const sourceSet = new Set(sourceBlocks);
      const added: RuntimeVoxel[] = [];
      for (const original of sourceBlocks) {
        const baseX = Math.floor(original.localX + 1e-6);
        const baseY = Math.floor(original.localY + 1e-6);
        const baseZ = Math.floor(original.localZ + 1e-6);
        for (let ix = 0; ix < MICRO_DIVISIONS; ix++) {
          for (let iy = 0; iy < MICRO_DIVISIONS; iy++) {
            for (let iz = 0; iz < MICRO_DIVISIONS; iz++) {
              added.push({
                localX: baseX + ix * MICRO_SIZE,
                localY: baseY + iy * MICRO_SIZE,
                localZ: baseZ + iz * MICRO_SIZE,
                size: MICRO_SIZE,
                color: original.color ?? DEFAULT_BLOCK_COLOR,
                materialId: normalizeVoxelMaterialId(original.materialId),
                block: original.block || BlockTypes.COLOR_BLOCK,
                entityId: original.entityId ?? nodeId,
                ...(original.part ? { part: original.part } : {})
              });
            }
          }
        }
      }
      contraption.blocks = contraption.blocks.filter(block => !sourceSet.has(block)).concat(added);
      finishEntityMutation(context, contraption, 'subdivide', nodeId, entityMutationEvent(command, {
        cells: sourceBlocks.slice(0, 64).map(original => [
          Math.floor(original.localX + 1e-6),
          Math.floor(original.localY + 1e-6),
          Math.floor(original.localZ + 1e-6)
        ]),
        truncated: sourceBlocks.length > 64,
        size: MICRO_SIZE,
        block: sourceBlocks[0].block,
        color: sourceBlocks[0].color,
        materialId: normalizeVoxelMaterialId(sourceBlocks[0].materialId)
      }));
      const subdivided = sourceBlocks.length * MICRO_CELLS_PER_BLOCK;
      return actionResult(command.action, subdivided, 'subdivided', { subdivided, removed: 0, empty: false });
    }
    case 'fill-blocks': {
      const coords = Array.isArray(command.coords) ? command.coords : [];
      const color = resolveColor(command.options ?? command.color);
      const colors = Array.isArray(command.colors)
        ? command.colors.map((value: unknown) => resolveColor(value))
        : null;
      const materialId = commandMaterialId(command.options);
      const changesMaterial = command.options?.materialId !== undefined;
      const isMicro = command.micro === true;
      const blockSize = isMicro ? MICRO_SIZE : 1;
      let addedCount = 0;
      let recoloredCount = 0;
      const blockMap = new Map<string, RuntimeVoxel>();
      for (const b of contraption.blocks) {
        if (blockOwnerId(contraption, b) === nodeId) {
          const gx = isMicro ? Math.round(b.localX * MICRO_DIVISIONS) : Math.floor(b.localX + 1e-6);
          const gy = isMicro ? Math.round(b.localY * MICRO_DIVISIONS) : Math.floor(b.localY + 1e-6);
          const gz = isMicro ? Math.round(b.localZ * MICRO_DIVISIONS) : Math.floor(b.localZ + 1e-6);
          blockMap.set(`${gx},${gy},${gz}`, b);
        }
      }
      for (let index = 0; index < coords.length; index++) {
        const c = coords[index];
        const targetColor = colors?.[index] ?? color;
        const key = `${c.x},${c.y},${c.z}`;
        const existing = blockMap.get(key);
        if (existing) {
          if (existing.color !== targetColor
            || (changesMaterial && normalizeVoxelMaterialId(existing.materialId) !== materialId)) {
            existing.color = targetColor;
            if (changesMaterial) existing.materialId = materialId;
            recoloredCount++;
          }
        } else {
          const localX = isMicro ? c.x * MICRO_SIZE : c.x;
          const localY = isMicro ? c.y * MICRO_SIZE : c.y;
          const localZ = isMicro ? c.z * MICRO_SIZE : c.z;
          contraption.blocks.push({
            localX,
            localY,
            localZ,
            size: blockSize,
            color: targetColor,
            materialId,
            entityId: nodeId
          });
          addedCount++;
        }
      }
      if (addedCount > 0 || recoloredCount > 0) {
        finishEntityMutation(context, contraption, addedCount > 0 ? 'place' : 'color', nodeId, entityMutationEvent(command, {
          color,
          materialId
        }));
      }
      return actionResult(command.action, addedCount + recoloredCount, 'filled', { added: addedCount, recolored: recoloredCount, color });
    }
    case 'paint-blocks': {
      const selectedBlocks = Array.isArray(command.blocks) ? command.blocks : [];
      if (selectedBlocks.length === 0) return actionResult(command.action, 0, 'not_found', { painted: 0 });
      const color = resolveColor(command.options ?? command.color);
      const colors = Array.isArray(command.colors)
        ? command.colors.map((value: unknown) => resolveColor(value))
        : null;
      const changesMaterial = command.options?.materialId !== undefined;
      const materialId = commandMaterialId(command.options);
      let painted = 0;
      for (let index = 0; index < selectedBlocks.length; index++) {
        const block = selectedBlocks[index];
        block.color = colors?.[index] ?? color;
        if (changesMaterial) block.materialId = materialId;
        painted++;
      }
      if (painted > 0) {
        finishEntityMutation(context, contraption, 'color', nodeId, entityMutationEvent(command, {
          color,
          ...(changesMaterial ? { materialId } : {})
        }));
      }
      return actionResult(command.action, painted, painted ? 'painted' : 'not_found', {
        painted,
        color,
        ...(changesMaterial ? { materialId } : {})
      });
    }
    case 'remove-blocks': {
      const selectedBlocks = Array.isArray(command.blocks) ? command.blocks : [];
      const selected = new Set(selectedBlocks);
      if (selected.size === 0) return actionResult(command.action, 0, 'not_found', { removed: 0 });
      // Virtual selections refer to cells inside live standard blocks. Carve
      // them directly so collision, picking, meshes and observers see only the
      // final result, never an intermediate 512-cell subdivision.
      const liveBlocks = new Set(contraption.blocks);
      const carved = new Map<RuntimeVoxel, Set<number>>();
      for (const block of selectedBlocks) {
        const source = block.sourceBlock;
        if (!block.virtualMicro || !liveBlocks.has(source) || (source.size || 1) < 1
          || blockOwnerId(contraption, source) !== nodeId) continue;
        const x = Math.round((block.localX - Math.floor(source.localX + 1e-6)) * MICRO_DIVISIONS);
        const y = Math.round((block.localY - Math.floor(source.localY + 1e-6)) * MICRO_DIVISIONS);
        const z = Math.round((block.localZ - Math.floor(source.localZ + 1e-6)) * MICRO_DIVISIONS);
        if (![x, y, z].every(v => Number.isInteger(v) && v >= 0 && v < MICRO_DIVISIONS)) continue;
        let cells = carved.get(source);
        if (!cells) carved.set(source, cells = new Set());
        cells.add((x * MICRO_DIVISIONS + y) * MICRO_DIVISIONS + z);
      }
      const next: RuntimeVoxel[] = [];
      const added: RuntimeVoxel[] = [];
      const removedBlocks: RuntimeVoxel[] = [];
      let removed = 0;
      for (const original of contraption.blocks) {
        if (selected.has(original) && blockOwnerId(contraption, original) === nodeId) {
          removedBlocks.push(original);
          removed++;
          continue;
        }
        const cells = carved.get(original);
        if (!cells) { next.push(original); continue; }
        removedBlocks.push(original);
        removed += cells.size;
        if (cells.size === MICRO_CELLS_PER_BLOCK) continue;
        const base = blockCell(original);
        for (let x = 0; x < MICRO_DIVISIONS; x++) {
          for (let y = 0; y < MICRO_DIVISIONS; y++) {
            for (let z = 0; z < MICRO_DIVISIONS; z++) {
              if (cells.has((x * MICRO_DIVISIONS + y) * MICRO_DIVISIONS + z)) continue;
              const survivor = {
                localX: base.x + x * MICRO_SIZE,
                localY: base.y + y * MICRO_SIZE,
                localZ: base.z + z * MICRO_SIZE,
                size: MICRO_SIZE,
                color: original.color ?? DEFAULT_BLOCK_COLOR,
                materialId: normalizeVoxelMaterialId(original.materialId),
                block: original.block || BlockTypes.COLOR_BLOCK,
                entityId: original.entityId ?? nodeId,
                ...(original.part ? { part: original.part } : {})
              };
              next.push(survivor);
              added.push(survivor);
            }
          }
        }
      }
      if (!removed) return actionResult(command.action, 0, 'not_found', { removed: 0 });
      contraption.blocks = next;
      const empty = finishEntityMutation(context, contraption, 'remove', nodeId, entityMutationEvent(command, {
        cells: selectedBlocks.slice(0, 64).map((block: RuntimeVoxel) => [block.localX, block.localY, block.localZ]),
        truncated: selectedBlocks.length > 64
      }), { added, removed: removedBlocks });
      return actionResult(command.action, removed, 'removed', { removed, empty });
    }
    case 'remove-subtree': {
      if (!contraption.entityNodes?.has(nodeId)) {
        return actionResult(command.action, 0, 'component_not_found', {
          removed: 0,
          standard: 0,
          micro: 0,
          entities: 0,
          components: 0
        });
      }
      const nodeIds = contraption.collectSubtreeNodeIds?.(nodeId) || new Set([nodeId]);
      const removedBlocks = contraption.blocks.filter(block => nodeIds.has(blockOwnerId(contraption, block)));
      const standard = removedBlocks.filter(block => (block.size || 1) >= 1).length;
      const micro = removedBlocks.length - standard;
      const manager = context?.manager || contraption.actionContext?.manager;
      const removesWholeEntity = nodeId === entityRootId(contraption) || removedBlocks.length === contraption.blocks.length;

      if (removesWholeEntity) {
        if (!manager?.contraptions?.includes(contraption)) {
          return actionResult(command.action, 0, 'entity_unmanaged', {
            removed: 0,
            standard: 0,
            micro: 0,
            entities: 0,
            components: 0
          });
        }
        const entityId = contraption.publicId ?? null;
        const runtimeId = contraption.id ?? null;
        manager.removeContraption?.(contraption);
        return actionResult(command.action, Math.max(1, removedBlocks.length), 'entity_removed', {
          removed: removedBlocks.length,
          standard,
          micro,
          entities: 1,
          components: nodeIds.size,
          entityId,
          runtimeId,
          nodeId,
          empty: true
        });
      }

      const result = contraption.removeComponentSubtree?.(nodeId);
      if (!result) {
        return actionResult(command.action, 0, 'component_not_found', {
          removed: 0,
          standard: 0,
          micro: 0,
          entities: 0,
          components: 0
        });
      }
      return actionResult(command.action, Math.max(1, result.removed + result.components), 'subtree_removed', {
        ...result,
        entities: 0,
        entityId: contraption.publicId ?? null,
        runtimeId: contraption.id ?? null,
        empty: false
      });
    }
    case 'start-scripts': {
      if (contraption.isWrenchGrabbed || context?.manager?.controller?.wrenchGrab?.contraption === contraption) {
        return actionResult(command.action, 0, 'wrench_grabbed', { status: 'stopped', physicsEnabled: false });
      }
      const hasRunnableCode = !!contraption.compiledScript || (contraption.compiledNodeScripts?.size || 0) > 0;
      if (!hasRunnableCode) {
        if (contraption.isPhysicsSimulationEnabled?.() === false) {
          contraption.enableAllNodeScripts?.();
          invalidateInternalEntitySelections(context, contraption);
          return actionResult(command.action, 1, 'started', {
            status: contraption.scriptStatus || 'stopped',
            physicsEnabled: true
          });
        }
        return actionResult(command.action, 0, 'no_scripts', { status: contraption.scriptStatus || 'stopped' });
      }
      contraption.enableAllNodeScripts?.();
      invalidateInternalEntitySelections(context, contraption);
      return actionResult(command.action, 1, 'started', {
        status: contraption.scriptStatus || 'running',
        physicsEnabled: contraption.isPhysicsSimulationEnabled?.() !== false
      });
    }
    case 'stop-scripts': {
      if (contraption.scriptStatus === 'stopped' && contraption.isPhysicsSimulationEnabled?.() === false) {
        return actionResult(command.action, 0, 'already_stopped', { status: 'stopped', physicsEnabled: false });
      }
      contraption.stopAllNodeScripts?.();
      return actionResult(command.action, 1, 'stopped', {
        status: contraption.scriptStatus || 'stopped',
        physicsEnabled: contraption.isPhysicsSimulationEnabled?.() !== false
      });
    }
    case 'toggle-scripts': {
      const nextAction = contraption.isPhysicsSimulationEnabled?.() === false
        ? 'start-scripts'
        : 'stop-scripts';
      const result = executeEntityAction(context, { ...command, action: nextAction });
      return { ...result, action: command.action };
    }
    case 'disassemble': {
      if (contraption.scriptStatus !== 'stopped') {
        contraption.stopAllNodeScripts?.();
      }
      const changed = context?.manager?.disassembleContraption?.(contraption) ? 1 : 0;
      return actionResult(command.action, changed, changed ? 'disassembled' : 'not_found', { disassembled: changed });
    }
    default:
      return actionResult(command.action, 0, 'unsupported_action');
  }
}
