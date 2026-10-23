import * as THREE from 'three';
import { MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import { toMicroPlacementItem } from '../inventory/InventoryMicroPlacement.ts';
import { getEntityPlacementShape } from '../inventory/InventoryPlacementGeometry.ts';
import { TransformGizmo, transformAxis, transformGizmoSize, transformScreenPoint, transformViewCamera,
  type TransformAxis, type TransformHandle } from '../render/TransformGizmo.ts';
import { SpecialTool } from './ControlBindings.ts';
import type { PlayerController } from './PlayerController.ts';

export type HammerPlacementPose = NonNullable<ReturnType<PlayerController['getInventoryPlacementPose']>>;

/** Holds construction outside the world until the player confirms the adjusted pose. */
export class HammerPlacementSession {
  pose: HammerPlacementPose | null = null;
  private installAsComponent = false;
  private gizmo: TransformGizmo | null = null;
  private hovered: TransformHandle | null = null;
  private center = new THREE.Vector3();
  private axesRotation = new THREE.Quaternion();
  private drag: { start: THREE.Vector2; position: THREE.Vector3; axis: TransformAxis;
    delta: THREE.Vector2; screenVector: THREE.Vector2; size: number } | null = null;
  private controller: PlayerController;

  constructor(controller: PlayerController) { this.controller = controller; }

  get isDragging() { return this.drag !== null; }

  private get installationTarget() {
    const slot = this.pose?.slot;
    if (!slot || slot.kind === 'blockset' || (slot.kind === 'item' && (slot.blockSet || slot.entityList?.length !== 1))) return null;
    return this.pose?.targetContraption ?? null;
  }

  begin(installAsComponent = false) {
    const c = this.controller;
    if (this.pose) return true;
    if (c.activeTool !== SpecialTool.HAMMER || c.bulkEditJob || c.worldPickingSuspended || c.ui?.hasAnyModalOpen?.()) return false;
    if (c.handleRunningEntityInteraction(c.hoveredContraptionHit?.contraption)) return false;
    const slot = c.getActiveHammerInventoryItem();
    if (!slot) { c.ui?.showToast?.('Item slot is empty or cannot be prepared for placement'); return false; }
    const pose = c.getInventoryPlacementPose(slot);
    if (!pose) { c.ui?.showToast?.('Point at a surface to preview placement'); return false; }
    this.pose = { ...pose, position: pose.position.clone(), quaternion: pose.quaternion?.clone() };
    this.axesRotation.copy(this.installationTarget
      ? this.installationTarget.getEntityNodeWorldQuaternion(pose.targetNodeId)
      : new THREE.Quaternion());
    this.installAsComponent = installAsComponent;
    const shape = getEntityPlacementShape(pose.slot);
    this.center.set(shape?.centerX || 0, shape ? (shape.minY + shape.maxY) / 2 : 0, shape?.centerZ || 0);
    c.updateInventoryPlacementPreview();
    c.ui?.refresh?.();
    c.ui?.showToast?.(`Aim at an XYZ axis and hold LMB to drag · ${c.hammerMicroMode ? 'MICRO' : 'STD'} grid · Enter confirms · RMB cancels`);
    return true;
  }

  cancel(resume = true) {
    if (!this.pose) return false;
    this.pose = null;
    this.endDrag();
    this.gizmo?.dispose();
    this.gizmo = null;
    if (this.controller.sceneRenderer) this.controller.sceneRenderer.hammerPlacementGizmo = undefined;
    this.controller.inventoryPlacementPreview = null;
    this.controller.sceneRenderer?.setInventoryPlacementPreview?.(null);
    this.controller.ui?.refresh?.();
    if (resume) void this.controller.requestLock();
    return true;
  }

  confirm() {
    const c = this.controller;
    if (!this.pose || c.worldPickingSuspended || c.ui?.hasAnyModalOpen?.() || c.bulkEditJob) return false;
    const target = this.installationTarget;
    if (target && (!c.contraptions?.contraptions.includes(target) || !target.getEntityNode(this.pose.targetNodeId)
      || !target.canEditInternalSelection())) {
      c.ui?.showToast?.('The placement target is unavailable or running · RMB cancels');
      return false;
    }
    let slot = this.pose.slot;
    // World standard cells cannot have fractional origins. Subdivide only static
    // geometry when needed, retaining its size and all authored entity data.
    if (this.pose.position.toArray().some(value => Math.abs(value - Math.round(value)) > 1e-6)) {
      try {
        if (slot.kind === 'blockset') slot = toMicroPlacementItem(slot);
        else if (slot.blockSet) slot = { ...slot, blockSet: toMicroPlacementItem(slot.blockSet) };
      } catch (error) {
        c.ui?.showToast?.(error instanceof Error ? error.message : 'Cannot place this item on the micro grid');
        return false;
      }
    }
    const pose = { ...this.pose, slot, position: this.pose.position.clone(), quaternion: this.pose.quaternion?.clone() };
    if (!c.pasteInventorySlot(this.installAsComponent, pose)) return false;
    this.cancel(false);
    void c.requestLock();
    return true;
  }

  /** Snap the displacement, preserving the original surface/mounting alignment. */
  moveAlongAxis(axis: TransformAxis, distance: number, origin = this.pose?.position.clone()) {
    if (!this.pose || !origin || !Number.isFinite(distance)) return false;
    const step = this.controller.hammerMicroMode ? MICRO_SIZE : 1;
    this.pose.position.copy(origin).addScaledVector(transformAxis(axis).applyQuaternion(this.axesRotation), Math.round(distance / step) * step);
    this.controller.updateInventoryPlacementPreview();
    return true;
  }

  update() {
    const c = this.controller;
    if (!this.pose) return;
    if (c.activeTool !== SpecialTool.HAMMER || c.worldPickingSuspended || c.ui?.hasAnyModalOpen?.()) {
      this.cancel(false);
      return;
    }
    if (!c.sceneRenderer?.scene || !c.camera) return;
    if (!this.gizmo) {
      this.gizmo = new TransformGizmo({ includeScale: false, includeRotate: false, name: 'HammerPlacementGizmo' });
      c.sceneRenderer.scene.add(this.gizmo.group);
      c.sceneRenderer.hammerPlacementGizmo = this.gizmo.group;
    }
    const position = this.center.clone().applyQuaternion(this.pose.quaternion || new THREE.Quaternion()).add(this.pose.position);
    const size = this.drag?.size || transformGizmoSize(position, c.camera.position);
    this.gizmo.setPose(position, this.axesRotation, size, this.hovered?.key);
    if (c.isLocked && !this.drag) {
      this.hovered = this.pickHandle(new THREE.Vector2());
      this.gizmo.setPose(position, this.axesRotation, size, this.hovered?.key);
    }
  }

  private pickHandle(pointer: THREE.Vector2) {
    if (!this.gizmo?.group.visible) return null;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, transformViewCamera(this.controller.camera));
    return this.gizmo.pick(raycaster.ray);
  }

  private viewport() {
    const rect = this.controller.sceneRenderer?.renderer?.domElement?.getBoundingClientRect();
    return { left: rect?.left || 0, top: rect?.top || 0,
      width: rect?.width || globalThis.innerWidth || 1, height: rect?.height || globalThis.innerHeight || 1 };
  }

  private isSceneEvent(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    return !target || (typeof document !== 'undefined' && target === document.body) || !!target.closest?.('#canvas-container');
  }

  pointerMove(event: MouseEvent) {
    this.update();
    if (this.drag && this.pose) {
      if (this.controller.isLocked) {
        this.drag.delta.x += Number(event.movementX) || 0;
        this.drag.delta.y += Number(event.movementY) || 0;
      } else {
        this.drag.delta.set(event.clientX, event.clientY).sub(this.drag.start);
      }
      const distance = this.drag.delta.dot(this.drag.screenVector) / this.drag.screenVector.lengthSq();
      this.moveAlongAxis(this.drag.axis, distance, this.drag.position);
      return true;
    }
    this.hovered = null;
    if (this.isSceneEvent(event) && this.gizmo?.group.visible) {
      const { left, top, width, height } = this.viewport();
      this.hovered = this.pickHandle(this.controller.isLocked ? new THREE.Vector2()
        : new THREE.Vector2((event.clientX - left) / width * 2 - 1, -(event.clientY - top) / height * 2 + 1));
    }
    this.update();
    return !!this.hovered;
  }

  pointerDown(event: MouseEvent) {
    if (!this.pose || !this.isSceneEvent(event)) return false;
    if (event.button === 2) return this.cancel();
    if (event.button !== 0) return true;
    this.pointerMove(event);
    const group = this.gizmo?.group, handle = this.hovered;
    if (!group || !handle || !this.pose) return true;
    const camera = transformViewCamera(this.controller.camera);
    const { width, height } = this.viewport();
    const axis = transformAxis(handle.axis).applyQuaternion(this.axesRotation);
    const screenVector = transformScreenPoint(group.position.clone().add(axis), camera, width, height)
      .sub(transformScreenPoint(group.position, camera, width, height));
    if (screenVector.length() < 2) return true;
    this.drag = { start: new THREE.Vector2(event.clientX, event.clientY), position: this.pose.position.clone(),
      axis: handle.axis, delta: new THREE.Vector2(), screenVector, size: group.scale.x };
    return true;
  }

  endDrag() { this.drag = null; this.hovered = null; }
}
