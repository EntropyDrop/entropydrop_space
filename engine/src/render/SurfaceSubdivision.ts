import { TORUS_RHO, TORUS_R } from '../torus/TorusWorld.ts';

/** Rotation-independent upper estimate of a bent column's projected face area.
 * Sum the three box-face areas, inflated by the torus' maximum local stretch.
 * Unlike a view-space AABB this keeps topology/cache residency stable on turns.
 * Multiply by (focalLengthPx / distance)^2 to obtain CSS pixel area. */
export function surfaceSubdivisionWorldArea(size: number, height: number, minimum: number) {
  const boundRho = Math.max(Math.abs(Math.min(TORUS_RHO + minimum - 16, TORUS_R - 1)),
    Math.abs(Math.min(TORUS_RHO + height - 16, TORUS_R - 1)));
  const stretch = Math.max(1, (TORUS_R + boundRho) / TORUS_R, boundRho / TORUS_RHO);
  return size * (size + 2 * Math.max(0, height - minimum)) * stretch * stretch;
}

/** Flat, nearly uniform surfaces already accurate to half a pixel need no
 * extra triangles. All other detail is governed by the requested px^2 area. */
export const SURFACE_SUBPIXEL_ERROR = 0.5;
export const SURFACE_AREA_HYSTERESIS = 0.65;

export function surfaceSubdivisionDistance(worldArea: number, error: number, pixelScale: number, areaPx2: number) {
  return Math.min(Math.sqrt(worldArea / areaPx2), error / SURFACE_SUBPIXEL_ERROR) * pixelScale;
}
