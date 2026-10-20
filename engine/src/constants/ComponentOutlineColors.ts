import { MAX_ENTITY_HIERARCHY_DEPTH } from './SpaceConstants.ts';

/** Alternate white and black at each hierarchy level, starting with a white root. */
export const COMPONENT_OUTLINE_COLORS: readonly number[] = Object.freeze(
  Array.from({ length: MAX_ENTITY_HIERARCHY_DEPTH }, (_, depth) => depth % 2 === 0 ? 0xffffff : 0x000000),
);

type ComponentParents = ReadonlyMap<string, { parentId: string | null }>;

/** Absolute depth keeps colors stable when focus moves into a subtree. */
export function componentOutlineDepth(nodes: ComponentParents | null | undefined, nodeId: string): number {
  let node = nodes?.get(nodeId);
  let depth = 0;
  while (node?.parentId && depth < MAX_ENTITY_HIERARCHY_DEPTH) {
    depth++;
    node = nodes?.get(node.parentId);
  }
  return depth;
}

export function componentOutlineColor(nodes: ComponentParents | null | undefined, nodeId: string): number {
  return COMPONENT_OUTLINE_COLORS[componentOutlineDepth(nodes, nodeId) % COMPONENT_OUTLINE_COLORS.length];
}
