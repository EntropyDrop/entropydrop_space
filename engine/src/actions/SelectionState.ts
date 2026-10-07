import type { Contraption } from '../contraption/Contraption.ts';
import type { BasicActionContext, ActionSelectionHost, EntityActionSelection, ActionManager } from './ActionContracts.ts';
import { entityRootId, requestedNodeId } from './ActionValues.ts';

export function clearEntitySelection(managerOrOwner: ActionSelectionHost | null | undefined) {
  if (!managerOrOwner) return;
  managerOrOwner.entitySelection?.contraption?.clearSubtreeHighlight?.();
  managerOrOwner.entitySelection = null;
  managerOrOwner.selectedSubtree?.contraption?.clearSubtreeHighlight?.();
  managerOrOwner.selectedSubtree = null;
  managerOrOwner.selectedBlockSelection?.contraption?.clearSubtreeHighlight?.();
  managerOrOwner.selectedBlockSelection = null;
}

export function canEditInternalSelection(contraption: Contraption) {
  return !!contraption && (typeof contraption.canEditInternalSelection === 'function'
    ? contraption.canEditInternalSelection()
    : contraption.scriptStatus === 'stopped');
}

export function isInternalEntitySelection(selection: EntityActionSelection | null | undefined, contraption: Contraption) {
  if (!selection || selection.contraption !== contraption) return false;
  if (selection.kind === 'entity-blocks' || Array.isArray(selection.blocks)) return true;
  return requestedNodeId(contraption, selection.nodeId, selection.rootId) !== entityRootId(contraption);
}

export function invalidateInternalEntitySelections(context: BasicActionContext, contraption: Contraption) {
  const owners = new Set([
    context?.selectionHost,
    context?.manager,
    contraption?.actionContext?.manager
  ].filter(Boolean));

  for (const owner of owners) {
    if (!owner) continue;
    const hasInternalSelection = isInternalEntitySelection(owner.entitySelection, contraption)
      || owner.childSelection?.contraption === contraption
      || owner.selectedBlockSelection?.contraption === contraption
      || (owner.selectedSubtree?.contraption === contraption
        && requestedNodeId(contraption, owner.selectedSubtree.rootId) !== entityRootId(contraption))
      || owner.selectorLevel?.contraption === contraption
      || owner.selectorRange?.contraption === contraption;
    if (!hasInternalSelection) continue;

    contraption.clearSubtreeHighlight?.();
    contraption.clearGlueSelection?.();
    if (owner.entitySelection?.contraption === contraption) owner.entitySelection = null;
    if (owner.childSelection?.contraption === contraption) owner.childSelection = null;
    if (owner.selectedBlockSelection?.contraption === contraption) owner.selectedBlockSelection = null;
    if (owner.selectedSubtree?.contraption === contraption) owner.selectedSubtree = null;
    if (owner.selectorLevel?.contraption === contraption) owner.selectorLevel = null;
    if (owner.selectorRange?.contraption === contraption) owner.selectorRange = null;
  }
}

export function selectionSnapshot(manager: ActionManager | null | undefined) {
  let entity = manager?.entitySelection;
  if (entity && isInternalEntitySelection(entity, entity.contraption)
    && !canEditInternalSelection(entity.contraption)) {
    clearEntitySelection(manager);
    entity = null;
  }
  if (entity) {
    return {
      kind: entity.kind,
      entityId: entity.contraption?.publicId ?? null,
      runtimeId: entity.contraption?.id ?? null,
      nodeId: requestedNodeId(entity.contraption, entity.nodeId, entity.rootId),
      count: entity.kind === 'entity-blocks' ? (entity.blocks?.length || 0) : entity.nodeIds?.size || 0,
      ready: true
    };
  }
  const info = manager?.getWorldGlueSelectionInfo?.() || { mode: 'box', pointCount: 0, count: 0, ready: false };
  const bounds = manager?.getSelectionBounds?.() || null;
  return {
    kind: info.mode === 'single' ? 'world-cells' : 'world-box',
    ...info,
    bounds: bounds ? { ...bounds } : null
  };
}
