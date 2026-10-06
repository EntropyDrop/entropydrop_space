import * as THREE from 'three/webgpu';
import { normalizeDecoration, type DecorationDefinition } from '@entropydrop/space-engine/contraption/Decorations.ts';
import { createDecorationGroup } from '@entropydrop/space-engine/contraption/DecorationMeshes.ts';
import { hookSceneMaterials } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import type { PlayerController } from './PlayerController.ts';
import { ActionDomain } from '@entropydrop/space-engine/actions/BasicActions.ts';
import { MAX_ENTITY_BOUNDS } from '@entropydrop/space-engine/constants/SpaceConstants.ts';
import { TransformGizmo, transformAxis, transformGizmoSize, transformScreenPoint, transformViewCamera, type TransformHandle } from '../render/TransformGizmo.ts';
import { DecorationOwnershipLink } from '../render/DecorationOwnershipLink.ts';

type Target = { contraption: any; componentId: string; decorationId?: string };
type Edit = { target: Target; before: DecorationDefinition[]; after: DecorationDefinition[] };
type PointerInput = Pick<MouseEvent, 'clientX' | 'clientY'> & Partial<Pick<MouseEvent, 'movementX' | 'movementY' | 'shiftKey'>>;
type PointerGesture = { locked: boolean; startX: number; startY: number; delta: THREE.Vector2 };
type Drag = PointerGesture & { target: Target; before: DecorationDefinition[]; start: DecorationDefinition; value: DecorationDefinition;
  handle: TransformHandle; screenVector: THREE.Vector2; size: number; freeMove?: { x: THREE.Vector3; y: THREE.Vector3 } };
type Creation = PointerGesture & { target: Target; start: DecorationDefinition; value: DecorationDefinition; anchor: THREE.Vector3;
  screenX: THREE.Vector2; screenZ: THREE.Vector2; thickness: number; drawing: boolean; shift: boolean; validPlane: boolean };
const DRAG_THRESHOLD = 4;
export const MODELING_DIMENSIONS_STORAGE_KEY = 'space_modeling_dimensions';

/** Editor-only state. Persisted decorations remain owned by their components. */
export class ModelingTool {
  selected: Target | null = null;
  hovered: any = null;
  placement: { target: Target; value: DecorationDefinition } | null = null;
  precisionOpen = false;
  private gizmo: TransformGizmo | null = null;
  private ownershipLink: DecorationOwnershipLink | null = null;
  private hoveredHandle: TransformHandle | null = null;
  private drag: Drag | null = null;
  private creation: Creation | null = null;
  get isDragging() { return !!this.drag || !!this.creation; }
  get creationDimensions() { return this.creation?.drawing && this.creation.validPlane ? this.creation.value.scale || [1, 1, 1] : null; }
  capturesPointer() { return this.controller.activeTool === 'modeling' && (this.precisionOpen || this.isDragging); }
  private preview: THREE.Group | null = null;
  private undoStack: Edit[] = [];
  private redoStack: Edit[] = [];
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  private controller: PlayerController;
  private creationSize: [number, number, number] = [0.5, 0.5, 0.5];
  constructor(controller: PlayerController) {
    this.controller = controller;
    try {
      const stored = localStorage.getItem(MODELING_DIMENSIONS_STORAGE_KEY);
      if (stored !== null) {
        const scale = JSON.parse(stored);
        if (!Array.isArray(scale)) return;
        this.creationSize = normalizeDecoration({ id: 'size', color: 0, scale }).scale || [1, 1, 1];
      }
    } catch { /* Missing, blocked or invalid browser storage keeps the default size. */ }
  }

  private rememberSize(value: DecorationDefinition) {
    this.creationSize = [...(value.scale || [1, 1, 1])];
    try { localStorage.setItem(MODELING_DIMENSIONS_STORAGE_KEY, JSON.stringify(this.creationSize)); } catch { }
  }

  getSelection() {
    const target = this.selected;
    if (!target) return null;
    if (!this.controller.contraptions?.contraptions?.includes(target.contraption)) {
      this.clearSelection(false);
      return null;
    }
    const value = target.contraption.getComponentDecorations(target.componentId)
      .find((decoration: DecorationDefinition) => decoration.id === target.decorationId);
    if (!value) { this.clearSelection(false); return null; }
    return { ...target, value };
  }

  /** The inspector follows a drag preview without changing the saved definition. */
  getDisplaySelection() {
    const selection = this.getSelection();
    return selection && this.drag ? { ...selection, value: this.drag.value } : selection;
  }

  clearSelection(refresh = true) {
    this.cancelDrag();
    this.selected?.contraption.setDecorationSelection(null);
    this.selected = null;
    this.precisionOpen = false;
    this.hoveredHandle = null;
    if (this.gizmo) this.gizmo.group.visible = false;
    if (this.ownershipLink) this.ownershipLink.group.visible = false;
    if (refresh) this.controller.ui?.refresh?.();
  }

  deactivate() {
    this.clearSelection();
    this.clearPreview();
    if (this.gizmo && this.controller.sceneRenderer?.modelingGizmo === this.gizmo.group) this.controller.sceneRenderer.modelingGizmo = undefined;
    this.gizmo?.dispose();
    this.gizmo = null;
    if (this.ownershipLink && this.controller.sceneRenderer?.modelingOwnershipLink === this.ownershipLink.group) {
      this.controller.sceneRenderer.modelingOwnershipLink = undefined;
    }
    this.ownershipLink?.dispose();
    this.ownershipLink = null;
    this.hovered = this.placement = null;
  }

  private clearPreview() {
    if (!this.preview) return;
    if (this.controller.sceneRenderer?.modelingPreview === this.preview) this.controller.sceneRenderer.modelingPreview = undefined;
    this.preview.removeFromParent();
    this.preview.traverse((object: any) => {
      object.geometry?.dispose();
      object.material?.dispose();
    });
    this.preview = null;
  }

  update(query: any) {
    if (this.controller.activeTool !== 'modeling') return;
    this.getSelection();
    this.renderGizmo();
    if (this.creation) {
      if (!this.validCreationTarget(this.creation)) this.cancelDrag();
      else if (this.creation.drawing) this.renderCreationPreview();
      return;
    }
    if (!this.controller.isLocked || this.drag) return;
    const ray = this.pointerRay();
    this.updateTarget(query, ray.origin, ray.direction);
    this.hoveredHandle = this.gizmo?.pick(ray) || null;
    this.renderGizmo();
  }

  private renderCreationPreview() {
    const draft = this.creation;
    if (!draft?.drawing || !draft.validPlane) return;
    const { target, value } = draft;
    if (!this.preview) {
      this.preview = createDecorationGroup([{ id: 'preview', color: value.color, materialId: value.materialId }], new THREE.Vector3());
      const material = (this.preview.children[0] as THREE.Mesh).material as THREE.MeshStandardNodeMaterial;
      material.transparent = true;
      material.opacity = 0.55;
      material.depthWrite = false;
      (this.preview.children[0] as THREE.Mesh).castShadow = false;
      target.contraption.scene.add(this.preview);
      hookSceneMaterials(this.preview);
      if (this.controller.sceneRenderer) this.controller.sceneRenderer.modelingPreview = this.preview;
    }
    const node = target.contraption.getEntityNode(target.componentId);
    const parentRotation = node.group.getWorldQuaternion(new THREE.Quaternion());
    this.preview.position.copy(target.contraption.entityLocalToWorld(target.componentId,
      new THREE.Vector3().fromArray(value.position || [0, 0, 0])));
    this.preview.quaternion.copy(parentRotation).multiply(new THREE.Quaternion().fromArray(value.rotation || [0, 0, 0, 1]));
    this.preview.scale.fromArray(value.scale || [1, 1, 1]);
    this.preview.visible = true;
  }

  private updateTarget(query: any, origin: THREE.Vector3, direction: THREE.Vector3) {
    let distance = query.kind === 'entity' ? query.entityHit.distance
      : query.kind === 'world' ? query.worldHit.distance : 16;
    if (!Number.isFinite(distance)) distance = 16;
    this.hovered = null;
    for (const entity of this.controller.contraptions?.contraptions || []) {
      const hit = entity.raycastDecorations(origin, direction, distance);
      if (hit && (!this.hovered || hit.distance < this.hovered.distance)) {
        this.hovered = hit;
        distance = hit.distance;
      }
    }
    const hit = this.hovered || (query.kind === 'entity' ? query.entityHit : null);
    this.placement = null;
    if (hit?.contraption && hit.point && hit.worldNormal) {
      const entity = hit.contraption;
      const componentId = hit.componentId || hit.entityId || entity.rootComponentId;
      const node = entity.getEntityNode(componentId);
      if (node) {
        const inverse = node.group.getWorldQuaternion(new THREE.Quaternion()).invert();
        const normal = hit.worldNormal.clone().applyQuaternion(inverse).normalize();
        const scale: [number, number, number] = [...this.creationSize];
        const position = entity.worldToEntityLocal(componentId, hit.point.clone().addScaledVector(hit.worldNormal, scale[1] / 2));
        const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
        try { this.placement = { target: { contraption: entity, componentId }, value: normalizeDecoration({
          id: 'preview', position: position.toArray(), rotation: rotation.toArray(), scale,
          color: this.controller.selectedColor, materialId: this.controller.selectedMaterialId,
        }) }; } catch { this.placement = null; }
      }
    }
  }

  private renderGizmo() {
    const selection = this.getSelection();
    this.updateOwnershipLink();
    if (!selection || this.creation || !this.controller.camera || !this.controller.canEditEntityInternals(selection.contraption)) {
      if (this.gizmo) this.gizmo.group.visible = false;
      return;
    }
    const node = selection.contraption.getEntityNode(selection.componentId);
    if (!node) return;
    if (!this.gizmo) {
      this.gizmo = new TransformGizmo({ name: 'ModelingGizmo' });
      selection.contraption.scene.add(this.gizmo.group);
      if (this.controller.sceneRenderer) this.controller.sceneRenderer.modelingGizmo = this.gizmo.group;
    }
    const value = this.drag?.value || selection.value;
    const position = selection.contraption.entityLocalToWorld(selection.componentId, new THREE.Vector3().fromArray(value.position || [0, 0, 0]));
    const rotation = node.group.getWorldQuaternion(new THREE.Quaternion()).multiply(new THREE.Quaternion().fromArray(value.rotation || [0, 0, 0, 1]));
    const size = this.drag?.size || transformGizmoSize(position, this.controller.camera.position);
    this.gizmo.setPose(position, rotation, size, this.drag?.handle.key || this.hoveredHandle?.key);
  }

  /** Also refreshed after render interpolation so the line stays attached to moving components. */
  updateOwnershipLink(seconds = performance.now() / 1000) {
    const selection = this.getSelection();
    const camera = this.controller.camera;
    const mesh = selection?.contraption.decorationGroups.get(selection.componentId)?.children
      .find((object: THREE.Object3D) => object.userData.decorationId === selection.decorationId);
    const node = selection?.contraption.getEntityNode(selection.componentId);
    if (this.controller.activeTool !== 'modeling' || !selection || !mesh || !node || !camera) {
      if (this.ownershipLink) this.ownershipLink.group.visible = false;
      return;
    }
    if (!this.ownershipLink) {
      this.ownershipLink = new DecorationOwnershipLink();
      selection.contraption.scene.add(this.ownershipLink.group);
      if (this.controller.sceneRenderer) this.controller.sceneRenderer.modelingOwnershipLink = this.ownershipLink.group;
    }
    const center = mesh.getWorldPosition(new THREE.Vector3());
    const pivot = node.group.getWorldPosition(new THREE.Vector3());
    this.ownershipLink.setEndpoints(center, pivot, camera, transformGizmoSize(center, camera.position), seconds);
  }

  private isSceneEvent(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    return !target || target === document.body || !!target.closest?.('#canvas-container');
  }

  private pointerRay(event?: PointerInput | null) {
    const rect = this.controller.sceneRenderer?.renderer?.domElement?.getBoundingClientRect();
    const width = rect?.width || globalThis.innerWidth, height = rect?.height || globalThis.innerHeight;
    const pointer = !event || this.controller.isLocked ? new THREE.Vector2() : new THREE.Vector2(
      (event.clientX - (rect?.left || 0)) / width * 2 - 1, -(event.clientY - (rect?.top || 0)) / height * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, transformViewCamera(this.controller.camera));
    return raycaster.ray;
  }

  pointerMove(event: MouseEvent) {
    if (this.creation) return this.updateCreation(event);
    if (this.drag) return this.updateDrag(event);
    if (!this.isSceneEvent(event)) {
      this.hoveredHandle = null;
      this.renderGizmo();
      return false;
    }
    this.renderGizmo();
    this.hoveredHandle = this.gizmo?.pick(this.pointerRay(event)) || null;
    this.renderGizmo();
    return !!this.hoveredHandle;
  }

  pointerDown(event: MouseEvent) {
    if (!this.precisionOpen) return false;
    if (!this.isSceneEvent(event) || ![0, 2].includes(event.button)) return false;
    if (this.isDragging) return true;
    this.pointerMove(event);
    if (event.button === 0 && this.hoveredHandle) return this.beginDrag(this.hoveredHandle, event);
    const ray = this.pointerRay(event);
    const query = this.controller.performBasicAction({ domain: ActionDomain.QUERY, action: 'raycast',
      origin: ray.origin, direction: ray.direction, maxDistance: 16, space: 'bent', include: 'all', voxelKinds: ['standard', 'micro'] });
    this.updateTarget(query, ray.origin, ray.direction);
    if (event.button === 2) return this.beginCreation(event);
    return this.leftDown(event);
  }

  leftDown(event: PointerInput | null = null) {
    if (this.isDragging) return true;
    this.renderGizmo();
    this.hoveredHandle = this.gizmo?.pick(this.pointerRay(event)) || null;
    const input = event || { clientX: 0, clientY: 0 };
    if (this.hoveredHandle) return this.beginDrag(this.hoveredHandle, input);
    if (!this.selectHovered()) return false;
    this.beginFreeDrag(input);
    return true;
  }

  private gesture(event?: PointerInput | null): PointerGesture {
    return { locked: !!this.controller.isLocked, startX: event?.clientX || 0, startY: event?.clientY || 0, delta: new THREE.Vector2() };
  }

  private updateDelta(gesture: PointerGesture, event: PointerInput) {
    if (gesture.locked) gesture.delta.add(new THREE.Vector2(event.movementX || 0, event.movementY || 0));
    else gesture.delta.set(event.clientX - gesture.startX, event.clientY - gesture.startY);
    return gesture.delta;
  }

  openPrecision() {
    this.cancelDrag();
    if (!this.getSelection()) return false;
    this.precisionOpen = true;
    this.controller.unlock();
    this.controller.ui?.refresh?.();
    return true;
  }

  continueBuilding() {
    this.cancelDrag();
    this.precisionOpen = false;
    this.controller.ui?.refresh?.();
    void this.controller.requestLock();
  }

  onPointerUnlocked() {
    this.cancelDrag();
    // Browsers may consume Escape before delivering keydown to the game.
    if (this.controller.activeTool === 'modeling' && this.getSelection()) {
      this.precisionOpen = true;
      this.controller.ui?.refresh?.();
    }
  }

  beginDrag(handle: TransformHandle, event: PointerInput) {
    const selection = this.getSelection();
    if (!selection || !this.editable(selection)) return false;
    this.cancelDrag();
    this.renderGizmo();
    const group = this.gizmo?.group;
    if (!group) return false;
    const axis = transformAxis(handle.axis).applyQuaternion(group.quaternion);
    const camera = transformViewCamera(this.controller.camera);
    const rect = this.controller.sceneRenderer?.renderer?.domElement?.getBoundingClientRect();
    const width = rect?.width || globalThis.innerWidth || 1, height = rect?.height || globalThis.innerHeight || 1;
    let origin = group.position.clone(), vector = axis.clone();
    if (handle.kind === 'rotate') {
      const radial = handle.worldPoint.clone().sub(origin);
      radial.addScaledVector(axis, -radial.dot(axis));
      if (radial.lengthSq() < 1e-10) return false;
      vector = axis.clone().cross(radial);
      origin.add(radial);
    }
    const screenVector = transformScreenPoint(origin.clone().add(vector), camera, width, height)
      .sub(transformScreenPoint(origin, camera, width, height));
    // A camera-aligned axis has no stable projected direction. Numeric entry remains available.
    if (screenVector.length() < 2) return false;
    this.drag = { target: selection, before: selection.contraption.getComponentDecorations(selection.componentId),
      start: selection.value, value: selection.value, handle, ...this.gesture(event), screenVector, size: group.scale.x };
    this.renderGizmo();
    return true;
  }

  private beginFreeDrag(event: PointerInput) {
    const selection = this.getSelection();
    if (!selection || !this.editable(selection)) return false;
    this.renderGizmo();
    const group = this.gizmo?.group;
    if (!group) return false;
    const camera = this.controller.camera;
    const height = this.controller.sceneRenderer?.renderer?.domElement?.getBoundingClientRect().height || globalThis.innerHeight || 1;
    const depth = group.position.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3()));
    const unitsPerPixel = 2 * Math.max(0.1, depth) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / height;
    const inverseOwner = selection.contraption.getEntityNode(selection.componentId).group.getWorldQuaternion(new THREE.Quaternion()).invert();
    this.drag = { target: selection, before: selection.contraption.getComponentDecorations(selection.componentId),
      start: selection.value, value: selection.value, ...this.gesture(event), size: group.scale.x, screenVector: new THREE.Vector2(),
      handle: { key: 'move-free', kind: 'move', axis: 'x', worldPoint: group.position.clone() }, freeMove: {
        x: new THREE.Vector3(unitsPerPixel, 0, 0).applyQuaternion(camera.quaternion).applyQuaternion(inverseOwner),
        y: new THREE.Vector3(0, -unitsPerPixel, 0).applyQuaternion(camera.quaternion).applyQuaternion(inverseOwner),
      } };
    return true;
  }

  updateDrag(event: PointerInput) {
    const drag = this.drag;
    if (!drag) return false;
    if (!this.getSelection() || !this.controller.canEditEntityInternals(drag.target.contraption)
      || JSON.stringify(drag.target.contraption.getComponentDecorations(drag.target.componentId)) !== JSON.stringify(drag.before)) {
      this.cancelDrag();
      return false;
    }
    const delta = this.updateDelta(drag, event);
    if (drag.freeMove && delta.length() < DRAG_THRESHOLD) return true;
    let amount = drag.freeMove ? 0 : delta.dot(drag.screenVector) / drag.screenVector.lengthSq();
    if (event.shiftKey) {
      const step = drag.handle.kind === 'rotate' ? Math.PI / 12 : 0.125;
      amount = Math.round(amount / step) * step;
    }
    const axis = transformAxis(drag.handle.axis);
    const rotation = new THREE.Quaternion().fromArray(drag.start.rotation || [0, 0, 0, 1]);
    const position = new THREE.Vector3().fromArray(drag.start.position || [0, 0, 0]);
    const scale = new THREE.Vector3().fromArray(drag.start.scale || [1, 1, 1]);
    if (drag.freeMove) {
      const offset = drag.freeMove.x.clone().multiplyScalar(delta.x).addScaledVector(drag.freeMove.y, delta.y);
      if (event.shiftKey) offset.divideScalar(0.125).round().multiplyScalar(0.125);
      position.add(offset);
    } else if (drag.handle.kind === 'move') position.addScaledVector(axis.applyQuaternion(rotation), amount);
    if (drag.handle.kind === 'rotate') rotation.multiply(new THREE.Quaternion().setFromAxisAngle(axis, amount)).normalize();
    if (drag.handle.kind === 'scale') scale[drag.handle.axis] = THREE.MathUtils.clamp(scale[drag.handle.axis] + amount, 0.01, MAX_ENTITY_BOUNDS);
    try {
      drag.value = normalizeDecoration({ ...drag.start, position: position.toArray(), rotation: rotation.toArray(), scale: scale.toArray() });
    } catch { return false; }
    this.previewTransform(drag.target, drag.value);
    this.renderGizmo();
    this.controller.ui?.refresh?.();
    return true;
  }

  /** Change only render objects while dragging; saving and mesh rebuilds happen once on release. */
  private previewTransform(target: Target, value: DecorationDefinition) {
    const node = target.contraption.getEntityNode(target.componentId);
    const group = target.contraption.decorationGroups.get(target.componentId);
    if (!node || !group) return;
    for (const object of group.children) {
      if (object.userData.decorationId !== target.decorationId && object.name !== 'DecorationSelection') continue;
      object.position.fromArray(value.position || [0, 0, 0]).sub(node.pivotLocal);
      object.quaternion.fromArray(value.rotation || [0, 0, 0, 1]);
      object.scale.fromArray(value.scale || [1, 1, 1]);
    }
  }

  cancelDrag() {
    if (this.creation) {
      this.creation = null;
      this.clearPreview();
      this.controller.ui?.refresh?.();
    }
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    const current = drag.target.contraption.getComponentDecorations(drag.target.componentId)
      .find((value: DecorationDefinition) => value.id === drag.target.decorationId);
    if (current) this.previewTransform(drag.target, current);
    this.controller.ui?.refresh?.();
  }

  endDrag() {
    const drag = this.drag;
    if (!drag) return false;
    this.cancelDrag();
    if (JSON.stringify(drag.before) !== JSON.stringify(drag.target.contraption.getComponentDecorations(drag.target.componentId))) {
      this.controller.ui?.showToast?.('Decoration changed elsewhere; drag cancelled', { tone: 'warning' });
      return false;
    }
    if (JSON.stringify(drag.start) === JSON.stringify(drag.value)) return false;
    return this.commit(drag.target, drag.before.map((value: DecorationDefinition) => value.id === drag.value.id ? drag.value : value), drag.value);
  }

  selectHovered() {
    this.clearSelection();
    if (!this.hovered) return false;
    this.selected = { contraption: this.hovered.contraption, componentId: this.hovered.componentId,
      decorationId: this.hovered.decorationId };
    this.selected.contraption.setDecorationSelection(this.selected);
    this.renderGizmo();
    this.controller.ui?.refresh?.();
    return true;
  }

  private editable(target: Target) {
    if (!this.controller.contraptions?.contraptions?.includes(target.contraption)) return false;
    if (this.controller.handleRunningEntityInteraction(target.contraption)) return false;
    if (this.controller.canEditEntityInternals(target.contraption)) return true;
    this.controller.ui?.showToast?.('This entity is read-only', { tone: 'warning' });
    return false;
  }

  private commit(target: Target, after: DecorationDefinition[], edited?: DecorationDefinition) {
    if (!this.editable(target)) return false;
    const before = target.contraption.getComponentDecorations(target.componentId);
    try {
      if (!target.contraption.setComponentDecorations(target.componentId, after)) return false;
    } catch (error) {
      this.controller.ui?.showToast?.((error as Error).message, { tone: 'warning' });
      return false;
    }
    const committed = target.contraption.getComponentDecorations(target.componentId);
    this.undoStack.push({ target: { ...target, decorationId: edited?.id || target.decorationId }, before, after: committed });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    const value = edited && committed.find((value: DecorationDefinition) => value.id === edited.id);
    if (value) this.rememberSize(value);
    this.save(target);
    return true;
  }

  private save(target: Target) {
    this.controller.contraptions.saveEntitiesToStorage?.();
    this.controller.ui?.notifyContraptionStructureChanged?.(target.contraption);
    this.controller.ui?.refresh?.();
  }

  beginCreation(event: PointerInput | null = null) {
    if (this.isDragging) return true;
    if (!this.placement) {
      this.controller.ui?.showToast?.('Modeling: point at an entity or component to add a decoration');
      return false;
    }
    const { target, value } = this.placement;
    if (!this.editable(target)) return false;
    const node = target.contraption.getEntityNode(target.componentId);
    if (!node) return false;
    const rotation = new THREE.Quaternion().fromArray(value.rotation || [0, 0, 0, 1]);
    const anchor = new THREE.Vector3().fromArray(value.position || [0, 0, 0])
      .addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(rotation), -(value.scale?.[1] ?? 1) / 2);
    const origin = target.contraption.entityLocalToWorld(target.componentId, anchor);
    const worldRotation = node.group.getWorldQuaternion(new THREE.Quaternion()).multiply(rotation);
    const camera = transformViewCamera(this.controller.camera);
    const rect = this.controller.sceneRenderer?.renderer?.domElement?.getBoundingClientRect();
    const width = rect?.width || globalThis.innerWidth || 1, height = rect?.height || globalThis.innerHeight || 1;
    const projectAxis = (axis: 'x' | 'z') => transformScreenPoint(origin.clone().add(transformAxis(axis).applyQuaternion(worldRotation)), camera, width, height)
      .sub(transformScreenPoint(origin, camera, width, height));
    const screenX = projectAxis('x'), screenZ = projectAxis('z');
    const determinant = screenX.x * screenZ.y - screenX.y * screenZ.x;
    const validPlane = screenX.length() >= 2 && screenZ.length() >= 2
      && Math.abs(determinant) / (screenX.length() * screenZ.length()) > 0.08;
    this.creation = { target: { ...target }, start: value, value, anchor, screenX, screenZ, validPlane,
      thickness: value.scale?.[1] ?? 1, drawing: false, shift: false, ...this.gesture(event) };
    this.renderGizmo();
    return true;
  }

  private validCreationTarget(draft: Creation) {
    return this.controller.contraptions?.contraptions?.includes(draft.target.contraption)
      && !!draft.target.contraption.getEntityNode(draft.target.componentId)
      && this.controller.canEditEntityInternals(draft.target.contraption);
  }

  updateCreation(event: PointerInput) {
    const draft = this.creation;
    if (!draft) return false;
    if (!this.validCreationTarget(draft)) { this.cancelDrag(); return false; }
    this.updateDelta(draft, event);
    draft.shift = !!event.shiftKey;
    if (!draft.drawing && draft.delta.length() < DRAG_THRESHOLD) return true;
    if (!draft.drawing && !draft.validPlane) {
      this.controller.ui?.showToast?.('Aim more directly at the surface to draw a box', { tone: 'warning' });
    }
    draft.drawing = true;
    return this.resizeCreation();
  }

  private resizeCreation() {
    const draft = this.creation;
    if (!draft?.drawing || !draft.validPlane) return false;
    const { screenX: x, screenZ: z, delta } = draft;
    const determinant = x.x * z.y - x.y * z.x;
    let u = (delta.x * z.y - delta.y * z.x) / determinant;
    let v = (x.x * delta.y - x.y * delta.x) / determinant;
    const dimension = (value: number) => {
      const magnitude = draft.shift ? Math.round(Math.abs(value) / 0.125) * 0.125 : Math.abs(value);
      return (value < 0 ? -1 : 1) * THREE.MathUtils.clamp(magnitude, 0.125, MAX_ENTITY_BOUNDS);
    };
    u = dimension(u); v = dimension(v);
    const rotation = new THREE.Quaternion().fromArray(draft.start.rotation || [0, 0, 0, 1]);
    const position = new THREE.Vector3(u / 2, draft.thickness / 2, v / 2).applyQuaternion(rotation).add(draft.anchor);
    try {
      draft.value = normalizeDecoration({ ...draft.start, position: position.toArray(), scale: [Math.abs(u), draft.thickness, Math.abs(v)] });
    } catch { return false; }
    this.renderCreationPreview();
    this.controller.ui?.refresh?.();
    return true;
  }

  creationWheel(event: { deltaY: number; shiftKey?: boolean; preventDefault?: () => void }) {
    const draft = this.creation;
    if (!draft) return false;
    event.preventDefault?.();
    if (draft.drawing && event.deltaY) {
      draft.thickness = THREE.MathUtils.clamp(draft.thickness - Math.sign(event.deltaY) * (event.shiftKey ? 0.125 : 0.25), 0.125, MAX_ENTITY_BOUNDS);
      this.resizeCreation();
    }
    return true;
  }

  endCreation() {
    const draft = this.creation;
    if (!draft) return false;
    this.creation = null;
    this.clearPreview();
    this.controller.ui?.refresh?.();
    if (!this.validCreationTarget(draft) || (draft.drawing && !draft.validPlane)) return false;
    return this.create({ target: draft.target, value: draft.drawing ? draft.value : draft.start });
  }

  create(placement = this.placement) {
    if (!placement) {
      this.controller.ui?.showToast?.('Modeling: point at an entity or component to add a decoration');
      return false;
    }
    const { target, value } = placement;
    const decoration = { ...value, id: `d_${crypto.randomUUID().replaceAll('-', '')}` };
    if (!this.commit(target, [...target.contraption.getComponentDecorations(target.componentId), decoration], decoration)) return false;
    this.controller.toolUseSequence = (this.controller.toolUseSequence || 0) + 1;
    this.clearSelection();
    this.selected = { ...target, decorationId: decoration.id };
    target.contraption.setDecorationSelection(this.selected);
    this.renderGizmo();
    this.controller.ui?.refresh?.();
    return true;
  }

  change(patch: Partial<DecorationDefinition>) {
    this.cancelDrag();
    const selection = this.getSelection();
    if (!selection) return false;
    try {
      const value = normalizeDecoration({ ...selection.value, ...patch, id: selection.value.id });
      return this.commit(selection, selection.contraption.getComponentDecorations(selection.componentId)
        .map((decoration: DecorationDefinition) => decoration.id === value.id ? value : decoration), value);
    } catch (error) {
      this.controller.ui?.showToast?.((error as Error).message, { tone: 'warning' });
      return false;
    }
  }

  duplicate() {
    this.cancelDrag();
    const selection = this.getSelection();
    if (!selection) return false;
    const value = { ...selection.value, id: `d_${crypto.randomUUID().replaceAll('-', '')}` };
    if (!this.commit(selection, [...selection.contraption.getComponentDecorations(selection.componentId), value], value)) return false;
    this.selected = { ...selection, decorationId: value.id };
    selection.contraption.setDecorationSelection(this.selected);
    this.controller.ui?.refresh?.();
    return true;
  }

  remove() {
    this.cancelDrag();
    const selection = this.getSelection();
    if (!selection) return false;
    if (!this.commit(selection, selection.contraption.getComponentDecorations(selection.componentId)
      .filter((decoration: DecorationDefinition) => decoration.id !== selection.decorationId))) return false;
    this.clearSelection();
    return true;
  }

  undo(redo = false) {
    this.cancelDrag();
    const source = redo ? this.redoStack : this.undoStack;
    const edit = source.at(-1);
    if (!edit || !this.editable(edit.target)) return false;
    const expected = redo ? edit.before : edit.after;
    if (JSON.stringify(edit.target.contraption.getComponentDecorations(edit.target.componentId)) !== JSON.stringify(expected)) {
      this.controller.ui?.showToast?.('Decoration changed elsewhere; this edit cannot be undone', { tone: 'warning' });
      return false;
    }
    try {
      if (!edit.target.contraption.setComponentDecorations(edit.target.componentId, redo ? edit.after : edit.before)) return false;
    } catch (error) {
      this.controller.ui?.showToast?.((error as Error).message, { tone: 'warning' });
      return false;
    }
    source.pop();
    (redo ? this.undoStack : this.redoStack).push(edit);
    const restored = edit.target.contraption.getComponentDecorations(edit.target.componentId)
      .find((value: DecorationDefinition) => value.id === edit.target.decorationId);
    if (restored) this.rememberSize(restored);
    this.getSelection();
    this.save(edit.target);
    return true;
  }
}
