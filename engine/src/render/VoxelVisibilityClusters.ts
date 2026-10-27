import type * as THREE from 'three';
import { VOXEL_VISIBILITY_STRIDE as STRIDE } from './VoxelFaceVisibility.ts';

/** Consecutive blocks retain their draw order. A coarse sphere can discharge
 * plane tests, but never replaces the per-block facing or coverage decisions. */
export type VoxelVisibilityClusters = { size: number; spheres: Float64Array; planes: Int8Array; bytes: number };

export function buildVoxelVisibilityClusters(data: Float32Array, size: number): VoxelVisibilityClusters {
  const blocks = Math.floor(data.length / STRIDE), count = Math.ceil(blocks / size);
  const spheres = new Float64Array(count * 4), planes = new Int8Array(count);
  planes.fill(63);
  for (let group = 0; group < count; group++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let block = group * size; block < Math.min(blocks, (group + 1) * size); block++) {
      const at = block * STRIDE, x = data[at], y = data[at + 1], z = data[at + 2], r = data[at + 3];
      x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r);
      y0 = Math.min(y0, y - r); y1 = Math.max(y1, y + r);
      z0 = Math.min(z0, z - r); z1 = Math.max(z1, z + r);
    }
    const at = group * 4;
    spheres[at] = (x0 + x1) / 2; spheres[at + 1] = (y0 + y1) / 2; spheres[at + 2] = (z0 + z1) / 2;
    spheres[at + 3] = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 + .001;
  }
  return { size, spheres, planes, bytes: spheres.byteLength + planes.byteLength };
}

export function updateVoxelVisibilityClusters(clusters: VoxelVisibilityClusters, camera: THREE.Vector3,
  frustum: THREE.Frustum, parentMask: number, padding: number, angular: number) {
  const { spheres, planes } = clusters;
  for (let group = 0; group < planes.length; group++) {
    const at = group * 4, x = spheres[at], y = spheres[at + 1], z = spheres[at + 2], radius = spheres[at + 3];
    const dx = x - camera.x, dy = y - camera.y, dz = z - camera.z;
    const margin = padding + (Math.sqrt(dx * dx + dy * dy + dz * dz) + radius) * angular;
    let mask = 0;
    for (let plane = 0; plane < 6; plane++) if (parentMask & (1 << plane)) {
      const p = frustum.planes[plane], n = p.normal, value = n.x * x + n.y * y + n.z * z + p.constant;
      const extent = radius * Math.max(1, n.length());
      if (value + extent + margin < 0) { mask = -1; break; }
      if (!(value - extent >= 0)) mask |= 1 << plane;
    }
    planes[group] = mask;
  }
}
