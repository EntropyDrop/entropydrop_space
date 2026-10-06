import * as THREE from 'three/webgpu';
import type { RuntimeVoxel } from './EntityTypes.ts';
import { MICRO_DIVISIONS, MICRO_SIZE } from '../voxel/MicroGrid.ts';
import { DEFAULT_BLOCK_COLOR } from '../voxel/BlockTypes.ts';
import { normalizeVoxelMaterialId, VoxelMaterialIds } from '../voxel/VoxelMaterials.ts';
import { createVoxelEmissiveMaterial } from '../render/VoxelEmission.ts';

export type VoxelMeshIndex = Map<string, RuntimeVoxel | number>;
/** Mesh ownership lives on the node and survives incremental geometry edits. */
export interface VoxelMeshNode {
  id: string;
  group: THREE.Group;
  pivotLocal: THREE.Vector3;
  voxelChunkGroup?: THREE.Group;
  voxelChunks?: Map<string, THREE.Mesh>;
  voxelChunkBlocks?: Map<string, Set<RuntimeVoxel>>;
  meshCellMap?: VoxelMeshIndex;
}

function voxelMeshKey(x: number, y: number, z: number, size: number): string {
  return `${Math.round(x * MICRO_DIVISIONS)},${Math.round(y * MICRO_DIVISIONS)},${Math.round(z * MICRO_DIVISIONS)},${Math.round(size * MICRO_DIVISIONS)}`;
}

function microMeshCellKey(x: number, y: number, z: number): string {
  return `micro:${Math.floor(x + 1e-6)},${Math.floor(y + 1e-6)},${Math.floor(z + 1e-6)}`;
}

function indexVoxelMeshBlock(index: VoxelMeshIndex, block: RuntimeVoxel, add: boolean) {
  const size = block.size || 1;
  const key = voxelMeshKey(block.localX, block.localY, block.localZ, size);
  if (add) index.set(key, block);
  else index.delete(key);
  if (size < 1) {
    const cellKey = microMeshCellKey(block.localX, block.localY, block.localZ);
    const count = (typeof index.get(cellKey) === 'number' ? index.get(cellKey) as number : 0) + (add ? 1 : -1);
    if (count > 0) index.set(cellKey, count);
    else index.delete(cellKey);
  }
}

/** Shared face tessellation for rendering and picking on the curved world. */
export function* visibleVoxelFaceQuads(block: RuntimeVoxel, normal: number[], quad: number[][], index?: VoxelMeshIndex) {
  const size = block.size || 1;
  const nx = block.localX + normal[0] * size;
  const ny = block.localY + normal[1] * size;
  const nz = block.localZ + normal[2] * size;
  if (index?.has(voxelMeshKey(nx, ny, nz, size))) return;
  if (size < 1 && index?.has(voxelMeshKey(
    Math.floor(nx + 1e-6), Math.floor(ny + 1e-6), Math.floor(nz + 1e-6), 1
  ))) return;

  // Standard-only faces remain compact. At mixed-grid boundaries, emit only
  // the micro patches exposed by the cut, with no coplanar internal faces.
  if (size !== 1 || !index?.has(microMeshCellKey(nx, ny, nz))) {
    yield quad;
    return;
  }
  const at = (a: number, b: number) => quad[0].map((origin, axis) => (
    origin + (quad[1][axis] - origin) * a / MICRO_DIVISIONS
    + (quad[3][axis] - origin) * b / MICRO_DIVISIONS
  ));
  const exposed: number[][][] = [];
  for (let u = 0; u < MICRO_DIVISIONS; u++) {
    for (let v = 0; v < MICRO_DIVISIONS; v++) {
      const center = at(u + 0.5, v + 0.5);
      const mx = Math.floor((block.localX + center[0] + normal[0] * MICRO_SIZE / 2) * MICRO_DIVISIONS + 1e-6) * MICRO_SIZE;
      const my = Math.floor((block.localY + center[1] + normal[1] * MICRO_SIZE / 2) * MICRO_DIVISIONS + 1e-6) * MICRO_SIZE;
      const mz = Math.floor((block.localZ + center[2] + normal[2] * MICRO_SIZE / 2) * MICRO_DIVISIONS + 1e-6) * MICRO_SIZE;
      if (index.has(voxelMeshKey(mx, my, mz, MICRO_SIZE))) continue;
      exposed.push([at(u, v), at(u + 1, v), at(u + 1, v + 1), at(u, v + 1)]);
    }
  }
  // Interior micro cells do not change this face. Keep its original triangles
  // until a micro cell actually touches it, matching chunk invalidation.
  if (exposed.length === MICRO_DIVISIONS ** 2) yield quad;
  else yield* exposed;
}

export function createVoxelMesh(blocks: readonly RuntimeVoxel[], coordinateOrigin: THREE.Vector3Like, parentGroup: THREE.Group, externalMeshCellMap: VoxelMeshIndex | null = null, existingMesh: THREE.Mesh | null = null) {
  if (blocks.length === 0) return null;
  const buckets = [
    { positions: [] as number[], normals: [] as number[], colors: [] as number[] },
    { positions: [] as number[], normals: [] as number[], colors: [] as number[] }
  ];

  const faces = [
    { dir: [0, 1, 0], norm: [0, 1, 0], quad: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], face: 'top' },
    { dir: [0, -1, 0], norm: [0, -1, 0], quad: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], face: 'bottom' },
    { dir: [0, 0, -1], norm: [0, 0, -1], quad: [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]], face: 'side' },
    { dir: [0, 0, 1], norm: [0, 0, 1], quad: [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]], face: 'side' },
    { dir: [-1, 0, 0], norm: [-1, 0, 0], quad: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]], face: 'side' },
    { dir: [1, 0, 0], norm: [1, 0, 0], quad: [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]], face: 'side' }
  ];

  const meshCellMap = externalMeshCellMap || new Map();
  if (!externalMeshCellMap) {
    for (const b of blocks) indexVoxelMeshBlock(meshCellMap, b, true);
  }

  const tempColor = new THREE.Color();

  for (const b of blocks) {
    const blockSize = b.size || 1;
    const materialId = normalizeVoxelMaterialId(b.materialId);
    const bucket = buckets[materialId];

    const ox = b.localX - coordinateOrigin.x;
    const oy = b.localY - coordinateOrigin.y;
    const oz = b.localZ - coordinateOrigin.z;

    for (const f of faces) {
      const hexColor = b.color ?? DEFAULT_BLOCK_COLOR;
      if (materialId === VoxelMaterialIds.EMISSIVE) {
        if (typeof hexColor === 'string') tempColor.setStyle(hexColor, THREE.LinearSRGBColorSpace);
        else tempColor.setHex(hexColor, THREE.LinearSRGBColorSpace);
      } else tempColor.set(hexColor);
      const shade = materialId === VoxelMaterialIds.EMISSIVE
        ? 1.0
        : f.face === 'top' ? 1.0 : f.face === 'bottom' ? 0.6 : 0.85;
      const r = tempColor.r * shade;
      const g = tempColor.g * shade;
      const bCol = tempColor.b * shade;

      for (const quad of visibleVoxelFaceQuads(b, f.norm, f.quad, meshCellMap)) {
        const v0 = [ox + quad[0][0] * blockSize, oy + quad[0][1] * blockSize, oz + quad[0][2] * blockSize];
        const v1 = [ox + quad[1][0] * blockSize, oy + quad[1][1] * blockSize, oz + quad[1][2] * blockSize];
        const v2 = [ox + quad[2][0] * blockSize, oy + quad[2][1] * blockSize, oz + quad[2][2] * blockSize];
        const v3 = [ox + quad[3][0] * blockSize, oy + quad[3][1] * blockSize, oz + quad[3][2] * blockSize];

        bucket.positions.push(...v0, ...v1, ...v2, ...v0, ...v2, ...v3);
        bucket.normals.push(...f.norm, ...f.norm, ...f.norm, ...f.norm, ...f.norm, ...f.norm);
        bucket.colors.push(r, g, bCol, r, g, bCol, r, g, bCol, r, g, bCol, r, g, bCol, r, g, bCol);
      }
    }
  }

  const positions = buckets.flatMap(bucket => bucket.positions);
  const normals = buckets.flatMap(bucket => bucket.normals);
  const colors = buckets.flatMap(bucket => bucket.colors);
  if (positions.length > 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    let groupStart = 0;
    buckets.forEach((bucket, materialIndex) => {
      if (bucket.positions.length === 0) return;
      const vertexCount = bucket.positions.length / 3;
      geo.addGroup(groupStart, vertexCount, materialIndex);
      groupStart += vertexCount;
    });

    if (existingMesh) {
      existingMesh.geometry.dispose();
      existingMesh.geometry = geo;
      return existingMesh;
    }
    const mat = [
      new THREE.MeshStandardNodeMaterial({
        vertexColors: true,
        flatShading: true,
        roughness: 0.65,
        metalness: 0.15
      }),
      createVoxelEmissiveMaterial()
    ];

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parentGroup.add(mesh);
    return mesh;
  }
  return null;
}

export function buildNodeChunkMeshes(node: VoxelMeshNode, blocks: readonly RuntimeVoxel[], rootId: string) {
  if (!node.voxelChunkGroup) {
    node.voxelChunkGroup = new THREE.Group();
    node.voxelChunkGroup.name = 'VoxelChunks';
    node.group.add(node.voxelChunkGroup);
  }
  if (node.voxelChunks) {
    for (const mesh of node.voxelChunks.values()) {
      node.voxelChunkGroup.remove(mesh);
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else mesh.material.dispose();
    }
  }
  node.voxelChunks = new Map<string, THREE.Mesh>();
  node.meshCellMap = new Map<string, RuntimeVoxel | number>();
  node.voxelChunkBlocks = new Map<string, Set<RuntimeVoxel>>();

  const nodeBlocks = blocks.filter(b => (b.entityId || rootId) === node.id);
  for (const b of nodeBlocks) {
    indexVoxelMeshBlock(node.meshCellMap, b, true);
    const ck = `${Math.floor(b.localX / 8)},${Math.floor(b.localY / 8)},${Math.floor(b.localZ / 8)}`;
    let cSet = node.voxelChunkBlocks.get(ck);
    if (!cSet) node.voxelChunkBlocks.set(ck, cSet = new Set());
    cSet.add(b);
  }

  for (const [ck, cSet] of node.voxelChunkBlocks) {
    const mesh = createVoxelMesh(Array.from(cSet), node.pivotLocal, node.voxelChunkGroup, node.meshCellMap);
    if (mesh) node.voxelChunks.set(ck, mesh);
  }
}

export function updateNodeChunkMeshes(node: VoxelMeshNode, blocks: readonly RuntimeVoxel[], rootId: string, dirtyChunkKeys: Set<string>, addedBlocks: readonly RuntimeVoxel[] = [], removedBlocks: readonly RuntimeVoxel[] = []) {
  if (!node.voxelChunkGroup || !node.voxelChunkBlocks || !node.meshCellMap || !node.voxelChunks) {
    buildNodeChunkMeshes(node, blocks, rootId);
    return;
  }
  for (const b of removedBlocks) {
    if ((b.entityId || rootId) === node.id) {
      indexVoxelMeshBlock(node.meshCellMap, b, false);
      const ck = `${Math.floor(b.localX / 8)},${Math.floor(b.localY / 8)},${Math.floor(b.localZ / 8)}`;
      node.voxelChunkBlocks.get(ck)?.delete(b);
    }
  }
  for (const b of addedBlocks) {
    if ((b.entityId || rootId) === node.id) {
      indexVoxelMeshBlock(node.meshCellMap, b, true);
      const ck = `${Math.floor(b.localX / 8)},${Math.floor(b.localY / 8)},${Math.floor(b.localZ / 8)}`;
      let cSet = node.voxelChunkBlocks.get(ck);
      if (!cSet) node.voxelChunkBlocks.set(ck, cSet = new Set());
      cSet.add(b);
    }
  }

  for (const ck of dirtyChunkKeys) {
    const cSet = node.voxelChunkBlocks.get(ck);
    const existingMesh = node.voxelChunks?.get(ck);
    // Build the replacement before disposing published geometry and retain
    // the mesh/material so local edits do not churn WebGL shader state.
    const mesh = cSet && cSet.size > 0
      ? createVoxelMesh(Array.from(cSet), node.pivotLocal, node.voxelChunkGroup, node.meshCellMap, existingMesh)
      : null;
    if (mesh) {
      node.voxelChunks?.set(ck, mesh);
      continue;
    }
    if (existingMesh) {
      node.voxelChunkGroup.remove(existingMesh);
      existingMesh.geometry.dispose();
      if (Array.isArray(existingMesh.material)) existingMesh.material.forEach((m) => m.dispose());
      else existingMesh.material.dispose();
      node.voxelChunks?.delete(ck);
    }
  }
}
