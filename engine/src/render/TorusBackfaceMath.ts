/** Macro-surface facing; intentionally not a visibility proof for actual terrain. */
import { TORUS_R, TORUS_RHO, TORUS_K_THETA, TORUS_K_PHI, torusTubeAngle } from '../torus/TorusWorld.ts';

export const BACKFACE_NEAR_KEEP = 384;
export const BACKFACE_MOTION_MARGIN = 18;
export const BACKFACE_HORIZON_MARGIN = 32;
export const BACKFACE_PROXY_STRIDE = 6;
const tubeDerivative = Math.sqrt((TORUS_R / TORUS_RHO + 1) / (TORUS_R / TORUS_RHO - 1));

/** Six coefficients bound every reference-surface normal/point in this rectangle.
 * The actual block center is only used to reuse the existing distance cache. */
export function surfaceFacingProxy(minX: number, maxX: number, minZ: number, maxZ: number,
  centerX: number, centerY: number, centerZ: number, out: Float64Array = new Float64Array(6), at = 0) {
  const theta = (minX + maxX) * .5 * TORUS_K_THETA, phi = torusTubeAngle((minZ + maxZ) * .5);
  const ct = Math.cos(theta), st = Math.sin(theta), cp = Math.cos(phi), sp = Math.sin(phi);
  const px = (TORUS_R + TORUS_RHO * cp) * ct, py = TORUS_RHO * sp, pz = (TORUS_R + TORUS_RHO * cp) * st;
  const thetaRadius = Math.abs(maxX - minX) * .5 * TORUS_K_THETA;
  // The derivative bound is seam-safe, unlike subtracting wrapped atan2 angles.
  const phiRadius = Math.abs(maxZ - minZ) * .5 * TORUS_K_PHI * tubeDerivative;
  const normalSpread = Math.min(2, thetaRadius + phiRadius);
  const patchRadius = (TORUS_R + TORUS_RHO) * thetaRadius + TORUS_RHO * phiRadius;
  const centerOffset = Math.hypot(centerX - px, centerY - py, centerZ - pz);
  out.set([cp * ct, sp, cp * st, TORUS_R * cp + TORUS_RHO, normalSpread,
    patchRadius + centerOffset * normalSpread + BACKFACE_MOTION_MARGIN + BACKFACE_HORIZON_MARGIN], at);
  return out;
}

export function surfaceBlockBackFacing(proxy: Float64Array, at: number, cameraX: number, cameraY: number, cameraZ: number,
  distance: number, radius: number, motionPadding = BACKFACE_MOTION_MARGIN) {
  if (distance - radius <= BACKFACE_NEAR_KEEP + motionPadding) return false;
  // Proxies already include the original motion margin. Wider reuse must add
  // its extra slack without changing the immutable proxy or the default filter.
  const extra = Math.max(0, motionPadding - BACKFACE_MOTION_MARGIN);
  return proxy[at] * cameraX + proxy[at + 1] * cameraY + proxy[at + 2] * cameraZ - proxy[at + 3]
    + distance * proxy[at + 4] + proxy[at + 5] + extra < 0;
}
