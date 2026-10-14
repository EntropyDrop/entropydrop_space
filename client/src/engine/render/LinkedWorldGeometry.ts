import * as THREE from 'three/webgpu';
import { bendPoint, TORUS_GREF, TORUS_R, TORUS_RHO } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { CHUNK_SIZE_Y } from '@entropydrop/space-engine/voxel/Chunk.ts';
import type { SurfaceZoneSnapshot } from '@entropydrop/space-engine/voxel/SurfaceZoneSnapshot.ts';

export const LINKED_WORLD_CENTER_OFFSET = 4 * TORUS_R / 3;
export const LINKED_WORLD_ROTATION_PERIOD_SECONDS = [720, 1080] as const;
export const LINKED_WORLD_ROTATION_CYCLE_SECONDS = 2160;

export function linkedWorldSpinAngle(snapshot: 0 | 1, elapsedSeconds: number): number {
  return (snapshot === 0 ? 1 : -1) * elapsedSeconds * 2 * Math.PI / LINKED_WORLD_ROTATION_PERIOD_SECONDS[snapshot];
}

/** Reference tori have tube radius r. For terrain in [0, CHUNK_SIZE_Y], the
 * bend mapping's tube radius is at most r + |y-GREF| * (1+r/R).
 * The envelope bound excludes entities and camera-local rendering correction;
 * it is not a measurement of the changing, tessellated terrain meshes.
 */
export const LINKED_WORLD_TERRAIN_TUBE_RADIUS = TORUS_RHO
  + Math.max(TORUS_GREF, CHUNK_SIZE_Y - TORUS_GREF) * (1 + TORUS_RHO / TORUS_R);

export function linkedWorldPairClearance(first: 0 | 1 | 2, second: 0 | 1 | 2, tubeRadius: number): number {
  if (first === second) throw new Error('Clearance requires two distinct rings.');
  const centerlineGap = first === 0 || second === 0
    ? 2 * TORUS_R - LINKED_WORLD_CENTER_OFFSET
    : 2 * LINKED_WORLD_CENTER_OFFSET - 2 * TORUS_R;
  return centerlineGap - 2 * tubeRadius;
}

export const LINKED_WORLD_CLEARANCE = Object.freeze({
  referenceSurface: Math.min(linkedWorldPairClearance(0, 1, TORUS_RHO), linkedWorldPairClearance(1, 2, TORUS_RHO)),
  terrainEnvelope: Math.min(linkedWorldPairClearance(0, 1, LINKED_WORLD_TERRAIN_TUBE_RADIUS),
    linkedWorldPairClearance(1, 2, LINKED_WORLD_TERRAIN_TUBE_RADIUS)),
});

/** Three equal-size links in an open chain. The live middle ring stays in XZ;
 * the left and right snapshots lie in XY at x = -d and +d, d = 4R/3.
 * Each end links the middle once, while the ends are separate and unlinked.
 * For R < d < 2R, adjacent centerline clearance is 2R-d; end-to-end clearance
 * is 2d-2R. Balancing these at d=4R/3 maximizes the minimum in this family.
 * Spin around each end ring's own normal leaves its circle and envelope fixed.
 */
export function linkedWorldTransform(slot: 0 | 1 | 2, elapsedSeconds = 0): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  if (slot === 0) return matrix;
  matrix.makeRotationX(Math.PI / 2).setPosition(slot === 1 ? -LINKED_WORLD_CENTER_OFFSET : LINKED_WORLD_CENTER_OFFSET, 0, 0);
  return matrix.multiply(new THREE.Matrix4().makeRotationY(linkedWorldSpinAngle(slot === 1 ? 0 : 1, elapsedSeconds)));
}

/** Bake authenticated surface data into bent-space geometry once. These meshes
 * never enter the live world's chunk, picking, physics or entity registries.
 */
export function buildLinkedWorldZone(zone: SurfaceZoneSnapshot, transform: THREE.Matrix4): THREE.BufferGeometry {
  const positions: number[] = [], colors: number[] = [];
  const point = new THREE.Vector3();
  const color = new THREE.Color();
  const originX = zone.zoneX * zone.zoneSizeChunks * 16;
  const originZ = zone.zoneZ * zone.zoneSizeChunks * 16;
  const quad = (origin: number[], width: number, height: number, direction: number, rgb: ArrayLike<number>) => {
    const axis = direction >> 1, u = (axis + 1) % 3, v = (axis + 2) % 3;
    // Even a large, flat snapshot face must follow the curvature of the torus.
    const nu = Math.ceil(width / 32), nv = Math.ceil(height / 32);
    color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
    const order = direction & 1 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      const bent = corners.map(([a, b]) => {
        const p = [...origin];
        p[u] += a * width / nu; p[v] += b * height / nv;
        bendPoint(originX + p[0], p[1], originZ + p[2], point).applyMatrix4(transform);
        return point.toArray();
      });
      for (const corner of order) {
        positions.push(...bent[corner]);
        colors.push(color.r, color.g, color.b);
      }
    }
  };
  // v7 preserves bridges, overhangs, holes and authored terrain in 3D.
  const mip = zone.voxelMips?.find(mip => mip.cellSize === 32)
    ?? zone.voxelMips?.at(-1);
  if (mip) {
    const view = new DataView(mip.faces.buffer, mip.faces.byteOffset, mip.faces.byteLength);
    for (let at = 0; at < mip.faces.byteLength; at += 16) {
      quad([view.getUint16(at, true) / 8, view.getUint16(at + 2, true) / 8, view.getUint16(at + 4, true) / 8],
        view.getUint16(at + 6, true) / 8, view.getUint16(at + 8, true) / 8,
        mip.faces[at + 10], mip.faces.subarray(at + 12, at + 15));
    }
  } else {
    // Older servers expose a height lattice. Close each occupied column so
    // different heights cannot leave cracks when the snapshot ring is tilted.
    const sourceSize = zone.sampleSize ?? 16 / zone.samplesPerChunkAxis;
    const sourceAxis = zone.zoneSizeChunks * 16 / sourceSize;
    const stride = Math.max(1, 32 / sourceSize);
    const size = sourceSize * stride;
    const axis = sourceAxis / stride;
    const sourceIndex = (x: number, z: number) => zone.sampleSize === undefined
        ? ((Math.floor(x / zone.samplesPerChunkAxis) * zone.zoneSizeChunks + Math.floor(z / zone.samplesPerChunkAxis))
          * zone.samplesPerChunkAxis + x % zone.samplesPerChunkAxis) * zone.samplesPerChunkAxis + z % zone.samplesPerChunkAxis
        : x * sourceAxis + z;
    for (let x = 0; x < axis; x++) for (let z = 0; z < axis; z++) {
      let index = sourceIndex(x * stride, z * stride);
      for (let dx = 0; dx < stride; dx++) for (let dz = 0; dz < stride; dz++) {
        const candidate = sourceIndex(x * stride + dx, z * stride + dz);
        if (zone.heightsMicro[candidate] > zone.heightsMicro[index]) index = candidate;
      }
      const height = zone.heightsMicro[index] / 8;
      if (!height) continue;
      const rgb = zone.colors.subarray(index * 3, index * 3 + 3);
      quad([x * size, height, z * size], size, size, 3, rgb);
      quad([x * size, 0, z * size], height, size, 0, rgb);
      quad([(x + 1) * size, 0, z * size], height, size, 1, rgb);
      quad([x * size, 0, z * size], size, height, 4, rgb);
      quad([x * size, 0, (z + 1) * size], size, height, 5, rgb);
      quad([x * size, 0, z * size], size, size, 2, rgb);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
