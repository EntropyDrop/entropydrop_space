import type { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import type { RuntimeVoxel } from '@entropydrop/space-engine/contraption/EntityTypes.ts';
import type { CollisionBounds } from '@entropydrop/space-engine/physics/CollisionGeometry.ts';
import type { Point3, SelectionGizmoHandle } from '../render/PreviewTypes.ts';

export interface ComponentSelection { contraption: Contraption; nodeId: string }
export interface ComponentRange extends ComponentSelection {
  pointA: Point3 | null; pointB: Point3 | null;
  allComponents?: boolean; gradientEligible?: boolean;
}
export interface SelectedVoxel extends RuntimeVoxel { virtualMicro?: boolean; sourceBlock?: RuntimeVoxel }
export interface ComponentBlockSelection extends ComponentSelection {
  confirmedRange?: { pointA: Point3; pointB: Point3 }; shapeCells?: Point3[] | null;
  blocks: SelectedVoxel[]; micro?: boolean; virtualMicro?: boolean;
  bounds?: CollisionBounds | null; gradientEligible?: boolean; allComponents?: boolean;
}
export interface SubtreeSelection { contraption: Contraption; rootId: string; nodeIds: Set<string> }

export interface BrushSelection extends ComponentSelection {
  pointA: Point3 | null;
  rawWorldA: Point3;
  micro: boolean;
}
export interface SelectionGizmoDrag extends SelectionGizmoHandle {
  isMicro: boolean;
  isEntity: boolean;
  accumulatedDelta: number;
  startX: number; startY: number;
  lastX: number; lastY: number;
}
