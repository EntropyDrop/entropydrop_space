import { MICRO_SIZE } from '../voxel/MicroGrid.ts';
import { mergeCollisionBoxes, type CollisionBox } from './CollisionGeometry.ts';

/**
 * Decorations collide as their footprint on the 0.125 m construction grid.
 * They carry no mass: only voxels contribute to mass, inertia and centre of mass.
 *
 * Axis-aligned cubes (rotations by quarter turns) become one box whose faces
 * round to the nearest grid plane, at least one cell thick. For a rotated cube
 * a micro cell belongs to the footprint when its centre lies inside the cube,
 * with each half extent raised to at least half a cell so thin panels stay
 * closed. Rotated cubes are scanned as runs along their longest axis; a cube that
 * would need more than `columnBudget` runs is sampled on a coarser grid of
 * 2, 4, 8 ... cells, which keeps any decoration bounded.
 */
export const DECORATION_COLLISION_COLUMN_BUDGET = 4096;
/** Runs shared by all rotated decorations of one entity or terrain chunk. */
export const DECORATION_COLLISION_SHARED_BUDGET = 65536;
export const DECORATION_COLLISION_MIN_BUDGET = 256;

export interface DecorationShape {
  position?: readonly number[];
  rotation?: readonly number[];
  scale?: readonly number[];
}

type Axes = [number[], number[], number[]];
const EPSILON = 1e-9;

function shapeAxes(rotation: readonly number[] | undefined): Axes {
  const [x, y, z, w] = rotation ?? [0, 0, 0, 1];
  const length = Math.hypot(x, y, z, w) || 1;
  const qx = x / length, qy = y / length, qz = z / length, qw = w / length;
  // Columns of the rotation matrix: the cube's local X, Y and Z axes.
  return [
    [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw)],
    [2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw)],
    [2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy)],
  ];
}

/** Each local axis lies on a world axis, so the cube is a grid-aligned box. */
function axisPermutation(axes: Axes): number[] | null {
  const mapping: number[] = [];
  for (const axis of axes) {
    const index = axis.findIndex(component => Math.abs(component) > 1 - 1e-9);
    if (index < 0 || mapping.includes(index)) return null;
    mapping.push(index);
  }
  return mapping;
}

/** Cells whose centre (index + 0.5) * size lies in [low, high]. Adding 0 turns -0 into 0. */
function cellRange(low: number, high: number, size: number) {
  return [Math.ceil(low / size - 0.5 - EPSILON) + 0, Math.floor(high / size - 0.5 + EPSILON) + 0];
}

function halfExtents(shape: DecorationShape, grid: number) {
  const scale = shape.scale ?? [1, 1, 1];
  return [0, 1, 2].map(axis => Math.max(scale[axis] / 2, grid * MICRO_SIZE / 2));
}

function worldCellCounts(shape: DecorationShape, axes: Axes, grid: number) {
  const center = shape.position ?? [0, 0, 0];
  const half = halfExtents(shape, grid);
  const size = grid * MICRO_SIZE;
  return [0, 1, 2].map(world => {
    const extent = half[0] * Math.abs(axes[0][world]) + half[1] * Math.abs(axes[1][world]) + half[2] * Math.abs(axes[2][world]);
    const [low, high] = cellRange(center[world] - extent, center[world] + extent, size);
    return Math.max(0, high - low + 1);
  });
}

/**
 * Collision boxes of one decoration in integer micro-cell coordinates of the
 * frame its `position` is expressed in (an entity's construction frame, or
 * world space for terrain decorations).
 */
export function voxelizeDecoration(shape: DecorationShape, entityId: string,
  columnBudget = DECORATION_COLLISION_COLUMN_BUDGET): CollisionBox[] {
  const center = shape.position ?? [0, 0, 0];
  const axes = shapeAxes(shape.rotation);
  const permutation = axisPermutation(axes);
  if (permutation) {
    // Each face rounds to the nearest grid plane (ties downward). A cube
    // thinner than one cell keeps the single cell holding its centre.
    const scale = shape.scale ?? [1, 1, 1];
    const extent = [0, 0, 0];
    permutation.forEach((world, local) => { extent[world] = scale[local] / 2; });
    const ranges = [0, 1, 2].map(axis => {
      const low = Math.ceil((center[axis] - extent[axis]) / MICRO_SIZE - 0.5 - EPSILON) + 0;
      const high = Math.ceil((center[axis] + extent[axis]) / MICRO_SIZE - 0.5 - EPSILON) - 1;
      if (high >= low) return [low, high];
      const cell = Math.floor(center[axis] / MICRO_SIZE + EPSILON) + 0;
      return [cell, cell];
    });
    return [{ x: ranges[0][0], y: ranges[1][0], z: ranges[2][0],
      spanX: ranges[0][1] - ranges[0][0] + 1, spanY: ranges[1][1] - ranges[1][0] + 1,
      spanZ: ranges[2][1] - ranges[2][0] + 1, entityId }];
  }

  // Coarsen in powers of two until the scan plane fits the budget.
  let grid = 1;
  let counts = worldCellCounts(shape, axes, grid);
  const budget = Math.max(1, Math.floor(columnBudget));
  const scanColumns = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[0] * sorted[1];
  };
  while (scanColumns(counts) > budget) {
    grid *= 2;
    counts = worldCellCounts(shape, axes, grid);
  }
  const size = grid * MICRO_SIZE;
  const half = halfExtents(shape, grid);
  // Run along the longest world axis; scan the other two.
  const run = counts.indexOf(Math.max(...counts));
  const [scanA, scanB] = [0, 1, 2].filter(axis => axis !== run);
  const extentOf = (world: number) => half[0] * Math.abs(axes[0][world])
    + half[1] * Math.abs(axes[1][world]) + half[2] * Math.abs(axes[2][world]);
  const [a0, a1] = cellRange(center[scanA] - extentOf(scanA), center[scanA] + extentOf(scanA), size);
  const [b0, b1] = cellRange(center[scanB] - extentOf(scanB), center[scanB] + extentOf(scanB), size);
  const boxes: CollisionBox[] = [];
  for (let a = a0; a <= a1; a++) {
    const offsetA = (a + 0.5) * size - center[scanA];
    for (let b = b0; b <= b1; b++) {
      const offsetB = (b + 0.5) * size - center[scanB];
      // Each slab |dot(p - c, axis)| <= half bounds the run coordinate.
      let low = -Infinity, high = Infinity;
      for (let k = 0; k < 3; k++) {
        const slope = axes[k][run];
        const offset = axes[k][scanA] * offsetA + axes[k][scanB] * offsetB;
        if (Math.abs(slope) < 1e-12) {
          if (Math.abs(offset) > half[k] + EPSILON) { low = Infinity; break; }
          continue;
        }
        const first = (-half[k] - offset) / slope, second = (half[k] - offset) / slope;
        low = Math.max(low, Math.min(first, second));
        high = Math.min(high, Math.max(first, second));
      }
      if (!(low <= high)) continue;
      const [r0, r1] = cellRange(center[run] + low, center[run] + high, size);
      if (r1 < r0) continue;
      const cell = [0, 0, 0], span = [grid, grid, grid];
      cell[scanA] = a * grid + 0; cell[scanB] = b * grid + 0; cell[run] = r0 * grid + 0;
      span[run] = (r1 - r0 + 1) * grid;
      boxes.push({ x: cell[0], y: cell[1], z: cell[2], spanX: span[0], spanY: span[1], spanZ: span[2], entityId });
    }
  }
  return mergeCollisionBoxes(boxes);
}

/** Per-decoration run budget when `rotatedCount` rotated cubes share one owner. */
export function decorationColumnBudget(rotatedCount: number) {
  if (rotatedCount <= 0) return DECORATION_COLLISION_COLUMN_BUDGET;
  return Math.max(DECORATION_COLLISION_MIN_BUDGET, Math.min(DECORATION_COLLISION_COLUMN_BUDGET,
    Math.floor(DECORATION_COLLISION_SHARED_BUDGET / rotatedCount)));
}

export function isRotatedDecoration(shape: DecorationShape) {
  return !axisPermutation(shapeAxes(shape.rotation));
}

/** Footprints of every decoration one owner holds, in the given order. */
export function voxelizeDecorations(shapes: readonly DecorationShape[], entityId: string): CollisionBox[] {
  const budget = decorationColumnBudget(shapes.filter(isRotatedDecoration).length);
  return shapes.flatMap(shape => voxelizeDecoration(shape, entityId, budget));
}

/** Split boxes so no span exceeds `maxSpan`; terrain contact probes and
 * culling assume bounded boxes, like merged voxel terrain boxes. Pieces
 * enclosed by the rest of their box are dropped, as enclosed voxels are. */
export function splitCollisionBoxes(boxes: readonly CollisionBox[], maxSpan: number): CollisionBox[] {
  const result: CollisionBox[] = [];
  for (const box of boxes) {
    if (box.spanX <= maxSpan && box.spanY <= maxSpan && box.spanZ <= maxSpan) {
      result.push(box);
      continue;
    }
    const outer = (offset: number, span: number) => offset === 0 || offset + maxSpan >= span;
    for (let x = 0; x < box.spanX; x += maxSpan) {
      for (let y = 0; y < box.spanY; y += maxSpan) {
        for (let z = 0; z < box.spanZ; z += maxSpan) {
          if (!outer(x, box.spanX) && !outer(y, box.spanY) && !outer(z, box.spanZ)) continue;
          result.push({ x: box.x + x, y: box.y + y, z: box.z + z,
            spanX: Math.min(maxSpan, box.spanX - x), spanY: Math.min(maxSpan, box.spanY - y),
            spanZ: Math.min(maxSpan, box.spanZ - z), entityId: box.entityId });
        }
      }
    }
  }
  return result;
}
