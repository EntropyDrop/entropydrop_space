import * as THREE from 'three';
import { bendPoint } from '../torus/TorusWorld.ts';

export const VOXEL_FACE_BLOCK = 16;
export const VOXEL_VISIBILITY_STRIDE = 12;
type Faces = { count: number; offset: Uint16Array; span: Uint16Array; direction: Uint8Array };

/** Immutable bounds and normal cones for consecutive face blocks. Bounds cover
 * both triangles after bending; the cone encloses both geometric normals of
 * every quad, including coarse quads spanning a curved part of the ring. */
export function* voxelFaceVisibility(faces: Faces, originX: number, originZ: number): Generator<void, Float32Array> {
  const result = new Float32Array(Math.ceil(faces.count / VOXEL_FACE_BLOCK) * VOXEL_VISIBILITY_STRIDE);
  const corners = Array.from({ length: 4 }, () => new THREE.Vector3());
  const edge = new THREE.Vector3(), normal = new THREE.Vector3(), reference = new THREE.Vector3();
  for (let first = 0; first < faces.count; first += VOXEL_FACE_BLOCK) {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let flatMinX = Infinity, flatMaxX = -Infinity, flatMinZ = Infinity, flatMaxZ = -Infinity, deviation = 0;
    reference.set(0, 0, 0);
    for (let i = first; i < Math.min(faces.count, first + VOXEL_FACE_BLOCK); i++) {
      const dir = faces.direction[i], axis = dir >> 1;
      const x = faces.offset[i * 3] / 8 + originX, y = faces.offset[i * 3 + 1] / 8, z = faces.offset[i * 3 + 2] / 8 + originZ;
      const w = faces.span[i * 2] / 8, h = faces.span[i * 2 + 1] / 8;
      for (let c = 0; c < 4; c++) {
        let u = c === 1 || c === 2 ? 1 : 0; const v = c >= 2 ? 1 : 0;
        if (!(dir & 1)) u = 1 - u;
        const px = x + (axis === 0 ? 0 : axis === 1 ? v * h : u * w);
        const py = y + (axis === 1 ? 0 : axis === 0 ? u * w : v * h);
        const pz = z + (axis === 2 ? 0 : axis === 0 ? v * h : u * w);
        const p = bendPoint(px, py, pz, corners[c]);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
        flatMinX = Math.min(flatMinX, px); flatMaxX = Math.max(flatMaxX, px);
        flatMinZ = Math.min(flatMinZ, pz); flatMaxZ = Math.max(flatMaxZ, pz);
      }
      for (let b = 1; b <= 2; b++) {
        const c = b + 1;
        normal.subVectors(corners[b], corners[0]).cross(edge.subVectors(corners[c], corners[0]));
        if (normal.lengthSq() < 1e-12) { deviation = 2; continue; }
        normal.normalize();
        if (reference.lengthSq() === 0) reference.copy(normal);
        deviation = Math.max(deviation, normal.distanceTo(reference));
      }
    }
    const at = first / VOXEL_FACE_BLOCK * VOXEL_VISIBILITY_STRIDE;
    // Padding covers CPU/GPU float rounding, including the metre angle lookup.
    result.set([(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2,
      Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + .01,
      reference.x, reference.y, reference.z, deviation + .00001,
      flatMinX, flatMaxX, flatMinZ, flatMaxZ], at);
    if ((first & 1023) === 0) yield;
  }
  return result;
}

/** A sphere plus a normal cone gives an upper bound on every facing test. */
export function voxelBlockBackFacing(data: Float32Array, at: number, x: number, y: number, z: number, motionPadding = 0) {
  const dx = x - data[at], dy = y - data[at + 1], dz = z - data[at + 2];
  const distance = Math.hypot(dx, dy, dz), radius = data[at + 3];
  // Inside camera-local flattening, use the ordinary rasterizer's facing test.
  if (distance - radius <= 256 + motionPadding) return false;
  return data[at + 4] * dx + data[at + 5] * dy + data[at + 6] * dz
    + distance * data[at + 7] + radius + motionPadding < 0;
}
