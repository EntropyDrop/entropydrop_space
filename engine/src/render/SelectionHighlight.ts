import * as THREE from 'three/webgpu';
import { normalLocal, positionLocal } from 'three/tsl';
import type { CollisionBounds } from '../physics/CollisionGeometry.ts';
import { MAX_ENTITY_BOUNDS } from '../constants/SpaceConstants.ts';

export const SELECTION_HIGHLIGHT_COLOR = 0xff9500;
export const SELECTION_HIGHLIGHT_SURFACE_OFFSET = 0.003;

/** Orange surface tint shared by selected cells and complete selection volumes. */
export function createSelectionHighlightMaterial() {
  const material = new THREE.MeshBasicNodeMaterial({
    color: SELECTION_HIGHLIGHT_COLOR,
    transparent: true,
    opacity: 0.65,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    // Slope bias is unbounded at grazing angles and can pull buried faces
    // through terrain. A small physical offset handles coplanar surfaces.
    polygonOffsetFactor: 0,
    polygonOffsetUnits: -1,
    toneMapped: false,
  });
  // TorusWorld composes this offset before bending the surface. Selection and
  // action bounds stay exact; only the preview moves three millimetres outward.
  material.positionNode = positionLocal.add(normalLocal.mul(SELECTION_HIGHLIGHT_SURFACE_OFFSET));
  return material;
}

/** Batch voxel faces into one draw, cancelling shared faces between neighbours. */
export function buildSelectionHighlightGeometry(boxes: readonly CollisionBounds[], origin: { x: number; y: number; z: number }) {
  const faces = new Map<string, { axis: number; sign: number; plane: number; u0: number; u1: number; v0: number; v1: number; mask: number }>();
  for (const box of boxes) {
    const lo = [box.minX - origin.x, box.minY - origin.y, box.minZ - origin.z];
    const hi = [box.maxX - origin.x, box.maxY - origin.y, box.maxZ - origin.z];
    for (let axis = 0; axis < 3; axis++) {
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      for (const sign of [-1, 1]) {
        const plane = sign === 1 ? hi[axis] : lo[axis];
        const key = `${axis}:${plane}:${lo[u]}:${hi[u]}:${lo[v]}:${hi[v]}`;
        const mask = sign === 1 ? 1 : 2;
        const existing = faces.get(key);
        if (existing) existing.mask |= mask;
        else faces.set(key, { axis, sign, plane, u0: lo[u], u1: hi[u], v0: lo[v], v1: hi[v], mask });
      }
    }
  }
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  for (const face of faces.values()) {
    if (face.mask === 3) continue;
    const { axis, sign, plane, u0, u1, v0, v1 } = face;
    // Large quads bend only at their corners and cut through curved terrain.
    // Match the one-metre terrain grid, sharing vertices within each face.
    // Micro faces already meet that spacing and need no extra subdivision.
    const nu = Math.max(1, Math.min(MAX_ENTITY_BOUNDS, Math.ceil(u1 - u0)));
    const nv = Math.max(1, Math.min(MAX_ENTITY_BOUNDS, Math.ceil(v1 - v0)));
    const start = positions.length / 3;
    for (let v = 0; v <= nv; v++) for (let u = 0; u <= nu; u++) {
      const p = [0, 0, 0], n = [0, 0, 0];
      p[axis] = plane; n[axis] = sign;
      p[(axis + 1) % 3] = u0 + (u1 - u0) * u / nu;
      p[(axis + 2) % 3] = v0 + (v1 - v0) * v / nv;
      positions.push(...p); normals.push(...n);
    }
    for (let v = 0; v < nv; v++) for (let u = 0; u < nu; u++) {
      const a = start + v * (nu + 1) + u, b = a + 1;
      const d = a + nu + 1, c = d + 1;
      if (sign === 1) indices.push(a, b, c, a, c, d);
      else indices.push(a, c, b, a, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}
