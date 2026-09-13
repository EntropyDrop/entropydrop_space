import * as THREE from 'three';
import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z, Chunk } from '@entropydrop/space-engine/voxel/Chunk.ts';
import { unwrapPeriodicNear, TORUS_SIZE_X, TORUS_SIZE_Z } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { IMPOSTOR_DISTANCE, type ImpostorSource } from './CrossPlaneImpostor.ts';

interface DetachedPart {
  helper: THREE.Mesh;
  remainder: THREE.BufferGeometry;
  bounds: THREE.Box3;
}

/** Separate only disconnected solid components; anything reaching a chunk edge stays terrain. */
export function* separateDetachedBlocks(chunk: Chunk, mesh: THREE.Mesh): Generator<void, DetachedPart | null> {
  const labels = new Uint16Array(chunk.blocks.length);
  const queue = new Uint32Array(chunk.blocks.length);
  const detached = new Set<number>();
  const layer = CHUNK_SIZE_X * CHUNK_SIZE_Z;
  let label = 0;
  for (let cell = 0; cell < chunk.blocks.length; cell++) {
    if ((cell & 255) === 0) yield;
    if (labels[cell] || !chunk.blocks[cell]) continue;
    label++;
    let head = 0, tail = 1, touchesBoundary = false;
    queue[0] = cell;
    labels[cell] = label;
    while (head < tail) {
      const current = queue[head++];
      const x = current % CHUNK_SIZE_X;
      const z = Math.floor(current / CHUNK_SIZE_X) % CHUNK_SIZE_Z;
      const y = Math.floor(current / layer);
      if (x === 0 || x === CHUNK_SIZE_X - 1 || z === 0 || z === CHUNK_SIZE_Z - 1 || y === 0 || y === CHUNK_SIZE_Y - 1) touchesBoundary = true;
      const neighbors = [
        x > 0 ? current - 1 : -1, x < CHUNK_SIZE_X - 1 ? current + 1 : -1,
        z > 0 ? current - CHUNK_SIZE_X : -1, z < CHUNK_SIZE_Z - 1 ? current + CHUNK_SIZE_X : -1,
        y > 0 ? current - layer : -1, y < CHUNK_SIZE_Y - 1 ? current + layer : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || labels[neighbor] || !chunk.blocks[neighbor]) continue;
        labels[neighbor] = label;
        queue[tail++] = neighbor;
      }
      if ((head & 255) === 0) yield;
    }
    if (!touchesBoundary) detached.add(label);
  }
  if (detached.size === 0) return null;
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  if (!normal) return null;
  const index = geometry.index;
  const selected: number[] = [], retained: number[] = [];
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  for (let i = 0; i < (index?.count ?? position.count); i += 3) {
    const a = index ? index.getX(i) : i;
    const b = index ? index.getX(i + 1) : i + 1;
    const c = index ? index.getX(i + 2) : i + 2;
    const x = Math.floor((position.getX(a) + position.getX(b) + position.getX(c)) / 3 - normal.getX(a) * 0.01);
    const y = Math.floor((position.getY(a) + position.getY(b) + position.getY(c)) / 3 - normal.getY(a) * 0.01);
    const z = Math.floor((position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3 - normal.getZ(a) * 0.01);
    if (detached.has(labels[Chunk.getIndex(x, y, z)])) {
      selected.push(a, b, c);
      for (const vertex of [a, b, c]) bounds.expandByPoint(point.fromBufferAttribute(position, vertex));
    } else retained.push(a, b, c);
    if ((i % 384) === 0) yield;
  }
  // An extra draw call for one or two cubes costs more than their saved faces.
  // Batch a useful amount of disconnected block geometry into one impostor.
  if (selected.length < 64 * 3) return null;
  const subset = (indices: number[]) => {
    const result = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(geometry.attributes)) result.setAttribute(name, attribute);
    result.setIndex(indices);
    return result;
  };
  const helper = new THREE.Mesh(subset(selected), mesh.material);
  return { helper, remainder: subset(retained), bounds };
}

interface Entry {
  chunk: Chunk;
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  version: number;
  job: Generator<void, DetachedPart | null> | null;
  part: DetachedPart | null;
  seen: number;
}

export class DetachedBlockImpostors {
  private entries = new Map<Chunk, Entry>();
  private frame = 0;

  private disposeEntry(entry: Entry) {
    entry.job?.return(null);
    entry.part?.helper.geometry.dispose();
    entry.part?.remainder.dispose();
    this.entries.delete(entry.chunk);
  }

  *sources(world: any, camera: THREE.Vector3, budgetMs = 1): Generator<ImpostorSource> {
    this.frame++;
    const started = performance.now();
    for (const key of world.activeChunkKeys || []) {
      const chunk: Chunk = world.chunks.get(key);
      const group = chunk?.mesh as THREE.Group;
      const mesh = group?.children.find(child => (child as THREE.Mesh).isMesh) as THREE.Mesh;
      if (!mesh) continue;
      let entry = this.entries.get(chunk);
      if (entry && (entry.geometry !== mesh.geometry || entry.mesh !== mesh || entry.version !== chunk.dataVersion)) {
        this.disposeEntry(entry);
        entry = undefined;
      }
      if (entry) entry.seen = this.frame;
      if (!entry) {
        if (!group.visible || !chunk.hasUserEdits || chunk.publishedDataVersion !== chunk.dataVersion) continue;
        const x = unwrapPeriodicNear(camera.x, chunk.cx * CHUNK_SIZE_X + 8, TORUS_SIZE_X);
        const z = unwrapPeriodicNear(camera.z, chunk.cz * CHUNK_SIZE_Z + 8, TORUS_SIZE_Z);
        if (Math.hypot(x - chunk.cx * CHUNK_SIZE_X - 8, z - chunk.cz * CHUNK_SIZE_Z - 8) < IMPOSTOR_DISTANCE) continue;
        if (this.entries.size >= 128) continue;
        entry = { chunk, mesh, geometry: mesh.geometry, version: chunk.dataVersion, job: separateDetachedBlocks(chunk, mesh), part: null, seen: this.frame };
        this.entries.set(chunk, entry);
      }
      while (entry.job && performance.now() - started < budgetMs) {
        const next = entry.job.next();
        if (next.done) { entry.job = null; entry.part = next.value; }
      }
      if (!entry.part) continue;
      const { helper, remainder, bounds } = entry.part;
      const originalGeometry = entry.geometry;
      yield {
        key: helper, parent: group, meshes: [helper], bounds, visible: group.visible,
        onShow: () => {
          mesh.geometry = remainder;
          return () => { mesh.geometry = originalGeometry; };
        },
      };
    }
    for (const entry of this.entries.values()) if (entry.seen !== this.frame) this.disposeEntry(entry);
  }

  dispose() {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
  }
}
