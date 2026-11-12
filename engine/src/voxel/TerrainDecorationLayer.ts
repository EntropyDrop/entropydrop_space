import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from './Chunk.ts';
import { wrapX, wrapZ } from '../torus/TorusWorld.ts';
import {
  normalizeTerrainDecoration,
  type TerrainDecorationDefinition,
} from '../contraption/Decorations.ts';

export type TerrainDecoration = Readonly<TerrainDecorationDefinition>;

const cellKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

export function terrainDecorationChunkKey(x: number, z: number) {
  return `${Math.floor(wrapX(x) / CHUNK_SIZE_X)},${Math.floor(wrapZ(z) / CHUNK_SIZE_Z)}`;
}

/** Wrap the anchor onto the torus and validate the closed decoration shape. */
export function normalizeWorldTerrainDecoration(value: unknown): TerrainDecoration {
  const decoration = normalizeTerrainDecoration(value);
  if (decoration.y < 0 || decoration.y >= CHUNK_SIZE_Y) throw new Error('Terrain decoration anchor is outside the world height.');
  return Object.freeze({ ...decoration, x: Math.floor(wrapX(decoration.x)), z: Math.floor(wrapZ(decoration.z)) });
}

/** Parse the server/storage object form, which names the material `material`. */
export function parseStoredTerrainDecoration(value: any): TerrainDecoration | null {
  if (!value || typeof value !== 'object') return null;
  try {
    const { material, ...rest } = value;
    return normalizeWorldTerrainDecoration({ ...rest, materialId: rest.materialId ?? material ?? 0 });
  } catch {
    return null;
  }
}

/** Server/storage object form; default transforms and material are omitted. */
export function storedTerrainDecoration(value: TerrainDecoration) {
  return {
    id: value.id, x: value.x, y: value.y, z: value.z, color: value.color,
    ...(value.materialId ? { material: value.materialId } : {}),
    ...(value.position ? { position: [...value.position] } : {}),
    ...(value.rotation ? { rotation: [...value.rotation] } : {}),
    ...(value.scale ? { scale: [...value.scale] } : {}),
  };
}

export function terrainDecorationsEqual(left: TerrainDecoration | undefined, right: TerrainDecoration | undefined) {
  if (!left || !right) return left === right;
  return JSON.stringify(storedTerrainDecoration(left)) === JSON.stringify(storedTerrainDecoration(right));
}

type Listener = (chunkKey: string) => void;

/**
 * Visual cubes bound to standard terrain voxels. A decoration lives in the chunk
 * of its anchor voxel, has an id unique in that chunk and is removed with that
 * voxel. Values are frozen; edits replace them.
 */
export class TerrainDecorationLayer {
  private readonly byChunk = new Map<string, Map<string, TerrainDecoration>>();
  private readonly byAnchor = new Map<string, Set<TerrainDecoration>>();
  private readonly listeners = new Set<Listener>();
  /** Increments on every visible change. */
  version = 0;

  onChange(listener: Listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(chunkKey: string) {
    this.version++;
    for (const listener of this.listeners) listener(chunkKey);
  }

  chunkKeys() {
    return this.byChunk.keys();
  }

  forChunkKey(chunkKey: string): Iterable<TerrainDecoration> {
    return this.byChunk.get(chunkKey)?.values() ?? [];
  }

  forChunk(cx: number, cz: number) {
    return this.forChunkKey(`${cx},${cz}`);
  }

  countInChunkOf(x: number, z: number) {
    return this.byChunk.get(terrainDecorationChunkKey(x, z))?.size ?? 0;
  }

  get(x: number, z: number, id: string) {
    return this.byChunk.get(terrainDecorationChunkKey(x, z))?.get(id);
  }

  atAnchor(x: number, y: number, z: number): TerrainDecoration[] {
    return [...(this.byAnchor.get(cellKey(Math.floor(wrapX(x)), y, Math.floor(wrapZ(z)))) ?? [])];
  }

  *all(): IterableIterator<TerrainDecoration> {
    for (const chunk of this.byChunk.values()) yield* chunk.values();
  }

  get size() {
    let count = 0;
    for (const chunk of this.byChunk.values()) count += chunk.size;
    return count;
  }

  private detach(chunk: Map<string, TerrainDecoration>, value: TerrainDecoration) {
    chunk.delete(value.id);
    const key = cellKey(value.x, value.y, value.z);
    const anchored = this.byAnchor.get(key);
    anchored?.delete(value);
    if (anchored?.size === 0) this.byAnchor.delete(key);
  }

  private attach(chunk: Map<string, TerrainDecoration>, value: TerrainDecoration) {
    chunk.set(value.id, value);
    const key = cellKey(value.x, value.y, value.z);
    let anchored = this.byAnchor.get(key);
    if (!anchored) this.byAnchor.set(key, anchored = new Set());
    anchored.add(value);
  }

  /** Insert or replace by id within the anchor's chunk. Returns the stored value. */
  upsert(input: unknown): TerrainDecoration {
    const value = normalizeWorldTerrainDecoration(input);
    const chunkKey = terrainDecorationChunkKey(value.x, value.z);
    let chunk = this.byChunk.get(chunkKey);
    const previous = chunk?.get(value.id);
    if (previous && terrainDecorationsEqual(previous, value)) return previous;
    if (!chunk) this.byChunk.set(chunkKey, chunk = new Map());
    if (previous) this.detach(chunk, previous);
    this.attach(chunk, value);
    this.changed(chunkKey);
    return value;
  }

  remove(x: number, z: number, id: string): TerrainDecoration | null {
    const chunkKey = terrainDecorationChunkKey(x, z);
    const chunk = this.byChunk.get(chunkKey);
    const previous = chunk?.get(id);
    if (!chunk || !previous) return null;
    this.detach(chunk, previous);
    if (chunk.size === 0) this.byChunk.delete(chunkKey);
    this.changed(chunkKey);
    return previous;
  }

  /** Removing a standard voxel removes every decoration bound to it. */
  removeAtAnchor(x: number, y: number, z: number): TerrainDecoration[] {
    const removed = this.atAnchor(x, y, z);
    if (!removed.length) return removed;
    const chunkKey = terrainDecorationChunkKey(removed[0].x, removed[0].z);
    const chunk = this.byChunk.get(chunkKey)!;
    for (const value of removed) this.detach(chunk, value);
    if (chunk.size === 0) this.byChunk.delete(chunkKey);
    this.changed(chunkKey);
    return removed;
  }

  /** Replace one chunk's decorations from an authoritative snapshot. */
  replaceChunk(chunkKey: string, values: Iterable<TerrainDecoration>) {
    const previous = this.byChunk.get(chunkKey);
    const next = new Map<string, TerrainDecoration>();
    for (const value of values) {
      if (terrainDecorationChunkKey(value.x, value.z) === chunkKey) next.set(value.id, value);
    }
    if (previous && previous.size === next.size
      && [...next.values()].every(value => terrainDecorationsEqual(previous.get(value.id), value))) return false;
    if (previous) for (const value of [...previous.values()]) this.detach(previous, value);
    this.byChunk.delete(chunkKey);
    if (next.size) {
      const chunk = new Map<string, TerrainDecoration>();
      this.byChunk.set(chunkKey, chunk);
      for (const value of next.values()) this.attach(chunk, value);
    }
    if (previous || next.size) this.changed(chunkKey);
    return true;
  }

  clear() {
    const keys = [...this.byChunk.keys()];
    this.byChunk.clear();
    this.byAnchor.clear();
    for (const key of keys) this.changed(key);
  }
}
