import * as THREE from 'three';
import { MICRO_SIZE } from '../voxel/MicroGrid.ts';
import { computeChunkBentSphere, getWorldProjectionRevision } from '../torus/TorusWorld.ts';

// Bound each synchronous copy. Dense authored chunks retain their partition
// meshes instead of turning one small edit into an unbounded chunk-wide merge.
export const MAX_MICRO_BATCH_VERTICES = 32_768;

/** Edit/collision partitions stay independent; only published render data is
 * combined. A batch never crosses a standard chunk (the terrain fade owner). */
export class MicroRenderBatches {
  readonly meshes = new Map<string, THREE.Mesh>();
  private readonly members = new Map<string, Map<string, THREE.Mesh>>();
  private readonly published = new Map<string, string[]>();
  private readonly dirty = new Set<string>();
  private enabled = true;

  private readonly group: THREE.Group;
  private readonly materials: THREE.Material[];

  constructor(group: THREE.Group, materials: THREE.Material[]) {
    this.group = group;
    this.materials = materials;
  }

  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    for (const key of this.members.keys()) this.dirty.add(key);
  }

  replace(partition: string, chunk: string, mesh: THREE.Mesh | null) {
    let members = this.members.get(chunk);
    if (!members) this.members.set(chunk, members = new Map());
    if (mesh) members.set(partition, mesh);
    else members.delete(partition);
    this.dirty.add(chunk);
  }

  flush(): THREE.Mesh[] {
    const rebuilt: THREE.Mesh[] = [];
    for (const chunk of this.dirty) {
      for (const key of this.published.get(chunk) ?? []) {
        const old = this.meshes.get(key)!;
        this.group.remove(old);
        if (old.userData.microRenderBatch) old.geometry.dispose();
        this.meshes.delete(key);
      }
      const members = this.members.get(chunk)!;
      if (!members.size) {
        this.members.delete(chunk);
        this.published.delete(chunk);
        continue;
      }
      let vertices = 0;
      for (const mesh of members.values()) vertices += mesh.geometry.getAttribute('position').count;
      const entries: [string, THREE.Mesh][] = this.enabled && members.size > 1 && vertices <= MAX_MICRO_BATCH_VERTICES
        ? [[chunk, this.merge(chunk, [...members.values()], vertices)]] : [...members];
      this.published.set(chunk, entries.map(([key]) => key));
      for (const [key, mesh] of entries) {
        this.meshes.set(key, mesh);
        this.group.add(mesh);
        rebuilt.push(mesh);
      }
    }
    this.dirty.clear();
    return rebuilt;
  }

  private merge(chunk: string, members: THREE.Mesh[], vertexCount: number): THREE.Mesh {
    const [cx, cz] = chunk.split(',').map(Number);
    const positions = new Uint16Array(vertexCount * 3);
    const normals = new Int8Array(vertexCount * 3);
    const colors = new Uint8Array(vertexCount * 3);
    let indexCount = 0, minY = Infinity, maxY = -Infinity;
    for (const mesh of members) {
      indexCount += mesh.geometry.index!.count;
      minY = Math.min(minY, mesh.userData.occupiedMinY);
      maxY = Math.max(maxY, mesh.userData.occupiedMaxY);
    }
    const indices = new Uint16Array(indexCount);
    let vertexOffset = 0;
    for (const mesh of members) {
      const geometry = mesh.geometry;
      const source = geometry.getAttribute('position').array;
      const dx = (mesh.position.x - cx * 16) / MICRO_SIZE;
      const dz = (mesh.position.z - cz * 16) / MICRO_SIZE;
      for (let i = 0; i < source.length; i += 3) {
        positions[vertexOffset * 3 + i] = source[i] + dx;
        positions[vertexOffset * 3 + i + 1] = source[i + 1];
        positions[vertexOffset * 3 + i + 2] = source[i + 2] + dz;
      }
      normals.set(geometry.getAttribute('normal').array, vertexOffset * 3);
      colors.set(geometry.getAttribute('color').array, vertexOffset * 3);
      vertexOffset += source.length / 3;
    }
    const geometry = new THREE.BufferGeometry();
    let written = 0;
    // Material-contiguous indices keep each batch at at most two draw calls.
    for (let material = 0; material < this.materials.length; material++) {
      const start = written;
      vertexOffset = 0;
      for (const mesh of members) {
        const source = mesh.geometry.index!.array;
        for (const group of mesh.geometry.groups) {
          if (group.materialIndex !== material) continue;
          for (let i = group.start; i < group.start + group.count; i++) {
            indices[written++] = source[i] + vertexOffset;
          }
        }
        vertexOffset += mesh.geometry.getAttribute('position').count;
      }
      if (written > start) geometry.addGroup(start, written - start, material);
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3, true));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    const mesh = new THREE.Mesh(geometry, this.materials);
    mesh.name = `MicroVoxelBatch:${chunk}`;
    Object.assign(mesh.userData, {
      microRenderBatch: true, standardChunkKey: chunk,
      projectionChunkCx: cx, projectionChunkCz: cz, bentSpan: 16,
      occupiedMinY: minY, occupiedMaxY: maxY,
      bentSphere: computeChunkBentSphere(cx, cz, null, minY, maxY),
      bentSphereRevision: getWorldProjectionRevision(),
    });
    mesh.position.set(cx * 16, 0, cz * 16);
    mesh.scale.setScalar(MICRO_SIZE);
    mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  }
}
