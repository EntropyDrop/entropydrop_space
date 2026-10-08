import type { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import type { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import type { ContraptionOptions, RuntimeVoxel } from '@entropydrop/space-engine/contraption/EntityTypes.ts';
import type { CollisionBounds } from '@entropydrop/space-engine/physics/CollisionGeometry.ts';
import type { PlayerPhysics } from '@entropydrop/space-engine/physics/PlayerPhysics.ts';
import type { World } from '@entropydrop/space-engine/voxel/World.ts';
import type { NavigationSystem } from '../../ui/NavigationSystem.ts';
import type { SpaceUiStore } from '../../ui/react/store/SpaceUiStore.ts';
import type { SoundManager } from '../audio/SoundManager.ts';
import type { ParticleSystem } from '../render/ParticleSystem.ts';
import type { Point3, SelectionGizmoHandle } from '../render/PreviewTypes.ts';
import type { SceneRenderer } from '../render/SceneRenderer.ts';
import { DrivingSession } from './DrivingSession.ts';
import { PlacementSession } from './PlacementSession.ts';
import { PlayerCamera } from './PlayerCamera.ts';
import * as selectionGeometry from './SelectionGeometry.ts';
import { contraptionBlockOwnerId, contraptionRootId } from './SelectionGeometry.ts';
import { SelectionSession } from './SelectionSession.ts';
import type { ComponentRange, ComponentSelection, SelectedVoxel } from './SelectionTypes.ts';
import { ToolInteractionSession } from './ToolInteractionSession.ts';

type PlacementSlot = InventoryInput & { placementRotation?: number[]; itemName?: string };
type SelectionGradient = { stops: GradientStop[]; start: Point3; end: Point3 };
interface WorldCopyVoxel extends Point3 { size: number; block: number; color: number; part?: string | null; materialId: number }
interface PlacementPose {
  position: THREE.Vector3; quaternion?: THREE.Quaternion;
  targetContraption?: Contraption | null; targetNodeId?: string;
  itemWorldPose?: { position: THREE.Vector3; quaternion: THREE.Quaternion }; deferStart?: boolean;
}
type WorldSelectionCapture = NonNullable<ReturnType<PlayerController['captureWorldSelectionEntities']>>;

type EntityHit = NonNullable<ReturnType<ContraptionManager['raycastContraptionHit']>>;

import { ActionDomain, executeBasicAction } from '@entropydrop/space-engine/actions/BasicActions.ts';
import { BULK_EDIT_MAX_OPERATIONS_PER_FRAME, BULK_EDIT_THRESHOLD, MAX_ENTITY_BOUNDS, MAX_ENTITY_COMPONENTS, MAX_INVENTORY_BLOCKS, MAX_INVENTORY_IMPORT_BYTES, MAX_INVENTORY_SCRIPT_BYTES, MAX_INVENTORY_TOTAL_SCRIPT_BYTES, MAX_MICRO_MATERIALIZE_BLOCKS, MAX_MICRO_SELECTION_CELLS } from '@entropydrop/space-engine/constants/SpaceConstants.ts';
import { BodyType, ContraptionMode } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { offsetDecorations } from '@entropydrop/space-engine/contraption/Decorations.ts';
import { PLAYER_GRAVITY_MPS2, PLAYER_MASS_KG } from '@entropydrop/space-engine/physics/PlayerPhysics.ts';
import { encodeInventoryResource, INVENTORY_PROTOBUF_SCHEMA_VERSION, MAX_BACKPACK_ITEM_SLOTS, MAX_BACKPACK_SLOTS_PER_CATEGORY, newItemTemplateId, type InventoryKind, } from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';
import { bendDirection, bendPointForView, TORUS_SIZE_X, TORUS_SIZE_Z, unbendPointForView, unwrapPeriodicNear, wrapMicroX, wrapMicroZ, } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { BlockTypes, colorToHex, normalizeColor, PRESET_COLORS } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { MICRO_DIVISIONS, MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import { normalizeGradientStops, sampleGradientColor, type GradientStop, } from '@entropydrop/space-engine/voxel/Palette.ts';
import { normalizeVoxelMaterialId, VoxelMaterialIds } from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';
import * as THREE from 'three';
import { STOPPED_GRID_EPSILON, validateVoxelOccupancy, withinEntityBounds } from '../inventory/InventoryGeometry.ts';
import { parseInventoryImport } from '../inventory/InventoryImport.ts';
import { rotateBlocksX90, rotateBlocksY90 } from '../inventory/InventoryRotation.ts';
import { encodeInventoryItem, inventoryEntityRootId, inventoryItemName, serializeInventoryItem, } from '../inventory/InventorySerialization.ts';
import { transformGizmoSize, transformScreenPoint, transformViewCamera, TRANSFORM_GIZMO_ROTATION_RADIUS as WRENCH_GIZMO_ROTATION_RADIUS, } from '../render/TransformGizmo.ts';
import type { SpaceStorage } from '../storage/BrowserStorage.ts';
import { CameraPerspectiveTransition } from './CameraPerspectiveTransition.ts';
import { isPerspectiveToggleCode, SpecialTool, type PlayerPerspective } from './ControlBindings.ts';
import { ModelingTool } from './ModelingTool.ts';
import { type SelectorShape } from './SelectorShapes.ts';
// Keep existing imports working while new consumers use the owning modules directly.
export { validateVoxelOccupancy, withinEntityBounds } from '../inventory/InventoryGeometry.ts';
export {
  isPerspectiveToggleCode,
  RESERVED_ENTITY_INPUT_CODES,
  SpecialTool,
  type PlayerPerspective
} from './ControlBindings.ts';
export {
  BULK_EDIT_MAX_OPERATIONS_PER_FRAME,
  BULK_EDIT_THRESHOLD,
  MAX_INVENTORY_BLOCKS,
  MAX_INVENTORY_IMPORT_BYTES,
  MAX_INVENTORY_SCRIPT_BYTES,
  MAX_INVENTORY_TOTAL_SCRIPT_BYTES,
  MAX_MICRO_MATERIALIZE_BLOCKS,
  MAX_MICRO_SELECTION_CELLS
};

import type { BlockSetVoxel, InventoryInput, InventoryVoxel } from '@entropydrop/space-engine/storage/InventoryTypes.ts';
import { addInventoryItem, createEmptyInventories, deleteInventoryItem, ensureDefaultColorSet, inventoryGroup, renameInventoryItem, swapInventorySlots, type Inventories, } from '../inventory/Backpack.ts';
import { loadBackpack, saveBackpack, type BackpackStorage } from '../inventory/BackpackPersistence.ts';
export const BULK_EDIT_FRAME_BUDGET_MS = 5;
const INTERACTIVE_ENTITY_EDIT_ACTIONS = new Set([
  'place-standard', 'remove-standard', 'paint-standard',
  'place-micro', 'remove-micro', 'paint-micro',
  'clear-cell', 'subdivide-standard', 'subdivide-cells',
  'fill-blocks', 'paint-blocks', 'remove-blocks', 'remove-subtree'
]);
const INTERACTIVE_ENTITY_SELECTION_ACTIONS = new Set([
  'entity-subtree', 'entity-box', 'toggle-entity-block',
  'delete', 'fill', 'paint', 'create-child'
]);
// Wrench grabbing is a mass-independent editor servo. Its previous 36/s
// position gain could request nearly 30 m/s in one 20 Hz tick, overshoot the
// target, then reverse just as hard on the next tick. A bounded critically
// damped controller preserves heavy-body handling without that oscillation.
const WRENCH_GRAB_RESPONSE = 8;
const WRENCH_GRAB_MAX_ACCELERATION = 36;
const WRENCH_GRAB_MAX_TARGET_SPEED = 10;
const WRENCH_GRAB_MAX_SPEED = 14;

/** Yaw of a rotation whose forward axis is -Z, using the camera's YXZ order. */
function quaternionForwardYaw(quaternion: any, fallback = 0): number {
  if (!quaternion?.isQuaternion) return fallback;
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
  const planar = Math.hypot(forward.x, forward.z);
  return planar < 1e-6 ? fallback : Math.atan2(-forward.x, -forward.z);
}

const GRID_ALIGNED_ORIENTATIONS = (() => {
  const directions = [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)
  ];
  const orientations: THREE.Quaternion[] = [];
  for (const xAxis of directions) {
    for (const yAxis of directions) {
      if (Math.abs(xAxis.dot(yAxis)) > 1e-9) continue;
      const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis);
      const quaternion = new THREE.Quaternion()
        .setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis))
        .normalize();
      // A quaternion and its negation describe the same orientation. Keeping a
      // canonical sign makes ties deterministic and the helper easy to test.
      if (quaternion.w < 0) quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
      orientations.push(quaternion);
    }
  }
  return Object.freeze(orientations);
})();

/** Return the closest of the 24 proper rotations whose axes align to the voxel grid. */
export function nearestGridAlignedQuaternion(quaternion: any): THREE.Quaternion {
  const current = quaternion?.isQuaternion
    ? quaternion.clone().normalize()
    : new THREE.Quaternion();
  let nearest = GRID_ALIGNED_ORIENTATIONS[0];
  let nearestDot = -1;
  for (const candidate of GRID_ALIGNED_ORIENTATIONS) {
    const dot = Math.abs(current.dot(candidate));
    if (dot > nearestDot) {
      nearestDot = dot;
      nearest = candidate;
    }
  }
  return nearest.clone();
}

type BulkEditPhase = 'applying' | 'waiting' | 'syncing' | 'complete' | 'failed';
type BulkEditJob = {
  label: string;
  total: number;
  processed: number;
  changed: number;
  /** False for read-only preparation jobs such as copying or entity-slot mapping. */
  mutatesWorld?: boolean;
  detail?: string | ((job: BulkEditJob) => string);
  step: (index: number, job: BulkEditJob) => number | void;
  finish?: (job: BulkEditJob) => void;
};

export class PlayerController {
  private _toolSession?: ToolInteractionSession;
  private get toolSession(): ToolInteractionSession {
    if (this._toolSession) return this._toolSession;
    const host = this;
    return this._toolSession = new ToolInteractionSession({
      get applySelectionShape() { return host.applySelectionShape.bind(host); },
      get boxSelectionPreview() { return host.boxSelectionPreview; },
      set boxSelectionPreview(value) { host.boxSelectionPreview = value; },
      get bulkEditJob() { return host.bulkEditJob; },
      set bulkEditJob(value) { host.bulkEditJob = value; },
      get canEditEntityInternals() { return host.canEditEntityInternals.bind(host); },
      get canPlaceStandardAt() { return host.canPlaceStandardAt.bind(host); },
      get clearHammerRotation() { return host.clearHammerRotation.bind(host); },
      get clearSelection() { return host.clearSelection.bind(host); },
      get clearWrenchPivotDisplay() { return host.clearWrenchPivotDisplay.bind(host); },
      get contraptions() { return host.contraptions; },
      set contraptions(value) { host.contraptions = value; },
      get currentRaycast() { return host.currentRaycast; },
      set currentRaycast(value) { host.currentRaycast = value; },
      get focusBlockPreview() { return host.focusBlockPreview; },
      set focusBlockPreview(value) { host.focusBlockPreview = value; },
      get handleBrushRightClick() { return host.handleBrushRightClick.bind(host); },
      get handleRunningEntityInteraction() { return host.handleRunningEntityInteraction.bind(host); },
      get hoveredContraption() { return host.hoveredContraption; },
      set hoveredContraption(value) { host.hoveredContraption = value; },
      get hoveredContraptionHit() { return host.hoveredContraptionHit; },
      set hoveredContraptionHit(value) { host.hoveredContraptionHit = value; },
      get hoveredGizmoHandle() { return host.hoveredGizmoHandle; },
      set hoveredGizmoHandle(value) { host.hoveredGizmoHandle = value; },
      get hoveredWrenchGizmoHandle() { return host.hoveredWrenchGizmoHandle; },
      set hoveredWrenchGizmoHandle(value) { host.hoveredWrenchGizmoHandle = value; },
      get inventoryPlacementPreview() { return host.inventoryPlacementPreview; },
      set inventoryPlacementPreview(value) { host.inventoryPlacementPreview = value; },
      get keys() { return host.keys; },
      set keys(value) { host.keys = value; },
      get microCarvePreview() { return host.microCarvePreview; },
      set microCarvePreview(value) { host.microCarvePreview = value; },
      get modeling() { return host.modeling; },
      set modeling(value) { host.modeling = value; },
      get paintTargetedBlock() { return host.paintTargetedBlock.bind(host); },
      get particles() { return host.particles; },
      set particles(value) { host.particles = value; },
      get pasteInventorySlot() { return host.pasteInventorySlot.bind(host); },
      get performAimRaycast() { return host.performAimRaycast.bind(host); },
      get performBasicAction() { return host.performBasicAction.bind(host); },
      get physics() { return host.physics; },
      set physics(value) { host.physics = value; },
      get releaseGizmoDrag() { return host.releaseGizmoDrag.bind(host); },
      get releaseWrenchGizmoDrag() { return host.releaseWrenchGizmoDrag.bind(host); },
      get releaseWrenchGrab() { return host.releaseWrenchGrab.bind(host); },
      get rotateActiveInventoryItem() { return host.rotateActiveInventoryItem.bind(host); },
      get sampleTargetedColor() { return host.sampleTargetedColor.bind(host); },
      get sceneRenderer() { return host.sceneRenderer; },
      set sceneRenderer(value) { host.sceneRenderer = value; },
      get selectedBlockSelection() { return host.selectedBlockSelection; },
      set selectedBlockSelection(value) { host.selectedBlockSelection = value; },
      get selectedColor() { return host.selectedColor; },
      set selectedColor(value) { host.selectedColor = value; },
      get selectedMaterialId() { return host.selectedMaterialId; },
      set selectedMaterialId(value) { host.selectedMaterialId = value; },
      get selectedSubtree() { return host.selectedSubtree; },
      set selectedSubtree(value) { host.selectedSubtree = value; },
      get selectionShapeAnchor() { return host.selectionShapeAnchor; },
      set selectionShapeAnchor(value) { host.selectionShapeAnchor = value; },
      get selectorLevel() { return host.selectorLevel; },
      set selectorLevel(value) { host.selectorLevel = value; },
      get selectorMicroCellFromRaycast() { return host.selectorMicroCellFromRaycast.bind(host); },
      get selectorMicroMode() { return host.selectorMicroMode; },
      set selectorMicroMode(value) { host.selectorMicroMode = value; },
      get selectorOnEntityClick() { return host.selectorOnEntityClick.bind(host); },
      get selectorRange() { return host.selectorRange; },
      set selectorRange(value) { host.selectorRange = value; },
      get selectorShape() { return host.selectorShape; },
      set selectorShape(value) { host.selectorShape = value; },
      get sound() { return host.sound; },
      set sound(value) { host.sound = value; },
      get startGizmoDrag() { return host.startGizmoDrag.bind(host); },
      get startWrenchGizmoDrag() { return host.startWrenchGizmoDrag.bind(host); },
      get startWrenchGrab() { return host.startWrenchGrab.bind(host); },
      get ui() { return host.ui; },
      set ui(value) { host.ui = value; },
    });
  }

  get pendingInteractionStops(): ToolInteractionSession['pendingInteractionStops'] { return this.toolSession.pendingInteractionStops; }
  set pendingInteractionStops(value: ToolInteractionSession['pendingInteractionStops']) { this.toolSession.pendingInteractionStops = value; }

  get worldPickingSuspended(): ToolInteractionSession['worldPickingSuspended'] { return this.toolSession.worldPickingSuspended; }
  set worldPickingSuspended(value: ToolInteractionSession['worldPickingSuspended']) { this.toolSession.worldPickingSuspended = value; }

  get brushSelection(): ToolInteractionSession['brushSelection'] { return this.toolSession.brushSelection; }
  set brushSelection(value: ToolInteractionSession['brushSelection']) { this.toolSession.brushSelection = value; }

  get brushMicroMode(): ToolInteractionSession['brushMicroMode'] { return this.toolSession.brushMicroMode; }
  set brushMicroMode(value: ToolInteractionSession['brushMicroMode']) { this.toolSession.brushMicroMode = value; }

  get entityInputReleased(): ToolInteractionSession['entityInputReleased'] { return this.toolSession.entityInputReleased; }
  set entityInputReleased(value: ToolInteractionSession['entityInputReleased']) { this.toolSession.entityInputReleased = value; }

  get entityInputPressed(): ToolInteractionSession['entityInputPressed'] { return this.toolSession.entityInputPressed; }
  set entityInputPressed(value: ToolInteractionSession['entityInputPressed']) { this.toolSession.entityInputPressed = value; }

  get entityInputDown(): ToolInteractionSession['entityInputDown'] { return this.toolSession.entityInputDown; }
  set entityInputDown(value: ToolInteractionSession['entityInputDown']) { this.toolSession.entityInputDown = value; }

  get toolUseSequence(): ToolInteractionSession['toolUseSequence'] { return this.toolSession.toolUseSequence; }
  set toolUseSequence(value: ToolInteractionSession['toolUseSequence']) { this.toolSession.toolUseSequence = value; }

  get _activeTool(): ToolInteractionSession['_activeTool'] { return this.toolSession._activeTool; }
  set _activeTool(value: ToolInteractionSession['_activeTool']) { this.toolSession._activeTool = value; }

  private _placementSession?: PlacementSession;
  private get placementSession(): PlacementSession {
    if (this._placementSession) return this._placementSession;
    const host = this;
    return this._placementSession = new PlacementSession({
      get activeInventoryCategory() { return host.activeInventoryCategory; },
      set activeInventoryCategory(value) { host.activeInventoryCategory = value; },
      get activeTool() { return host.activeTool; },
      set activeTool(value) { host.activeTool = value; },
      get currentRaycast() { return host.currentRaycast; },
      set currentRaycast(value) { host.currentRaycast = value; },
      get hoveredContraption() { return host.hoveredContraption; },
      set hoveredContraption(value) { host.hoveredContraption = value; },
      get hoveredContraptionHit() { return host.hoveredContraptionHit; },
      set hoveredContraptionHit(value) { host.hoveredContraptionHit = value; },
      get inventorySlots() { return host.inventorySlots; },
      set inventorySlots(value) { host.inventorySlots = value; },
      get rotateBlocksX90() { return host.rotateBlocksX90.bind(host); },
      get rotateBlocksY90() { return host.rotateBlocksY90.bind(host); },
      get sceneRenderer() { return host.sceneRenderer; },
      set sceneRenderer(value) { host.sceneRenderer = value; },
      get selectedInventoryIndex() { return host.selectedInventoryIndex; },
      set selectedInventoryIndex(value) { host.selectedInventoryIndex = value; },
      get sound() { return host.sound; },
      set sound(value) { host.sound = value; },
      get ui() { return host.ui; },
      set ui(value) { host.ui = value; },
      get world() { return host.world; },
      set world(value) { host.world = value; },
      get worldPickingSuspended() { return host.worldPickingSuspended; },
      set worldPickingSuspended(value) { host.worldPickingSuspended = value; },
    });
  }

  get inventoryPlacementPreview(): PlacementSession['inventoryPlacementPreview'] { return this.placementSession.inventoryPlacementPreview; }
  set inventoryPlacementPreview(value: PlacementSession['inventoryPlacementPreview']) { this.placementSession.inventoryPlacementPreview = value; }

  get hammerRotatedSlotCache(): PlacementSession['hammerRotatedSlotCache'] { return this.placementSession.hammerRotatedSlotCache; }
  set hammerRotatedSlotCache(value: PlacementSession['hammerRotatedSlotCache']) { this.placementSession.hammerRotatedSlotCache = value; }

  get hammerRotatedSlotTurnsKey(): PlacementSession['hammerRotatedSlotTurnsKey'] { return this.placementSession.hammerRotatedSlotTurnsKey; }
  set hammerRotatedSlotTurnsKey(value: PlacementSession['hammerRotatedSlotTurnsKey']) { this.placementSession.hammerRotatedSlotTurnsKey = value; }

  get hammerRotatedSlotSource(): PlacementSession['hammerRotatedSlotSource'] { return this.placementSession.hammerRotatedSlotSource; }
  set hammerRotatedSlotSource(value: PlacementSession['hammerRotatedSlotSource']) { this.placementSession.hammerRotatedSlotSource = value; }

  get hammerRotationTurnsX(): PlacementSession['hammerRotationTurnsX'] { return this.placementSession.hammerRotationTurnsX; }
  set hammerRotationTurnsX(value: PlacementSession['hammerRotationTurnsX']) { this.placementSession.hammerRotationTurnsX = value; }

  get hammerRotationTurnsY(): PlacementSession['hammerRotationTurnsY'] { return this.placementSession.hammerRotationTurnsY; }
  set hammerRotationTurnsY(value: PlacementSession['hammerRotationTurnsY']) { this.placementSession.hammerRotationTurnsY = value; }

  private _selectionSession?: SelectionSession;
  private get selectionSession(): SelectionSession {
    if (this._selectionSession) return this._selectionSession;
    const host = this;
    return this._selectionSession = new SelectionSession({
      get activeTool() { return host.activeTool; },
      set activeTool(value) { host.activeTool = value; },
      get boxSelectionPreview() { return host.boxSelectionPreview; },
      set boxSelectionPreview(value) { host.boxSelectionPreview = value; },
      get buildEntityMicroSelection() { return host.buildEntityMicroSelection.bind(host); },
      get camera() { return host.camera; },
      set camera(value) { host.camera = value; },
      get canEditEntityInternals() { return host.canEditEntityInternals.bind(host); },
      get clearBrushSelection() { return host.clearBrushSelection.bind(host); },
      get collectSubtreeIds() { return host.collectSubtreeIds.bind(host); },
      get contraptions() { return host.contraptions; },
      set contraptions(value) { host.contraptions = value; },
      get focusBlockPreview() { return host.focusBlockPreview; },
      set focusBlockPreview(value) { host.focusBlockPreview = value; },
      get getEntitySelectionBounds() { return host.getEntitySelectionBounds.bind(host); },
      get getTargetEntityWorldQuaternion() { return host.getTargetEntityWorldQuaternion.bind(host); },
      get handleRunningEntityInteraction() { return host.handleRunningEntityInteraction.bind(host); },
      get hasActiveSelection() { return host.hasActiveSelection.bind(host); },
      get isLocked() { return host.isLocked; },
      set isLocked(value) { host.isLocked = value; },
      get performBasicAction() { return host.performBasicAction.bind(host); },
      get physics() { return host.physics; },
      set physics(value) { host.physics = value; },
      get requireConfirmedSelection() { return host.requireConfirmedSelection.bind(host); },
      get sceneRenderer() { return host.sceneRenderer; },
      set sceneRenderer(value) { host.sceneRenderer = value; },
      get sound() { return host.sound; },
      set sound(value) { host.sound = value; },
      get targetEntityLocalToWorld() { return host.targetEntityLocalToWorld.bind(host); },
      get ui() { return host.ui; },
      set ui(value) { host.ui = value; },
      get worldPickingSuspended() { return host.worldPickingSuspended; },
      set worldPickingSuspended(value) { host.worldPickingSuspended = value; },
    });
  }

  get selectionGizmoRaycaster(): SelectionSession['selectionGizmoRaycaster'] { return this.selectionSession.selectionGizmoRaycaster; }
  set selectionGizmoRaycaster(value: SelectionSession['selectionGizmoRaycaster']) { this.selectionSession.selectionGizmoRaycaster = value; }

  get activeGizmoDrag(): SelectionSession['activeGizmoDrag'] { return this.selectionSession.activeGizmoDrag; }
  set activeGizmoDrag(value: SelectionSession['activeGizmoDrag']) { this.selectionSession.activeGizmoDrag = value; }

  get hoveredGizmoHandle(): SelectionSession['hoveredGizmoHandle'] { return this.selectionSession.hoveredGizmoHandle; }
  set hoveredGizmoHandle(value: SelectionSession['hoveredGizmoHandle']) { this.selectionSession.hoveredGizmoHandle = value; }

  get selectionShapeAnchor(): SelectionSession['selectionShapeAnchor'] { return this.selectionSession.selectionShapeAnchor; }
  set selectionShapeAnchor(value: SelectionSession['selectionShapeAnchor']) { this.selectionSession.selectionShapeAnchor = value; }

  get selectorShape(): SelectionSession['selectorShape'] { return this.selectionSession.selectorShape; }
  set selectorShape(value: SelectionSession['selectorShape']) { this.selectionSession.selectorShape = value; }

  get selectorMicroMode(): SelectionSession['selectorMicroMode'] { return this.selectionSession.selectorMicroMode; }
  set selectorMicroMode(value: SelectionSession['selectorMicroMode']) { this.selectionSession.selectorMicroMode = value; }

  get selectorRange(): SelectionSession['selectorRange'] { return this.selectionSession.selectorRange; }
  set selectorRange(value: SelectionSession['selectorRange']) { this.selectionSession.selectorRange = value; }

  get selectorLevel(): SelectionSession['selectorLevel'] { return this.selectionSession.selectorLevel; }
  set selectorLevel(value: SelectionSession['selectorLevel']) { this.selectionSession.selectorLevel = value; }

  get selectedBlockSelection(): SelectionSession['selectedBlockSelection'] { return this.selectionSession.selectedBlockSelection; }
  set selectedBlockSelection(value: SelectionSession['selectedBlockSelection']) { this.selectionSession.selectedBlockSelection = value; }

  get selectedSubtree(): SelectionSession['selectedSubtree'] { return this.selectionSession.selectedSubtree; }
  set selectedSubtree(value: SelectionSession['selectedSubtree']) { this.selectionSession.selectedSubtree = value; }

  private _drivingSession?: DrivingSession;
  private get drivingSession(): DrivingSession {
    if (this._drivingSession) return this._drivingSession;
    const host = this;
    return this._drivingSession = new DrivingSession({
      get contraptions() { return host.contraptions; },
      set contraptions(value) { host.contraptions = value; },
      get hoveredContraption() { return host.hoveredContraption; },
      set hoveredContraption(value) { host.hoveredContraption = value; },
      get hoveredContraptionHit() { return host.hoveredContraptionHit; },
      set hoveredContraptionHit(value) { host.hoveredContraptionHit = value; },
      get physics() { return host.physics; },
      set physics(value) { host.physics = value; },
      get resetEntityInputState() { return host.resetEntityInputState.bind(host); },
      get ui() { return host.ui; },
      set ui(value) { host.ui = value; },
    });
  }

  get drivenSeatFixedOrientation(): DrivingSession['drivenSeatFixedOrientation'] { return this.drivingSession.drivenSeatFixedOrientation; }
  set drivenSeatFixedOrientation(value: DrivingSession['drivenSeatFixedOrientation']) { this.drivingSession.drivenSeatFixedOrientation = value; }

  get drivenSeat(): DrivingSession['drivenSeat'] { return this.drivingSession.drivenSeat; }
  set drivenSeat(value: DrivingSession['drivenSeat']) { this.drivingSession.drivenSeat = value; }

  get drivenContraption(): DrivingSession['drivenContraption'] { return this.drivingSession.drivenContraption; }
  set drivenContraption(value: DrivingSession['drivenContraption']) { this.drivingSession.drivenContraption = value; }

  get isDriving(): DrivingSession['isDriving'] { return this.drivingSession.isDriving; }
  set isDriving(value: DrivingSession['isDriving']) { this.drivingSession.isDriving = value; }

  private _cameraSession?: PlayerCamera;
  private get cameraSession(): PlayerCamera {
    if (this._cameraSession) return this._cameraSession;
    const host = this;
    return this._cameraSession = new PlayerCamera({
      get camera() { return host.camera; },
      set camera(value) { host.camera = value; },
      get bodyQuaternion() { return host.bodyQuaternion; },
      get physics() { return host.physics; },
      set physics(value) { host.physics = value; },
      get sceneRenderer() { return host.sceneRenderer; },
      set sceneRenderer(value) { host.sceneRenderer = value; },
      get ui() { return host.ui; },
      set ui(value) { host.ui = value; },
    });
  }

  get cameraPerspectiveTransition(): PlayerCamera['cameraPerspectiveTransition'] { return this.cameraSession.cameraPerspectiveTransition; }
  set cameraPerspectiveTransition(value: PlayerCamera['cameraPerspectiveTransition']) { this.cameraSession.cameraPerspectiveTransition = value; }

  get thirdPersonDistance(): PlayerCamera['thirdPersonDistance'] { return this.cameraSession.thirdPersonDistance; }
  set thirdPersonDistance(value: PlayerCamera['thirdPersonDistance']) { this.cameraSession.thirdPersonDistance = value; }

  get perspective(): PlayerCamera['perspective'] { return this.cameraSession.perspective; }
  set perspective(value: PlayerCamera['perspective']) { this.cameraSession.perspective = value; }

  get fov(): PlayerCamera['fov'] { return this.cameraSession.fov; }
  set fov(value: PlayerCamera['fov']) { this.cameraSession.fov = value; }

  get yaw(): PlayerCamera['yaw'] { return this.cameraSession.yaw; }
  set yaw(value: PlayerCamera['yaw']) { this.cameraSession.yaw = value; }

  get pitch(): PlayerCamera['pitch'] { return this.cameraSession.pitch; }
  set pitch(value: PlayerCamera['pitch']) { this.cameraSession.pitch = value; }

  modeling = new ModelingTool(this);
  // Reusable temporary vectors for torus-world aiming.
  static _bentEye = new THREE.Vector3();
  static _forwardFlat = new THREE.Vector3();
  static _forwardBent = new THREE.Vector3();

  // --- Injected engine dependencies ---
  camera: THREE.PerspectiveCamera;
  physics: PlayerPhysics;
  world: World;
  sound: SoundManager;
  particles: ParticleSystem;
  contraptions: ContraptionManager;
  ui: SpaceUiStore;

  // --- Pointer lock state ---
  isLocked: boolean;
  pointerLockDesired: boolean;
  ignoreNextLockedMouseMove: boolean;
  mouseSensitivity: number;

  // --- Movement key states ---
  keys: {
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
    jump: boolean;
    crouch: boolean;
    sprint: boolean;
  };
  get activeTool(): string {
    return this.toolSession.activeTool;
  }
  set activeTool(tool: string) {
    this.toolSession.activeTool = tool;
  }
  selectedBlock: number | null;
  selectedColor: number;
  selectedMaterialId: number;
  selectedGradientStops: GradientStop[];
  currentRaycast: any;
  hoveredContraption: Contraption | null;
  hoveredContraptionHit: any;
  wrenchGrab: any;
  private wrenchScrollSaveTimer: ReturnType<typeof setTimeout> | null = null;
  wrenchPivotTarget: any;
  hoveredWrenchGizmoHandle: any;
  activeWrenchGizmoDrag: any;
  microCarvePreview: any;
  focusBlockPreview: any;
  boxSelectionPreview: any;
  private wrenchGizmoRaycaster: THREE.Raycaster | null = null;
  inventories: Inventories;
  activeInventoryCategory: string;
  get hammerRotationTurns(): number {
    return this.hammerRotationTurnsY;
  }
  set hammerRotationTurns(val: number) {
    this.hammerRotationTurnsY = val;
  }
  get hammerRotatedSlotTurns(): number {
    return this.hammerRotationTurnsY;
  }
  set hammerRotatedSlotTurns(val: number) {
    this.hammerRotationTurnsY = val;
  }
  persistentStorage: SpaceStorage | null;
  bulkEditJob: BulkEditJob | null;
  serverEntityRunStateHandler: ((contraption: any, state: 'running' | 'stopped') => Promise<any>) | null;
  serverEntityDeleteHandler: ((contraption: any) => Promise<any>) | null = null;

  // --- Camera / View Settings ---
  sceneRenderer: SceneRenderer | null;
  navigationSystem: NavigationSystem | null = null;

  constructor(
    camera: THREE.PerspectiveCamera,
    physics: PlayerPhysics,
    world: World,
    soundManager: SoundManager,
    particleSystem: ParticleSystem,
    contraptionManager: ContraptionManager,
    uiBridge: SpaceUiStore,
    persistentStorage: SpaceStorage | null = null
  ) {
    this.camera = camera;
    this.physics = physics;
    this.world = world;
    this.sound = soundManager;
    this.particles = particleSystem;
    this.contraptions = contraptionManager;
    this.ui = uiBridge;
    this.persistentStorage = persistentStorage;
    this.bulkEditJob = null;
    this.serverEntityRunStateHandler = null;
    if (this.contraptions) this.contraptions.selectionHost = this;

    this.sceneRenderer = null;
    this.fov = 75;
    this.perspective = 'first_person';
    this.thirdPersonDistance = 4.0;

    this.isLocked = false;
    this.pointerLockDesired = false;
    this.ignoreNextLockedMouseMove = false;
    this.mouseSensitivity = 0.0022;

    // Movement key states
    this.keys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      jump: false,
      crouch: false,
      sprint: false
    };

    // Sampled once by the engine. Entity scripts never add DOM listeners, so
    // stopping or deleting code automatically removes its keyboard behavior.
    this.entityInputDown = new Set();
    this.entityInputPressed = new Set();
    this.entityInputReleased = new Set();

    // Camera angles (Euler YXZ)
    this.pitch = 0;
    this.yaw = 0;

    // Selected Item
    this.activeTool = SpecialTool.SELECTOR;
    this.selectedBlock = BlockTypes.COLOR_BLOCK;
    this.selectedColor = 0xf2a93b;
    this.selectedMaterialId = VoxelMaterialIds.DEFAULT;
    this.selectedGradientStops = normalizeGradientStops(null, this.selectedColor);
    this.currentRaycast = { hit: false };
    this.hoveredContraption = null;
    this.hoveredContraptionHit = null;
    this.pendingInteractionStops = new WeakSet();
    this.wrenchGrab = null;
    this.wrenchPivotTarget = null;
    this.hoveredWrenchGizmoHandle = null;
    this.activeWrenchGizmoDrag = null;
    this.microCarvePreview = null;
    // Selector focus block guide: { cellOrigin, active } | null
    this.focusBlockPreview = null;
    // Selector box selection live preview: { pointA, cursor } | null
    this.boxSelectionPreview = null;
    // Hammer placement ghost: { slot, kind, position } | null
    this.inventoryPlacementPreview = null;
    this.hoveredGizmoHandle = null;
    this.activeGizmoDrag = null;
    // Entity/component selector + inventory clipboard
    this.selectedSubtree = null;          // { contraption, rootId, nodeIds: Set }
    this.selectedBlockSelection = null;   // { contraption, nodeId, blocks: [] }
    this.selectorLevel = null;            // Active box-selection level { contraption, nodeId } — decoupled from block selection
    this.selectorRange = null;            // { contraption, nodeId, pointA, pointB }
    // Selector Tab toggle: default selects standard 1 m blocks; true selects
    // 0.125 m micro cells (single toggles + boxes materialize to existing micro
    // voxels).
    this.selectorMicroMode = false;
    this.selectorShape = 'box';
    this.selectionShapeAnchor = null;
    this.brushMicroMode = false;
    this.brushSelection = null;
    // Items share 198 slots; Color Sets retain 99 slots. The first nine slots
    // of each group form its hotbar. Item content reuses Block Set and Entity data.
    this.inventories = this.createEmptyInventories();
    this.activeInventoryCategory = 'item';
    this.hammerRotationTurnsY = 0;
    this.hammerRotationTurnsX = 0;
    this.hammerRotatedSlotSource = null;
    this.hammerRotatedSlotTurnsKey = null;
    this.hammerRotatedSlotCache = null;
    this.loadInventoriesFromLocalStorage();
    // Driving State
    this.isDriving = false;
    this.drivenContraption = null;
    this.drivenSeat = null;
    this.drivenSeatFixedOrientation = false;

    this.setupPointerLock();
    this.setupEventListeners();
  }

  setupPointerLock() {
    const domElement = document.body;

    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === domElement;
      // Do not briefly publish a locked state for a cancelled request: queued
      // mouse events must remain UI input while a menu or modal is open.
      if (locked && !this.pointerLockDesired) {
        this.applyPointerLockState(false);
        try { document.exitPointerLock?.(); } catch (e) { }
        return;
      }
      this.applyPointerLockState(locked);
      if (!locked) {
        this.modeling?.onPointerUnlocked();
        this.pointerLockDesired = false;
        this.resetEntityInputState();
        this.releaseWrenchGizmoDrag();
        this.releaseWrenchGrab();
        this.clearWrenchPivotDisplay();
      }
    });

    document.addEventListener('pointerlockerror', () => {
      this.pointerLockDesired = false;
      this.syncPointerLockState();
      console.warn('Pointer lock error');
    });
  }

  applyPointerLockState(locked: boolean) {
    if (locked && !this.isLocked) this.ignoreNextLockedMouseMove = true;
    this.isLocked = !!locked;
    if (this.ui) this.ui.setPointerLocked?.(this.isLocked);
    return this.isLocked;
  }

  syncPointerLockState() {
    return this.applyPointerLockState(this.pointerLockDesired
      && typeof document !== 'undefined' && document.pointerLockElement === document.body);
  }

  requestLock() {
    this.pointerLockDesired = true;
    if (typeof document === 'undefined') {
      return Promise.resolve(false);
    }
    if (document.pointerLockElement === document.body) {
      this.syncPointerLockState();
      return Promise.resolve(true);
    }

    try {
      const request = document.body.requestPointerLock();
      if (request?.then) {
        return request.then(() => {
          if (!this.pointerLockDesired && document.pointerLockElement === document.body) {
            try { document.exitPointerLock?.(); } catch (e) { }
            return false;
          }
          return this.syncPointerLockState();
        }).catch(() => {
          this.pointerLockDesired = false;
          this.syncPointerLockState();
          return false;
        });
      }
    } catch (e) {
      this.pointerLockDesired = false;
      this.syncPointerLockState();
      return Promise.resolve(false);
    } finally {
      this.sound?.init();
    }

    // Legacy browsers report the result through pointerlockchange only.
    return Promise.resolve(typeof document !== 'undefined' && document.pointerLockElement === document.body);
  }

  unlock() {
    this.pointerLockDesired = false;
    // exitPointerLock / pointerlockchange are asynchronous in some browsers.
    // Stop consuming look deltas before restoring the system cursor.
    this.applyPointerLockState(false);
    this.resetEntityInputState();
    if (typeof document !== 'undefined' && document.exitPointerLock && document.pointerLockElement) {
      try { document.exitPointerLock(); } catch (e) { }
    }
  }

  setupEventListeners() {
    // Mouse Look
    document.addEventListener('mousemove', (e) => {
      if (this.worldPickingSuspended) return;
      if (this.activeTool === SpecialTool.MODELING && !this.isLocked) {
        this.modeling.pointerMove(e);
        return;
      }
      if (this.activeWrenchGizmoDrag) {
        this.updateWrenchGizmoDrag(e);
        return;
      }
      if (this.activeGizmoDrag) {
        this.updateGizmoDrag(e);
        return;
      }
      if (!this.isLocked || !this.pointerLockDesired || document.pointerLockElement !== document.body) {
        if (this.activeTool === SpecialTool.SELECTOR) {
          this.updateSelectionGizmoPointerHover(e);
        } else if (this.activeTool === SpecialTool.WRENCH) {
          this.updateWrenchGizmoPointerHover(e);
        }
        return;
      }
      // Lock transitions can include a large cursor-recentring delta. Drop
      // only the first event after acquisition, never cap genuine fast turns.
      if (this.ignoreNextLockedMouseMove) {
        this.ignoreNextLockedMouseMove = false;
        return;
      }

      if (this.activeTool === SpecialTool.MODELING && this.modeling.isDragging) {
        this.modeling.pointerMove(e);
        return;
      }

      // Keep unrestricted mouse-look angles; the camera separately composes
      // the mounted body's tilt when rendering a first-person view.
      this.yaw -= e.movementX * this.mouseSensitivity;
      this.pitch -= e.movementY * this.mouseSensitivity;

      const maxPitch = Math.PI / 2 - 0.01;
      this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch));

      this.updateCameraRotation();
    });

    document.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.modeling?.endCreation();
      if (e.button !== 0) return;
      this.modeling?.endDrag();
      this.releaseWrenchGizmoDrag();
      this.releaseWrenchGrab();
      this.releaseGizmoDrag();
    });

    // Mouse Clicks
    document.addEventListener('mousedown', (e) => {
      if (this.worldPickingSuspended) return;
      if (!this.isLocked) {
        if (this.activeTool === SpecialTool.MODELING && this.modeling.pointerDown(e)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (this.activeTool === SpecialTool.SELECTOR && e.button === 0) {
          this.updateSelectionGizmoPointerHover(e);
          if (this.hoveredGizmoHandle) {
            e.preventDefault();
            e.stopPropagation();
            this.startGizmoDrag(this.hoveredGizmoHandle, e);
            return;
          }
        } else if (this.activeTool === SpecialTool.WRENCH && e.button === 0) {
          this.updateWrenchGizmoPointerHover(e);
          if (this.hoveredWrenchGizmoHandle) {
            e.preventDefault();
            e.stopPropagation();
            this.startWrenchGizmoDrag(this.hoveredWrenchGizmoHandle, e);
            return;
          }
        }
        return;
      }

      // Mouse movement and button events can arrive between animation frames.
      // Recast from the latest camera orientation and latest entity transforms
      // so a click never consumes the previous frame's hover result.
      this.updateAimRaycast();

      if (e.button === 0) {
        this.handleLeftClick(e);
        this.refreshAimAfterPointerAction();
      } else if (e.button === 2) {
        this.handleRightClick(e);
        this.refreshAimAfterPointerAction();
      } else if (e.button === 1) {
        // Middle Click: Sample color from targeted voxel if pointing at one
        if (this.currentRaycast && this.currentRaycast.hit && this.currentRaycast.color !== undefined && this.currentRaycast.color !== null) {
          if (this.ui) {
            this.ui.setBuildColor(this.currentRaycast.color);
          }
        } else {
          this.assembleSelection();
        }
      }
    });

    document.addEventListener('contextmenu', (e) => e.preventDefault());

    // Keyboard controls
    document.addEventListener('keydown', (e) => this.handleKeyDown(e));

    document.addEventListener('keyup', (e) => {
      // Always release captured input, even if focus moved into the editor
      // after the matching keydown.
      this.recordEntityKeyUp(e.code);
      switch (e.code) {
        case 'KeyW': this.keys.forward = false; break;
        case 'KeyS': this.keys.backward = false; break;
        case 'KeyA': this.keys.left = false; break;
        case 'KeyD': this.keys.right = false; break;
        case 'Space':
          e.preventDefault();
          this.keys.jump = false;
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          this.keys.crouch = false;
          this.keys.sprint = false;
          this.physics.isSprinting = false;
          break;
      }
    });

    window.addEventListener('blur', () => {
      this.modeling?.cancelDrag();
      this.resetEntityInputState();
      this.releaseWrenchGizmoDrag();
      this.releaseWrenchGrab();
      this.clearWrenchPivotDisplay();
    });

    document.addEventListener('wheel', (e) => {
      this.handleWheel(e);
    }, { passive: false });
  }

  handleKeyDown(e: KeyboardEvent) {
    if (this.ui?.isEntityContextMenuOpen?.()) return;
    const eventTarget = e.target as HTMLElement;
    if (eventTarget && (eventTarget.tagName === 'INPUT' || eventTarget.tagName === 'SELECT' || eventTarget.tagName === 'TEXTAREA' || eventTarget.isContentEditable)) return;

    // Ensure any accidentally focused button or interactive 2D element is blurred
    if (typeof document !== 'undefined' && document.activeElement && document.activeElement !== document.body && (document.activeElement.tagName === 'BUTTON' || document.activeElement.getAttribute('role') === 'button')) {
      (document.activeElement as HTMLElement).blur();
    }

    // Digit 1..9 shortcuts:
    // - When Shovel or Spoon is active: Alt + 1..9 picks palette preset color N
    // - When Selector tool is active: Alt + 1..5 (or Shift + 1..5) switches selector shape (1: box, 2: cylinder, 3: sphere, 4: stairs, 5: line)
    // - When Hammer is active: Alt + 1..9 (or Shift + 1..9) picks backpack slot N
    // - When Brush or other tools: Alt + 1..9 (or Shift + 1..9) picks palette preset color N
    const digitMatch = e.code.match(/^(?:Digit|Numpad)([1-9])$/);
    if (digitMatch) {
      const num = parseInt(digitMatch[1], 10);
      if (num >= 1 && num <= 9) {
        const isShovelOrSpoon = this.activeTool === SpecialTool.SHOVEL || this.activeTool === SpecialTool.SPOON;
        if (isShovelOrSpoon) {
          if (e.altKey) {
            e.preventDefault();
            if (this.ui) {
              this.ui.selectPresetColor(num - 1);
            } else {
              const preset = PRESET_COLORS[num - 1];
              if (preset) {
                this.selectedColor = normalizeColor(preset.hex);
              }
            }
            return;
          }
        } else if (e.altKey || e.shiftKey) {
          e.preventDefault();
          if (this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE) {
            const shapes: SelectorShape[] = ['box', 'cylinder', 'sphere', 'stairs', 'line'];
            if (num >= 1 && num <= 5) {
              this.setSelectorShape(shapes[num - 1]);
              return;
            }
          }
          if (this.ui) {
            if (this.activeTool === SpecialTool.HAMMER) {
              this.ui.selectInventorySlot(num - 1);
            } else {
              this.ui.selectPresetColor(num - 1);
            }
          } else {
            const preset = PRESET_COLORS[num - 1];
            if (preset) {
              this.selectedColor = normalizeColor(preset.hex);
            }
          }
          return;
        }
      }
    }

    // F3 is the primary perspective shortcut. Keep F5 as a compatibility
    // alias for existing users, but consume both before entity input so a
    // mounted script never receives a global camera command.
    if (isPerspectiveToggleCode(e.code)) {
      e.preventDefault();
      this.togglePerspective();
      return;
    }

    this.recordEntityKeyDown(e.code);

    if (this.activeTool === SpecialTool.MODELING) {
      if (e.code === 'Escape') {
        e.preventDefault();
        if (this.modeling.precisionOpen && !this.modeling.isDragging) this.modeling.continueBuilding();
        else this.modeling.openPrecision();
        return;
      }
      if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); this.modeling.remove(); return; }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); this.modeling.undo(e.shiftKey); return; }
      if ((e.code === 'KeyR' && !e.ctrlKey && !e.metaKey && !e.altKey)
        || ((e.ctrlKey || e.metaKey) && e.code === 'KeyD')) {
        e.preventDefault();
        if (!e.repeat) this.modeling.duplicate();
        return;
      }
    }

    switch (e.code) {
      case 'KeyW': this.keys.forward = true; break;
      case 'KeyS': this.keys.backward = true; break;
      case 'KeyA': this.keys.left = true; break;
      case 'KeyD': this.keys.right = true; break;
      case 'Space':
        e.preventDefault();
        this.keys.jump = true;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.keys.crouch = true;
        this.keys.sprint = true;
        this.physics.isSprinting = true;
        break;

      case 'Escape':
        if (this.brushSelection) {
          this.clearBrushSelection();
          if (this.ui) this.ui.showToast('Brush selection cancelled');
        }
        break;

      case 'KeyR': // R key: unified smart copy selection (entity or world blocks)
        if (this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE) {
          this.copySelectionSmart();
        }
        break;

      case 'KeyB': // B key: fill selection with active color
        if (this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE) {
          this.fillSelectionBlocks();
        }
        break;

      case 'KeyP': // P key: paint/recolor selection with active color
        if (this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE) {
          this.paintSelectionBlocks();
        }
        break;

      case 'Delete': // Del key: delete blocks only after A/B confirmation
      case 'Backspace':
        this.deleteSelectionBlocks();
        break;

      case 'KeyC': // C key: open code editor / programmable terminal (always)
        this.openCodeEditorForTarget();
        break;

      case 'KeyG': // G key: create child from block selection (selector) / assemble selection
        if ((this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE) &&
          this.selectedBlockSelection) {
          this.createChildFromSelectedBlocks();
        } else {
          this.assembleSelection();
        }
        break;

      case 'KeyV': // V key: Mount / Drive vehicle
        this.toggleDriveVehicle();
        break;

      case 'KeyF': // F key: Fill selection if selected in selector, otherwise Fly toggle
        if ((this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE) && this.hasActiveSelection()) {
          this.fillSelectionBlocks();
        } else {
          this.physics.isFlying = !this.physics.isFlying;
          if (this.ui) this.ui.showToast(this.physics.isFlying ? 'FLY MODE ON' : 'FLY MODE OFF');
        }
        break;

      case 'KeyE': // E key: Inventory Palette
        if (this.ui) this.ui.toggleInventoryModal();
        break;

      case 'KeyI': // I key: open browser color picker near active color in toolbar
        e.preventDefault();
        this.unlock();
        if (this.ui) this.ui.openColorPicker();
        break;

      case 'KeyO': // O key: Global Settings Modal
        if (this.ui) this.ui.toggleGlobalSettingsModal();
        break;

      case 'Tab': // Tab: switch the hammer bar between block sets and entities,
        // or toggle the selector / brush between standard (1 m) and micro (0.125 m) blocks.
        if (this.activeTool === SpecialTool.HAMMER) {
          e.preventDefault();
          this.toggleHammerCategory();
        } else if (this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE) {
          e.preventDefault();
          this.toggleSelectorMicroMode();
        } else if (this.activeTool === SpecialTool.BRUSH) {
          e.preventDefault();
          this.toggleBrushMicroMode();
        }
        break;

      case 'ArrowLeft':
        e.preventDefault();
        if (this.activeTool === SpecialTool.HAMMER) {
          this.rotateActiveInventoryItem(-1, 'y');
        } else if ((this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE) && this.hasActiveSelection()) {
          this.rotateSelection(-1, 'y');
        }
        break;

      case 'ArrowRight':
        e.preventDefault();
        if (this.activeTool === SpecialTool.HAMMER) {
          this.rotateActiveInventoryItem(1, 'y');
        } else if ((this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE) && this.hasActiveSelection()) {
          this.rotateSelection(1, 'y');
        }
        break;

      case 'ArrowUp':
        e.preventDefault();
        if (this.activeTool === SpecialTool.HAMMER) {
          this.rotateActiveInventoryItem(1, 'x');
        } else if ((this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE) && this.hasActiveSelection()) {
          this.rotateSelection(1, 'x');
        }
        break;

      case 'ArrowDown':
        e.preventDefault();
        if (this.activeTool === SpecialTool.HAMMER) {
          this.rotateActiveInventoryItem(-1, 'x');
        } else if ((this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE) && this.hasActiveSelection()) {
          this.rotateSelection(-1, 'x');
        }
        break;

      case 'Digit1': this.setHotbarSlot(0); break;
      case 'Digit2': this.setHotbarSlot(1); break;
      case 'Digit3': this.setHotbarSlot(2); break;
      case 'Digit4': this.setHotbarSlot(3); break;
      case 'Digit5': this.setHotbarSlot(4); break;
      case 'Digit6': this.setHotbarSlot(5); break;
      case 'Digit7': this.setHotbarSlot(6); break;
    }
  }

  handleWheel(e: { deltaY: number; deltaMode?: number; shiftKey?: boolean; ctrlKey?: boolean; preventDefault?: () => void }) {
    if (this.worldPickingSuspended) return;
    if (this.activeTool === SpecialTool.MODELING && this.modeling?.creationWheel(e)) return;
    if (this.activeTool === SpecialTool.WRENCH) {
      const unitScale = e.deltaMode === 1
        ? 16
        : e.deltaMode === 2
          ? (typeof window !== 'undefined' ? window.innerHeight : 800)
          : 1;
      const distanceChange = THREE.MathUtils.clamp(Number(e.deltaY) * unitScale * 0.01, -2, 2);
      if (!Number.isFinite(distanceChange) || distanceChange === 0) return;
      const focusedEntity = this.hoveredContraptionHit?.contraption || this.hoveredContraption || null;
      const grab = this.wrenchGrab;
      if (grab?.active && (!focusedEntity || focusedEntity === grab.contraption)) {
        const nextDistance = THREE.MathUtils.clamp(grab.targetDistance + distanceChange, 0.75, 48);
        if (nextDistance !== grab.targetDistance) {
          grab.targetDistance = nextDistance;
          e.preventDefault?.();
        }
        return;
      }
      if (focusedEntity && this.scrollFocusedWrenchEntity(focusedEntity, this.hoveredContraptionHit, distanceChange)) {
        e.preventDefault?.();
      }
      return;
    }
    if (!this.isLocked) return;
    if (this.ui) {
      if (this.activeTool === SpecialTool.HAMMER) {
        // Wheel cycles the active backpack category's slots when the Hammer is active.
        this.cycleInventorySlot(e.deltaY > 0 ? 1 : -1);
      } else if (this.activeTool === SpecialTool.BRUSH || e.shiftKey) {
        // Wheel with Brush (or Shift+Wheel) cycles palette colors.
        this.ui.cycleColor(e.deltaY > 0 ? 1 : -1);
      }
    }
  }

  private scrollFocusedWrenchEntity(contraption: Contraption, hit: EntityHit | null, distanceChange: number) {
    if (!this.contraptions?.contraptions?.includes(contraption)) return false;
    if (this.bulkEditJob) {
      this.ui?.showToast?.(`Please wait for ${this.bulkEditJob.label.toLowerCase()} to finish`, { tone: 'warning' });
      return true;
    }
    if (contraption.serverManaged === true && contraption.serverCanEdit !== true) {
      this.ui?.showToast?.('This entity is read-only or occupied by another endpoint', { tone: 'warning' });
      return true;
    }
    if (this.handleRunningEntityInteraction(contraption)
      && (this.pendingInteractionStops?.has(contraption) || this.isEntityRunning(contraption))) return true;
    if (!this.canEditEntityInternals(contraption)) return true;

    const eyePosition = this.physics?.getEyePosition?.() || this.camera?.position;
    if (!eyePosition?.isVector3) return false;
    const rootBody = contraption.getRigidBody?.(contraptionRootId(contraption));
    const hitPoint = hit?.point?.isVector3
      ? hit.point.clone()
      : hit?.point
        ? new THREE.Vector3(Number(hit.point.x), Number(hit.point.y), Number(hit.point.z))
        : rootBody?.position?.clone?.();
    if (!hitPoint?.isVector3) return false;

    const hitDistance = Number(hit?.distance);
    const targetSpace = Number.isFinite(hitDistance) && hitDistance >= 0 ? 'bent' : 'flat';
    const currentDistance = targetSpace === 'bent' ? hitDistance : eyePosition.distanceTo(hitPoint);
    const nextDistance = THREE.MathUtils.clamp(currentDistance + distanceChange, 0.75, 48);
    if (nextDistance === currentDistance) return true;
    const nextPoint = this.getWrenchTargetPosition(eyePosition, nextDistance, hitPoint, targetSpace);
    const translation = nextPoint.sub(hitPoint);
    if (translation.lengthSq() < 1e-10) return true;

    for (const body of contraption.rigidBodies?.values?.() || []) {
      body.position?.add?.(translation);
      body.velocity?.set?.(0, 0, 0);
      body.angularVelocity?.set?.(0, 0, 0);
      body.appliedForces?.set?.(0, 0, 0);
      body.appliedTorques?.set?.(0, 0, 0);
      body.previousKinematicPosition?.copy?.(body.position);
      body.previousKinematicQuaternion?.copy?.(body.quaternion);
    }
    contraption.position.add(translation);
    contraption.syncAllBodyTransforms?.();
    contraption.updateTransform?.();
    contraption.capturePreviousEntityTransforms?.();
    if (this.wrenchScrollSaveTimer) clearTimeout(this.wrenchScrollSaveTimer);
    this.wrenchScrollSaveTimer = setTimeout(() => {
      this.wrenchScrollSaveTimer = null;
      this.contraptions?.saveEntitiesToStorage?.();
    }, 180);
    return true;
  }

  setHotbarSlot(index: number) {
    if (this.ui?.selectHotbarSlot) {
      this.ui.selectHotbarSlot(index);
    }
  }

  /** Switch tools from an interaction flow such as a successful selection copy. */
  activateTool(tool: string) {
    if (this.activeWrenchGizmoDrag) this.releaseWrenchGizmoDrag();
    if (this.wrenchGrab) this.releaseWrenchGrab();
    if (tool !== SpecialTool.SELECTOR) {
      this.hoveredGizmoHandle = null;
      this.releaseGizmoDrag();
      this.sceneRenderer?.clearSelectionAxisGizmo?.();
    }
    this.activeTool = tool;
    if (this.ui?.selectTool) this.ui.selectTool(tool);
    else this.ui?.updateToolPanelMode?.();
    return this.activeTool;
  }

  /** Canonical command entry shared with entity programs and editor buttons. */
  performBasicAction<C extends import('@entropydrop/space-engine/actions/ActionContracts.ts').BasicActionCommand>(command: C): import('@entropydrop/space-engine/actions/ActionContracts.ts').BasicActionResult<C>;
  performBasicAction(command: import('@entropydrop/space-engine/actions/ActionContracts.ts').BasicActionCommand): unknown {
    const contraption = ('target' in command ? command.target?.contraption : null) || ('selection' in command ? command.selection?.contraption : null)
      || this.selectedBlockSelection?.contraption || this.selectedSubtree?.contraption;
    const interactive = (command.actor?.source || 'player') === 'player'
      && ((command.domain === ActionDomain.ENTITY && INTERACTIVE_ENTITY_EDIT_ACTIONS.has(command.action))
        || (command.domain === ActionDomain.SELECTION && INTERACTIVE_ENTITY_SELECTION_ACTIONS.has(command.action)));
    if (interactive && contraption && this.handleRunningEntityInteraction(contraption)) {
      return {
        ok: false, action: command.action, reason: 'entity_not_stopped', changed: 0,
        placed: 0, removed: 0, painted: 0, subdivided: 0, added: 0, recolored: 0, empty: false
      };
    }
    const result = executeBasicAction(
      { world: this.world, manager: this.contraptions, selectionHost: this },
      { actor: { source: 'player' }, ...command }
    );
    if (interactive && result && 'reason' in result && result.reason === 'entity_not_stopped') {
      this.handleRunningEntityInteraction(contraption ?? null);
    }
    return result;
  }

  clearSelection() {
    return this.selectionSession.clearSelection();
  }

  setWorldPickingSuspended(suspended: boolean): void {
    return this.toolSession.setWorldPickingSuspended(suspended);
  }

  clearBrushSelection() {
    return this.toolSession.clearBrushSelection();
  }

  recordEntityKeyDown(code: string) {
    return this.toolSession.recordEntityKeyDown(code);
  }

  recordEntityKeyUp(code: string) {
    return this.toolSession.recordEntityKeyUp(code);
  }

  consumeEntityInputFrame() {
    return this.toolSession.consumeEntityInputFrame();
  }

  resetEntityInputState() {
    return this.toolSession.resetEntityInputState();
  }

  openCodeEditorForTarget(target = this.hoveredContraption) {
    if (!target || !this.contraptions.contraptions.includes(target)) {
      if (this.ui) this.ui.showToast(`Point directly at a contraption to program it.`);
      return false;
    }
    if (target.serverManaged === true && target.serverCanEdit !== true) {
      this.ui?.showToast?.('This entity is read-only or occupied by another endpoint');
      return false;
    }

    this.contraptions.activeProgrammingContraption = target;
    if (this.ui) this.ui.openCodeEditor(target);
    return true;
  }

  handleLeftClick(e: MouseEvent | null = null) {
    return this.toolSession.handleLeftClick(e);
  }

  /**
   * Handle a Selector left-click on an entity/component.
   *
   * Interaction states for entities whose scripts are not running:
   * - **First click**: select the hit component level; auto-recursively highlight it and all
   *   descendants (never the parent). Confirm A/B before using selection actions.
   * - **Second click on the same entity** (any surface): advance the 2-point box selection for
   *   that level's *own* blocks only (child-component blocks are excluded). Any point on the
   *   entity surface is valid — the hit does not need to land exactly on the target component,
   *   making it easy to box-select small components.
   * - **Click after box is complete**: restart box-selection (same level; this click becomes the
   *   new first corner).
   * - **Shift+click**: immediately switch / re-select the component level without entering box
   *   mode.
   *
   * Only stopped entities expose their construction grid. An attempt on a
   * running entity immediately stops it without also selecting or editing.
   */
  selectorOnEntityClick(hit: EntityHit, e: Pick<MouseEvent, "shiftKey"> | null = null) {
    const contraption = hit.contraption;
    const hitNodeId = (hit.entityId && contraption?.entityNodes?.has(hit.entityId))
      ? hit.entityId
      : contraptionRootId(contraption);
    const shiftHeld = !!(e?.shiftKey || this.keys?.crouch);

    // Consume the interaction as Stop before opening the construction grid,
    // including attempts made while a world-space selection is in progress.
    if (this.handleRunningEntityInteraction(contraption)) return;

    // World 2-point box in progress (cornerA set, cornerB not yet set): clicking an entity
    // A selection that starts in the world cannot end on an entity.
    if (this.contraptions && this.contraptions.selectionCornerA !== null && this.contraptions.selectionCornerB === null) {
      this.contraptions.selectionCornerA = null;
      this.contraptions.selectionCornerB = null;
      this.boxSelectionPreview = null;
      this.sceneRenderer?.clearBoxSelectionPreview?.();
      if (this.ui) this.ui.showToast('A selection that starts in the world cannot end on an entity.', { tone: 'warning' });
      return;
    }

    if (!this.canEditEntityInternals(contraption)) {
      this.startSubtreeSelection(contraption, contraptionRootId(contraption), { wholeOnly: true });
      return;
    }

    // Shift+click: multi-select / toggle individual block or micro-block.
    if (shiftHeld) {
      if (this.selectedSubtree) {
        this.selectedSubtree.contraption.clearSubtreeHighlight();
        this.selectedSubtree = null;
      }
      let hitBlock = hit.block;
      if (!hitBlock) {
        this.startSubtreeSelection(contraption, hitNodeId);
        return;
      }
      // Micro mode selects 0.125 m voxels. Toggling a cell of a 1 m block is
      // virtual (non-destructive): the block is only subdivided later, when
      // Del/F/P/G actually mutate geometry.
      if (this.selectorMicroMode === true && (hitBlock.size || 1) >= 1) {
        const microCell = this.entityMicroCellFromHit(hit);
        if (!microCell) return;
        const previous = this.selectedBlockSelection;
        const current = (previous?.contraption === contraption
          && previous?.micro === true
          && previous?.nodeId === hitNodeId)
          ? [...previous.blocks]
          : [];
        const key = `${microCell.x},${microCell.y},${microCell.z}`;
        const index = current.findIndex((b: any) => this.microCellKey(b) === key);
        if (index >= 0) {
          current.splice(index, 1);
        } else {
          current.push({
            localX: microCell.x * MICRO_SIZE,
            localY: microCell.y * MICRO_SIZE,
            localZ: microCell.z * MICRO_SIZE,
            size: MICRO_SIZE,
            color: hitBlock.color,
            block: hitBlock.block,
            entityId: contraptionBlockOwnerId(contraption, hitBlock),
            virtualMicro: true,
            sourceBlock: hitBlock
          });
        }
        if (current.length === 0) {
          this.clearSelection();
        } else {
          this.setVirtualMicroSelection(contraption, hitNodeId, current);
        }
        return;
      }
      const result = this.performBasicAction({
        domain: ActionDomain.SELECTION,
        action: 'toggle-entity-block',
        target: { contraption },
        nodeId: hitNodeId,
        block: hitBlock
      });
      if (result.ok && result.selection) {
        const isMicro = this.selectorMicroMode === true;
        this.selectedBlockSelection = {
          contraption,
          nodeId: hitNodeId,
          blocks: result.selection?.blocks,
          bounds: this.getEntitySelectionBounds(result.selection?.blocks, isMicro)
        };
        this.selectorLevel = { contraption, nodeId: hitNodeId };
        this.selectorRange = null;
        this.updateSelectionAxisGizmo();
      } else {
        this.selectedBlockSelection = null;
        this.selectorLevel = { contraption, nodeId: hitNodeId };
        this.selectorRange = null;
        this.updateSelectionAxisGizmo();
      }
      return;
    }

    // Point 2 on entity (selection in progress):
    if (this.selectorRange && this.selectorRange.pointA) {
      if (this.selectorRange.contraption !== contraption) {
        this.clearSelection();
        if (this.ui) this.ui.showToast('The selection start and end must belong to the same entity.', { tone: 'warning' });
        return;
      }
      if (this.selectorRange.nodeId !== hitNodeId) {
        this.clearSelection();
        if (this.ui) this.ui.showToast('The selection must stay at the same hierarchy level and share one parent component.', { tone: 'warning' });
        return;
      }
      const inwardPoint = this.getInwardEntityPoint(hit);
      this.selectorRange.pointB = this.rangePointToLocal(this.selectorRange, inwardPoint);
      this.resolveBlockRangeSelection(this.selectorRange);
      return;
    }

    // Point 1 on entity (sets the first point immediately, allowing 2-click box selection):
    if (this.contraptions) {
      this.contraptions.selectionCornerA = null;
      this.contraptions.selectionCornerB = null;
    }
    // A fresh selection must not inherit the previous selection's shape corners,
    // otherwise Alt+shape after a new box would recompute from a stale region.
    this.selectionShapeAnchor = null;
    this.performBasicAction({ domain: ActionDomain.SELECTION, action: 'clear' });
    if (this.selectedSubtree) {
      this.selectedSubtree.contraption.clearSubtreeHighlight?.();
      this.selectedSubtree = null;
    }
    if (this.selectedBlockSelection) {
      this.selectedBlockSelection.contraption.clearSubtreeHighlight?.();
      this.selectedBlockSelection = null;
    }
    const nodeIds = this.collectSubtreeIds(contraption, hitNodeId);
    this.selectedSubtree = { contraption, rootId: hitNodeId, nodeIds };
    this.selectorLevel = { contraption, nodeId: hitNodeId };
    this.selectorRange = {
      contraption,
      nodeId: hitNodeId,
      pointA: null,
      pointB: null
    };
    const inwardPoint = this.getInwardEntityPoint(hit);
    this.selectorRange.pointA = this.rangePointToLocal(this.selectorRange, inwardPoint);
    this.updateSelectionAxisGizmo();
  }

  canEditEntityInternals(contraption: Contraption | null) {
    return !!contraption && (contraption.serverManaged !== true || contraption.serverCanEdit === true)
      && !this.pendingInteractionStops?.has(contraption) && !this.isEntityRunning(contraption);
  }

  /** A preselected subtree or Shift-picked cells are not a confirmed A/B box. */
  canUseSelectionActions() {
    if (this.selectedSubtree) return false;
    if (this.selectedBlockSelection) {
      const selection = this.selectedBlockSelection;
      return !!(selection.confirmedRange?.pointA && selection.confirmedRange?.pointB
        && selection.blocks?.length > 0 && this.canEditEntityInternals(selection.contraption));
    }
    return this.contraptions?.selectionBoxConfirmed === true
      && this.contraptions.hasValidSelection?.() === true;
  }

  canDeleteSelection() {
    return this.canUseSelectionActions();
  }

  requireConfirmedSelection(action: string) {
    const entity = this.selectedBlockSelection?.contraption || this.selectedSubtree?.contraption
      || this.selectorRange?.contraption || this.contraptions?.getChildSelectionInfo?.()?.contraption
      || (!this.contraptions?.hasValidSelection?.() && !this.contraptions?.selectionCornerA
        ? this.hoveredContraptionHit?.contraption : null);
    if (this.handleRunningEntityInteraction(entity)) return false;
    if (entity?.serverManaged === true && entity.serverCanEdit !== true) {
      this.ui?.showToast?.('This entity is read-only', { tone: 'warning' });
      return false;
    }
    if (!this.canUseSelectionActions()) {
      this.ui?.showToast?.(entity || this.hasActiveSelection() || this.contraptions?.selectionCornerA
        ? `Confirm both selection points A and B before ${action}`
        : `Nothing selected - select points A and B before ${action}`, { tone: 'warning' });
      return false;
    }
    return true;
  }

  /** A running-entity interaction immediately performs Stop, never the attempted edit. */
  handleRunningEntityInteraction(contraption: Contraption | null) {
    if (!contraption) return false;
    const label = `Entity #${contraption.id}`;
    if (this.pendingInteractionStops?.has(contraption)) {
      this.ui?.showToast?.(`${label} is stopping — please wait`, { tone: 'warning' });
      return true;
    }
    if (!this.isEntityRunning(contraption)) return false;
    if (contraption.serverManaged === true) {
      if (contraption.serverCanControl !== true || !this.serverEntityRunStateHandler) {
        this.ui?.showToast?.(contraption.serverCanControl !== true
          ? 'This entity is read-only or occupied by another endpoint'
          : 'Entity control is temporarily unavailable', { tone: 'warning' });
        return true;
      }
      this.clearSelection();
      this.pendingInteractionStops ||= new WeakSet();
      this.pendingInteractionStops.add(contraption);
      const requestedRevision = contraption.serverRevision;
      const previousRunState = contraption.serverDesiredRunState;
      this.ui?.showToast?.(`${label} is stopping — please wait`);
      void this.requestServerEntityRunState(contraption, 'stopped', { silent: true }).then(stopped => {
        this.pendingInteractionStops.delete(contraption);
        if (!stopped) {
          if (contraption.serverRevision === requestedRevision) contraption.serverDesiredRunState = previousRunState;
          this.ui?.showToast?.(`${label} could not be stopped — try again`, { tone: 'warning' });
          return;
        }
        // A delayed stop acknowledgement must not overwrite a newer remote Start.
        if (contraption.serverRevision !== requestedRevision && contraption.serverDesiredRunState !== 'stopped') {
          this.ui?.showToast?.(`${label} state changed elsewhere — try again`, { tone: 'warning' });
          return;
        }
        contraption.serverDesiredRunState = 'stopped';
        executeBasicAction({ world: this.world, manager: this.contraptions, selectionHost: this }, {
          domain: ActionDomain.ENTITY, action: 'stop-scripts', target: { contraption }, actor: { source: 'server-sync' }
        });
        this.sound?.playWrenchClick?.();
        this.ui?.showToast?.(`${label} stopped`);
      });
      return true;
    }
    this.clearSelection();
    const result = this.performBasicAction({ domain: ActionDomain.ENTITY, action: 'stop-scripts', target: { contraption } });
    if (result.ok || result.reason === 'already_stopped') {
      this.sound?.playWrenchClick?.();
      this.ui?.showToast?.(`${label} stopped`);
    } else {
      this.ui?.showToast?.(`${label} could not be stopped`, { tone: 'warning' });
    }
    return true;
  }

  getSelectorSelectAllTarget() {
    const selection = this.selectedBlockSelection || this.selectorRange
      || this.selectedSubtree || this.selectorLevel || this.hoveredContraptionHit;
    if (!selection?.contraption) return null;
    return {
      contraption: selection.contraption,
      nodeId: selection.nodeId || selection.rootId || selection.entityId
        || contraptionRootId(selection.contraption)
    };
  }

  /** Explicitly confirm the full A/B bounds of the current component's own blocks. */
  selectAllSelectionBlocks(explicitTarget: ComponentSelection | null = null) {
    if (this.bulkEditJob) {
      this.ui?.showToast?.(`Please wait for ${this.bulkEditJob.label.toLowerCase()} to finish`);
      return false;
    }
    const target = explicitTarget || this.getSelectorSelectAllTarget();
    if (!target) {
      this.ui?.showToast?.('Point at or select an entity component before using Select All', { tone: 'warning' });
      return false;
    }
    const { contraption, nodeId } = target;
    if (this.handleRunningEntityInteraction(contraption)) return false;
    if (!this.canEditEntityInternals(contraption)) {
      this.ui?.showToast?.(contraption.serverManaged === true && contraption.serverCanEdit !== true
        ? 'This entity is read-only'
        : 'Stop the entity with the Wrench before selecting all its blocks', { tone: 'warning' });
      return false;
    }
    const node = contraption.entityNodes?.get?.(nodeId);
    const blocks = contraption.blocks.filter((block: RuntimeVoxel) => contraptionBlockOwnerId(contraption, block) === nodeId);
    if (!node || blocks.length === 0) {
      this.ui?.showToast?.('Selected component has no blocks', { tone: 'warning' });
      return false;
    }
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const block of blocks) {
      const size = block.size || 1;
      min.x = Math.min(min.x, block.localX);
      min.y = Math.min(min.y, block.localY);
      min.z = Math.min(min.z, block.localZ);
      max.x = Math.max(max.x, block.localX + size);
      max.y = Math.max(max.y, block.localY + size);
      max.z = Math.max(max.z, block.localZ + size);
    }
    const pivot = node.pivotLocal || new THREE.Vector3();
    this.clearSelection();
    this.selectorShape = 'box';
    this.resolveBlockRangeSelection({
      contraption,
      nodeId,
      pointA: min.sub(pivot).addScalar(1e-6),
      pointB: max.sub(pivot).addScalar(-1e-6),
      allComponents: false,
      gradientEligible: false
    });
    const selected = this.selectedBlockSelection;
    if (!selected?.confirmedRange) return false;
    this.ui?.updateToolPanelMode?.();
    this.ui?.showToast?.(`Selected all ${selected.blocks.length} blocks in [${nodeId}] · A/B confirmed · Del delete`);
    return true;
  }

  /**
   * True while an entity still simulates scripts or physics, i.e. it must be
   * stopped before its construction grid becomes selectable.
   */
  isEntityRunning(contraption: Contraption | null) {
    if (!contraption) return false;
    if (contraption.serverManaged === true && contraption.serverDesiredRunState === 'running') return true;
    if (typeof contraption.canEditInternalSelection === 'function') {
      return !contraption.canEditInternalSelection();
    }
    return contraption.scriptStatus !== 'stopped';
  }

  /**
   * Select a component level and auto-highlight its full subtree (descendants only, not the
   * parent). Clears any active world selection so the two modes never overlap.
   */
  startSubtreeSelection(contraption: Contraption, hitNodeId: string, opts: { wholeOnly?: boolean } = {}) {
    // New selection: drop any shape corners left over from a previous region.
    this.selectionShapeAnchor = null;
    if (this.selectedSubtree && this.selectedSubtree.contraption !== contraption) {
      this.selectedSubtree.contraption.clearSubtreeHighlight();
    }
    // A finished block selection on another entity keeps its orange per-block outlines
    // attached to that entity's node groups. They must be removed here as well, or the
    // old entity stays permanently highlighted after switching levels.
    if (this.selectedBlockSelection && this.selectedBlockSelection.contraption !== contraption) {
      this.selectedBlockSelection.contraption.clearSubtreeHighlight();
    }
    const result = this.performBasicAction({
      domain: ActionDomain.SELECTION,
      action: 'entity-subtree',
      target: { contraption },
      nodeId: hitNodeId
    });
    if (!result.ok) return;
    const nodeIds = result.selection?.nodeIds || this.collectSubtreeIds(contraption, hitNodeId);
    this.selectedSubtree = { contraption, rootId: hitNodeId, nodeIds };
    this.selectedBlockSelection = null;
    if (opts.wholeOnly) {
      this.selectorLevel = null;
      this.selectorRange = null;
      this.updateSelectionAxisGizmo();
    } else {
      this.selectorLevel = { contraption, nodeId: hitNodeId };
      this.selectorRange = { contraption, nodeId: hitNodeId, pointA: null, pointB: null };
      if (this.selectorShape !== 'box') {
        this.applyEntitySelectionShape(this.selectorShape);
      } else {
        this.updateSelectionAxisGizmo();
      }
    }

    const blockCount = contraption.blocks.filter(b => nodeIds.has(b.entityId || 'root')).length;
    if (this.ui && opts.wholeOnly) {
      const mayEdit = contraption.serverManaged !== true || contraption.serverCanEdit === true;
      const message = !mayEdit
        ? `Entity #${contraption.id} is read-only — inspection only (${blockCount} blocks)`
        : `Entity #${contraption.id} must be stopped, then A/B confirmed before using selection actions`;
      this.ui.showToast(message, { tone: 'warning' });
    }
  }

  /**
   * Shift a surface hit point slightly inward along the face normal so that
   * cell quantization (Math.floor) and range selection firmly target the hit
   * voxel instead of extending into the empty neighbor block along the normal.
   */
  getInwardEntityPoint(hit: EntityHit | null): THREE.Vector3 | null {
    if (!hit?.point) return null;
    let normal = hit.worldNormal;
    if (!normal && hit.normal) {
      const node = hit.contraption?.entityNodes?.get?.(hit.entityId || hit.contraption?.rootComponentId);
      if (node?.group?.getWorldQuaternion) {
        const q = node.group.getWorldQuaternion(new THREE.Quaternion());
        normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z).applyQuaternion(q).normalize();
      } else {
        normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
      }
    }
    if (!normal || (normal.x === 0 && normal.y === 0 && normal.z === 0)) {
      return hit.point.clone ? hit.point.clone() : new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z);
    }
    const isMicro = hit.kind === 'micro' || (hit.block && (hit.block.size || 1) < 1) || this.selectorMicroMode;
    const eps = isMicro ? 0.005 : 0.02;
    return new THREE.Vector3(
      hit.point.x - normal.x * eps,
      hit.point.y - normal.y * eps,
      hit.point.z - normal.z * eps
    );
  }

  /**
   * Convert a world-space click point into the target node's local coordinate frame and store it
   * as a box-selection corner.
   *
   * Components can be rotated or translated at runtime by scripts or rotors (e.g. turbine blades).
   * If the range corners were stored in world space, any movement between the two clicks would
   * misalign the stored range with the blocks, producing false "No blocks" misses. Anchoring to
   * the node's local frame means the range co-moves with the component regardless of rotation or
   * translation.
   *
   * @returns The point in node-local space, or `null` if the node no longer exists.
   */
  rangePointToLocal(range: ComponentSelection | null, worldPoint: Point3 | null) {
    return selectionGeometry.rangePointToLocal(range, worldPoint);
  }

  /**
   * Convert a node-local range corner back to world space.
   * Used for live preview rendering and diagnostic toast messages.
   *
   * @returns World-space position, or `null` if the node no longer exists.
   */
  rangePointToWorld(range: ComponentSelection | null, point: Point3 | null) {
    return selectionGeometry.rangePointToWorld(range, point);
  }

  /**
   * Describe an entity selection range in its authored voxel grid. Range
   * points are stored relative to the node pivot, while renderer cell
   * quantization expects entity-local voxel coordinates, so the pivot is
   * added back here. The renderer uses the live node group as the frame so
   * previews inherit root and child rotations, including render interpolation.
   */
  rangePreviewFrame(range: ComponentSelection | null) {
    return selectionGeometry.rangePreviewFrame(range);
  }

  rangePointToPreviewGrid(range: ComponentSelection | null, point: Point3 | null) {
    return selectionGeometry.rangePointToPreviewGrid(range, point);
  }

  worldPointToRangePreviewGrid(range: ComponentSelection | null, worldPoint: Point3 | null) {
    return selectionGeometry.worldPointToRangePreviewGrid(range, worldPoint);
  }

  /**
   * Finalize a 2-point AABB box-selection for the current component level.
   *
   * Collects all blocks owned directly by `range.nodeId` (child-component blocks are excluded)
   * whose AABB intersects the selection box. Block-AABB intersection is used instead of
   * block-center containment because the two surface clicks typically form a near-zero-thickness
   * slab — center-point testing would miss many surface blocks.
   *
   * If no own blocks are found the method tries to auto-detect which other component's blocks
   * fall inside the range and switches to that level automatically.
   */
  resolveBlockRangeSelection(range: ComponentRange) {
    const { contraption, nodeId, pointA, pointB } = range;
    const node = contraption.entityNodes.get(nodeId);
    if (!node || !pointA || !pointB) {
      // Target component no longer exists — discard this range.
      range.pointA = null;
      range.pointB = null;
      this.selectorRange = null;
      if (this.ui) this.ui.showToast(`Level [${nodeId}] no longer exists - selection reset`, { tone: 'warning' });
      return;
    }
    const result = this.performBasicAction({
      domain: ActionDomain.SELECTION,
      action: 'entity-box',
      target: { contraption },
      nodeId,
      a: pointA,
      b: pointB,
      space: 'node-local',
      // Micro mode (Tab) keeps only 0.125 m blocks inside the range.
      micro: this.selectorMicroMode === true,
      allComponents: range.allComponents !== false
    });

    if (!result.ok) {
      range.pointA = null;
      range.pointB = null;
      if (this.ui) {
        if (result.reason === 'entity_not_stopped') {
          this.ui.showToast(`Entity #${contraption.id} is not stopped — stop it with Wrench before selecting blocks`, { tone: 'warning' });
        } else {
          this.ui.showToast(`No blocks inside this range - try again`, { tone: 'warning' });
        }
      }
      return;
    }

    let selected = result.selection?.blocks ?? [];
    const components = result.components || [];

    // A selection cannot include blocks already assigned to child components.
    const hasOtherComponentBlocks = selected.some((b: any) => contraptionBlockOwnerId(contraption, b) !== nodeId);
    if (hasOtherComponentBlocks || components.length > 1 || (components.length === 1 && components[0] !== nodeId)) {
      this.clearSelection();
      if (this.ui) this.ui.showToast('The selection cannot include blocks assigned to child components.', { tone: 'warning' });
      return;
    }

    const isMicro = this.selectorMicroMode === true;

    // Micro mode must select 0.125 m voxels, not whole 1 m blocks. The component
    // may not own any micro geometry yet, so the range is resolved into a
    // *virtual* micro selection: every micro cell of a covered standard block is
    // synthesized in place (non-destructively). The entity is only subdivided
    // later, when Del/F/P/G actually mutate the geometry.
    if (isMicro) {
      const cellRange = this.entityMicroCellRangeForBox(range);
      const virtual = cellRange
        ? this.buildEntityMicroSelection(contraption, nodeId, (x: number, y: number, z: number) => (
          x >= cellRange.minX && x <= cellRange.maxX &&
          y >= cellRange.minY && y <= cellRange.maxY &&
          z >= cellRange.minZ && z <= cellRange.maxZ
        ), cellRange)
        : null;
      if (virtual) {
        selected = virtual;
      } else {
        // Do not fall back to the coarse engine query: Del would then remove
        // whole standard blocks from an oversized micro selection.
        this.clearSelection();
        this.ui?.showToast?.(
          `Micro selection is too large (limit ${MAX_MICRO_SELECTION_CELLS} voxels) — narrow the box`,
          { tone: 'warning' }
        );
        return;
      }
    }

    const targetNodeId = nodeId;
    this.selectedSubtree = null;
    this.selectedBlockSelection = {
      contraption,
      nodeId: targetNodeId,
      blocks: selected,
      micro: isMicro,
      virtualMicro: selected.some((b: any) => b.virtualMicro === true),
      gradientEligible: range.gradientEligible !== false,
      confirmedRange: { pointA: { ...pointA }, pointB: { ...pointB } },
      bounds: this.getEntitySelectionBounds(selected, isMicro)
    };
    contraption.clearSubtreeHighlight?.();
    contraption.highlightBlocks?.(selected);
    this.selectorLevel = { contraption, nodeId: targetNodeId };
    // Box-selection complete: exit box mode. The next click anywhere will start a fresh re-box.
    this.selectorRange = null;
    if (this.selectorShape !== 'box') {
      const gridA = this.rangePointToPreviewGrid(range, pointA);
      const gridB = this.rangePointToPreviewGrid(range, pointB);
      let anchorA: any = undefined;
      let anchorB: any = undefined;
      if (gridA && gridB) {
        anchorA = isMicro
          ? { x: Math.round(gridA.x * MICRO_DIVISIONS), y: Math.round(gridA.y * MICRO_DIVISIONS), z: Math.round(gridA.z * MICRO_DIVISIONS) }
          : { x: Math.floor(gridA.x + 1e-6), y: Math.floor(gridA.y + 1e-6), z: Math.floor(gridA.z + 1e-6) };
        anchorB = isMicro
          ? { x: Math.round(gridB.x * MICRO_DIVISIONS), y: Math.round(gridB.y * MICRO_DIVISIONS), z: Math.round(gridB.z * MICRO_DIVISIONS) }
          : { x: Math.floor(gridB.x + 1e-6), y: Math.floor(gridB.y + 1e-6), z: Math.floor(gridB.z + 1e-6) };
      }
      this.applyEntitySelectionShape(this.selectorShape, anchorA, anchorB);
    } else {
      this.updateSelectionAxisGizmo();
    }
  }

  /**
   * Node-local 0.125 m cell index under an entity standard-block hit. Matches the
   * surface micro cell the selector cursor highlights, so Shift+click toggles
   * exactly the voxel the player is aiming at.
   */
  private entityMicroCellFromHit(hit: EntityHit | null) {
    const place = hit?.placeMicroPos;
    if (!place) return null;
    const normal = hit.normal || { x: 0, y: 0, z: 0 };
    return {
      x: Math.floor((place.localX - (normal.x || 0) * (MICRO_SIZE / 2)) * MICRO_DIVISIONS),
      y: Math.floor((place.localY - (normal.y || 0) * (MICRO_SIZE / 2)) * MICRO_DIVISIONS),
      z: Math.floor((place.localZ - (normal.z || 0) * (MICRO_SIZE / 2)) * MICRO_DIVISIONS)
    };
  }

  /**
   * Authored-space 0.125 m cell index AABB covered by a node-local box range.
   * Mirrors the engine's block-AABB intersection (both endpoints inclusive),
   * so the synthesized micro cells match the blocks the shared query selects.
   */
  private entityMicroCellRangeForBox(range: ComponentRange) {
    return selectionGeometry.entityMicroCellRangeForBox(range);
  }

  /**
   * Build a **virtual** micro selection for a component: real micro blocks inside
   * the region are reused, and every 0.125 m cell of a covered 1 m block is
   * synthesized as a lightweight descriptor (`virtualMicro` + `sourceBlock`) that
   * is NOT added to the entity. The geometry is only subdivided when an operation
   * (Del/F/P/G) actually needs real voxels.
   *
   * @returns The descriptor list, or `null` when the region exceeds
   *   {@link MAX_MICRO_SELECTION_CELLS} cells.
   */
  private buildEntityMicroSelection(contraption: Contraption, nodeId: string, contains: (x: number, y: number, z: number) => boolean, bounds: CollisionBounds) {
    return selectionGeometry.buildEntityMicroSelection(contraption, nodeId, contains, bounds);
  }

  /** Cell key used to compare a block descriptor with a 0.125 m cell index. */
  private microCellKey(block: RuntimeVoxel) {
    return selectionGeometry.microCellKey(block);
  }

  /**
   * Replace the current selection with a virtual micro selection made of the
   * given descriptors, refreshing highlights, bounds and the shape gizmo.
   */
  private setVirtualMicroSelection(contraption: Contraption, nodeId: string, blocks: SelectedVoxel[]) {
    this.selectedSubtree = null;
    this.selectedBlockSelection = {
      contraption,
      nodeId,
      blocks,
      micro: true,
      virtualMicro: blocks.some((b: any) => b.virtualMicro === true),
      bounds: this.getEntitySelectionBounds(blocks, true)
    };
    this.selectorLevel = { contraption, nodeId };
    this.selectorRange = null;
    contraption.clearSubtreeHighlight?.();
    contraption.highlightBlocks?.(blocks);
    this.updateSelectionAxisGizmo();
  }

  /**
   * Lazily subdivide the standard blocks behind a virtual micro selection and
   * swap the virtual descriptors for the real micro voxels that now exist.
   *
   * Called only by mutating operations (Del / F / P / G); selecting and copying
   * never touch entity geometry.
   *
   * @returns `true` when the selection is backed by real blocks afterwards.
   */
  private materializeMicroSelection() {
    const selection = this.selectedBlockSelection;
    if (!selection?.micro) return true;
    const virtual = (selection.blocks || []).filter((b: any) => b.virtualMicro === true);
    if (virtual.length === 0) return true;

    const { contraption, nodeId } = selection;
    const sources = new Set<any>();
    for (const block of virtual) {
      if (block.sourceBlock) sources.add(block.sourceBlock);
    }
    if (sources.size === 0) return true;
    if (sources.size > MAX_MICRO_MATERIALIZE_BLOCKS) {
      this.ui?.showToast?.(
        `Micro edit would subdivide ${sources.size} standard blocks (limit ${MAX_MICRO_MATERIALIZE_BLOCKS}) — narrow the selection`,
        { tone: 'warning' }
      );
      return false;
    }

    // Subdivide every source block through one batched action. Calling the
    // single-block `subdivide-standard` action per block rebuilt collision,
    // picking and chunk meshes for every block, which dominated the cost of a
    // micro Del/F/P even for tiny entities.
    const result = this.performBasicAction({
      domain: ActionDomain.ENTITY,
      action: 'subdivide-cells',
      target: { contraption },
      nodeId,
      cells: [...sources].map((source: any) => ({
        x: Math.floor(source.localX + 1e-6),
        y: Math.floor(source.localY + 1e-6),
        z: Math.floor(source.localZ + 1e-6)
      }))
    });
    if (!result?.ok) {
      this.ui?.showToast?.('Could not subdivide the selected blocks for micro editing', { tone: 'warning' });
      return false;
    }

    // Map every selected cell to the real micro voxel now occupying it.
    const realMicroByCell = new Map<string, any>();
    for (const block of contraption.blocks) {
      if (contraptionBlockOwnerId(contraption, block) !== nodeId) continue;
      if ((block.size || 1) >= 1) continue;
      realMicroByCell.set(this.microCellKey(block), block);
    }
    const realBlocks: any[] = [];
    for (const block of selection.blocks) {
      if (!block.virtualMicro) {
        realBlocks.push(block);
        continue;
      }
      const real = realMicroByCell.get(this.microCellKey(block));
      if (real) realBlocks.push(real);
    }
    selection.blocks = realBlocks;
    selection.virtualMicro = false;
    selection.bounds = this.getEntitySelectionBounds(realBlocks, true);
    this.ui?.notifyContraptionStructureChanged?.(contraption);
    return true;
  }

  /**
   * G key (Selector + block selection): create a child component from the currently box-selected
   * blocks under the active level.
   */
  private preparedChildBoundsStep(bounds: CollisionBounds, block: RuntimeVoxel) {
    const size = block.size || 1;
    bounds.minX = Math.min(bounds.minX, block.localX);
    bounds.minY = Math.min(bounds.minY, block.localY);
    bounds.minZ = Math.min(bounds.minZ, block.localZ);
    bounds.maxX = Math.max(bounds.maxX, block.localX + size);
    bounds.maxY = Math.max(bounds.maxY, block.localY + size);
    bounds.maxZ = Math.max(bounds.maxZ, block.localZ + size);
  }

  private finishPreparedChildCreation(contraption: Contraption, nodeId: string, blocks: RuntimeVoxel[], bounds: CollisionBounds, legacy = false) {
    const result = this.performBasicAction({
      domain: ActionDomain.SELECTION,
      action: 'create-child',
      selection: {
        kind: 'entity-blocks',
        contraption,
        nodeId,
        blocks,
        preparedBounds: bounds
      }
    });
    const child = result.child;
    if (!child) {
      this.ui?.showToast?.(result.reason === 'entity_not_stopped'
        ? 'Stop the entity before assembling a sub-contraption'
        : 'Could not assemble a sub-contraption from this selection');
      return null;
    }
    contraption.clearSubtreeHighlight?.();
    this.sound?.playAssemblyClack?.();
    if (legacy) {
      this.ui?.showToast?.(`Sub-contraption ${child.id} assembled · control it via self.child('${child.id}')`);
      this.ui?.renderComponentTree?.();
      this.ui?.renderCodeTabs?.();
      this.ui?.updateInspectorProperties?.(child.id);
    } else {
      this.selectorLevel = { contraption, nodeId };
      this.ui?.showToast?.(`Assembled sub-contraption [${child.id}] from ${blocks.length} blocks under [${nodeId}] · press C to program`);
    }
    return child;
  }

  private startLargeChildCreation(contraption: Contraption, nodeId: string, candidates: Iterable<RuntimeVoxel>, legacy = false, selectedCells: ReadonlySet<string> | null = null) {
    const source = [...candidates];
    const prepared: any[] = [];
    const bounds = {
      minX: Infinity, minY: Infinity, minZ: Infinity,
      maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity
    };
    return this.startBulkEditJob({
      label: 'Assembling sub-contraption',
      total: source.length,
      mutatesWorld: false,
      detail: 'Preparing component blocks',
      step: (index: number) => {
        const block = source[index];
        if (contraptionBlockOwnerId(contraption, block) !== nodeId) return 0;
        if (selectedCells) {
          const key = `${Math.floor(block.localX + 1e-6)},${Math.floor(block.localY + 1e-6)},${Math.floor(block.localZ + 1e-6)}`;
          if (!selectedCells.has(key)) return 0;
        }
        prepared.push(block);
        this.preparedChildBoundsStep(bounds, block);
        return 1;
      },
      finish: () => this.finishPreparedChildCreation(contraption, nodeId, prepared, bounds, legacy)
    });
  }

  createChildFromSelectedBlocks() {
    if (this.bulkEditJob) {
      this.ui?.showToast?.(`Please wait for ${this.bulkEditJob.label.toLowerCase()} to finish`);
      return null;
    }
    if (!this.requireConfirmedSelection('assembling a sub-contraption')) return null;
    const sel = this.selectedBlockSelection;
    if (!sel || !sel.contraption || sel.blocks.length === 0) {
      if (this.ui) this.ui.showToast('No block selection - box-select blocks of a level first');
      return;
    }
    // G moves real voxels into a child, so a virtual micro selection must be
    // subdivided into real 0.125 m blocks first.
    if (!this.materializeMicroSelection()) return null;
    const { contraption, blocks } = sel;
    if (!this.canEditEntityInternals(contraption)) {
      this.clearSelection();
      this.ui?.showToast?.('Stop the entity before assembling a sub-contraption');
      return null;
    }

    // Validation: all selected blocks must belong to the same component and share that common parent
    const components = new Set<string>();
    for (const b of blocks) {
      const owner = contraptionBlockOwnerId(contraption, b);
      if (owner) components.add(owner);
    }
    if (components.size > 1) {
      const sorted = Array.from(components).sort();
      if (this.ui) {
        this.ui.showToast(
          `Range covers multiple components (${sorted.join(', ')}) - sub-selection cannot span across components`,
          { tone: 'warning' }
        );
      }
      return null;
    }
    const targetNodeId = [...components][0] || sel.nodeId;
    if (!targetNodeId || !contraption.entityNodes.has(targetNodeId)) {
      if (this.ui) {
        this.ui.showToast(`Level [${targetNodeId}] no longer exists - selection reset`, { tone: 'warning' });
      }
      return null;
    }
    sel.nodeId = targetNodeId;
    const nodeId = targetNodeId;

    // The entire parent component cannot become a child component.
    const totalParentBlocks = contraption.blocks.filter((b: any) => contraptionBlockOwnerId(contraption, b) === nodeId).length;
    if (blocks.length >= totalParentBlocks) {
      if (this.ui) {
        this.ui.showToast('Select only part of the parent component to assemble a sub-contraption.', { tone: 'warning' });
      }
      return null;
    }

    if (blocks.length > BULK_EDIT_THRESHOLD) {
      const started = this.startLargeChildCreation(contraption, nodeId, blocks);
      if (started) {
        contraption.clearSubtreeHighlight?.();
        this.selectedBlockSelection = null;
        this.selectorRange = null;
      }
      return started;
    }
    const result = this.performBasicAction({
      domain: ActionDomain.SELECTION,
      action: 'create-child',
      selection: { kind: 'entity-blocks', contraption, nodeId, blocks }
    });
    const child = result.child;
    if (child) {
      contraption.clearSubtreeHighlight();
      this.selectedBlockSelection = null;
      this.selectorLevel = { contraption, nodeId }; // Keep level active so another region can be box-selected immediately.
      this.sound?.playAssemblyClack?.();
      if (this.ui) {
        this.ui.showToast(`Assembled sub-contraption [${child.id}] from ${blocks.length} blocks under [${nodeId}] · press C to program`);
      }
      return child;
    } else if (this.ui) {
      if (result.reason === 'multiple_components') {
        const sorted = (result.components || []).sort();
        this.ui.showToast(
          `Range covers multiple components (${sorted.join(', ')}) - sub-selection cannot span across components`,
          { tone: 'warning' }
        );
      } else {
        this.ui.showToast(result.reason === 'entity_not_stopped'
          ? 'Stop the entity before assembling a sub-contraption'
          : 'Could not assemble a sub-contraption from this selection');
      }
    }
  }

  /** Returns true if there is an active world or entity selection. */
  hasActiveSelection(): boolean {
    if (this.selectedBlockSelection && this.selectedBlockSelection.blocks?.length > 0) {
      return true;
    }
    if (this.selectedSubtree && this.selectedSubtree.contraption) {
      return true;
    }
    if (this.contraptions && typeof this.contraptions.hasValidSelection === 'function' && this.contraptions.hasValidSelection()) {
      return true;
    }
    return false;
  }

  /**
   * Smart copy (R key or Copy button):
   * - Confirmed entity blocks copy as an entity.
   * - World selections combine the selected voxels and fully enclosed entities in one Item.
   * - A-only, subtree and Shift preselection are rejected.
   * - If nothing is selected, shows a helpful toast.
   */
  copySelectionSmart() {
    if (!this.requireConfirmedSelection('copying')) return null;
    if (this.selectedBlockSelection && this.selectedBlockSelection.blocks.length > 0) {
      return this.copySelectionToInventory();
    }
    if (this.selectedSubtree && this.selectedSubtree.contraption) {
      return this.copySelectionToInventory();
    }
    if (this.contraptions && this.contraptions.hasValidSelection()) {
      return this.copyWorldSelectionToInventory();
    }
    if (this.ui) {
      this.ui.showToast('Nothing selected - select an entity/component or box-select blocks, then press R');
    }
    return null;
  }

  /** The cyan outer box defines which complete entities accompany orange world cells. */
  private captureWorldSelectionEntities() {
    const manager = this.contraptions;
    const micro = Array.isArray(manager?.microSelection);
    const bounds = micro ? manager.getMicroSelectionBounds?.() : manager?.getSelectionBounds?.();
    if (!bounds) return null;
    const step = micro ? MICRO_SIZE : 1;
    const origin = new THREE.Vector3(bounds.minX, bounds.minY, bounds.minZ).multiplyScalar(step);
    const region = new THREE.Box3(origin.clone(), new THREE.Vector3(
      bounds.maxX + 1, bounds.maxY + 1, bounds.maxZ + 1,
    ).multiplyScalar(step)).expandByScalar(STOPPED_GRID_EPSILON);
    const center = region.getCenter(new THREE.Vector3());
    const blockBounds = new THREE.Box3();
    const entityList = [];
    let voxelCount = 0;
    for (const entity of manager.contraptions || []) {
      if (!entity.blocks?.length) continue;
      let periodicOffset: THREE.Vector3 | null = null;
      let enclosed = true;
      for (const block of entity.blocks) {
        entity.getBlockWorldBounds(block, blockBounds);
        if (blockBounds.isEmpty()) { enclosed = false; break; }
        if (!periodicOffset) {
          const blockCenter = blockBounds.getCenter(new THREE.Vector3());
          periodicOffset = new THREE.Vector3(
            Math.round((center.x - blockCenter.x) / TORUS_SIZE_X) * TORUS_SIZE_X, 0,
            Math.round((center.z - blockCenter.z) / TORUS_SIZE_Z) * TORUS_SIZE_Z,
          );
        }
        // Most loaded entities are outside the region; reject at the first outside voxel.
        if (!region.containsBox(blockBounds.translate(periodicOffset))) { enclosed = false; break; }
      }
      if (!enclosed || !periodicOffset) continue;
      voxelCount += entity.blocks.length;
      if (voxelCount > MAX_INVENTORY_BLOCKS) throw new Error('Selected entities exceed the Item voxel limit');
      const source = entity.serializeSubtree(contraptionRootId(entity));
      if (!source) throw new Error('Selected entity no longer exists');
      const portable = this.serializeInventoryItem('entity', source);
      const position = new THREE.Vector3().fromArray(source.sourcePosition).add(periodicOffset).sub(origin);
      portable.root.localPosition = position.toArray();
      portable.root.localRotation = [...source.sourceRotation];
      // World endpoints belong to the Item frame; body-local endpoints keep their own frames.
      for (const constraint of portable.constraints || []) {
        if (constraint.bodyA != null || !constraint.anchorA) continue;
        constraint.anchorA = new THREE.Vector3().fromArray(constraint.anchorA)
          .add(periodicOffset).sub(origin).toArray();
      }
      entityList.push(portable);
    }
    return { origin, entityList };
  }

  /** R copies one portable Item without editing or stopping any enclosed source entity. */
  copyWorldSelectionToInventory() {
    if (this.bulkEditJob) {
      this.ui?.showToast?.(`Please wait for ${this.bulkEditJob.label.toLowerCase()} to finish`);
      return null;
    }
    if (!this.requireConfirmedSelection('copying')) return null;
    try {
      const capture = this.captureWorldSelectionEntities();
      if (!capture) return null;
      if (this.contraptions.getSelectionBlockCount?.() > BULK_EDIT_THRESHOLD) {
        return this.startLargeWorldBlockSetCopy(this.contraptions, capture);
      }
      return this.finishWorldSelectionCopy(this.sampleWorldSelectionAsBlockSet(capture.origin), capture);
    } catch (error) {
      this.ui?.showToast?.(`Copy failed: ${error instanceof Error ? error.message : 'Invalid selection'}`, { tone: 'warning' });
      return null;
    }
  }

  private finishWorldSelectionCopy(blocks: InventoryVoxel[], capture: WorldSelectionCapture) {
    if (!blocks.length && !capture.entityList.length) {
      this.ui?.showToast?.('Selection contains no world voxels or fully enclosed entities');
      return null;
    }
    const name = `world selection (${blocks.length} voxels, ${capture.entityList.length} entities)`;
    const portable = {
      type: 'space-item', version: INVENTORY_PROTOBUF_SCHEMA_VERSION, id: newItemTemplateId(), name,
      ...(blocks.length ? { blockSet: this.serializeInventoryItem('blockset', { name, blocks }) } : {}),
      entityList: capture.entityList,
    };
    const parsed = this.parseInventoryImport(encodeInventoryResource('item', portable), 'item');
    if (!parsed.ok) {
      this.ui?.showToast?.(`Copy failed: ${parsed.error}`, { tone: 'warning' });
      return null;
    }
    const index = this.addInventoryItem('item', parsed.item);
    if (index === null) {
      this.ui?.showToast?.(`Item inventory is full (${MAX_BACKPACK_ITEM_SLOTS}) - delete one first`);
      return null;
    }
    this.setActiveInventoryCategory('item');
    this.ui?.renderInventoryBar?.();
    this.clearSelection();
    this.activateTool(SpecialTool.HAMMER);
    this.ui?.showToast?.(`Copied ${blocks.length} selected voxels and ${capture.entityList.length} entities to item slot ${index + 1} · switched to Hammer`);
    return parsed.item;
  }

  /**
   * Copy the currently selected component/entity into the active entity inventory slot.
   *
   * Sources, in priority order:
   *
   * - **Block selection** (2-point box): copies the selected own-blocks as a standalone entity
   *   slot.
   * - First-click subtree preselection is not sufficient; A/B must be confirmed.
   */
  private stripCopiedBottomGap<T extends InventoryVoxel>(blocks: T[], yKey: 'dy' | 'localY') {
    if (!Array.isArray(blocks) || blocks.length === 0) return blocks;
    let minY = Infinity;
    for (const block of blocks) {
      const y = Number(block?.[yKey]);
      if (Number.isFinite(y) && y < minY) minY = y;
    }
    if (!Number.isFinite(minY) || Math.abs(minY) < 1e-9) return blocks;

    // A copied selection gets a fresh placement origin. Anchor its lowest
    // occupied voxel there instead of preserving empty micro layers inherited
    // from the source cell/component (for example, a top layer at y = 0.8).
    return blocks.map(block => ({
      ...block,
      [yKey]: Math.round((Number(block[yKey]) - minY) * MICRO_DIVISIONS) / MICRO_DIVISIONS
    }));
  }

  copySelectionToInventory() {
    if (!this.requireConfirmedSelection('copying')) return null;
    if (this.selectedBlockSelection && this.selectedBlockSelection.blocks.length > 0) {
      const { contraption, nodeId, blocks } = this.selectedBlockSelection;
      if (!this.canEditEntityInternals(contraption)) {
        this.clearSelection();
        this.ui?.showToast?.('Stop the entity before copying an internal block selection');
        return null;
      }
      const slot = contraption.serializeSubtree(nodeId);
      if (!slot) return null;
      const slotRootId = inventoryEntityRootId(slot);
      const copiedMinY = Math.min(...blocks.map(block => Number(block.localY)));
      if (slot.decorations?.length) slot.decorations = offsetDecorations(slot.decorations, [0, -copiedMinY, 0]);
      slot.blocks = this.stripCopiedBottomGap(
        // Virtual micro descriptors carry resolver-only fields that must not leak
        // into the portable inventory payload.
        blocks.map(b => {
          const { virtualMicro, sourceBlock, ...rest } = b as any;
          return { ...rest, entityId: slotRootId };
        }),
        'localY'
      );
      slot.blockCount = blocks.length;
      // A block selection copies only the level's own blocks (children excluded), so
      // descendants must be pruned to avoid empty ghost components and orphaned scripts.
      slot.childEntities = [];
      slot.scripts = (slot.scripts || []).filter(s => s.id === slotRootId);
      slot.enabled = (slot.enabled || []).filter(e => e.id === slotRootId);
      slot.constraints = (slot.constraints || []).filter(constraint => (
        constraint.bodyA === null && constraint.bodyB === slotRootId
      ));
      slot.nodeCount = 1;
      const index = this.addInventoryItem('entity', slot);
      if (index === null) {
        this.ui?.showToast?.(`Item inventory is full (${this.inventories.entity.items.length}) - delete one first`);
        return null;
      }
      this.setActiveInventoryCategory('entity');
      this.ui?.renderInventoryBar?.();
      this.clearSelection();
      this.activateTool(SpecialTool.HAMMER);
      if (this.ui) {
        this.ui.showToast(`Copied ${blocks.length} own blocks of [${nodeId}] to item slot ${index + 1} · switched to Hammer`);
      }
      return slot;
    }
    if (this.selectedSubtree && this.selectedSubtree.contraption) {
      return this.copySelectedSubtreeToInventory();
    }
    if (this.contraptions && this.contraptions.hasValidSelection()) {
      return this.copyWorldSelectionToInventory();
    }
    if (this.ui) this.ui.showToast('Nothing selected - click an entity/component with the selector, or box-select its blocks');
    return null;
  }

  /**
   * T key: copy the current selection as a raw **block set** into the active
   * inventory slot. Pasting stamps plain world blocks — no entity is created.
   *
   * This is the sibling of R (copy as entity): R keeps the full component hierarchy
   * and scripts, while T keeps only the raw voxels (standard blocks + micro voxels).
   *
   * Sources, in priority order:
   * 1. **Block selection** (2-point box on a level): the selected own-blocks.
   * 2. **Subtree selection** (first-click level): all blocks of the subtree.
   * 3. **World selection** (2-point box / single cells): read-only sampling of the
   *    world — the original blocks stay in place (unlike G, which extracts them).
   */
  private finishBlockSetCopy(rawBlocks: InventoryVoxel[], name: string) {
    if (!Array.isArray(rawBlocks) || rawBlocks.length === 0) {
      this.ui?.showToast?.('Selection region is empty (no voxels to copy)');
      return null;
    }
    const blocks = this.stripCopiedBottomGap(rawBlocks, 'dy');
    const slot = { kind: 'blockset', name, blocks, blockCount: blocks.length };
    const index = this.addInventoryItem('blockset', slot);
    if (index === null) {
      this.ui?.showToast?.(`Item inventory is full (${this.inventories.item.items.length}) - delete one first`);
      return null;
    }
    this.setActiveInventoryCategory('blockset');
    this.ui?.renderInventoryBar?.();
    this.clearSelection();
    this.activateTool(SpecialTool.HAMMER);
    this.ui?.showToast?.(`Copied ${rawBlocks.length} voxels as a block set to block set slot ${index + 1} · switched to Hammer · left-click to build`);
    return slot;
  }

  /** Two-pass, frame-sliced normalization for entity-local block selections. */
  private startLargeEntityBlockSetCopy(blocks: RuntimeVoxel[], name: string) {
    const source = [...blocks];
    const rawBlocks: any[] = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    return this.startBulkEditJob({
      label: 'Copying block set',
      total: source.length * 2,
      mutatesWorld: false,
      detail: job => job.processed < source.length ? 'Measuring selection' : 'Preparing inventory voxels',
      step: (index: number) => {
        const sourceIndex = index % source.length;
        const block = source[sourceIndex];
        if (index < source.length) {
          minX = Math.min(minX, block.localX);
          minY = Math.min(minY, block.localY);
          minZ = Math.min(minZ, block.localZ);
          return 0;
        }
        rawBlocks.push({
          dx: block.localX - minX,
          dy: block.localY - minY,
          dz: block.localZ - minZ,
          size: block.size || 1,
          block: block.block,
          color: block.color,
          materialId: normalizeVoxelMaterialId(block.materialId),
          part: block.part
        });
        return 1;
      },
      finish: () => this.finishBlockSetCopy(rawBlocks, name)
    });
  }

  /** Read one standard world cell and all of its carved micro voxels. */
  private sampleWorldCellForBulkCopy(cell: Point3, consider: (x: number, y: number, z: number, size: number, block: number, color: number, part?: string | null, materialId?: number) => void) {
    const block = this.world.getBlock?.(cell.x, cell.y, cell.z);
    if (block !== BlockTypes.AIR) {
      consider(cell.x, cell.y, cell.z, 1, block,
        this.world.getBlockColor?.(cell.x, cell.y, cell.z), null,
        this.world.getBlockMaterial?.(cell.x, cell.y, cell.z));
    }
    const micros = this.world.getMicroBlocksInAABB?.({
      minX: cell.x,
      minY: cell.y,
      minZ: cell.z,
      maxX: cell.x + 1 - 1e-6,
      maxY: cell.y + 1 - 1e-6,
      maxZ: cell.z + 1 - 1e-6
    }) || [];
    for (const micro of micros) {
      consider(micro.x, micro.y, micro.z, micro.size || MICRO_SIZE,
        BlockTypes.COLOR_BLOCK, micro.color, micro.part, micro.materialId);
    }
  }

  /** Scan and normalize a large world selection through the shared executor. */
  private startLargeWorldBlockSetCopy(manager: ContraptionManager, itemCapture: WorldSelectionCapture | null = null) {
    const microCells = Array.isArray(manager.microSelection)
      ? manager.microSelection.map(cell => ({ x: cell.x, y: cell.y, z: cell.z }))
      : null;
    const bounds = manager.getSelectionBounds?.();
    const sparseCells = !microCells && manager.connectedSelection !== null
      ? [...(manager.connectedSelection || [])].map(cell => ({ x: cell.x, y: cell.y, z: cell.z }))
      : null;
    if (!microCells && !bounds) return false;

    const sizeY = bounds ? bounds!.maxY - bounds!.minY + 1 : 0;
    const sizeZ = bounds ? bounds!.maxZ - bounds!.minZ + 1 : 0;
    const scanTotal = microCells?.length
      ?? sparseCells?.length
      ?? ((bounds!.maxX - bounds!.minX + 1) * sizeY * sizeZ);
    const collected: any[] = [];
    const rawBlocks: any[] = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    const consider = (x: number, y: number, z: number, size: number, block: number, color: number, part: string | null = null, materialId = 0) => {
      collected.push({ x, y, z, size, block, color, part, materialId });
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
    };
    const cellAt = (index: number) => sparseCells?.[index] || {
      x: bounds!.minX + Math.floor(index / (sizeY * sizeZ)),
      y: bounds!.minY + Math.floor(index / sizeZ) % sizeY,
      z: bounds!.minZ + index % sizeZ
    };

    const started = this.startBulkEditJob({
      label: 'Copying world selection',
      total: scanTotal,
      mutatesWorld: false,
      detail: job => job.processed < scanTotal ? 'Scanning selected cells' : 'Normalizing inventory voxels',
      step: (index: number, job) => {
        if (index < scanTotal) {
          if (microCells) {
            const cell = microCells[index];
            const existing = this.world.getMicroBlock?.(cell.x, cell.y, cell.z);
            let color = existing?.color;
            let part = null;
            let materialId = existing?.materialId ?? 0;
            if (existing) {
              const exact = this.world.getMicroBlocksInAABB?.({
                minX: cell.x / MICRO_DIVISIONS,
                minY: cell.y / MICRO_DIVISIONS,
                minZ: cell.z / MICRO_DIVISIONS,
                maxX: cell.x / MICRO_DIVISIONS,
                maxY: cell.y / MICRO_DIVISIONS,
                maxZ: cell.z / MICRO_DIVISIONS
              })?.[0];
              part = exact?.part ?? null;
            } else {
              const wx = Math.floor(cell.x / MICRO_DIVISIONS);
              const wy = Math.floor(cell.y / MICRO_DIVISIONS);
              const wz = Math.floor(cell.z / MICRO_DIVISIONS);
              if (this.world.getBlock?.(wx, wy, wz) !== BlockTypes.AIR) {
                color = this.world.getBlockColor?.(wx, wy, wz);
                materialId = this.world.getBlockMaterial?.(wx, wy, wz) ?? 0;
              }
            }
            if (color !== null && color !== undefined) {
              consider(
                cell.x / MICRO_DIVISIONS,
                cell.y / MICRO_DIVISIONS,
                cell.z / MICRO_DIVISIONS,
                MICRO_SIZE,
                BlockTypes.COLOR_BLOCK,
                color,
                part,
                materialId,
              );
            }
          } else {
            this.sampleWorldCellForBulkCopy(cellAt(index), consider);
          }
          if (index === scanTotal - 1) job.total += collected.length;
          return 0;
        }

        const item = collected[index - scanTotal];
        const origin = itemCapture?.origin || { x: minX, y: minY, z: minZ };
        rawBlocks.push({
          dx: microCells ? Math.round((item.x - origin.x) * MICRO_DIVISIONS) / MICRO_DIVISIONS : item.x - origin.x,
          dy: microCells ? Math.round((item.y - origin.y) * MICRO_DIVISIONS) / MICRO_DIVISIONS : item.y - origin.y,
          dz: microCells ? Math.round((item.z - origin.z) * MICRO_DIVISIONS) / MICRO_DIVISIONS : item.z - origin.z,
          size: item.size,
          block: item.block,
          color: item.color,
          materialId: normalizeVoxelMaterialId(item.materialId),
          part: item.part
        });
        return 1;
      },
      finish: () => itemCapture
        ? this.finishWorldSelectionCopy(rawBlocks, itemCapture)
        : this.finishBlockSetCopy(rawBlocks, `world selection (${rawBlocks.length} voxels)`)
    });
    if (started && !itemCapture) manager.clearSelection?.();
    return started;
  }

  copySelectionAsBlockSet() {
    if (this.bulkEditJob) {
      this.ui?.showToast?.(`Please wait for ${this.bulkEditJob.label.toLowerCase()} to finish`);
      return null;
    }
    if (!this.requireConfirmedSelection('copying')) return null;
    let rawBlocks = null;
    let name = '';

    // 1. Entity block selection (2-point box on a component level)
    if (this.selectedBlockSelection && this.selectedBlockSelection.blocks.length > 0) {
      const { contraption, nodeId, blocks } = this.selectedBlockSelection;
      if (!this.canEditEntityInternals(contraption)) {
        this.clearSelection();
        this.ui?.showToast?.('Stop the entity before copying an internal block selection');
        return null;
      }
      if (blocks.length > BULK_EDIT_THRESHOLD) {
        const started = this.startLargeEntityBlockSetCopy(blocks, `${blocks.length} blocks of [${nodeId}]`);
        if (started) {
          contraption.clearSubtreeHighlight?.();
          this.selectedBlockSelection = null;
          this.selectorRange = null;
        }
        return started;
      }
      const minX = Math.min(...blocks.map(b => b.localX));
      const minY = Math.min(...blocks.map(b => b.localY));
      const minZ = Math.min(...blocks.map(b => b.localZ));
      rawBlocks = blocks.map(b => ({
        dx: b.localX - minX,
        dy: b.localY - minY,
        dz: b.localZ - minZ,
        size: b.size || 1,
        block: b.block,
        color: b.color == null ? undefined : normalizeColor(b.color),
        materialId: normalizeVoxelMaterialId(b.materialId),
        part: b.part
      }));
      name = `${blocks.length} blocks of [${nodeId}]`;
    }

    // 2. Subtree selection (first-click level): every block owned by the subtree.
    if (!rawBlocks && this.selectedSubtree && this.selectedSubtree.contraption) {
      const { contraption, rootId } = this.selectedSubtree;
      if (rootId !== contraptionRootId(contraption) && !this.canEditEntityInternals(contraption)) {
        this.clearSelection();
        this.ui?.showToast?.('Stop the entity before copying one of its internal components');
        return null;
      }
      const nodeIds = this.selectedSubtree?.nodeIds || this.collectSubtreeIds(contraption, rootId);
      const blocks = contraption.blocks.filter(b => nodeIds.has(contraptionBlockOwnerId(contraption, b)));
      if (blocks.length > 0) {
        if (blocks.length > BULK_EDIT_THRESHOLD) {
          const started = this.startLargeEntityBlockSetCopy(blocks, `subtree [${rootId}] (${blocks.length} blocks)`);
          if (started) {
            contraption.clearSubtreeHighlight?.();
            this.selectedSubtree = null;
          }
          return started;
        }
        const minX = Math.min(...blocks.map(b => b.localX));
        const minY = Math.min(...blocks.map(b => b.localY));
        const minZ = Math.min(...blocks.map(b => b.localZ));
        rawBlocks = blocks.map(b => ({
          dx: b.localX - minX,
          dy: b.localY - minY,
          dz: b.localZ - minZ,
          size: b.size || 1,
          block: b.block,
          color: b.color == null ? undefined : normalizeColor(b.color),
          materialId: normalizeVoxelMaterialId(b.materialId),
          part: b.part
        }));
        name = `subtree [${rootId}] (${blocks.length} blocks)`;
      }
    }

    // 3. World selection (2-point box / single-cell mode): read-only, keeps the source intact.
    if (!rawBlocks && this.contraptions && this.contraptions.hasValidSelection()) {
      if (this.contraptions.getSelectionBlockCount?.() > BULK_EDIT_THRESHOLD) {
        return this.startLargeWorldBlockSetCopy(this.contraptions);
      }
      rawBlocks = this.sampleWorldSelectionAsBlockSet();
      if (rawBlocks && rawBlocks.length > 0) name = `world selection (${rawBlocks.length} voxels)`;
    }

    if (!rawBlocks || rawBlocks.length === 0) {
      if (this.ui) this.ui.showToast('Nothing selected - box-select blocks in the world or on a component, then press T');
      return;
    }

    return this.finishBlockSetCopy(rawBlocks, name);
  }

  /**
   * Read-only sampling of the current world selection (cornerA/B box or
   * connectedSelection single cells) into relative block-set entries.
   * Unlike G-assembly this never extracts or removes anything.
   */
  sampleWorldSelectionAsBlockSet(origin: THREE.Vector3 | null = null) {
    const manager = this.contraptions;
    if (!this.world || !manager) return [];

    // Micro selection (Tab mode): sample exactly the selected 0.125 m cells.
    // Empty selected cells are skipped so the copy matches what G extracts.
    const microSelection = manager.microSelection;
    if (Array.isArray(microSelection)) {
      const collected: WorldCopyVoxel[] = [];
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      for (const cell of microSelection) {
        let color = null;
        const block = this.world.getMicroBlock?.(cell.x, cell.y, cell.z);
        if (block) {
          color = block.color;
        } else {
          const wx = Math.floor(cell.x / MICRO_DIVISIONS);
          const wy = Math.floor(cell.y / MICRO_DIVISIONS);
          const wz = Math.floor(cell.z / MICRO_DIVISIONS);
          if (this.world.getBlock && this.world.getBlock(wx, wy, wz) !== BlockTypes.AIR) {
            color = this.world.getBlockColor(wx, wy, wz);
          }
        }
        if (color === null || color === undefined) continue;
        const x = cell.x * MICRO_SIZE;
        const y = cell.y * MICRO_SIZE;
        const z = cell.z * MICRO_SIZE;
        const materialId = block?.materialId
          ?? this.world.getBlockMaterial?.(
            Math.floor(cell.x / MICRO_DIVISIONS),
            Math.floor(cell.y / MICRO_DIVISIONS),
            Math.floor(cell.z / MICRO_DIVISIONS),
          ) ?? 0;
        collected.push({ x, y, z, size: MICRO_SIZE, block: BlockTypes.COLOR_BLOCK, color, materialId });
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
      }
      if (collected.length === 0) return [];
      if (origin) { minX = origin.x; minY = origin.y; minZ = origin.z; }
      return collected.map(b => ({
        dx: Math.round((b.x - minX) * MICRO_DIVISIONS) / MICRO_DIVISIONS,
        dy: Math.round((b.y - minY) * MICRO_DIVISIONS) / MICRO_DIVISIONS,
        dz: Math.round((b.z - minZ) * MICRO_DIVISIONS) / MICRO_DIVISIONS,
        size: b.size,
        block: b.block,
        color: b.color == null ? undefined : normalizeColor(b.color),
        ...(normalizeVoxelMaterialId(b.materialId) === VoxelMaterialIds.DEFAULT
          ? {}
          : { materialId: normalizeVoxelMaterialId(b.materialId) }),
      }));
    }

    const bounds = manager.getSelectionBounds();
    if (!bounds) return [];

    // MicroVoxelLayer.getCellsInAABB treats max as an exclusive bound, but the
    // selection bounds are inclusive integer cells — expand by 1−ε so micro
    // voxels in the top 4/5 of the last cell are still sampled.
    const microBounds = {
      minX: bounds.minX,
      minY: bounds.minY,
      minZ: bounds.minZ,
      maxX: bounds.maxX + 1 - 1e-6,
      maxY: bounds.maxY + 1 - 1e-6,
      maxZ: bounds.maxZ + 1 - 1e-6
    };

    const collected: WorldCopyVoxel[] = []; // { x, y, z, size, block, color } in world units
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    const consider = (x: number, y: number, z: number, size: number, block: number, color: number, materialId = 0) => {
      collected.push({ x, y, z, size, block, color, materialId });
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
    };

    if (manager.connectedSelection !== null) {
      // Single-cell mode: only the explicitly selected cells (standard blocks
      // plus any micro voxels inside those cells).
      const singleKeys = new Set(manager.connectedSelection.map(c => `${c.x},${c.y},${c.z}`));
      for (const cell of manager.connectedSelection) {
        const block = this.world.getBlock(cell.x, cell.y, cell.z);
        if (block !== BlockTypes.AIR) {
          consider(cell.x, cell.y, cell.z, 1, block,
            this.world.getBlockColor(cell.x, cell.y, cell.z),
            this.world.getBlockMaterial?.(cell.x, cell.y, cell.z));
        }
      }
      const micros = this.world.getMicroBlocksInAABB(microBounds) || [];
      for (const m of micros) {
        const cellKey = `${Math.floor(m.x)},${Math.floor(m.y)},${Math.floor(m.z)}`;
        if (singleKeys.has(cellKey)) {
          consider(m.x, m.y, m.z, m.size || MICRO_SIZE,
            BlockTypes.COLOR_BLOCK, m.color, m.materialId);
        }
      }
    } else {
      // 2-point box: every non-air standard block plus micro voxels in the AABB.
      for (let x = bounds.minX; x <= bounds.maxX; x++) {
        for (let y = bounds.minY; y <= bounds.maxY; y++) {
          for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
            const block = this.world.getBlock(x, y, z);
            if (block !== BlockTypes.AIR) {
              consider(x, y, z, 1, block, this.world.getBlockColor(x, y, z),
                this.world.getBlockMaterial?.(x, y, z));
            }
          }
        }
      }
      const micros = this.world.getMicroBlocksInAABB(microBounds) || [];
      for (const m of micros) {
        consider(m.x, m.y, m.z, m.size || MICRO_SIZE,
          BlockTypes.COLOR_BLOCK, m.color, m.materialId);
      }
    }

    if (collected.length === 0) return [];
    if (origin) { minX = origin.x; minY = origin.y; minZ = origin.z; }
    return collected.map(b => ({
      dx: b.x - minX,
      dy: b.y - minY,
      dz: b.z - minZ,
      size: b.size,
      block: b.block,
      color: b.color == null ? undefined : normalizeColor(b.color),
      ...(normalizeVoxelMaterialId(b.materialId) === VoxelMaterialIds.DEFAULT
        ? {}
        : { materialId: normalizeVoxelMaterialId(b.materialId) })
    }));
  }

  private bulkEditProgress(job: BulkEditJob, phase: BulkEditPhase, detail = '') {
    const jobDetail = typeof job.detail === 'function' ? job.detail(job) : job.detail;
    this.ui?.setBulkEditProgress?.({
      label: job.label,
      phase,
      processed: job.processed,
      total: job.total,
      changed: job.changed,
      detail: detail || jobDetail || ''
    });
  }

  private startBulkEditJob(job: Omit<BulkEditJob, 'processed' | 'changed'>) {
    if (this.bulkEditJob) {
      this.ui?.showToast?.(`Please wait for ${this.bulkEditJob.label.toLowerCase()} to finish`);
      return false;
    }
    this.bulkEditJob = {
      ...job,
      processed: 0,
      changed: 0
    };
    this.bulkEditProgress(this.bulkEditJob, 'applying');
    return true;
  }

  /** Process a bounded slice of a large Hammer/Selector edit from the game loop. */
  processBulkEditFrame(
    maxOperations = BULK_EDIT_MAX_OPERATIONS_PER_FRAME,
    timeBudgetMs = BULK_EDIT_FRAME_BUDGET_MS
  ) {
    const job = this.bulkEditJob;
    if (!job) return false;

    const sync = this.world?.editPersistence?.getSyncStatus?.();
    if (sync) this.ui?.setWorldEditSync?.(sync);
    if (job.mutatesWorld !== false && sync?.backpressured) {
      this.bulkEditProgress(job, 'waiting', `Waiting for the server · ${sync.pendingBatches} batches queued`);
      return true;
    }

    const now = () => globalThis.performance?.now?.() ?? Date.now();
    const startedAt = now();
    let operations = 0;
    const operationLimit = Number.isFinite(maxOperations) ? Math.max(1, Math.floor(maxOperations)) : Infinity;
    const timeLimit = Number.isFinite(timeBudgetMs) ? Math.max(0, timeBudgetMs) : Infinity;

    try {
      while (
        job.processed < job.total
        && operations < operationLimit
        && (operations === 0 || now() - startedAt < timeLimit)
      ) {
        const changed = Number(job.step(job.processed, job)) || 0;
        job.changed += changed;
        job.processed++;
        operations++;
      }
    } catch (error) {
      console.error(`Bulk edit failed during ${job.label}.`, error);
      this.bulkEditJob = null;
      this.bulkEditProgress(job, 'failed', 'The operation stopped before all blocks were processed');
      this.ui?.showToast?.(`${job.label} failed after ${job.processed}/${job.total} cells`);
      return false;
    }

    if (job.processed < job.total) {
      this.bulkEditProgress(job, 'applying');
      return true;
    }

    this.bulkEditJob = null;
    try {
      job.finish?.(job);
    } catch (error) {
      console.error(`Bulk edit failed while finishing ${job.label}.`, error);
      this.bulkEditProgress(job, 'failed', 'The operation could not be committed');
      this.ui?.showToast?.(`${job.label} could not be completed`);
      return false;
    }
    const finalSync = this.world?.editPersistence?.getSyncStatus?.();
    if (finalSync) this.ui?.setWorldEditSync?.(finalSync);
    const hasPendingSync = job.mutatesWorld !== false
      && !!finalSync
      && (finalSync.pendingBatches > 0 || finalSync.sending);
    this.bulkEditProgress(
      job,
      hasPendingSync ? 'syncing' : 'complete',
      hasPendingSync ? `${finalSync.pendingBatches} server batches queued` : ''
    );
    return false;
  }

  /** Prefer the visible entity surface over terrain behind it for inventory placement. */
  getInventoryPlacementHit() {
    return this.placementSession.getInventoryPlacementHit();
  }

  private targetEntityLocalToWorld(target: Contraption | null | undefined, nodeId: string, point: THREE.Vector3) {
    return this.placementSession.targetEntityLocalToWorld(target, nodeId, point);
  }

  private getTargetEntityWorldQuaternion(target: Contraption | null | undefined, nodeId: string) {
    return this.placementSession.getTargetEntityWorldQuaternion(target, nodeId);
  }

  private entitySlotOverlapsTarget(slot: InventoryInput, position: THREE.Vector3, quaternion: THREE.Quaternion, target: Contraption | null | undefined) {
    return this.placementSession.entitySlotOverlapsTarget(slot, position, quaternion, target);
  }

  /**
   * Resolve the exact origin shared by the Hammer ghost and every Hammer
   * build (LMB/RMB). Placement always requires a hovered surface — terrain
   * or entity — so aiming at the sky (high altitude, open air) yields no
   * pose instead of falling back to a point in front of the eye.
   * Pure-micro block sets snap to the 1/5 grid; block sets containing standard
   * voxels stay on the 1 m grid. On terrain, entity slots geometrically centre
   * and settle onto sampled support without moving away from the player. On
   * another entity, they align to the targeted component's 0.125 m grid, rotate
   * outward from side faces, and move only along that normal to clear voxels.
   */
  getInventoryPlacementPose(slot: InventoryInput) {
    return this.placementSession.getInventoryPlacementPose(slot);
  }

  /** Refresh the Hammer hover ghost without mutating either world or entity state. */
  updateInventoryPlacementPreview() {
    return this.placementSession.updateInventoryPlacementPreview();
  }

  /**
   * Paste a block-set slot (kind === 'blockset') at the crosshair as plain world
   * blocks. Standard blocks land on integer cells; micro voxels land on the
   * 1/5-scale micro grid. No entity is created — the voxels become terrain.
   *
   * replace = false (Hammer LMB): writes only empty cells; occupied cells are
   * skipped. replace = true (Hammer RMB, overwrite mode): occupied standard
   * blocks are replaced and occupied micro cells are replaced; a micro voxel
   * that overlaps a standard block clears that block first.
   */
  private applyBlockSetVoxel(target: Point3, block: InventoryVoxel, replace = false) {
    if ((block.size || 1) < 1) {
      if (replace) {
        // Micro voxels cannot coexist with a standard block, so overwrite
        // mode clears the parent cell before writing the micro voxel.
        const wx = Math.round(target.x + (block.dx ?? 0));
        const wy = Math.round(target.y + (block.dy ?? 0));
        const wz = Math.round(target.z + (block.dz ?? 0));
        if (this.world.getBlock?.(wx, wy, wz) !== BlockTypes.AIR) {
          this.performBasicAction({
            domain: ActionDomain.WORLD,
            action: 'remove-standard',
            cell: { x: wx, y: wy, z: wz }
          });
        }
      }
      const result = this.performBasicAction({
        domain: ActionDomain.WORLD,
        action: 'place-micro',
        micro: [
          Math.round((target.x + (block.dx ?? 0)) * MICRO_DIVISIONS),
          Math.round((target.y + (block.dy ?? 0)) * MICRO_DIVISIONS),
          Math.round((target.z + (block.dz ?? 0)) * MICRO_DIVISIONS)
        ],
        options: { color: block.color, materialId: normalizeVoxelMaterialId(block.materialId) },
        part: block.part || null,
        replace
      });
      return result.placed || 0;
    }

    const result = this.performBasicAction({
      domain: ActionDomain.WORLD,
      action: 'place-standard',
      cell: {
        x: target.x + Math.round((block.dx ?? 0)),
        y: target.y + Math.round((block.dy ?? 0)),
        z: target.z + Math.round((block.dz ?? 0))
      },
      block: block.block || BlockTypes.COLOR_BLOCK,
      options: { color: block.color, materialId: normalizeVoxelMaterialId(block.materialId) },
      replace
    });
    return result.placed || 0;
  }

  /** Finish successful construction while preserving a tool changed during a bulk job. */
  private completeHammerPlacement() {
    if (this.activeTool !== SpecialTool.HAMMER) return;
    this.activateTool(SpecialTool.WRENCH);
  }

  private finishBlockSetPaste(target: Point3, total: number, placed: number, replace: boolean) {
    if (placed > 0) {
      this.sound?.playBlockPlace?.();
      this.completeHammerPlacement();
    }
    if (!this.ui) return;
    const skipped = Math.max(0, total - placed);
    const where = `at (${target.x}, ${target.y}, ${target.z})`;
    this.ui.showToast(replace
      ? `Overwrote block set: ${placed}/${total} voxels ${where}`
      : skipped > 0
        ? `Built block set: ${placed}/${total} voxels ${where} · ${skipped} occupied cell(s) skipped`
        : `Built block set: ${placed}/${total} voxels ${where}`);
  }

  pasteBlockSet(slot: InventoryInput, replace = false) {
    if (!this.world || !slot || !Array.isArray(slot.blocks) || slot.blocks.length === 0) return false;
    if (this.bulkEditJob) {
      this.ui?.showToast?.(`Please wait for ${this.bulkEditJob.label.toLowerCase()} to finish`);
      return false;
    }

    const pose = this.getInventoryPlacementPose(slot);
    if (!pose) {
      if (this.ui) this.ui.showToast('No surface under the crosshair — aim at terrain or an entity to build');
      return false;
    }
    const target = pose.position.clone?.() || { ...pose.position };
    const blocks = [...slot.blocks];
    let placed = 0;

    if (blocks.length > BULK_EDIT_THRESHOLD) {
      return this.startBulkEditJob({
        label: replace ? 'Overwriting block set' : 'Building block set',
        total: blocks.length,
        step: (index: number) => {
          const changed = this.applyBlockSetVoxel(target, blocks[index], replace);
          placed += changed;
          return changed;
        },
        finish: () => this.finishBlockSetPaste(target, blocks.length, placed, replace)
      });
    }

    for (const block of blocks) placed += this.applyBlockSetVoxel(target, block, replace);
    this.finishBlockSetPaste(target, blocks.length, placed, replace);
    return placed > 0;
  }

  /**
   * Put an imported block set into the player's shared Item inventory so it
   * matches block sets copied with T.
   * Enforces the same admission limits as backpack persistence and market publishing.
   * @returns The written slot, or null.
   */
  importBlockSetToInventory(blocks: BlockSetVoxel[], name = 'STL import') {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      if (this.ui) this.ui.showToast('Nothing to import - the source produced no voxels');
      return null;
    }
    if (blocks.length > MAX_INVENTORY_BLOCKS) {
      const msg = `Block set exceeds ${MAX_INVENTORY_BLOCKS.toLocaleString()} voxels (${blocks.length.toLocaleString()})`;
      if (this.ui) this.ui.showToast(msg);
      throw new Error(msg);
    }
    if (!withinEntityBounds(blocks, ['dx', 'dy', 'dz'])) {
      const msg = `Block-set bounds may not exceed ${MAX_ENTITY_BOUNDS} cells per axis`;
      if (this.ui) this.ui.showToast(msg);
      throw new Error(msg);
    }
    if (!validateVoxelOccupancy(blocks, ['dx', 'dy', 'dz'])) {
      const msg = 'Block set contains duplicate voxels or standard/micro overlap';
      if (this.ui) this.ui.showToast(msg);
      throw new Error(msg);
    }
    const slot = { kind: 'blockset', name, blocks, blockCount: blocks.length };
    try {
      const serialized = this.serializeInventoryItem('blockset', slot);
      const encoded = encodeInventoryResource('blockset', serialized);
      if (encoded && encoded.byteLength > MAX_INVENTORY_IMPORT_BYTES) {
        const msg = `Block set exceeds ${MAX_INVENTORY_IMPORT_BYTES / (1024 * 1024)} MiB storage limit`;
        if (this.ui) this.ui.showToast(msg);
        throw new Error(msg);
      }
    } catch (err: any) {
      if (this.ui) this.ui.showToast(err?.message || 'Block set cannot be serialized');
      throw err;
    }
    const index = this.addInventoryItem('blockset', slot);
    if (index === null) {
      if (this.ui) this.ui.showToast(`Item inventory is full (${MAX_BACKPACK_ITEM_SLOTS}) - cannot import ${name}`);
      return null;
    }
    this.setActiveInventoryCategory('blockset');
    this.ui?.renderInventoryBar?.();
    if (this.ui) {
      this.ui.showToast(`Imported ${name}: ${blocks.length} voxels into item slot ${index + 1} · Hammer LMB builds · RMB rotates 90°`);
    }
    return this.inventories.item.items[index];
  }

  private finishWorldSelectionDelete(standard: number, micro: number) {
    const removed = standard + micro;
    if (removed > 0) {
      this.sound?.playBlockBreak?.({ kind: 'bulk', count: removed });
      const parts = [];
      if (standard > 0) parts.push(`${standard} blocks`);
      if (micro > 0) parts.push(`${micro} micro voxels`);
      this.ui?.showToast?.(`Deleted ${parts.join(' + ')} from the selection`);
    } else {
      this.ui?.showToast?.('Selection region is empty (no blocks to delete)');
    }
  }

  private startLargeWorldSelectionDelete(manager: ContraptionManager, microSelection: Point3[] | null, bounds: CollisionBounds | null) {
    let particleBudget = 64;
    let removedStandard = 0;
    let removedMicro = 0;

    const partition = (Array.isArray(microSelection) || manager.microBounds) && manager.partitionMicroSelection
      ? manager.partitionMicroSelection()
      : null;

    if (partition) {
      const stdCells = partition.standardCells;
      const microCells = partition.microCells;
      const total = stdCells.length + microCells.length;
      const subdividedStandardCells = new Set<string>();
      const started = this.startBulkEditJob({
        label: 'Deleting micro selection',
        total,
        step: (index: number) => {
          if (index < stdCells.length) {
            const cell = stdCells[index];
            const block = this.world.getBlock?.(cell.x, cell.y, cell.z);
            if (block !== BlockTypes.AIR && particleBudget > 0) {
              this.particles?.emitBlockBreak?.(
                { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 },
                this.world.getBlockColor?.(cell.x, cell.y, cell.z),
                6
              );
              particleBudget--;
            }
            const result = this.performBasicAction({
              domain: ActionDomain.WORLD,
              action: 'clear-cell',
              cell
            });
            removedStandard += result.standard || 0;
            removedMicro += result.micro || 0;
            return result.removed || 0;
          } else {
            const cell = microCells[index - stdCells.length];
            const wx = Math.floor(cell.x / MICRO_DIVISIONS);
            const wy = Math.floor(cell.y / MICRO_DIVISIONS);
            const wz = Math.floor(cell.z / MICRO_DIVISIONS);
            let block: { color: number; block?: number; materialId?: number } | null | undefined = this.world.getMicroBlock?.(cell.x, cell.y, cell.z);
            if (!block && this.world.getBlock?.(wx, wy, wz) !== BlockTypes.AIR) {
              block = { color: this.world.getBlockColor?.(wx, wy, wz) };
            }
            if (block && particleBudget > 0) {
              this.particles?.emitBlockBreak?.(
                {
                  x: cell.x / MICRO_DIVISIONS + 0.5 / MICRO_DIVISIONS,
                  y: cell.y / MICRO_DIVISIONS + 0.5 / MICRO_DIVISIONS,
                  z: cell.z / MICRO_DIVISIONS + 0.5 / MICRO_DIVISIONS
                },
                block.color,
                3
              );
              particleBudget--;
            }
            const cellKey = `${wx},${wy},${wz}`;
            let result;
            if (!subdividedStandardCells.has(cellKey)) {
              if (this.world.getBlock?.(wx, wy, wz) !== BlockTypes.AIR) {
                result = this.performBasicAction({
                  domain: ActionDomain.WORLD,
                  action: 'subdivide-standard',
                  cell: { x: wx, y: wy, z: wz },
                  micro: cell
                });
              }
              subdividedStandardCells.add(cellKey);
            }
            if (!result) {
              result = this.performBasicAction({
                domain: ActionDomain.WORLD,
                action: 'remove-micro',
                micro: cell
              });
            }
            const changed = result.removed || 0;
            removedMicro += changed;
            return changed;
          }
        },
        finish: () => this.finishWorldSelectionDelete(removedStandard, removedMicro)
      });
      if (started) manager.clearSelection?.();
      return started;
    }

    if (Array.isArray(microSelection)) {
      const cells = microSelection.map(cell => ({ x: cell.x, y: cell.y, z: cell.z }));
      const subdividedStandardCells = new Set<string>();
      const started = this.startBulkEditJob({
        label: 'Deleting micro selection',
        total: cells.length,
        step: (index: number) => {
          const cell = cells[index];
          const wx = Math.floor(cell.x / MICRO_DIVISIONS);
          const wy = Math.floor(cell.y / MICRO_DIVISIONS);
          const wz = Math.floor(cell.z / MICRO_DIVISIONS);
          let block: { color: number; block?: number; materialId?: number } | null | undefined = this.world.getMicroBlock?.(cell.x, cell.y, cell.z);
          if (!block && this.world.getBlock?.(wx, wy, wz) !== BlockTypes.AIR) {
            block = { color: this.world.getBlockColor?.(wx, wy, wz) };
          }
          if (block && particleBudget > 0) {
            this.particles?.emitBlockBreak?.(
              {
                x: cell.x / MICRO_DIVISIONS + 0.5 / MICRO_DIVISIONS,
                y: cell.y / MICRO_DIVISIONS + 0.5 / MICRO_DIVISIONS,
                z: cell.z / MICRO_DIVISIONS + 0.5 / MICRO_DIVISIONS
              },
              block.color,
              3
            );
            particleBudget--;
          }

          const cellKey = `${wx},${wy},${wz}`;
          let result;
          if (!subdividedStandardCells.has(cellKey)) {
            if (this.world.getBlock?.(wx, wy, wz) !== BlockTypes.AIR) {
              result = this.performBasicAction({
                domain: ActionDomain.WORLD,
                action: 'subdivide-standard',
                cell: { x: wx, y: wy, z: wz },
                micro: cell
              });
            }
            subdividedStandardCells.add(cellKey);
          }
          if (!result) {
            result = this.performBasicAction({
              domain: ActionDomain.WORLD,
              action: 'remove-micro',
              micro: cell
            });
          }
          const changed = result.removed || 0;
          removedMicro += changed;
          return changed;
        },
        finish: () => this.finishWorldSelectionDelete(0, removedMicro)
      });
      if (started) manager.clearSelection?.();
      return started;
    }

    const sparseCells = manager.connectedSelection !== null
      ? [...(manager.connectedSelection || [])].map(cell => ({ x: cell.x, y: cell.y, z: cell.z }))
      : null;
    if (!bounds) return false;
    const sizeY = bounds.maxY - bounds.minY + 1;
    const sizeZ = bounds.maxZ - bounds.minZ + 1;
    const total = sparseCells?.length
      ?? (bounds.maxX - bounds.minX + 1) * sizeY * sizeZ;
    const cellAt = (index: number) => {
      if (sparseCells) return sparseCells[index];
      return {
        x: bounds.minX + Math.floor(index / (sizeY * sizeZ)),
        y: bounds.minY + Math.floor(index / sizeZ) % sizeY,
        z: bounds.minZ + index % sizeZ
      };
    };

    const started = this.startBulkEditJob({
      label: 'Deleting selection',
      total,
      step: (index: number) => {
        const cell = cellAt(index);
        const block = this.world.getBlock?.(cell.x, cell.y, cell.z);
        if (block !== BlockTypes.AIR && particleBudget > 0) {
          this.particles?.emitBlockBreak?.(
            { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 },
            this.world.getBlockColor?.(cell.x, cell.y, cell.z),
            6
          );
          particleBudget--;
        }
        const result = this.performBasicAction({
          domain: ActionDomain.WORLD,
          action: 'clear-cell',
          cell
        });
        removedStandard += result.standard || 0;
        removedMicro += result.micro || 0;
        return result.removed || 0;
      },
      finish: () => this.finishWorldSelectionDelete(removedStandard, removedMicro)
    });
    if (started) manager.clearSelection?.();
    return started;
  }

  private gradientColorAt(
    point: { x: number; y: number; z: number },
    gradient: { stops: GradientStop[]; start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } } | null,
    fallback: number,
  ): number {
    if (!gradient || gradient.stops.length <= 1) return fallback;
    const dx = gradient.end.x - gradient.start.x;
    const dy = gradient.end.y - gradient.start.y;
    const dz = gradient.end.z - gradient.start.z;
    const lengthSquared = dx * dx + dy * dy + dz * dz;
    if (lengthSquared <= 1e-12) return sampleGradientColor(gradient.stops, 0);
    const progress = (
      (point.x - gradient.start.x) * dx
      + (point.y - gradient.start.y) * dy
      + (point.z - gradient.start.z) * dz
    ) / lengthSquared;
    return sampleGradientColor(gradient.stops, progress);
  }

  private worldSelectionGradient(targetColor?: number) {
    const stops = targetColor === undefined
      ? normalizeGradientStops(this.selectedGradientStops, this.selectedColor)
      : normalizeGradientStops(null, targetColor);
    const manager = this.contraptions;
    if (stops.length <= 1 || manager?.selectionBoxConfirmed !== true
      || !manager.selectionCornerA || !manager.selectionCornerB) return null;
    const micro = manager.selectionCornerA.micro === true || manager.selectionCornerB.micro === true;
    const center = (point: Point3) => micro
      ? { x: (point.x + 0.5) / MICRO_DIVISIONS, y: (point.y + 0.5) / MICRO_DIVISIONS, z: (point.z + 0.5) / MICRO_DIVISIONS }
      : { x: point.x + 0.5, y: point.y + 0.5, z: point.z + 0.5 };
    return { stops, start: center(manager.selectionCornerA), end: center(manager.selectionCornerB) };
  }

  private entitySelectionGradient(selection: any, targetColor?: number) {
    const stops = targetColor === undefined
      ? normalizeGradientStops(this.selectedGradientStops, this.selectedColor)
      : normalizeGradientStops(null, targetColor);
    const range = selection?.confirmedRange;
    if (stops.length <= 1 || selection?.gradientEligible !== true
      || !range?.pointA || !range?.pointB) return null;
    const pivot = selection?.contraption?.entityNodes?.get?.(selection.nodeId)?.pivotLocal;
    const point = (value: any) => ({
      x: Number(value.x) + Number(pivot?.x || 0),
      y: Number(value.y) + Number(pivot?.y || 0),
      z: Number(value.z) + Number(pivot?.z || 0),
    });
    return { stops, start: point(range.pointA), end: point(range.pointB) };
  }

  private startLargeWorldSelectionFill(manager: ContraptionManager, partition: ReturnType<ContraptionManager['partitionMicroSelection']> | null, bounds: CollisionBounds | null, color: number, materialId: number = VoxelMaterialIds.DEFAULT, gradient: SelectionGradient | null = null) {
    let placedStandard = 0;
    let placedMicro = 0;

    if (partition) {
      const stdCells = partition.standardCells;
      const microCells = partition.microCells;
      const total = stdCells.length + microCells.length;
      const subdividedStandardCells = new Set<string>();
      const started = this.startBulkEditJob({
        label: 'Filling micro selection',
        total,
        step: (index: number) => {
          if (index < stdCells.length) {
            const cell = stdCells[index];
            const cellColor = this.gradientColorAt(
              { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 }, gradient, color,
            );
            const result = this.performBasicAction({
              domain: ActionDomain.WORLD,
              action: 'place-standard',
              cell,
              color: cellColor,
              options: { color: cellColor, materialId },
              replace: true
            });
            if (result.placed) placedStandard++;
            return result.placed || 0;
          } else {
            const cell = microCells[index - stdCells.length];
            const cellColor = this.gradientColorAt({
              x: (cell.x + 0.5) / MICRO_DIVISIONS,
              y: (cell.y + 0.5) / MICRO_DIVISIONS,
              z: (cell.z + 0.5) / MICRO_DIVISIONS,
            }, gradient, color);
            const wx = Math.floor(cell.x / MICRO_DIVISIONS);
            const wy = Math.floor(cell.y / MICRO_DIVISIONS);
            const wz = Math.floor(cell.z / MICRO_DIVISIONS);
            const cellKey = `${wx},${wy},${wz}`;
            if (!subdividedStandardCells.has(cellKey)) {
              if (this.world.getBlock?.(wx, wy, wz) !== BlockTypes.AIR) {
                this.performBasicAction({
                  domain: ActionDomain.WORLD,
                  action: 'subdivide-standard',
                  cell: { x: wx, y: wy, z: wz },
                  micro: cell
                });
              }
              subdividedStandardCells.add(cellKey);
            }
            const result = this.performBasicAction({
              domain: ActionDomain.WORLD,
              action: 'place-micro',
              micro: cell,
              color: cellColor,
              options: { color: cellColor, materialId },
              replace: true
            });
            if (result.placed) placedMicro++;
            return result.placed || 0;
          }
        },
        finish: () => {
          this.sound?.playBlockPlace?.();
          const parts = [];
          if (placedStandard > 0) parts.push(`${placedStandard} blocks`);
          if (placedMicro > 0) parts.push(`${placedMicro} micro voxels`);
          this.ui?.showToast?.(`Filled ${parts.join(' + ') || '0 voxels'} with ${colorToHex(color)}`);
        }
      });
      if (started) manager.clearSelection?.();
      return started;
    }

    const sparseCells = manager.connectedSelection !== null
      ? [...(manager.connectedSelection || [])].map(cell => ({ x: cell.x, y: cell.y, z: cell.z }))
      : null;
    if (!bounds) return false;
    const sizeY = bounds.maxY - bounds.minY + 1;
    const sizeZ = bounds.maxZ - bounds.minZ + 1;
    const total = sparseCells?.length ?? (bounds.maxX - bounds.minX + 1) * sizeY * sizeZ;
    const cellAt = (index: number) => {
      if (sparseCells) return sparseCells[index];
      return {
        x: bounds.minX + Math.floor(index / (sizeY * sizeZ)),
        y: bounds.minY + Math.floor(index / sizeZ) % sizeY,
        z: bounds.minZ + index % sizeZ
      };
    };

    const started = this.startBulkEditJob({
      label: 'Filling selection',
      total,
      step: (index: number) => {
        const cell = cellAt(index);
        const cellColor = this.gradientColorAt(
          { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 }, gradient, color,
        );
        const result = this.performBasicAction({
          domain: ActionDomain.WORLD,
          action: 'place-standard',
          cell,
          color: cellColor,
          options: { color: cellColor, materialId },
          replace: true
        });
        if (result.placed) placedStandard++;
        return result.placed || 0;
      },
      finish: () => {
        this.sound?.playBlockPlace?.();
        this.ui?.showToast?.(`Filled ${placedStandard} blocks with ${colorToHex(color)}`);
      }
    });
    if (started) manager.clearSelection?.();
    return started;
  }

  private startLargeWorldSelectionPaint(manager: ContraptionManager, partition: ReturnType<ContraptionManager['partitionMicroSelection']> | null, bounds: CollisionBounds | null, color: number, fromColor?: number, materialId: number = VoxelMaterialIds.DEFAULT, gradient: SelectionGradient | null = null) {
    let paintedStandard = 0;
    let paintedMicro = 0;

    if (partition) {
      const stdCells = partition.standardCells;
      const microCells = partition.microCells;
      const total = stdCells.length + microCells.length;
      const subdividedStandardCells = new Set<string>();
      const started = this.startBulkEditJob({
        label: 'Recoloring micro selection',
        total,
        step: (index: number) => {
          if (index < stdCells.length) {
            const cell = stdCells[index];
            const cellColor = this.gradientColorAt(
              { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 }, gradient, color,
            );
            const currColor = this.world.getBlockColor?.(cell.x, cell.y, cell.z);
            if (fromColor === undefined || currColor === fromColor) {
              const result = this.performBasicAction({
                domain: ActionDomain.WORLD,
                action: 'paint-standard',
                cell,
                color: cellColor,
                options: { color: cellColor, materialId }
              });
              if (result.painted) paintedStandard++;
              return result.painted || 0;
            }
            return 0;
          } else {
            const cell = microCells[index - stdCells.length];
            const cellColor = this.gradientColorAt({
              x: (cell.x + 0.5) / MICRO_DIVISIONS,
              y: (cell.y + 0.5) / MICRO_DIVISIONS,
              z: (cell.z + 0.5) / MICRO_DIVISIONS,
            }, gradient, color);
            const wx = Math.floor(cell.x / MICRO_DIVISIONS);
            const wy = Math.floor(cell.y / MICRO_DIVISIONS);
            const wz = Math.floor(cell.z / MICRO_DIVISIONS);
            const cellKey = `${wx},${wy},${wz}`;
            if (!subdividedStandardCells.has(cellKey)) {
              if (this.world.getBlock?.(wx, wy, wz) !== BlockTypes.AIR) {
                this.performBasicAction({
                  domain: ActionDomain.WORLD,
                  action: 'subdivide-standard',
                  cell: { x: wx, y: wy, z: wz },
                  micro: cell
                });
              }
              subdividedStandardCells.add(cellKey);
            }
            const mBlock = this.world.getMicroBlock?.(cell.x, cell.y, cell.z);
            if (mBlock && (fromColor === undefined || mBlock.color === fromColor)) {
              const result = this.performBasicAction({
                domain: ActionDomain.WORLD,
                action: 'paint-micro',
                micro: cell,
                color: cellColor,
                options: { color: cellColor, materialId }
              });
              if (result.painted) paintedMicro++;
              return result.painted || 0;
            }
            return 0;
          }
        },
        finish: () => {
          this.sound?.playBlockPlace?.();
          const parts = [];
          if (paintedStandard > 0) parts.push(`${paintedStandard} blocks`);
          if (paintedMicro > 0) parts.push(`${paintedMicro} micro voxels`);
          this.ui?.showToast?.(`Recolored ${parts.join(' + ') || '0 voxels'} to ${colorToHex(color)}`);
        }
      });
      if (started) manager.clearSelection?.();
      return started;
    }

    const sparseCells = manager.connectedSelection !== null
      ? [...(manager.connectedSelection || [])].map(cell => ({ x: cell.x, y: cell.y, z: cell.z }))
      : null;
    if (!bounds) return false;
    const sizeY = bounds.maxY - bounds.minY + 1;
    const sizeZ = bounds.maxZ - bounds.minZ + 1;
    const total = sparseCells?.length ?? (bounds.maxX - bounds.minX + 1) * sizeY * sizeZ;
    const cellAt = (index: number) => {
      if (sparseCells) return sparseCells[index];
      return {
        x: bounds.minX + Math.floor(index / (sizeY * sizeZ)),
        y: bounds.minY + Math.floor(index / sizeZ) % sizeY,
        z: bounds.minZ + index % sizeZ
      };
    };

    const started = this.startBulkEditJob({
      label: 'Recoloring selection',
      total,
      step: (index: number) => {
        const cell = cellAt(index);
        const cellColor = this.gradientColorAt(
          { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 }, gradient, color,
        );
        const currColor = this.world.getBlockColor?.(cell.x, cell.y, cell.z);
        if (fromColor === undefined || currColor === fromColor) {
          const result = this.performBasicAction({
            domain: ActionDomain.WORLD,
            action: 'paint-standard',
            cell,
            color: cellColor,
            options: { color: cellColor, materialId }
          });
          if (result.painted) paintedStandard++;
          return result.painted || 0;
        }
        return 0;
      },
      finish: () => {
        this.sound?.playBlockPlace?.();
        this.ui?.showToast?.(`Recolored ${paintedStandard} blocks to ${colorToHex(color)}`);
      }
    });
    if (started) manager.clearSelection?.();
    return started;
  }

  /**
   * Delete removes blocks in a confirmed A/B selection and then resets it.
   *
   * - Entity block selection removes selected standard and microblocks directly
   *   owned by a component, removing the entity when it becomes empty.
   * - Confirmed world boxes/shapes remove standard and 8x8x8 microblocks.
   * - Preselected subtrees and Shift-picked cells cannot be deleted.
   */
  deleteSelectionBlocks() {
    const manager = this.contraptions;
    if (!manager) return;
    if (this.bulkEditJob) {
      this.ui?.showToast?.(`Please wait for ${this.bulkEditJob.label.toLowerCase()} to finish`);
      return;
    }

    if (!this.requireConfirmedSelection('deleting')) return;

    // 1. Remove selected blocks from an entity component.
    if (this.selectedBlockSelection && this.selectedBlockSelection.blocks.length > 0) {
      // The shared delete action carves virtual cells in one mutation, creating
      // only the survivors of partially covered standard blocks.
      const { contraption, nodeId, blocks } = this.selectedBlockSelection;
      const coverage = new Map<any, Set<string>>();
      for (const block of blocks) {
        if (!block.virtualMicro || !block.sourceBlock) continue;
        let cells = coverage.get(block.sourceBlock);
        if (!cells) coverage.set(block.sourceBlock, cells = new Set());
        cells.add(this.microCellKey(block));
      }
      const partialCount = [...coverage.values()].filter(cells => cells.size < MICRO_DIVISIONS ** 3).length;
      if (partialCount > MAX_MICRO_MATERIALIZE_BLOCKS) {
        this.ui?.showToast?.(
          `Micro edit would subdivide ${partialCount} standard blocks (limit ${MAX_MICRO_MATERIALIZE_BLOCKS}) — narrow the selection`,
          { tone: 'warning' }
        );
        return;
      }
      const result = this.performBasicAction({
        domain: ActionDomain.SELECTION,
        action: 'delete',
        selection: { kind: 'entity-blocks', contraption, nodeId, blocks }
      });
      contraption.clearSubtreeHighlight?.();
      this.selectedBlockSelection = null;
      this.selectorLevel = null;
      this.selectorRange = null;
      if (result.ok) {
        const kind = (result.removed ?? 0) > 1
          ? 'bulk'
          : (blocks[0]?.size || 1) < 1 ? 'micro' : 'standard';
        this.sound?.playBlockBreak({ kind, count: result.removed });
        const remainingBlocks = contraption.blocks.filter((b: any) => contraptionBlockOwnerId(contraption, b) === nodeId);
        if (remainingBlocks.length === 0) {
          if (nodeId === contraptionRootId(contraption) || contraption.blocks.length === 0) {
            this.contraptions?.removeContraption?.(contraption);
            this.ui?.notifyContraptionRemoved?.(contraption);
            if (this.ui) this.ui.showToast(`Entity #${contraption.id} fully dismantled`);
          } else {
            contraption.removeComponentSubtree?.(nodeId);
            this.ui?.notifyContraptionStructureChanged?.(contraption);
            if (this.ui) this.ui.showToast(`Component [${nodeId}] and all its subcomponents deleted`);
          }
        } else {
          if (!result.empty) this.ui?.notifyContraptionStructureChanged(contraption);
          if (this.ui) this.ui.showToast(`Deleted ${result.removed} blocks from [${nodeId}]`);
        }
      } else if (this.ui) {
        this.ui.showToast(result.reason === 'entity_not_stopped'
          ? 'Stop the entity before deleting internal blocks'
          : 'Selection is empty');
      }
      return;
    }

    // 2. Delete a confirmed A/B world box or shape (standard or micro mode).
    if (!this.world || !manager.hasValidSelection()) {
      if (this.ui) this.ui.showToast('Nothing selected - box-select a region with the selector first, then press Del');
      return;
    }
    const microSelection = manager.microSelection;
    const isMicroSelection = Array.isArray(microSelection) || manager.microBounds !== null;
    const partition = isMicroSelection && manager.partitionMicroSelection ? manager.partitionMicroSelection() : null;
    const bounds = isMicroSelection ? null : manager.getSelectionBounds();
    if (!isMicroSelection && !bounds) return;
    if (!bounds && !isMicroSelection) {
      if (this.ui) this.ui.showToast('Nothing selected - box-select a region with the selector first, then press Del');
      return;
    }

    const largeSelectionCount = partition
      ? partition.standardCells.length + partition.microCells.length
      : isMicroSelection
        ? microSelection?.length || 0
        : manager.connectedSelection !== null
          ? manager.connectedSelection.length
          : (bounds!.maxX - bounds!.minX + 1)
          * (bounds!.maxY - bounds!.minY + 1)
          * (bounds!.maxZ - bounds!.minZ + 1);
    if (largeSelectionCount > BULK_EDIT_THRESHOLD) {
      this.startLargeWorldSelectionDelete(manager, microSelection, bounds);
      return;
    }

    let particleBudget = 64;
    if (partition) {
      for (const cell of partition.standardCells) {
        const block = this.world.getBlock?.(cell.x, cell.y, cell.z);
        if (block !== BlockTypes.AIR && particleBudget > 0) {
          this.particles?.emitBlockBreak(
            { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 },
            this.world.getBlockColor?.(cell.x, cell.y, cell.z),
            6
          );
          particleBudget--;
        }
      }
      for (const cell of partition.microCells) {
        const block = this.world.getMicroBlock?.(cell.x, cell.y, cell.z);
        if (block && particleBudget > 0) {
          this.particles?.emitBlockBreak(
            { x: (cell.x + 0.5) * MICRO_SIZE, y: (cell.y + 0.5) * MICRO_SIZE, z: (cell.z + 0.5) * MICRO_SIZE },
            block.color,
            3
          );
          particleBudget--;
        }
      }
    } else if (isMicroSelection && Array.isArray(microSelection)) {
      // Micro mode deletes exactly the selected 0.125 m cells that hold a voxel.
      for (const cell of microSelection) {
        let block: { color: number; block?: number; materialId?: number } | null | undefined = this.world.getMicroBlock?.(cell.x, cell.y, cell.z);
        if (!block) {
          const wx = Math.floor(cell.x / MICRO_DIVISIONS);
          const wy = Math.floor(cell.y / MICRO_DIVISIONS);
          const wz = Math.floor(cell.z / MICRO_DIVISIONS);
          if (this.world.getBlock && this.world.getBlock(wx, wy, wz) !== BlockTypes.AIR) {
            block = { block: BlockTypes.COLOR_BLOCK, color: this.world.getBlockColor(wx, wy, wz) };
          }
        }
        if (block && particleBudget > 0) {
          this.particles?.emitBlockBreak(
            { x: (cell.x + 0.5) * MICRO_SIZE, y: (cell.y + 0.5) * MICRO_SIZE, z: (cell.z + 0.5) * MICRO_SIZE },
            block.color, 3
          );
          particleBudget--;
        }
      }
    } else {
      const cells = [];
      const collectCell = (x: number, y: number, z: number) => {
        cells.push({ x, y, z });
        const block = this.world.getBlock(x, y, z);
        if (block !== BlockTypes.AIR) {
          const color = this.world.getBlockColor(x, y, z);
          if (particleBudget > 0) {
            this.particles?.emitBlockBreak({ x: x + 0.5, y: y + 0.5, z: z + 0.5 }, color, 6);
            particleBudget--;
          }
        }
      };

      if (manager.connectedSelection !== null) {
        // A shape deletes only cells inside the confirmed A/B region.
        for (const cell of manager.connectedSelection) collectCell(cell.x, cell.y, cell.z);
      } else {
        for (let x = bounds!.minX; x <= bounds!.maxX; x++) {
          for (let y = bounds!.minY; y <= bounds!.maxY; y++) {
            for (let z = bounds!.minZ; z <= bounds!.maxZ; z++) collectCell(x, y, z);
          }
        }
      }
    }

    // The shared selection command resolves the manager's current box/sparse cells
    // and executes the same world voxel commands available to entity programs.
    const result = this.performBasicAction({ domain: ActionDomain.SELECTION, action: 'delete' });
    const removedBlocks = result.standard || 0;
    const removedMicros = result.micro || 0;
    if (result.ok) {
      const removed = removedBlocks + removedMicros;
      const kind = removed > 1 ? 'bulk' : removedMicros > 0 ? 'micro' : 'standard';
      this.sound?.playBlockBreak({ kind, count: removed });
      if (this.ui) {
        const parts = [];
        if (removedBlocks > 0) parts.push(`${removedBlocks} blocks`);
        if (removedMicros > 0) parts.push(`${removedMicros} micro voxels`);
        this.ui.showToast(`Deleted ${parts.join(' + ')} from the selection`);
      }
    } else if (this.ui) {
      this.ui.showToast('Selection region is empty (no blocks to delete)');
    }
  }

  /**
   * Fill fills the current selection with solid blocks using the active color.
   */
  fillSelectionBlocks(targetColor?: number) {
    const manager = this.contraptions;
    if (!manager) return;
    if (this.bulkEditJob) {
      this.ui?.showToast?.(`Please wait for ${this.bulkEditJob.label.toLowerCase()} to finish`);
      return;
    }
    if (!this.requireConfirmedSelection('filling')) return;

    const activeStops = targetColor === undefined
      ? normalizeGradientStops(this.selectedGradientStops, this.selectedColor)
      : normalizeGradientStops(null, targetColor);
    const color = sampleGradientColor(activeStops, 0);
    const materialId = normalizeVoxelMaterialId(this.selectedMaterialId);

    // A whole-component (subtree) selection has no block box of its own. F must
    // still "fill/expand the component" instead of only recoloring it, so
    // normalize it into a block selection over the component's own blocks (the
    // level that owns the start point) before the expand branch below.
    if (!this.selectedBlockSelection && this.selectedSubtree?.contraption) {
      const { contraption, rootId } = this.selectedSubtree;
      if (!this.canEditEntityInternals(contraption)) {
        this.clearSelection();
        this.ui?.showToast?.('Stop the entity before expanding its components', { tone: 'warning' });
        return;
      }
      const ownerBlocks = contraption.blocks.filter((b: any) => contraptionBlockOwnerId(contraption, b) === rootId);
      const ownerBounds = this.getEntitySelectionBounds(ownerBlocks, this.selectorMicroMode === true);
      if (ownerBlocks.length === 0 || !ownerBounds) {
        this.clearSelection();
        this.ui?.showToast?.('Selected component has no blocks to expand', { tone: 'warning' });
        return;
      }
      this.selectedBlockSelection = {
        contraption,
        nodeId: rootId,
        blocks: ownerBlocks,
        bounds: ownerBounds
      };
      this.selectedSubtree = null;
    }

    // 1. Entity blocks fill -> expand component
    if (this.selectedBlockSelection) {
      // Filling mutates geometry, so any virtual micro selection is subdivided now.
      if (!this.materializeMicroSelection()) return;
      const { contraption, nodeId, bounds, shapeCells } = this.selectedBlockSelection;
      const isMicro = this.selectorMicroMode === true;
      const gradient = this.entitySelectionGradient(this.selectedBlockSelection, targetColor);

      let targetCoords: Array<{ x: number; y: number; z: number }> = [];
      if (Array.isArray(shapeCells) && shapeCells.length > 0) {
        targetCoords = shapeCells;
      } else if (bounds) {
        for (let x = bounds!.minX; x <= bounds!.maxX; x++) {
          for (let y = bounds!.minY; y <= bounds!.maxY; y++) {
            for (let z = bounds!.minZ; z <= bounds!.maxZ; z++) {
              targetCoords.push({ x, y, z });
            }
          }
        }
      }

      const result = this.performBasicAction({
        domain: ActionDomain.ENTITY,
        action: 'fill-blocks',
        target: { contraption },
        nodeId,
        coords: targetCoords,
        ...(gradient ? {
          colors: targetCoords.map(coord => this.gradientColorAt({
            x: isMicro ? (coord.x + 0.5) / MICRO_DIVISIONS : coord.x + 0.5,
            y: isMicro ? (coord.y + 0.5) / MICRO_DIVISIONS : coord.y + 0.5,
            z: isMicro ? (coord.z + 0.5) / MICRO_DIVISIONS : coord.z + 0.5,
          }, gradient, color)),
        } : {}),
        color,
        options: { color, materialId },
        micro: isMicro
      });

      if (!result.ok) return;

      contraption.clearSubtreeHighlight?.();
      this.selectedBlockSelection = null;
      this.selectorLevel = null;
      this.selectorRange = null;
      this.updateSelectionAxisGizmo();
      this.sound?.playBlockPlace?.();
      if (this.ui) {
        const addedCount = result.added || 0;
        const recoloredCount = result.recolored || 0;
        this.ui.showToast(`Expanded [${nodeId}]: added ${addedCount}, updated ${recoloredCount} blocks with ${colorToHex(color)}`);
      }
      return;
    }

    // 2. World box / micro selection fill
    if (!this.world || !manager.hasValidSelection()) {
      this.ui?.showToast?.('Nothing selected - box-select a region with the selector first, then press F or click Fill');
      return;
    }

    const isMicroSelection = Array.isArray(manager.microSelection) || manager.microBounds !== null;
    const partition = isMicroSelection && manager.partitionMicroSelection ? manager.partitionMicroSelection() : null;
    const bounds = isMicroSelection ? null : manager.getSelectionBounds();
    if (!isMicroSelection && !bounds) return;
    const gradient = this.worldSelectionGradient(targetColor);

    const largeSelectionCount = partition
      ? partition.standardCells.length + partition.microCells.length
      : isMicroSelection
        ? manager.microSelection?.length || 0
        : manager.connectedSelection !== null
          ? manager.connectedSelection.length
          : (bounds!.maxX - bounds!.minX + 1) * (bounds!.maxY - bounds!.minY + 1) * (bounds!.maxZ - bounds!.minZ + 1);

    if (gradient || largeSelectionCount > BULK_EDIT_THRESHOLD) {
      this.startLargeWorldSelectionFill(manager, partition, bounds, color, materialId, gradient);
      return;
    }

    const result = this.performBasicAction({
      domain: ActionDomain.SELECTION,
      action: 'fill',
      color,
      options: { color, materialId }
    });

    if (result.ok && (result.placed || 0) > 0) {
      this.sound?.playBlockPlace?.();
      const parts = [];
      if ((result.standard ?? 0) > 0) parts.push(`${result.standard} blocks`);
      if ((result.micro ?? 0) > 0) parts.push(`${result.micro} micro voxels`);
      this.ui?.showToast?.(`Filled ${parts.join(' + ') || `${result.placed} voxels`} with ${colorToHex(color)}`);
    } else {
      this.ui?.showToast?.('Selection region fill completed');
    }
  }

  /**
   * Paint/Recolor replaces block colors in the current selection with the active color.
   */
  paintSelectionBlocks(targetColor?: number, fromColor?: number) {
    const manager = this.contraptions;
    if (!manager) return;
    if (this.bulkEditJob) {
      this.ui?.showToast?.(`Please wait for ${this.bulkEditJob.label.toLowerCase()} to finish`);
      return;
    }
    if (!this.requireConfirmedSelection('recoloring')) return;

    const activeStops = targetColor === undefined
      ? normalizeGradientStops(this.selectedGradientStops, this.selectedColor)
      : normalizeGradientStops(null, targetColor);
    const color = sampleGradientColor(activeStops, 0);
    const materialId = normalizeVoxelMaterialId(this.selectedMaterialId);

    // 1. Entity blocks recolor
    if (this.selectedBlockSelection && this.selectedBlockSelection.blocks.length > 0) {
      // Recoloring mutates geometry, so virtual micro cells are subdivided first.
      if (!this.materializeMicroSelection()) return;
      const { contraption, nodeId, blocks } = this.selectedBlockSelection;
      const gradient = this.entitySelectionGradient(this.selectedBlockSelection, targetColor);
      const targetBlocks = fromColor !== undefined
        ? blocks.filter(b => b.color === fromColor)
        : blocks;
      const result = this.performBasicAction({
        domain: ActionDomain.ENTITY,
        action: 'paint-blocks',
        target: { contraption },
        nodeId,
        blocks: targetBlocks,
        ...(gradient ? {
          colors: targetBlocks.map(block => this.gradientColorAt({
            x: Number(block.localX) + Number(block.size || 1) / 2,
            y: Number(block.localY) + Number(block.size || 1) / 2,
            z: Number(block.localZ) + Number(block.size || 1) / 2,
          }, gradient, color)),
        } : {}),
        color,
        options: { color, materialId }
      });
      contraption.clearSubtreeHighlight?.();
      this.selectedBlockSelection = null;
      if (result.ok) {
        this.sound?.playBlockPlace?.();
        this.ui?.showToast?.(`Recolored ${result.painted || targetBlocks.length} blocks on [${nodeId}] to ${colorToHex(color)}`);
      }
      return;
    }

    // 1.5 Entity subtree recolor
    if (this.selectedSubtree && this.selectedSubtree.contraption) {
      const { contraption, rootId } = this.selectedSubtree;
      const result = this.performBasicAction({
        domain: ActionDomain.SELECTION,
        action: 'paint',
        selection: { kind: 'entity-subtree', contraption, rootId, nodeId: rootId },
        color,
        options: { color, materialId, ...(fromColor !== undefined ? { fromColor } : {}) }
      });
      contraption.clearSubtreeHighlight?.();
      this.selectedSubtree = null;
      if (result.ok) {
        this.sound?.playBlockPlace?.();
        this.ui?.showToast?.(`Recolored component [${rootId}] to ${colorToHex(color)}`);
      }
      return;
    }

    // 2. World box / micro selection recolor
    if (!this.world || !manager.hasValidSelection()) {
      this.ui?.showToast?.('Nothing selected - box-select a region with the selector first, then press P or click Paint');
      return;
    }

    const isMicroSelection = Array.isArray(manager.microSelection) || manager.microBounds !== null;
    const partition = isMicroSelection && manager.partitionMicroSelection ? manager.partitionMicroSelection() : null;
    const bounds = isMicroSelection ? null : manager.getSelectionBounds();
    if (!isMicroSelection && !bounds) return;
    const gradient = this.worldSelectionGradient(targetColor);

    const largeSelectionCount = partition
      ? partition.standardCells.length + partition.microCells.length
      : isMicroSelection
        ? manager.microSelection?.length || 0
        : manager.connectedSelection !== null
          ? manager.connectedSelection.length
          : (bounds!.maxX - bounds!.minX + 1) * (bounds!.maxY - bounds!.minY + 1) * (bounds!.maxZ - bounds!.minZ + 1);

    if (gradient || largeSelectionCount > BULK_EDIT_THRESHOLD) {
      this.startLargeWorldSelectionPaint(manager, partition, bounds, color, fromColor, materialId, gradient);
      return;
    }

    const result = this.performBasicAction({
      domain: ActionDomain.SELECTION,
      action: 'paint',
      color,
      options: { color, materialId, ...(fromColor !== undefined ? { fromColor } : {}) }
    });

    if (result.ok && (result.painted || 0) > 0) {
      this.sound?.playBlockPlace?.();
      const parts = [];
      if ((result.standard ?? 0) > 0) parts.push(`${result.standard} blocks`);
      if ((result.micro ?? 0) > 0) parts.push(`${result.micro} micro voxels`);
      this.ui?.showToast?.(`Recolored ${parts.join(' + ') || `${result.painted} voxels`} to ${colorToHex(color)}`);
    } else {
      this.ui?.showToast?.('Selection region contains no matching blocks to recolor');
    }
  }

  handleRightClick(e: MouseEvent | null = null) {
    return this.toolSession.handleRightClick(e);
  }

  rotateBlocksX90(blocks: InventoryVoxel[], quarterTurns = 1) {
    return rotateBlocksX90(blocks, quarterTurns);
  }

  rotateBlocksY90(blocks: InventoryVoxel[], quarterTurns = 1) {
    return rotateBlocksY90(blocks, quarterTurns);
  }

  /** Clear the Hammer's placement-only rotation without touching inventory data. */
  clearHammerRotation() {
    return this.placementSession.clearHammerRotation();
  }

  /** Return the active item in its temporary Hammer placement orientation. */
  getActiveHammerInventoryItem() {
    return this.placementSession.getActiveHammerInventoryItem();
  }

  /**
   * Advance the active inventory item's temporary rotation by one quarter turn.
   * axis: 'y' for horizontal rotation (yaw), 'x' for vertical rotation (pitch).
   * Every pose is derived from the untouched inventory item plus the total turn count.
   */
  rotateActiveInventoryItem(direction = 1, axis: 'x' | 'y' = 'y') {
    return this.placementSession.rotateActiveInventoryItem(direction, axis);
  }

  rotateActiveInventoryItemY(direction = 1) {
    return this.placementSession.rotateActiveInventoryItemY(direction);
  }

  rotateActiveInventoryItemX(direction = 1) {
    return this.placementSession.rotateActiveInventoryItemX(direction);
  }

  private refreshWrenchPivotTargetPose(target = this.wrenchPivotTarget) {
    if (!target?.contraption) return null;
    const contraption = target.contraption;
    if (this.contraptions?.contraptions
      && !this.contraptions.contraptions.includes(contraption)) return null;
    const rootId = contraptionRootId(contraption);
    const rootBody = contraption.getRigidBody?.(rootId);
    target.nodeId = rootId;
    target.bodyId = rootId;
    target.position = (rootBody?.position || contraption.position)?.clone?.();
    target.quaternion = (rootBody?.quaternion || contraption.quaternion)?.clone?.();
    if (!target.position?.isVector3 || !target.quaternion?.isQuaternion) return null;
    const eye = this.physics?.getEyePosition?.() || this.camera?.position || new THREE.Vector3();
    const eyeBent = bendPointForView(eye.x, eye.y, eye.z, new THREE.Vector3());
    const pivotBent = bendPointForView(
      target.position.x,
      target.position.y,
      target.position.z,
      new THREE.Vector3()
    );
    const distance = eyeBent.distanceTo(pivotBent);
    if (!Number.isFinite(distance) || distance > 12) return null;
    target.axisLength = transformGizmoSize(target.position, this.camera?.position || eye);
    return target;
  }

  private renderWrenchPivotTarget() {
    const target = this.wrenchPivotTarget;
    if (!target?.position) {
      this.sceneRenderer?.clearWrenchPivotGizmo?.();
      return false;
    }
    this.sceneRenderer?.setWrenchPivotGizmo?.(
      target.position,
      target.quaternion,
      target.axisLength,
      this.hoveredWrenchGizmoHandle?.handleKey || null,
      this.activeWrenchGizmoDrag?.handleKey || null
    );
    return true;
  }

  private getWrenchGizmoCrosshairHit() {
    if (!this.wrenchPivotTarget || !this.sceneRenderer) return null;
    if (!this.camera) return null;
    const view = transformViewCamera(this.camera);
    return this.sceneRenderer.raycastWrenchPivotGizmoBent?.(view.position, view.getWorldDirection(new THREE.Vector3())) || null;
  }

  updateWrenchGizmoPointerHover(e: MouseEvent) {
    if (this.worldPickingSuspended) {
      this.hoveredWrenchGizmoHandle = null;
      return null;
    }
    if (this.activeTool !== SpecialTool.WRENCH || !this.wrenchPivotTarget || !this.sceneRenderer) {
      this.hoveredWrenchGizmoHandle = null;
      return null;
    }
    if (!this.wrenchGizmoRaycaster) this.wrenchGizmoRaycaster = new THREE.Raycaster();
    const width = Math.max(1, globalThis.innerWidth || 1);
    const height = Math.max(1, globalThis.innerHeight || 1);
    const pointer = new THREE.Vector2(
      (e.clientX / width) * 2 - 1,
      -(e.clientY / height) * 2 + 1
    );
    let hit;
    if (this.sceneRenderer.raycastWrenchPivotGizmoBent) {
      this.wrenchGizmoRaycaster.setFromCamera(pointer, transformViewCamera(this.camera));
      const { origin, direction } = this.wrenchGizmoRaycaster.ray;
      hit = this.sceneRenderer.raycastWrenchPivotGizmoBent(origin, direction);
    } else {
      this.wrenchGizmoRaycaster.setFromCamera(pointer, this.camera);
      hit = this.sceneRenderer.raycastWrenchPivotGizmo?.(this.wrenchGizmoRaycaster);
    }
    this.hoveredWrenchGizmoHandle = hit || null;
    this.renderWrenchPivotTarget();
    return this.hoveredWrenchGizmoHandle;
  }

  updateWrenchPivotGizmo(entityHit: EntityHit | null) {
    if (this.worldPickingSuspended) {
      this.clearWrenchPivotDisplay();
      return null;
    }
    if (this.activeTool !== SpecialTool.WRENCH) {
      this.wrenchPivotTarget = null;
      this.hoveredWrenchGizmoHandle = null;
      this.sceneRenderer?.clearWrenchPivotGizmo?.();
      return null;
    }

    if (this.activeWrenchGizmoDrag) {
      const active = this.refreshWrenchPivotTargetPose();
      if (active) this.renderWrenchPivotTarget();
      return active;
    }

    // Once the crosshair leaves the entity surface for one of the handles, keep
    // the current target alive and pick the already-rendered gizmo first.
    const handleHit = this.isLocked ? this.getWrenchGizmoCrosshairHit() : this.hoveredWrenchGizmoHandle;
    if (handleHit && this.wrenchPivotTarget) {
      this.hoveredWrenchGizmoHandle = handleHit;
      const current = this.refreshWrenchPivotTargetPose();
      if (current) this.renderWrenchPivotTarget();
      return current;
    }

    this.hoveredWrenchGizmoHandle = null;
    if (!entityHit?.contraption) {
      // Keep the current frame while aiming through empty space between the
      // body and its arrows. Otherwise an outer handle vanishes on approach.
      const current = this.refreshWrenchPivotTargetPose();
      if (current) {
        this.renderWrenchPivotTarget();
        return current;
      }
      this.clearWrenchPivotDisplay();
      return null;
    }
    const rootId = contraptionRootId(entityHit.contraption);
    if (this.wrenchPivotTarget?.contraption !== entityHit.contraption) {
      this.wrenchPivotTarget = {
        contraption: entityHit.contraption,
        nodeId: rootId,
        bodyId: rootId
      };
    }
    const current = this.refreshWrenchPivotTargetPose();
    if (!current) {
      this.wrenchPivotTarget = null;
      this.sceneRenderer?.clearWrenchPivotGizmo?.();
      return null;
    }
    this.renderWrenchPivotTarget();
    if (this.isLocked) {
      this.hoveredWrenchGizmoHandle = this.getWrenchGizmoCrosshairHit();
      this.renderWrenchPivotTarget();
    }
    return current;
  }

  clearWrenchPivotDisplay() {
    this.wrenchPivotTarget = null;
    this.hoveredWrenchGizmoHandle = null;
    this.sceneRenderer?.clearWrenchPivotGizmo?.();
  }

  private beginWrenchManipulation(contraption: Contraption, simulationEnabled: boolean, updateServerRunState = true) {
    this.releaseWrenchGrab();
    const wasRunning = contraption.scriptStatus !== 'stopped'
      || contraption.isPhysicsSimulationEnabled?.() !== false;
    contraption.isWrenchGrabbed = true;
    // Fence remote downloads that began before this manual edit, including
    // replies arriving after the mouse has already been released.
    contraption.wrenchManipulationRevision = (contraption.wrenchManipulationRevision || 0) + 1;
    if (contraption.scriptStatus !== 'stopped') {
      this.performBasicAction({
        domain: ActionDomain.ENTITY,
        action: 'stop-scripts',
        target: { contraption }
      });
    } else {
      contraption.stopAllNodeScripts?.();
    }
    if (contraption.serverManaged === true && updateServerRunState) {
      contraption.serverDesiredRunState = 'stopped';
      this.requestServerEntityRunState(contraption, 'stopped', { silent: true });
    }
    contraption.setPhysicsSimulationEnabled?.(simulationEnabled);
    if (typeof contraption.setCollisionSimulationEnabled === 'function') {
      contraption.setCollisionSimulationEnabled(false);
    } else {
      contraption.collisionSimulationEnabled = false;
      contraption.invalidateCollisionPoseCache?.();
    }
    return wasRunning;
  }

  private wrenchScreenVector(origin: THREE.Vector3, vector: THREE.Vector3) {
    const view = transformViewCamera(this.camera);
    const width = Math.max(1, globalThis.innerWidth || 1), height = Math.max(1, globalThis.innerHeight || 1);
    return transformScreenPoint(origin.clone().add(vector), view, width, height)
      .sub(transformScreenPoint(origin, view, width, height));
  }

  startWrenchGizmoDrag(hit: any, e: MouseEvent | null = null) {
    const target = this.refreshWrenchPivotTargetPose();
    if (!hit || !target?.contraption || !['move', 'rotate'].includes(hit.kind)) return false;
    const contraption = target.contraption;
    const bodyId = target.bodyId || contraptionRootId(contraption);
    const axis = String(hit.axis) as 'x' | 'y' | 'z';
    if (!['x', 'y', 'z'].includes(axis)) return false;
    if (!contraption.getRigidBody?.(bodyId)) return false;
    const wasRunning = this.beginWrenchManipulation(contraption, false);
    const rootBody = contraption.getRigidBody(bodyId);
    const localAxis = new THREE.Vector3(
      axis === 'x' ? 1 : 0,
      axis === 'y' ? 1 : 0,
      axis === 'z' ? 1 : 0
    );
    const startPosition = rootBody.position.clone();
    const startQuaternion = rootBody.quaternion.clone();
    const worldAxis = localAxis.clone().applyQuaternion(startQuaternion).normalize();
    const hitPoint = hit.worldPoint?.isVector3 ? hit.worldPoint.clone() : startPosition.clone();
    let radialWorld = hitPoint.sub(startPosition)
      .addScaledVector(worldAxis, -hitPoint.dot(worldAxis));
    if (radialWorld.lengthSq() < 1e-8) {
      radialWorld = (axis === 'x' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0))
        .applyQuaternion(startQuaternion);
    }
    radialWorld.normalize().multiplyScalar((target.axisLength || 1) * WRENCH_GIZMO_ROTATION_RADIUS);

    const inverseStart = startQuaternion.clone().invert();
    const bodyFrames = [...(contraption.rigidBodies?.values?.() || [])].map((body: any) => ({
      body,
      localPosition: body.position.clone().sub(startPosition).applyQuaternion(inverseStart),
      localQuaternion: inverseStart.clone().multiply(body.quaternion).normalize()
    }));
    this.wrenchGrab = { contraption, bodyId, active: false, mode: 'gizmo' };
    this.activeWrenchGizmoDrag = {
      handleKey: hit.handleKey,
      kind: hit.kind,
      axis,
      contraption,
      bodyId,
      startPosition,
      startQuaternion,
      localAxis,
      worldAxis,
      radialWorld,
      bodyFrames,
      totalDistance: 0,
      totalAngle: 0,
      lastX: Number(e?.clientX) || 0,
      lastY: Number(e?.clientY) || 0
    };
    this.sound?.playWrenchClick?.();
    const operation = hit.kind === 'move' ? 'move' : 'rotate';
    const prefix = wasRunning ? 'stopped · ' : '';
    this.ui?.showToast?.(`Wrench: ${prefix}drag ${axis.toUpperCase()} to ${operation} Entity #${contraption.id}`);
    this.renderWrenchPivotTarget();
    return true;
  }

  updateWrenchGizmoDrag(e: MouseEvent) {
    const drag = this.activeWrenchGizmoDrag;
    if (!drag?.contraption) return false;
    const dx = this.isLocked
      ? Number(e.movementX) || 0
      : (Number(e.clientX) || 0) - drag.lastX;
    const dy = this.isLocked
      ? Number(e.movementY) || 0
      : (Number(e.clientY) || 0) - drag.lastY;
    if (!this.isLocked) {
      drag.lastX = Number(e.clientX) || 0;
      drag.lastY = Number(e.clientY) || 0;
    }

    let nextPosition = drag.startPosition.clone();
    let nextQuaternion = drag.startQuaternion.clone();
    if (drag.kind === 'move') {
      const screenAxis = this.wrenchScreenVector(drag.startPosition, drag.worldAxis);
      const pixelsPerMeter = screenAxis.length();
      if (pixelsPerMeter < 1e-4) return false;
      const screenDirection = screenAxis.divideScalar(pixelsPerMeter);
      const delta = THREE.MathUtils.clamp(
        (dx * screenDirection.x + dy * screenDirection.y) / pixelsPerMeter,
        -2,
        2
      );
      drag.totalDistance += delta;
      nextPosition.addScaledVector(drag.worldAxis, drag.totalDistance);
    } else {
      const ringPoint = drag.startPosition.clone().add(drag.radialWorld);
      const tangentWorld = new THREE.Vector3()
        .crossVectors(drag.worldAxis, drag.radialWorld)
        .normalize();
      const screenTangent = this.wrenchScreenVector(ringPoint, tangentWorld);
      const tangentLength = screenTangent.length();
      if (tangentLength < 1e-4) return false;
      const tangentDirection = screenTangent.divideScalar(tangentLength);
      const radiusPixels = Math.max(
        24,
        this.wrenchScreenVector(drag.startPosition, drag.radialWorld).length()
      );
      drag.totalAngle += THREE.MathUtils.clamp(
        (dx * tangentDirection.x + dy * tangentDirection.y) / radiusPixels,
        -0.35,
        0.35
      );
      nextQuaternion.multiply(
        new THREE.Quaternion().setFromAxisAngle(drag.localAxis, drag.totalAngle)
      ).normalize();
    }

    for (const frame of drag.bodyFrames) {
      frame.body.position.copy(frame.localPosition).applyQuaternion(nextQuaternion).add(nextPosition);
      frame.body.quaternion.copy(nextQuaternion).multiply(frame.localQuaternion).normalize();
      frame.body.velocity?.set?.(0, 0, 0);
      frame.body.angularVelocity?.set?.(0, 0, 0);
      frame.body.appliedForces?.set?.(0, 0, 0);
      frame.body.appliedTorques?.set?.(0, 0, 0);
      frame.body.previousKinematicPosition?.copy?.(frame.body.position);
      frame.body.previousKinematicQuaternion?.copy?.(frame.body.quaternion);
    }
    drag.contraption.position.copy(nextPosition);
    drag.contraption.quaternion.copy(nextQuaternion);
    drag.contraption.syncAllBodyTransforms?.();
    drag.contraption.updateTransform?.();
    // Gizmo input directly sets the pose between fixed ticks. Interpolating
    // from the previous mouse event with the physics alpha rewinds on ticks.
    drag.contraption.capturePreviousEntityTransforms?.();
    this.refreshWrenchPivotTargetPose();
    this.renderWrenchPivotTarget();
    return true;
  }

  releaseWrenchGizmoDrag() {
    if (!this.activeWrenchGizmoDrag) return false;
    this.activeWrenchGizmoDrag = null;
    this.hoveredWrenchGizmoHandle = null;
    this.releaseWrenchGrab();
    if (this.refreshWrenchPivotTargetPose()) this.renderWrenchPivotTarget();
    return true;
  }

  getWrenchGrabBodyId(contraption: Contraption, nodeId = contraptionRootId(contraption)) {
    let currentId = String(nodeId ?? contraptionRootId(contraption));
    let kinematicId = null;
    while (currentId) {
      const body = contraption.getRigidBody?.(currentId);
      if (body?.type === BodyType.DYNAMIC) return currentId;
      if (body?.type === BodyType.KINEMATIC && kinematicId === null) kinematicId = currentId;
      currentId = contraption.getEntityNode?.(currentId)?.parentId || '';
    }
    return kinematicId;
  }

  getWrenchTargetPosition(eyePos: THREE.Vector3, targetDistance: number, anchorPos = eyePos, targetSpace = 'flat') {
    const cameraQuat = this.camera?.quaternion || new THREE.Quaternion();
    const lookDir = new THREE.Vector3(0, 0, -1).applyQuaternion(cameraQuat).normalize();
    if (targetSpace !== 'bent') {
      return eyePos.clone().addScaledVector(lookDir, targetDistance);
    }

    // Picking follows the rendered torus surface in bent space. Keep a held
    // point on that same screen ray; a flat tangent ray can drift far enough
    // from the original hit to kick the body when grabbing begins.
    const eyeBent = bendPointForView(eyePos.x, eyePos.y, eyePos.z);
    const lookBent = bendDirection(eyePos.x, eyePos.y, eyePos.z, lookDir).normalize();
    const targetBent = eyeBent.addScaledVector(lookBent, targetDistance);
    const target = unbendPointForView(targetBent.x, targetBent.y, targetBent.z);
    target.x = unwrapPeriodicNear(target.x, anchorPos.x, TORUS_SIZE_X);
    target.z = unwrapPeriodicNear(target.z, anchorPos.z, TORUS_SIZE_Z);
    return target;
  }

  startWrenchGrab() {
    const contraption = this.hoveredContraptionHit?.contraption || this.hoveredContraption;
    if (!contraption) {
      this.ui?.showToast?.('Wrench: hold left-click on an entity to stop and lift it');
      return false;
    }

    if (this.wrenchGrab?.contraption === contraption && this.wrenchGrab.active === true) {
      return true;
    }

    const bodyId = this.getWrenchGrabBodyId(
      contraption,
      this.hoveredContraptionHit?.entityId ?? contraptionRootId(contraption)
    );
    if (!bodyId) {
      this.ui?.showToast?.('Wrench: this entity has no movable body to grab');
      return false;
    }
    const body = contraption.getRigidBody?.(bodyId);
    const originalBodyType = body?.type;
    if (originalBodyType === BodyType.KINEMATIC && typeof contraption.setNodeBodyType !== 'function') {
      this.ui?.showToast?.('Wrench: this kinematic body cannot be moved');
      return false;
    }
    // Point-grabbing uses the existing velocity servo, unlike the COM gizmo's
    // direct stopped transform. Kinematic bodies temporarily become dynamic
    // while held so the same collision-aware servo can move them.
    const wasRunning = this.beginWrenchManipulation(contraption, true);
    if (originalBodyType === BodyType.KINEMATIC
      && !contraption.setNodeBodyType(bodyId, BodyType.DYNAMIC, { runtimeOnly: true, captureDefault: false })) {
      contraption.isWrenchGrabbed = false;
      contraption.setPhysicsSimulationEnabled?.(false);
      contraption.setCollisionSimulationEnabled?.(true);
      this.ui?.showToast?.('Wrench: this kinematic body cannot be moved');
      return false;
    }
    const eyePos = this.physics?.getEyePosition ? this.physics.getEyePosition() : (this.camera?.position ? this.camera.position.clone() : new THREE.Vector3());
    const hitPoint = this.hoveredContraptionHit?.point
      ? (this.hoveredContraptionHit.point.isVector3
        ? this.hoveredContraptionHit.point.clone()
        : new THREE.Vector3(this.hoveredContraptionHit.point.x, this.hoveredContraptionHit.point.y, this.hoveredContraptionHit.point.z))
      : (contraption.position?.isVector3 ? contraption.position.clone() : new THREE.Vector3());

    const localPoint = contraption.worldToEntityLocal
      ? contraption.worldToEntityLocal(bodyId, hitPoint.clone())
      : contraption.worldToLocal
        ? contraption.worldToLocal(hitPoint.clone())
        : hitPoint.clone().sub(contraption.position || new THREE.Vector3());

    const hitDistance = Number(this.hoveredContraptionHit?.distance);
    const targetSpace = Number.isFinite(hitDistance) && hitDistance >= 0 ? 'bent' : 'flat';
    const initialDistance = targetSpace === 'bent' ? hitDistance : eyePos.distanceTo(hitPoint);
    const initialTargetPosition = this.getWrenchTargetPosition(
      eyePos,
      initialDistance,
      hitPoint,
      targetSpace
    );

    this.wrenchGrab = {
      contraption,
      bodyId,
      originalBodyType,
      localPoint,
      targetDistance: initialDistance,
      targetSpace,
      lastTargetPosition: initialTargetPosition,
      active: true
    };
    this.sound?.playWrenchClick?.();
    const actionLabel = wasRunning ? 'stopped and lifted' : 'lifted';
    this.ui?.showToast?.(`Wrench: ${actionLabel} Entity #${contraption.id}`);
    return true;
  }

  releaseWrenchGrab() {
    const wasActive = !!this.wrenchGrab;
    if (this.wrenchGrab?.contraption) {
      const contraption = this.wrenchGrab.contraption;
      contraption.isWrenchGrabbed = false;
      if (contraption.scriptStatus !== 'stopped') {
        this.performBasicAction({
          domain: ActionDomain.ENTITY,
          action: 'stop-scripts',
          target: { contraption }
        });
      } else {
        contraption.stopAllNodeScripts?.();
      }
      if (contraption.serverManaged === true) {
        contraption.serverDesiredRunState = 'stopped';
        this.requestServerEntityRunState(contraption, 'stopped', { silent: true });
      }
      for (const body of contraption.rigidBodies?.values?.() || []) {
        body.velocity?.set?.(0, 0, 0);
        body.angularVelocity?.set?.(0, 0, 0);
      }
      contraption.velocity?.set?.(0, 0, 0);
      contraption.angularVelocity?.set?.(0, 0, 0);
      if (this.wrenchGrab?.originalBodyType === BodyType.KINEMATIC) {
        contraption.setNodeBodyType?.(
          this.wrenchGrab.bodyId,
          BodyType.KINEMATIC,
          { runtimeOnly: true, captureDefault: false }
        );
      }
      contraption.setPhysicsSimulationEnabled?.(false);
      // A stopped network replica receives no further local history updates.
      contraption.capturePreviousEntityTransforms?.();
      if (typeof contraption.setCollisionSimulationEnabled === 'function') {
        contraption.setCollisionSimulationEnabled(true);
      } else {
        contraption.collisionSimulationEnabled = true;
        contraption.invalidateCollisionPoseCache?.();
      }
    }
    this.wrenchGrab = null;
    this.sceneRenderer?.setWrenchTether?.(null, null);
    return wasActive;
  }

  startHoveredEntity() {
    const contraption = this.hoveredContraptionHit?.contraption || this.hoveredContraption;
    if (!contraption) {
      this.ui?.showToast?.('Wrench: point at an entity to start it');
      return false;
    }
    if (this.wrenchGrab?.contraption === contraption) {
      this.releaseWrenchGrab();
    }
    contraption.isWrenchGrabbed = false;
    contraption.serverDesiredRunState = 'running';
    if (typeof contraption.setCollisionSimulationEnabled === 'function') {
      contraption.setCollisionSimulationEnabled(true);
    } else {
      contraption.collisionSimulationEnabled = true;
      contraption.invalidateCollisionPoseCache?.();
    }
    if (contraption.serverManaged === true) {
      return this.requestServerEntityRunState(contraption, 'running');
    }
    const hasRunnableCode = !!contraption.compiledScript || (contraption.compiledNodeScripts?.size || 0) > 0;
    const isAlreadyRunning = contraption.isPhysicsSimulationEnabled?.() !== false &&
      (hasRunnableCode ? contraption.scriptStatus === 'running' : true);

    if (isAlreadyRunning && contraption.scriptStatus !== 'stopped') {
      this.ui?.showToast?.(`Entity #${contraption.id} is already running`);
      return true;
    }

    const result = this.performBasicAction({
      domain: ActionDomain.ENTITY,
      action: 'start-scripts',
      target: { contraption }
    });
    this.sound?.playWrenchClick?.();
    if (this.ui) {
      const message = result.ok
        ? `Entity #${contraption.id} started`
        : result.reason === 'no_scripts'
          ? `Entity #${contraption.id} has no runnable code`
          : `Entity #${contraption.id} could not be started`;
      this.ui.showToast(message);
    }
    return result.ok;
  }

  stopHoveredEntity() {
    const contraption = this.hoveredContraptionHit?.contraption || this.hoveredContraption;
    if (!contraption) {
      this.ui?.showToast?.('Wrench: point at an entity to stop it');
      return false;
    }
    if (contraption.serverManaged === true) {
      return this.requestServerEntityRunState(contraption, 'stopped');
    }
    const result = this.performBasicAction({
      domain: ActionDomain.ENTITY,
      action: 'stop-scripts',
      target: { contraption }
    });
    this.sound?.playWrenchClick?.();
    if (this.ui) {
      this.ui.showToast(result.ok
        ? `Entity #${contraption.id} stopped (state reset)`
        : result.reason === 'already_stopped'
          ? `Entity #${contraption.id} is already stopped`
          : `Entity #${contraption.id} could not be stopped`);
    }
    return result.ok;
  }

  toggleHoveredEntityPlayback() {
    const contraption = this.hoveredContraptionHit?.contraption || this.hoveredContraption;
    if (!contraption) {
      this.ui?.showToast?.('Wrench: point at an entity to start or stop it');
      return false;
    }
    const shouldStart = contraption.isPhysicsSimulationEnabled?.() === false;
    if (contraption.serverManaged === true) {
      return this.requestServerEntityRunState(contraption, shouldStart ? 'running' : 'stopped');
    }
    const result = this.performBasicAction({
      domain: ActionDomain.ENTITY,
      action: shouldStart ? 'start-scripts' : 'stop-scripts',
      target: { contraption }
    });
    this.sound?.playWrenchClick?.();
    if (this.ui) {
      const message = result.ok
        ? shouldStart
          ? `Entity #${contraption.id} started`
          : `Entity #${contraption.id} stopped (state reset)`
        : result.reason === 'no_scripts'
          ? `Entity #${contraption.id} has no runnable code`
          : `Entity #${contraption.id} could not be updated`;
      this.ui.showToast(message);
    }
    return result.ok;
  }

  setServerEntityRunStateHandler(handler: PlayerController['serverEntityRunStateHandler']) {
    this.serverEntityRunStateHandler = typeof handler === 'function' ? handler : null;
  }

  setServerEntityDeleteHandler(handler: PlayerController['serverEntityDeleteHandler']) {
    this.serverEntityDeleteHandler = typeof handler === 'function' ? handler : null;
  }

  private applyEntityRotation(contraption: Contraption, targetRotation: THREE.Quaternion, options: any = {}): boolean {
    const rootId = contraptionRootId(contraption);
    const rootBody = contraption.getRigidBody?.(rootId);
    if (!rootBody?.position?.isVector3 || !rootBody?.quaternion?.isQuaternion) {
      this.ui?.showToast?.('Entity rotation could not be reset', { tone: 'warning' });
      return false;
    }

    this.beginWrenchManipulation(contraption, false, false);
    const rootPosition = rootBody.position.clone();
    const rootRotation = rootBody.quaternion.clone().normalize();
    const inverseRootRotation = rootRotation.clone().invert();
    const bodyFrames = [...(contraption.rigidBodies?.values?.() || [])].map((body: any) => ({
      body,
      localPosition: body.position.clone().sub(rootPosition).applyQuaternion(inverseRootRotation),
      localQuaternion: inverseRootRotation.clone().multiply(body.quaternion).normalize()
    }));
    const nextRotation = targetRotation.clone().normalize();

    for (const frame of bodyFrames) {
      frame.body.position.copy(frame.localPosition).applyQuaternion(nextRotation).add(rootPosition);
      frame.body.quaternion.copy(nextRotation).multiply(frame.localQuaternion).normalize();
      frame.body.velocity?.set?.(0, 0, 0);
      frame.body.angularVelocity?.set?.(0, 0, 0);
      frame.body.appliedForces?.set?.(0, 0, 0);
      frame.body.appliedTorques?.set?.(0, 0, 0);
      frame.body.previousKinematicPosition?.copy?.(frame.body.position);
      frame.body.previousKinematicQuaternion?.copy?.(frame.body.quaternion);
    }
    rootBody.quaternion.copy(nextRotation);
    contraption.position.copy(rootPosition);
    contraption.quaternion.copy(nextRotation);
    contraption.velocity?.set?.(0, 0, 0);
    contraption.angularVelocity?.set?.(0, 0, 0);
    contraption.syncAllBodyTransforms?.();
    contraption.updateTransform?.();
    contraption.isWrenchGrabbed = false;
    if (typeof contraption.setCollisionSimulationEnabled === 'function') {
      contraption.setCollisionSimulationEnabled(true);
    } else {
      contraption.collisionSimulationEnabled = true;
      contraption.invalidateCollisionPoseCache?.();
    }
    contraption.capturePreviousEntityTransforms?.();
    if (options.save !== false) this.contraptions?.saveEntitiesToStorage?.();
    if (options.refresh !== false) this.ui?.refresh?.();
    if (options.toast) this.ui?.showToast?.(options.toast);
    return true;
  }

  private async rotateEntityToGrid(contraption: Contraption, targetRotation: THREE.Quaternion, options: any = {}): Promise<boolean> {
    if (contraption.serverManaged === true) {
      if (contraption.serverExecutionMode === 'hosted' || contraption.serverCanEdit !== true) {
        this.ui?.showToast?.('This entity cannot be rotated from this client', { tone: 'warning' });
        return false;
      }
      if (this.isEntityRunning(contraption)) {
        const stopped = await this.requestServerEntityRunState(contraption, 'stopped', { silent: true });
        if (!stopped) return false;
      }
    }
    return this.applyEntityRotation(contraption, targetRotation, options);
  }

  private async resetEntityRotation(contraption: Contraption): Promise<boolean> {
    return this.rotateEntityToGrid(contraption, new THREE.Quaternion(), {
      toast: `Entity #${contraption.id} rotation reset`
    });
  }

  private async snapEntityRotationToGrid(contraption: Contraption, options: any = {}): Promise<boolean> {
    const rootBody = contraption.getRigidBody?.(contraptionRootId(contraption));
    if (!rootBody?.quaternion?.isQuaternion) {
      this.ui?.showToast?.('Entity rotation could not be aligned to the grid', { tone: 'warning' });
      return false;
    }
    return this.rotateEntityToGrid(
      contraption,
      nearestGridAlignedQuaternion(rootBody.quaternion),
      options
    );
  }

  private async disassembleEntity(contraption: Contraption): Promise<boolean> {
    const isServerManaged = contraption.serverManaged === true;
    if (isServerManaged
      && (contraption.serverExecutionMode === 'hosted'
        || contraption.serverCanControl !== true
        || contraption.serverCanEdit !== true)) {
      this.ui?.showToast?.('This entity cannot be disassembled from this client', { tone: 'warning' });
      return false;
    }
    if (isServerManaged && !this.serverEntityDeleteHandler) {
      this.ui?.showToast?.('Entity disassembly is temporarily unavailable', { tone: 'warning' });
      return false;
    }
    const originalRootRotation = contraption.getRigidBody?.(contraptionRootId(contraption))?.quaternion?.clone?.();
    if (this.wrenchGrab?.contraption === contraption) this.releaseWrenchGrab();
    const aligned = await this.snapEntityRotationToGrid(contraption, {
      save: false,
      refresh: false
    });
    if (!aligned) return false;
    if (!this.contraptions?.contraptions?.includes(contraption)) {
      this.ui?.showToast?.('This entity is no longer available', { tone: 'warning' });
      return false;
    }

    if (isServerManaged) {
      try {
        const deleteEntity = this.serverEntityDeleteHandler;
        if (!deleteEntity) throw new Error('Entity deletion is unavailable');
        await deleteEntity(contraption);
      } catch {
        if (originalRootRotation?.isQuaternion) {
          this.applyEntityRotation(contraption, originalRootRotation, { save: false });
        }
        this.ui?.showToast?.('Entity could not be disassembled; please try again', { tone: 'warning' });
        return false;
      }
    }

    if (this.isDriving && this.drivenContraption === contraption) this.toggleDriveVehicle();
    if ([this.selectedBlockSelection, this.selectedSubtree, this.selectorLevel, this.selectorRange]
      .some(selection => selection?.contraption === contraption)) this.clearSelection();
    if (this.hoveredContraption === contraption) this.hoveredContraption = null;
    if (this.hoveredContraptionHit?.contraption === contraption) this.hoveredContraptionHit = null;
    const disassembled = this.contraptions.disassembleContraption?.(contraption, {
      skipRemoteDelete: isServerManaged
    }) === true;
    if (!disassembled) {
      this.ui?.showToast?.('Entity could not be disassembled', { tone: 'warning' });
      return false;
    }
    this.ui?.notifyContraptionRemoved?.(contraption);
    this.ui?.refresh?.();
    this.ui?.showToast?.(`Entity #${contraption.id} aligned to the grid and disassembled`);
    return true;
  }

  /** Whole-entity menu commands deliberately do not depend on hover, active
   * tool, or a Selector A/B range. Geometry selection retains its own gate. */
  async performEntityMenuAction(contraption: Contraption, action: string): Promise<boolean> {
    if (!this.contraptions?.contraptions?.includes(contraption)) {
      this.ui?.showToast?.('This entity is no longer available', { tone: 'warning' });
      return false;
    }
    if (this.bulkEditJob) {
      this.ui?.showToast?.(`Please wait for ${this.bulkEditJob.label.toLowerCase()} to finish`, { tone: 'warning' });
      return false;
    }
    if (contraption.serverManaged === true && contraption.serverCanControl !== true && this.isEntityRunning(contraption)) {
      this.ui?.showToast?.('This entity is occupied by another endpoint', { tone: 'warning' });
      return false;
    }
    if (action === 'program') return this.openCodeEditorForTarget(contraption);
    if (action === 'copy') {
      const slot = contraption.serializeSubtree(contraptionRootId(contraption));
      const index = this.addInventoryItem('entity', slot);
      if (index === null) {
        this.ui?.showToast?.('Item inventory is full; remove an item first', { tone: 'warning' });
        return false;
      }
      this.clearSelection();
      this.setActiveInventoryCategory('entity');
      this.activateTool(SpecialTool.HAMMER);
      this.ui?.renderInventoryBar?.();
      this.ui?.showToast?.(`Entity copied to backpack slot ${index + 1} · use Hammer to place it`);
      return true;
    }
    if (action === 'select-all') {
      this.activateTool(SpecialTool.SELECTOR);
      return this.selectAllSelectionBlocks({ contraption, nodeId: contraptionRootId(contraption) });
    }
    if (action === 'reset-rotation') return this.resetEntityRotation(contraption);
    if (action === 'disassemble') return this.disassembleEntity(contraption);
    if (!['start', 'stop', 'delete'].includes(action)) return false;
    if (contraption.serverManaged === true && contraption.serverCanControl !== true) {
      this.ui?.showToast?.('This entity is occupied by another endpoint', { tone: 'warning' });
      return false;
    }
    if (action === 'delete') {
      if (contraption.serverManaged === true) {
        if (!this.serverEntityDeleteHandler) {
          this.ui?.showToast?.('Entity deletion is temporarily unavailable', { tone: 'warning' });
          return false;
        }
        try {
          const deleteEntity = this.serverEntityDeleteHandler;
        if (!deleteEntity) throw new Error('Entity deletion is unavailable');
        await deleteEntity(contraption);
        } catch {
          this.ui?.showToast?.('Entity could not be deleted; please try again', { tone: 'warning' });
          return false;
        }
      }
      if (this.wrenchGrab?.contraption === contraption) this.releaseWrenchGrab();
      if (this.isDriving && this.drivenContraption === contraption) this.toggleDriveVehicle();
      if ([this.selectedBlockSelection, this.selectedSubtree, this.selectorLevel, this.selectorRange]
        .some(selection => selection?.contraption === contraption)) this.clearSelection();
      if (this.hoveredContraption === contraption) this.hoveredContraption = null;
      if (this.hoveredContraptionHit?.contraption === contraption) this.hoveredContraptionHit = null;
      if (this.contraptions.contraptions.includes(contraption)) {
        this.contraptions.removeContraption(contraption, { skipRemoteDelete: contraption.serverManaged === true });
      }
      this.ui?.notifyContraptionRemoved?.(contraption);
      this.ui?.showToast?.(`Entity #${contraption.id} deleted`);
      return true;
    }
    if (this.wrenchGrab?.contraption === contraption) this.releaseWrenchGrab();
    if (contraption.serverManaged === true) {
      return this.requestServerEntityRunState(contraption, action === 'start' ? 'running' : 'stopped');
    }
    const result = this.performBasicAction({
      domain: ActionDomain.ENTITY,
      action: action === 'start' ? 'start-scripts' : 'stop-scripts',
      target: { contraption }
    });
    this.ui?.refresh?.();
    this.ui?.showToast?.(result.ok ? `Entity #${contraption.id} ${action === 'start' ? 'started' : 'stopped'}` : 'Entity could not be updated');
    return result.ok;
  }

  async requestServerEntityRunState(contraption: Contraption, desiredState: 'running' | 'stopped', options: any = {}) {
    if (contraption.serverCanControl !== true) {
      if (!options?.silent) {
        this.ui?.showToast?.('This entity is read-only or occupied by another endpoint');
      }
      return false;
    }
    if (!this.serverEntityRunStateHandler) {
      if (!options?.silent) {
        this.ui?.showToast?.('Entity control is temporarily unavailable');
      }
      return false;
    }
    try {
      await this.serverEntityRunStateHandler(contraption, desiredState);
      if (!options?.silent) {
        this.sound?.playWrenchClick?.();
        const executesHere = contraption.serverExecutesLocally === true;
        this.ui?.showToast?.(
          desiredState === 'stopped'
            ? `Entity #${contraption.id} stopped (state reset)`
            : executesHere
              ? `Entity #${contraption.id} started`
              : `Entity #${contraption.id} waiting for an available execution endpoint`
        );
      }
      return true;
    } catch (error: any) {
      if (!options?.silent) {
        if (error?.code === 'ENTITY_REVISION_CONFLICT') {
          this.ui?.showToast?.('Entity state changed elsewhere; try again');
        } else if (error?.code === 'ENTITY_OCCUPIED') {
          this.ui?.showToast?.('This entity is occupied by another endpoint');
        } else {
          this.ui?.showToast?.('Entity could not be updated');
        }
      }
      return false;
    }
  }

  paintTargetedBlock() {
    if (this.handleRunningEntityInteraction(this.hoveredContraptionHit?.contraption)) return;
    if (this.hoveredContraptionHit) {
      const hit = this.hoveredContraptionHit;
      const c = hit.contraption;
      if (hit.block) {
        const nodeId = hit.entityId ?? contraptionRootId(c);
        const isMicro = (hit.block.size || 1) < 1;

        if (this.brushMicroMode) {
          if (isMicro) {
            const result = this.performBasicAction({
              domain: ActionDomain.ENTITY,
              action: 'paint-micro',
              target: { contraption: c },
              nodeId,
              micro: [
                Math.round(hit.block.localX * MICRO_DIVISIONS),
                Math.round(hit.block.localY * MICRO_DIVISIONS),
                Math.round(hit.block.localZ * MICRO_DIVISIONS)
              ],
              color: this.selectedColor,
              options: { color: this.selectedColor, materialId: this.selectedMaterialId }
            });
            if (!result.ok) return;
            this.sound.playBlockPlace();
            this.particles.emitBlockBreak(hit.point, this.selectedColor, 4);
            if (this.ui) this.ui.showToast(`Painted micro voxel on [${nodeId}]: ${colorToHex(this.selectedColor)}`);
            return;
          } else {
            const hitCell = hit.cell;
            const targetMicro = [
              Math.round((hit.placeMicroPos.localX - hit.normal.x * MICRO_SIZE) * MICRO_DIVISIONS),
              Math.round((hit.placeMicroPos.localY - hit.normal.y * MICRO_SIZE) * MICRO_DIVISIONS),
              Math.round((hit.placeMicroPos.localZ - hit.normal.z * MICRO_SIZE) * MICRO_DIVISIONS)
            ];
            const subdivideRes = this.performBasicAction({
              domain: ActionDomain.ENTITY,
              action: 'subdivide-standard',
              target: { contraption: c },
              nodeId,
              cell: hitCell
            });
            if (subdivideRes.ok) {
              this.performBasicAction({
                domain: ActionDomain.ENTITY,
                action: 'paint-micro',
                target: { contraption: c },
                nodeId,
                micro: targetMicro,
                color: this.selectedColor,
                options: { color: this.selectedColor, materialId: this.selectedMaterialId }
              });
              this.ui?.notifyContraptionStructureChanged(c);
              this.sound.playBlockPlace();
              this.particles.emitBlockBreak(hit.point, this.selectedColor, 4);
              if (this.ui) this.ui.showToast(`Subdivided & painted micro voxel on [${nodeId}]: ${colorToHex(this.selectedColor)}`);
              return;
            }
          }
        } else {
          const result = this.performBasicAction({
            domain: ActionDomain.ENTITY,
            target: { contraption: c },
            nodeId,
            ...(isMicro
              ? {
                action: 'paint-micro' as const,
                micro: [
                  Math.round(hit.block.localX * MICRO_DIVISIONS),
                  Math.round(hit.block.localY * MICRO_DIVISIONS),
                  Math.round(hit.block.localZ * MICRO_DIVISIONS)
                ]
              }
              : { action: 'paint-standard' as const, cell: hit.cell }),
            color: this.selectedColor,
            options: { color: this.selectedColor, materialId: this.selectedMaterialId }
          });
          if (!result.ok) return;
          this.sound.playBlockPlace();
          this.particles.emitBlockBreak(hit.point, this.selectedColor, 6);
          if (this.ui) this.ui.showToast(`Painted block on [${nodeId}]: ${colorToHex(this.selectedColor)}`);
          return;
        }
      }
    }

    if (!this.currentRaycast || !this.currentRaycast.hit) return;

    if (this.brushMicroMode) {
      if (this.currentRaycast.kind === 'micro') {
        const mp = this.currentRaycast.microPos;
        const result = this.performBasicAction({
          domain: ActionDomain.WORLD,
          action: 'paint-micro',
          micro: mp,
          color: this.selectedColor,
          options: { color: this.selectedColor, materialId: this.selectedMaterialId }
        });
        if (result.ok) {
          this.sound.playBlockPlace();
          this.particles.emitBlockBreak(this.currentRaycast.hitPos, this.selectedColor, 4);
          if (this.ui) this.ui.showToast(`Painted micro voxel: ${colorToHex(this.selectedColor)}`);
        }
      } else {
        const hp = this.currentRaycast.hitPos;
        const normal = this.currentRaycast.normal;
        const entry = this.currentRaycast.entry
          ? new THREE.Vector3(this.currentRaycast.entry.x, this.currentRaycast.entry.y, this.currentRaycast.entry.z)
          : this.physics.getEyePosition();
        const clamp = (value: number, base: number) => Math.max(base * MICRO_DIVISIONS, Math.min(base * MICRO_DIVISIONS + MICRO_DIVISIONS - 1, value));
        const targetMicro = [
          clamp(Math.floor((entry.x + normal.x * 0.02) * MICRO_DIVISIONS), hp.x),
          clamp(Math.floor((entry.y + normal.y * 0.02) * MICRO_DIVISIONS), hp.y),
          clamp(Math.floor((entry.z + normal.z * 0.02) * MICRO_DIVISIONS), hp.z)
        ];
        const subdivideResult = this.performBasicAction({
          domain: ActionDomain.WORLD,
          action: 'subdivide-standard',
          cell: hp
        });
        if (subdivideResult.ok) {
          this.performBasicAction({
            domain: ActionDomain.WORLD,
            action: 'paint-micro',
            micro: targetMicro,
            color: this.selectedColor,
            options: { color: this.selectedColor, materialId: this.selectedMaterialId }
          });
          this.sound.playBlockPlace();
          this.particles.emitBlockBreak(this.currentRaycast.hitPos, this.selectedColor, 4);
          if (this.ui) this.ui.showToast(`Subdivided & painted micro voxel: ${colorToHex(this.selectedColor)}`);
        }
      }
    } else {
      if (this.currentRaycast.kind === 'micro') {
        const mp = this.currentRaycast.microPos;
        const result = this.performBasicAction({
          domain: ActionDomain.WORLD,
          action: 'paint-micro',
          micro: mp,
          color: this.selectedColor,
          options: { color: this.selectedColor, materialId: this.selectedMaterialId }
        });
        if (result.ok) {
          this.sound.playBlockPlace();
          this.particles.emitBlockBreak(this.currentRaycast.hitPos, this.selectedColor, 4);
          if (this.ui) this.ui.showToast(`Painted micro voxel: ${colorToHex(this.selectedColor)}`);
        }
      } else {
        const hp = this.currentRaycast.hitPos;
        const result = this.performBasicAction({
          domain: ActionDomain.WORLD,
          action: 'paint-standard',
          cell: hp,
          color: this.selectedColor,
          options: { color: this.selectedColor, materialId: this.selectedMaterialId }
        });
        if (result.ok) {
          this.sound.playBlockPlace();
          this.particles.emitBlockBreak(hp, this.selectedColor, 8);
          if (this.ui) this.ui.showToast(`Painted block: ${colorToHex(this.selectedColor)}`);
        }
      }
    }
  }

  sampleTargetedColor() {
    if (this.hoveredContraptionHit && this.hoveredContraptionHit.color !== undefined) {
      if (this.ui) {
        this.ui.setBuildColor(this.hoveredContraptionHit.color);
      }
      this.sound.playWrenchClick();
      return;
    }

    if (!this.currentRaycast || !this.currentRaycast.hit) return;
    const color = this.currentRaycast.color;
    if (color !== undefined && color !== null) {
      if (this.ui) {
        this.ui.setBuildColor(color);
      }
      this.sound.playWrenchClick();
    }
  }

  handleBrushRightClick() {
    const hitEntity = this.hoveredContraptionHit;
    if (this.handleRunningEntityInteraction(hitEntity?.contraption)) return;

    if (this.brushSelection === null) {
      if (!hitEntity) {
        return;
      }
      const c = hitEntity.contraption;
      if (!this.canEditEntityInternals(c)) {
        if (this.ui) {
          this.ui.showToast('Brush right-click only works on stopped entities');
        }
        return;
      }
      const nodeId = hitEntity.entityId ?? contraptionRootId(c);
      const targetPoint = this.brushMicroMode
        ? (hitEntity.placeMicroPos
          ? new THREE.Vector3(
            hitEntity.placeMicroPos.localX - (hitEntity.normal?.x || 0) * (MICRO_SIZE / 2),
            hitEntity.placeMicroPos.localY - (hitEntity.normal?.y || 0) * (MICRO_SIZE / 2),
            hitEntity.placeMicroPos.localZ - (hitEntity.normal?.z || 0) * (MICRO_SIZE / 2)
          )
          : hitEntity.point)
        : hitEntity.point;
      const localPoint = this.rangePointToLocal({ contraption: c, nodeId }, targetPoint);
      this.brushSelection = {
        contraption: c,
        nodeId,
        pointA: localPoint,
        rawWorldA: hitEntity.point.clone(),
        micro: this.brushMicroMode === true
      };
      c.clearFocusHighlight?.();
      this.sound?.playWrenchClick?.();
      if (this.ui) {
        this.ui.showToast(`Brush [1/2] picked corner on [${nodeId}], right-click opposite corner in same component to dye region`);
      }
      return;
    }

    this.applyBrushRegionDye(hitEntity);
  }

  applyBrushRegionDye(hitEntity: any = null) {
    if (!this.brushSelection) return;

    const selection = this.brushSelection;
    const c = selection.contraption;
    if (this.handleRunningEntityInteraction(c)) return;
    if (!c || !this.canEditEntityInternals(c)) {
      this.clearBrushSelection();
      this.sound?.playWrenchClick?.();
      if (this.ui) {
        this.ui.showToast('Brush selection cancelled (entity not editable)');
      }
      return;
    }

    const hitNodeId = hitEntity?.entityId ?? (hitEntity?.contraption ? contraptionRootId(hitEntity.contraption) : null);
    const sameComponent = hitEntity
      && hitEntity.contraption === c
      && hitNodeId === selection.nodeId;

    if (!sameComponent) {
      this.clearBrushSelection();
      this.sound?.playWrenchClick?.();
      if (this.ui) {
        this.ui.showToast('Brush selection cancelled (outside component)');
      }
      return;
    }

    const nodeId = selection.nodeId;
    const localPointB = this.rangePointToLocal(selection, hitEntity.point);
    if (!localPointB || !selection.pointA) {
      this.clearBrushSelection();
      return;
    }

    const boxResult = this.performBasicAction({
      domain: ActionDomain.SELECTION,
      action: 'entity-box',
      target: { contraption: c },
      nodeId,
      a: selection.pointA,
      b: localPointB,
      space: 'node-local',
      micro: selection.micro === true
    });

    const blocks = boxResult.selection?.blocks || [];
    if (blocks.length > 0) {
      const paintResult = this.performBasicAction({
        domain: ActionDomain.ENTITY,
        action: 'paint-blocks',
        target: { contraption: c },
        nodeId,
        blocks,
        color: this.selectedColor,
        options: { color: this.selectedColor, materialId: this.selectedMaterialId }
      });
      this.performBasicAction({ domain: ActionDomain.SELECTION, action: 'clear' });
      c.clearSubtreeHighlight?.();
      c.clearFocusHighlight?.();
      const count = paintResult.painted || blocks.length;
      this.sound?.playBlockPlace?.();
      this.particles?.emitBlockBreak?.(hitEntity.point, this.selectedColor, 8);
      if (this.ui) {
        this.ui.showToast(`Brush [2/2]: dyed ${count} blocks on [${nodeId}] with ${colorToHex(this.selectedColor)}`);
      }
    } else {
      this.performBasicAction({ domain: ActionDomain.SELECTION, action: 'clear' });
      c.clearSubtreeHighlight?.();
      c.clearFocusHighlight?.();
      if (this.ui) {
        this.ui.showToast('Brush: region contains no blocks to dye');
      }
    }
    this.clearBrushSelection();
  }

  // =========================================================================
  // Inventory serialization plus Hammer placement
  // =========================================================================

  /**
   * Recursively collect the node IDs of `rootId` and all its descendants.
   * @returns A `Set<string>` of node IDs.
   */
  collectSubtreeIds(contraption: Contraption, rootId: string) {
    const ids = new Set<string>();
    const walk = (id: string) => {
      if (ids.has(id)) return;
      ids.add(id);
      for (const node of contraption.entityNodes.values()) {
        if (node.parentId === id) walk(node.id);
      }
    };
    walk(rootId);
    return ids;
  }

  /** R key (Selector): serialize the selected subtree into the entity category. */
  copySelectedSubtreeToInventory() {
    if (!this.requireConfirmedSelection('copying')) return null;
    if (!this.selectedSubtree || !this.selectedSubtree.contraption) {
      if (this.ui) this.ui.showToast('Nothing selected - point at an entity/component with the selector first');
      return null;
    }
    const { contraption, rootId } = this.selectedSubtree;
    const containsInternalRoot = rootId !== contraptionRootId(contraption);
    if (containsInternalRoot && !this.canEditEntityInternals(contraption)) {
      this.clearSelection();
      this.ui?.showToast?.('Stop the entity before copying one of its internal components');
      return null;
    }
    const slot = contraption.serializeSubtree(rootId);
    if (!slot) return null;
    const index = this.addInventoryItem('entity', slot);
    if (index === null) {
      this.ui?.showToast?.(`Item inventory is full (${this.inventories.entity.items.length}) - delete one first`);
      return null;
    }
    this.setActiveInventoryCategory('entity');
    this.ui?.renderInventoryBar?.();
    this.clearSelection();
    this.activateTool(SpecialTool.HAMMER);
    if (this.ui) {
      this.ui.showToast(`Copied [${rootId}] (${slot.blockCount} blocks, ${slot.scripts.length} scripts) to item slot ${index + 1} · switched to Hammer`);
    }
    return slot;
  }

  // --- Backpack compatibility bridge -------------------------------------------------
  // `inventorySlots` / `selectedInventoryIndex` keep the historic single-list API,
  // transparently bound to the *active* category so the hammer bar and the Shift
  // shortcuts operate on 9 slots of blocksets, entities or color sets.
  get inventorySlots() {
    return this.inventoryCategory().items;
  }
  set inventorySlots(value) {
    this.clearHammerRotation();
    const capacity = this.activeInventoryCategory === 'colorset' ? MAX_BACKPACK_SLOTS_PER_CATEGORY : MAX_BACKPACK_ITEM_SLOTS;
    const items = new Array(capacity).fill(null);
    if (Array.isArray(value)) {
      for (let index = 0; index < Math.min(capacity, value.length); index++) items[index] = value[index];
    }
    this.inventoryCategory().items = items;
    this.saveInventoriesToLocalStorage();
  }
  get selectedInventoryIndex() {
    return this.inventoryCategory().selected;
  }
  set selectedInventoryIndex(value) {
    const group = this.inventoryCategory();
    const next = Number.isInteger(value) && value >= 0 && value < group.items.length ? value : 0;
    if (group.selected !== next) this.clearHammerRotation();
    group.selected = next;
    this.saveInventoriesToLocalStorage();
  }

  createEmptyInventories(): Inventories {
    return createEmptyInventories();
  }

  inventoryCategory() {
    if (!this.inventories) {
      this.inventories = this.createEmptyInventories();
      this.activeInventoryCategory = 'item';
    }
    return inventoryGroup(this.inventories, this.activeInventoryCategory) || this.inventories.item;
  }

  setActiveInventoryCategory(category: string) {
    if (!this.inventories) this.inventoryCategory();
    const view = category === 'colorset' ? 'colorset' : 'item';
    if (this.activeInventoryCategory !== view) this.clearHammerRotation();
    this.activeInventoryCategory = view;
    const group = this.inventories[view];
    group.selected = Number.isInteger(group.selected) && group.selected >= 0 && group.selected < group.items.length
      ? group.selected : 0;
    this.saveInventoriesToLocalStorage();
    return view;
  }

  /** Hammer has one shared Item hotbar. */
  toggleHammerCategory() {
    this.setActiveInventoryCategory('item');
    this.ui?.renderInventoryBar?.();
    return 'item';
  }

  /**
   * Tab key (Selector tool): toggle between standard 1 m block selection
   * (the default) and 0.125 m micro-block selection. Switching granularity
   * discards any in-progress or completed block selection (world box, sparse
   * single cells, entity box) so the two granularities never mix; component
   * subtree selection is unaffected.
   */
  toggleSelectorMicroMode() {
    return this.selectionSession.toggleSelectorMicroMode();
  }

  /** Switch active geometric selection shape (box, cylinder, sphere, stairs, line). */
  setSelectorShape(shape: SelectorShape) {
    return this.selectionSession.setSelectorShape(shape);
  }

  /**
   * Apply geometric selection shape (box, cylinder, sphere, stairs, line) to sub-component selection.
   */
  applyEntitySelectionShape(
    shape: SelectorShape = this.selectorShape,
    anchorA?: { x: number; y: number; z: number },
    anchorB?: { x: number; y: number; z: number }
  ) {
    return this.selectionSession.applyEntitySelectionShape(shape, anchorA, anchorB);
  }

  /**
   * Mathematically compute voxels for the active shape within the selection
   * bounds and update connectedSelection / microSelection.
   */
  applySelectionShape(shape: SelectorShape = this.selectorShape) {
    return this.selectionSession.applySelectionShape(shape);
  }

  /**
   * Rotate the active selection 90° around the selection center.
   * - axis = 'y': Yaw (horizontal rotation, ArrowLeft = -1, ArrowRight = 1)
   * - axis = 'x': Pitch (vertical rotation, ArrowDown = -1, ArrowUp = 1)
   */
  rotateSelection(direction: number = 1, axis: 'x' | 'y' = 'y'): boolean {
    return this.selectionSession.rotateSelection(direction, axis);
  }

  /**
   * Tab key (Brush tool): toggle between standard 1 m block painting (the default)
   * and 0.125 m micro-block painting.
   */
  toggleBrushMicroMode() {
    return this.toolSession.toggleBrushMicroMode();
  }

  /**
   * Resolve the 0.125 m micro cell under the crosshair for the current world
   * raycast. Micro hits use the hit micro cell directly; standard hits use
   * the exact face entry point pushed through the surface (the same math as
   * the spoon's direct carve), clamped to the hit standard cell so aiming at
   * any face selects the surface micro cell of the target block. Returns
   * torus-wrapped micro-grid indices {x,y,z}, or null when nothing is hit.
   */
  selectorMicroCellFromRaycast(ray = this.currentRaycast) {
    if (!ray || !ray.hit) return null;
    if (ray.kind === 'micro' && ray.microPos) {
      return {
        x: wrapMicroX(ray.microPos.x),
        y: Math.max(0, ray.microPos.y),
        z: wrapMicroZ(ray.microPos.z)
      };
    }
    const hp = ray.hitPos;
    if (!hp) return null;
    const normal = ray.normal || { x: 0, y: 0, z: 0 };
    const entry = ray.entry || hp;
    const baseX = Math.floor(hp.x);
    const baseY = Math.floor(hp.y);
    const baseZ = Math.floor(hp.z);
    const clamp = (value: number, base: number) => Math.max(base * MICRO_DIVISIONS, Math.min(base * MICRO_DIVISIONS + MICRO_DIVISIONS - 1, value));
    return {
      x: wrapMicroX(clamp(Math.floor((entry.x + normal.x * 0.02) * MICRO_DIVISIONS), baseX)),
      y: Math.max(0, clamp(Math.floor((entry.y + normal.y * 0.02) * MICRO_DIVISIONS), baseY)),
      z: wrapMicroZ(clamp(Math.floor((entry.z + normal.z * 0.02) * MICRO_DIVISIONS), baseZ))
    };
  }

  /** Meter-space origin of the 0.125 m micro cell containing a world point. */
  microMeterPoint(point: Point3 | null) {
    if (!point) return null;
    return {
      x: Math.floor(point.x * MICRO_DIVISIONS + 1e-6) / MICRO_DIVISIONS,
      y: Math.max(0, Math.floor(point.y * MICRO_DIVISIONS + 1e-6)) / MICRO_DIVISIONS,
      z: Math.floor(point.z * MICRO_DIVISIONS + 1e-6) / MICRO_DIVISIONS
    };
  }

  /**
   * Corner A of a pending world box in meter units. Micro-mode corners are
   * stored as 0.125-grid integers, so they must be scaled down before the
   * preview renderer (which works in meters) floors them.
   */
  pendingWorldCornerAMeters() {
    const cornerA = this.contraptions?.selectionCornerA;
    if (!cornerA) return null;
    return cornerA.micro
      ? { x: cornerA.x / MICRO_DIVISIONS, y: cornerA.y / MICRO_DIVISIONS, z: cornerA.z / MICRO_DIVISIONS }
      : { x: cornerA.x, y: cornerA.y, z: cornerA.z };
  }

  /** Use an empty shared Item or Color Set slot, preferring the selected empty
   *  hotbar slot. Returns its index, or null when the group is full. */
  addInventoryItem(category: InventoryKind, item: InventoryInput | null): number | null {
    this.inventoryCategory();
    const view = category === 'colorset' ? 'colorset' : 'item';
    const group = inventoryGroup(this.inventories, view);
    if (!group) return null;
    const previousSelected = group.selected;
    const index = addInventoryItem(this.inventories, category, item);
    if (index === null) return null;
    if (this.activeInventoryCategory === view && previousSelected !== this.inventories[view].selected) this.clearHammerRotation();
    this.saveInventoriesToLocalStorage();
    return index;
  }

  inventoryItemName(category: string, item: InventoryInput | null, index = 0): string {
    return inventoryItemName(category, item, index);
  }

  renameInventoryItem(category: string, index: number, name: unknown): string | null {
    this.inventoryCategory();
    const result = renameInventoryItem(this.inventories, category, index, name);
    if (result !== null) this.saveInventoriesToLocalStorage();
    return result;
  }

  deleteInventoryItem(category: string, index: number): boolean {
    this.inventoryCategory();
    const changed = deleteInventoryItem(this.inventories, category, index);
    if (changed) {
      if (this.activeInventoryCategory === category) this.clearHammerRotation();
      this.saveInventoriesToLocalStorage();
    }
    return changed;
  }

  swapInventorySlots(category: string, fromIndex: number, toIndex: number): boolean {
    this.inventoryCategory();
    const changed = swapInventorySlots(this.inventories, category, fromIndex, toIndex);
    if (changed) {
      if (this.activeInventoryCategory === category) this.clearHammerRotation();
      this.saveInventoriesToLocalStorage();
    }
    return changed;
  }

  inventoryStorage() {
    if (this.persistentStorage) return this.persistentStorage;
    try {
      return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
    } catch (err) {
      return null;
    }
  }

  ensureDefaultColorSet(): boolean {
    this.inventoryCategory();
    return ensureDefaultColorSet(this.inventories);
  }

  saveInventoriesToLocalStorage(storage: BackpackStorage | null = this.inventoryStorage()): boolean {
    return saveBackpack(this.inventories, this.activeInventoryCategory, storage);
  }

  loadInventoriesFromLocalStorage(storage: BackpackStorage | null = this.inventoryStorage()): boolean {
    const result = loadBackpack(storage);
    this.inventories = result.inventories;
    this.activeInventoryCategory = result.activeCategory;
    return result.loaded;
  }

  // --- File import / export (pure, DOM-free) ----------------------------------------

  /** Build the portable object that is encoded into Protobuf storage or transfer. */
  serializeInventoryItem(category: 'entity', item: InventoryInput): import('@entropydrop/space-engine/storage/InventoryTypes.ts').PortableEntity;
  serializeInventoryItem(category: string, item: InventoryInput | null): import('@entropydrop/space-engine/storage/InventoryTypes.ts').PortableResource | null;
  serializeInventoryItem(category: string, item: InventoryInput | null) {
    return serializeInventoryItem(category, item);
  }

  encodeInventoryItem(category: string, item: InventoryInput | null) {
    return encodeInventoryItem(category, item);
  }

  /** Parse one Protobuf resource into a backpack item. Returns { ok, item, error }. */
  parseInventoryImport(input: unknown, category: string) {
    return parseInventoryImport(input, category);
  }

  private finishEntitySlotBuild(slot: PlacementSlot, pose: PlacementPose, preparedBlocks: RuntimeVoxel[] | null = null) {
    const origin = pose?.position?.clone?.()
      || new THREE.Vector3(Number(pose?.position?.x) || 0, Number(pose?.position?.y) || 0, Number(pose?.position?.z) || 0);
    const rotation = pose?.quaternion?.isQuaternion
      ? pose.quaternion.clone().normalize()
      : new THREE.Quaternion();
    const pendingWorldConstraints: NonNullable<InventoryInput['constraints']> = [];
    if (slot.itemWorldConstraints) {
      const worldPose = pose.itemWorldPose || { position: origin, quaternion: rotation };
      slot = { ...slot, constraints: (slot.constraints || []).filter(constraint => {
        if (constraint.bodyA != null) return true;
        const transformed = { ...constraint };
        const axis = new THREE.Vector3().fromArray(constraint.axisA || [0, 0, 1]).normalize();
        const perpendicular = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        transformed.axisA = constraint.axisA || axis.toArray();
        transformed.referenceA = constraint.referenceA || perpendicular.addScaledVector(axis, -perpendicular.dot(axis)).normalize().toArray();
        for (const field of ['anchorA', 'axisA', 'referenceA'] as const) {
          if (!transformed[field]) continue;
          const value = new THREE.Vector3().fromArray(transformed[field]).applyQuaternion(worldPose.quaternion);
          if (field === 'anchorA') value.add(worldPose.position);
          transformed[field] = value.toArray();
        }
        pendingWorldConstraints.push(transformed);
        return false;
      }) };
    }
    const created = this.contraptions.buildFromSlot(slot, origin, null, false, preparedBlocks);
    if (created) {
      // Preview coordinates use `origin + rotation * localPoint`, while a
      // Contraption's root position is its local center. Move that center into
      // the identical world pose before saving.
      created.position.copy(origin).add(created.localCenter.clone().applyQuaternion(rotation));
      created.quaternion.copy(rotation);
      created.updateTransform();
      created.originWorldPos.copy(origin);
      // Defaults for world anchors/reference B depend on the final body pose.
      for (const constraint of pendingWorldConstraints) created.createConstraint(constraint);
      // Placing an independent entity is a completed spawn operation, so it
      // has the same result as pressing global Play: physics is active and all
      // runnable component scripts start, even if the backpack copy was saved
      // with its component code disabled. Component installation intentionally
      // keeps its target stopped and does not pass through this path.
      if (pose.deferStart) return created;
      this.performBasicAction({
        domain: ActionDomain.ENTITY,
        action: 'start-scripts',
        target: { contraption: created }
      });
      this.contraptions.saveEntitiesToStorage?.();
      this.sound?.playBlockPlace?.();
      this.completeHammerPlacement();
      const builtLabel = slot.itemName || slot.name || 'entity';
      this.ui?.showToast?.(`Built [${builtLabel}] (${slot.blockCount} blocks) as running entity #${created.id}`);
    }
    return created;
  }

  /** Place all static geometry and independent Entity trees in one Item frame. */
  private pasteCompositeItem(slot: InventoryInput, installAsComponent = false) {
    const singleEntity = !slot.blockSet && slot.entityList?.length === 1;
    if (installAsComponent && !singleEntity) {
      this.ui?.showToast?.('Component installation requires an item containing one entity and no static blocks');
      return false;
    }
    const pose = this.getInventoryPlacementPose(slot);
    if (!pose) {
      this.ui?.showToast?.('No surface under the crosshair — aim at terrain or an entity to build');
      return false;
    }
    const rotation = pose.quaternion || new THREE.Quaternion();
    const origin = pose.position.clone();
    if (singleEntity && (installAsComponent || pose.targetContraption)) {
      if (!pose.targetContraption) {
        this.ui?.showToast?.('Shift+LMB installs modules — aim directly at a stopped entity component');
        return false;
      }
      if (this.handleRunningEntityInteraction(pose.targetContraption)) return false;
      if (!pose.targetContraption.canEditInternalSelection?.()) {
        this.ui?.showToast?.('Stop the target entity with the Wrench before installing components');
        return false;
      }
      const entity = slot.entityList?.[0];
      if (!entity) return false;
      const entityPose = {
        ...pose,
        position: new THREE.Vector3().fromArray(entity.itemPosition || [0, 0, 0])
          .applyQuaternion(rotation).add(origin),
        quaternion: rotation.clone().multiply(new THREE.Quaternion().fromArray(entity.itemRotation || [0, 0, 0, 1])),
      };
      return entity.blocks.length > BULK_EDIT_THRESHOLD
        ? this.startLargeEntitySlotInstall(entity, entityPose)
        : !!this.finishEntitySlotInstall(entity, entityPose);
    }
    const step = slot.blockSet?.blocks?.some(block => (block.size || 1) === 1) ? 1 : MICRO_SIZE;
    if (slot.blockSet) {
      origin.x = Math.round(origin.x / step) * step;
      origin.z = Math.round(origin.z / step) * step;
      origin.y = Math.ceil((origin.y - 1e-6) / step) * step;
    }
    const blocks = (slot.blockSet?.blocks || []).map(block => {
      const size = block.size || 1;
      const minimum = new THREE.Vector3(block.dx + size / 2, block.dy + size / 2, block.dz + size / 2)
        .applyQuaternion(rotation).addScalar(-size / 2);
      return { ...block, dx: minimum.x, dy: minimum.y, dz: minimum.z };
    });
    let placed = 0;
    const buildEntities = () => {
      const created = [];
      try {
        for (const entity of slot.entityList || []) {
          const position = new THREE.Vector3().fromArray(entity.itemPosition || [0, 0, 0])
            .applyQuaternion(rotation).add(origin);
          const quaternion = rotation.clone().multiply(new THREE.Quaternion().fromArray(entity.itemRotation || [0, 0, 0, 1]));
          const result = this.finishEntitySlotBuild(entity, {
            position, quaternion, itemWorldPose: { position: origin, quaternion: rotation }, deferStart: true,
          });
          if (!result) throw new Error('An Item entity could not be built');
          created.push(result);
        }
      } catch (error) {
        for (const entity of created) this.contraptions.removeContraption(entity, { skipSave: true, skipRemoteDelete: true });
        this.ui?.showToast?.(error instanceof Error ? error.message : 'Item placement failed');
        return false;
      }
      for (const entity of created) this.performBasicAction({
        domain: ActionDomain.ENTITY, action: 'start-scripts', target: { contraption: entity },
      });
      if (created.length) this.contraptions.saveEntitiesToStorage?.();
      this.sound?.playBlockPlace?.();
      if (placed > 0 || created.length > 0) this.completeHammerPlacement();
      this.ui?.showToast?.(`Built [${slot.name || 'Item'}] (${blocks.length} static voxels, ${created.length} entities)`);
      return true;
    };
    if (blocks.length > BULK_EDIT_THRESHOLD) {
      return this.startBulkEditJob({
        label: 'Building item', total: blocks.length,
        step: (index: number) => {
          const changed = this.applyBlockSetVoxel(origin, blocks[index]);
          placed += changed;
          return changed;
        },
        finish: buildEntities,
      });
    }
    for (const block of blocks) placed += this.applyBlockSetVoxel(origin, block);
    return buildEntities();
  }

  private describeComponentInstallFailure(reason: string | undefined) {
    const messages: Record<string, string> = {
      target_entity_missing: 'The target entity is no longer available',
      target_component_missing: 'The targeted component is no longer available',
      target_not_stopped: 'Stop the target entity with the Wrench before installing components',
      empty_entity: 'The selected entity slot is empty',
      invalid_entity_slot: 'The selected entity module is malformed',
      hierarchy_too_deep: 'Installing this module would exceed the 16-level component depth limit',
      too_many_components: `Installing this module would exceed ${MAX_ENTITY_COMPONENTS} components`,
      too_many_blocks: 'Installing this module would exceed the entity voxel limit',
      too_many_constraints: 'Installing this module would exceed the entity constraint limit',
      component_bounds_too_large: `One installed component exceeds ${MAX_ENTITY_BOUNDS} cells per axis`,
      scripts_too_large: 'Installing this module would exceed the entity script size limit',
      invalid_component_ids: 'The module contains invalid or duplicate component ids',
      invalid_component_hierarchy: 'The module component hierarchy is invalid',
      overlapping_blocks: 'The module would overlap existing blocks on the target entity',
      invalid_blocks: 'The module contains invalid voxel data',
      invalid_constraints: 'The module contains invalid internal constraints',
      invalid_scripts: 'The module contains an invalid component script'
    };
    return messages[reason || ''] || `Component installation failed (${reason || 'unknown error'})`;
  }

  private finishEntitySlotInstall(slot: PlacementSlot, pose: PlacementPose, preparedBlocks: RuntimeVoxel[] | null = null) {
    const target = pose?.targetContraption;
    if (!target) return null;
    const parentId = pose?.targetNodeId ?? contraptionRootId(target);
    const placementRotation = pose?.quaternion?.isQuaternion
      ? pose.quaternion
      : new THREE.Quaternion();
    if (this.entitySlotOverlapsTarget(slot, pose.position, placementRotation, target)) {
      this.ui?.showToast?.(this.describeComponentInstallFailure('overlapping_blocks'));
      return null;
    }
    const result = this.contraptions.installSlotAsComponent?.(
      target,
      slot,
      parentId,
      pose.position,
      true,
      preparedBlocks,
      placementRotation
    );
    if (!result?.ok) {
      this.ui?.showToast?.(this.describeComponentInstallFailure(result?.reason));
      return null;
    }
    this.sound?.playAssemblyClack?.();
    this.sound?.playBlockPlace?.();
    this.ui?.notifyContraptionStructureChanged?.(target);
    this.completeHammerPlacement();
    const skipped = result.skippedExternalConstraints > 0
      ? ` · ignored ${result.skippedExternalConstraints} external constraint(s)`
      : '';
    this.ui?.showToast?.(
      `Installed [${slot.name || 'entity'}] as [${result.rootId}] on [${parentId}]${skipped}`
    );
    return result;
  }

  /** Map a large serialized entity slot incrementally; registration stays atomic. */
  private startLargeEntitySlotBuild(slot: PlacementSlot, pose: PlacementPose) {
    const source = [...(slot.blocks || [])];
    const preparedBlocks: any[] = [];
    return this.startBulkEditJob({
      label: 'Building entity',
      total: source.length,
      mutatesWorld: false,
      detail: 'Preparing entity voxels',
      step: (index: number) => {
        const block = source[index];
        preparedBlocks.push({
          localX: block.localX,
          localY: block.localY,
          localZ: block.localZ,
          size: block.size || 1,
          color: block.color,
          materialId: normalizeVoxelMaterialId(block.materialId),
          block: block.block,
          part: block.part,
          entityId: block.entityId ?? inventoryEntityRootId(slot)
        });
        return 1;
      },
      finish: () => this.finishEntitySlotBuild(slot, pose, preparedBlocks)
    });
  }

  /** Prepare a large module incrementally, then merge it in one atomic hierarchy edit. */
  private startLargeEntitySlotInstall(slot: PlacementSlot, pose: PlacementPose) {
    const source = [...(slot.blocks || [])];
    const preparedBlocks: any[] = [];
    return this.startBulkEditJob({
      label: 'Installing component',
      total: source.length,
      mutatesWorld: false,
      detail: 'Preparing component voxels',
      step: (index: number) => {
        const block = source[index];
        preparedBlocks.push({
          localX: block.localX,
          localY: block.localY,
          localZ: block.localZ,
          size: block.size || 1,
          color: block.color,
          materialId: normalizeVoxelMaterialId(block.materialId),
          block: block.block,
          part: block.part,
          entityId: block.entityId ?? inventoryEntityRootId(slot)
        });
        return 1;
      },
      finish: () => this.finishEntitySlotInstall(slot, pose, preparedBlocks)
    });
  }

  /**
   * Hammer left-click: place the current inventory slot at the crosshair.
   * - **Block set** (T copy, STL import): stamps plain world blocks.
   * - **Entity on terrain** (R copy, imported): spawns an independent physics entity.
   * - **Entity on entity**: installs the template under the hit stopped component.
   * - **Shift + entity**: explicitly requests component installation and requires an entity target.
   * - **Color set**: applies its 9 colors to the keyboard palette.
   */
  pasteInventorySlot(installAsComponent = false) {
    if (this.activeTool !== SpecialTool.HAMMER) return false;
    const category = this.activeInventoryCategory;
    const slot = this.getActiveHammerInventoryItem();
    if (!slot) {
      if (this.ui) this.ui.showToast(`${category} slot is empty - copy or import something first`);
      return false;
    }
    if (this.bulkEditJob) {
      this.ui?.showToast?.(`Please wait for ${this.bulkEditJob.label.toLowerCase()} to finish`);
      return false;
    }

    if (category === 'colorset') {
      this.ui?.applyColorSetToPalette?.(slot);
      if (this.ui) {
        this.ui.showToast(`Applied color set "${slot.name || 'unnamed'}" to the keyboard palette`);
      }
      return true;
    }

    if (this.handleRunningEntityInteraction(this.hoveredContraptionHit?.contraption)) return false;

    if (slot.kind === 'item') return this.pasteCompositeItem(slot, installAsComponent);

    if (slot.kind === 'blockset') {
      return this.pasteBlockSet(slot);
    }

    const pose = this.getInventoryPlacementPose(slot);
    if (!pose) {
      if (Array.isArray(slot.blocks) && slot.blocks.length > 0 && this.ui) {
        this.ui.showToast('No surface under the crosshair — aim at terrain or an entity to build');
      }
      return false;
    }

    const shouldInstallAsComponent = Boolean(pose.targetContraption) || installAsComponent;
    const placedSlot = pose.slot || slot;
    if (shouldInstallAsComponent) {
      if (!pose.targetContraption) {
        this.ui?.showToast?.('Shift+LMB installs modules — aim directly at a stopped entity component');
        return false;
      }
      if (this.handleRunningEntityInteraction(pose.targetContraption)) return false;
      if (!pose.targetContraption.canEditInternalSelection?.()) {
        this.ui?.showToast?.('Stop the target entity with the Wrench before installing components');
        return false;
      }
      if (Array.isArray(placedSlot.blocks) && placedSlot.blocks.length > BULK_EDIT_THRESHOLD) {
        return this.startLargeEntitySlotInstall(placedSlot, pose);
      }
      return !!this.finishEntitySlotInstall(placedSlot, pose);
    }

    if (Array.isArray(placedSlot.blocks) && placedSlot.blocks.length > BULK_EDIT_THRESHOLD) {
      return this.startLargeEntitySlotBuild(placedSlot, pose);
    }
    return !!this.finishEntitySlotBuild(placedSlot, pose);
  }

  /**
   * Cycle the active inventory slot of the current backpack category by
   * `direction` (+1 or −1); used when the Hammer is active.
   */
  cycleInventorySlot(direction: number) {
    const count = this.inventorySlots.length;
    this.selectedInventoryIndex = (this.selectedInventoryIndex + direction + count) % count;
    this.ui?.renderInventoryBar?.();
    if (this.ui) {
      const slot = this.inventorySlots[this.selectedInventoryIndex];
      const prefix = `${this.activeInventoryCategory} slot ${this.selectedInventoryIndex + 1}`;
      this.ui.showToast(!slot
        ? `${prefix}: empty`
        : this.activeInventoryCategory === 'colorset'
          ? `${prefix}: ${slot.name || 'unnamed'} (Hammer LMB applies palette)`
          : this.activeInventoryCategory === 'blockset'
            ? `${prefix}: ${slot.name || 'unnamed'} · ${slot.blockCount} voxels (Hammer LMB builds · RMB rotates 90°)`
            : `${prefix}: ${slot.name || 'unnamed'} · ${slot.blockCount} blocks`);
    }
  }

  canPlaceStandardAt(pos: Point3 | null) {
    if (!pos) return false;
    const playerAABB = this.physics.getAABB();
    return !(
      pos.x + 1 > playerAABB.minX && pos.x < playerAABB.maxX &&
      pos.y + 1 > playerAABB.minY && pos.y < playerAABB.maxY &&
      pos.z + 1 > playerAABB.minZ && pos.z < playerAABB.maxZ
    );
  }

  private finishPreparedWorldAssembly(rawBlocks: RuntimeVoxel[], origin: Point3, mode: string, customOptions: ContraptionOptions) {
    if (rawBlocks.length === 0) {
      this.ui?.showToast?.('Selection region is empty (no blocks to assemble)');
      return null;
    }
    const actionResult = this.performBasicAction({
      domain: ActionDomain.SELECTION,
      action: 'assemble',
      mode,
      options: customOptions,
      prepared: { blocks: rawBlocks, origin }
    });
    const contraption = actionResult.entity;
    if (contraption) {
      this.ui?.showToast?.(`${contraption.blocks.length} blocks assembled into a contraption · press C to open the editor`);
      this.openCodeEditorForTarget();
    }
    return contraption || null;
  }

  /** Extract a large world selection incrementally, then atomically create its entity. */
  private startLargeWorldAssembly(mode: string, customOptions: ContraptionOptions = {}) {
    const manager = this.contraptions;
    const finalMode = manager.normalizeAssemblyMode?.(mode);
    if (!finalMode) return false;

    const microCells = Array.isArray(manager.microSelection)
      ? manager.microSelection.map(cell => ({ x: cell.x, y: cell.y, z: cell.z }))
      : null;
    const bounds = manager.getSelectionBounds?.();
    const sparseCells = !microCells && manager.connectedSelection !== null
      ? [...(manager.connectedSelection || [])].map(cell => ({ x: cell.x, y: cell.y, z: cell.z }))
      : null;
    if (!microCells && !bounds) return false;

    const sizeY = bounds ? bounds!.maxY - bounds!.minY + 1 : 0;
    const sizeZ = bounds ? bounds!.maxZ - bounds!.minZ + 1 : 0;
    const scanTotal = microCells?.length
      ?? sparseCells?.length
      ?? ((bounds!.maxX - bounds!.minX + 1) * sizeY * sizeZ);
    const origin = microCells
      ? { x: Infinity, y: Infinity, z: Infinity }
      : { x: bounds!.minX, y: bounds!.minY, z: bounds!.minZ };
    const total = microCells ? scanTotal * 2 : scanTotal;
    const rawBlocks: any[] = [];
    const cellAt = (index: number) => sparseCells?.[index] || {
      x: bounds!.minX + Math.floor(index / (sizeY * sizeZ)),
      y: bounds!.minY + Math.floor(index / sizeZ) % sizeY,
      z: bounds!.minZ + index % sizeZ
    };

    const started = this.startBulkEditJob({
      label: 'Assembling contraption',
      total,
      detail: job => microCells && job.processed < scanTotal
        ? 'Measuring micro selection'
        : 'Extracting selected voxels',
      step: (index: number) => {
        if (microCells) {
          if (index < scanTotal) {
            const cell = microCells[index];
            origin.x = Math.min(origin.x, cell.x / MICRO_DIVISIONS);
            origin.y = Math.min(origin.y, cell.y / MICRO_DIVISIONS);
            origin.z = Math.min(origin.z, cell.z / MICRO_DIVISIONS);
            return 0;
          }
          const cell = microCells[index - scanTotal];
          const wx = Math.floor(cell.x / MICRO_DIVISIONS);
          const wy = Math.floor(cell.y / MICRO_DIVISIONS);
          const wz = Math.floor(cell.z / MICRO_DIVISIONS);
          const existing = this.world.getMicroBlock?.(cell.x, cell.y, cell.z);
          let color = existing?.color;
          let part = null;
          if (existing) {
            const exact = this.world.getMicroBlocksInAABB?.({
              minX: cell.x / MICRO_DIVISIONS,
              minY: cell.y / MICRO_DIVISIONS,
              minZ: cell.z / MICRO_DIVISIONS,
              maxX: cell.x / MICRO_DIVISIONS,
              maxY: cell.y / MICRO_DIVISIONS,
              maxZ: cell.z / MICRO_DIVISIONS
            })?.[0];
            part = exact?.part ?? null;
          } else if (this.world.getBlock?.(wx, wy, wz) !== BlockTypes.AIR) {
            color = this.world.getBlockColor?.(wx, wy, wz);
          }
          if (color === null || color === undefined) return 0;

          let result;
          if (!existing && this.world.getBlock?.(wx, wy, wz) !== BlockTypes.AIR) {
            result = this.performBasicAction({
              domain: ActionDomain.WORLD,
              action: 'subdivide-standard',
              cell: { x: wx, y: wy, z: wz },
              micro: cell
            });
          } else {
            result = this.performBasicAction({
              domain: ActionDomain.WORLD,
              action: 'remove-micro',
              micro: cell
            });
          }
          if (!((result.removed ?? 0) > 0)) return 0;
          rawBlocks.push({
            localX: cell.x / MICRO_DIVISIONS - origin.x,
            localY: cell.y / MICRO_DIVISIONS - origin.y,
            localZ: cell.z / MICRO_DIVISIONS - origin.z,
            size: MICRO_SIZE,
            block: BlockTypes.COLOR_BLOCK,
            color,
            part
          });
          return 1;
        }

        const cell = cellAt(index);
        const block = this.world.getBlock?.(cell.x, cell.y, cell.z);
        const color = block !== BlockTypes.AIR
          ? this.world.getBlockColor?.(cell.x, cell.y, cell.z)
          : null;
        const micros = this.world.getMicroBlocksInAABB?.({
          minX: cell.x,
          minY: cell.y,
          minZ: cell.z,
          maxX: cell.x + 1 - 1e-6,
          maxY: cell.y + 1 - 1e-6,
          maxZ: cell.z + 1 - 1e-6
        }) || [];
        const result = this.performBasicAction({
          domain: ActionDomain.WORLD,
          action: 'clear-cell',
          cell
        });
        if ((result.standard ?? 0) > 0) {
          rawBlocks.push({
            localX: cell.x - origin.x,
            localY: cell.y - origin.y,
            localZ: cell.z - origin.z,
            size: 1,
            block,
            color
          });
        }
        for (const micro of micros) {
          rawBlocks.push({
            localX: micro.x - origin.x,
            localY: micro.y - origin.y,
            localZ: micro.z - origin.z,
            size: micro.size || MICRO_SIZE,
            block: BlockTypes.COLOR_BLOCK,
            color: micro.color,
            part: micro.part
          });
        }
        return result.removed || 0;
      },
      finish: () => this.finishPreparedWorldAssembly(rawBlocks, origin, finalMode, customOptions)
    });
    if (started) manager.clearSelection?.();
    return started;
  }

  assembleSelection(mode = ContraptionMode.PROGRAMMABLE, customOptions = {}) {
    if (this.bulkEditJob) {
      this.ui?.showToast?.(`Please wait for ${this.bulkEditJob.label.toLowerCase()} to finish`);
      return null;
    }
    const hasChildSelection = this.contraptions?.hasChildSelection?.() === true;
    if (!this.requireConfirmedSelection(hasChildSelection ? 'assembling a sub-contraption' : 'assembling')) return null;
    if (hasChildSelection) {
      if (!this.contraptions.hasReadyChildSelection()) {
        if (this.ui) this.ui.showToast('No blocks selected - click to select component blocks');
        return null;
      }
      const selection = this.contraptions.getChildSelectionInfo?.();
      if (selection && (selection.count > BULK_EDIT_THRESHOLD
        || selection.contraption.blocks.length > BULK_EDIT_THRESHOLD)) {
        const started = this.startLargeChildCreation(
          selection.contraption,
          selection.parentId,
          selection.contraption.blocks,
          true,
          selection.cells
        );
        if (started) this.contraptions.clearChildSelection?.();
        return started;
      }
      const actionResult = this.performBasicAction({
        domain: ActionDomain.SELECTION,
        action: 'create-child'
      });
      const result = actionResult.child
        ? { child: actionResult.child, contraption: actionResult.contraption }
        : null;
      if (result && this.ui) {
        this.ui.showToast(`Sub-contraption ${result.child.id} assembled · control it via self.child('${result.child.id}')`);
        this.ui.renderComponentTree();
        this.ui.renderCodeTabs();
        this.ui.updateInspectorProperties(result.child.id);
      }
      return result?.child || null;
    }
    if (this.contraptions.getSelectionBlockCount?.() > BULK_EDIT_THRESHOLD) {
      return this.startLargeWorldAssembly(mode, customOptions);
    }
    const actionResult = this.performBasicAction({
      domain: ActionDomain.SELECTION,
      action: 'assemble',
      mode,
      options: customOptions
    });
    const contraption = actionResult.entity;
    if (contraption && this.ui) {
      this.ui.showToast(`${contraption.blocks.length} blocks assembled into a contraption · press C to open the editor`);
      this.openCodeEditorForTarget();
    }
    return contraption || null;
  }

  toggleDriveVehicle() {
    return this.drivingSession.toggleDriveVehicle();
  }

  get mass(): number {
    return this.physics?.mass ?? PLAYER_MASS_KG;
  }

  get weight(): number {
    return this.physics?.weight ?? PLAYER_MASS_KG * Math.abs(PLAYER_GRAVITY_MPS2);
  }

  setSceneRenderer(sceneRenderer: SceneRenderer) {
    this.sceneRenderer = sceneRenderer;
    this.syncCameraViewVisibility();
  }

  setFov(fov: number) {
    return this.cameraSession.setFov(fov);
  }

  setPerspective(perspective: PlayerPerspective, animate = true) {
    return this.cameraSession.setPerspective(perspective, animate);
  }

  setThirdPersonDistance(dist: number) {
    return this.cameraSession.setThirdPersonDistance(dist);
  }

  togglePerspective() {
    return this.cameraSession.togglePerspective();
  }

  /** Free-look heading stays independent of the mounted body's tilt. */
  get viewYaw(): number {
    return this.cameraSession.viewYaw;
  }

  /** Full solved seat rotation for the avatar; null means normal free-look body yaw. */
  get bodyQuaternion(): THREE.Quaternion | null {
    return this.drivingSession.bodyQuaternion;
  }

  get bodyYaw(): number {
    return quaternionForwardYaw(this.bodyQuaternion, this.viewYaw);
  }

  private getCameraPerspectiveTransition(): CameraPerspectiveTransition {
    return this.cameraSession.getCameraPerspectiveTransition();
  }

  private syncCameraViewVisibility() {
    return this.cameraSession.syncCameraViewVisibility();
  }

  private updateCameraRotation(): THREE.Vector3 {
    return this.cameraSession.updateCameraRotation();
  }

  updateCameraPosition() {
    return this.cameraSession.updateCameraPosition();
  }

  /**
   * Re-seat a mounted player from the vehicle's latest solved transform.
   * Contraption physics runs after PlayerController.update(), so doing this
   * again from the post-physics aim pass prevents the camera from rendering a
   * one-frame-old cockpit pose while a vehicle accelerates or rotates.
   */
  syncDrivenVehiclePose() {
    return this.drivingSession.syncDrivenVehiclePose();
  }

  updateSimulation(dt: number) {
    if (this.isDriving) this.physics.capturePreviousPosition?.();
    if (!this.syncDrivenVehiclePose()) {
      if (this.navigationSystem?.isNavigating) {
        this.navigationSystem.update(dt);
      } else {
        this.physics.update(dt, this.keys, this.viewYaw);
      }
    }

    if (this.wrenchGrab?.active && this.wrenchGrab.contraption) {
      const grab = this.wrenchGrab;
      const contraption = grab.contraption;
      if (this.contraptions?.contraptions && !this.contraptions.contraptions.includes(contraption)) {
        this.releaseWrenchGrab();
      } else {
        const { localPoint, targetDistance, bodyId } = grab;
        const body = contraption.getRigidBody?.(bodyId);
        if (!body || body.type !== BodyType.DYNAMIC || body.simulationEnabled === false) {
          this.releaseWrenchGrab();
        } else {
          const eyePos = this.physics?.getEyePosition ? this.physics.getEyePosition() : this.camera.position.clone();
          const targetPos = this.getWrenchTargetPosition(
            eyePos,
            targetDistance,
            grab.lastTargetPosition,
            grab.targetSpace
          );
          const anchorPos = contraption.entityLocalToWorld
            ? contraption.entityLocalToWorld(bodyId, localPoint.clone())
            : contraption.localToWorld
              ? contraption.localToWorld(localPoint.clone())
              : localPoint.clone().add(contraption.position || new THREE.Vector3());

          this.sceneRenderer?.setWrenchTether?.(eyePos, anchorPos);

          // Treat the wrench as a mass-independent, critically damped velocity
          // servo. Acceleration and speed limits prevent one 20 Hz editor tick
          // from crossing the target and reversing violently on the next tick.
          // Movement still goes through physics sweep/collision checks.
          const safeDt = Math.max(1 / 240, Math.min(0.08, Number(dt) || 0));
          const targetVelocity = targetPos.clone()
            .sub(grab.lastTargetPosition)
            .divideScalar(safeDt);
          if (targetVelocity.length() > WRENCH_GRAB_MAX_TARGET_SPEED) {
            targetVelocity.setLength(WRENCH_GRAB_MAX_TARGET_SPEED);
          }

          const anchorLever = anchorPos.clone().sub(body.position);
          const anchorVelocity = body.velocity.clone()
            .add(body.angularVelocity.clone().cross(anchorLever));
          // Keep response*dt <= 0.4 even for a clamped/stalled frame so the
          // discrete critical-damping update remains non-oscillatory.
          const response = Math.min(WRENCH_GRAB_RESPONSE, 0.4 / safeDt);
          const servoAcceleration = targetPos.clone()
            .sub(anchorPos)
            .multiplyScalar(response * response)
            .add(targetVelocity.clone().sub(anchorVelocity).multiplyScalar(2 * response));
          if (servoAcceleration.length() > WRENCH_GRAB_MAX_ACCELERATION) {
            servoAcceleration.setLength(WRENCH_GRAB_MAX_ACCELERATION);
          }

          const desiredVelocity = body.velocity.clone()
            .addScaledVector(servoAcceleration, safeDt);
          // Gravity is applied after the controller during the three physics
          // substeps. Pre-compensating its expected velocity change prevents a
          // held body from repeatedly sagging and being snapped upward.
          const gravity = this.contraptions?.physics?.gravity;
          if (contraption.getNodeGravityEnabled?.(bodyId) !== false && gravity?.isVector3) {
            // About two thirds of the full-frame velocity change keeps the
            // integrated anchor position fixed; compensating the full change
            // would launch it upward before gravity is accumulated gradually
            // across the three substeps.
            desiredVelocity.addScaledVector(gravity, -safeDt * (2 / 3));
          }
          if (desiredVelocity.length() > WRENCH_GRAB_MAX_SPEED) {
            desiredVelocity.setLength(WRENCH_GRAB_MAX_SPEED);
          }

          const constrained = this.contraptions?.physics?.constrainWrenchVelocity?.(
            contraption,
            body,
            desiredVelocity,
            safeDt,
            this.contraptions?.contraptions
          );
          const collisionSafeVelocity = constrained?.velocity || desiredVelocity;

          body.velocity.copy(collisionSafeVelocity);
          for (const normal of constrained?.normals || []) {
            const inwardSpeed = body.velocity.dot(normal);
            if (inwardSpeed < 0) body.velocity.addScaledVector(normal, -inwardSpeed);
          }
          body.angularVelocity.multiplyScalar(Math.exp(-32 * safeDt));
          grab.lastTargetPosition.copy(targetPos);
        }
      }
    } else {
      this.sceneRenderer?.setWrenchTether?.(null, null);
    }
  }

  updateRender(dt = 0) {
    this.processBulkEditFrame();
    this.getCameraPerspectiveTransition().advance(dt);
    this.updateCameraPosition();
  }

  /** Compatibility one-call form used by focused controller tests. The game
   * loop invokes updateSimulation at 20 Hz and updateRender on every RAF. */
  update(dt: number) {
    this.processBulkEditFrame();
    this.updateSimulation(dt);
    this.getCameraPerspectiveTransition().advance(dt);
    this.updateCameraPosition();
  }

  /**
   * Refresh crosshair picking after all scene kinematics have advanced.
   * Game.animate calls this after ContraptionManager.update so interactions use
   * the latest solved pose before presentation-only interpolation is applied.
   */
  updateAimRaycast() {
    // This pass runs after ContraptionManager.update(), so it is the first
    // point in the frame where the mounted body's final physics pose exists.
    this.syncDrivenVehiclePose();
    this.updateCameraPosition();
    if (this.worldPickingSuspended) return;
    const query = this.performAimRaycast('all');
    this.modeling?.update(query);
    this.currentRaycast = query.worldHit || { hit: false };

    // Entity and terrain candidates are resolved by the shared raycast query,
    // using exact bent triangles for the same deformation rendered by the GPU.
    const contraptionHit = query.entityHit;
    const hovered = query.kind === 'entity' ? contraptionHit?.contraption ?? null : null;
    this.hoveredContraptionHit = hovered ? contraptionHit : null;
    this.updateWrenchPivotGizmo(hovered ? contraptionHit : null);
    if (this.hoveredContraption !== hovered) {
      if (this.hoveredContraption) {
        this.hoveredContraption.setHighlighted(false);
        if (!this.contraptions.hasChildSelection() || this.contraptions.childSelection?.contraption !== this.hoveredContraption) {
          this.hoveredContraption.clearFocusHighlight();
        }
      }
      this.hoveredContraption = hovered;
    }

    if (this.hoveredContraption) {
      if (this.activeTool === SpecialTool.WRENCH || this.activeTool === SpecialTool.MODELING) {
        this.hoveredContraption.setHighlighted(false);
        this.hoveredContraption.clearFocusHighlight();
      } else if (this.activeTool === SpecialTool.BRUSH) {
        this.hoveredContraption.setHighlighted(true);
        this.hoveredContraption.clearFocusHighlight();
      } else if (this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE) {
        // Selector: do NOT highlight parent components (setHighlighted(false)).
        // Only highlight the hovered component and all its subcomponents via setFocusHighlight!
        this.hoveredContraption.setHighlighted(false);
        if (this.hoveredContraptionHit) {
          const hitNodeId = this.hoveredContraptionHit.entityId ?? contraptionRootId(this.hoveredContraption);
          if (!this.contraptions.hasChildSelection() || this.contraptions.childSelection?.contraption !== this.hoveredContraption) {
            this.hoveredContraption.setFocusHighlight(hitNodeId);
          }
        }
      } else {
        this.hoveredContraption.setHighlighted(true);
        if (this.hoveredContraptionHit) {
          const hitNodeId = this.hoveredContraptionHit.entityId ?? contraptionRootId(this.hoveredContraption);
          if (!this.contraptions.hasChildSelection() || this.contraptions.childSelection?.contraption !== this.hoveredContraption) {
            this.hoveredContraption.setFocusHighlight(hitNodeId);
          }
        }
      }
    }

    this.updateMicroCarvePreview();
    this.updateInventoryPlacementPreview();
    this.updateSelectionAxisGizmo();
  }

  /** Query along the current crosshair without changing hover presentation. */
  performAimRaycast(include: 'all' | 'world' | 'entities' = 'all', usePublishedCollision: boolean | undefined = undefined) {
    if (this.worldPickingSuspended) {
      return { kind: null, worldHit: { hit: false }, entityHit: null };
    }
    const eyePos = this.cameraSession.getEyePosition();
    const eyeBent = PlayerController._bentEye.copy(eyePos);
    bendPointForView(eyePos.x, eyePos.y, eyePos.z, eyeBent);
    const forwardFlat = PlayerController._forwardFlat
      .set(0, 0, -1)
      .applyQuaternion(this.camera.quaternion);
    const forwardBent = bendDirection(
      eyePos.x,
      eyePos.y,
      eyePos.z,
      forwardFlat,
      PlayerController._forwardBent,
    );
    return this.performBasicAction({
      domain: ActionDomain.QUERY,
      action: 'raycast',
      origin: eyeBent,
      direction: forwardBent,
      maxDistance: 16,
      space: 'bent',
      include,
      voxelKinds: ['standard', 'micro'],
      usePublishedCollision,
    });
  }

  /**
   * Mouse actions can synchronously change the micro-voxel data under the
   * crosshair between animation frames. Re-pick the currently published view
   * once the action has finished, then update the aim-dependent overlays. If a
   * replacement mesh is still building, the cursor deliberately stays on its
   * old visible cell instead of tunnelling into live-but-unpublished data.
   */
  refreshAimAfterPointerAction() {
    this.updateAimRaycast();
    const cursor = this.getCursorHighlight();
    this.sceneRenderer?.setCursor?.(cursor ? cursor.pos : null, cursor?.size ?? 1, cursor?.quaternion, cursor?.center);
    this.sceneRenderer?.setMicroCarvePreview?.(this.microCarvePreview);
  }

  /**
   * Cursor highlight (block focus box). When hovering over an entity (even a large
   * multi-block entity), it displays the small wireframe for the pointed individual
   * block (or micro-block). When the shovel targets a 0.125 micro voxel, the
   * operation applies to the whole 1x1x1 standard cell, so the outline stays 1x1x1.
   * @returns {null | { pos: {x,y,z}, size: number, quaternion?: any, center?: any, isEntity?: boolean }}
   */
  getCursorHighlight() {
    if (this.worldPickingSuspended) return null;
    if (this.activeTool === SpecialTool.MODELING) return null;
    if (this.hoveredContraptionHit) {
      const hit = this.hoveredContraptionHit;
      const contraption = hit.contraption;
      if (contraption) {
        const nodeId = hit.entityId ?? (typeof contraptionRootId === 'function' ? contraptionRootId(contraption) : (contraption.rootComponentId || 'root'));
        const targetNodeId = hit.block?.entityId || nodeId;
        const focusNode = contraption.entityNodes?.get?.(targetNodeId)
          || contraption.entityNodes?.get?.(nodeId)
          || contraption.entityNodes?.get?.(contraption.rootComponentId);
        focusNode?.group?.updateWorldMatrix?.(true, false);
        const quaternion = focusNode?.group?.getWorldQuaternion?.(new THREE.Quaternion())
          || contraption.quaternion?.clone?.()
          || new THREE.Quaternion();

        const isMicroBlock = hit.kind === 'micro' || (hit.block && (hit.block.size || 1) < 1);
        let size = isMicroBlock ? (hit.block?.size || MICRO_SIZE) : 1;

        if (this.activeTool === SpecialTool.SHOVEL) {
          size = 1;
        } else if (this.activeTool === SpecialTool.BRUSH && this.brushMicroMode) {
          size = MICRO_SIZE;
        } else if ((this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE) && this.selectorMicroMode) {
          size = MICRO_SIZE;
        }

        let center: THREE.Vector3 | null = null;
        if (this.activeTool === SpecialTool.SHOVEL && isMicroBlock && hit.block) {
          const stdCellX = Math.floor(hit.block.localX) + 0.5;
          const stdCellY = Math.floor(hit.block.localY) + 0.5;
          const stdCellZ = Math.floor(hit.block.localZ) + 0.5;
          center = typeof contraption.entityLocalToWorld === 'function'
            ? contraption.entityLocalToWorld(targetNodeId, new THREE.Vector3(stdCellX, stdCellY, stdCellZ))
            : null;
        } else if (size === MICRO_SIZE && !isMicroBlock && hit.placeMicroPos && hit.normal && typeof contraption.entityLocalToWorld === 'function') {
          const localX = (Math.floor((hit.placeMicroPos.localX - (hit.normal.x || 0) * (MICRO_SIZE / 2)) * MICRO_DIVISIONS) + 0.5) / MICRO_DIVISIONS;
          const localY = (Math.floor((hit.placeMicroPos.localY - (hit.normal.y || 0) * (MICRO_SIZE / 2)) * MICRO_DIVISIONS) + 0.5) / MICRO_DIVISIONS;
          const localZ = (Math.floor((hit.placeMicroPos.localZ - (hit.normal.z || 0) * (MICRO_SIZE / 2)) * MICRO_DIVISIONS) + 0.5) / MICRO_DIVISIONS;
          center = contraption.entityLocalToWorld(targetNodeId, new THREE.Vector3(localX, localY, localZ));
        } else if (hit.block && typeof contraption.getBlockWorldCenter === 'function') {
          center = contraption.getBlockWorldCenter(hit.block);
        } else if (hit.cell && typeof contraption.entityLocalToWorld === 'function') {
          center = contraption.entityLocalToWorld(
            targetNodeId,
            new THREE.Vector3(hit.cell.x + size / 2, hit.cell.y + size / 2, hit.cell.z + size / 2)
          );
        } else if (hit.point) {
          center = hit.point.isVector3 ? hit.point.clone() : new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z);
        }

        if (center) {
          const pos = {
            x: center.x - size / 2,
            y: center.y - size / 2,
            z: center.z - size / 2
          };
          return {
            pos,
            center,
            size,
            quaternion,
            isEntity: true,
            contraption,
            nodeId: targetNodeId,
            block: hit.block
          };
        }
      }
    }

    const ray = this.currentRaycast;
    if (!ray || !ray.hit) return null;
    if (this.activeTool === SpecialTool.SHOVEL && ray.kind === 'micro' && ray.microPos) {
      return {
        pos: {
          x: Math.floor(ray.microPos.x / MICRO_DIVISIONS),
          y: Math.floor(ray.microPos.y / MICRO_DIVISIONS),
          z: Math.floor(ray.microPos.z / MICRO_DIVISIONS)
        },
        size: 1
      };
    }
    // Selector micro mode (Tab): highlight the exact 0.125 m cell under the
    // crosshair so the selection granularity is visible while aiming.
    if (this.selectorMicroMode && ray.kind && ray.hitPos) {
      const isSelectorTool = this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE;
      if (isSelectorTool) {
        const cell = this.selectorMicroCellFromRaycast(ray);
        if (cell) {
          return {
            pos: { x: cell.x * MICRO_SIZE, y: cell.y * MICRO_SIZE, z: cell.z * MICRO_SIZE },
            size: MICRO_SIZE
          };
        }
      }
    }
    // Brush micro mode (Tab): highlight the exact 0.125 m cell under the crosshair
    if (this.brushMicroMode && this.activeTool === SpecialTool.BRUSH && ray.kind && ray.hitPos) {
      if (ray.kind === 'micro' && ray.microPos) {
        return {
          pos: { x: ray.microPos.x * MICRO_SIZE, y: ray.microPos.y * MICRO_SIZE, z: ray.microPos.z * MICRO_SIZE },
          size: MICRO_SIZE
        };
      }
      const cell = this.selectorMicroCellFromRaycast(ray);
      if (cell) {
        return {
          pos: { x: cell.x * MICRO_SIZE, y: cell.y * MICRO_SIZE, z: cell.z * MICRO_SIZE },
          size: MICRO_SIZE
        };
      }
    }
    return { pos: ray.hitPos, size: ray.size || 1 };
  }

  /**
   * Compute the spoon 8x8x8 grid focus preview (same hit priority as clicks):
   * entity hit first, then world ray; standard cell shows the full grid,
   * micro hit additionally highlights the current micro cell.
   */
  updateMicroCarvePreview() {
    this.microCarvePreview = null;
    if (this.worldPickingSuspended) return;
    // Spoon: show 8×8 micro-voxel focus grid.
    // Selector (after a level has been selected): show a 1×1×1 outline on hover to help the user
    // aim their first box-selection corner.
    const isSpoon = this.activeTool === SpecialTool.SPOON;
    const isSelectorTool = this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE;
    const selectorActive = isSelectorTool && !!this.selectorRange && !!this.selectorRange.contraption;
    // World 2-point box in progress: cornerA set, cornerB not yet confirmed → live preview.
    const worldBoxPending = isSelectorTool &&
      !!this.contraptions &&
      this.contraptions.selectionCornerA !== null &&
      this.contraptions.selectionCornerB === null;
    const isBrush = this.activeTool === SpecialTool.BRUSH;
    const brushBoxPending = isBrush && !!this.brushSelection;
    this.focusBlockPreview = null;
    this.boxSelectionPreview = null;
    if (!isSpoon && !isSelectorTool && !worldBoxPending && !brushBoxPending && !isBrush) return;

    if (this.hoveredContraptionHit) {
      const hit = this.hoveredContraptionHit;
      const contraption = hit.contraption;
      const nodeId = hit.entityId ?? contraptionRootId(contraption);
      const cellOrigin = hit.cell && typeof contraption.entityLocalToWorld === 'function'
        ? contraption.entityLocalToWorld(
          nodeId,
          new THREE.Vector3(hit.cell.x, hit.cell.y, hit.cell.z)
        )
        : null;
      // Brush on stopped entity: show crosshair cell guide (focusBlockPreview), sized by mode (0.125m micro or 1m standard)
      if (isBrush) {
        if (this.canEditEntityInternals(contraption)) {
          const focusNode = contraption.entityNodes?.get?.(nodeId);
          focusNode?.group?.updateWorldMatrix?.(true, false);
          const focusQuaternion = focusNode?.group
            ?.getWorldQuaternion?.(new THREE.Quaternion()) || new THREE.Quaternion();

          let center: THREE.Vector3 | null = null;
          let cellSize = 1;

          if (this.brushMicroMode) {
            cellSize = MICRO_SIZE;
            if (hit.block && (hit.block.size || 1) < 1 && typeof contraption.getBlockWorldCenter === 'function') {
              center = contraption.getBlockWorldCenter(hit.block);
            } else if (hit.placeMicroPos && hit.normal && typeof contraption.entityLocalToWorld === 'function') {
              const localX = (Math.floor((hit.placeMicroPos.localX - (hit.normal.x || 0) * (MICRO_SIZE / 2)) * MICRO_DIVISIONS) + 0.5) / MICRO_DIVISIONS;
              const localY = (Math.floor((hit.placeMicroPos.localY - (hit.normal.y || 0) * (MICRO_SIZE / 2)) * MICRO_DIVISIONS) + 0.5) / MICRO_DIVISIONS;
              const localZ = (Math.floor((hit.placeMicroPos.localZ - (hit.normal.z || 0) * (MICRO_SIZE / 2)) * MICRO_DIVISIONS) + 0.5) / MICRO_DIVISIONS;
              center = contraption.entityLocalToWorld(nodeId, new THREE.Vector3(localX, localY, localZ));
            } else if (hit.point) {
              center = hit.point.clone();
            }
          } else {
            cellSize = 1;
            if (hit.cell && typeof contraption.entityLocalToWorld === 'function') {
              center = contraption.entityLocalToWorld(
                nodeId,
                new THREE.Vector3(hit.cell.x + 0.5, hit.cell.y + 0.5, hit.cell.z + 0.5)
              );
            } else if (hit.block && typeof contraption.getBlockWorldCenter === 'function') {
              center = contraption.getBlockWorldCenter(hit.block);
            } else if (hit.point) {
              center = hit.point.clone();
            }
          }

          if (center) {
            this.focusBlockPreview = {
              center,
              cellSize,
              active: brushBoxPending,
              quaternion: focusQuaternion
            };
          }

          // Brush 2-point box in progress: hovering an entity shows live preview if in same component
          if (brushBoxPending) {
            if (hit.point && this.brushSelection && this.brushSelection.contraption === contraption && this.brushSelection.nodeId === nodeId) {
              const pointA = this.rangePointToPreviewGrid(this.brushSelection, this.brushSelection.pointA);
              const cursor = this.worldPointToRangePreviewGrid(this.brushSelection, hit.point);
              const frame = this.rangePreviewFrame(this.brushSelection);
              if (pointA && cursor && frame) {
                this.boxSelectionPreview = {
                  pointA,
                  cursor,
                  micro: this.brushSelection.micro === true,
                  frame
                };
                return;
              }
            }
            this.boxSelectionPreview = null;
            this.sceneRenderer?.clearBoxSelectionPreview?.();
          }
        }
        return;
      }
      // World 2-point box in progress: hovering an entity also shows the live preview
      // (clicking the entity surface confirms cornerB, same as clicking world voxels).
      if (worldBoxPending && hit.point) {
        this.boxSelectionPreview = {
          pointA: this.pendingWorldCornerAMeters(),
          cursor: this.selectorMicroMode
            ? this.microMeterPoint(hit.point)
            : {
              x: Math.floor(hit.point.x),
              y: Math.floor(hit.point.y),
              z: Math.floor(hit.point.z)
            },
          micro: this.selectorMicroMode === true
        };
        return;
      }
      // Selector: once a level is active, hovering inside the entity shows the 1×1×1 focus
      // outline. After corner 1 is set (box-selection in progress) the outline turns orange and
      // a live AABB preview is drawn. Range corners are stored in node-local space and converted
      // back to world space here so the preview co-moves with rotating/translating components.
      // Hovering a *different* entity shows nothing (a click there switches the level) — and it
      // must never fall through to the spoon micro-voxel grid.
      if (selectorActive && this.selectorRange) {
        if (this.selectorRange.contraption === contraption) {
          // Reuse the cursor target so the guide matches what the selector will
          // pick: a 0.125 m cell inside a standard block in micro mode, or the
          // whole block in standard mode. Previously a standard block always drew
          // a 1 m guide even in micro mode, which read as a broken selection.
          const cursor = this.getCursorHighlight();
          if (cursor?.center) {
            this.focusBlockPreview = {
              center: cursor.center,
              cellSize: cursor.size ?? 1,
              active: !!this.selectorRange.pointA,
              quaternion: cursor.quaternion || new THREE.Quaternion()
            };
          }
          if (this.selectorRange.pointA && !this.selectorRange.pointB && hit.point) {
            const pointA = this.rangePointToPreviewGrid(this.selectorRange, this.selectorRange.pointA);
            const inwardPoint = this.getInwardEntityPoint(hit);
            const cursor = this.worldPointToRangePreviewGrid(this.selectorRange, inwardPoint);
            const frame = this.rangePreviewFrame(this.selectorRange);
            if (pointA && cursor && frame) {
              this.boxSelectionPreview = {
                pointA,
                cursor,
                micro: this.selectorMicroMode === true,
                frame
              };
            }
          }
        }
        return;
      }
      // Only the spoon renders the 8×8 micro-voxel grid.
      if (!isSpoon) return;
      const focusNode = contraption.entityNodes?.get?.(nodeId);
      focusNode?.group?.updateWorldMatrix?.(true, false);
      const quaternion = focusNode?.group
        ?.getWorldQuaternion?.(new THREE.Quaternion()) || new THREE.Quaternion();
      let microCenter = null;
      if (hit.kind === 'micro' && hit.block) {
        microCenter = contraption.getBlockWorldCenter(hit.block);
      }
      this.microCarvePreview = { cellOrigin, microCenter, quaternion };
      return;
    }

    // Selector (world hit): corner 1 is set — show live AABB preview (re-project corner 1 from
    // node-local to current world space so it follows component movement).
    if (isSelectorTool && this.selectorRange && this.selectorRange.pointA && !this.selectorRange.pointB && this.currentRaycast && this.currentRaycast.hit) {
      const pointA = this.rangePointToPreviewGrid(this.selectorRange, this.selectorRange.pointA);
      if (pointA) {
        // Cursor must use the same quantization the click applies: in micro mode
        // the corner snaps to the 0.125 m surface cell under the crosshair, not to
        // the whole standard cell (hitPos).
        const microCell = this.selectorMicroMode ? this.selectorMicroCellFromRaycast() : null;
        const cursorWorld = microCell
          ? new THREE.Vector3(microCell.x / MICRO_DIVISIONS, microCell.y / MICRO_DIVISIONS, microCell.z / MICRO_DIVISIONS)
          : new THREE.Vector3(this.currentRaycast.hitPos.x, this.currentRaycast.hitPos.y, this.currentRaycast.hitPos.z);
        const cursor = this.worldPointToRangePreviewGrid(this.selectorRange, cursorWorld);
        const frame = this.rangePreviewFrame(this.selectorRange);
        if (cursor && frame) {
          this.boxSelectionPreview = {
            pointA,
            cursor,
            micro: this.selectorMicroMode === true,
            frame
          };
        }
      }
      return;
    }
    // World 2-point box (cornerA/B): cornerA set, cornerB not yet confirmed → rubber-band
    // preview follows the crosshair. A second click on any voxel or entity surface finalises it.
    if (worldBoxPending && this.currentRaycast && this.currentRaycast.hit) {
      const hp = this.currentRaycast.hitPos;
      const microC = this.selectorMicroMode ? this.selectorMicroCellFromRaycast() : null;
      this.boxSelectionPreview = {
        pointA: this.pendingWorldCornerAMeters(),
        cursor: microC
          ? { x: microC.x / MICRO_DIVISIONS, y: microC.y / MICRO_DIVISIONS, z: microC.z / MICRO_DIVISIONS }
          : { x: Math.floor(hp.x), y: Math.floor(hp.y), z: Math.floor(hp.z) },
        micro: this.selectorMicroMode === true
      };
      return;
    }
    // Brush 2-point box is entity-component only; hovering world terrain clears preview
    if (brushBoxPending) {
      this.boxSelectionPreview = null;
      this.sceneRenderer?.clearBoxSelectionPreview?.();
      return;
    }
    // World hit: only the Spoon shows the micro-voxel grid. The Selector already has its own
    // block cursor overlay so we skip the grid to avoid duplication.
    if (!isSpoon) return;
    const ray = this.currentRaycast;
    if (!ray || !ray.hit) return;
    if (ray.kind === 'micro') {
      const mp = ray.microPos;
      this.microCarvePreview = {
        cellOrigin: new THREE.Vector3(
          Math.floor(mp.x / MICRO_DIVISIONS),
          Math.floor(mp.y / MICRO_DIVISIONS),
          Math.floor(mp.z / MICRO_DIVISIONS)
        ),
        microCenter: isSpoon
          ? new THREE.Vector3((mp.x + 0.5) * MICRO_SIZE, (mp.y + 0.5) * MICRO_SIZE, (mp.z + 0.5) * MICRO_SIZE)
          : null,
        quaternion: new THREE.Quaternion()
      };
    } else {
      this.microCarvePreview = {
        cellOrigin: new THREE.Vector3(ray.hitPos.x, ray.hitPos.y, ray.hitPos.z),
        microCenter: null,
        quaternion: new THREE.Quaternion()
      };
    }
  }

  getEntitySelectionBounds(blocks: RuntimeVoxel[], isMicro = false) {
    return selectionGeometry.getEntitySelectionBounds(blocks, isMicro);
  }

  expandEntitySelectionAxis(axis: 'x' | 'y' | 'z', direction: 1 | -1, steps: number, isMicro = false) {
    return this.selectionSession.expandEntitySelectionAxis(axis, direction, steps, isMicro);
  }

  updateSelectionAxisGizmo() {
    return this.selectionSession.updateSelectionAxisGizmo();
  }

  updateSelectionGizmoPointerHover(e: MouseEvent) {
    return this.selectionSession.updateSelectionGizmoPointerHover(e);
  }

  startGizmoDrag(hit: SelectionGizmoHandle | null, e: MouseEvent | null = null) {
    return this.selectionSession.startGizmoDrag(hit, e);
  }

  updateGizmoDrag(e: MouseEvent) {
    return this.selectionSession.updateGizmoDrag(e);
  }

  releaseGizmoDrag() {
    return this.selectionSession.releaseGizmoDrag();
  }
}

(PlayerController.prototype as any)._selectorShape = 'box';
