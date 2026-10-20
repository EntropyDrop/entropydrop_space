import { MAX_INVENTORY_BLOCKS } from '@entropydrop/space-engine/constants/SpaceConstants.ts';
import type { InventoryInput, InventoryVoxel } from '@entropydrop/space-engine/storage/InventoryTypes.ts';
import { MICRO_DIVISIONS, MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';

function microVoxelCount(slot: InventoryInput): number {
  if (slot.kind === 'item') {
    return (slot.blockSet ? microVoxelCount(slot.blockSet) : 0)
      + (slot.entityList || []).reduce((total, entity) => total + microVoxelCount(entity), 0);
  }
  return (slot.blocks || []).reduce((total, block) => total + ((block.size || 1) < 1 ? 1 : MICRO_DIVISIONS ** 3), 0);
}

function convertSlot<T extends InventoryInput>(slot: T): T {
  if (slot.kind === 'item') {
    const blockSet = slot.blockSet && convertSlot(slot.blockSet);
    const entityList = (slot.entityList || []).map(convertSlot);
    if (blockSet === slot.blockSet && entityList.every((entity, index) => entity === slot.entityList?.[index])) return slot;
    const blocks = [...(blockSet?.blocks || []), ...entityList.flatMap(entity => entity.blocks)];
    return { ...slot, blockSet, entityList, blocks, blockCount: blocks.length };
  }
  if (!slot.blocks?.some(block => (block.size || 1) >= 1)) return slot;

  const entity = slot.kind !== 'blockset';
  const keys = entity ? ['localX', 'localY', 'localZ'] as const : ['dx', 'dy', 'dz'] as const;
  // Resolve legacy constructor ownership before expanding its source cells.
  const owners = new Map<string, string>();
  if (entity) for (const child of slot.childEntities || []) {
    for (const key of child.blockKeys || []) owners.set(Array.isArray(key) ? key.join(',') : key, child.id);
  }
  const blocks: InventoryVoxel[] = [];
  for (const block of slot.blocks) {
    const minimum = keys.map(key => Number(block[key]) || 0);
    const owner = owners.get(minimum.map(value => Math.floor(value + 1e-6)).join(',')) || block.entityId || slot.rootComponentId;
    if ((block.size || 1) < 1) {
      blocks.push(entity && owner !== block.entityId ? { ...block, entityId: owner } : block);
      continue;
    }
    for (let x = 0; x < MICRO_DIVISIONS; x++) {
      for (let y = 0; y < MICRO_DIVISIONS; y++) {
        for (let z = 0; z < MICRO_DIVISIONS; z++) {
          blocks.push({
            ...block, size: MICRO_SIZE,
            [keys[0]]: minimum[0] + x * MICRO_SIZE,
            [keys[1]]: minimum[1] + y * MICRO_SIZE,
            [keys[2]]: minimum[2] + z * MICRO_SIZE,
            ...(entity ? { entityId: owner } : {}),
          });
        }
      }
    }
  }
  // Ownership now lives on every voxel; old coarse-cell keys must not reassign
  // a single micro voxel after conversion.
  const childEntities = slot.childEntities?.map(({ blockKeys: _keys, ...child }) => child);
  return { ...slot, blocks, blockCount: blocks.length, ...(childEntities ? { childEntities } : {}) };
}

/** Subdivide standard voxels without scaling geometry or mutating the backpack copy. */
export function toMicroPlacementItem<T extends InventoryInput>(slot: T): T {
  const count = microVoxelCount(slot);
  if (count > MAX_INVENTORY_BLOCKS) {
    throw new Error(`Micro construction exceeds the ${MAX_INVENTORY_BLOCKS.toLocaleString('en-US')} voxel limit (${count.toLocaleString('en-US')} after conversion)`);
  }
  return convertSlot(slot);
}
