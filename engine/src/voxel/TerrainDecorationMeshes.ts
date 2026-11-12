import * as THREE from 'three/webgpu';
import {
  createDecorationGroup,
  editDecorationGroup,
  raycastDecorationGroup,
  syncDecorationMeshTransform,
} from '../contraption/DecorationMeshes.ts';
import { anchoredDecorationCenter, type DecorationDefinition } from '../contraption/Decorations.ts';
import { hookSceneMaterials, TORUS_SIZE_X, TORUS_SIZE_Z, unbendPointForView, unwrapPeriodicNear } from '../torus/TorusWorld.ts';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z } from './Chunk.ts';
import type { TerrainDecoration, TerrainDecorationLayer } from './TerrainDecorationLayer.ts';

const ORIGIN = new THREE.Vector3();
// Offset (16) plus the half-diagonal of a 16 m cube.
const DECORATION_REACH = 16 + 8 * Math.sqrt(3);

/** Render form: the world-space cube centre of a terrain decoration. */
export function terrainDecorationRenderValue(value: TerrainDecoration): DecorationDefinition {
  return {
    id: value.id, color: value.color,
    ...(value.materialId ? { materialId: value.materialId } : {}),
    position: anchoredDecorationCenter([value.x, value.y, value.z], value.position),
    ...(value.rotation ? { rotation: value.rotation } : {}),
    ...(value.scale ? { scale: value.scale } : {}),
  };
}

export type TerrainDecorationHit = {
  decoration: TerrainDecoration;
  distance: number;
  point: THREE.Vector3;
  worldNormal: THREE.Vector3;
};

/**
 * One instanced decoration group per chunk. Groups follow layer changes
 * incrementally and are only visible while their chunk is in the near AOI.
 */
export class TerrainDecorationMeshes {
  readonly group = new THREE.Group();
  private readonly chunks = new Map<string, { group: THREE.Group; ids: Set<string> }>();
  private readonly dirty = new Set<string>();
  private readonly unsubscribe: () => void;
  private selection: Pick<TerrainDecoration, 'x' | 'z' | 'id'> | null = null;
  private outline: THREE.LineSegments | null = null;
  private activeKeys: ReadonlySet<string> | null = null;

  private readonly layer: TerrainDecorationLayer;

  constructor(layer: TerrainDecorationLayer) {
    this.layer = layer;
    this.group.name = 'TerrainDecorations';
    this.unsubscribe = layer.onChange(chunkKey => this.dirty.add(chunkKey));
    for (const chunkKey of layer.chunkKeys()) this.dirty.add(chunkKey);
  }

  /** Apply pending layer changes and near-AOI visibility. */
  sync(activeChunkKeys: ReadonlySet<string> | null = this.activeKeys) {
    this.activeKeys = activeChunkKeys;
    for (const chunkKey of this.dirty) this.rebuild(chunkKey);
    this.dirty.clear();
    for (const [chunkKey, entry] of this.chunks) entry.group.visible = !activeChunkKeys || activeChunkKeys.has(chunkKey);
    this.updateOutline();
  }

  private rebuild(chunkKey: string) {
    let entry = this.chunks.get(chunkKey);
    const values = [...this.layer.forChunkKey(chunkKey)];
    if (!values.length) {
      if (entry) {
        this.disposeGroup(entry.group);
        this.chunks.delete(chunkKey);
      }
      return;
    }
    if (!entry) {
      const group = createDecorationGroup(values.map(terrainDecorationRenderValue), ORIGIN);
      group.name = `TerrainDecorations:${chunkKey}`;
      entry = { group, ids: new Set(values.map(value => value.id)) };
      this.chunks.set(chunkKey, entry);
      this.group.add(group);
      return;
    }
    const next = new Set(values.map(value => value.id));
    for (const id of entry.ids) if (!next.has(id)) editDecorationGroup(entry.group, id, undefined, ORIGIN);
    for (const value of values) editDecorationGroup(entry.group, value.id, terrainDecorationRenderValue(value), ORIGIN);
    entry.ids = next;
  }

  private disposeGroup(group: THREE.Group) {
    group.removeFromParent();
    group.traverse(object => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose?.();
      (mesh.material as THREE.Material | undefined)?.dispose?.();
    });
  }

  handleFor(value: Pick<TerrainDecoration, 'x' | 'z' | 'id'>) {
    const chunkKey = `${Math.floor(value.x / CHUNK_SIZE_X)},${Math.floor(value.z / CHUNK_SIZE_Z)}`;
    const group = this.chunks.get(chunkKey)?.group;
    return group?.children.find(object => object.userData.decorationId === value.id) as THREE.Mesh | undefined;
  }

  /** Editor-only pose used while dragging; the stored value is unchanged. */
  previewTransform(value: TerrainDecoration, preview: TerrainDecoration) {
    const mesh = this.handleFor(value);
    if (!mesh) return;
    const render = terrainDecorationRenderValue(preview);
    mesh.position.fromArray(render.position!);
    mesh.quaternion.fromArray(render.rotation || [0, 0, 0, 1]);
    mesh.scale.fromArray(render.scale || [1, 1, 1]);
    syncDecorationMeshTransform(mesh);
    this.updateOutline();
  }

  setSelection(value: Pick<TerrainDecoration, 'x' | 'z' | 'id'> | null) {
    this.selection = value ? { x: value.x, z: value.z, id: value.id } : null;
    this.updateOutline();
  }

  private updateOutline() {
    const mesh = this.selection ? this.handleFor(this.selection) : undefined;
    if (!mesh) {
      if (this.outline) this.outline.visible = false;
      return;
    }
    if (!this.outline) {
      this.outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
        new THREE.LineBasicNodeMaterial({ color: 0x5cff5c, depthTest: false, depthWrite: false, fog: false, toneMapped: false }));
      this.outline.name = 'TerrainDecorationSelection';
      this.outline.renderOrder = 95;
      hookSceneMaterials(this.outline);
      this.group.add(this.outline);
    }
    this.outline.visible = mesh.parent?.visible !== false;
    this.outline.position.copy(mesh.position);
    this.outline.quaternion.copy(mesh.quaternion);
    this.outline.scale.copy(mesh.scale);
  }

  /** Nearest visible decoration along a bent-view ray (the editor's pick ray). */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance = 16, bent = true): TerrainDecorationHit | null {
    const flat = bent ? unbendPointForView(origin.x, origin.y, origin.z) : origin;
    const reach = maxDistance + DECORATION_REACH;
    let closest: TerrainDecorationHit | null = null;
    for (const [chunkKey, entry] of this.chunks) {
      if (!entry.group.visible) continue;
      const [cx, cz] = chunkKey.split(',').map(Number);
      const minX = unwrapPeriodicNear(cx * CHUNK_SIZE_X, flat.x - CHUNK_SIZE_X / 2, TORUS_SIZE_X);
      const minZ = unwrapPeriodicNear(cz * CHUNK_SIZE_Z, flat.z - CHUNK_SIZE_Z / 2, TORUS_SIZE_Z);
      const dx = Math.max(minX - flat.x, 0, flat.x - minX - CHUNK_SIZE_X);
      const dz = Math.max(minZ - flat.z, 0, flat.z - minZ - CHUNK_SIZE_Z);
      if (dx * dx + dz * dz > reach * reach) continue;
      const hit = raycastDecorationGroup(entry.group, origin, direction, closest?.distance ?? maxDistance, bent);
      if (!hit) continue;
      const decoration = [...this.layer.forChunkKey(chunkKey)].find(value => value.id === hit.decorationId);
      if (decoration) closest = { decoration, distance: hit.distance, point: hit.point, worldNormal: hit.worldNormal };
    }
    return closest;
  }

  dispose() {
    this.unsubscribe();
    for (const entry of this.chunks.values()) this.disposeGroup(entry.group);
    this.chunks.clear();
    this.outline?.geometry.dispose();
    (this.outline?.material as THREE.Material | undefined)?.dispose();
    this.group.removeFromParent();
  }
}
