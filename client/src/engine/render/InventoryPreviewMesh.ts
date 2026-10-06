import * as THREE from 'three';
import { MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import type { InventoryPreviewBlock } from '../inventory/InventoryGeometry.ts';

interface PreviewFace { v0: number[]; v1: number[]; v2: number[]; v3: number[]; normal: number[]; color: THREE.ColorRepresentation }

export function buildUnifiedInventoryPreviewMesh(entries: readonly (Omit<InventoryPreviewBlock, 'color'> & { color?: THREE.ColorRepresentation })[]) {
  if (!entries || entries.length === 0) return null;

  let minSize = Infinity;
  let allSize1 = true;
  for (const entry of entries) {
    const s = Number(entry.size) || 1;
    minSize = Math.min(minSize, s);
    if (Math.abs(s - 1) > 1e-4) allSize1 = false;
  }

  // Quantization step in milli-units (1.0 block -> 1000, 0.125 microblock -> 125)
  const step = allSize1 ? 1000 : (minSize < 0.9 ? MICRO_SIZE * 1000 : 1000);
  const toCoord = (val: number) => Math.round(val * 1000);

  // Map of patchKey -> { pos?: Patch, neg?: Patch }
  // Back-to-back opposing faces cancel each other out (internal face culling).
  const patchMap = new Map<string, { pos?: PreviewFace; neg?: PreviewFace }>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const size = Number(entry.size) || 1;
    const color = entry.color ?? 0xf2a93b;
    const cx = entry.center.x;
    const cy = entry.center.y;
    const cz = entry.center.z;

    const qx0 = toCoord(cx - size / 2);
    const qy0 = toCoord(cy - size / 2);
    const qz0 = toCoord(cz - size / 2);
    const qx1 = toCoord(cx + size / 2);
    const qy1 = toCoord(cy + size / 2);
    const qz1 = toCoord(cz + size / 2);

    // 1. +X Face (Plane X = qx1, Normal +X, Dir +1)
    for (let u = qy0; u < qy1; u += step) {
      for (let v = qz0; v < qz1; v += step) {
        const u1 = Math.min(u + step, qy1);
        const v1 = Math.min(v + step, qz1);
        const key = `X:${qx1}:${u}:${u1}:${v}:${v1}`;
        const existing = patchMap.get(key);
        if (existing?.neg) {
          patchMap.delete(key);
        } else {
          patchMap.set(key, {
            pos: {
              v0: [qx1 / 1000, u / 1000, v1 / 1000],
              v1: [qx1 / 1000, u / 1000, v / 1000],
              v2: [qx1 / 1000, u1 / 1000, v / 1000],
              v3: [qx1 / 1000, u1 / 1000, v1 / 1000],
              normal: [1, 0, 0],
              color
            }
          });
        }
      }
    }

    // 2. -X Face (Plane X = qx0, Normal -X, Dir -1)
    for (let u = qy0; u < qy1; u += step) {
      for (let v = qz0; v < qz1; v += step) {
        const u1 = Math.min(u + step, qy1);
        const v1 = Math.min(v + step, qz1);
        const key = `X:${qx0}:${u}:${u1}:${v}:${v1}`;
        const existing = patchMap.get(key);
        if (existing?.pos) {
          patchMap.delete(key);
        } else {
          patchMap.set(key, {
            neg: {
              v0: [qx0 / 1000, u / 1000, v / 1000],
              v1: [qx0 / 1000, u / 1000, v1 / 1000],
              v2: [qx0 / 1000, u1 / 1000, v1 / 1000],
              v3: [qx0 / 1000, u1 / 1000, v / 1000],
              normal: [-1, 0, 0],
              color
            }
          });
        }
      }
    }

    // 3. +Y Face (Plane Y = qy1, Normal +Y, Dir +1)
    for (let u = qx0; u < qx1; u += step) {
      for (let v = qz0; v < qz1; v += step) {
        const u1 = Math.min(u + step, qx1);
        const v1 = Math.min(v + step, qz1);
        const key = `Y:${qy1}:${u}:${u1}:${v}:${v1}`;
        const existing = patchMap.get(key);
        if (existing?.neg) {
          patchMap.delete(key);
        } else {
          patchMap.set(key, {
            pos: {
              v0: [u / 1000, qy1 / 1000, v1 / 1000],
              v1: [u1 / 1000, qy1 / 1000, v1 / 1000],
              v2: [u1 / 1000, qy1 / 1000, v / 1000],
              v3: [u / 1000, qy1 / 1000, v / 1000],
              normal: [0, 1, 0],
              color
            }
          });
        }
      }
    }

    // 4. -Y Face (Plane Y = qy0, Normal -Y, Dir -1)
    for (let u = qx0; u < qx1; u += step) {
      for (let v = qz0; v < qz1; v += step) {
        const u1 = Math.min(u + step, qx1);
        const v1 = Math.min(v + step, qz1);
        const key = `Y:${qy0}:${u}:${u1}:${v}:${v1}`;
        const existing = patchMap.get(key);
        if (existing?.pos) {
          patchMap.delete(key);
        } else {
          patchMap.set(key, {
            neg: {
              v0: [u / 1000, qy0 / 1000, v / 1000],
              v1: [u1 / 1000, qy0 / 1000, v / 1000],
              v2: [u1 / 1000, qy0 / 1000, v1 / 1000],
              v3: [u / 1000, qy0 / 1000, v1 / 1000],
              normal: [0, -1, 0],
              color
            }
          });
        }
      }
    }

    // 5. +Z Face (Plane Z = qz1, Normal +Z, Dir +1)
    for (let u = qx0; u < qx1; u += step) {
      for (let v = qy0; v < qy1; v += step) {
        const u1 = Math.min(u + step, qx1);
        const v1 = Math.min(v + step, qy1);
        const key = `Z:${qz1}:${u}:${u1}:${v}:${v1}`;
        const existing = patchMap.get(key);
        if (existing?.neg) {
          patchMap.delete(key);
        } else {
          patchMap.set(key, {
            pos: {
              v0: [u / 1000, v / 1000, qz1 / 1000],
              v1: [u1 / 1000, v / 1000, qz1 / 1000],
              v2: [u1 / 1000, v1 / 1000, qz1 / 1000],
              v3: [u / 1000, v1 / 1000, qz1 / 1000],
              normal: [0, 0, 1],
              color
            }
          });
        }
      }
    }

    // 6. -Z Face (Plane Z = qz0, Normal -Z, Dir -1)
    for (let u = qx0; u < qx1; u += step) {
      for (let v = qy0; v < qy1; v += step) {
        const u1 = Math.min(u + step, qx1);
        const v1 = Math.min(v + step, qy1);
        const key = `Z:${qz0}:${u}:${u1}:${v}:${v1}`;
        const existing = patchMap.get(key);
        if (existing?.pos) {
          patchMap.delete(key);
        } else {
          patchMap.set(key, {
            neg: {
              v0: [u1 / 1000, v / 1000, qz0 / 1000],
              v1: [u / 1000, v / 1000, qz0 / 1000],
              v2: [u / 1000, v1 / 1000, qz0 / 1000],
              v3: [u1 / 1000, v1 / 1000, qz0 / 1000],
              normal: [0, 0, -1],
              color
            }
          });
        }
      }
    }
  }

  const patchCount = patchMap.size;
  if (patchCount === 0) return null;

  const fillPositions = new Float32Array(patchCount * 18);
  const fillNormals = new Float32Array(patchCount * 18);
  const fillColors = new Float32Array(patchCount * 18);

  const edgePositions: number[] = [];
  const edgeSet = new Set<string>();
  const tempColor = new THREE.Color();

  let vertOffset = 0;
  for (const item of patchMap.values()) {
    const patch = item.pos || item.neg;
    if (!patch) continue;

    tempColor.set(patch.color ?? 0xf2a93b);
    const r = tempColor.r;
    const g = tempColor.g;
    const b = tempColor.b;
    const [nx, ny, nz] = patch.normal;
    const { v0, v1, v2, v3 } = patch;

    // Triangle 1: v0, v1, v2
    fillPositions[vertOffset] = v0[0];
    fillPositions[vertOffset + 1] = v0[1];
    fillPositions[vertOffset + 2] = v0[2];
    fillPositions[vertOffset + 3] = v1[0];
    fillPositions[vertOffset + 4] = v1[1];
    fillPositions[vertOffset + 5] = v1[2];
    fillPositions[vertOffset + 6] = v2[0];
    fillPositions[vertOffset + 7] = v2[1];
    fillPositions[vertOffset + 8] = v2[2];

    // Triangle 2: v0, v2, v3
    fillPositions[vertOffset + 9] = v0[0];
    fillPositions[vertOffset + 10] = v0[1];
    fillPositions[vertOffset + 11] = v0[2];
    fillPositions[vertOffset + 12] = v2[0];
    fillPositions[vertOffset + 13] = v2[1];
    fillPositions[vertOffset + 14] = v2[2];
    fillPositions[vertOffset + 15] = v3[0];
    fillPositions[vertOffset + 16] = v3[1];
    fillPositions[vertOffset + 17] = v3[2];

    for (let k = 0; k < 6; k++) {
      const idx = vertOffset + k * 3;
      fillNormals[idx] = nx;
      fillNormals[idx + 1] = ny;
      fillNormals[idx + 2] = nz;
      fillColors[idx] = r;
      fillColors[idx + 1] = g;
      fillColors[idx + 2] = b;
    }
    vertOffset += 18;

    // Outer quad boundary edges
    const edges = [
      [v0, v1],
      [v1, v2],
      [v2, v3],
      [v3, v0]
    ];
    for (const [p1, p2] of edges) {
      const k1 = `${Math.round(p1[0] * 1000)},${Math.round(p1[1] * 1000)},${Math.round(p1[2] * 1000)}`;
      const k2 = `${Math.round(p2[0] * 1000)},${Math.round(p2[1] * 1000)},${Math.round(p2[2] * 1000)}`;
      const edgeKey = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        edgePositions.push(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
      }
    }
  }

  const fillGeometry = new THREE.BufferGeometry();
  fillGeometry.setAttribute('position', new THREE.BufferAttribute(fillPositions, 3));
  fillGeometry.setAttribute('normal', new THREE.BufferAttribute(fillNormals, 3));
  fillGeometry.setAttribute('color', new THREE.BufferAttribute(fillColors, 3));

  const wireGeometry = new THREE.BufferGeometry();
  wireGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));

  return { fillGeometry, wireGeometry, patchCount };
}
