import * as THREE from 'three';
import type { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import type { InventoryBlockSet } from '@entropydrop/space-engine/storage/InventoryTypes.ts';
import { CHUNK_SIZE_Y } from '@entropydrop/space-engine/voxel/Chunk.ts';
import { MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import { VoxelMaterialIds } from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';
import { toMicroPlacementItem } from '../inventory/InventoryMicroPlacement.ts';
import type { InventoryPlacementPreview } from '../render/PreviewTypes.ts';
import { voxelizeText, type TextVoxelOptions, type TextVoxelResult } from '../voxel/TextVoxelizer.ts';

export interface TextCreationAnchor {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  forward: THREE.Vector3;
  target: Contraption | null;
  nodeId: string;
}
export interface TextPlacement { slot: InventoryBlockSet; position: THREE.Vector3 }
export type TextOrientation = 'vertical' | 'horizontal';
export interface TextCreationOptions extends TextVoxelOptions { orientation: TextOrientation }
export interface TextCreationView extends TextCreationOptions {
  open: boolean; busy: boolean; error: string | null; blockCount: number;
  width: number; height: number; canCreate: boolean;
  offsetX: number; offsetY: number; offsetZ: number;
}
export const EMPTY_TEXT_CREATION: TextCreationView = Object.freeze({
  open: false, text: 'Text', fontSize: 12, color: 0xffffff, micro: true,
  materialId: VoxelMaterialIds.DEFAULT,
  orientation: 'vertical',
  busy: false, error: null, blockCount: 0, width: 0, height: 0, canCreate: false,
  offsetX: 0, offsetY: 0, offsetZ: 0,
});

function axisNormal(value: THREE.Vector3) {
  const axis = Math.abs(value.x) > Math.abs(value.y)
    ? (Math.abs(value.x) > Math.abs(value.z) ? 'x' : 'z')
    : (Math.abs(value.y) > Math.abs(value.z) ? 'y' : 'z');
  return new THREE.Vector3().setComponent(axis === 'x' ? 0 : axis === 'y' ? 1 : 2, value[axis] < 0 ? -1 : 1);
}

/** Orient the stencil in the target's construction grid and keep it outside the focused surface. */
export function placeTextOnSurface(result: TextVoxelResult, anchor: TextCreationAnchor, orientation?: TextOrientation): TextPlacement {
  const surfaceNormal = axisNormal(anchor.normal);
  const horizontal = orientation ? orientation === 'horizontal' : Math.abs(surfaceNormal.y) > 0.5;
  const normal = horizontal ? new THREE.Vector3(0, surfaceNormal.y < 0 ? -1 : 1, 0)
    : Math.abs(surfaceNormal.y) < 0.5 ? surfaceNormal
      : axisNormal(new THREE.Vector3(-anchor.forward.x, 0, -anchor.forward.z));
  const up = Math.abs(normal.y) < 0.5 ? new THREE.Vector3(0, 1, 0)
    : Math.abs(anchor.forward.x) > Math.abs(anchor.forward.z)
      ? new THREE.Vector3(anchor.forward.x < 0 ? -1 : 1, 0, 0)
      : new THREE.Vector3(0, 0, anchor.forward.z < 0 ? -1 : 1);
  const right = up.clone().cross(normal).normalize();
  const rotation = new THREE.Matrix4().makeBasis(right, up, normal);
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const size = result.cellSize;
  const blocks = result.slot.blocks.map(block => {
    const point = new THREE.Vector3(block.dx + size / 2, block.dy + size / 2, size / 2)
      .applyMatrix4(rotation).addScalar(-size / 2);
    for (const axis of ['x', 'y', 'z'] as const) point[axis] = Math.round(point[axis] / size) * size || 0;
    min.min(point); max.max(point.clone().addScalar(size));
    return { ...block, dx: point.x, dy: point.y, dz: point.z };
  });
  const position = anchor.point.clone().addScaledVector(right, -result.width / 2);
  for (const axis of ['x', 'y', 'z'] as const) {
    let value = normal[axis] > 0 ? anchor.point[axis] - min[axis]
      : normal[axis] < 0 ? anchor.point[axis] - max[axis] : position[axis];
    // A plane facing a different direction must still stay on the empty side
    // of the original hit, including standing on floors and below ceilings.
    if (surfaceNormal[axis] > 0) value = Math.max(value, anchor.point[axis] - min[axis]);
    if (surfaceNormal[axis] < 0) value = Math.min(value, anchor.point[axis] - max[axis]);
    const snapNormal = normal[axis] || surfaceNormal[axis];
    position[axis] = (snapNormal > 0 ? Math.ceil(value / size - 1e-6)
      : snapNormal < 0 ? Math.floor(value / size + 1e-6) : Math.round(value / size)) * size || 0;
  }
  if (!anchor.target && (position.y + min.y < 0 || position.y + max.y > CHUNK_SIZE_Y)) {
    throw new Error('Text extends beyond the world height. Pick another surface or reduce its size.');
  }
  return { slot: { ...result.slot, blocks }, position };
}

interface TextCreationHost {
  refresh(): void;
  unlock(): void;
  requestLock(): unknown;
  canEdit(anchor: TextCreationAnchor): boolean;
  preview(anchor: TextCreationAnchor, placement: TextPlacement): InventoryPlacementPreview;
  build(anchor: TextCreationAnchor, placement: TextPlacement): boolean;
}

/** Holds a frozen focus anchor while the player edits a live voxel text preview. */
export class TextCreationSession {
  private state: TextCreationView = { ...EMPTY_TEXT_CREATION };
  private anchor: TextCreationAnchor | null = null;
  private placement: TextPlacement | null = null;
  private basePlacement: TextPlacement | null = null;
  private bounds = new THREE.Box3();
  private microSlot: InventoryBlockSet | Error | null = null;
  private generation = 0;
  ready: Promise<void> = Promise.resolve();
  private host: TextCreationHost;
  private voxelize: typeof voxelizeText;
  constructor(host: TextCreationHost, voxelize = voxelizeText) {
    this.host = host;
    this.voxelize = voxelize;
  }
  get isOpen() { return this.state.open; }
  get view(): TextCreationView {
    const editable = !this.anchor || this.host.canEdit(this.anchor);
    return { ...this.state, error: this.state.open && !editable ? 'The target is no longer editable. Close and pick a stopped entity.' : this.state.error,
      canCreate: this.state.open && !this.state.busy && !this.state.error && !!this.placement && editable };
  }
  open(anchor: TextCreationAnchor, color: number, micro = EMPTY_TEXT_CREATION.micro) {
    if (!this.host.canEdit(anchor)) return false;
    this.anchor = { ...anchor, point: anchor.point.clone(), normal: anchor.normal.clone(), forward: anchor.forward.clone() };
    this.state = { ...this.state, open: true, color, micro, offsetX: 0, offsetY: 0, offsetZ: 0 };
    this.host.unlock();
    this.ready = this.regenerate();
    return true;
  }
  edit(patch: Partial<TextCreationOptions>) {
    this.state = { ...this.state, ...patch };
    if (this.state.open) this.ready = this.regenerate();
  }
  private async regenerate() {
    const revision = ++this.generation;
    this.placement = null;
    this.basePlacement = null;
    this.microSlot = null;
    this.state = { ...this.state, busy: true, error: null, blockCount: 0 };
    this.host.refresh();
    try {
      const result = await this.voxelize({ ...this.state });
      if (revision !== this.generation || !this.anchor || !this.state.open) return;
      this.basePlacement = placeTextOnSurface(result, this.anchor, this.state.orientation);
      this.bounds.makeEmpty();
      for (const block of this.basePlacement.slot.blocks) {
        const point = new THREE.Vector3(block.dx, block.dy, block.dz);
        this.bounds.expandByPoint(point);
        this.bounds.expandByPoint(point.addScalar(block.size || 1));
      }
      this.state = { ...this.state, busy: false, blockCount: result.slot.blockCount, width: result.width, height: result.height };
      this.updatePlacement();
    } catch (error) {
      if (revision !== this.generation) return;
      this.state = { ...this.state, busy: false, error: error instanceof Error ? error.message : 'Text preview failed.' };
    }
    this.host.refresh();
  }
  getPreview(): InventoryPlacementPreview | null {
    // Keep an over-limit standard preview draggable so moving back to a whole
    // cell can recover without discarding the text.
    return this.state.open && this.anchor && this.placement && this.host.canEdit(this.anchor)
      ? this.host.preview(this.anchor, this.placement) : null;
  }
  get offset() { return new THREE.Vector3(this.state.offsetX, this.state.offsetY, this.state.offsetZ); }
  setOffset(offset: THREE.Vector3) {
    if (!this.state.open || !this.basePlacement || !this.anchor || !this.host.canEdit(this.anchor)
      || !offset.toArray().every(Number.isFinite)) return false;
    const snapped = offset.clone().divideScalar(MICRO_SIZE).round().multiplyScalar(MICRO_SIZE);
    this.state = { ...this.state, offsetX: snapped.x || 0, offsetY: snapped.y || 0, offsetZ: snapped.z || 0 };
    this.updatePlacement();
    this.host.refresh();
    return true;
  }
  private updatePlacement() {
    if (!this.basePlacement || !this.anchor) return;
    const position = this.basePlacement.position.clone().add(this.offset);
    if (!this.anchor.target) {
      position.y = THREE.MathUtils.clamp(position.y, -this.bounds.min.y, CHUNK_SIZE_Y - this.bounds.max.y) || 0;
      this.state.offsetY = position.y - this.basePlacement.position.y;
    }
    let slot = this.basePlacement.slot;
    this.state.error = null;
    if (!this.state.micro && position.toArray().some(value => !Number.isInteger(value))) {
      // Standard cells at fractional origins must be subdivided to preserve
      // the displayed shape on the world's and component's micro grids.
      if (!this.microSlot) {
        try { this.microSlot = toMicroPlacementItem(slot); }
        catch (error) { this.microSlot = error instanceof Error ? error : new Error('Micro construction failed.'); }
      }
      if (this.microSlot instanceof Error) this.state.error = this.microSlot.message;
      else slot = this.microSlot;
    }
    this.placement = { slot, position };
    this.state.blockCount = slot.blockCount;
  }
  create() {
    if (!this.view.canCreate || !this.anchor || !this.placement) return false;
    const accepted = this.host.build(this.anchor, this.placement);
    if (accepted) this.close(true);
    return accepted;
  }
  close(resume = true) {
    this.generation++;
    this.placement = null;
    this.basePlacement = null;
    this.microSlot = null;
    this.state = { ...this.state, open: false, busy: false };
    this.host.refresh();
    if (resume) void this.host.requestLock();
  }
}
