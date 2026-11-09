import { alignedVertexAttribute } from './NodeMaterials.ts';
import * as THREE from 'three';
import { MICRO_SIZE } from '../voxel/MicroGrid.ts';
import { computeChunkBentSphere, getWorldProjectionRevision } from '../torus/TorusWorld.ts';

// Bound each synchronous copy. One merged batch never exceeds this many
// vertices, so a small edit rebuilds at most one bounded batch.
export const MAX_MICRO_BATCH_VERTICES = 32_768;
// Dense authored chunks (Aether ornaments, castles) are split into several
// bounded batches instead of falling back to dozens of partition draws. Only
// chunks beyond this total keep their independent partition meshes.
export const MAX_MICRO_CHUNK_MERGE_VERTICES = 131_072;

interface MicroBatchBin {
  key: string;
  parts: Map<string, THREE.Mesh>;
  vertices: number;
  /** Published render mesh: the merged batch, or the only partition mesh. */
  output: THREE.Mesh | null;
  outputKey: string;
}

const vertexCount = (mesh: THREE.Mesh) => mesh.geometry.getAttribute('position').count;

/** Edit/collision partitions stay independent; only published render data is
 * combined. A batch never crosses a standard chunk (the terrain fade owner). */
export class MicroRenderBatches {
  readonly meshes = new Map<string, THREE.Mesh>();
  private readonly members = new Map<string, Map<string, THREE.Mesh>>();
  private readonly published = new Map<string, string[]>();
  private readonly bins = new Map<string, MicroBatchBin[]>();
  private readonly dirty = new Set<string>();
  private enabled = true;
  private binSerial = 0;

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
      const members = this.members.get(chunk);
      const next = new Map<string, THREE.Mesh>();
      if (members?.size) {
        let vertices = 0;
        for (const mesh of members.values()) vertices += vertexCount(mesh);
        if (this.enabled && members.size > 1 && vertices <= MAX_MICRO_CHUNK_MERGE_VERTICES) {
          for (const [key, mesh] of this.packBins(chunk, members)) next.set(key, mesh);
        } else {
          // Unbatched publication: the published-mesh diff below disposes
          // any merged batches that this chunk previously owned.
          this.bins.delete(chunk);
          for (const [key, mesh] of members) next.set(key, mesh);
        }
      } else this.bins.delete(chunk);
      // Retire only what changed; unchanged batches keep their GPU buffers,
      // pipelines and cached render bundles.
      for (const key of this.published.get(chunk) ?? []) {
        const old = this.meshes.get(key)!;
        if (next.get(key) === old) continue;
        this.group.remove(old);
        if (old.userData.microRenderBatch) old.geometry.dispose();
        this.meshes.delete(key);
      }
      if (!members?.size) {
        this.members.delete(chunk);
        this.published.delete(chunk);
        continue;
      }
      this.published.set(chunk, [...next.keys()]);
      for (const [key, mesh] of next) {
        if (this.meshes.get(key) === mesh) continue;
        this.meshes.set(key, mesh);
        this.group.add(mesh);
        rebuilt.push(mesh);
      }
    }
    this.dirty.clear();
    return rebuilt;
  }

  /** Stable first-fit packing: unchanged partitions keep their previous batch,
   * so an edit rebuilds only the bounded batch that contains it. */
  private packBins(chunk: string, members: Map<string, THREE.Mesh>): [string, THREE.Mesh][] {
    const previous = this.bins.get(chunk) ?? [];
    const bins: MicroBatchBin[] = previous.map(bin => ({ key: bin.key, parts: new Map(), vertices: 0,
      output: bin.output, outputKey: bin.outputKey }));
    const placed = new Set<string>();
    previous.forEach((bin, index) => {
      for (const [key, mesh] of bin.parts) {
        if (members.get(key) !== mesh) continue;
        bins[index].parts.set(key, mesh); bins[index].vertices += vertexCount(mesh); placed.add(key);
      }
    });
    const entries: [string, THREE.Mesh][] = [];
    for (const [key, mesh] of members) {
      if (placed.has(key)) continue;
      const vertices = vertexCount(mesh);
      if (vertices > MAX_MICRO_BATCH_VERTICES) { entries.push([key, mesh]); continue; }
      const home = previous.findIndex(bin => bin.parts.has(key));
      let bin = home >= 0 && bins[home].vertices + vertices <= MAX_MICRO_BATCH_VERTICES ? bins[home]
        : bins.find(candidate => candidate.vertices + vertices <= MAX_MICRO_BATCH_VERTICES);
      if (!bin) {
        // The first batch keeps the chunk key; extra batches get unique keys.
        const key = bins.some(candidate => candidate.key === chunk) ? `${chunk}#${++this.binSerial}` : chunk;
        bin = { key, parts: new Map(), vertices: 0, output: null, outputKey: '' };
        bins.push(bin);
      }
      bin.parts.set(key, mesh); bin.vertices += vertices;
    }
    const kept: MicroBatchBin[] = [];
    bins.forEach((bin, index) => {
      const before = previous[index];
      const unchanged = before && before.output && before.parts.size === bin.parts.size
        && [...bin.parts].every(([key, mesh]) => before.parts.get(key) === mesh);
      if (!unchanged) {
        if (bin.parts.size === 1) {
          const [key, mesh] = bin.parts.entries().next().value!;
          bin.output = mesh; bin.outputKey = key;
        } else if (bin.parts.size > 1) {
          bin.output = this.merge(chunk, [...bin.parts.values()], bin.vertices); bin.outputKey = bin.key;
        } else { bin.output = null; bin.outputKey = ''; }
      }
      if (bin.output) { kept.push(bin); entries.push([bin.outputKey, bin.output]); }
    });
    this.bins.set(chunk, kept);
    return entries;
  }

  private merge(chunk: string, members: THREE.Mesh[], vertexCount: number): THREE.Mesh {
    const [cx, cz] = chunk.split(',').map(Number);
    const positions = new Uint16Array(vertexCount * 3);
    // Written directly in the padded 4-byte layout that alignedVertexAttribute
    // would otherwise build with one subarray per vertex.
    const normals = new Int8Array(vertexCount * 4);
    const colors = new Uint8Array(vertexCount * 4);
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
      const base = vertexOffset * 3;
      for (let i = 0; i < source.length; i += 3) {
        positions[base + i] = source[i] + dx;
        positions[base + i + 1] = source[i + 1];
        positions[base + i + 2] = source[i + 2] + dz;
      }
      const normal = geometry.getAttribute('normal'), color = geometry.getAttribute('color');
      const normalArray = normal.array, normalStride = normal.itemSize;
      for (let i = 0, from = 0, to = vertexOffset * 4; i < normal.count; i++, from += normalStride, to += 4) {
        normals[to] = normalArray[from]; normals[to + 1] = normalArray[from + 1]; normals[to + 2] = normalArray[from + 2];
      }
      if (color.itemSize === 4) colors.set(color.array.subarray(0, color.count * 4), vertexOffset * 4);
      else for (let i = 0; i < color.count; i++) for (let c = 0; c < 4; c++) {
        colors[(vertexOffset + i) * 4 + c] = c === 3 && color.itemSize === 3 ? 255 : color.array[i * color.itemSize + c];
      }
      vertexOffset += source.length / 3;
    }
    const geometry = new THREE.BufferGeometry();
    let written = 0;
    // Material-contiguous indices keep each batch at at most three draw calls.
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
    // Same uploaded formats as alignedVertexAttribute: float positions (from the
    // integer micro lattice) and padded signed-normalized normals.
    const floatPositions = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i++) floatPositions[i] = positions[i];
    geometry.setAttribute('position', new THREE.BufferAttribute(floatPositions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 4, true));
    geometry.setAttribute('color', alignedVertexAttribute(colors, 4, true));
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
