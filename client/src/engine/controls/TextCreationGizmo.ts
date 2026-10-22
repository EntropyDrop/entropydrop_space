import * as THREE from 'three';
import type { InventoryInput } from '@entropydrop/space-engine/storage/InventoryTypes.ts';
import { TransformGizmo, transformAxis, transformGizmoSize, transformScreenPoint, transformViewCamera,
  type TransformAxis, type TransformHandle } from '../render/TransformGizmo.ts';
import type { PlayerController } from './PlayerController.ts';

/** Free-cursor translation of the text preview in its construction grid. */
export class TextCreationGizmo {
  private gizmo: TransformGizmo | null = null;
  private hovered: TransformHandle | null = null;
  private boundsSlot: InventoryInput | null = null;
  private center = new THREE.Vector3();
  private drag: { axis: TransformAxis; start: THREE.Vector2; offset: THREE.Vector3;
    screenVector: THREE.Vector2; size: number } | null = null;
  private controller: PlayerController;

  constructor(controller: PlayerController) { this.controller = controller; }

  update() {
    const renderer = this.controller.sceneRenderer;
    const session = this.controller.textCreation;
    if (!session.isOpen) {
      if (renderer && renderer.textCreationGizmo === this.gizmo?.group) renderer.textCreationGizmo = undefined;
      this.gizmo?.dispose();
      this.gizmo = null;
      this.boundsSlot = null;
      this.endDrag();
      return;
    }
    const preview = session.getPreview();
    if (!preview || !renderer?.scene) {
      if (this.gizmo) this.gizmo.group.visible = false;
      this.endDrag();
      return;
    }
    if (!this.gizmo) {
      this.gizmo = new TransformGizmo({ includeScale: false, includeRotate: false, name: 'TextCreationGizmo' });
      renderer.scene.add(this.gizmo.group);
      renderer.textCreationGizmo = this.gizmo.group;
    }
    if (this.boundsSlot !== preview.slot) {
      const bounds = new THREE.Box3();
      for (const block of preview.slot.blocks || []) {
        const point = new THREE.Vector3(block.dx, block.dy, block.dz);
        bounds.expandByPoint(point);
        bounds.expandByPoint(point.addScalar(block.size || 1));
      }
      bounds.getCenter(this.center);
      this.boundsSlot = preview.slot;
    }
    const rotation = preview.quaternion || new THREE.Quaternion();
    const position = this.center.clone().applyQuaternion(rotation).add(preview.position);
    this.gizmo.setPose(position, rotation, this.drag?.size || transformGizmoSize(position, this.controller.camera.position),
      this.drag ? `move-${this.drag.axis}` : this.hovered?.key);
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
    if (this.drag) {
      const delta = new THREE.Vector2(event.clientX, event.clientY).sub(this.drag.start);
      const distance = delta.dot(this.drag.screenVector) / this.drag.screenVector.lengthSq();
      const offset = this.drag.offset.clone();
      offset[this.drag.axis] += distance;
      this.controller.textCreation.setOffset(offset);
      this.update();
      return true;
    }
    this.hovered = null;
    if (this.isSceneEvent(event) && this.gizmo?.group.visible) {
      const { left, top, width, height } = this.viewport();
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - left) / width * 2 - 1,
        -(event.clientY - top) / height * 2 + 1), transformViewCamera(this.controller.camera));
      this.hovered = this.gizmo.pick(raycaster.ray);
    }
    this.update();
    return !!this.hovered;
  }

  pointerDown(event: MouseEvent) {
    if (event.button !== 0 || !this.isSceneEvent(event)) return false;
    this.pointerMove(event);
    const group = this.gizmo?.group, handle = this.hovered;
    if (!group || !handle) return false;
    const camera = transformViewCamera(this.controller.camera);
    const { width, height } = this.viewport();
    const axis = transformAxis(handle.axis).applyQuaternion(group.quaternion);
    const screenVector = transformScreenPoint(group.position.clone().add(axis), camera, width, height)
      .sub(transformScreenPoint(group.position, camera, width, height));
    if (screenVector.length() < 2) return false;
    this.drag = { axis: handle.axis, start: new THREE.Vector2(event.clientX, event.clientY),
      offset: this.controller.textCreation.offset, screenVector, size: group.scale.x };
    this.update();
    return true;
  }

  endDrag() { this.drag = null; this.hovered = null; }
}
