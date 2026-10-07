import type { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import type { DecorationDefinition } from '@entropydrop/space-engine/contraption/Decorations.ts';
import type { EntityRunStatus } from '../utils/entityNameplate.ts';

export interface EntityLabelView {
  entity: Contraption;
  name: string;
  status: EntityRunStatus;
  canControl: boolean;
  canEdit: boolean;
  executionMode: string | undefined;
  hostingCoreId: number | null;
}

export interface ModelingView {
  selection: {
    contraption: Contraption;
    componentId: string;
    decorationId?: string;
    componentName: string;
    value: DecorationDefinition;
  } | null;
  editable: boolean;
  canEdit: boolean;
  isDragging: boolean;
  canUndo: boolean;
  canRedo: boolean;
  creationDimensions: number[] | null;
}

/** Compare view data by value, but opaque engine instances strictly by identity. */
export function equalView(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length && left.every((value, index) => equalView(value, right[index]));
  }
  if (Object.getPrototypeOf(left) !== Object.prototype) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => {
    // These references are action targets, never data to recursively traverse.
    if (key === 'entity' || key === 'contraption') return a[key] === b[key];
    return Object.hasOwn(b, key) && equalView(a[key], b[key]);
  });
}

export function retainView<T>(previous: T, next: T): T {
  return equalView(previous, next) ? previous : next;
}

export const EMPTY_MODELING_VIEW: ModelingView = {
  selection: null, editable: false, canEdit: false, isDragging: false,
  canUndo: false, canRedo: false, creationDimensions: null,
};
