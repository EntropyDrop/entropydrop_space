import * as THREE from 'three/webgpu';
import { normalizeDecoration, type DecorationDefinition } from '@entropydrop/space-engine/contraption/Decorations.ts';
import { createDecorationGroup, syncDecorationMeshTransform } from '@entropydrop/space-engine/contraption/DecorationMeshes.ts';
import { hookSceneMaterials, TORUS_SIZE_X, TORUS_SIZE_Z, unwrapPeriodicNear } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import type { PlayerController } from './PlayerController.ts';
import { ActionDomain } from '@entropydrop/space-engine/actions/BasicActions.ts';
import {
  MAX_ENTITY_BOUNDS, MAX_TERRAIN_DECORATION_EXTENT, MAX_TERRAIN_DECORATIONS_PER_CHUNK,
} from '@entropydrop/space-engine/constants/SpaceConstants.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { normalizeWorldTerrainDecoration, type TerrainDecoration } from '@entropydrop/space-engine/voxel/TerrainDecorationLayer.ts';
import { TransformGizmo, transformAxis, transformGizmoSize, transformScreenPoint, transformViewCamera, type TransformHandle } from '../render/TransformGizmo.ts';
import { DecorationOwnershipLinks, type DecorationOwnershipEndpoints } from '../render/DecorationOwnershipLink.ts';
import type { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';

/** A decoration owner: an entity component, or one standard terrain voxel. */
type TerrainAnchor = { x: number; y: number; z: number };
type Target = { contraption: any; componentId: string; decorationId?: string; terrain?: undefined }
  | { terrain: TerrainAnchor; decorationId?: string; contraption?: undefined; componentId?: undefined };
type Edit = { target: Target; before: DecorationDefinition[]; after: DecorationDefinition[] };
type PointerInput = Pick<MouseEvent, 'clientX' | 'clientY'> & Partial<Pick<MouseEvent, 'movementX' | 'movementY' | 'shiftKey'>>;
type PointerGesture = { locked: boolean; startX: number; startY: number; delta: THREE.Vector2 };
type Drag = PointerGesture & { target: Target; before: DecorationDefinition[]; start: DecorationDefinition; value: DecorationDefinition;
  handle: TransformHandle; screenVector: THREE.Vector2; size: number; freeMove?: { x: THREE.Vector3; y: THREE.Vector3 } };
type Creation = PointerGesture & { target: Target; start: DecorationDefinition; value: DecorationDefinition; anchor: THREE.Vector3;
  screenX: THREE.Vector2; screenZ: THREE.Vector2; thickness: number; drawing: boolean; shift: boolean; validPlane: boolean };
const DRAG_THRESHOLD = 4;
const IDENTITY = new THREE.Quaternion();
const localTerrainValue = ({ x: _x, y: _y, z: _z, ...value }: TerrainDecoration): DecorationDefinition => value;
const anchorCenter = (anchor: TerrainAnchor) => new THREE.Vector3(anchor.x + 0.5, anchor.y + 0.5, anchor.z + 0.5);
export const MODELING_DIMENSIONS_STORAGE_KEY = 'space_modeling_dimensions';

/** Editor-only state. Persisted decorations remain owned by their components. */
export class ModelingTool {
  selected: Target | null = null;
  hovered: any = null;
  placement: { target: Target; value: DecorationDefinition } | null = null;
  precisionOpen = false;
  private gizmo: TransformGizmo | null = null;
  private ownershipLink: DecorationOwnershipLinks | null = null;
  private focusedEntity: Contraption | null = null;
  private focusedTerrain: TerrainAnchor | null = null;
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
    if (!target.terrain && !this.controller.contraptions?.contraptions?.includes(target.contraption)) {
      this.clearSelection(false);
      return null;
    }
    const value = this.decorationsOf(target).find(decoration => decoration.id === target.decorationId);
    if (!value) { this.clearSelection(false); return null; }
    return { ...target, value };
  }

  /** Terrain decorations follow terrain edit rules; entity ones need edit access. */
  canEditTarget(target: Target | null | undefined) {
    if (!target) return false;
    if (target.terrain) return !!this.controller.world?.terrainDecorations;
    return this.controller.canEditEntityInternals(target.contraption) === true;
  }

  private terrainWorld() {
    return this.controller.world?.terrainDecorations ? this.controller.world : null;
  }

  /** The owner's decorations, sorted by id, in its local frame. */
  private decorationsOf(target: Target): DecorationDefinition[] {
    if (!target.terrain) return target.contraption.getComponentDecorations(target.componentId);
    const { x, y, z } = target.terrain;
    return (this.terrainWorld()?.terrainDecorations.atAnchor(x, y, z) || []).map(localTerrainValue)
      .sort((left: DecorationDefinition, right: DecorationDefinition) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  }

  /** Replace the owner's decorations; terrain edits become terrain mutations. */
  private setDecorationsOf(target: Target, values: DecorationDefinition[]) {
    if (!target.terrain) return target.contraption.setComponentDecorations(target.componentId, values);
    const world = this.terrainWorld();
    if (!world) return false;
    const anchor = target.terrain;
    const previous = new Map(this.decorationsOf(target).map(value => [value.id, value]));
    const next = values.map(value => normalizeWorldTerrainDecoration({ ...value, ...anchor }));
    if (next.length && world.getBlock(anchor.x, anchor.y, anchor.z) === BlockTypes.AIR) {
      throw new Error('Decorations attach to standard terrain blocks.');
    }
    const added = next.filter(value => !previous.has(value.id)).length;
    const removed = [...previous.keys()].filter(id => !next.some(value => value.id === id)).length;
    if (world.terrainDecorations.countInChunkOf(anchor.x, anchor.z) + added - removed > MAX_TERRAIN_DECORATIONS_PER_CHUNK) {
      throw new Error(`A chunk may contain at most ${MAX_TERRAIN_DECORATIONS_PER_CHUNK} terrain decorations.`);
    }
    for (const id of previous.keys()) {
      if (!next.some(value => value.id === id)) world.removeTerrainDecoration({ ...anchor, id });
    }
    for (const value of next) {
      const current = previous.get(value.id);
      if (!current || JSON.stringify(current) !== JSON.stringify(localTerrainValue(value))) world.setTerrainDecoration(value);
    }
    return true;
  }

  private ownerExists(target: Target) {
    if (!target.terrain) {
      return this.controller.contraptions?.contraptions?.includes(target.contraption)
        && !!target.contraption.getEntityNode(target.componentId);
    }
    const world = this.terrainWorld();
    return !!world && world.getBlock(target.terrain.x, target.terrain.y, target.terrain.z) !== BlockTypes.AIR;
  }

  private ownerQuaternion(target: Target) {
    return target.terrain ? IDENTITY.clone()
      : target.contraption.getEntityNode(target.componentId).group.getWorldQuaternion(new THREE.Quaternion());
  }

  /** Terrain anchors are wrapped; express their world points near the viewer across the torus seam. */
  private ownerLocalToWorld(target: Target, point: THREE.Vector3) {
    if (!target.terrain) return target.contraption.entityLocalToWorld(target.componentId, point);
    const world = point.clone().add(anchorCenter(target.terrain));
    const viewer = this.controller.camera?.position;
    if (viewer) {
      world.x = unwrapPeriodicNear(world.x, viewer.x, TORUS_SIZE_X);
      world.z = unwrapPeriodicNear(world.z, viewer.z, TORUS_SIZE_Z);
    }
    return world;
  }

  private ownerWorldToLocal(target: Target, point: THREE.Vector3) {
    if (!target.terrain) return target.contraption.worldToEntityLocal(target.componentId, point);
    const center = anchorCenter(target.terrain);
    return new THREE.Vector3(unwrapPeriodicNear(point.x, center.x, TORUS_SIZE_X) - center.x, point.y - center.y,
      unwrapPeriodicNear(point.z, center.z, TORUS_SIZE_Z) - center.z);
  }

  private ownerScene(target: Target): THREE.Object3D | null {
    return target.terrain ? (this.terrainWorld()?.scene as unknown as THREE.Object3D | undefined) ?? null : target.contraption.scene;
  }

  private maxDimension(target: Target) {
    return target.terrain ? MAX_TERRAIN_DECORATION_EXTENT : MAX_ENTITY_BOUNDS;
  }

  private setHighlight(target: Target | null) {
    const meshes = this.terrainWorld()?.terrainDecorationMeshes;
    if (target?.terrain && target.decorationId) {
      meshes?.setSelection({ x: target.terrain.x, z: target.terrain.z, id: target.decorationId });
    } else meshes?.setSelection(null);
    if (target && !target.terrain) target.contraption.setDecorationSelection(target);
  }

  /** The inspector follows a drag preview without changing the saved definition. */
  getDisplaySelection() {
    const selection = this.getSelection();
    return selection && this.drag ? { ...selection, value: this.drag.value } : selection;
  }

  clearSelection(refresh = true) {
    this.cancelDrag();
    if (this.selected && !this.selected.terrain) this.selected.contraption.setDecorationSelection(null);
    this.terrainWorld()?.terrainDecorationMeshes?.setSelection(null);
    this.selected = null;
    this.precisionOpen = false;
    this.hoveredHandle = null;
    if (this.gizmo) this.gizmo.group.visible = false;
    if (this.ownershipLink) this.ownershipLink.group.visible = false;
    this.updateOwnershipLink();
    if (refresh) this.controller.ui?.refresh?.();
  }

  deactivate() {
    this.focusedEntity = null;
    this.focusedTerrain = null;
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
    if (this.drag) return;
    const ray = this.pointerRay();
    this.updateTarget(query, ray.origin, ray.direction);
    // Focus remains visible when switching tools with the free cursor. In that
    // state pointerMove owns gizmo hover, rather than the center-screen ray.
    if (this.controller.isLocked) this.hoveredHandle = this.gizmo?.pick(ray) || null;
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
      this.ownerScene(target)?.add(this.preview);
      hookSceneMaterials(this.preview);
      if (this.controller.sceneRenderer) this.controller.sceneRenderer.modelingPreview = this.preview;
    }
    const parentRotation = this.ownerQuaternion(target);
    this.preview.position.copy(this.ownerLocalToWorld(target, new THREE.Vector3().fromArray(value.position || [0, 0, 0])));
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
    const terrainHit = this.terrainWorld()?.terrainDecorationMeshes?.raycast(origin, direction, distance, true);
    if (terrainHit && (!this.hovered || terrainHit.distance < this.hovered.distance)) {
      const { x, y, z, id } = terrainHit.decoration;
      this.hovered = { terrain: { x, y, z }, decorationId: id, distance: terrainHit.distance,
        point: terrainHit.point, worldNormal: terrainHit.worldNormal };
    }
    const hit = this.hovered || (query.kind === 'entity' ? query.entityHit : null);
    this.focusedEntity = hit?.contraption ?? null;
    this.focusedTerrain = hit?.terrain ?? null;
    this.placement = null;
    if (!this.hovered && query.kind === 'world' && query.worldHit?.kind === 'standard' && this.terrainWorld()) {
      this.placeOnTerrain(query.worldHit);
    } else if (hit?.terrain && hit.point && hit.worldNormal) {
      this.placeAt({ terrain: hit.terrain }, hit.point, hit.worldNormal);
    }
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

  /** Aim at a standard voxel face: the new decoration is bound to that voxel. */
  private placeOnTerrain(worldHit: any) {
    const { x, y, z } = worldHit.hitPos;
    const normal = new THREE.Vector3(worldHit.normal.x, worldHit.normal.y, worldHit.normal.z);
    const entry = worldHit.entry;
    const point = entry ? new THREE.Vector3(entry.x, entry.y, entry.z)
      : anchorCenter({ x, y, z }).addScaledVector(normal, 0.5);
    this.focusedTerrain = { x, y, z };
    this.placeAt({ terrain: { x, y, z } }, point, normal);
  }

  private placeAt(target: Target, point: THREE.Vector3, worldNormal: THREE.Vector3) {
    const normal = worldNormal.clone().applyQuaternion(this.ownerQuaternion(target).invert()).normalize();
    const scale: [number, number, number] = [...this.creationSize];
    if (target.terrain) for (let axis = 0; axis < 3; axis++) scale[axis] = Math.min(scale[axis], MAX_TERRAIN_DECORATION_EXTENT);
    const position = this.ownerWorldToLocal(target, point.clone().addScaledVector(worldNormal, scale[1] / 2));
    const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    try {
      this.placement = { target, value: normalizeDecoration({
        id: 'preview', position: position.toArray(), rotation: rotation.toArray(), scale,
        color: this.controller.selectedColor, materialId: this.controller.selectedMaterialId,
      }) };
      if (target.terrain) normalizeWorldTerrainDecoration({ ...this.placement.value, ...target.terrain });
    } catch { this.placement = null; }
  }

  private renderGizmo() {
    const selection = this.getSelection();
    this.updateOwnershipLink();
    if (!selection || this.creation || !this.controller.camera || !this.canEditTarget(selection)) {
      if (this.gizmo) this.gizmo.group.visible = false;
      return;
    }
    if (!this.ownerExists(selection)) return;
    if (!this.gizmo) this.gizmo = new TransformGizmo({ name: 'ModelingGizmo' });
    const scene = this.ownerScene(selection);
    if (scene && this.gizmo.group.parent !== scene) scene.add(this.gizmo.group);
    if (this.controller.sceneRenderer) this.controller.sceneRenderer.modelingGizmo = this.gizmo.group;
    const value = this.drag?.value || selection.value;
    const position = this.ownerLocalToWorld(selection, new THREE.Vector3().fromArray(value.position || [0, 0, 0]));
    const rotation = this.ownerQuaternion(selection).multiply(new THREE.Quaternion().fromArray(value.rotation || [0, 0, 0, 1]));
    const size = this.drag?.size || transformGizmoSize(position, this.controller.camera.position);
    this.gizmo.setPose(position, rotation, size, this.drag?.handle.key || this.hoveredHandle?.key);
  }

  /** Also refreshed after render interpolation so links stay attached to moving components. */
  updateOwnershipLink(seconds = performance.now() / 1000) {
    const selection = this.getSelection();
    const camera = this.controller.camera;
    const focused = this.focusedEntity && this.controller.contraptions?.contraptions?.includes(this.focusedEntity)
      ? this.focusedEntity : null;
    const entity: Contraption | null = this.drag?.target.contraption || this.creation?.target.contraption
      || focused || selection?.contraption || null;
    const terrain = this.drag?.target.terrain || this.creation?.target.terrain || this.focusedTerrain || selection?.terrain || null;
    if (this.controller.activeTool !== 'modeling' || this.controller.worldPickingSuspended || (!entity && !terrain) || !camera) {
      if (this.ownershipLink) this.ownershipLink.group.visible = false;
      return;
    }
    if (!entity && terrain) return this.updateTerrainOwnershipLink(terrain, selection, camera, seconds);
    const entries: DecorationOwnershipEndpoints[] = [];
    for (const [componentId, group] of entity!.decorationGroups) {
      const node = entity!.getEntityNode(componentId);
      if (!node) continue;
      const pivot = node.group.getWorldPosition(new THREE.Vector3());
      for (const object of group.children) {
        if (!object.userData.decorationId) continue;
        entries.push({ center: object.getWorldPosition(new THREE.Vector3()), pivot,
          selected: selection?.contraption === entity && selection.componentId === componentId
            && selection.decorationId === object.userData.decorationId });
      }
    }
    if (!entries.length) {
      if (this.ownershipLink) this.ownershipLink.group.visible = false;
      return;
    }
    if (!this.ownershipLink) {
      this.ownershipLink = new DecorationOwnershipLinks();
      if (this.controller.sceneRenderer) this.controller.sceneRenderer.modelingOwnershipLink = this.ownershipLink.group;
    }
    if (this.ownershipLink.group.parent !== entity!.scene) entity!.scene.add(this.ownershipLink.group);
    this.ownershipLink.setLinks(entries, camera, seconds);
  }

  /** Terrain decorations link to the centre of the standard voxel that owns them. */
  private updateTerrainOwnershipLink(anchor: TerrainAnchor, selection: ReturnType<ModelingTool['getSelection']>, camera: any, seconds: number) {
    const world = this.terrainWorld();
    const pivot = this.ownerLocalToWorld({ terrain: anchor }, new THREE.Vector3());
    const entries: DecorationOwnershipEndpoints[] = (world?.terrainDecorations.atAnchor(anchor.x, anchor.y, anchor.z) || [])
      .map((value: TerrainDecoration) => {
        const preview = this.drag?.target.terrain && this.drag.value.id === value.id ? this.drag.value : value;
        return { center: pivot.clone().add(new THREE.Vector3().fromArray(preview.position || [0, 0, 0])), pivot,
          selected: !!selection?.terrain && selection.decorationId === value.id };
      });
    const scene = world?.scene as unknown as THREE.Object3D | undefined;
    if (!entries.length || !scene) {
      if (this.ownershipLink) this.ownershipLink.group.visible = false;
      return;
    }
    if (!this.ownershipLink) {
      this.ownershipLink = new DecorationOwnershipLinks();
      if (this.controller.sceneRenderer) this.controller.sceneRenderer.modelingOwnershipLink = this.ownershipLink.group;
    }
    if (this.ownershipLink.group.parent !== scene) scene.add(this.ownershipLink.group);
    this.ownershipLink.setLinks(entries, camera, seconds);
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
    if (this.controller.handleRunningEntityInteraction(this.hovered?.contraption || this.placement?.target.contraption)) return false;
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
    this.drag = { target: selection, before: this.decorationsOf(selection),
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
    const inverseOwner = this.ownerQuaternion(selection).invert();
    this.drag = { target: selection, before: this.decorationsOf(selection),
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
    if (!this.getSelection() || !this.canEditTarget(drag.target)
      || JSON.stringify(this.decorationsOf(drag.target)) !== JSON.stringify(drag.before)) {
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
    if (drag.handle.kind === 'scale') {
      scale[drag.handle.axis] = THREE.MathUtils.clamp(scale[drag.handle.axis] + amount, 0.01, this.maxDimension(drag.target));
    }
    try {
      const value = normalizeDecoration({ ...drag.start, position: position.toArray(), rotation: rotation.toArray(), scale: scale.toArray() });
      if (drag.target.terrain) normalizeWorldTerrainDecoration({ ...value, ...drag.target.terrain });
      drag.value = value;
    } catch { return false; }
    this.previewTransform(drag.target, drag.value);
    this.renderGizmo();
    this.controller.ui?.refresh?.();
    return true;
  }

  /** Change only render objects while dragging; saving and mesh rebuilds happen once on release. */
  private previewTransform(target: Target, value: DecorationDefinition) {
    if (target.terrain) {
      const meshes = this.terrainWorld()?.terrainDecorationMeshes;
      const stored = this.terrainWorld()?.terrainDecorations.get(target.terrain.x, target.terrain.z, value.id);
      if (meshes && stored) meshes.previewTransform(stored, { ...value, ...target.terrain });
      return;
    }
    const node = target.contraption.getEntityNode(target.componentId);
    const group = target.contraption.decorationGroups.get(target.componentId);
    if (!node || !group) return;
    for (const object of group.children) {
      if (object.userData.decorationId !== target.decorationId && object.name !== 'DecorationSelection') continue;
      object.position.fromArray(value.position || [0, 0, 0]).sub(node.pivotLocal);
      object.quaternion.fromArray(value.rotation || [0, 0, 0, 1]);
      object.scale.fromArray(value.scale || [1, 1, 1]);
      if (object.userData.decorationId) syncDecorationMeshTransform(object as THREE.Mesh);
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
    const current = this.decorationsOf(drag.target).find(value => value.id === drag.target.decorationId);
    if (current) this.previewTransform(drag.target, current);
    this.controller.ui?.refresh?.();
  }

  endDrag() {
    const drag = this.drag;
    if (!drag) return false;
    this.cancelDrag();
    if (JSON.stringify(drag.before) !== JSON.stringify(this.decorationsOf(drag.target))) {
      this.controller.ui?.showToast?.('Decoration changed elsewhere; drag cancelled', { tone: 'warning' });
      return false;
    }
    if (JSON.stringify(drag.start) === JSON.stringify(drag.value)) return false;
    return this.commit(drag.target, drag.before.map((value: DecorationDefinition) => value.id === drag.value.id ? drag.value : value), drag.value);
  }

  selectHovered() {
    this.clearSelection();
    if (!this.hovered) return false;
    this.selected = this.hovered.terrain
      ? { terrain: { ...this.hovered.terrain }, decorationId: this.hovered.decorationId }
      : { contraption: this.hovered.contraption, componentId: this.hovered.componentId, decorationId: this.hovered.decorationId };
    this.setHighlight(this.selected);
    this.renderGizmo();
    this.controller.ui?.refresh?.();
    return true;
  }

  private editable(target: Target) {
    if (target.terrain) return this.ownerExists(target);
    if (!this.controller.contraptions?.contraptions?.includes(target.contraption)) return false;
    if (this.controller.handleRunningEntityInteraction(target.contraption)) return false;
    if (this.controller.canEditEntityInternals(target.contraption)) return true;
    this.controller.ui?.showToast?.('This entity is read-only', { tone: 'warning' });
    return false;
  }

  private commit(target: Target, after: DecorationDefinition[], edited?: DecorationDefinition) {
    if (!this.editable(target)) return false;
    const before = this.decorationsOf(target);
    try {
      if (!this.setDecorationsOf(target, after)) return false;
    } catch (error) {
      this.controller.ui?.showToast?.((error as Error).message, { tone: 'warning' });
      return false;
    }
    const committed = this.decorationsOf(target);
    this.undoStack.push({ target: { ...target, decorationId: edited?.id || target.decorationId }, before, after: committed });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    const value = edited && committed.find((value: DecorationDefinition) => value.id === edited.id);
    if (value) this.rememberSize(value);
    this.save(target);
    return true;
  }

  private save(target: Target) {
    if (!target.terrain) {
      this.controller.contraptions.saveEntitiesToStorage?.();
      this.controller.ui?.notifyContraptionStructureChanged?.(target.contraption);
    }
    this.controller.ui?.refresh?.();
  }

  beginCreation(event: PointerInput | null = null) {
    if (this.isDragging) return true;
    if (!this.placement) {
      this.controller.ui?.showToast?.('Modeling: point at an entity, component or standard terrain block to add a decoration');
      return false;
    }
    const { target, value } = this.placement;
    if (!this.editable(target) || !this.ownerExists(target)) return false;
    const rotation = new THREE.Quaternion().fromArray(value.rotation || [0, 0, 0, 1]);
    const anchor = new THREE.Vector3().fromArray(value.position || [0, 0, 0])
      .addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(rotation), -(value.scale?.[1] ?? 1) / 2);
    const origin = this.ownerLocalToWorld(target, anchor);
    const worldRotation = this.ownerQuaternion(target).multiply(rotation);
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
    return this.ownerExists(draft.target) && this.canEditTarget(draft.target);
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
    const limit = this.maxDimension(draft.target);
    const dimension = (value: number) => {
      const magnitude = draft.shift ? Math.round(Math.abs(value) / 0.125) * 0.125 : Math.abs(value);
      return (value < 0 ? -1 : 1) * THREE.MathUtils.clamp(magnitude, 0.125, limit);
    };
    u = dimension(u); v = dimension(v);
    const rotation = new THREE.Quaternion().fromArray(draft.start.rotation || [0, 0, 0, 1]);
    const position = new THREE.Vector3(u / 2, draft.thickness / 2, v / 2).applyQuaternion(rotation).add(draft.anchor);
    try {
      const value = normalizeDecoration({ ...draft.start, position: position.toArray(), scale: [Math.abs(u), draft.thickness, Math.abs(v)] });
      if (draft.target.terrain) normalizeWorldTerrainDecoration({ ...value, ...draft.target.terrain });
      draft.value = value;
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
      draft.thickness = THREE.MathUtils.clamp(draft.thickness - Math.sign(event.deltaY) * (event.shiftKey ? 0.125 : 0.25), 0.125,
        this.maxDimension(draft.target));
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
      this.controller.ui?.showToast?.('Modeling: point at an entity, component or standard terrain block to add a decoration');
      return false;
    }
    const { target, value } = placement;
    const decoration = { ...value, id: `d_${crypto.randomUUID().replaceAll('-', '')}` };
    if (!this.commit(target, [...this.decorationsOf(target), decoration], decoration)) return false;
    this.controller.toolUseSequence = (this.controller.toolUseSequence || 0) + 1;
    this.clearSelection();
    this.selected = { ...target, decorationId: decoration.id } as Target;
    this.setHighlight(this.selected);
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
      return this.commit(selection, this.decorationsOf(selection)
        .map(decoration => decoration.id === value.id ? value : decoration), value);
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
    if (!this.commit(selection, [...this.decorationsOf(selection), value], value)) return false;
    const { value: _value, ...target } = selection;
    this.selected = { ...target, decorationId: value.id } as Target;
    this.setHighlight(this.selected);
    this.controller.ui?.refresh?.();
    return true;
  }

  remove() {
    this.cancelDrag();
    const selection = this.getSelection();
    if (!selection) return false;
    if (!this.commit(selection, this.decorationsOf(selection)
      .filter(decoration => decoration.id !== selection.decorationId))) return false;
    this.clearSelection();
    return true;
  }

  undo(redo = false) {
    this.cancelDrag();
    const source = redo ? this.redoStack : this.undoStack;
    const edit = source.at(-1);
    if (!edit || !this.editable(edit.target)) return false;
    const expected = redo ? edit.before : edit.after;
    if (JSON.stringify(this.decorationsOf(edit.target)) !== JSON.stringify(expected)) {
      this.controller.ui?.showToast?.('Decoration changed elsewhere; this edit cannot be undone', { tone: 'warning' });
      return false;
    }
    try {
      if (!this.setDecorationsOf(edit.target, redo ? edit.after : edit.before)) return false;
    } catch (error) {
      this.controller.ui?.showToast?.((error as Error).message, { tone: 'warning' });
      return false;
    }
    source.pop();
    (redo ? this.undoStack : this.redoStack).push(edit);
    const restored = this.decorationsOf(edit.target).find(value => value.id === edit.target.decorationId);
    if (restored) this.rememberSize(restored);
    this.getSelection();
    this.save(edit.target);
    return true;
  }
}
