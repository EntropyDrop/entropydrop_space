import { parseInventoryImport } from '../src/engine/inventory/InventoryImport.ts';
import { decodeInventoryResource } from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';
import type { InventoryEntity, InventoryBlockSet } from '@entropydrop/space-engine/storage/InventoryTypes.ts';

/** Compile-only contracts: removing result narrowing or erasing the codec's
 * return type to any makes the expected-error checks fail. Never executed. */
export function inventoryTypeContracts(bytes: Uint8Array): void {
  const parsed = parseInventoryImport(bytes, 'entity');
  // @ts-expect-error Failed imports do not provide an item.
  parsed.item.blocks;
  if (parsed.ok) {
    const entity: InventoryEntity = parsed.item;
    // @ts-expect-error An entity cannot be used as a block set.
    const blockSet: InventoryBlockSet = entity;
    void blockSet;
  }
  const decoded = decodeInventoryResource(bytes);
  // @ts-expect-error The category must be narrowed before accessing root.
  decoded.portable.root;
  if (decoded.category === 'entity') decoded.portable.root.children;
  const colors = decodeInventoryResource(bytes, 'colorset');
  colors.portable.entries;
  // @ts-expect-error Color sets cannot carry entity hierarchies.
  colors.portable.root;
}
