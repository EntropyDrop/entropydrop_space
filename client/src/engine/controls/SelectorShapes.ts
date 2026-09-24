export type SelectorShape = 'box' | 'cylinder' | 'sphere' | 'stairs' | 'line';

export interface VoxelPoint {
  x: number;
  y: number;
  z: number;
  micro?: boolean;
}

export type SelectorAxis = 'x' | 'y' | 'z';

/** Orientation of a stair-shaped selection inside its unchanged selection bounds. */
export interface StairsOrientation {
  runAxis: SelectorAxis;
  riseAxis: SelectorAxis;
  runDirection: 1 | -1;
  riseDirection: 1 | -1;
}

export const SELECTOR_SHAPES: { key: SelectorShape; label: string; nameEn: string; shortcut: number }[] = [
  { key: 'box', label: 'Box', nameEn: 'Box', shortcut: 1 },
  { key: 'cylinder', label: 'Cylinder', nameEn: 'Cylinder', shortcut: 2 },
  { key: 'sphere', label: 'Sphere', nameEn: 'Sphere', shortcut: 3 },
  { key: 'stairs', label: 'Stairs', nameEn: 'Stairs', shortcut: 4 },
  { key: 'line', label: 'Line', nameEn: 'Line', shortcut: 5 }
];

export function bresenham3D(
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number
): VoxelPoint[] {
  const points: VoxelPoint[] = [];
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const dz = Math.abs(z2 - z1);
  const sx = x2 >= x1 ? 1 : -1;
  const sy = y2 >= y1 ? 1 : -1;
  const sz = z2 >= z1 ? 1 : -1;

  let x = x1, y = y1, z = z1;

  if (dx >= dy && dx >= dz) {
    let p1 = 2 * dy - dx;
    let p2 = 2 * dz - dx;
    while (x !== x2) {
      points.push({ x, y, z });
      if (p1 >= 0) { y += sy; p1 -= 2 * dx; }
      if (p2 >= 0) { z += sz; p2 -= 2 * dx; }
      p1 += 2 * dy;
      p2 += 2 * dz;
      x += sx;
    }
  } else if (dy >= dx && dy >= dz) {
    let p1 = 2 * dx - dy;
    let p2 = 2 * dz - dy;
    while (y !== y2) {
      points.push({ x, y, z });
      if (p1 >= 0) { x += sx; p1 -= 2 * dy; }
      if (p2 >= 0) { z += sz; p2 -= 2 * dy; }
      p1 += 2 * dx;
      p2 += 2 * dz;
      y += sy;
    }
  } else {
    let p1 = 2 * dy - dz;
    let p2 = 2 * dx - dz;
    while (z !== z2) {
      points.push({ x, y, z });
      if (p1 >= 0) { y += sy; p1 -= 2 * dz; }
      if (p2 >= 0) { x += sx; p2 -= 2 * dz; }
      p1 += 2 * dy;
      p2 += 2 * dx;
      z += sz;
    }
  }
  points.push({ x: x2, y: y2, z: z2 });
  return points;
}

export function computeSelectionCells(
  shape: SelectorShape,
  pointA: { x: number; y: number; z: number },
  pointB: { x: number; y: number; z: number },
  isMicro = false,
  cylinderAxis: 'x' | 'y' | 'z' = 'y',
  stairsAxis?: 'x' | 'z',
  stairsOrientation?: StairsOrientation
): VoxelPoint[] {
  const minX = Math.min(pointA.x, pointB.x);
  const maxX = Math.max(pointA.x, pointB.x);
  const minY = Math.min(pointA.y, pointB.y);
  const maxY = Math.max(pointA.y, pointB.y);
  const minZ = Math.min(pointA.z, pointB.z);
  const maxZ = Math.max(pointA.z, pointB.z);

  const W = maxX - minX + 1;
  const H = maxY - minY + 1;
  const D = maxZ - minZ + 1;

  if (shape === 'line') {
    const points = bresenham3D(pointA.x, pointA.y, pointA.z, pointB.x, pointB.y, pointB.z);
    if (isMicro) {
      return points.map(p => ({ ...p, micro: true }));
    }
    return points;
  }

  const cells: VoxelPoint[] = [];

  if (shape === 'box') {
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          cells.push(isMicro ? { x, y, z, micro: true } : { x, y, z });
        }
      }
    }
    return cells;
  }

  if (shape === 'cylinder') {
    if (cylinderAxis === 'x') {
      const cy = (minY + maxY + 1) / 2;
      const cz = (minZ + maxZ + 1) / 2;
      const ry = H === 1 ? 0.51 : (H - 0.5) / 2;
      const rz = D === 1 ? 0.51 : (D - 0.5) / 2;

      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          const uy = (y + 0.5) - cy;
          for (let z = minZ; z <= maxZ; z++) {
            const uz = (z + 0.5) - cz;
            if ((uy / ry) ** 2 + (uz / rz) ** 2 <= 1.0 + 1e-5) {
              cells.push(isMicro ? { x, y, z, micro: true } : { x, y, z });
            }
          }
        }
      }
    } else if (cylinderAxis === 'z') {
      const cx = (minX + maxX + 1) / 2;
      const cy = (minY + maxY + 1) / 2;
      const rx = W === 1 ? 0.51 : (W - 0.5) / 2;
      const ry = H === 1 ? 0.51 : (H - 0.5) / 2;

      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          const ux = (x + 0.5) - cx;
          for (let y = minY; y <= maxY; y++) {
            const uy = (y + 0.5) - cy;
            if ((ux / rx) ** 2 + (uy / ry) ** 2 <= 1.0 + 1e-5) {
              cells.push(isMicro ? { x, y, z, micro: true } : { x, y, z });
            }
          }
        }
      }
    } else {
      // Default: along Y (vertical cylinder)
      const cx = (minX + maxX + 1) / 2;
      const cz = (minZ + maxZ + 1) / 2;
      const rx = W === 1 ? 0.51 : (W - 0.5) / 2;
      const rz = D === 1 ? 0.51 : (D - 0.5) / 2;

      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const ux = (x + 0.5) - cx;
          for (let z = minZ; z <= maxZ; z++) {
            const uz = (z + 0.5) - cz;
            if ((ux / rx) ** 2 + (uz / rz) ** 2 <= 1.0 + 1e-5) {
              cells.push(isMicro ? { x, y, z, micro: true } : { x, y, z });
            }
          }
        }
      }
    }
    return cells;
  }

  if (shape === 'sphere') {
    const cx = (minX + maxX + 1) / 2;
    const cy = (minY + maxY + 1) / 2;
    const cz = (minZ + maxZ + 1) / 2;
    const rx = W === 1 ? 0.51 : (W - 0.5) / 2;
    const ry = H === 1 ? 0.51 : (H - 0.5) / 2;
    const rz = D === 1 ? 0.51 : (D - 0.5) / 2;

    for (let y = minY; y <= maxY; y++) {
      const uy = (y + 0.5) - cy;
      for (let x = minX; x <= maxX; x++) {
        const ux = (x + 0.5) - cx;
        for (let z = minZ; z <= maxZ; z++) {
          const uz = (z + 0.5) - cz;
          if ((ux / rx) ** 2 + (uy / ry) ** 2 + (uz / rz) ** 2 <= 1.0 + 1e-5) {
            cells.push(isMicro ? { x, y, z, micro: true } : { x, y, z });
          }
        }
      }
    }
    return cells;
  }

  if (shape === 'stairs') {
    if (stairsOrientation && stairsOrientation.runAxis !== stairsOrientation.riseAxis) {
      const { runAxis, riseAxis, runDirection, riseDirection } = stairsOrientation;
      const axes: SelectorAxis[] = ['x', 'y', 'z'];
      const widthAxis = axes.find(axis => axis !== runAxis && axis !== riseAxis)!;
      const axisMin = { x: minX, y: minY, z: minZ };
      const axisMax = { x: maxX, y: maxY, z: maxZ };
      const runLength = axisMax[runAxis] - axisMin[runAxis] + 1;
      const riseLength = axisMax[riseAxis] - axisMin[riseAxis] + 1;

      for (let runStep = 0; runStep < runLength; runStep++) {
        const u = runLength === 1 ? 0 : runStep / (runLength - 1);
        const stepHeight = runLength === 1
          ? riseLength
          : (riseLength === 1 ? 1 : 1 + Math.floor(u * (riseLength - 1)));
        const run = runDirection > 0
          ? axisMin[runAxis] + runStep
          : axisMax[runAxis] - runStep;

        for (let riseStep = 0; riseStep < stepHeight; riseStep++) {
          const rise = riseDirection > 0
            ? axisMin[riseAxis] + riseStep
            : axisMax[riseAxis] - riseStep;
          for (let width = axisMin[widthAxis]; width <= axisMax[widthAxis]; width++) {
            const point = { x: 0, y: 0, z: 0 };
            point[runAxis] = run;
            point[riseAxis] = rise;
            point[widthAxis] = width;
            cells.push(isMicro ? { ...point, micro: true } : point);
          }
        }
      }
      return cells;
    }

    const dx = pointB.x - pointA.x;
    const dy = pointB.y - pointA.y;
    const dz = pointB.z - pointA.z;
    const isXAxis = stairsAxis !== undefined ? stairsAxis === 'x' : Math.abs(dx) >= Math.abs(dz);
    const isPositiveY = dy >= 0;

    if (isXAxis) {
      const isPositive = dx >= 0;
      for (let x = minX; x <= maxX; x++) {
        const u = isPositive ? (x - minX) : (maxX - x);
        const stepHeight = W === 1 ? H : (H === 1 ? 1 : 1 + Math.floor((u / (W - 1)) * (H - 1)));
        if (isPositiveY) {
          for (let y = minY; y < minY + stepHeight; y++) {
            for (let z = minZ; z <= maxZ; z++) {
              cells.push(isMicro ? { x, y, z, micro: true } : { x, y, z });
            }
          }
        } else {
          for (let y = maxY; y > maxY - stepHeight; y--) {
            for (let z = minZ; z <= maxZ; z++) {
              cells.push(isMicro ? { x, y, z, micro: true } : { x, y, z });
            }
          }
        }
      }
    } else {
      const isPositive = dz >= 0;
      for (let z = minZ; z <= maxZ; z++) {
        const u = isPositive ? (z - minZ) : (maxZ - z);
        const stepHeight = D === 1 ? H : (H === 1 ? 1 : 1 + Math.floor((u / (D - 1)) * (H - 1)));
        if (isPositiveY) {
          for (let y = minY; y < minY + stepHeight; y++) {
            for (let x = minX; x <= maxX; x++) {
              cells.push(isMicro ? { x, y, z, micro: true } : { x, y, z });
            }
          }
        } else {
          for (let y = maxY; y > maxY - stepHeight; y--) {
            for (let x = minX; x <= maxX; x++) {
              cells.push(isMicro ? { x, y, z, micro: true } : { x, y, z });
            }
          }
        }
      }
    }
    return cells;
  }

  return cells;
}
