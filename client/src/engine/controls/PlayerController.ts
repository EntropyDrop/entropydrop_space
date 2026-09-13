import { MICRO_DIVISIONS, MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import * as THREE from 'three';
import { MAX_INVENTORY_NAME_LENGTH, trimInventoryName, inventoryNameLength, truncateInventoryName } from '@entropydrop/space-engine/storage/InventoryName.ts';
import { BlockTypes, colorToHex, normalizeColor, PRESET_COLORS } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import {
  BodyType,
  ContraptionMode,
  isValidComponentId,
  isValidConstraintId,
  MAX_ENTITY_BOUNDS,
  MAX_ENTITY_COMPONENTS
} from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ActionDomain, executeBasicAction } from '@entropydrop/space-engine/actions/BasicActions.ts';
import {
  bendPoint, bendDirection, unbendPoint, unwrapPeriodicNear,
  TORUS_GREF, TORUS_SIZE_X, TORUS_SIZE_Z, TORUS_SPAWN_X, TORUS_SPAWN_Z,
  wrapMicroX, wrapMicroZ
} from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { calculatePreviewDragForce, getInventoryPreviewBlocks } from '../render/SceneRenderer.ts';
import { InventoryThumbnailRenderer } from '../render/InventoryThumbnailRenderer.ts';
import type { SpaceStorage } from '../storage/BrowserStorage.ts';
import { type SelectorShape, computeSelectionCells } from './SelectorShapes.ts';
import {
  decodeBackpack,
  decodeInventoryResource,
  encodeBackpack,
  encodeInventoryResource,
  MAX_BACKPACK_SLOTS_PER_CATEGORY,
  portableEntityToRuntime,
  protobufFromBase64,
  protobufToBase64,
  runtimeEntityToPortable,
  type InventoryKind,
  type PortableBackpack,
} from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';
import { PLAYER_GRAVITY_MPS2, PLAYER_MASS_KG } from '@entropydrop/space-engine/physics/PlayerPhysics.ts';
import { CHUNK_SIZE_Y } from '@entropydrop/space-engine/voxel/Chunk.ts';

// Global editor/game commands stay engine-owned and are not exposed to entity
// programs, avoiding collisions between scripts and C/V/tool shortcuts.
export const RESERVED_ENTITY_INPUT_CODES = new Set([
  'Escape',
  'Backspace', 'Delete',
  'F3', 'F5',
  'KeyC', 'KeyE', 'KeyF', 'KeyG', 'KeyR', 'KeyV',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'
]);

export function isPerspectiveToggleCode(code: string) {
  return code === 'F3' || code === 'F5';
}

export type PlayerPerspective = 'first_person' | 'third_person' | 'third_person_front';

const HEX_COLOR = /^#?[0-9a-f]{6}$/i;

const INVENTORY_STORAGE_KEY = 'space.backpack.v8.pb';
const INVENTORY_CATEGORIES = ['blockset', 'entity', 'colorset'];
const DEFAULT_COLOR_SET_NAME = 'Default palette';
export const MAX_INVENTORY_IMPORT_BYTES = 8 * 1024 * 1024;
export const MAX_INVENTORY_BLOCKS = 65_536;
export const MAX_INVENTORY_SCRIPT_BYTES = 64 * 1024;
export const MAX_INVENTORY_TOTAL_SCRIPT_BYTES = 512 * 1024;
const MAX_INVENTORY_CONSTRAINTS = 256;
const MAX_IMPORT_COORDINATE = MAX_ENTITY_BOUNDS * 2;
const MAX_PORTABLE_VECTOR_COMPONENT = 256;
const MAX_PORTABLE_BODY_MASS = 1e12;
const MAX_PORTABLE_CONSTRAINT_VALUE = 10_000;
export const BULK_EDIT_THRESHOLD = 256;
export const BULK_EDIT_MAX_OPERATIONS_PER_FRAME = 1024;
export const BULK_EDIT_FRAME_BUDGET_MS = 5;
/**
 * Upper bound on the number of virtual 0.125 m cells a single micro-mode entity
 * selection may synthesize. Keeps very large micro boxes a safe no-op with a
 * warning instead of allocating millions of descriptors.
 */
export const MAX_MICRO_SELECTION_CELLS = 16384;
/**
 * Upper bound on how many 1 m blocks one Del/F/P/G may convert into 0.125 m
 * voxels. Each conversion adds 512 voxels and the engine rebuild is the dominant
 * cost, so oversized edits are refused with a warning instead of freezing.
 */
export const MAX_MICRO_MATERIALIZE_BLOCKS = 32;
const ENTITY_PLACEMENT_MAX_DROP = 48;
const ENTITY_PLACEMENT_SUPPORT_BINS = 12;
const ENTITY_PLACEMENT_SUPPORT_SAMPLE_LIMIT = 256;
const ENTITY_PLACEMENT_EPSILON = 1e-5;
const ENTITY_TARGET_PLACEMENT_MAX_OUTWARD_STEPS = MAX_ENTITY_BOUNDS * MICRO_DIVISIONS;
const ENTITY_TARGET_PLACEMENT_BUCKET_SIZE = 2;
const STOPPED_GRID_EPSILON = 1e-6;
// Wrench grabbing is a mass-independent editor servo. Its previous 36/s
// position gain could request nearly 30 m/s in one 20 Hz tick, overshoot the
// target, then reverse just as hard on the next tick. A bounded critically
// damped controller preserves heavy-body handling without that oscillation.
const WRENCH_GRAB_RESPONSE = 8;
const WRENCH_GRAB_MAX_ACCELERATION = 36;
const WRENCH_GRAB_MAX_TARGET_SPEED = 10;
const WRENCH_GRAB_MAX_SPEED = 14;

// A seat may pin the view yaw to the vehicle. The player keeps a small bounded
// head-look arc so the cockpit still feels alive without letting them stare at
// the world while the chassis swings underneath.
const SEAT_LOOK_YAW_LIMIT = 0.6;

/** Yaw of a rotation whose forward axis is -Z, using the camera's YXZ order. */
function quaternionForwardYaw(quaternion: any): number {
  if (!quaternion?.isQuaternion) return 0;
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
  const planar = Math.hypot(forward.x, forward.z);
  return planar < 1e-6 ? 0 : Math.atan2(-forward.x, -forward.z);
}

function contraptionRootId(contraption: any): string {
  const explicit = contraption?.rootComponentId;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  for (const node of contraption?.entityNodes?.values?.() || []) {
    if (node?.parentId === null && typeof node.id === 'string' && node.id.length > 0) return node.id;
  }
  return '';
}

function contraptionBlockOwnerId(contraption: any, block: any): string {
  return block?.entityId === undefined || block?.entityId === null
    ? contraptionRootId(contraption)
    : String(block.entityId);
}

function inventoryEntityRootId(item: any): string {
  if (typeof item?.rootComponentId === 'string' && item.rootComponentId) return item.rootComponentId;
  const definitions = Array.isArray(item?.childEntities) ? item.childEntities : [];
  const childIds = new Set(definitions.map(definition => String(definition?.id ?? '')));
  const candidates = new Set<string>();
  for (const block of item?.blocks || []) {
    const owner = block?.entityId;
    if (typeof owner === 'string' && owner && !childIds.has(owner)) candidates.add(owner);
  }
  for (const definition of definitions) {
    const parentId = definition?.parentId;
    if (typeof parentId === 'string' && parentId && !childIds.has(parentId)) candidates.add(parentId);
  }
  return candidates.size === 1 ? [...candidates][0] : '';
}

type EntityPlacementEntry = { center: THREE.Vector3; size: number };
type EntityPlacementObb = {
  center: THREE.Vector3;
  axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  halfExtents: [number, number, number];
  min: THREE.Vector3;
  max: THREE.Vector3;
};

function isStoppedGridQuaternion(value): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length !== 4) return false;
  const components = value.map(Number);
  if (!components.every(Number.isFinite)) return false;
  const quaternion = new THREE.Quaternion(
    components[0], components[1], components[2], components[3]
  );
  if (quaternion.lengthSq() <= 1e-12) return false;
  quaternion.normalize();
  return [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1)
  ].every(axis => axis.applyQuaternion(quaternion).toArray().every(component => (
    Math.abs(component - Math.round(component)) <= STOPPED_GRID_EPSILON
    && Math.abs(Math.round(component)) <= 1
  )));
}

function validateStoppedEntityGrid(slot): string | null {
  if (!isStoppedGridQuaternion(slot?.anchorRotation)) {
    return 'Root anchor rotation must be one of the 24 axis-aligned 90-degree rotations';
  }
  for (const definition of slot?.childEntities || []) {
    if (!isStoppedGridQuaternion(definition?.localRotation)) {
      return `Component ${String(definition?.id || '')} local rotation must use 90-degree grid steps`;
    }
    if (!isStoppedGridQuaternion(definition?.anchorRotation)) {
      return `Component ${String(definition?.id || '')} anchor rotation must use 90-degree grid steps`;
    }
  }

  const entries = getInventoryPreviewBlocks({ ...slot, kind: 'entity' });
  if (entries.length !== (slot?.blocks || []).length) {
    return 'Stopped entity hierarchy does not resolve every voxel';
  }
  type GridBox = [number, number, number, number, number, number];
  const buckets = new Map<string, GridBox[]>();
  for (const entry of entries) {
    const size = Number(entry?.size) || 1;
    const bounds = [
      (Number(entry?.center?.x) - size / 2) * MICRO_DIVISIONS,
      (Number(entry?.center?.y) - size / 2) * MICRO_DIVISIONS,
      (Number(entry?.center?.z) - size / 2) * MICRO_DIVISIONS,
      (Number(entry?.center?.x) + size / 2) * MICRO_DIVISIONS,
      (Number(entry?.center?.y) + size / 2) * MICRO_DIVISIONS,
      (Number(entry?.center?.z) + size / 2) * MICRO_DIVISIONS
    ];
    const box = bounds.map(Math.round) as GridBox;
    if (bounds.some((value, index) => (
      !Number.isFinite(value) || Math.abs(value - box[index]) > STOPPED_GRID_EPSILON
    ))) {
      return 'Stopped entity voxels must align to the 0.125-unit construction grid';
    }
    const [minX, minY, minZ, maxX, maxY, maxZ] = box;
    const keys: string[] = [];
    for (let x = Math.floor(minX / MICRO_DIVISIONS); x <= Math.floor((maxX - 1) / MICRO_DIVISIONS); x++) {
      for (let y = Math.floor(minY / MICRO_DIVISIONS); y <= Math.floor((maxY - 1) / MICRO_DIVISIONS); y++) {
        for (let z = Math.floor(minZ / MICRO_DIVISIONS); z <= Math.floor((maxZ - 1) / MICRO_DIVISIONS); z++) {
          keys.push(`${x},${y},${z}`);
        }
      }
    }
    for (const key of keys) {
      for (const other of buckets.get(key) || []) {
        if (minX < other[3] && maxX > other[0]
          && minY < other[4] && maxY > other[1]
          && minZ < other[5] && maxZ > other[2]) {
          return 'Stopped entity components contain overlapping voxels';
        }
      }
    }
    for (const key of keys) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(box);
      else buckets.set(key, [box]);
    }
  }
  return null;
}

type EntityPlacementShape = {
  blocksRef: any[];
  childEntitiesRef: any;
  entries: EntityPlacementEntry[];
  supportSamples: Array<{ x: number; z: number; bottom: number }>;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  centerX: number;
  centerZ: number;
};

const entityPlacementShapeCache = new WeakMap<object, EntityPlacementShape>();
const entityPlacementTargetObbCache = new WeakMap<object, {
  poseSignature: string;
  entriesRef: any;
  boxes: EntityPlacementObb[];
  buckets: Map<string, EntityPlacementObb[]>;
}>();

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

export const SpecialTool = {
  SHOVEL: 'shovel',         // 1. Shovel (remove / place 1x1x1 standard blocks)
  SPOON: 'spoon',           // 2. Spoon (carve 8x8x8 micro voxels)
  SELECTOR: 'selector',     // 3. Selector (world/component selection and copy)
  HAMMER: 'hammer',         // 4. Hammer (preview/place inventory items)
  WRENCH: 'wrench',         // 5. Wrench (show pivot XYZ, hold to grab, right start/stop)
  BRUSH: 'brush',           // 6. Brush (repaint block colors)
  PIPETTE: 'pipette',       // Legacy alias; color sampling is part of Brush
  SUPER_GLUE: 'selector'    // alias for backwards compatibility
};

export class PlayerController {
  // Reusable temporary vectors for torus-world aiming.
  static _bentEye = new THREE.Vector3();
  static _forwardFlat = new THREE.Vector3();
  static _forwardBent = new THREE.Vector3();

  // --- Injected engine dependencies ---
  camera: any;
  physics: any;
  world: any;
  sound: any;
  particles: any;
  contraptions: any;
  ui: any;

  // --- Pointer lock state ---
  isLocked: boolean;
  pointerLockDesired: boolean;
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

  // --- Entity (program) keyboard input, sampled once by the engine ---
  entityInputDown: Set<string>;
  entityInputPressed: Set<string>;
  entityInputReleased: Set<string>;

  // --- Camera angles (Euler YXZ) ---
  pitch: number;
  yaw: number;

  // --- Selected item / cursor state ---
  _activeTool: string;
  toolUseSequence = 0;
  get activeTool(): string {
    return this._activeTool;
  }
  set activeTool(tool: string) {
    const prev = this._activeTool;
    if (prev === tool) return;
    // Hammer rotation is a placement-only pose. Leaving (or entering) a tool
    // must never carry that pose into a later Hammer session.
    this.clearHammerRotation();
    if ((prev === SpecialTool.SELECTOR || prev === SpecialTool.SUPER_GLUE) &&
        (tool !== SpecialTool.SELECTOR && tool !== SpecialTool.SUPER_GLUE)) {
      this.clearSelection();
    }
    if (tool === SpecialTool.BRUSH) {
      this.hoveredContraption?.clearFocusHighlight?.();
    }
    if (prev === SpecialTool.BRUSH && tool !== SpecialTool.BRUSH) {
      this.clearBrushSelection();
    }
    if (prev === SpecialTool.WRENCH && tool !== SpecialTool.WRENCH) {
      this.releaseWrenchGrab();
      this.clearWrenchPivotDisplay();
    }
    this._activeTool = tool;
  }
  selectedBlock: number;
  selectedColor: number;
  currentRaycast: any;
  hoveredContraption: any;
  hoveredContraptionHit: any;
  wrenchGrab: any;
  wrenchPivotTarget: any;
  microCarvePreview: any;
  focusBlockPreview: any;
  boxSelectionPreview: any;
  inventoryPlacementPreview: any;
  hoveredGizmoHandle: any;
  activeGizmoDrag: any;
  private selectionGizmoRaycaster: THREE.Raycaster | null = null;

  // --- Entity/component selector + inventory clipboard ---
  selectedSubtree: any;
  selectedBlockSelection: any;
  selectorLevel: any;
  selectorRange: any;
  selectorMicroMode: boolean;
  private _selectorShape: SelectorShape = 'box';
  get selectorShape(): SelectorShape {
    return this._selectorShape || 'box';
  }
  set selectorShape(val: SelectorShape) {
    this._selectorShape = val;
  }
  selectionShapeAnchor: {
    cornerA: { x: number; y: number; z: number };
    cornerB: { x: number; y: number; z: number } | null;
    micro: boolean;
    cylinderAxis?: 'x' | 'y' | 'z';
    stairsAxis?: 'x' | 'z';
  } | null = null;
  brushMicroMode: boolean;
  brushSelection: any;
  inventories: any;
  activeInventoryCategory: string;
  hammerRotationTurnsY: number;
  hammerRotationTurnsX: number;
  get hammerRotationTurns(): number {
    return this.hammerRotationTurnsY;
  }
  set hammerRotationTurns(val: number) {
    this.hammerRotationTurnsY = val;
  }
  private hammerRotatedSlotSource: any;
  private hammerRotatedSlotTurnsKey: string | null;
  get hammerRotatedSlotTurns(): number {
    return this.hammerRotationTurnsY;
  }
  set hammerRotatedSlotTurns(val: number) {
    this.hammerRotationTurnsY = val;
  }
  private hammerRotatedSlotCache: any;
  persistentStorage: SpaceStorage | null;
  bulkEditJob: BulkEditJob | null;
  serverEntityRunStateHandler: ((contraption: any, state: 'running' | 'stopped') => Promise<any>) | null;

  // --- Camera / View Settings ---
  sceneRenderer: any;
  fov: number;
  perspective: PlayerPerspective;
  thirdPersonDistance: number;

  // --- Driving state ---
  isDriving: boolean;
  drivenContraption: any;
  drivenSeat: { componentId: string; seatIndex: number } | null;
  /** True while the occupied seat drives the view yaw instead of free mouse look. */
  drivenSeatLocksYaw: boolean;
  /** Player yaw offset from the seat forward, clamped while the seat locks yaw. */
  seatLookYaw: number;
  navigationSystem: any;

  constructor(
    camera,
    physics,
    world,
    soundManager,
    particleSystem,
    contraptionManager,
    uiBridge,
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
    this.activeTool = SpecialTool.SHOVEL;
    this.selectedBlock = BlockTypes.COLOR_BLOCK;
    this.selectedColor = 0xf2a93b;
    this.currentRaycast = { hit: false };
    this.hoveredContraption = null;
    this.hoveredContraptionHit = null;
    this.wrenchGrab = null;
    this.wrenchPivotTarget = null;
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
    this._selectorShape = 'box';
    this.selectionShapeAnchor = null;
    this.brushMicroMode = false;
    this.brushSelection = null;
    // The backpack holds three categories of at most 9 items each:
    // - blockset: plain voxel stamps (T copy, STL import), built with the Hammer
    // - entity: full component trees with scripts (R copy), built with the Hammer
    // - colorset: named sets of 9 palette colors, applied to the keyboard palette
    this.inventories = this.createEmptyInventories();
    this.activeInventoryCategory = 'blockset';
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
    this.drivenSeatLocksYaw = false;
    this.seatLookYaw = 0;

    this.setupPointerLock();
    this.setupEventListeners();
  }

  setupPointerLock() {
    const domElement = document.body;

    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === domElement;
      this.applyPointerLockState(locked);
      if (!locked) {
        this.pointerLockDesired = false;
        this.resetEntityInputState();
        this.releaseWrenchGrab();
        this.clearWrenchPivotDisplay();
      }

      // A pending request may finish after a modal has already called
      // unlock(). Never let that stale request hide the cursor again.
      if (locked && !this.pointerLockDesired && document.exitPointerLock) {
        try { document.exitPointerLock(); } catch (e) {}
      }
    });

    document.addEventListener('pointerlockerror', () => {
      this.pointerLockDesired = false;
      this.syncPointerLockState();
      console.warn('Pointer lock error');
    });
  }

  applyPointerLockState(locked) {
    this.isLocked = !!locked;
    if (this.ui) this.ui.setPointerLocked?.(this.isLocked);
    return this.isLocked;
  }

  syncPointerLockState() {
    return this.applyPointerLockState(typeof document !== 'undefined' && document.pointerLockElement === document.body);
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
            try { document.exitPointerLock?.(); } catch (e) {}
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
    this.resetEntityInputState();
    if (typeof document !== 'undefined' && document.exitPointerLock && document.pointerLockElement) {
      try { document.exitPointerLock(); } catch (e) {}
    } else {
      this.syncPointerLockState();
    }
  }

  setupEventListeners() {
    // Mouse Look
    document.addEventListener('mousemove', (e) => {
      if (this.activeGizmoDrag) {
        this.updateGizmoDrag(e);
        return;
      }
      if (!this.isLocked) {
        if (this.activeTool === SpecialTool.SELECTOR) {
          this.updateSelectionGizmoPointerHover(e);
        }
        return;
      }

      // A yaw-locking seat owns the view direction: horizontal mouse motion
      // only trims a bounded head-look arc inside the cockpit, while vertical
      // motion stays free.
      if (this.drivenSeatLocksYaw && this.isDriving) {
        this.seatLookYaw = Math.max(
          -SEAT_LOOK_YAW_LIMIT,
          Math.min(SEAT_LOOK_YAW_LIMIT, this.seatLookYaw - e.movementX * this.mouseSensitivity)
        );
      } else {
        this.yaw -= e.movementX * this.mouseSensitivity;
      }
      this.pitch -= e.movementY * this.mouseSensitivity;

      const maxPitch = Math.PI / 2 - 0.01;
      this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch));

      this.camera.rotation.set(this.pitch, this.viewYaw, 0, 'YXZ');
    });

    document.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;
      this.releaseWrenchGrab();
      this.releaseGizmoDrag();
    });

    // Mouse Clicks
    document.addEventListener('mousedown', (e) => {
      if (!this.isLocked) {
        if (this.activeTool === SpecialTool.SELECTOR && e.button === 0 && this.hoveredGizmoHandle) {
          e.preventDefault();
          e.stopPropagation();
          this.startGizmoDrag(this.hoveredGizmoHandle, e);
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
      this.resetEntityInputState();
      this.releaseWrenchGrab();
      this.clearWrenchPivotDisplay();
    });

    document.addEventListener('wheel', (e) => {
      this.handleWheel(e);
    });
  }

  handleKeyDown(e: KeyboardEvent) {
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

      case 'Delete': // Del key: delete the selected entity/component or selected blocks
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
    }
  }

  handleWheel(e: { deltaY: number; shiftKey?: boolean }) {
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

  setHotbarSlot(index) {
    if (this.ui?.selectHotbarSlot) {
      this.ui.selectHotbarSlot(index);
    }
  }

  /** Switch tools from an interaction flow such as a successful selection copy. */
  activateTool(tool) {
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
  performBasicAction(command) {
    return executeBasicAction(
      { world: this.world, manager: this.contraptions, selectionHost: this },
      { actor: { source: 'player' }, ...command }
    );
  }

  clearSelection() {
    this.selectedSubtree?.contraption?.clearSubtreeHighlight?.();
    this.selectedBlockSelection?.contraption?.clearSubtreeHighlight?.();
    const result = this.performBasicAction({ domain: ActionDomain.SELECTION, action: 'clear' });
    this.selectedSubtree = null;
    this.selectedBlockSelection = null;
    this.selectorLevel = null;
    this.selectorRange = null;
    this.selectionShapeAnchor = null;
    this.hoveredGizmoHandle = null;
    this.releaseGizmoDrag();
    this.clearBrushSelection();
    this.boxSelectionPreview = null;
    this.focusBlockPreview = null;
    this.sceneRenderer?.clearBoxSelectionPreview?.();
    this.sceneRenderer?.clearFocusBlockGuide?.();
    this.sceneRenderer?.clearSelectionAxisGizmo?.();
    if (this.sceneRenderer && this.contraptions) {
      this.sceneRenderer.updateSelectionHologram(null, null, null);
    }
    return result;
  }

  clearBrushSelection() {
    this.brushSelection = null;
    if (this.activeTool === SpecialTool.BRUSH) {
      this.boxSelectionPreview = null;
      this.sceneRenderer?.clearBoxSelectionPreview?.();
      this.hoveredContraption?.clearFocusHighlight?.();
    }
  }

  recordEntityKeyDown(code) {
    if (!code || RESERVED_ENTITY_INPUT_CODES.has(code)) return false;
    if (!this.entityInputDown.has(code)) {
      this.entityInputPressed.add(code);
    }
    this.entityInputDown.add(code);
    return true;
  }

  recordEntityKeyUp(code) {
    if (!code || RESERVED_ENTITY_INPUT_CODES.has(code)) return false;
    if (this.entityInputDown.delete(code)) {
      this.entityInputReleased.add(code);
    }
    return true;
  }

  consumeEntityInputFrame() {
    const frame = Object.freeze({
      down: Object.freeze([...this.entityInputDown]),
      pressed: Object.freeze([...this.entityInputPressed]),
      released: Object.freeze([...this.entityInputReleased])
    });
    this.entityInputPressed.clear();
    this.entityInputReleased.clear();
    return frame;
  }

  resetEntityInputState() {
    this.entityInputDown?.clear();
    this.entityInputPressed?.clear();
    this.entityInputReleased?.clear();
  }

  openCodeEditorForTarget() {
    const target = this.hoveredContraption;
    if (!target || !this.contraptions.contraptions.includes(target)) {
      if (this.ui) this.ui.showToast(`Point directly at an assembled entity to program it.`);
      return false;
    }
    if (target.serverManaged === true && target.serverCanEdit !== true) {
      this.ui?.showToast?.('Only this entity’s owner can edit it');
      return false;
    }

    this.contraptions.activeProgrammingContraption = target;
    if (this.ui) this.ui.openCodeEditor(target);
    return true;
  }

  handleLeftClick(e = null) {
    if (this.bulkEditJob) {
      this.ui?.showToast?.(`Please wait for ${this.bulkEditJob.label.toLowerCase()} to finish`);
      return false;
    }
    // Count accepted game clicks, including swings into empty space. DOM/UI
    // clicks never reach this method unless the game owns pointer lock.
    this.toolUseSequence = (this.toolUseSequence || 0) + 1;
    // Selector XYZ coordinate axis gizmo dragging
    if (this.activeTool === SpecialTool.SELECTOR && this.hoveredGizmoHandle) {
      this.startGizmoDrag(this.hoveredGizmoHandle, e);
      return;
    }

    // Hammer owns inventory construction. Selection never places inventory
    // contents, so copying and building remain distinct tool modes.
    if (this.activeTool === SpecialTool.HAMMER) {
      this.pasteInventorySlot(!!(e?.shiftKey || this.keys?.crouch));
      return;
    }

    // The pivot axes are informational only. Wrench left-click always keeps
    // its single interaction: charged point grabbing while the button is held.
    if (this.activeTool === SpecialTool.WRENCH) {
      this.startWrenchGrab();
      return;
    }

    // 1. Shovel -> remove one standard 1x1x1 cell or entity block. If pointing at
    // micro-geometry, remove the micro cells contained in that standard cell.
    if (this.activeTool === SpecialTool.SHOVEL) {
      if (this.hoveredContraptionHit) {
        const hit = this.hoveredContraptionHit;
        const c = hit.contraption;
        const targetNodeId = hit.entityId ?? contraptionRootId(c);
        const hitCell = hit.cell;
        let result;

        if (hit.kind === 'micro') {
          result = this.performBasicAction({
            domain: ActionDomain.ENTITY,
            action: 'clear-cell',
            target: { contraption: c },
            nodeId: targetNodeId,
            cell: hitCell,
            microOnly: true
          });
          if (result.empty) {
            if (this.ui) this.ui.showToast(`Entity #${c.id} fully dismantled`);
          } else if (result.ok) {
            this.ui?.notifyContraptionStructureChanged(c);
            if (this.ui) {
              this.ui.showToast(`Shovel removed ${result.removed} micro voxels (1 standard cell) from [${targetNodeId}]`);
            }
          }
        } else {
          result = this.performBasicAction({
            domain: ActionDomain.ENTITY,
            action: 'remove-standard',
            target: { contraption: c },
            nodeId: targetNodeId,
            cell: hitCell
          });
          if (result.empty) {
            if (this.ui) this.ui.showToast(`Entity #${c.id} fully dismantled`);
          } else if (result.ok) {
            this.ui?.notifyContraptionStructureChanged(c);
            if (this.ui) {
              this.ui.showToast(`Shovel removed 1 standard block from [${targetNodeId}]`);
            }
          }
        }
        if ((result?.removed || 0) > 0) {
          this.particles.emitBlockBreak(hit.point, hit.color || this.selectedColor, 12);
          this.sound.playBlockBreak({ kind: 'standard', count: result.removed });
        }
        return;
      }

      if (!this.currentRaycast.hit) return;
      let result;
      if (this.currentRaycast.kind === 'micro') {
        const mp = this.currentRaycast.microPos;
        const wx = Math.floor(mp.x / MICRO_DIVISIONS);
        const wy = Math.floor(mp.y / MICRO_DIVISIONS);
        const wz = Math.floor(mp.z / MICRO_DIVISIONS);
        result = this.performBasicAction({
          domain: ActionDomain.WORLD,
          action: 'clear-cell',
          cell: { x: wx, y: wy, z: wz },
          microOnly: true
        });
        if (result.removed && this.ui) this.ui.showToast(`Shovel removed ${result.removed} micro voxels (1 standard cell)`);
      } else {
        const hp = this.currentRaycast.hitPos;
        result = this.performBasicAction({ domain: ActionDomain.WORLD, action: 'remove-standard', cell: hp });
        if ((result.removed || 0) > 0) {
          this.particles.emitBlockBreak(hp, this.currentRaycast.color || this.selectedColor, 12);
        }
      }
      if ((result?.removed || 0) > 0) {
        this.sound.playBlockBreak({ kind: 'standard', count: result.removed });
      }
      return;
    }

    // 2. Spoon -> subdivide a standard block, then edit individual micro cells.
    if (this.activeTool === SpecialTool.SPOON) {
      if (this.hoveredContraptionHit) {
        const hit = this.hoveredContraptionHit;
        const c = hit.contraption;
        const targetNodeId = hit.entityId ?? contraptionRootId(c);
        const hitCell = hit.cell;
        let result;

        if (hit.kind === 'micro' && hit.block) {
          result = this.performBasicAction({
            domain: ActionDomain.ENTITY,
            action: 'remove-micro',
            target: { contraption: c },
            nodeId: targetNodeId,
            micro: [
              Math.round(hit.block.localX * MICRO_DIVISIONS),
              Math.round(hit.block.localY * MICRO_DIVISIONS),
              Math.round(hit.block.localZ * MICRO_DIVISIONS)
            ]
          });
          if (result.empty) {
            if (this.ui) this.ui.showToast(`Entity #${c.id} fully micro-carved away`);
          } else if (result.ok) {
            this.ui?.notifyContraptionStructureChanged(c);
            if (this.ui) {
              this.ui.showToast(`Spoon removed 1 micro voxel from [${targetNodeId}]`);
            }
          }
        } else {
          const carved = [
            Math.round((hit.placeMicroPos.localX - hit.normal.x * MICRO_SIZE) * MICRO_DIVISIONS),
            Math.round((hit.placeMicroPos.localY - hit.normal.y * MICRO_SIZE) * MICRO_DIVISIONS),
            Math.round((hit.placeMicroPos.localZ - hit.normal.z * MICRO_SIZE) * MICRO_DIVISIONS)
          ];
          result = this.performBasicAction({
            domain: ActionDomain.ENTITY,
            action: 'subdivide-standard',
            target: { contraption: c },
            nodeId: targetNodeId,
            cell: hitCell,
            micro: carved
          });
          if (result.ok) {
            this.ui?.notifyContraptionStructureChanged(c);
            if (this.ui) {
              this.ui.showToast(`Carved 1 micro voxel out of a subdivided block on [${targetNodeId}] (511 left)`);
            }
          }
        }
        if ((result?.removed || 0) > 0) {
          this.particles.emitBlockBreak(hit.point, hit.color || this.selectedColor, 4);
          this.sound.playBlockBreak({ kind: 'micro', count: result.removed });
        }
        return;
      }

      if (!this.currentRaycast.hit) return;
      const publishedHit = this.currentRaycast;
      const publishedCell = publishedHit.kind === 'micro'
        ? {
            x: Math.floor(publishedHit.microPos.x / MICRO_DIVISIONS),
            y: Math.floor(publishedHit.microPos.y / MICRO_DIVISIONS),
            z: Math.floor(publishedHit.microPos.z / MICRO_DIVISIONS),
          }
        : publishedHit.hitPos;

      const carve = hit => {
        if (hit.kind === 'micro') {
          return this.performBasicAction({
            domain: ActionDomain.WORLD,
            action: 'remove-micro',
            micro: hit.microPos,
          });
        }

        const hp = hit.hitPos;
        // Direct carve uses the exact rendered entry point, clamped to the hit standard cell.
        const normal = hit.normal;
        const entry = hit.entry
          ? new THREE.Vector3(hit.entry.x, hit.entry.y, hit.entry.z)
          : this.physics.getEyePosition();
        const clamp = (value, base) => Math.max(base * MICRO_DIVISIONS, Math.min(
          base * MICRO_DIVISIONS + MICRO_DIVISIONS - 1,
          value,
        ));
        const carveMicro = [
          clamp(Math.floor((entry.x + normal.x * 0.02) * MICRO_DIVISIONS), hp.x),
          clamp(Math.floor((entry.y + normal.y * 0.02) * MICRO_DIVISIONS), hp.y),
          clamp(Math.floor((entry.z + normal.z * 0.02) * MICRO_DIVISIONS), hp.z),
        ];
        return this.performBasicAction({
          domain: ActionDomain.WORLD,
          action: 'subdivide-standard',
          cell: hp,
          micro: carveMicro,
        });
      };

      let carvedHit = publishedHit;
      let result = carve(carvedHit);
      if (!result.ok && result.reason === 'not_found') {
        // The mesh currently on screen can outlive the cell consumed by the
        // preceding click. Keep hover tied to that published mesh, but let this
        // destructive retry advance through live microcells in the same 1 m
        // cell so a burst of clicks is never swallowed.
        const liveQuery = this.performAimRaycast('all', false);
        const liveHit = liveQuery.kind === 'world' ? liveQuery.worldHit : null;
        const liveCell = liveHit?.kind === 'micro' && liveHit.microPos
          ? {
              x: Math.floor(liveHit.microPos.x / MICRO_DIVISIONS),
              y: Math.floor(liveHit.microPos.y / MICRO_DIVISIONS),
              z: Math.floor(liveHit.microPos.z / MICRO_DIVISIONS),
            }
          : null;
        if (
          liveCell
          && liveCell.x === publishedCell.x
          && liveCell.y === publishedCell.y
          && liveCell.z === publishedCell.z
        ) {
          carvedHit = liveHit;
          result = carve(carvedHit);
        }
      }

      if ((result.removed || 0) > 0) {
        if (carvedHit.kind === 'standard' && this.ui) {
          this.ui.showToast(`Carved 1 micro voxel out of ${result.subdivided} (511 left)`);
        }
        this.particles.emitBlockBreak(carvedHit.hitPos, carvedHit.color, 4);
        this.sound.playBlockBreak({ kind: 'micro', count: result.removed });
      }
      return;
    }

    // 3. Brush -> Paint / Override block color directly, or cancel pending 2-point selection
    if (this.activeTool === SpecialTool.BRUSH) {
      if (this.brushSelection) {
        this.clearBrushSelection();
        this.sound?.playWrenchClick?.();
        if (this.ui) this.ui.showToast('Brush selection cancelled');
        return;
      }
      this.paintTargetedBlock();
      return;
    }

    // 4. Pipette -> Pick / Sample block color directly
    if (this.activeTool === SpecialTool.PIPETTE) {
      this.sampleTargetedColor();
      return;
    }

    // 5. Tool: Selector — entity/component level selection, 2-point block box,
    //    and R/T copy. Inventory construction belongs exclusively to Hammer.
    if (this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE) {
      const isMultiSelect = !!(e?.shiftKey || this.keys.crouch);

      const worldPoint = this.currentRaycast && this.currentRaycast.hit
        ? new THREE.Vector3(this.currentRaycast.hitPos.x, this.currentRaycast.hitPos.y, this.currentRaycast.hitPos.z)
        : null;

      // 预选后左键再点击任意方块->回到未选:
      // When in preselected state (completed selection without an in-progress 2-point drag),
      // a plain left click on any block (entity or world) dismisses the selection and returns to unselected ('未选').
      // A subtree-only selection created by Shift+click on an editable level also counts as
      // preselected. Running/errored entities keep their whole-selection on repeat clicks (the
      // only level they expose), so their non-editable subtree stays sticky.
      const isEntityBoxInProgress = !!(this.selectorRange && this.selectorRange.pointA && !this.selectorRange.pointB);
      const isWorldBoxInProgress = !!(this.contraptions && this.contraptions.selectionCornerA !== null && this.contraptions.selectionCornerB === null);
      const isEditableSubtreeSelection = !!(
        this.selectedSubtree?.contraption &&
        this.selectedBlockSelection === null &&
        this.canEditEntityInternals(this.selectedSubtree.contraption)
      );
      const isPreselected = !!(
        isEditableSubtreeSelection ||
        (this.selectedBlockSelection && this.selectedBlockSelection.blocks?.length > 0) ||
        (this.contraptions && typeof this.contraptions.hasValidSelection === 'function' && this.contraptions.hasValidSelection())
      );
      const clickedAnyBlock = !!(this.hoveredContraptionHit || worldPoint);
      if (!isMultiSelect && !isEntityBoxInProgress && !isWorldBoxInProgress && isPreselected && clickedAnyBlock) {
        this.clearSelection();
        return;
      }

      if (this.hoveredContraptionHit) {
        // If world selection was in progress (cornerA was set on world terrain), but point 2 hits an entity:
        if (this.contraptions && this.contraptions.selectionCornerA !== null && this.contraptions.selectionCornerB === null) {
          this.contraptions.selectionCornerA = null;
          this.contraptions.selectionCornerB = null;
          this.boxSelectionPreview = null;
          this.sceneRenderer?.clearBoxSelectionPreview?.();
          this.ui?.showToast?.('起点不是实体，结束点也不能是实体', { tone: 'warning' });
          return;
        }
        // Entity/component hit:
        //   First click  → select that component level (auto-highlights its subtree, not its parent).
        //   Second click → advance the 2-point box selection for that level's own blocks only.
        //   Shift+click  → multi-select / toggle individual blocks or micro-blocks.
        this.selectorOnEntityClick(this.hoveredContraptionHit, e);
        return;
      }

      // Micro selection mode (Tab) targets the 0.125 m cell under the crosshair
      // instead of the whole standard cell.
      const microCell = this.selectorMicroMode ? this.selectorMicroCellFromRaycast() : null;
      const targetPoint = microCell
        ? new THREE.Vector3(microCell.x / MICRO_DIVISIONS, microCell.y / MICRO_DIVISIONS, microCell.z / MICRO_DIVISIONS)
        : worldPoint;

      // Shift + world click: exit entity box-selection level, enter world single-cell mode.
      if (isMultiSelect && worldPoint) {
        if (this.selectedSubtree) {
          this.selectedSubtree.contraption.clearSubtreeHighlight();
          this.selectedSubtree = null;
        }
        if (this.selectedBlockSelection) {
          this.selectedBlockSelection.contraption.clearSubtreeHighlight();
        }
        this.selectedBlockSelection = null;
        this.selectorLevel = null;
        this.selectorRange = null;
        const info = this.performBasicAction({
          domain: ActionDomain.SELECTION,
          action: 'toggle-cell',
          point: targetPoint,
          micro: this.selectorMicroMode === true
        }).selection;
        if (info?.rejected && this.ui) {
          this.ui.showToast('Selected cell lies outside the 64×64×64 limit', { tone: 'warning' });
        }
        return;
      }

      // If entity selection was in progress (corner 1 on entity), but corner 2 is clicked on world:
      if (this.selectorRange && this.selectorRange.pointA && !this.selectorRange.pointB && worldPoint) {
        this.selectorRange = null;
        this.selectorLevel = null;
        this.boxSelectionPreview = null;
        this.sceneRenderer?.clearBoxSelectionPreview?.();
        this.ui?.showToast?.('起点是实体，结束点也必须是该实体的一部分', { tone: 'warning' });
        return;
      }

      // World hit (no active entity box-selection): clear entity/component state and enter
      // world 2-point box mode. Previously this would unconditionally re-enter "re-box entity
      // level", causing selectorLevel to persist after G-assembly so clicks outside the entity
      // could never start a world selection. Now: world click = world box; entity click = re-box
      // entity level. A click that hits nothing (sky) intentionally leaves the current entity
      // selection untouched — missing a shot must not cancel an in-progress 2-point box.
      if (worldPoint) {
        if (this.selectedSubtree) {
          this.selectedSubtree.contraption.clearSubtreeHighlight();
          this.selectedSubtree = null;
        }
        if (this.selectedBlockSelection) {
          this.selectedBlockSelection.contraption.clearSubtreeHighlight();
        }
        this.selectedBlockSelection = null;
        this.selectorLevel = null;
        this.selectorRange = null;

        const hp = worldPoint;
        if (isMultiSelect) {
          const info = this.performBasicAction({
            domain: ActionDomain.SELECTION,
            action: 'toggle-cell',
            point: targetPoint,
            micro: this.selectorMicroMode === true
          }).selection;
          if (info?.rejected && this.ui) {
            this.ui.showToast('Selected cell lies outside the 64×64×64 limit', { tone: 'warning' });
          }
        } else {
          // 2-point world box: cornerA then cornerB define the diagonal AABB.
          // In micro mode the confirmed box materializes into the existing
          // micro voxels it contains; a plain click on the completed set clears it.
          if (this.selectorMicroMode && Array.isArray(this.contraptions?.microSelection)) {
            this.clearSelection();
          } else if (this.contraptions.selectionCornerA === null) {
            this.performBasicAction({
              domain: ActionDomain.SELECTION,
              action: 'corner-a',
              point: targetPoint,
              micro: this.selectorMicroMode === true
            });
            this.selectionShapeAnchor = {
              cornerA: this.selectorMicroMode ? { ...microCell } : { x: Math.floor(hp.x), y: Math.floor(hp.y), z: Math.floor(hp.z) },
              cornerB: null,
              micro: this.selectorMicroMode === true
            };
          } else if (this.contraptions.selectionCornerB === null) {
            const cornerResult = this.performBasicAction({
              domain: ActionDomain.SELECTION,
              action: 'corner-b',
              point: targetPoint,
              micro: this.selectorMicroMode === true
            });
            const ptB = this.selectorMicroMode ? { ...microCell } : { x: Math.floor(hp.x), y: Math.floor(hp.y), z: Math.floor(hp.z) };
            if (this.selectionShapeAnchor) {
              this.selectionShapeAnchor.cornerB = ptB;
            } else {
              this.selectionShapeAnchor = {
                cornerA: this.selectorMicroMode ? { ...microCell } : { x: Math.floor(hp.x), y: Math.floor(hp.y), z: Math.floor(hp.z) },
                cornerB: ptB,
                micro: this.selectorMicroMode === true
              };
            }
            if (this.selectorShape !== 'box') {
              this.applySelectionShape(this.selectorShape);
            }
            if (cornerResult?.clamped && this.ui) {
              this.ui.showToast('Selection exceeds 64×64×64 limit · clamped to bounds', { tone: 'warning' });
            }
          } else {
            // Box already complete — next plain click clears it and resets to idle.
            this.clearSelection();
          }
        }
      }
      return;
    }
  }

  /**
   * Handle a Selector left-click on an entity/component.
   *
   * Interaction states for entities whose scripts are not running:
   * - **First click**: select the hit component level; auto-recursively highlight it and all
   *   descendants (never the parent). Press R to copy the subtree.
   * - **Second click on the same entity** (any surface): advance the 2-point box selection for
   *   that level's *own* blocks only (child-component blocks are excluded). Any point on the
   *   entity surface is valid — the hit does not need to land exactly on the target component,
   *   making it easy to box-select small components.
   * - **Click after box is complete**: restart box-selection (same level; this click becomes the
   *   new first corner).
   * - **Shift+click**: immediately switch / re-select the component level without entering box
   *   mode.
   *
   * Only stopped entities expose their construction grid. A **running** entity is
   * stopped by the first click (returning it to its construction pose); the next
   * click starts the 2-point box on the now-editable entity. Entities the player
   * is not allowed to edit keep whole-entity selection only.
   */
  selectorOnEntityClick(hit, e = null) {
    const contraption = hit.contraption;
    const hitNodeId = (hit.entityId && contraption?.entityNodes?.has(hit.entityId))
      ? hit.entityId
      : contraptionRootId(contraption);
    const shiftHeld = !!(e?.shiftKey || this.keys?.crouch);

    // World 2-point box in progress (cornerA set, cornerB not yet set): clicking an entity
    // must be rejected per requirement: "如果框选的起点不是实体，结束的点也应该不是实体，否则退出选区，给出提示。"
    if (this.contraptions && this.contraptions.selectionCornerA !== null && this.contraptions.selectionCornerB === null) {
      this.contraptions.selectionCornerA = null;
      this.contraptions.selectionCornerB = null;
      this.boxSelectionPreview = null;
      this.sceneRenderer?.clearBoxSelectionPreview?.();
      if (this.ui) this.ui.showToast('起点不是实体，结束点也不能是实体', { tone: 'warning' });
      return;
    }

    // A running entity must be stopped before its construction grid can be
    // selected. The first click stops it (returning it to the construction pose);
    // the next click starts the 2-point box on the now-editable entity.
    if (!this.canEditEntityInternals(contraption)) {
      const mayEdit = contraption.serverManaged !== true || contraption.serverCanEdit === true;
      const mayStop = contraption.serverManaged !== true || contraption.serverCanControl === true;
      // Only stop when the player may both edit and control it; otherwise the
      // stop can never stick and whole-entity selection is the only option.
      if (mayEdit && mayStop && this.isEntityRunning(contraption)) {
        // Drop any stale selection before the stop resets the entity pose.
        this.clearSelection();
        const stopped = this.stopRunningEntityForSelection(contraption);
        if (!stopped) {
          this.ui?.showToast?.(`Entity #${contraption.id} could not be stopped`);
          return;
        }
        this.sound?.playWrenchClick?.();
        this.ui?.showToast?.(`Entity #${contraption.id} stopped — click again to start the selection`);
        return;
      }
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
          blocks: result.selection.blocks,
          bounds: this.getEntitySelectionBounds(result.selection.blocks, isMicro)
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
        if (this.ui) this.ui.showToast('选区的起点与终点必须属于同一实体', { tone: 'warning' });
        return;
      }
      if (this.selectorRange.nodeId !== hitNodeId) {
        this.clearSelection();
        if (this.ui) this.ui.showToast('选中区域必须是同一层级、同父组件', { tone: 'warning' });
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

  canEditEntityInternals(contraption) {
    return !!contraption && (contraption.serverManaged !== true || contraption.serverCanEdit === true)
      && (typeof contraption.canEditInternalSelection === 'function'
      ? contraption.canEditInternalSelection()
      : contraption.scriptStatus === 'stopped');
  }

  /**
   * True while an entity still simulates scripts or physics, i.e. it must be
   * stopped before its construction grid becomes selectable.
   */
  isEntityRunning(contraption) {
    if (!contraption) return false;
    if (typeof contraption.canEditInternalSelection === 'function') {
      return !contraption.canEditInternalSelection();
    }
    return contraption.scriptStatus !== 'stopped';
  }

  /**
   * Stop a running entity so the selector can expose its construction grid.
   *
   * The stop is applied locally first (same state reset the Wrench uses) so the
   * next click can select immediately instead of waiting for a server
   * round-trip. Server-managed entities additionally sync the durable run state;
   * setting `serverDesiredRunState` stops the poll from restarting it before the
   * server confirms.
   */
  stopRunningEntityForSelection(contraption) {
    if (!contraption) return false;
    const result = this.performBasicAction({
      domain: ActionDomain.ENTITY,
      action: 'stop-scripts',
      target: { contraption }
    });
    const stopped = result.ok || result.reason === 'already_stopped';
    if (contraption.serverManaged === true) {
      contraption.serverDesiredRunState = 'stopped';
      if (contraption.serverCanControl === true && this.serverEntityRunStateHandler) {
        void this.requestServerEntityRunState(contraption, 'stopped', { silent: true });
      }
    }
    return stopped;
  }

  /**
   * Select a component level and auto-highlight its full subtree (descendants only, not the
   * parent). Clears any active world selection so the two modes never overlap.
   */
  startSubtreeSelection(contraption, hitNodeId, opts: { wholeOnly?: boolean } = {}) {
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
      this.ui.showToast(`Entity #${contraption.id} is not stopped — whole entity selected (${blockCount} blocks) · Del delete entity · R copy entity · T copy block set · use Wrench to stop it before selecting internal blocks`);
    }
  }

  /**
   * Shift a surface hit point slightly inward along the face normal so that
   * cell quantization (Math.floor) and range selection firmly target the hit
   * voxel instead of extending into the empty neighbor block along the normal.
   */
  getInwardEntityPoint(hit: any): THREE.Vector3 | null {
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
  rangePointToLocal(range, worldPoint) {
    if (!range || !worldPoint || !range.contraption) return null;
    const node = range.contraption.entityNodes.get(range.nodeId);
    if (!node) return null;
    return node.group.worldToLocal(new THREE.Vector3(worldPoint.x, worldPoint.y, worldPoint.z));
  }

  /**
   * Convert a node-local range corner back to world space.
   * Used for live preview rendering and diagnostic toast messages.
   *
   * @returns World-space position, or `null` if the node no longer exists.
   */
  rangePointToWorld(range, point) {
    if (!range || !point || !range.contraption) return null;
    const node = range.contraption.entityNodes.get(range.nodeId);
    if (!node) return null;
    return node.group.localToWorld(new THREE.Vector3(point.x, point.y, point.z));
  }

  /**
   * Describe an entity selection range in its authored voxel grid. Range
   * points are stored relative to the node pivot, while renderer cell
   * quantization expects entity-local voxel coordinates, so the pivot is
   * added back here. The renderer uses the live node group as the frame so
   * previews inherit root and child rotations, including render interpolation.
   */
  rangePreviewFrame(range) {
    if (!range || !range.contraption) return null;
    const node = range.contraption.entityNodes.get(range.nodeId);
    if (!node) return null;
    // Clamp to EVERY block owned by this level, standard and micro alike. Filtering
    // to micro blocks alone broke components that mix granularities: after carving
    // a hole in one 1 m block, a box drawn on another (still standard) block was
    // clamped to the carved micro geometry elsewhere in the component, so the
    // live preview jumped to the wrong block.
    const ownerBlocks = range.contraption.blocks.filter(block => (
      contraptionBlockOwnerId(range.contraption, block) === range.nodeId
    ));
    if (ownerBlocks.length === 0) return null;
    node.group?.updateWorldMatrix?.(true, false);
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const block of ownerBlocks) {
      const size = block.size || 1;
      min.x = Math.min(min.x, block.localX);
      min.y = Math.min(min.y, block.localY);
      min.z = Math.min(min.z, block.localZ);
      max.x = Math.max(max.x, block.localX + size);
      max.y = Math.max(max.y, block.localY + size);
      max.z = Math.max(max.z, block.localZ + size);
    }
    const hasValidBounds = Number.isFinite(min.x) && Number.isFinite(max.x) &&
                           Number.isFinite(min.y) && Number.isFinite(max.y) &&
                           Number.isFinite(min.z) && Number.isFinite(max.z) &&
                           min.x <= max.x && min.y <= max.y && min.z <= max.z;
    return {
      object: node.group,
      pivot: (node.pivotLocal || new THREE.Vector3()).clone(),
      // The live range is only a selector aid. Clamp it to real component
      // bounds so pointing outside the entity cannot draw cyan ghost cells.
      bounds: hasValidBounds ? { min, max } : null
    };
  }

  rangePointToPreviewGrid(range, point) {
    const frame = this.rangePreviewFrame(range);
    if (!frame || !point) return null;
    return new THREE.Vector3(point.x, point.y, point.z).add(frame.pivot);
  }

  worldPointToRangePreviewGrid(range, worldPoint) {
    const local = this.rangePointToLocal(range, worldPoint);
    return local ? this.rangePointToPreviewGrid(range, local) : null;
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
  resolveBlockRangeSelection(range) {
    const { contraption, nodeId, pointA, pointB } = range;
    const node = contraption.entityNodes.get(nodeId);
    if (!node) {
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
      allComponents: true
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

    let selected = result.selection.blocks;
    const components = result.components || [];

    // Validation: "不含已分配的子组件的方块。（否则退出选择器，给出提示）"
    const hasOtherComponentBlocks = selected.some((b: any) => contraptionBlockOwnerId(contraption, b) !== nodeId);
    if (hasOtherComponentBlocks || components.length > 1 || (components.length === 1 && components[0] !== nodeId)) {
      this.clearSelection();
      if (this.ui) this.ui.showToast('选区不能包含已分配的子组件方块', { tone: 'warning' });
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
  private entityMicroCellFromHit(hit) {
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
  private entityMicroCellRangeForBox(range) {
    const gridA = this.rangePointToPreviewGrid(range, range.pointA);
    const gridB = this.rangePointToPreviewGrid(range, range.pointB);
    if (!gridA || !gridB) return null;
    const minX = Math.min(gridA.x, gridB.x);
    const maxX = Math.max(gridA.x, gridB.x);
    const minY = Math.min(gridA.y, gridB.y);
    const maxY = Math.max(gridA.y, gridB.y);
    const minZ = Math.min(gridA.z, gridB.z);
    const maxZ = Math.max(gridA.z, gridB.z);
    return {
      minX: Math.ceil(minX * MICRO_DIVISIONS) - 1,
      maxX: Math.floor(maxX * MICRO_DIVISIONS),
      minY: Math.ceil(minY * MICRO_DIVISIONS) - 1,
      maxY: Math.floor(maxY * MICRO_DIVISIONS),
      minZ: Math.ceil(minZ * MICRO_DIVISIONS) - 1,
      maxZ: Math.floor(maxZ * MICRO_DIVISIONS)
    };
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
  private buildEntityMicroSelection(contraption, nodeId, contains: (x: number, y: number, z: number) => boolean, bounds) {
    const blocks: any[] = [];
    let cells = 0;
    for (const block of contraption.blocks) {
      if (contraptionBlockOwnerId(contraption, block) !== nodeId) continue;
      const size = (block.size !== undefined && block.size !== null) ? block.size : 1;
      if (size < 1) {
        const cx = Math.round(block.localX * MICRO_DIVISIONS);
        const cy = Math.round(block.localY * MICRO_DIVISIONS);
        const cz = Math.round(block.localZ * MICRO_DIVISIONS);
        if (cx < bounds.minX || cx > bounds.maxX || cy < bounds.minY || cy > bounds.maxY || cz < bounds.minZ || cz > bounds.maxZ) continue;
        if (contains(cx, cy, cz)) {
          if (++cells > MAX_MICRO_SELECTION_CELLS) return null;
          blocks.push(block);
        }
        continue;
      }
      const baseX = Math.floor(block.localX + 1e-6) * MICRO_DIVISIONS;
      const baseY = Math.floor(block.localY + 1e-6) * MICRO_DIVISIONS;
      const baseZ = Math.floor(block.localZ + 1e-6) * MICRO_DIVISIONS;
      // Only enumerate the overlap. A tiny cut in a large entity must not visit
      // 512 virtual cells for every unrelated standard block.
      const minX = Math.max(0, bounds.minX - baseX);
      const minY = Math.max(0, bounds.minY - baseY);
      const minZ = Math.max(0, bounds.minZ - baseZ);
      const maxX = Math.min(MICRO_DIVISIONS - 1, bounds.maxX - baseX);
      const maxY = Math.min(MICRO_DIVISIONS - 1, bounds.maxY - baseY);
      const maxZ = Math.min(MICRO_DIVISIONS - 1, bounds.maxZ - baseZ);
      if (minX > maxX || minY > maxY || minZ > maxZ) continue;
      const owner = contraptionBlockOwnerId(contraption, block);
      for (let ix = minX; ix <= maxX; ix++) {
        for (let iy = minY; iy <= maxY; iy++) {
          for (let iz = minZ; iz <= maxZ; iz++) {
            if (!contains(baseX + ix, baseY + iy, baseZ + iz)) continue;
            if (++cells > MAX_MICRO_SELECTION_CELLS) return null;
            blocks.push({
              localX: (baseX + ix) * MICRO_SIZE,
              localY: (baseY + iy) * MICRO_SIZE,
              localZ: (baseZ + iz) * MICRO_SIZE,
              size: MICRO_SIZE,
              color: block.color,
              block: block.block,
              entityId: owner,
              virtualMicro: true,
              sourceBlock: block
            });
          }
        }
      }
    }
    return blocks;
  }

  /** Cell key used to compare a block descriptor with a 0.125 m cell index. */
  private microCellKey(block) {
    return `${Math.round(block.localX * MICRO_DIVISIONS)},${Math.round(block.localY * MICRO_DIVISIONS)},${Math.round(block.localZ * MICRO_DIVISIONS)}`;
  }

  /**
   * Replace the current selection with a virtual micro selection made of the
   * given descriptors, refreshing highlights, bounds and the shape gizmo.
   */
  private setVirtualMicroSelection(contraption, nodeId, blocks) {
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
  private preparedChildBoundsStep(bounds, block) {
    const size = block.size || 1;
    bounds.minX = Math.min(bounds.minX, block.localX);
    bounds.minY = Math.min(bounds.minY, block.localY);
    bounds.minZ = Math.min(bounds.minZ, block.localZ);
    bounds.maxX = Math.max(bounds.maxX, block.localX + size);
    bounds.maxY = Math.max(bounds.maxY, block.localY + size);
    bounds.maxZ = Math.max(bounds.maxZ, block.localZ + size);
  }

  private finishPreparedChildCreation(contraption, nodeId, blocks, bounds, legacy = false) {
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
        ? 'Stop the entity before creating a child component from its blocks'
        : 'Could not create child component from this selection');
      return null;
    }
    contraption.clearSubtreeHighlight?.();
    this.sound?.playAssemblyClack?.();
    if (legacy) {
      this.ui?.showToast?.(`Child component ${child.id} created · control it via self.child('${child.id}')`);
      this.ui?.renderComponentTree?.(contraption);
      this.ui?.renderCodeTabs?.(contraption);
      this.ui?.updateInspectorProperties?.(child.id);
    } else {
      this.selectorLevel = { contraption, nodeId };
      this.ui?.showToast?.(`Created child component [${child.id}] from ${blocks.length} blocks under [${nodeId}] · press C to program`);
    }
    return child;
  }

  private startLargeChildCreation(contraption, nodeId, candidates, legacy = false, selectedCells = null) {
    const source = [...candidates];
    const prepared: any[] = [];
    const bounds = {
      minX: Infinity, minY: Infinity, minZ: Infinity,
      maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity
    };
    return this.startBulkEditJob({
      label: 'Creating child component',
      total: source.length,
      mutatesWorld: false,
      detail: 'Preparing component blocks',
      step: index => {
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
      this.ui?.showToast?.('Stop the entity before creating a child component from its blocks');
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

    // Validation: "但不能把整个父组件选中创建子组件"
    const totalParentBlocks = contraption.blocks.filter((b: any) => contraptionBlockOwnerId(contraption, b) === nodeId).length;
    if (blocks.length >= totalParentBlocks) {
      if (this.ui) {
        this.ui.showToast('不能将整个父组件全部选中创建子组件', { tone: 'warning' });
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
        this.ui.showToast(`Created child component [${child.id}] from ${blocks.length} blocks under [${nodeId}] · press C to program`);
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
          ? 'Stop the entity before creating a child component from its blocks'
          : 'Could not create child component from this selection');
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
   * - If an entity component or subtree is selected, copies as an entity.
   * - If world blocks / micro cells are selected, copies as a raw block set.
   * - If nothing is selected, shows a helpful toast.
   */
  copySelectionSmart() {
    if (this.selectedBlockSelection && this.selectedBlockSelection.blocks.length > 0) {
      return this.copySelectionToInventory();
    }
    if (this.selectedSubtree && this.selectedSubtree.contraption) {
      return this.copySelectionToInventory();
    }
    if (this.contraptions && this.contraptions.hasValidSelection()) {
      return this.copySelectionAsBlockSet();
    }
    if (this.ui) {
      this.ui.showToast('Nothing selected - select an entity/component or box-select blocks, then press R');
    }
    return null;
  }

  /**
   * Copy the currently selected component/entity into the active entity inventory slot.
   *
   * Sources, in priority order:
   *
   * - **Block selection** (2-point box): copies the selected own-blocks as a standalone entity
   *   slot.
   * - **Subtree selection** (first-click level): copies the entire component subtree.
   */
  private stripCopiedBottomGap(blocks, yKey) {
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
    if (this.selectedBlockSelection && this.selectedBlockSelection.blocks.length > 0) {
      const { contraption, nodeId, blocks } = this.selectedBlockSelection;
      if (!this.canEditEntityInternals(contraption)) {
        this.clearSelection();
        this.ui?.showToast?.('Stop the entity before copying an internal block selection');
        return null;
      }
      const slot = contraption.serializeSubtree(nodeId);
      const slotRootId = inventoryEntityRootId(slot);
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
        this.ui?.showToast?.(`Entity inventory is full (${this.inventories.entity.items.length}) - delete one first`);
        return null;
      }
      this.setActiveInventoryCategory('entity');
      this.ui?.renderInventoryBar?.();
      this.clearSelection();
      this.activateTool(SpecialTool.HAMMER);
      if (this.ui) {
        this.ui.showToast(`Copied ${blocks.length} own blocks of [${nodeId}] to entity slot ${index + 1} · switched to Hammer`);
      }
      return slot;
    }
    if (this.selectedSubtree && this.selectedSubtree.contraption) {
      return this.copySelectedSubtreeToInventory();
    }
    if (this.contraptions && this.contraptions.hasValidSelection()) {
      return this.copySelectionAsBlockSet();
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
  private finishBlockSetCopy(rawBlocks, name) {
    if (!Array.isArray(rawBlocks) || rawBlocks.length === 0) {
      this.ui?.showToast?.('Selection region is empty (no voxels to copy)');
      return null;
    }
    const blocks = this.stripCopiedBottomGap(rawBlocks, 'dy');
    const slot = { kind: 'blockset', name, blocks, blockCount: blocks.length };
    const index = this.addInventoryItem('blockset', slot);
    if (index === null) {
      this.ui?.showToast?.(`Block set inventory is full (${this.inventories.blockset.items.length}) - delete one first`);
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
  private startLargeEntityBlockSetCopy(blocks, name) {
    const source = [...blocks];
    const rawBlocks: any[] = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    return this.startBulkEditJob({
      label: 'Copying block set',
      total: source.length * 2,
      mutatesWorld: false,
      detail: job => job.processed < source.length ? 'Measuring selection' : 'Preparing inventory voxels',
      step: index => {
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
          part: block.part
        });
        return 1;
      },
      finish: () => this.finishBlockSetCopy(rawBlocks, name)
    });
  }

  /** Read one standard world cell and all of its carved micro voxels. */
  private sampleWorldCellForBulkCopy(cell, consider) {
    const block = this.world.getBlock?.(cell.x, cell.y, cell.z);
    if (block !== BlockTypes.AIR) {
      consider(cell.x, cell.y, cell.z, 1, block, this.world.getBlockColor?.(cell.x, cell.y, cell.z), null);
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
      consider(micro.x, micro.y, micro.z, micro.size || MICRO_SIZE, BlockTypes.COLOR_BLOCK, micro.color, micro.part);
    }
  }

  /** Scan and normalize a large world selection through the shared executor. */
  private startLargeWorldBlockSetCopy(manager) {
    const microCells = Array.isArray(manager.microSelection)
      ? manager.microSelection.map(cell => ({ x: cell.x, y: cell.y, z: cell.z }))
      : null;
    const bounds = manager.getSelectionBounds?.();
    const sparseCells = !microCells && manager.connectedSelection !== null
      ? [...(manager.connectedSelection || [])].map(cell => ({ x: cell.x, y: cell.y, z: cell.z }))
      : null;
    if (!microCells && !bounds) return false;

    const sizeY = bounds ? bounds.maxY - bounds.minY + 1 : 0;
    const sizeZ = bounds ? bounds.maxZ - bounds.minZ + 1 : 0;
    const scanTotal = microCells?.length
      ?? sparseCells?.length
      ?? ((bounds.maxX - bounds.minX + 1) * sizeY * sizeZ);
    const collected: any[] = [];
    const rawBlocks: any[] = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    const consider = (x, y, z, size, block, color, part = null) => {
      collected.push({ x, y, z, size, block, color, part });
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
    };
    const cellAt = index => sparseCells?.[index] || {
      x: bounds.minX + Math.floor(index / (sizeY * sizeZ)),
      y: bounds.minY + Math.floor(index / sizeZ) % sizeY,
      z: bounds.minZ + index % sizeZ
    };

    const started = this.startBulkEditJob({
      label: 'Copying world selection',
      total: scanTotal,
      mutatesWorld: false,
      detail: job => job.processed < scanTotal ? 'Scanning selected cells' : 'Normalizing inventory voxels',
      step: (index, job) => {
        if (index < scanTotal) {
          if (microCells) {
            const cell = microCells[index];
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
            } else {
              const wx = Math.floor(cell.x / MICRO_DIVISIONS);
              const wy = Math.floor(cell.y / MICRO_DIVISIONS);
              const wz = Math.floor(cell.z / MICRO_DIVISIONS);
              if (this.world.getBlock?.(wx, wy, wz) !== BlockTypes.AIR) {
                color = this.world.getBlockColor?.(wx, wy, wz);
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
                part
              );
            }
          } else {
            this.sampleWorldCellForBulkCopy(cellAt(index), consider);
          }
          if (index === scanTotal - 1) job.total += collected.length;
          return 0;
        }

        const item = collected[index - scanTotal];
        rawBlocks.push({
          dx: microCells ? Math.round((item.x - minX) * MICRO_DIVISIONS) / MICRO_DIVISIONS : item.x - minX,
          dy: microCells ? Math.round((item.y - minY) * MICRO_DIVISIONS) / MICRO_DIVISIONS : item.y - minY,
          dz: microCells ? Math.round((item.z - minZ) * MICRO_DIVISIONS) / MICRO_DIVISIONS : item.z - minZ,
          size: item.size,
          block: item.block,
          color: item.color,
          part: item.part
        });
        return 1;
      },
      finish: () => this.finishBlockSetCopy(rawBlocks, `world selection (${rawBlocks.length} voxels)`)
    });
    if (started) manager.clearSelection?.();
    return started;
  }

  copySelectionAsBlockSet() {
    if (this.bulkEditJob) {
      this.ui?.showToast?.(`Please wait for ${this.bulkEditJob.label.toLowerCase()} to finish`);
      return null;
    }
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
        color: b.color,
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
      const nodeIds = this.selectedSubtree.nodeIds || this.collectSubtreeIds(contraption, rootId);
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
          color: b.color,
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
  sampleWorldSelectionAsBlockSet() {
    const manager = this.contraptions;
    if (!this.world || !manager) return [];

    // Micro selection (Tab mode): sample exactly the selected 0.125 m cells.
    // Empty selected cells are skipped so the copy matches what G extracts.
    const microSelection = manager.microSelection;
    if (Array.isArray(microSelection)) {
      const collected = [];
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
        collected.push({ x, y, z, size: MICRO_SIZE, block: BlockTypes.COLOR_BLOCK, color });
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
      }
      if (collected.length === 0) return [];
      return collected.map(b => ({
        dx: Math.round((b.x - minX) * MICRO_DIVISIONS) / MICRO_DIVISIONS,
        dy: Math.round((b.y - minY) * MICRO_DIVISIONS) / MICRO_DIVISIONS,
        dz: Math.round((b.z - minZ) * MICRO_DIVISIONS) / MICRO_DIVISIONS,
        size: b.size,
        block: b.block,
        color: b.color
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

    const collected = []; // { x, y, z, size, block, color } in world units
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    const consider = (x, y, z, size, block, color) => {
      collected.push({ x, y, z, size, block, color });
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
          consider(cell.x, cell.y, cell.z, 1, block, this.world.getBlockColor(cell.x, cell.y, cell.z));
        }
      }
      const micros = this.world.getMicroBlocksInAABB(microBounds) || [];
      for (const m of micros) {
        const cellKey = `${Math.floor(m.x)},${Math.floor(m.y)},${Math.floor(m.z)}`;
        if (singleKeys.has(cellKey)) {
          consider(m.x, m.y, m.z, m.size || MICRO_SIZE, BlockTypes.COLOR_BLOCK, m.color);
        }
      }
    } else {
      // 2-point box: every non-air standard block plus micro voxels in the AABB.
      for (let x = bounds.minX; x <= bounds.maxX; x++) {
        for (let y = bounds.minY; y <= bounds.maxY; y++) {
          for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
            const block = this.world.getBlock(x, y, z);
            if (block !== BlockTypes.AIR) {
              consider(x, y, z, 1, block, this.world.getBlockColor(x, y, z));
            }
          }
        }
      }
      const micros = this.world.getMicroBlocksInAABB(microBounds) || [];
      for (const m of micros) {
        consider(m.x, m.y, m.z, m.size || MICRO_SIZE, BlockTypes.COLOR_BLOCK, m.color);
      }
    }

    if (collected.length === 0) return [];
    return collected.map(b => ({
      dx: b.x - minX,
      dy: b.y - minY,
      dz: b.z - minZ,
      size: b.size,
      block: b.block,
      color: b.color
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
    const entityHit = this.hoveredContraptionHit;
    if (entityHit?.point) {
      return {
        hitPos: entityHit.point,
        normal: entityHit.worldNormal || entityHit.normal || { x: 0, y: 1, z: 0 },
        microNormal: entityHit.worldNormal || entityHit.normal || { x: 0, y: 1, z: 0 },
        entry: entityHit.point,
        kind: entityHit.kind,
        targetContraption: entityHit.contraption || this.hoveredContraption || null,
        targetNodeId: entityHit.entityId ?? entityHit.entityNode?.id ?? contraptionRootId(entityHit.contraption),
        targetLocalNormal: entityHit.normal || entityHit.worldNormal || { x: 0, y: 1, z: 0 }
      };
    }
    return this.currentRaycast?.hit
      ? {
          hitPos: this.currentRaycast.hitPos,
          normal: this.currentRaycast.normal,
          microNormal: this.currentRaycast.normal,
          entry: this.currentRaycast.entry,
          kind: this.currentRaycast.kind,
          placeMicroPos: this.currentRaycast.placeMicroPos
        }
      : null;
  }

  /** Pure-micro block sets can move on the 1/5 grid without invalidating a standard voxel. */
  private usesMicroBlockSetPlacement(slot) {
    return slot?.kind === 'blockset'
      && Array.isArray(slot.blocks)
      && slot.blocks.length > 0
      && slot.blocks.every(block => (Number(block?.size) || 1) < 1);
  }

  /** Resolve the adjacent 0.125 m cell on either terrain or an entity surface. */
  private getMicroBlockSetPlacementPosition(placementHit) {
    if (placementHit.kind === 'micro' && placementHit.placeMicroPos) {
      const micro = placementHit.placeMicroPos;
      if ([micro.x, micro.y, micro.z].every(Number.isFinite)) {
        return new THREE.Vector3(
          micro.x / MICRO_DIVISIONS,
          micro.y / MICRO_DIVISIONS,
          micro.z / MICRO_DIVISIONS
        );
      }
    }

    const point = placementHit.entry;
    if (!point) {
      const hp = placementHit.hitPos;
      if (!hp) return null;
      const fallbackNormal = placementHit.normal || { x: 0, y: 1, z: 0 };
      return new THREE.Vector3(
        Math.floor(hp.x + (fallbackNormal.x || 0)),
        Math.floor(hp.y + (fallbackNormal.y || 0)),
        Math.floor(hp.z + (fallbackNormal.z || 0))
      );
    }
    const normal = placementHit.microNormal || placementHit.normal || { x: 0, y: 1, z: 0 };
    const outside = new THREE.Vector3(point.x, point.y, point.z).addScaledVector(
      new THREE.Vector3(normal.x || 0, normal.y || 0, normal.z || 0),
      0.02
    );
    const snap = value => Math.floor(value * MICRO_DIVISIONS + 1e-6) / MICRO_DIVISIONS;
    return new THREE.Vector3(snap(outside.x), snap(outside.y), snap(outside.z));
  }

  /**
   * Cache the authored entity footprint used by both the Hammer ghost and the
   * final build. A small spatial sample of bottom faces is enough to follow
   * uneven terrain without raycasting every voxel of a large inventory item
   * on every render frame.
   */
  private getEntityPlacementShape(slot): EntityPlacementShape | null {
    if (!slot || typeof slot !== 'object' || !Array.isArray(slot.blocks)) return null;
    const cached = entityPlacementShapeCache.get(slot);
    if (cached
      && cached.blocksRef === slot.blocks
      && cached.childEntitiesRef === slot.childEntities) return cached;

    const entries = getInventoryPreviewBlocks(slot).flatMap(entry => {
      const size = Number(entry?.size) || 1;
      const center = entry?.center;
      if (!(size > 0) || !center
        || ![center.x, center.y, center.z].every(Number.isFinite)) return [];
      return [{ center: center.clone(), size }];
    });
    if (entries.length === 0) return null;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const entry of entries) {
      const half = entry.size / 2;
      minX = Math.min(minX, entry.center.x - half);
      minY = Math.min(minY, entry.center.y - half);
      minZ = Math.min(minZ, entry.center.z - half);
      maxX = Math.max(maxX, entry.center.x + half);
      maxY = Math.max(maxY, entry.center.y + half);
      maxZ = Math.max(maxZ, entry.center.z + half);
    }

    // Preserve all small footprints. Large ones use one lowest voxel per X/Z
    // bin, spreading support probes across the whole authored footprint.
    let representatives = entries;
    const binLimit = ENTITY_PLACEMENT_SUPPORT_BINS * ENTITY_PLACEMENT_SUPPORT_BINS;
    if (entries.length > binLimit) {
      const width = Math.max(ENTITY_PLACEMENT_EPSILON, maxX - minX);
      const depth = Math.max(ENTITY_PLACEMENT_EPSILON, maxZ - minZ);
      const bins = new Map<number, { center: THREE.Vector3; size: number }>();
      for (const entry of entries) {
        const bx = Math.min(
          ENTITY_PLACEMENT_SUPPORT_BINS - 1,
          Math.max(0, Math.floor((entry.center.x - minX) / width * ENTITY_PLACEMENT_SUPPORT_BINS))
        );
        const bz = Math.min(
          ENTITY_PLACEMENT_SUPPORT_BINS - 1,
          Math.max(0, Math.floor((entry.center.z - minZ) / depth * ENTITY_PLACEMENT_SUPPORT_BINS))
        );
        const key = bx * ENTITY_PLACEMENT_SUPPORT_BINS + bz;
        const previous = bins.get(key);
        if (!previous
          || entry.center.y - entry.size / 2 < previous.center.y - previous.size / 2) {
          bins.set(key, entry);
        }
      }
      representatives = [...bins.values()];
    }

    const rawSamples: Array<{ x: number; z: number; bottom: number }> = [];
    const sampleKeys = new Set<string>();
    const addSample = (x, z, bottom) => {
      const key = `${Math.round(x * 1000)},${Math.round(z * 1000)},${Math.round(bottom * 1000)}`;
      if (sampleKeys.has(key)) return;
      sampleKeys.add(key);
      rawSamples.push({ x, z, bottom });
    };
    for (const entry of representatives) {
      const half = entry.size / 2;
      const bottom = entry.center.y - half;
      addSample(entry.center.x, entry.center.z, bottom);
      // Edge probes keep a one-voxel entity from hanging over a ledge merely
      // because its centre ray missed the supporting terrain cell.
      const inset = Math.max(0, half - Math.min(0.05, entry.size * 0.1));
      if (inset > ENTITY_PLACEMENT_EPSILON) {
        addSample(entry.center.x - inset, entry.center.z - inset, bottom);
        addSample(entry.center.x + inset, entry.center.z - inset, bottom);
        addSample(entry.center.x - inset, entry.center.z + inset, bottom);
        addSample(entry.center.x + inset, entry.center.z + inset, bottom);
      }
    }
    const supportSamples = rawSamples.length <= ENTITY_PLACEMENT_SUPPORT_SAMPLE_LIMIT
      ? rawSamples
      : Array.from({ length: ENTITY_PLACEMENT_SUPPORT_SAMPLE_LIMIT }, (_, index) => (
          rawSamples[Math.floor(index * (rawSamples.length - 1) / (ENTITY_PLACEMENT_SUPPORT_SAMPLE_LIMIT - 1))]
        ));

    const shape: EntityPlacementShape = {
      blocksRef: slot.blocks,
      childEntitiesRef: slot.childEntities,
      entries,
      supportSamples,
      minX, minY, minZ,
      maxX, maxY, maxZ,
      centerX: (minX + maxX) / 2,
      centerZ: (minZ + maxZ) / 2
    };
    entityPlacementShapeCache.set(slot, shape);
    return shape;
  }

  /** Exact face point when available; otherwise use the centre of the hit voxel face. */
  private getEntityPlacementSurfacePoint(placementHit) {
    const entry = placementHit?.entry;
    if (entry && [entry.x, entry.y, entry.z].every(Number.isFinite)) {
      return new THREE.Vector3(entry.x, entry.y, entry.z);
    }
    const hp = placementHit?.hitPos;
    if (!hp || ![hp.x, hp.y, hp.z].every(Number.isFinite)) return null;
    const normal = placementHit.normal || { x: 0, y: 1, z: 0 };
    const cellSize = placementHit.kind === 'micro' ? 1 / MICRO_DIVISIONS : 1;
    const onFace = (value, axisNormal) => value + (
      axisNormal > 0 ? cellSize : axisNormal < 0 ? 0 : cellSize / 2
    );
    return new THREE.Vector3(
      onFace(hp.x, Number(normal.x) || 0),
      onFace(hp.y, Number(normal.y) || 0),
      onFace(hp.z, Number(normal.z) || 0)
    );
  }

  private clampEntityPlacementY(shape: EntityPlacementShape, y) {
    const minOriginY = -shape.minY;
    const maxOriginY = CHUNK_SIZE_Y - shape.maxY;
    return Math.max(minOriginY, Math.min(maxOriginY, y));
  }

  private snapEntityPlacementMicroValue(value) {
    const units = Math.round(value * MICRO_DIVISIONS);
    return units === 0 ? 0 : units / MICRO_DIVISIONS;
  }

  private targetEntityLocalToWorld(target, nodeId, point: THREE.Vector3) {
    if (typeof target?.entityLocalToWorld === 'function') {
      return target.entityLocalToWorld(nodeId, point.clone());
    }
    const node = target?.getEntityNode?.(nodeId) || target?.entityNodes?.get?.(nodeId);
    if (node?.group?.localToWorld) {
      node.group.updateWorldMatrix?.(true, false);
      return node.group.localToWorld(point.clone().sub(node.pivotLocal || new THREE.Vector3()));
    }
    return point.clone();
  }

  private targetEntityWorldToLocal(target, nodeId, point: THREE.Vector3) {
    if (typeof target?.worldToEntityLocal === 'function') {
      return target.worldToEntityLocal(nodeId, point.clone());
    }
    const node = target?.getEntityNode?.(nodeId) || target?.entityNodes?.get?.(nodeId);
    if (node?.group?.worldToLocal) {
      node.group.updateWorldMatrix?.(true, false);
      return node.group.worldToLocal(point.clone()).add(node.pivotLocal || new THREE.Vector3());
    }
    return point.clone();
  }

  private getTargetEntityWorldQuaternion(target, nodeId) {
    const direct = target?.getEntityNodeWorldQuaternion?.(nodeId);
    if (direct?.isQuaternion) return direct.clone().normalize();
    const node = target?.getEntityNode?.(nodeId) || target?.entityNodes?.get?.(nodeId);
    if (node?.group?.getWorldQuaternion) {
      node.group.updateWorldMatrix?.(true, false);
      return node.group.getWorldQuaternion(new THREE.Quaternion()).normalize();
    }
    return new THREE.Quaternion();
  }

  /** Read a normalized quaternion without allowing malformed inventory data to poison placement math. */
  private inventoryQuaternion(value, fallback = new THREE.Quaternion()) {
    if (!Array.isArray(value) || value.length < 4) return fallback.clone();
    const components = value.slice(0, 4).map(Number);
    if (!components.every(Number.isFinite)) return fallback.clone();
    const quaternion = new THREE.Quaternion(
      components[0], components[1], components[2], components[3]
    );
    return quaternion.lengthSq() > 1e-12 ? quaternion.normalize() : fallback.clone();
  }

  /** Authored mounting frame: identity means local +Y is the outward axis. */
  private getEntityAnchorRotation(slot) {
    return this.inventoryQuaternion(slot?.anchorRotation);
  }

  /** Hammer-only roll. It is temporary and is never written back to the backpack item. */
  private getEntityPlacementRotation(slot) {
    return this.inventoryQuaternion(slot?.placementRotation);
  }

  private axisAlignedEntityFaceNormal(value) {
    const normal = value?.isVector3
      ? value.clone()
      : new THREE.Vector3(Number(value?.x) || 0, Number(value?.y) || 0, Number(value?.z) || 0);
    const components = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)];
    const axis = components[1] > components[0]
      ? (components[2] > components[1] ? 2 : 1)
      : (components[2] > components[0] ? 2 : 0);
    const result = new THREE.Vector3();
    result.setComponent(axis, normal.getComponent(axis) < 0 ? -1 : 1);
    return result;
  }

  private getRotatedEntityPlacementBounds(shape: EntityPlacementShape, rotation: THREE.Quaternion) {
    const axes = [
      new THREE.Vector3(1, 0, 0).applyQuaternion(rotation),
      new THREE.Vector3(0, 1, 0).applyQuaternion(rotation),
      new THREE.Vector3(0, 0, 1).applyQuaternion(rotation)
    ];
    const bounds = {
      minX: Infinity, minY: Infinity, minZ: Infinity,
      maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity
    };
    for (const entry of shape.entries) {
      const center = entry.center.clone().applyQuaternion(rotation);
      const half = entry.size / 2;
      const radiusX = half * axes.reduce((sum, axis) => sum + Math.abs(axis.x), 0);
      const radiusY = half * axes.reduce((sum, axis) => sum + Math.abs(axis.y), 0);
      const radiusZ = half * axes.reduce((sum, axis) => sum + Math.abs(axis.z), 0);
      bounds.minX = Math.min(bounds.minX, center.x - radiusX);
      bounds.minY = Math.min(bounds.minY, center.y - radiusY);
      bounds.minZ = Math.min(bounds.minZ, center.z - radiusZ);
      bounds.maxX = Math.max(bounds.maxX, center.x + radiusX);
      bounds.maxY = Math.max(bounds.maxY, center.y + radiusY);
      bounds.maxZ = Math.max(bounds.maxZ, center.z + radiusZ);
    }
    return bounds;
  }

  /** Rotate cached support probes together with the entity without mutating the authored shape. */
  private getRotatedEntityTerrainShape(shape: EntityPlacementShape, rotation: THREE.Quaternion): EntityPlacementShape {
    const bounds = this.getRotatedEntityPlacementBounds(shape, rotation);
    const supportSamples = shape.supportSamples.map(sample => {
      const point = new THREE.Vector3(sample.x, sample.bottom, sample.z).applyQuaternion(rotation);
      return { x: point.x, z: point.z, bottom: point.y };
    });
    return {
      ...shape,
      ...bounds,
      supportSamples,
      centerX: (bounds.minX + bounds.maxX) / 2,
      centerZ: (bounds.minZ + bounds.maxZ) / 2
    };
  }

  private createEntityPlacementObb(center: THREE.Vector3, size, quaternion: THREE.Quaternion): EntityPlacementObb {
    const axes = [
      new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion).normalize(),
      new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize(),
      new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize()
    ] as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
    const half = Number(size) / 2;
    const radius = new THREE.Vector3(
      half * axes.reduce((sum, axis) => sum + Math.abs(axis.x), 0),
      half * axes.reduce((sum, axis) => sum + Math.abs(axis.y), 0),
      half * axes.reduce((sum, axis) => sum + Math.abs(axis.z), 0)
    );
    return {
      center,
      axes,
      halfExtents: [half, half, half],
      min: center.clone().sub(radius),
      max: center.clone().add(radius)
    };
  }

  private entityPlacementObbsOverlap(a: EntityPlacementObb, b: EntityPlacementObb) {
    if (a.max.x <= b.min.x + ENTITY_PLACEMENT_EPSILON || a.min.x >= b.max.x - ENTITY_PLACEMENT_EPSILON
      || a.max.y <= b.min.y + ENTITY_PLACEMENT_EPSILON || a.min.y >= b.max.y - ENTITY_PLACEMENT_EPSILON
      || a.max.z <= b.min.z + ENTITY_PLACEMENT_EPSILON || a.min.z >= b.max.z - ENTITY_PLACEMENT_EPSILON) {
      return false;
    }
    const axes = [...a.axes, ...b.axes];
    for (const axisA of a.axes) {
      for (const axisB of b.axes) {
        const cross = new THREE.Vector3().crossVectors(axisA, axisB);
        if (cross.lengthSq() > 1e-10) axes.push(cross.normalize());
      }
    }
    const delta = b.center.clone().sub(a.center);
    for (const rawAxis of axes) {
      const axis = rawAxis.clone().normalize();
      const radiusA = a.halfExtents.reduce((sum, halfExtent, index) => (
        sum + halfExtent * Math.abs(a.axes[index].dot(axis))
      ), 0);
      const radiusB = b.halfExtents.reduce((sum, halfExtent, index) => (
        sum + halfExtent * Math.abs(b.axes[index].dot(axis))
      ), 0);
      if (radiusA + radiusB - Math.abs(delta.dot(axis)) <= ENTITY_PLACEMENT_EPSILON) return false;
    }
    return true;
  }

  private getTargetEntityPlacementPoseSignature(target) {
    const values: Array<string | number> = [];
    const appendVector = value => {
      if (!value) return;
      for (const key of ['x', 'y', 'z', 'w']) {
        if (Number.isFinite(Number(value[key]))) values.push(Number(value[key]));
      }
    };
    appendVector(target?.position);
    appendVector(target?.quaternion);
    for (const node of target?.entityNodes?.values?.() || []) {
      values.push(String(node.id || ''));
      appendVector(node.localPosition || node.group?.position);
      appendVector(node.localQuaternion || node.group?.quaternion);
    }
    return values.length > 0
      ? values.join(',')
      : String(Number(target?.collisionPoseVersion) || 0);
  }

  private getTargetEntityPlacementObbs(target) {
    if (!target) return { boxes: [], buckets: new Map<string, EntityPlacementObb[]>() };
    const entries = Array.isArray(target.collisionEntries) && target.collisionEntries.length > 0
      ? target.collisionEntries
      : null;
    const entriesRef = entries || target.blocks;
    const poseSignature = this.getTargetEntityPlacementPoseSignature(target);
    const cached = entityPlacementTargetObbCache.get(target);
    if (cached && cached.entriesRef === entriesRef && cached.poseSignature === poseSignature) return cached;

    const quaternionByNode = new Map<string, THREE.Quaternion>();
    const quaternionFor = nodeId => {
      const id = nodeId === undefined || nodeId === null ? contraptionRootId(target) : String(nodeId);
      let quaternion = quaternionByNode.get(id);
      if (!quaternion) {
        quaternion = this.getTargetEntityWorldQuaternion(target, id);
        quaternionByNode.set(id, quaternion);
      }
      return quaternion;
    };
    const boxes: EntityPlacementObb[] = [];
    if (entries) {
      for (const entry of entries) {
        const nodeId = contraptionBlockOwnerId(target, entry);
        const size = Number(entry.span) / MICRO_DIVISIONS;
        if (!(size > 0)) continue;
        const center = this.targetEntityLocalToWorld(target, nodeId, new THREE.Vector3(
          (Number(entry.x) + Number(entry.span) / 2) / MICRO_DIVISIONS,
          (Number(entry.y) + Number(entry.span) / 2) / MICRO_DIVISIONS,
          (Number(entry.z) + Number(entry.span) / 2) / MICRO_DIVISIONS
        ));
        boxes.push(this.createEntityPlacementObb(center, size, quaternionFor(nodeId)));
      }
    } else {
      for (const block of target.blocks || []) {
        const nodeId = contraptionBlockOwnerId(target, block);
        const size = Number(block.size) || 1;
        const center = target.getBlockWorldCenter?.(block)
          || this.targetEntityLocalToWorld(target, nodeId, new THREE.Vector3(
            Number(block.localX) + size / 2,
            Number(block.localY) + size / 2,
            Number(block.localZ) + size / 2
          ));
        boxes.push(this.createEntityPlacementObb(center, size, quaternionFor(nodeId)));
      }
    }
    const buckets = new Map<string, EntityPlacementObb[]>();
    for (const box of boxes) {
      const minX = Math.floor(box.min.x / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const minY = Math.floor(box.min.y / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const minZ = Math.floor(box.min.z / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const maxX = Math.floor((box.max.x - ENTITY_PLACEMENT_EPSILON) / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const maxY = Math.floor((box.max.y - ENTITY_PLACEMENT_EPSILON) / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const maxZ = Math.floor((box.max.z - ENTITY_PLACEMENT_EPSILON) / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          for (let z = minZ; z <= maxZ; z++) {
            const key = `${x},${y},${z}`;
            const bucket = buckets.get(key);
            if (bucket) bucket.push(box);
            else buckets.set(key, [box]);
          }
        }
      }
    }
    const result = { poseSignature, entriesRef, boxes, buckets };
    entityPlacementTargetObbCache.set(target, result);
    return result;
  }

  private entitySlotOverlapsTarget(slot, position: THREE.Vector3, quaternion: THREE.Quaternion, target) {
    const shape = this.getEntityPlacementShape(slot);
    if (!shape) return false;
    const targetIndex = this.getTargetEntityPlacementObbs(target);
    if (targetIndex.boxes.length === 0) return false;
    for (const entry of shape.entries) {
      const center = entry.center.clone().applyQuaternion(quaternion).add(position);
      const placed = this.createEntityPlacementObb(center, entry.size, quaternion);
      const candidates = new Set<EntityPlacementObb>();
      const minX = Math.floor(placed.min.x / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const minY = Math.floor(placed.min.y / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const minZ = Math.floor(placed.min.z / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const maxX = Math.floor((placed.max.x - ENTITY_PLACEMENT_EPSILON) / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const maxY = Math.floor((placed.max.y - ENTITY_PLACEMENT_EPSILON) / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      const maxZ = Math.floor((placed.max.z - ENTITY_PLACEMENT_EPSILON) / ENTITY_TARGET_PLACEMENT_BUCKET_SIZE);
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          for (let z = minZ; z <= maxZ; z++) {
            for (const box of targetIndex.buckets.get(`${x},${y},${z}`) || []) candidates.add(box);
          }
        }
      }
      for (const existing of candidates) {
        if (this.entityPlacementObbsOverlap(placed, existing)) return true;
      }
    }
    return false;
  }

  /** Centre on the hit face, align to its component grid, then move only outward to clear occupied voxels. */
  private resolveEntityTargetPlacement(slot, shape: EntityPlacementShape, surface: THREE.Vector3, placementHit) {
    const target = placementHit.targetContraption;
    const nodeId = placementHit.targetNodeId ?? contraptionRootId(placementHit.targetContraption);
    const targetWorldRotation = this.getTargetEntityWorldQuaternion(target, nodeId);
    const localNormal = this.axisAlignedEntityFaceNormal(placementHit.targetLocalNormal);
    const faceRotation = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      localNormal
    ).normalize();
    const relativeRotation = faceRotation
      .clone()
      .multiply(this.getEntityAnchorRotation(slot).invert())
      .normalize();
    const worldRotation = targetWorldRotation.clone().multiply(relativeRotation).normalize();
    const bounds = this.getRotatedEntityPlacementBounds(shape, relativeRotation);
    const surfaceLocal = this.targetEntityWorldToLocal(target, nodeId, surface);
    const originLocal = new THREE.Vector3(
      surfaceLocal.x - (bounds.minX + bounds.maxX) / 2,
      surfaceLocal.y - (bounds.minY + bounds.maxY) / 2,
      surfaceLocal.z - (bounds.minZ + bounds.maxZ) / 2
    );
    for (const axis of ['x', 'y', 'z'] as const) {
      const normal = localNormal[axis];
      if (normal > 0) originLocal[axis] = surfaceLocal[axis] - bounds[`min${axis.toUpperCase()}`];
      else if (normal < 0) originLocal[axis] = surfaceLocal[axis] - bounds[`max${axis.toUpperCase()}`];
      originLocal[axis] = this.snapEntityPlacementMicroValue(originLocal[axis]);
    }

    const position = this.targetEntityLocalToWorld(target, nodeId, originLocal);
    const outwardWorld = localNormal.clone().applyQuaternion(targetWorldRotation).normalize();
    for (let step = 0; step <= ENTITY_TARGET_PLACEMENT_MAX_OUTWARD_STEPS; step++) {
      if (!this.entitySlotOverlapsTarget(slot, position, worldRotation, target)) {
        return { position, quaternion: worldRotation, localNormal };
      }
      position.addScaledVector(outwardWorld, 1 / MICRO_DIVISIONS);
    }
    return null;
  }

  /** Drop (or minimally lift) a centred entity until sampled bottom faces meet terrain. */
  private resolveEntityTerrainSupport(
    shape: EntityPlacementShape,
    origin: THREE.Vector3,
    placementHit
  ) {
    const normalY = Number(placementHit?.normal?.y) || 0;
    let bestOriginY = -Infinity;
    let supported = false;
    const down = new THREE.Vector3(0, -1, 0);
    const canRaycastStandard = typeof this.world?.raycast === 'function';
    const canRaycastMicro = typeof this.world?.raycastMicro === 'function';

    if (canRaycastStandard || canRaycastMicro) {
      // Start just below a downward-facing hit so the ceiling voxel itself is
      // not mistaken for support. Other faces start above the placed shape.
      const startY = origin.y + shape.maxY + (normalY < -0.5 ? -0.05 : 0.05);
      for (const sample of shape.supportSamples) {
        const lowestSurfaceY = origin.y + sample.bottom - ENTITY_PLACEMENT_MAX_DROP;
        const maxDistance = Math.max(0.05, startY - lowestSurfaceY);
        const rayOrigin = new THREE.Vector3(
          origin.x + sample.x,
          startY,
          origin.z + sample.z
        );
        for (const raycast of [
          canRaycastStandard ? this.world.raycast(rayOrigin, down, maxDistance) : null,
          canRaycastMicro ? this.world.raycastMicro(rayOrigin, down, maxDistance) : null
        ]) {
          const distance = Number(raycast?.distance);
          if (!raycast?.hit || !Number.isFinite(distance)
            || distance < -ENTITY_PLACEMENT_EPSILON
            || distance > maxDistance + ENTITY_PLACEMENT_EPSILON) continue;
          const supportTop = startY - Math.max(0, distance);
          bestOriginY = Math.max(bestOriginY, supportTop - sample.bottom);
          supported = true;
        }
      }
    }

    return {
      y: this.clampEntityPlacementY(
        shape,
        supported ? bestOriginY : origin.y
      ),
      supported
    };
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
  getInventoryPlacementPose(slot) {
    if (!slot || !Array.isArray(slot.blocks) || slot.blocks.length === 0) return null;

    const placementHit = this.getInventoryPlacementHit();
    if (!placementHit) return null;

    if (this.usesMicroBlockSetPlacement(slot)) {
      const position = this.getMicroBlockSetPlacementPosition(placementHit);
      if (!position) return null;
      return { slot, kind: 'blockset', position };
    }

    const hp = placementHit.hitPos;
    const n = placementHit.normal;
    const position = new THREE.Vector3(
      hp.x + (n?.x || 0),
      hp.y + (n?.y || 0),
      hp.z + (n?.z || 0)
    );
    const quaternion = new THREE.Quaternion();

    if (slot.kind === 'blockset') {
      position.set(
        Math.floor(position.x),
        Math.floor(position.y),
        Math.floor(position.z)
      );
    } else {
      const shape = this.getEntityPlacementShape(slot);
      const surface = this.getEntityPlacementSurfacePoint(placementHit);
      if (shape && surface) {
        if (placementHit.targetContraption) {
          const targetPose = this.resolveEntityTargetPlacement(slot, shape, surface, placementHit);
          if (!targetPose) return null;
          position.copy(targetPose.position);
          quaternion.copy(targetPose.quaternion);
        } else {
          const placementRotation = this.getEntityPlacementRotation(slot);
          const terrainShape = this.getRotatedEntityTerrainShape(shape, placementRotation);
          quaternion.copy(placementRotation);
          const normal = placementHit.normal || { x: 0, y: 1, z: 0 };
          let originX = surface.x - terrainShape.centerX;
          let originY = surface.y - terrainShape.minY;
          let originZ = surface.z - terrainShape.centerZ;
          // On a wall or ceiling, keep the nearest authored face outside the
          // hit surface instead of centring half of the entity inside terrain.
          if ((Number(normal.x) || 0) > 0.5) originX = surface.x - terrainShape.minX;
          else if ((Number(normal.x) || 0) < -0.5) originX = surface.x - terrainShape.maxX;
          if ((Number(normal.z) || 0) > 0.5) originZ = surface.z - terrainShape.minZ;
          else if ((Number(normal.z) || 0) < -0.5) originZ = surface.z - terrainShape.maxZ;
          if ((Number(normal.y) || 0) < -0.5) originY = surface.y - terrainShape.maxY;
          const candidateOrigin = new THREE.Vector3(originX, originY, originZ);
          candidateOrigin.y = this.clampEntityPlacementY(terrainShape, candidateOrigin.y);
          position.copy(candidateOrigin);
          position.y = this.resolveEntityTerrainSupport(terrainShape, position, placementHit).y;
        }
      }
    }

    return {
      slot,
      kind: slot.kind === 'blockset' ? 'blockset' : 'entity',
      position,
      quaternion,
      targetContraption: placementHit.targetContraption || null,
      targetNodeId: placementHit.targetNodeId || null
    };
  }

  /** Refresh the Hammer hover ghost without mutating either world or entity state. */
  updateInventoryPlacementPreview() {
    this.inventoryPlacementPreview = null;
    if (this.activeTool !== SpecialTool.HAMMER) return;
    // Color sets apply to the palette with left-click — no placement ghost.
    if (this.activeInventoryCategory === 'colorset') return;
    const slot = this.getActiveHammerInventoryItem();
    if (!slot) return;
    this.inventoryPlacementPreview = this.getInventoryPlacementPose(slot);
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
  private applyBlockSetVoxel(target, block, replace = false) {
    if ((block.size || 1) < 1) {
      if (replace) {
        // Micro voxels cannot coexist with a standard block, so overwrite
        // mode clears the parent cell before writing the micro voxel.
        const wx = Math.round(target.x + block.dx);
        const wy = Math.round(target.y + block.dy);
        const wz = Math.round(target.z + block.dz);
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
          Math.round((target.x + block.dx) * MICRO_DIVISIONS),
          Math.round((target.y + block.dy) * MICRO_DIVISIONS),
          Math.round((target.z + block.dz) * MICRO_DIVISIONS)
        ],
        color: block.color,
        part: block.part || null,
        replace
      });
      return result.placed || 0;
    }

    const result = this.performBasicAction({
      domain: ActionDomain.WORLD,
      action: 'place-standard',
      cell: {
        x: target.x + Math.round(block.dx),
        y: target.y + Math.round(block.dy),
        z: target.z + Math.round(block.dz)
      },
      block: block.block || BlockTypes.COLOR_BLOCK,
      color: block.color,
      replace
    });
    return result.placed || 0;
  }

  private finishBlockSetPaste(target, total, placed, replace) {
    if (placed > 0) this.sound?.playBlockPlace?.();
    if (!this.ui) return;
    const skipped = Math.max(0, total - placed);
    const where = `at (${target.x}, ${target.y}, ${target.z})`;
    this.ui.showToast(replace
      ? `Overwrote block set: ${placed}/${total} plain blocks ${where}`
      : skipped > 0
        ? `Built block set: ${placed}/${total} plain blocks ${where} · ${skipped} occupied cell(s) skipped`
        : `Built block set: ${placed}/${total} plain blocks ${where}`);
  }

  pasteBlockSet(slot, replace = false) {
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
        step: index => {
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
   * Put an externally generated block set, such as an STL import, into the first
   * empty block-set slot. Its format and Hammer left-click placement behavior
   * matches block sets copied with T.
   * @returns The written slot, or null.
   */
  importBlockSetToInventory(blocks, name = 'STL import') {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      if (this.ui) this.ui.showToast('Nothing to import - the source produced no voxels');
      return null;
    }
    const slot = { kind: 'blockset', name, blocks, blockCount: blocks.length };
    const index = this.addInventoryItem('blockset', slot);
    if (index === null) {
      if (this.ui) this.ui.showToast(`Block set inventory is full (99) - cannot import ${name}`);
      return null;
    }
    this.setActiveInventoryCategory('blockset');
    this.ui?.renderInventoryBar?.();
    if (this.ui) {
      this.ui.showToast(`Imported ${name}: ${blocks.length} voxels into block set slot ${index + 1} · Hammer LMB builds · RMB rotates 90°`);
    }
    return slot;
  }

  private finishWorldSelectionDelete(standard, micro) {
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

  private startLargeWorldSelectionDelete(manager, microSelection, bounds) {
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
        step: index => {
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
            let block = this.world.getMicroBlock?.(cell.x, cell.y, cell.z);
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
        step: index => {
          const cell = cells[index];
          const wx = Math.floor(cell.x / MICRO_DIVISIONS);
          const wy = Math.floor(cell.y / MICRO_DIVISIONS);
          const wz = Math.floor(cell.z / MICRO_DIVISIONS);
          let block = this.world.getMicroBlock?.(cell.x, cell.y, cell.z);
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
    const sizeY = bounds.maxY - bounds.minY + 1;
    const sizeZ = bounds.maxZ - bounds.minZ + 1;
    const total = sparseCells?.length
      ?? (bounds.maxX - bounds.minX + 1) * sizeY * sizeZ;
    const cellAt = index => {
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
      step: index => {
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

  private startLargeWorldSelectionFill(manager, partition, bounds, color) {
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
        step: index => {
          if (index < stdCells.length) {
            const cell = stdCells[index];
            const result = this.performBasicAction({
              domain: ActionDomain.WORLD,
              action: 'place-standard',
              cell,
              color,
              replace: true
            });
            if (result.placed) placedStandard++;
            return result.placed || 0;
          } else {
            const cell = microCells[index - stdCells.length];
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
              color,
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
    const sizeY = bounds.maxY - bounds.minY + 1;
    const sizeZ = bounds.maxZ - bounds.minZ + 1;
    const total = sparseCells?.length ?? (bounds.maxX - bounds.minX + 1) * sizeY * sizeZ;
    const cellAt = index => {
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
      step: index => {
        const cell = cellAt(index);
        const result = this.performBasicAction({
          domain: ActionDomain.WORLD,
          action: 'place-standard',
          cell,
          color,
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

  private startLargeWorldSelectionPaint(manager, partition, bounds, color, fromColor?: number) {
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
        step: index => {
          if (index < stdCells.length) {
            const cell = stdCells[index];
            const currColor = this.world.getBlockColor?.(cell.x, cell.y, cell.z);
            if (fromColor === undefined || currColor === fromColor) {
              const result = this.performBasicAction({
                domain: ActionDomain.WORLD,
                action: 'paint-standard',
                cell,
                color
              });
              if (result.painted) paintedStandard++;
              return result.painted || 0;
            }
            return 0;
          } else {
            const cell = microCells[index - stdCells.length];
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
                color
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
    const sizeY = bounds.maxY - bounds.minY + 1;
    const sizeZ = bounds.maxZ - bounds.minZ + 1;
    const total = sparseCells?.length ?? (bounds.maxX - bounds.minX + 1) * sizeY * sizeZ;
    const cellAt = index => {
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
      step: index => {
        const cell = cellAt(index);
        const currColor = this.world.getBlockColor?.(cell.x, cell.y, cell.z);
        if (fromColor === undefined || currColor === fromColor) {
          const result = this.performBasicAction({
            domain: ActionDomain.WORLD,
            action: 'paint-standard',
            cell,
            color
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
   * Delete removes blocks in the current selection and then resets the selection.
   *
   * - Entity subtree selection removes the selected component and descendants;
   *   selecting root removes the whole entity.
   * - Entity block selection removes selected standard and microblocks directly
   *   owned by a component, removing the entity when it becomes empty.
   * - World box or Shift single-cell selection removes standard and 8x8x8 microblocks.
   */
  deleteSelectionBlocks() {
    const manager = this.contraptions;
    if (!manager) return;
    if (this.bulkEditJob) {
      this.ui?.showToast?.(`Please wait for ${this.bulkEditJob.label.toLowerCase()} to finish`);
      return;
    }

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
        const kind = result.removed > 1
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

    // 2. Delete a selected entity/component subtree through the same selection
    // command used by ctx.selection.delete(). Root selection removes the entity;
    // child selection removes that component and all descendants.
    if (this.selectedSubtree?.contraption) {
      const { contraption, rootId, nodeIds } = this.selectedSubtree;
      const result = this.performBasicAction({
        domain: ActionDomain.SELECTION,
        action: 'delete',
        selection: { kind: 'entity-subtree', contraption, rootId, nodeId: rootId, nodeIds }
      });
      this.selectedSubtree = null;
      this.selectedBlockSelection = null;
      this.selectorLevel = null;
      this.selectorRange = null;
      if (this.hoveredContraption === contraption) this.hoveredContraption = null;
      if (this.hoveredContraptionHit?.contraption === contraption) this.hoveredContraptionHit = null;

      if (result.ok) {
        if ((result.removed || 0) > 0) {
          const kind = result.removed > 1 ? 'bulk' : result.micro > 0 ? 'micro' : 'standard';
          this.sound?.playBlockBreak({ kind, count: result.removed });
        }
        if (result.entities > 0) {
          this.ui?.notifyContraptionRemoved?.(contraption);
          this.ui?.showToast(`Deleted entity ${result.entityId || `#${contraption.id}`} (${result.removed} voxels)`);
        } else {
          this.ui?.notifyContraptionStructureChanged?.(contraption);
          const descendants = Math.max(0, (result.components || 1) - 1);
          const suffix = descendants > 0 ? ` and ${descendants} descendant component${descendants === 1 ? '' : 's'}` : '';
          this.ui?.showToast(`Deleted component [${rootId}]${suffix} (${result.removed} voxels)`);
        }
      } else {
        this.ui?.showToast(result.reason === 'entity_not_stopped'
          ? 'Stop the entity before deleting an internal component'
          : 'Selected entity no longer exists');
      }
      return;
    }

    // 3. Delete a two-point world box or Shift-selected cells (standard or
    // Tab-toggled micro mode).
    if (!this.world || !manager.hasValidSelection()) {
      if (this.ui) this.ui.showToast('Nothing selected - box-select a region with the selector first, then press Del');
      return;
    }
    const microSelection = manager.microSelection;
    const isMicroSelection = Array.isArray(microSelection) || manager.microBounds !== null;
    const partition = isMicroSelection && manager.partitionMicroSelection ? manager.partitionMicroSelection() : null;
    const bounds = isMicroSelection ? null : manager.getSelectionBounds();
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
          : (bounds.maxX - bounds.minX + 1)
            * (bounds.maxY - bounds.minY + 1)
            * (bounds.maxZ - bounds.minZ + 1);
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
        let block = this.world.getMicroBlock?.(cell.x, cell.y, cell.z);
        if (!block) {
          const wx = Math.floor(cell.x / MICRO_DIVISIONS);
          const wy = Math.floor(cell.y / MICRO_DIVISIONS);
          const wz = Math.floor(cell.z / MICRO_DIVISIONS);
          if (this.world.getBlock && this.world.getBlock(wx, wy, wz) !== BlockTypes.AIR) {
            block = { color: this.world.getBlockColor(wx, wy, wz) };
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
      const collectCell = (x, y, z) => {
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
        // Shift single-cell mode deletes only explicitly selected cells.
        for (const cell of manager.connectedSelection) collectCell(cell.x, cell.y, cell.z);
      } else {
        for (let x = bounds.minX; x <= bounds.maxX; x++) {
          for (let y = bounds.minY; y <= bounds.maxY; y++) {
            for (let z = bounds.minZ; z <= bounds.maxZ; z++) collectCell(x, y, z);
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

    const color = targetColor ?? this.selectedColor;

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

      let targetCoords: Array<{ x: number; y: number; z: number }> = [];
      if (Array.isArray(shapeCells) && shapeCells.length > 0) {
        targetCoords = shapeCells;
      } else if (bounds) {
        for (let x = bounds.minX; x <= bounds.maxX; x++) {
          for (let y = bounds.minY; y <= bounds.maxY; y++) {
            for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
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
        color,
        micro: isMicro
      });

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

    const largeSelectionCount = partition
      ? partition.standardCells.length + partition.microCells.length
      : isMicroSelection
        ? manager.microSelection?.length || 0
        : manager.connectedSelection !== null
          ? manager.connectedSelection.length
          : (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1) * (bounds.maxZ - bounds.minZ + 1);

    if (largeSelectionCount > BULK_EDIT_THRESHOLD) {
      this.startLargeWorldSelectionFill(manager, partition, bounds, color);
      return;
    }

    const result = this.performBasicAction({
      domain: ActionDomain.SELECTION,
      action: 'fill',
      color
    });

    if (result.ok && (result.placed || 0) > 0) {
      this.sound?.playBlockPlace?.();
      const parts = [];
      if (result.standard > 0) parts.push(`${result.standard} blocks`);
      if (result.micro > 0) parts.push(`${result.micro} micro voxels`);
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

    const color = targetColor ?? this.selectedColor;

    // 1. Entity blocks recolor
    if (this.selectedBlockSelection && this.selectedBlockSelection.blocks.length > 0) {
      // Recoloring mutates geometry, so virtual micro cells are subdivided first.
      if (!this.materializeMicroSelection()) return;
      const { contraption, nodeId, blocks } = this.selectedBlockSelection;
      const targetBlocks = fromColor !== undefined
        ? blocks.filter(b => b.color === fromColor)
        : blocks;
      const result = this.performBasicAction({
        domain: ActionDomain.ENTITY,
        action: 'paint-blocks',
        target: { contraption },
        nodeId,
        blocks: targetBlocks,
        color
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
        options: fromColor !== undefined ? { fromColor } : null
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

    const largeSelectionCount = partition
      ? partition.standardCells.length + partition.microCells.length
      : isMicroSelection
        ? manager.microSelection?.length || 0
        : manager.connectedSelection !== null
          ? manager.connectedSelection.length
          : (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1) * (bounds.maxZ - bounds.minZ + 1);

    if (largeSelectionCount > BULK_EDIT_THRESHOLD) {
      this.startLargeWorldSelectionPaint(manager, partition, bounds, color, fromColor);
      return;
    }

    const result = this.performBasicAction({
      domain: ActionDomain.SELECTION,
      action: 'paint',
      color,
      options: fromColor !== undefined ? { fromColor } : null
    });

    if (result.ok && (result.painted || 0) > 0) {
      this.sound?.playBlockPlace?.();
      const parts = [];
      if (result.standard > 0) parts.push(`${result.standard} blocks`);
      if (result.micro > 0) parts.push(`${result.micro} micro voxels`);
      this.ui?.showToast?.(`Recolored ${parts.join(' + ') || `${result.painted} voxels`} to ${colorToHex(color)}`);
    } else {
      this.ui?.showToast?.('Selection region contains no matching blocks to recolor');
    }
  }

  handleRightClick(e = null) {
    if (this.bulkEditJob) {
      this.ui?.showToast?.(`Please wait for ${this.bulkEditJob.label.toLowerCase()} to finish`);
      return false;
    }
    const isRecolorModifier = e && (e.shiftKey || this.keys.crouch);

    // 1. Shovel -> place one standard block, replacing micro cells in the cell.
    // When Shift is held, recolor the targeted block without placing a new one.
    if (this.activeTool === SpecialTool.SHOVEL) {
      if (isRecolorModifier) {
        this.paintTargetedBlock();
        return;
      }

      if (this.hoveredContraptionHit) {
        const hit = this.hoveredContraptionHit;
        const c = hit.contraption;
        const targetNodeId = hit.entityId ?? contraptionRootId(c);
        // When targeting micro voxels, treat the carved cell as one 1x1x1
        // block: the placement target is its neighbor along the normal; the
        // carved cell itself is never overwritten.
        const targetCell = hit.kind === 'micro'
          ? {
              x: hit.cell.x + (hit.normal?.x || 0),
              y: hit.cell.y + (hit.normal?.y || 0),
              z: hit.cell.z + (hit.normal?.z || 0)
            }
          : hit.placeCell;

        const result = this.performBasicAction({
          domain: ActionDomain.ENTITY,
          action: 'place-standard',
          target: { contraption: c },
          nodeId: targetNodeId,
          cell: targetCell,
          color: this.selectedColor
        });
        if (!result.ok) {
          if (result.reason === 'occupied' && this.ui) {
            this.ui.showToast('Target cell is occupied; the shovel never overwrites existing geometry');
          }
          return;
        }
        this.ui?.notifyContraptionStructureChanged(c);
        this.sound.playBlockPlace();
        if (this.ui) {
          this.ui.showToast(`Added 1 standard block to [${targetNodeId}]`);
        }
        return;
      }

      if (!this.currentRaycast.hit) return;

      let target;
      if (this.currentRaycast.kind === 'micro') {
        // Carved cell is treated as one block: target = neighbor along the normal
        const mp = this.currentRaycast.microPos;
        const normal = this.currentRaycast.normal;
        target = {
          x: Math.floor(mp.x / MICRO_DIVISIONS) + (normal?.x || 0),
          y: Math.floor(mp.y / MICRO_DIVISIONS) + (normal?.y || 0),
          z: Math.floor(mp.z / MICRO_DIVISIONS) + (normal?.z || 0)
        };
      } else {
        target = this.currentRaycast.placePos;
      }
      if (!this.canPlaceStandardAt(target)) return;
      const result = this.performBasicAction({
        domain: ActionDomain.WORLD,
        action: 'place-standard',
        cell: target,
        color: this.selectedColor
      });
      if (!result.ok && result.reason === 'occupied') {
        if (this.ui) this.ui.showToast('Target cell is occupied; the shovel never overwrites existing geometry');
        return;
      }
      this.sound.playBlockPlace();
      return;
    }

    // 2. Spoon -> place one 1/5-scale micro block on the targeted surface.
    // When Shift is held, recolor the targeted micro block.
    if (this.activeTool === SpecialTool.SPOON) {
      if (isRecolorModifier) {
        this.paintTargetedBlock();
        return;
      }

      if (this.hoveredContraptionHit) {
        const hit = this.hoveredContraptionHit;
        const c = hit.contraption;
        const targetNodeId = hit.entityId ?? contraptionRootId(c);
        const placePos = hit.placeMicroPos;
        const mx = Math.round(placePos.localX * MICRO_DIVISIONS) / MICRO_DIVISIONS;
        const my = Math.round(placePos.localY * MICRO_DIVISIONS) / MICRO_DIVISIONS;
        const mz = Math.round(placePos.localZ * MICRO_DIVISIONS) / MICRO_DIVISIONS;

        const result = this.performBasicAction({
          domain: ActionDomain.ENTITY,
          action: 'place-micro',
          target: { contraption: c },
          nodeId: targetNodeId,
          micro: [Math.round(mx * MICRO_DIVISIONS), Math.round(my * MICRO_DIVISIONS), Math.round(mz * MICRO_DIVISIONS)],
          color: this.selectedColor
        });

        if (result.ok) {
          this.ui?.notifyContraptionStructureChanged(c);
          this.sound.playBlockPlace();
          if (this.ui) {
            this.ui.showToast(`Added 1 micro voxel to [${targetNodeId}]`);
          }
        }
        return;
      }

      if (!this.currentRaycast.hit) return;

      let targetMicro = this.currentRaycast.placeMicroPos;
      if (this.currentRaycast.kind === 'standard') {
        const normal = this.currentRaycast.normal;
        const entry = this.currentRaycast.entry
          ? new THREE.Vector3(this.currentRaycast.entry.x, this.currentRaycast.entry.y, this.currentRaycast.entry.z)
          : this.physics.getEyePosition();
        entry.x += normal.x * 0.02;
        entry.y += normal.y * 0.02;
        entry.z += normal.z * 0.02;
        targetMicro = {
          x: Math.floor(entry.x * MICRO_DIVISIONS),
          y: Math.floor(entry.y * MICRO_DIVISIONS),
          z: Math.floor(entry.z * MICRO_DIVISIONS)
        };
      }
      const result = targetMicro && this.performBasicAction({
        domain: ActionDomain.WORLD,
        action: 'place-micro',
        micro: targetMicro,
        color: this.selectedColor
      });
      if (result?.ok) {
        this.sound.playBlockPlace();
      }
      return;
    }

    // 3. Brush -> Right-click 2-point box selection and dye region
    if (this.activeTool === SpecialTool.BRUSH) {
      this.handleBrushRightClick();
      return;
    }

    // 4. Pipette -> Sample color on right click as well
    if (this.activeTool === SpecialTool.PIPETTE) {
      this.sampleTargetedColor();
      return;
    }

    // Wrench right-click starts entity runtime.
    if (this.activeTool === SpecialTool.WRENCH) {
      this.startHoveredEntity();
      return;
    }

    // Hammer RMB rotates the active inventory item 90 degrees around Y axis,
    // centered at the integer/grid-aligned center of the object.
    if (this.activeTool === SpecialTool.HAMMER) {
      return this.rotateActiveInventoryItem();
    }

    // Selector intentionally has no right-click action.
    return;
  }

  private normalizeQuarterTurns(turns = 0) {
    const wholeTurns = Number.isFinite(turns) ? Math.trunc(turns) : 0;
    return ((wholeTurns % 4) + 4) % 4;
  }

  /**
   * Rotate a set of voxel blocks around the X axis by `quarterTurns * 90°`.
   * The result is calculated directly from the supplied original coordinates,
   * never by repeatedly rotating an already rounded intermediate result.
   */
  rotateBlocksX90(blocks: any[], quarterTurns = 1) {
    if (!Array.isArray(blocks) || blocks.length === 0) return blocks;

    const turns = this.normalizeQuarterTurns(quarterTurns);
    if (turns === 0) return blocks.map(block => ({ ...block }));

    const isEntity = 'localX' in blocks[0] || 'localY' in blocks[0];
    const hasMicro = blocks.some(b => (b.size && b.size < 1) || (isEntity ? (!Number.isInteger(b.localY ?? 0) || !Number.isInteger(b.localZ ?? 0)) : (!Number.isInteger(b.dy ?? 0) || !Number.isInteger(b.dz ?? 0))));
    const S = hasMicro ? MICRO_SIZE : 1.0;

    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (const b of blocks) {
      const y = isEntity ? (b.localY ?? 0) : (b.dy ?? 0);
      const z = isEntity ? (b.localZ ?? 0) : (b.dz ?? 0);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;

    const rotatePoint = (y: number, z: number) => {
      if (turns === 1) return [cy + cz - z, cz - cy + y];
      if (turns === 2) return [2 * cy - y, 2 * cz - z];
      return [cy - cz + z, cz + cy - y];
    };

    // Rotating an even-height/depth shape around its geometric center can land its
    // lower-corner coordinates on half cells. Apply one deterministic grid
    // correction derived from the original bounds for this final orientation.
    const [sampleY, sampleZ] = rotatePoint(minY, minZ);
    const gridUnitsY = sampleY / S;
    const gridUnitsZ = sampleZ / S;
    const remY = (gridUnitsY - Math.round(gridUnitsY)) * S;
    const remZ = (gridUnitsZ - Math.round(gridUnitsZ)) * S;

    return blocks.map(b => {
      const y = isEntity ? (b.localY ?? 0) : (b.dy ?? 0);
      const z = isEntity ? (b.localZ ?? 0) : (b.dz ?? 0);

      const rotated = rotatePoint(y, z);
      let ry = rotated[0] - remY;
      let rz = rotated[1] - remZ;

      if (hasMicro) {
        ry = Math.round(ry * MICRO_DIVISIONS) / MICRO_DIVISIONS;
        rz = Math.round(rz * MICRO_DIVISIONS) / MICRO_DIVISIONS;
      } else {
        ry = Math.round(ry);
        rz = Math.round(rz);
      }

      if (isEntity) {
        return { ...b, localY: ry, localZ: rz };
      } else {
        return { ...b, dy: ry, dz: rz };
      }
    });
  }

  /**
   * Rotate a set of voxel blocks around the Y axis by `quarterTurns * 90°`.
   * The result is calculated directly from the supplied original coordinates,
   * never by repeatedly rotating an already rounded intermediate result.
   */
  rotateBlocksY90(blocks: any[], quarterTurns = 1) {
    if (!Array.isArray(blocks) || blocks.length === 0) return blocks;

    const turns = this.normalizeQuarterTurns(quarterTurns);
    if (turns === 0) return blocks.map(block => ({ ...block }));

    const isEntity = 'localX' in blocks[0];
    const hasMicro = blocks.some(b => (b.size && b.size < 1) || (isEntity ? (!Number.isInteger(b.localX ?? 0) || !Number.isInteger(b.localZ ?? 0)) : (!Number.isInteger(b.dx ?? 0) || !Number.isInteger(b.dz ?? 0))));
    const S = hasMicro ? MICRO_SIZE : 1.0;

    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (const b of blocks) {
      const x = isEntity ? (b.localX ?? 0) : (b.dx ?? 0);
      const z = isEntity ? (b.localZ ?? 0) : (b.dz ?? 0);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;

    const rotatePoint = (x, z) => {
      if (turns === 1) return [cx + cz - z, cz - cx + x];
      if (turns === 2) return [2 * cx - x, 2 * cz - z];
      return [cx - cz + z, cz + cx - x];
    };

    // Rotating an even-width shape around its geometric center can land its
    // lower-corner coordinates on half cells. Apply one deterministic grid
    // correction derived from the original bounds for this final orientation.
    const [sampleX, sampleZ] = rotatePoint(minX, minZ);
    const gridUnitsX = sampleX / S;
    const gridUnitsZ = sampleZ / S;
    const remX = (gridUnitsX - Math.round(gridUnitsX)) * S;
    const remZ = (gridUnitsZ - Math.round(gridUnitsZ)) * S;

    return blocks.map(b => {
      const x = isEntity ? (b.localX ?? 0) : (b.dx ?? 0);
      const z = isEntity ? (b.localZ ?? 0) : (b.dz ?? 0);

      const rotated = rotatePoint(x, z);
      let rx = rotated[0] - remX;
      let rz = rotated[1] - remZ;

      if (hasMicro) {
        rx = Math.round(rx * MICRO_DIVISIONS) / MICRO_DIVISIONS;
        rz = Math.round(rz * MICRO_DIVISIONS) / MICRO_DIVISIONS;
      } else {
        rx = Math.round(rx);
        rz = Math.round(rz);
      }

      if (isEntity) {
        return { ...b, localX: rx, localZ: rz };
      } else {
        return { ...b, dx: rx, dz: rz };
      }
    });
  }

  /**
   * Rotate child entity definitions around the same center (cy, cz).
   */
  private rotateChildDefinitionsX90(childEntities: any[], quarterTurns = 1, center: { cy: number; cz: number } | null = null) {
    if (!Array.isArray(childEntities) || childEntities.length === 0) return childEntities;
    const turns = this.normalizeQuarterTurns(quarterTurns);
    if (turns === 0) return childEntities.map(child => ({
      ...child,
      position: child.position ? { ...child.position } : child.position
    }));
    return childEntities.map(child => {
      const pos = child.position || { x: 0, y: 0, z: 0 };
      const cy = center ? center.cy : 0;
      const cz = center ? center.cz : 0;
      const ry = turns === 1
        ? cy + cz - pos.z
        : turns === 2
          ? 2 * cy - pos.y
          : cy - cz + pos.z;
      const rz = turns === 1
        ? cz - cy + pos.y
        : turns === 2
          ? 2 * cz - pos.z
          : cz + cy - pos.y;
      return {
        ...child,
        position: {
          x: pos.x,
          y: Math.round(ry * MICRO_DIVISIONS) / MICRO_DIVISIONS,
          z: Math.round(rz * MICRO_DIVISIONS) / MICRO_DIVISIONS
        }
      };
    });
  }

  /**
   * Rotate child entity definitions around the same center (cx, cz).
   */
  private rotateChildDefinitionsY90(childEntities: any[], quarterTurns = 1, center: { cx: number; cz: number } | null = null) {
    if (!Array.isArray(childEntities) || childEntities.length === 0) return childEntities;
    const turns = this.normalizeQuarterTurns(quarterTurns);
    if (turns === 0) return childEntities.map(child => ({
      ...child,
      position: child.position ? { ...child.position } : child.position
    }));
    return childEntities.map(child => {
      const pos = child.position || { x: 0, y: 0, z: 0 };
      const cx = center ? center.cx : 0;
      const cz = center ? center.cz : 0;
      const rx = turns === 1
        ? cx + cz - pos.z
        : turns === 2
          ? 2 * cx - pos.x
          : cx - cz + pos.z;
      const rz = turns === 1
        ? cz - cx + pos.x
        : turns === 2
          ? 2 * cz - pos.z
          : cz + cx - pos.x;
      return {
        ...child,
        position: {
          x: Math.round(rx * MICRO_DIVISIONS) / MICRO_DIVISIONS,
          y: pos.y,
          z: Math.round(rz * MICRO_DIVISIONS) / MICRO_DIVISIONS
        }
      };
    });
  }

  /** Clear the Hammer's placement-only rotation without touching inventory data. */
  clearHammerRotation() {
    this.hammerRotationTurnsY = 0;
    this.hammerRotationTurnsX = 0;
    this.hammerRotatedSlotSource = null;
    this.hammerRotatedSlotTurnsKey = null;
    this.hammerRotatedSlotCache = null;
    this.inventoryPlacementPreview = null;
    if (this.sceneRenderer) this.sceneRenderer.inventoryPlacementSlot = null;
  }

  /** Return the active item in its temporary Hammer placement orientation. */
  getActiveHammerInventoryItem() {
    const slot = this.inventorySlots?.[this.selectedInventoryIndex];
    if (!slot) return null;

    const turnsY = this.normalizeQuarterTurns(this.hammerRotationTurnsY);
    const turnsX = this.normalizeQuarterTurns(this.hammerRotationTurnsX);
    if (turnsY === 0 && turnsX === 0) return slot;

    const cacheKey = `${turnsY}:${turnsX}`;
    if (this.hammerRotatedSlotSource === slot &&
        this.hammerRotatedSlotTurnsKey === cacheKey &&
        this.hammerRotatedSlotCache) {
      return this.hammerRotatedSlotCache;
    }

    const isEntity = slot.kind === 'entity' || this.activeInventoryCategory === 'entity';
    const qY = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      turnsY * Math.PI / 2
    );
    const qX = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      turnsX * Math.PI / 2
    );
    const placementRotation = qY.clone().multiply(qX);

    let rotatedBlocks = slot.blocks;
    if (turnsX !== 0 && Array.isArray(rotatedBlocks)) {
      rotatedBlocks = this.rotateBlocksX90(rotatedBlocks, turnsX);
    }
    if (turnsY !== 0 && Array.isArray(rotatedBlocks)) {
      rotatedBlocks = this.rotateBlocksY90(rotatedBlocks, turnsY);
    }

    let rotatedChildren = slot.childEntities;
    if (Array.isArray(rotatedChildren)) {
      if (turnsX !== 0) {
        rotatedChildren = this.rotateChildDefinitionsX90(rotatedChildren, turnsX);
      }
      if (turnsY !== 0) {
        rotatedChildren = this.rotateChildDefinitionsY90(rotatedChildren, turnsY);
      }
    }

    const rotatedSlot = isEntity
      ? {
          ...slot,
          // Entity geometry and scripts stay in their authored local frame.
          // The temporary anchor carries this roll for component installation,
          // while placementRotation carries the same pose for terrain builds.
          anchorRotation: this.getEntityAnchorRotation(slot)
            .multiply(placementRotation.clone().invert())
            .normalize()
            .toArray(),
          placementRotation: placementRotation.toArray()
        }
      : {
          ...slot,
          blocks: rotatedBlocks,
          childEntities: rotatedChildren
        };
    this.hammerRotatedSlotSource = slot;
    this.hammerRotatedSlotTurnsKey = cacheKey;
    this.hammerRotatedSlotCache = rotatedSlot;
    return rotatedSlot;
  }

  /**
   * Advance the active inventory item's temporary rotation by one quarter turn.
   * axis: 'y' for horizontal rotation (yaw), 'x' for vertical rotation (pitch).
   * Every pose is derived from the untouched inventory item plus the total turn count.
   */
  rotateActiveInventoryItem(direction = 1, axis: 'x' | 'y' = 'y') {
    const category = this.activeInventoryCategory;
    if (category === 'colorset') return false;
    const slot = this.inventorySlots?.[this.selectedInventoryIndex];
    if (!slot || !Array.isArray(slot.blocks) || slot.blocks.length === 0) {
      this.ui?.showToast?.('No item in current slot to rotate');
      return false;
    }

    const step = direction >= 0 ? 1 : -1;
    if (axis === 'x') {
      this.hammerRotationTurnsX = this.normalizeQuarterTurns((this.hammerRotationTurnsX || 0) + step);
    } else {
      this.hammerRotationTurnsY = this.normalizeQuarterTurns((this.hammerRotationTurnsY || 0) + step);
    }
    this.hammerRotatedSlotSource = null;
    this.hammerRotatedSlotTurnsKey = null;
    this.hammerRotatedSlotCache = null;

    if (this.sceneRenderer) {
      this.sceneRenderer.inventoryPlacementSlot = null;
    }
    this.updateInventoryPlacementPreview();

    InventoryThumbnailRenderer.getInstance().clearCache();

    this.sound?.playWrenchClick?.();
    const axisLabel = axis === 'x' ? 'pitch' : 'yaw';
    this.ui?.showToast?.(`Rotated "${slot.name || 'item'}" 90° (${axisLabel})`);
    this.ui?.syncInventoryState?.();
    return true;
  }

  rotateActiveInventoryItemY(direction = 1) {
    return this.rotateActiveInventoryItem(direction, 'y');
  }

  rotateActiveInventoryItemX(direction = 1) {
    return this.rotateActiveInventoryItem(direction, 'x');
  }

  private refreshWrenchPivotTargetPose(target = this.wrenchPivotTarget) {
    if (!target?.contraption) return null;
    const contraption = target.contraption;
    if (this.contraptions?.contraptions
      && !this.contraptions.contraptions.includes(contraption)) return null;
    const node = contraption.getEntityNode?.(target.nodeId)
      || contraption.entityNodes?.get?.(target.nodeId);
    if (!node?.group) return null;
    node.group.updateWorldMatrix?.(true, false);
    target.position = contraption.getEntityNodeWorldPosition?.(target.nodeId)
      || node.group.getWorldPosition(new THREE.Vector3());
    target.quaternion = contraption.getEntityNodeWorldQuaternion?.(target.nodeId)
      || node.group.getWorldQuaternion(new THREE.Quaternion());
    const eye = this.physics?.getEyePosition?.() || this.camera?.position || new THREE.Vector3();
    const eyeBent = bendPoint(eye.x, eye.y, eye.z, new THREE.Vector3());
    const pivotBent = bendPoint(
      target.position.x,
      target.position.y,
      target.position.z,
      new THREE.Vector3()
    );
    const distance = eyeBent.distanceTo(pivotBent);
    if (!Number.isFinite(distance) || distance > 12) return null;
    target.axisLength = Math.min(3.5, Math.max(1.2, distance * 0.18));
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
      target.axisLength
    );
    return true;
  }

  updateWrenchPivotGizmo(entityHit) {
    if (this.activeTool !== SpecialTool.WRENCH || !entityHit?.contraption) {
      this.wrenchPivotTarget = null;
      this.sceneRenderer?.clearWrenchPivotGizmo?.();
      return null;
    }
    const nodeId = String(entityHit.entityId ?? contraptionRootId(entityHit.contraption));
    if (
      this.wrenchPivotTarget?.contraption !== entityHit.contraption
      || this.wrenchPivotTarget?.nodeId !== nodeId
    ) {
      this.wrenchPivotTarget = { contraption: entityHit.contraption, nodeId };
    }
    const current = this.refreshWrenchPivotTargetPose();
    if (!current) {
      this.wrenchPivotTarget = null;
      this.sceneRenderer?.clearWrenchPivotGizmo?.();
      return null;
    }
    this.renderWrenchPivotTarget();
    return current;
  }

  clearWrenchPivotDisplay() {
    this.wrenchPivotTarget = null;
    this.sceneRenderer?.clearWrenchPivotGizmo?.();
  }

  getWrenchGrabBodyId(contraption, nodeId = contraptionRootId(contraption)) {
    let currentId = String(nodeId ?? contraptionRootId(contraption));
    while (currentId) {
      const body = contraption.getRigidBody?.(currentId);
      if (body?.type === BodyType.DYNAMIC) return currentId;
      currentId = contraption.getEntityNode?.(currentId)?.parentId || '';
    }
    return null;
  }

  getWrenchTargetPosition(eyePos, targetDistance, anchorPos = eyePos, targetSpace = 'flat') {
    const cameraQuat = this.camera?.quaternion || new THREE.Quaternion();
    const lookDir = new THREE.Vector3(0, 0, -1).applyQuaternion(cameraQuat).normalize();
    if (targetSpace !== 'bent') {
      return eyePos.clone().addScaledVector(lookDir, targetDistance);
    }

    // Picking follows the rendered torus surface in bent space. Keep a held
    // point on that same screen ray; a flat tangent ray can drift far enough
    // from the original hit to kick the body when grabbing begins.
    const eyeBent = bendPoint(eyePos.x, eyePos.y, eyePos.z);
    const lookBent = bendDirection(eyePos.x, eyePos.y, eyePos.z, lookDir).normalize();
    const targetBent = eyeBent.addScaledVector(lookBent, targetDistance);
    const target = unbendPoint(targetBent.x, targetBent.y, targetBent.z);
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

    if (this.wrenchGrab?.contraption === contraption) {
      return true;
    }
    this.releaseWrenchGrab();

    // 1. Unconditionally mark grabbed and stopped so background sync or physics cannot start scripts
    contraption.isWrenchGrabbed = true;
    const wasRunning = contraption.scriptStatus !== 'stopped' || contraption.isPhysicsSimulationEnabled?.() !== false;
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

    // 2. Enable physics simulation so the velocity servo can lift and move the rigid body
    contraption.setPhysicsSimulationEnabled?.(true);

    // 3. Disable physical collision during grab so entity moves freely without collision snagging
    if (typeof contraption.setCollisionSimulationEnabled === 'function') {
      contraption.setCollisionSimulationEnabled(false);
    } else {
      contraption.collisionSimulationEnabled = false;
      contraption.invalidateCollisionPoseCache?.();
    }

    const bodyId = this.getWrenchGrabBodyId(
      contraption,
      this.hoveredContraptionHit?.entityId ?? contraptionRootId(contraption)
    );
    if (!bodyId) {
      contraption.isWrenchGrabbed = false;
      contraption.setPhysicsSimulationEnabled?.(false);
      this.ui?.showToast?.('Wrench: this entity has no dynamic body to grab');
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
      contraption.setPhysicsSimulationEnabled?.(false);
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

  setServerEntityRunStateHandler(handler) {
    this.serverEntityRunStateHandler = typeof handler === 'function' ? handler : null;
  }

  async requestServerEntityRunState(contraption, desiredState, options: any = {}) {
    if (contraption.serverCanControl !== true) {
      if (!options?.silent) {
        this.ui?.showToast?.('Only this entity’s owner can start or stop it');
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
              : `Entity #${contraption.id} start requested for its owner browser`
        );
      }
      return true;
    } catch (error: any) {
      if (!options?.silent) {
        if (error?.code === 'ENTITY_REVISION_CONFLICT') {
          this.ui?.showToast?.('Entity state changed elsewhere; try again');
        } else if (error?.code === 'ENTITY_CONTROL_FORBIDDEN') {
          this.ui?.showToast?.('Only this entity’s owner can start or stop it');
        } else {
          this.ui?.showToast?.('Entity could not be updated');
        }
      }
      return false;
    }
  }

  paintTargetedBlock() {
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
              color: this.selectedColor
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
                color: this.selectedColor
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
            action: isMicro ? 'paint-micro' : 'paint-standard',
            target: { contraption: c },
            nodeId,
            ...(isMicro
              ? { micro: [
                  Math.round(hit.block.localX * MICRO_DIVISIONS),
                  Math.round(hit.block.localY * MICRO_DIVISIONS),
                  Math.round(hit.block.localZ * MICRO_DIVISIONS)
                ] }
              : { cell: hit.cell }),
            color: this.selectedColor
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
          color: this.selectedColor
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
            color: this.selectedColor
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
          color: this.selectedColor
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
          color: this.selectedColor
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
        color: this.selectedColor
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
  collectSubtreeIds(contraption, rootId) {
    const ids = new Set();
    const walk = (id) => {
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
    const index = this.addInventoryItem('entity', slot);
    if (index === null) {
      this.ui?.showToast?.(`Entity inventory is full (${this.inventories.entity.items.length}) - delete one first`);
      return null;
    }
    this.setActiveInventoryCategory('entity');
    this.ui?.renderInventoryBar?.();
    this.clearSelection();
    this.activateTool(SpecialTool.HAMMER);
    if (this.ui) {
      this.ui.showToast(`Copied [${rootId}] (${slot.blockCount} blocks, ${slot.scripts.length} scripts) to entity slot ${index + 1} · switched to Hammer`);
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
    const items = new Array(9).fill(null);
    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(9, value.length); i++) items[i] = value[i];
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

  createEmptyInventories() {
    return {
      blockset: { items: new Array(MAX_BACKPACK_SLOTS_PER_CATEGORY).fill(null), selected: 0 },
      entity: { items: new Array(MAX_BACKPACK_SLOTS_PER_CATEGORY).fill(null), selected: 0 },
      colorset: { items: new Array(MAX_BACKPACK_SLOTS_PER_CATEGORY).fill(null), selected: 0 }
    };
  }

  inventoryCategory() {
    // Lazy bootstrap for prototype-created instances (tests skip the constructor).
    if (!this.inventories) {
      this.inventories = this.createEmptyInventories();
      this.activeInventoryCategory = 'blockset';
    }
    return this.inventories[this.activeInventoryCategory] || this.inventories.blockset;
  }

  /** Switch the hammer bar between blocksets / entities. */
  setActiveInventoryCategory(category) {
    if (!this.inventories) this.inventoryCategory();
    if (!this.inventories[category]) return this.activeInventoryCategory;
    if (this.activeInventoryCategory !== category) this.clearHammerRotation();
    this.activeInventoryCategory = category;
    const group = this.inventories[category];
    group.selected = Number.isInteger(group.selected) && group.selected >= 0 && group.selected < group.items.length
      ? group.selected
      : 0;
    this.saveInventoriesToLocalStorage();
    return category;
  }

  /**
   * Tab key: toggle the hammer bar between block sets (BKS) and entities
   * (ENT). The bar no longer exposes color sets; its renderer snaps a
   * legacy color-set focus back to block sets.
   */
  toggleHammerCategory() {
    const next = this.activeInventoryCategory === 'entity' ? 'blockset' : 'entity';
    this.setActiveInventoryCategory(next);
    this.ui?.renderInventoryBar?.();
    if (this.ui) {
      this.ui.showToast(next === 'entity'
        ? 'Hammer bar: ENTITIES · Tab switches to BLOCK SETS'
        : 'Hammer bar: BLOCK SETS · Tab switches to ENTITIES');
    }
    return next;
  }

  /**
   * Tab key (Selector tool): toggle between standard 1 m block selection
   * (the default) and 0.125 m micro-block selection. Switching granularity
   * discards any in-progress or completed block selection (world box, sparse
   * single cells, entity box) so the two granularities never mix; component
   * subtree selection is unaffected.
   */
  toggleSelectorMicroMode() {
    this.selectorMicroMode = !this.selectorMicroMode;
    if (this.selectedBlockSelection?.contraption?.clearSubtreeHighlight) {
      this.selectedBlockSelection.contraption.clearSubtreeHighlight();
    }
    this.selectedBlockSelection = null;
    this.selectorLevel = null;
    this.selectorRange = null;
    this.selectionShapeAnchor = null;
    this.contraptions?.clearSelection?.();
    if (this.ui) {
      this.ui.updateToolPanelMode?.();
      this.ui.renderHotbar?.();
      this.ui.showToast(this.selectorMicroMode
        ? 'Selector: MICRO mode · Shift+click toggles micro cells · Tab switches to STANDARD'
        : 'Selector: STANDARD mode · Tab switches to MICRO');
    }
    return this.selectorMicroMode;
  }

  /** Switch active geometric selection shape (box, cylinder, sphere, stairs, line). */
  setSelectorShape(shape: SelectorShape) {
    this.selectorShape = shape;
    this.ui?.setSelectorShape?.(shape);
    this.ui?.updateToolPanelMode?.();
    this.applySelectionShape(shape);
  }

  /**
   * Apply geometric selection shape (box, cylinder, sphere, stairs, line) to sub-component selection.
   */
  applyEntitySelectionShape(
    shape: SelectorShape = this.selectorShape,
    anchorA?: { x: number; y: number; z: number },
    anchorB?: { x: number; y: number; z: number }
  ) {
    const contraption = this.selectedBlockSelection?.contraption || this.selectedSubtree?.contraption;
    const nodeId = this.selectedBlockSelection?.nodeId || this.selectedSubtree?.rootId;
    if (!contraption || !nodeId) return;

    const isMicro = this.selectorMicroMode === true;

    if (!this.selectedBlockSelection && this.selectedSubtree) {
      const nodeIds = this.selectedSubtree.nodeIds || this.collectSubtreeIds(contraption, nodeId);
      const subtreeBlocks = contraption.blocks.filter((b: any) => nodeIds.has(contraptionBlockOwnerId(contraption, b)));
      this.selectedBlockSelection = {
        contraption,
        nodeId,
        blocks: subtreeBlocks,
        bounds: this.getEntitySelectionBounds(subtreeBlocks, isMicro)
      };
      this.selectedSubtree = null;
    }

    if (!this.selectedBlockSelection) return;

    let bounds = this.selectedBlockSelection.bounds;
    if (!bounds) {
      bounds = this.getEntitySelectionBounds(this.selectedBlockSelection.blocks, isMicro);
      this.selectedBlockSelection.bounds = bounds;
    }
    if (!bounds) return;

    const cornerA = anchorA || this.selectionShapeAnchor?.cornerA || { x: bounds.minX, y: bounds.minY, z: bounds.minZ };
    const cornerB = anchorB || this.selectionShapeAnchor?.cornerB || { x: bounds.maxX, y: bounds.maxY, z: bounds.maxZ };
    const cylinderAxis = this.selectionShapeAnchor?.cylinderAxis || 'y';
    const stairsAxis = this.selectionShapeAnchor?.stairsAxis;

    this.selectionShapeAnchor = {
      cornerA: { ...cornerA },
      cornerB: { ...cornerB },
      micro: isMicro,
      cylinderAxis,
      stairsAxis
    };

    const minX = Math.min(cornerA.x, cornerB.x);
    const maxX = Math.max(cornerA.x, cornerB.x);
    const minY = Math.min(cornerA.y, cornerB.y);
    const maxY = Math.max(cornerA.y, cornerB.y);
    const minZ = Math.min(cornerA.z, cornerB.z);
    const maxZ = Math.max(cornerA.z, cornerB.z);

    bounds.minX = minX;
    bounds.maxX = maxX;
    bounds.minY = minY;
    bounds.maxY = maxY;
    bounds.minZ = minZ;
    bounds.maxZ = maxZ;

    let matchingBlocks: any[] = [];
    let shapeCells: any[] | null = null;

    if (isMicro) {
      // Virtual micro selection: synthesize 0.125 m cells over covered 1 m blocks
      // without mutating the entity. Del/F/P/G subdivide lazily.
      if (shape === 'box') {
        matchingBlocks = this.buildEntityMicroSelection(contraption, nodeId, (x: number, y: number, z: number) => (
          x >= bounds.minX && x <= bounds.maxX &&
          y >= bounds.minY && y <= bounds.maxY &&
          z >= bounds.minZ && z <= bounds.maxZ
        ), bounds) || [];
      } else {
        shapeCells = computeSelectionCells(shape, cornerA, cornerB, true, cylinderAxis, stairsAxis);
        const cellSet = new Set(shapeCells.map(c => `${c.x},${c.y},${c.z}`));
        matchingBlocks = this.buildEntityMicroSelection(contraption, nodeId, (x: number, y: number, z: number) => (
          cellSet.has(`${x},${y},${z}`)
        ), bounds) || [];
      }
    } else {
    const hasMicroInComponent = contraption.blocks.some((b: any) => contraptionBlockOwnerId(contraption, b) === nodeId && (b.size || 1) < 1);
    if (shape === 'box') {
      const matchingMicro: any[] = [];
      const matchingStandard: any[] = [];
      for (const b of contraption.blocks) {
        if (contraptionBlockOwnerId(contraption, b) !== nodeId) continue;
        const isMicroB = (b.size || 1) < 1;
        const s = (b.size !== undefined && b.size !== null) ? b.size : 1;
        const bx = isMicro ? Math.round(b.localX * MICRO_DIVISIONS) : Math.floor(b.localX + 1e-6);
        const by = isMicro ? Math.round(b.localY * MICRO_DIVISIONS) : Math.floor(b.localY + 1e-6);
        const bz = isMicro ? Math.round(b.localZ * MICRO_DIVISIONS) : Math.floor(b.localZ + 1e-6);
        const bSize = isMicro ? Math.max(1, Math.round(s * MICRO_DIVISIONS)) : 1;
        const maxBx = bx + bSize - 1;
        const maxBy = by + bSize - 1;
        const maxBz = bz + bSize - 1;
        if (!(maxBx < minX || bx > maxX || maxBy < minY || by > maxY || maxBz < minZ || bz > maxZ)) {
          if (isMicroB) {
            matchingMicro.push(b);
          } else {
            matchingStandard.push(b);
          }
        }
      }
      matchingBlocks = (isMicro && hasMicroInComponent && matchingMicro.length > 0)
        ? matchingMicro
        : (isMicro ? (matchingMicro.length > 0 ? matchingMicro : matchingStandard) : [...matchingMicro, ...matchingStandard]);
    } else {
      shapeCells = computeSelectionCells(shape, cornerA, cornerB, isMicro, cylinderAxis, stairsAxis);
      const cellSet = new Set(shapeCells.map(c => `${c.x},${c.y},${c.z}`));
      const matchingMicro: any[] = [];
      const matchingStandard: any[] = [];
      for (const b of contraption.blocks) {
        // Skip blocks owned by other components (parent/root/siblings) instead
        // of aborting: only this component's own blocks may match the shape.
        if (contraptionBlockOwnerId(contraption, b) !== nodeId) continue;
        const isMicroB = (b.size || 1) < 1;
        const s = (b.size !== undefined && b.size !== null) ? b.size : 1;
        const bx = isMicro ? Math.round(b.localX * MICRO_DIVISIONS) : Math.floor(b.localX + 1e-6);
        const by = isMicro ? Math.round(b.localY * MICRO_DIVISIONS) : Math.floor(b.localY + 1e-6);
        const bz = isMicro ? Math.round(b.localZ * MICRO_DIVISIONS) : Math.floor(b.localZ + 1e-6);
        if (s < 1) {
          if (cellSet.has(`${bx},${by},${bz}`)) {
            matchingMicro.push(b);
          }
        } else {
          let intersects = false;
          if (isMicro) {
            for (let ix = 0; ix < MICRO_DIVISIONS && !intersects; ix++) {
              for (let iy = 0; iy < MICRO_DIVISIONS && !intersects; iy++) {
                for (let iz = 0; iz < MICRO_DIVISIONS && !intersects; iz++) {
                  if (cellSet.has(`${bx + ix},${by + iy},${bz + iz}`)) intersects = true;
                }
              }
            }
          } else {
            intersects = cellSet.has(`${bx},${by},${bz}`);
          }
          if (intersects) {
            matchingStandard.push(b);
          }
        }
      }
      matchingBlocks = (isMicro && hasMicroInComponent && matchingMicro.length > 0)
        ? matchingMicro
        : (isMicro ? (matchingMicro.length > 0 ? matchingMicro : matchingStandard) : [...matchingMicro, ...matchingStandard]);
    }
    }

    this.selectedBlockSelection.blocks = matchingBlocks;
    this.selectedBlockSelection.micro = isMicro;
    this.selectedBlockSelection.virtualMicro = matchingBlocks.some((b: any) => b.virtualMicro === true);
    this.selectedBlockSelection.shapeCells = shapeCells;
    contraption.clearSubtreeHighlight?.();
    contraption.highlightBlocks?.(matchingBlocks);
    this.updateSelectionAxisGizmo();

    const node = contraption.entityNodes?.get?.(nodeId);
    const frame = node?.group ? { object: node.group, pivot: (node.pivotLocal || new THREE.Vector3()).clone() } : null;
    if (shape === 'box' || !shapeCells || shapeCells.length === 0) {
      // Micro bounds are expressed in 0.125 m grid units, so the outer guide box
      // must be scaled by MICRO_SIZE too.
      this.sceneRenderer?.updateSelectionHologram?.(bounds, null, null, isMicro, frame);
    } else if (isMicro) {
      this.sceneRenderer?.updateSelectionHologram?.(bounds, null, shapeCells, true, frame);
    } else {
      this.sceneRenderer?.updateSelectionHologram?.(bounds, shapeCells, null, false, frame);
    }
  }

  /**
   * Mathematically compute voxels for the active shape within the selection
   * bounds and update connectedSelection / microSelection.
   */
  applySelectionShape(shape: SelectorShape = this.selectorShape) {
    if (this.selectedBlockSelection || this.selectedSubtree) {
      this.applyEntitySelectionShape(shape);
      return;
    }
    if (!this.contraptions) return;
    const isMicro = this.selectorMicroMode === true;

    // Resolve anchor corners
    let cornerA = this.selectionShapeAnchor?.cornerA;
    let cornerB = this.selectionShapeAnchor?.cornerB;

    if (!cornerA || !cornerB) {
      if (isMicro) {
        const mb = this.contraptions.getMicroSelectionBounds?.();
        if (mb) {
          cornerA = { x: mb.minX, y: mb.minY, z: mb.minZ };
          cornerB = { x: mb.maxX, y: mb.maxY, z: mb.maxZ };
        }
      } else {
        if (this.contraptions.selectionCornerA && this.contraptions.selectionCornerB) {
          cornerA = this.contraptions.selectionCornerA;
          cornerB = this.contraptions.selectionCornerB;
        } else {
          const bounds = this.contraptions.getSelectionBounds?.();
          if (bounds) {
            cornerA = { x: bounds.minX, y: bounds.minY, z: bounds.minZ };
            cornerB = { x: bounds.maxX, y: bounds.maxY, z: bounds.maxZ };
          }
        }
      }
    }

    if (!cornerA || !cornerB) {
      return;
    }

    const cylinderAxis = this.selectionShapeAnchor?.cylinderAxis || 'y';
    const dx = cornerB.x - cornerA.x;
    const dz = cornerB.z - cornerA.z;
    const stairsAxis = this.selectionShapeAnchor?.stairsAxis || (Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z');

    this.selectionShapeAnchor = {
      cornerA: { ...cornerA },
      cornerB: { ...cornerB },
      micro: isMicro,
      cylinderAxis,
      stairsAxis
    };

    if (shape === 'box') {
      if (isMicro) {
        const minX = Math.min(cornerA.x, cornerB.x);
        const maxX = Math.max(cornerA.x, cornerB.x);
        const minY = Math.min(cornerA.y, cornerB.y);
        const maxY = Math.max(cornerA.y, cornerB.y);
        const minZ = Math.min(cornerA.z, cornerB.z);
        const maxZ = Math.max(cornerA.z, cornerB.z);
        this.contraptions.microBounds = { minX, minY, minZ, maxX, maxY, maxZ };
        this.contraptions.microSelection = this.contraptions.materializeMicroBox?.(minX, minY, minZ, maxX, maxY, maxZ) || [];
      } else {
        this.contraptions.connectedSelection = null;
        this.contraptions.selectionCornerA = { ...cornerA };
        this.contraptions.selectionCornerB = { ...cornerB };
      }
    } else {
      const cells = computeSelectionCells(shape, cornerA, cornerB, isMicro, cylinderAxis, stairsAxis);
      if (isMicro) {
        this.contraptions.microSelection = cells;
        this.contraptions.microBounds = null;
      } else {
        this.contraptions.selectionCornerA = { ...cornerA };
        this.contraptions.selectionCornerB = { ...cornerB };
        this.contraptions.connectedSelection = cells;
      }
    }

    const bounds = isMicro
      ? (shape === 'box'
          ? this.contraptions.getMicroSelectionBounds?.()
          : {
              minX: Math.min(cornerA.x, cornerB.x),
              maxX: Math.max(cornerA.x, cornerB.x),
              minY: Math.min(cornerA.y, cornerB.y),
              maxY: Math.max(cornerA.y, cornerB.y),
              minZ: Math.min(cornerA.z, cornerB.z),
              maxZ: Math.max(cornerA.z, cornerB.z)
            })
      : this.contraptions.getSelectionBounds?.();
    this.sceneRenderer?.updateSelectionAxisGizmo?.(bounds, isMicro);
    this.sceneRenderer?.updateSelectionHologram?.(
      bounds,
      this.contraptions.connectedSelection,
      this.contraptions.microSelection,
      isMicro && shape !== 'box'
    );
  }

  /**
   * Rotate the active selection 90° around the selection center.
   * - axis = 'y': Yaw (horizontal rotation, ArrowLeft = -1, ArrowRight = 1)
   * - axis = 'x': Pitch (vertical rotation, ArrowDown = -1, ArrowUp = 1)
   */
  rotateSelection(direction: number = 1, axis: 'x' | 'y' = 'y'): boolean {
    if (!this.contraptions || !this.hasActiveSelection()) {
      return false;
    }

    const isMicro = this.selectorMicroMode === true;
    const isEntity = !!(this.selectedBlockSelection || this.selectedSubtree);

    let cornerA = this.selectionShapeAnchor?.cornerA;
    let cornerB = this.selectionShapeAnchor?.cornerB;

    if (!cornerA || !cornerB) {
      if (isEntity) {
        const contraption = this.selectedBlockSelection?.contraption || this.selectedSubtree?.contraption;
        const nodeId = this.selectedBlockSelection?.nodeId || this.selectedSubtree?.rootId;
        if (contraption && nodeId) {
          const blocks = this.selectedBlockSelection?.blocks || contraption.blocks.filter((b: any) => (this.selectedSubtree?.nodeIds || this.collectSubtreeIds(contraption, nodeId)).has(contraptionBlockOwnerId(contraption, b)));
          const bounds = this.selectedBlockSelection?.bounds || this.getEntitySelectionBounds(blocks, isMicro);
          if (bounds) {
            cornerA = { x: bounds.minX, y: bounds.minY, z: bounds.minZ };
            cornerB = { x: bounds.maxX, y: bounds.maxY, z: bounds.maxZ };
          }
        }
      } else if (isMicro) {
        const mb = this.contraptions.getMicroSelectionBounds?.();
        if (mb) {
          cornerA = { x: mb.minX, y: mb.minY, z: mb.minZ };
          cornerB = { x: mb.maxX, y: mb.maxY, z: mb.maxZ };
        }
      } else {
        if (this.contraptions.selectionCornerA && this.contraptions.selectionCornerB) {
          cornerA = { ...this.contraptions.selectionCornerA };
          cornerB = { ...this.contraptions.selectionCornerB };
        } else {
          const bounds = this.contraptions.getSelectionBounds?.();
          if (bounds) {
            cornerA = { x: bounds.minX, y: bounds.minY, z: bounds.minZ };
            cornerB = { x: bounds.maxX, y: bounds.maxY, z: bounds.maxZ };
          }
        }
      }
    }

    if (!cornerA || !cornerB) return false;

    const minX = Math.min(cornerA.x, cornerB.x);
    const maxX = Math.max(cornerA.x, cornerB.x);
    const minY = Math.min(cornerA.y, cornerB.y);
    const maxY = Math.max(cornerA.y, cornerB.y);
    const minZ = Math.min(cornerA.z, cornerB.z);
    const maxZ = Math.max(cornerA.z, cornerB.z);

    const sizeX = maxX - minX + 1;
    const sizeY = maxY - minY + 1;
    const sizeZ = maxZ - minZ + 1;

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;

    const dx = cornerB.x - cornerA.x;
    const dy = cornerB.y - cornerA.y;
    const dz = cornerB.z - cornerA.z;

    let newSizeX: number, newSizeY: number, newSizeZ: number;
    let newDx: number, newDy: number, newDz: number;
    let newMinX: number, newMaxX: number;
    let newMinY: number, newMaxY: number;
    let newMinZ: number, newMaxZ: number;

    let currentCylinderAxis: 'x' | 'y' | 'z' = this.selectionShapeAnchor?.cylinderAxis || 'y';
    let newCylinderAxis: 'x' | 'y' | 'z' = currentCylinderAxis;

    const origDx = cornerB.x - cornerA.x;
    const origDz = cornerB.z - cornerA.z;
    let currentStairsAxis: 'x' | 'z' = this.selectionShapeAnchor?.stairsAxis || (Math.abs(origDx) >= Math.abs(origDz) ? 'x' : 'z');
    let newStairsAxis: 'x' | 'z' = currentStairsAxis;

    if (axis === 'y') {
      newSizeX = sizeZ;
      newSizeY = sizeY;
      newSizeZ = sizeX;

      // Rotate vector around Y
      newDx = direction > 0 ? -dz : dz;
      newDz = direction > 0 ? dx : -dx;
      newDy = dy;

      newMinX = Math.round(cx - (newSizeX - 1) / 2);
      newMaxX = newMinX + newSizeX - 1;
      newMinY = minY;
      newMaxY = maxY;
      newMinZ = Math.round(cz - (newSizeZ - 1) / 2);
      newMaxZ = newMinZ + newSizeZ - 1;

      if (currentCylinderAxis === 'x') newCylinderAxis = 'z';
      else if (currentCylinderAxis === 'z') newCylinderAxis = 'x';

      newStairsAxis = currentStairsAxis === 'x' ? 'z' : 'x';
    } else {
      newSizeX = sizeX;
      newSizeY = sizeZ;
      newSizeZ = sizeY;

      // Rotate vector around X
      newDx = dx;
      newDy = direction > 0 ? -dz : dz;
      newDz = direction > 0 ? dy : -dy;

      newMinX = minX;
      newMaxX = maxX;
      newMinY = Math.round(cy - (newSizeY - 1) / 2);
      newMaxY = newMinY + newSizeY - 1;
      newMinZ = Math.round(cz - (newSizeZ - 1) / 2);
      newMaxZ = newMinZ + newSizeZ - 1;

      if (currentCylinderAxis === 'y') newCylinderAxis = 'z';
      else if (currentCylinderAxis === 'z') newCylinderAxis = 'y';
    }

    // Clamp Y to prevent negative coordinates below ground
    if (newMinY < 0) {
      const shiftY = -newMinY;
      newMinY += shiftY;
      newMaxY += shiftY;
    }

    const newCornerA = {
      x: newDx >= 0 ? newMinX : newMaxX,
      y: newDy >= 0 ? newMinY : newMaxY,
      z: newDz >= 0 ? newMinZ : newMaxZ
    };
    const newCornerB = {
      x: newDx >= 0 ? newMaxX : newMinX,
      y: newDy >= 0 ? newMaxY : newMinY,
      z: newDz >= 0 ? newMaxZ : newMinZ
    };

    this.selectionShapeAnchor = {
      cornerA: newCornerA,
      cornerB: newCornerB,
      micro: isMicro,
      cylinderAxis: newCylinderAxis,
      stairsAxis: newStairsAxis
    };

    if (isEntity) {
      this.applyEntitySelectionShape(this.selectorShape, newCornerA, newCornerB);
      this.sound?.playWrenchClick?.();
      this.ui?.updateToolPanelMode?.();
      return true;
    }

    if (this.selectorShape === 'box') {
      if (isMicro) {
        this.contraptions.microBounds = {
          minX: newMinX, minY: newMinY, minZ: newMinZ,
          maxX: newMaxX, maxY: newMaxY, maxZ: newMaxZ
        };
        this.contraptions.microSelection = this.contraptions.materializeMicroBox?.(
          newMinX, newMinY, newMinZ, newMaxX, newMaxY, newMaxZ
        ) || [];
      } else {
        this.contraptions.connectedSelection = null;
        this.contraptions.selectionCornerA = { ...newCornerA };
        this.contraptions.selectionCornerB = { ...newCornerB };
      }
    } else {
      const cells = computeSelectionCells(this.selectorShape, newCornerA, newCornerB, isMicro, newCylinderAxis, newStairsAxis);
      if (isMicro) {
        this.contraptions.microSelection = cells;
        this.contraptions.microBounds = null;
      } else {
        this.contraptions.selectionCornerA = { ...newCornerA };
        this.contraptions.selectionCornerB = { ...newCornerB };
        this.contraptions.connectedSelection = cells;
      }
    }

    const bounds = isMicro
      ? this.contraptions.getMicroSelectionBounds?.()
      : this.contraptions.getSelectionBounds?.();
    this.sceneRenderer?.updateSelectionAxisGizmo?.(bounds, isMicro);
    this.sceneRenderer?.updateSelectionHologram?.(
      bounds,
      this.contraptions.connectedSelection,
      this.contraptions.microSelection,
      isMicro && this.selectorShape !== 'box'
    );

    this.sound?.playWrenchClick?.();
    this.ui?.updateToolPanelMode?.();
    return true;
  }

  /**
   * Tab key (Brush tool): toggle between standard 1 m block painting (the default)
   * and 0.125 m micro-block painting.
   */
  toggleBrushMicroMode() {
    this.brushMicroMode = !this.brushMicroMode;
    if (this.ui) {
      this.ui.updateToolPanelMode?.();
      this.ui.renderHotbar?.();
      this.ui.showToast(this.brushMicroMode
        ? 'Brush: MICRO mode (0.125 m) · Tab switches to STANDARD'
        : 'Brush: STANDARD mode (1.0 m) · Tab switches to MICRO');
    }
    return this.brushMicroMode;
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
    const clamp = (value, base) => Math.max(base * MICRO_DIVISIONS, Math.min(base * MICRO_DIVISIONS + MICRO_DIVISIONS - 1, value));
    return {
      x: wrapMicroX(clamp(Math.floor((entry.x + normal.x * 0.02) * MICRO_DIVISIONS), baseX)),
      y: Math.max(0, clamp(Math.floor((entry.y + normal.y * 0.02) * MICRO_DIVISIONS), baseY)),
      z: wrapMicroZ(clamp(Math.floor((entry.z + normal.z * 0.02) * MICRO_DIVISIONS), baseZ))
    };
  }

  /** Meter-space origin of the 0.125 m micro cell containing a world point. */
  microMeterPoint(point) {
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

  /** Put an item into the first matching-category slot that is empty (or the selected
   *  slot when it is empty and the bar is showing that category). Returns the index,
   *  or null when the category is full (99 items max). */
  addInventoryItem(category, item) {
    if (!this.inventories) this.inventoryCategory();
    const group = this.inventories?.[category];
    if (!group || !item) return null;
    if (!item.id) {
      const prefix = category === 'colorset' ? 'cs_' : category === 'blockset' ? 'bs_' : 'ent_';
      item.id = typeof globalThis.crypto?.randomUUID === 'function'
        ? `${prefix}${globalThis.crypto.randomUUID()}`
        : `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }
    // Put an item into the first available empty slot in the category.
    const index = group.items.findIndex(slot => !slot);
    if (index < 0) return null;
    if (category !== 'entity') item.name = this.inventoryItemName(category, item, index);
    group.items[index] = item;
    if (index < 9) {
      if (this.activeInventoryCategory === category && group.selected !== index) this.clearHammerRotation();
      group.selected = index;
    }
    this.saveInventoriesToLocalStorage();
    return index;
  }

  /** Display name for a backpack item. Names are intentionally not unique. */
  inventoryItemName(category, item, index = 0) {
    const explicitName = typeof item?.name === 'string' ? trimInventoryName(item.name) : '';
    if (explicitName) return truncateInventoryName(explicitName);
    if (category === 'blockset') {
      return `Block set ${index + 1}`;
    }
    if (category === 'entity') {
      return String(item?.rootComponentId || `Entity ${index + 1}`);
    }
    return `Color set ${index + 1}`;
  }

  /** Rename one item. Duplicate and empty names are allowed within and across categories. */
  renameInventoryItem(category, index, name) {
    if (!this.inventories) this.inventoryCategory();
    const group = this.inventories?.[category];
    if (!group || !Number.isInteger(index) || !group.items[index]) return null;
    const cleanName = typeof name === 'string' ? truncateInventoryName(trimInventoryName(name)) : '';
    group.items[index].name = cleanName;
    this.saveInventoriesToLocalStorage();
    return cleanName;
  }

  /** Remove one backpack item; keeps a valid selected index. */
  deleteInventoryItem(category, index) {
    if (!this.inventories) this.inventoryCategory();
    const group = this.inventories?.[category];
    if (!group || !Number.isInteger(index) || !group.items[index]) return false;
    if (this.activeInventoryCategory === category) this.clearHammerRotation();
    if (category === 'colorset') {
      const nonNullCount = group.items.filter(Boolean).length;
      if (nonNullCount <= 1) return false;
      group.items.splice(index, 1);
      while (group.items.length < MAX_BACKPACK_SLOTS_PER_CATEGORY) {
        group.items.push(null);
      }
      if (group.selected >= group.items.filter(Boolean).length) {
        group.selected = Math.max(0, group.items.filter(Boolean).length - 1);
      }
      this.saveInventoriesToLocalStorage();
      return true;
    }
    group.items[index] = null;
    if (!group.items[group.selected]) {
      const filled = group.items.findIndex(slot => slot);
      group.selected = filled >= 0 ? filled : 0;
    }
    this.saveInventoriesToLocalStorage();
    return true;
  }

  /** Swap two slots within an inventory category. */
  swapInventorySlots(category, fromIndex, toIndex) {
    if (!this.inventories) this.inventoryCategory();
    const group = this.inventories?.[category];
    if (!group || !Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return false;
    const maxLen = group.items.length;
    if (fromIndex < 0 || fromIndex >= maxLen || toIndex < 0 || toIndex >= maxLen || fromIndex === toIndex) return false;
    if (this.activeInventoryCategory === category) this.clearHammerRotation();

    const temp = group.items[fromIndex];
    group.items[fromIndex] = group.items[toIndex];
    group.items[toIndex] = temp;

    if (group.selected === fromIndex) {
      group.selected = toIndex;
    } else if (group.selected === toIndex) {
      group.selected = fromIndex;
    }

    this.saveInventoriesToLocalStorage();
    return true;
  }

  inventoryStorage() {
    if (this.persistentStorage) return this.persistentStorage;
    try {
      return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
    } catch (err) {
      return null;
    }
  }

  /** Keep the built-in nine-color palette available as a color set. */
  ensureDefaultColorSet() {
    if (!this.inventories) this.inventoryCategory();
    const items = this.inventories.colorset.items;
    const defaultColors = PRESET_COLORS.map(color => color.hex.toLowerCase());
    const alreadyPresent = items.some(item => item && Array.isArray(item.colors)
      && item.colors.length === defaultColors.length
      && item.colors.every((color, index) => String(color).toLowerCase() === defaultColors[index]));
    if (alreadyPresent) {
      items.forEach(item => {
        if (item && !item.id) {
          item.id = typeof globalThis.crypto?.randomUUID === 'function'
            ? `cs_${globalThis.crypto.randomUUID()}`
            : `cs_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        }
      });
      return false;
    }
    const index = items.findIndex(item => !item);
    if (index < 0) return false;
    items[index] = {
      id: typeof globalThis.crypto?.randomUUID === 'function'
        ? `cs_${globalThis.crypto.randomUUID()}`
        : `cs_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      name: DEFAULT_COLOR_SET_NAME,
      colors: defaultColors
    };
    return true;
  }

  /** Persist all three backpack categories in the same canonical format used by export. */
  saveInventoriesToLocalStorage(storage = this.inventoryStorage()) {
    if (!storage || !this.inventories) return false;
    const categories = {} as PortableBackpack['categories'];
    for (const category of INVENTORY_CATEGORIES) {
      const group = this.inventories[category];
      categories[category] = {
        selected: group.selected,
        items: group.items.map(item => item ? this.serializeInventoryItem(category, item) : null)
      };
    }
    try {
      const encoded = encodeBackpack({
        activeCategory: this.activeInventoryCategory as InventoryKind,
        categories
      });
      if (typeof storage.setBytes === 'function') storage.setBytes(INVENTORY_STORAGE_KEY, encoded);
      else storage.setItem(INVENTORY_STORAGE_KEY, protobufToBase64(encoded));
      return true;
    } catch (err) {
      console.warn('Could not save backpack to browser storage:', err);
      return false;
    }
  }

  /** Restore the backpack on startup; old or malformed storage is intentionally ignored. */
  loadInventoriesFromLocalStorage(storage = this.inventoryStorage()) {
    const inventories = this.createEmptyInventories();
    let activeCategory = 'blockset';
    let loaded = false;
    let changed = false;

    try {
      const raw = storage?.getBytes?.(INVENTORY_STORAGE_KEY) ?? storage?.getItem(INVENTORY_STORAGE_KEY);
      if (raw) {
        const data = decodeBackpack(typeof raw === 'string' ? protobufFromBase64(raw) : raw);
        for (const category of INVENTORY_CATEGORIES) {
          const storedGroup = data.categories?.[category];
          const maxLen = inventories[category].items.length;
          const storedItems = Array.isArray(storedGroup?.items) ? storedGroup.items.slice(0, maxLen) : [];
          for (let index = 0; index < storedItems.length; index++) {
            if (!storedItems[index]) continue;
            const parsed = this.parseInventoryImport(
              encodeInventoryResource(category as any, storedItems[index]),
              category
            );
            if (parsed.ok) inventories[category].items[index] = (parsed as any).item;
            else changed = true;
          }
          const selected = Number(storedGroup?.selected);
          inventories[category].selected = Number.isInteger(selected) && selected >= 0 && selected < maxLen ? selected : 0;
        }
        if (INVENTORY_CATEGORIES.includes(data.activeCategory)) activeCategory = data.activeCategory;
        loaded = true;
      }
    } catch (err) {
      changed = true;
    }

    this.inventories = inventories;
    this.activeInventoryCategory = activeCategory;
    if (this.ensureDefaultColorSet()) changed = true;
    if (storage && (!loaded || changed)) {
      this.saveInventoriesToLocalStorage(storage);
    }
    return loaded;
  }

  // --- File import / export (pure, DOM-free) ----------------------------------------

  /** Build the portable object that is encoded into Protobuf storage or transfer. */
  serializeInventoryItem(category, item) {
    if (!item) return null;
    if (category === 'blockset') {
      return {
        type: 'space-blockset',
        version: 7,
        name: this.inventoryItemName('blockset', item),
        blocks: (item.blocks || []).map(b => {
          const shared = {
            block: BlockTypes.COLOR_BLOCK,
            color: normalizeColor(b.color ?? 0xf2a93b)
          };
          if ((b.size ?? 1) < 1) {
            // Block-set files keep every coordinate integral. dx/dy/dz select
            // the standard cell; mx/my/mz select one of its 8 subdivisions.
            const microX = Math.round(Number(b.dx) * MICRO_DIVISIONS);
            const microY = Math.round(Number(b.dy) * MICRO_DIVISIONS);
            const microZ = Math.round(Number(b.dz) * MICRO_DIVISIONS);
            const dx = Math.floor(microX / MICRO_DIVISIONS);
            const dy = Math.floor(microY / MICRO_DIVISIONS);
            const dz = Math.floor(microZ / MICRO_DIVISIONS);
            return {
              dx,
              dy,
              dz,
              mx: microX - dx * MICRO_DIVISIONS,
              my: microY - dy * MICRO_DIVISIONS,
              mz: microZ - dz * MICRO_DIVISIONS,
              ...shared
            };
          }
          return {
            dx: Math.round(Number(b.dx)),
            dy: Math.round(Number(b.dy)),
            dz: Math.round(Number(b.dz)),
            ...shared
          };
        })
      };
    }
    if (category === 'entity') {
      const rootComponentId = inventoryEntityRootId(item);
      const vector3 = value => Array.isArray(value) && value.length >= 3
        && value.slice(0, 3).every(component => Number.isFinite(Number(component)))
        ? value.slice(0, 3).map(Number)
        : undefined;
      const quaternion4 = value => Array.isArray(value) && value.length >= 4
        && value.slice(0, 4).every(component => Number.isFinite(Number(component)))
        && value.slice(0, 4).reduce((sum, component) => sum + Number(component) ** 2, 0) > 1e-12
        ? new THREE.Quaternion(...value.slice(0, 4).map(Number) as [number, number, number, number]).normalize().toArray()
        : undefined;
      const optionalNumber = value => value !== null && value !== undefined && Number.isFinite(Number(value))
        ? Number(value)
        : undefined;
      // Seats accept the legacy `[x,y,z]` shorthand and the current object form.
      // A missing rotation stays implicit so plain seats round trip unchanged;
      // an unusable one drops the seat exactly like an unusable position.
      const portableSeat = seat => {
        const position = vector3(Array.isArray(seat) ? seat : seat?.position);
        if (!position) return null;
        if (Array.isArray(seat)) return { position };
        const rotation = quaternion4(seat.rotation);
        if (seat.rotation !== undefined && seat.rotation !== null && !rotation) return null;
        return {
          position,
          ...(rotation ? { rotation } : {}),
          ...(seat.fixedOrientation === true ? { fixedOrientation: true } : {})
        };
      };
      const portableSeats = seats => (seats || []).flatMap(seat => {
        const parsed = portableSeat(seat);
        return parsed ? [parsed] : [];
      });
      const childEntities = (item.childEntities || []).map(definition => ({
        id: String(definition.id || ''),
        name: typeof definition.name === 'string' ? truncateInventoryName(trimInventoryName(definition.name)) : '',
        parentId: String(definition.parentId ?? ''),
        ...(definition.collisionEnabled === false ? { collisionEnabled: false } : {}),
        ...(typeof definition.useGravity === 'boolean' ? { useGravity: definition.useGravity } : {}),
        ...(vector3(definition.pivot) ? { pivot: vector3(definition.pivot) } : {}),
        ...(vector3(definition.localPosition) ? { localPosition: vector3(definition.localPosition) } : {}),
        ...(quaternion4(definition.localRotation) ? { localRotation: quaternion4(definition.localRotation) } : {}),
        ...(quaternion4(definition.anchorRotation) ? { anchorRotation: quaternion4(definition.anchorRotation) } : {}),
        ...(['dynamic', 'kinematic'].includes(definition.bodyType) ? { bodyType: definition.bodyType } : {}),
        ...(optionalNumber(definition.mass) !== undefined ? { mass: optionalNumber(definition.mass) } : {}),
        ...(optionalNumber(definition.restitution) !== undefined ? { restitution: optionalNumber(definition.restitution) } : {}),
        ...(optionalNumber(definition.friction) !== undefined ? { friction: optionalNumber(definition.friction) } : {}),
        seats: portableSeats(definition.seats)
      }));
      const constraints = (item.constraints || []).map(constraint => ({
        id: String(constraint.id || ''),
        type: ['point', 'hinge', 'weld'].includes(constraint.type) ? constraint.type : 'point',
        bodyA: constraint.bodyA == null ? null : String(constraint.bodyA),
        bodyB: String(constraint.bodyB || constraint.nodeId || ''),
        ...(vector3(constraint.anchorA) ? { anchorA: vector3(constraint.anchorA) } : {}),
        ...(vector3(constraint.anchorB) ? { anchorB: vector3(constraint.anchorB) } : {}),
        ...(vector3(constraint.axisA) ? { axisA: vector3(constraint.axisA) } : {}),
        ...(vector3(constraint.axisB) ? { axisB: vector3(constraint.axisB) } : {}),
        ...(vector3(constraint.referenceA) ? { referenceA: vector3(constraint.referenceA) } : {}),
        ...(vector3(constraint.referenceB) ? { referenceB: vector3(constraint.referenceB) } : {}),
        ...(constraint.limits && Number.isFinite(Number(constraint.limits.min))
          && Number.isFinite(Number(constraint.limits.max))
          ? { limits: { min: Number(constraint.limits.min), max: Number(constraint.limits.max) } }
          : {}),
        stiffness: Number.isFinite(Number(constraint.stiffness)) ? Number(constraint.stiffness) : 0.9,
        collideConnected: constraint.collideConnected === true
      }));
      const rootPivotOverride = vector3(item.rootPivotOverride ?? item.pivot);
      return runtimeEntityToPortable({
        name: typeof item.name === 'string' ? truncateInventoryName(trimInventoryName(item.name)) : '',
        rootComponentId,
        blocks: (item.blocks || []).map(b => {
          const shared = {
            block: BlockTypes.COLOR_BLOCK,
            color: normalizeColor(b.color ?? 0xf2a93b),
            entityId: b.entityId === undefined || b.entityId === null
              ? rootComponentId
              : String(b.entityId)
          };
          const x = Number(b.localX ?? b.dx);
          const y = Number(b.localY ?? b.dy);
          const z = Number(b.localZ ?? b.dz);
          if ((b.size ?? 1) < 1) {
            const microX = Math.round(x * MICRO_DIVISIONS);
            const microY = Math.round(y * MICRO_DIVISIONS);
            const microZ = Math.round(z * MICRO_DIVISIONS);
            const dx = Math.floor(microX / MICRO_DIVISIONS);
            const dy = Math.floor(microY / MICRO_DIVISIONS);
            const dz = Math.floor(microZ / MICRO_DIVISIONS);
            return {
              dx,
              dy,
              dz,
              mx: microX - dx * MICRO_DIVISIONS,
              my: microY - dy * MICRO_DIVISIONS,
              mz: microZ - dz * MICRO_DIVISIONS,
              ...shared
            };
          }
          return {
            dx: Math.round(x),
            dy: Math.round(y),
            dz: Math.round(z),
            ...shared
          };
        }),
        childEntities,
        scripts: (item.scripts || []).map(script => ({ id: String(script.id || ''), code: String(script.code || '') })),
        enabled: (item.enabled || []).map(entry => ({ id: String(entry.id || ''), enabled: entry.enabled === true })),
        constraints,
        ...(rootPivotOverride ? { rootPivotOverride } : {}),
        ...(quaternion4(item.anchorRotation) ? { anchorRotation: quaternion4(item.anchorRotation) } : {}),
        bodyType: item.bodyType,
        mass: item.mass,
        restitution: item.restitution,
        friction: item.friction,
        useGravity: item.useGravity,
        collisionEnabled: item.collisionEnabled,
        seats: portableSeats(item.seats)
      });
    }
    if (category === 'colorset') {
      return {
        type: 'space-colorset',
        version: 7,
        name: item.name || 'color set',
        colors: item.colors
      };
    }
    return null;
  }

  encodeInventoryItem(category, item) {
    const portable = this.serializeInventoryItem(category, item);
    if (!portable) return null;
    return encodeInventoryResource(category, portable);
  }

  /** Parse one Protobuf resource into a backpack item. Returns { ok, item, error }. */
  parseInventoryImport(input, category) {
    const fail = error => ({ ok: false, error });
    const encoded = input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : null;
    if (!encoded) return fail('Import data must be a Protobuf binary file');
    if (encoded.byteLength > MAX_INVENTORY_IMPORT_BYTES) {
      return fail(`File exceeds ${MAX_INVENTORY_IMPORT_BYTES / (1024 * 1024)} MiB`);
    }

    let data;
    try {
      data = decodeInventoryResource(encoded, category).portable;
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'Not valid inventory Protobuf');
    }

    const validBaseCoordinates = values => values.every(value => (
      Number.isSafeInteger(value) && Math.abs(value) <= MAX_IMPORT_COORDINATE
    ));
    const portableVector = (value, maxAbs = MAX_PORTABLE_VECTOR_COMPONENT) => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.length !== 3) return null;
      const vector = value.map(Number);
      return vector.every(component => Number.isFinite(component) && Math.abs(component) <= maxAbs)
        ? vector
        : null;
    };
    // Unit-quaternion shape check without the stopped-grid restriction, which
    // applies only to authored component local/anchor rotations.
    const portableUnitQuaternion = value => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.length !== 4) return null;
      const components = value.map(Number);
      const lengthSq = components.reduce((sum, component) => sum + component * component, 0);
      const unitTolerance = Math.max(1e-6, 1e-6 * Math.max(Math.abs(lengthSq), 1));
      if (!components.every(Number.isFinite)
        || !Number.isFinite(lengthSq)
        || Math.abs(lengthSq - 1) > unitTolerance) return null;
      return new THREE.Quaternion(
        components[0], components[1], components[2], components[3]
      ).normalize().toArray();
    };
    const portableQuaternion = value => {
      if (value === undefined) return undefined;
      // The backend rejects components outside -1..1 before it even checks the
      // norm, so an unnormalized rotation is mirrored here.
      if (Array.isArray(value) && value.map(Number).some(component => component < -1 || component > 1)) {
        return null;
      }
      const normalized = portableUnitQuaternion(value);
      return normalized === null || normalized === undefined
        ? null
        : (isStoppedGridQuaternion(normalized) ? normalized : null);
    };
    const withinEntityBounds = (blocks, keys, ownerKey = null) => {
      const groups = new Map();
      for (const block of blocks) {
        const owner = ownerKey ? String(block[ownerKey] ?? '') : 'resource';
        if (!groups.has(owner)) groups.set(owner, []);
        groups.get(owner).push(block);
      }
      for (const group of groups.values()) {
        for (let axis = 0; axis < 3; axis++) {
          let min = Number.POSITIVE_INFINITY;
          let max = Number.NEGATIVE_INFINITY;
          for (const block of group) {
            const value = Math.floor(Number(block[keys[axis]]) + 1e-6);
            min = Math.min(min, value);
            max = Math.max(max, value);
          }
          if (max - min + 1 > MAX_ENTITY_BOUNDS) return false;
        }
      }
      return true;
    };
    const validateVoxelOccupancy = (blocks, coordinateKeys, ownerKey = null) => {
      const standardCells = new Set();
      const microCells = new Set();
      const microParents = new Set();
      for (const block of blocks) {
        const owner = ownerKey ? String(block[ownerKey] ?? '') : 'resource';
        const coordinates = coordinateKeys.map(key => Number(block[key]));
        const base = coordinates.map(value => Math.floor(value + 1e-6));
        const isMicro = Number(block.size) < 1;
        const parentKey = `${owner}:${base.join(',')}`;
        const fine = coordinates.map(value => Math.round(value * MICRO_DIVISIONS));
        if (isMicro) {
          const key = `${owner}:${fine.join(',')}`;
          if (standardCells.has(parentKey) || microCells.has(key)) return false;
          microCells.add(key);
          microParents.add(parentKey);
        } else {
          if (standardCells.has(parentKey) || microParents.has(parentKey)) return false;
          standardCells.add(parentKey);
        }
      }
      return true;
    };
    const runtimeVoxel = (block, ownerId = null) => {
      if (block?.block !== undefined && block.block !== BlockTypes.COLOR_BLOCK) {
        throw new Error('Inventory v7 supports only color block id 1');
      }
      const color = Number(block?.color ?? 0xf2a93b);
      if (!Number.isSafeInteger(color) || color < 0 || color > 0xffffff) {
        throw new Error('Voxel color must be an unsigned 24-bit value');
      }
      const base = [block?.dx, block?.dy, block?.dz].map(Number);
      if (!validBaseCoordinates(base)) throw new Error('Voxel coordinates must be bounded safe integers');
      const microValues = [block?.mx, block?.my, block?.mz];
      const hasMicro = microValues.some(value => value !== undefined);
      let coordinates = base;
      if (hasMicro) {
        const micro = microValues.map(Number);
        if (!micro.every(value => Number.isInteger(value) && value >= 0 && value < MICRO_DIVISIONS)) {
          throw new Error('Micro coordinates mx/my/mz must all be integers between 0 and 7');
        }
        coordinates = base.map((value, index) => (
          (value * MICRO_DIVISIONS + micro[index]) / MICRO_DIVISIONS
        ));
      }
      const result = {
        size: hasMicro ? 1 / MICRO_DIVISIONS : 1,
        block: BlockTypes.COLOR_BLOCK,
        color
      };
      if (ownerId !== null) {
        return {
          ...result,
          localX: coordinates[0],
          localY: coordinates[1],
          localZ: coordinates[2],
          entityId: ownerId
        };
      }
      return { ...result, dx: coordinates[0], dy: coordinates[1], dz: coordinates[2] };
    };

    if (category === 'blockset') {
      if (data?.type !== 'space-blockset' || data?.version !== 7) {
        return fail('Expected a space-blockset v7 Protobuf file');
      }
      if (typeof data.name !== 'string' || !trimInventoryName(data.name)) return fail('A block set must have a name');
      if (inventoryNameLength(data.name) > MAX_INVENTORY_NAME_LENGTH) {
        return fail(`A block set name may contain at most ${MAX_INVENTORY_NAME_LENGTH} characters`);
      }
      if (!Array.isArray(data.blocks) || data.blocks.length === 0) return fail('A block set must contain voxels');
      if (data.blocks.length > MAX_INVENTORY_BLOCKS) {
        return fail(`A block set may contain at most ${MAX_INVENTORY_BLOCKS} voxels`);
      }
      let blocks;
      try {
        blocks = data.blocks.map(block => runtimeVoxel(block));
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Invalid block set');
      }
      if (!withinEntityBounds(blocks, ['dx', 'dy', 'dz'])) {
        return fail(`Block-set bounds may not exceed ${MAX_ENTITY_BOUNDS} cells per axis`);
      }
      if (!validateVoxelOccupancy(blocks, ['dx', 'dy', 'dz'])) {
        return fail('Block set contains duplicate voxels or standard/micro overlap');
      }
      return {
        ok: true,
        item: {
          kind: 'blockset',
          name: truncateInventoryName(trimInventoryName(data.name)),
          blocks,
          blockCount: blocks.length
        }
      };
    }

    if (category === 'entity') {
      if (data?.type !== 'space-entity' || data?.version !== 7 || !data.root) {
        return fail('Expected a recursive space-entity v7 Protobuf file');
      }
      if (Object.hasOwn(data, 'name')) return fail('Entity names belong to root.name');

      const ids = new Set();
      let componentCount = 0;
      let blockCount = 0;
      let seatCount = 0;
      let totalScriptBytes = 0;
      const validateBody = (body, id) => {
        if (!body || (body.type !== 'dynamic' && body.type !== 'kinematic')) {
          throw new Error(`Component ${id} must have a valid body config`);
        }
        if (body.mass !== undefined) {
          const mass = Number(body.mass);
          if (!Number.isFinite(mass) || mass < 0.1 || mass > MAX_PORTABLE_BODY_MASS) {
            throw new Error(`Component ${id} has invalid mass`);
          }
        }
        for (const field of ['restitution', 'friction']) {
          if (body[field] === undefined) continue;
          const value = Number(body[field]);
          if (!Number.isFinite(value) || value < 0 || value > 1) {
            throw new Error(`Component ${id} has invalid ${field}`);
          }
        }
        for (const field of ['useGravity', 'collisionEnabled']) {
          if (body[field] !== undefined && typeof body[field] !== 'boolean') {
            throw new Error(`Component ${id} has invalid ${field}`);
          }
        }
      };
      const validateComponent = (component, parentId, depth) => {
        if (!component || typeof component !== 'object' || depth > 16) {
          throw new Error('Component hierarchy is malformed or exceeds depth 16');
        }
        const id = component.id;
        if (component.name !== undefined && (typeof component.name !== 'string'
          || inventoryNameLength(component.name) > MAX_INVENTORY_NAME_LENGTH)) {
          throw new Error(`Component ${id} name must be a string of at most ${MAX_INVENTORY_NAME_LENGTH} characters`);
        }
        component.name = trimInventoryName(component.name ?? '');
        if (!isValidComponentId(id) || ids.has(id)) {
          throw new Error('Component ids must be unique portable identifiers');
        }
        ids.add(id);
        componentCount += 1;
        if (componentCount > MAX_ENTITY_COMPONENTS) {
          throw new Error(`An entity may contain at most ${MAX_ENTITY_COMPONENTS} components`);
        }
        const pivot = portableVector(component.pivot, MAX_IMPORT_COORDINATE);
        if (pivot === null) throw new Error(`Component ${id} has an invalid pivot`);
        const localPosition = portableVector(component.localPosition, MAX_IMPORT_COORDINATE);
        if (localPosition === null) throw new Error(`Component ${id} has an invalid local position`);
        if (parentId === null && (component.localPosition !== undefined || component.localRotation !== undefined)) {
          throw new Error('The entity root may not have a parent-relative transform');
        }
        for (const [label, value] of [
          ['local rotation', component.localRotation],
          ['anchor rotation', component.anchorRotation]
        ]) {
          if (portableQuaternion(value) === null) {
            throw new Error(`Component ${id} ${label} must use an axis-aligned 90-degree grid rotation`);
          }
        }
        validateBody(component.body, id);
        if (!Array.isArray(component.blocks) || !Array.isArray(component.children) || !Array.isArray(component.seats)) {
          throw new Error(`Component ${id} has malformed repeated fields`);
        }
        blockCount += component.blocks.length;
        if (blockCount > MAX_INVENTORY_BLOCKS) {
          throw new Error(`An entity may contain at most ${MAX_INVENTORY_BLOCKS} voxels`);
        }
        if (component.script !== undefined) {
          if (typeof component.script !== 'string') throw new Error(`Component ${id} has an invalid script`);
          const bytes = new TextEncoder().encode(component.script).byteLength;
          if (bytes > MAX_INVENTORY_SCRIPT_BYTES) {
            throw new Error(`One component script may not exceed ${MAX_INVENTORY_SCRIPT_BYTES / 1024} KiB`);
          }
          totalScriptBytes += bytes;
          if (totalScriptBytes > MAX_INVENTORY_TOTAL_SCRIPT_BYTES) {
            throw new Error(`Entity scripts may not exceed ${MAX_INVENTORY_TOTAL_SCRIPT_BYTES / 1024} KiB in total`);
          }
        }
        for (const seat of component.seats) {
          seatCount += 1;
          const position = portableVector(seat?.position, MAX_IMPORT_COORDINATE);
          if (seatCount > 256 || position === null || position === undefined) {
            throw new Error('Entity seats must be bounded 3D positions and may not exceed 256');
          }
          // Seat orientation is an arbitrary unit quaternion, unlike the
          // stopped-grid local/anchor rotations, so it uses the plain check.
          if (seat.rotation !== undefined && portableUnitQuaternion(seat.rotation) === null) {
            throw new Error('Entity seat rotations must be unit quaternions');
          }
          if (seat.fixedOrientation !== undefined && typeof seat.fixedOrientation !== 'boolean') {
            throw new Error('Entity seat fixedOrientation must be a boolean');
          }
        }
        for (const child of component.children) validateComponent(child, id, depth + 1);
      };
      try {
        validateComponent(data.root, null, 0);
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Invalid component hierarchy');
      }
      if (blockCount === 0) return fail('An entity must contain at least one voxel');

      let runtime;
      try {
        runtime = portableEntityToRuntime(data);
        runtime.blocks = runtime.blocks.map(block => runtimeVoxel(block, block.entityId));
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Invalid recursive entity');
      }
      if (!withinEntityBounds(runtime.blocks, ['localX', 'localY', 'localZ'], 'entityId')) {
        return fail(`Entity bounds may not exceed ${MAX_ENTITY_BOUNDS} cells per axis`);
      }
      if (!validateVoxelOccupancy(runtime.blocks, ['localX', 'localY', 'localZ'], 'entityId')) {
        return fail('Entity contains duplicate voxels or standard/micro overlap');
      }
      const stoppedGridError = validateStoppedEntityGrid(runtime);
      if (stoppedGridError) return fail(stoppedGridError);

      if (!Array.isArray(data.constraints) || data.constraints.length > MAX_INVENTORY_CONSTRAINTS) {
        return fail(`An entity may contain at most ${MAX_INVENTORY_CONSTRAINTS} constraints`);
      }
      const constraintIds = new Set();
      const constraints = [];
      for (const constraint of data.constraints) {
        const id = constraint?.id;
        const bodyA = constraint?.bodyA === null ? null : String(constraint?.bodyA ?? '');
        const bodyB = String(constraint?.bodyB || '');
        if (!isValidConstraintId(id) || constraintIds.has(id)) {
          return fail('Constraint ids must be unique portable identifiers');
        }
        if ((bodyA !== null && !ids.has(bodyA)) || !ids.has(bodyB) || bodyA === bodyB) {
          return fail(`Constraint ${id} references an invalid component`);
        }
        const vectors = {};
        for (const field of ['anchorA', 'anchorB', 'axisA', 'axisB', 'referenceA', 'referenceB']) {
          if (constraint[field] === undefined) continue;
          const vector = portableVector(constraint[field]);
          if (vector === null) return fail(`Constraint ${id} has an invalid ${field}`);
          vectors[field] = vector;
        }
        let limits;
        if (constraint.limits !== undefined) {
          const min = Number(constraint.limits?.min);
          const max = Number(constraint.limits?.max);
          if (!Number.isFinite(min) || !Number.isFinite(max)
            || Math.abs(min) > MAX_PORTABLE_CONSTRAINT_VALUE
            || Math.abs(max) > MAX_PORTABLE_CONSTRAINT_VALUE) {
            return fail(`Constraint ${id} has invalid limits`);
          }
          limits = { min: Math.min(min, max), max: Math.max(min, max) };
        }
        const stiffness = Number(constraint.stiffness ?? 0.9);
        if (!Number.isFinite(stiffness) || stiffness < 0 || stiffness > 1) {
          return fail(`Constraint ${id} has invalid stiffness`);
        }
        constraintIds.add(id);
        constraints.push({
          id,
          type: ['point', 'hinge', 'weld'].includes(constraint.type) ? constraint.type : 'point',
          bodyA,
          bodyB,
          ...vectors,
          ...(limits ? { limits } : {}),
          stiffness,
          collideConnected: constraint.collideConnected === true
        });
      }
      runtime.kind = 'entity';
      runtime.constraints = constraints;
      runtime.blockCount = runtime.blocks.length;
      runtime.nodeCount = componentCount;
      return { ok: true, item: runtime };
    }

    if (category === 'colorset') {
      if (data?.type !== 'space-colorset' || data?.version !== 7) {
        return fail('Expected a space-colorset v7 Protobuf file');
      }
      if (typeof data.name !== 'string' || !trimInventoryName(data.name)) return fail('A color set must have a name');
      if (inventoryNameLength(data.name) > MAX_INVENTORY_NAME_LENGTH) {
        return fail(`A color set name may contain at most ${MAX_INVENTORY_NAME_LENGTH} characters`);
      }
      if (!Array.isArray(data.colors) || data.colors.length !== 9) {
        return fail('A color set must contain exactly 9 hex colors');
      }
      const colors = data.colors.map(color => `#${String(color ?? '').replace(/^#/, '').toLowerCase()}`);
      if (!colors.every(color => HEX_COLOR.test(color))) {
        return fail('Every color must be a 6-digit hex value like #48dbfb');
      }
      return {
        ok: true,
        item: { name: truncateInventoryName(trimInventoryName(data.name)), colors }
      };
    }

    return fail('Unknown inventory category');
  }
  private finishEntitySlotBuild(slot, pose, preparedBlocks = null) {
    const origin = pose?.position?.clone?.()
      || new THREE.Vector3(Number(pose?.position?.x) || 0, Number(pose?.position?.y) || 0, Number(pose?.position?.z) || 0);
    const rotation = pose?.quaternion?.isQuaternion
      ? pose.quaternion.clone().normalize()
      : new THREE.Quaternion();
    const created = this.contraptions.buildFromSlot(slot, origin, null, false, preparedBlocks);
    if (created) {
      // Preview coordinates use `origin + rotation * localPoint`, while a
      // Contraption's root position is its local center. Move that center into
      // the identical world pose before saving.
      created.position.copy(origin).add(created.localCenter.clone().applyQuaternion(rotation));
      created.quaternion.copy(rotation);
      created.updateTransform();
      created.originWorldPos.copy(origin);
      // Placing an independent entity is a completed spawn operation, so it
      // has the same result as pressing global Play: physics is active and all
      // runnable component scripts start, even if the backpack copy was saved
      // with its component code disabled. Component installation intentionally
      // keeps its target stopped and does not pass through this path.
      this.performBasicAction({
        domain: ActionDomain.ENTITY,
        action: 'start-scripts',
        target: { contraption: created }
      });
      this.contraptions.saveEntitiesToStorage?.();
      this.sound?.playBlockPlace?.();
      const builtLabel = slot.name || 'entity';
      this.ui?.showToast?.(`Built [${builtLabel}] (${slot.blockCount} blocks) as running entity #${created.id}`);
    }
    return created;
  }

  private describeComponentInstallFailure(reason) {
    const messages = {
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
    return messages[reason] || `Component installation failed (${reason || 'unknown error'})`;
  }

  private finishEntitySlotInstall(slot, pose, preparedBlocks = null) {
    const target = pose?.targetContraption;
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
    const skipped = result.skippedExternalConstraints > 0
      ? ` · ignored ${result.skippedExternalConstraints} external constraint(s)`
      : '';
    this.ui?.showToast?.(
      `Installed [${slot.name || 'entity'}] as [${result.rootId}] on [${parentId}]${skipped}`
    );
    return result;
  }

  /** Map a large serialized entity slot incrementally; registration stays atomic. */
  private startLargeEntitySlotBuild(slot, pose) {
    const source = [...slot.blocks];
    const preparedBlocks: any[] = [];
    return this.startBulkEditJob({
      label: 'Building entity',
      total: source.length,
      mutatesWorld: false,
      detail: 'Preparing entity voxels',
      step: index => {
        const block = source[index];
        preparedBlocks.push({
          localX: block.localX,
          localY: block.localY,
          localZ: block.localZ,
          size: block.size || 1,
          color: block.color,
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
  private startLargeEntitySlotInstall(slot, pose) {
    const source = [...slot.blocks];
    const preparedBlocks: any[] = [];
    return this.startBulkEditJob({
      label: 'Installing component',
      total: source.length,
      mutatesWorld: false,
      detail: 'Preparing component voxels',
      step: index => {
        const block = source[index];
        preparedBlocks.push({
          localX: block.localX,
          localY: block.localY,
          localZ: block.localZ,
          size: block.size || 1,
          color: block.color,
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

    if (slot.kind === 'blockset' || category === 'blockset') {
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
  cycleInventorySlot(direction) {
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

  canPlaceStandardAt(pos) {
    if (!pos) return false;
    const playerAABB = this.physics.getAABB();
    return !(
      pos.x + 1 > playerAABB.minX && pos.x < playerAABB.maxX &&
      pos.y + 1 > playerAABB.minY && pos.y < playerAABB.maxY &&
      pos.z + 1 > playerAABB.minZ && pos.z < playerAABB.maxZ
    );
  }

  private finishPreparedWorldAssembly(rawBlocks, origin, mode, customOptions) {
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
      this.ui?.showToast?.(`${contraption.blocks.length} blocks assembled as root body · press C to open the editor`);
      this.openCodeEditorForTarget();
    }
    return contraption || null;
  }

  /** Extract a large world selection incrementally, then atomically create its entity. */
  private startLargeWorldAssembly(mode, customOptions = {}) {
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

    const sizeY = bounds ? bounds.maxY - bounds.minY + 1 : 0;
    const sizeZ = bounds ? bounds.maxZ - bounds.minZ + 1 : 0;
    const scanTotal = microCells?.length
      ?? sparseCells?.length
      ?? ((bounds.maxX - bounds.minX + 1) * sizeY * sizeZ);
    const origin = microCells
      ? { x: Infinity, y: Infinity, z: Infinity }
      : { x: bounds.minX, y: bounds.minY, z: bounds.minZ };
    const total = microCells ? scanTotal * 2 : scanTotal;
    const rawBlocks: any[] = [];
    const cellAt = index => sparseCells?.[index] || {
      x: bounds.minX + Math.floor(index / (sizeY * sizeZ)),
      y: bounds.minY + Math.floor(index / sizeZ) % sizeY,
      z: bounds.minZ + index % sizeZ
    };

    const started = this.startBulkEditJob({
      label: 'Assembling selection',
      total,
      detail: job => microCells && job.processed < scanTotal
        ? 'Measuring micro selection'
        : 'Extracting selected voxels',
      step: index => {
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
          if (!(result.removed > 0)) return 0;
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
        if (result.standard > 0) {
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
    if (this.contraptions.hasChildSelection()) {
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
        this.ui.showToast(`Child component ${result.child.id} created · control it via self.child('${result.child.id}')`);
        this.ui.renderComponentTree(result.contraption);
        this.ui.renderCodeTabs(result.contraption);
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
      this.ui.showToast(`${contraption.blocks.length} blocks assembled as root body · press C to open the editor`);
      this.openCodeEditorForTarget();
    }
    return contraption || null;
  }

  toggleDriveVehicle() {
    if (this.isDriving) {
      const vehicle = this.drivenContraption;
      const seat = this.drivenSeat;
      // Read the seat-derived view before clearing the driving state; the
      // getter needs the lock flags that the teardown below removes.
      const dismountYaw = this.viewYaw;
      this.isDriving = false;
      this.contraptions.activeDrivable = null;
      this.drivenContraption = null;
      this.drivenSeat = null;
      // Hand the seat-derived view direction back to free look so stepping out
      // of a locked cockpit does not snap the camera.
      this.yaw = dismountYaw;
      this.seatLookYaw = 0;
      this.drivenSeatLocksYaw = false;
      this.resetEntityInputState();

      if (vehicle) {
        // Leave beside the vehicle instead of teleporting two metres upward.
        // The bounding sphere keeps the player's AABB outside even when the
        // vehicle is rotated, while preserving its current altitude/velocity.
        // A seat orientation wins over the chassis axis so the player is set
        // down where the seat faces instead of inside a swung-out hull.
        const seatRotation = seat
          ? vehicle.getSeatWorldQuaternion?.(seat.componentId, seat.seatIndex)
          : null;
        const exitDirection = new THREE.Vector3(1, 0, 0).applyQuaternion(
          seatRotation?.isQuaternion ? seatRotation : vehicle.quaternion
        );
        exitDirection.y = 0;
        if (exitDirection.lengthSq() < 1e-6) exitDirection.set(1, 0, 0);
        exitDirection.normalize();
        const exitDistance = vehicle.boundingRadius + this.physics.width + 0.25;
        this.physics.position.copy(vehicle.position).addScaledVector(exitDirection, exitDistance);
        this.physics.velocity.copy(vehicle.velocity);
        this.physics.isOnGround = false;
        this.physics.ridingContraption = null;
      }

      if (this.ui) this.ui.showToast(`Left the driver seat`);
      return;
    }

    const target = this.hoveredContraptionHit?.contraption || this.hoveredContraption;
    const hit = this.hoveredContraptionHit;
    const hitPoint = hit?.point;
    const focusPoint = hit?.block && target?.getBlockWorldCenter
      ? target.getBlockWorldCenter(hit.block)
      : hitPoint?.isVector3
        ? hitPoint
        : hitPoint
          ? new THREE.Vector3(Number(hitPoint.x), Number(hitPoint.y), Number(hitPoint.z))
          : null;
    const seat = target && focusPoint ? target.getNearestSeat?.(focusPoint) : null;

    if (target && seat) {
      this.resetEntityInputState();
      this.isDriving = true;
      this.drivenContraption = target;
      this.drivenSeat = { componentId: seat.componentId, seatIndex: seat.seatIndex };
      this.drivenSeatLocksYaw = seat.fixedOrientation === true;
      // Entering a locked seat snaps the view onto the seat forward axis and
      // starts the head-look arc from center; `this.yaw` keeps tracking the
      // free-look value so leaving the seat never whips the camera around.
      this.seatLookYaw = 0;
      this.contraptions.activeDrivable = target;
      if (this.ui) this.ui.showToast(`Mounted! Key behavior is defined by the ctx.input script · [C] program [V] leave`);
    } else {
      if (this.ui) this.ui.showToast(`Aim at an entity block with a configured seat, then press V`);
    }
  }

  get mass(): number {
    return this.physics?.mass ?? PLAYER_MASS_KG;
  }

  get weight(): number {
    return this.physics?.weight ?? PLAYER_MASS_KG * Math.abs(PLAYER_GRAVITY_MPS2);
  }

  setSceneRenderer(sceneRenderer) {
    this.sceneRenderer = sceneRenderer;
    if (this.sceneRenderer?.setPlayerAvatarVisible) {
      this.sceneRenderer.setPlayerAvatarVisible(this.perspective !== 'first_person');
    }
  }

  setFov(fov: number) {
    this.fov = Math.max(40, Math.min(120, Number(fov) || 75));
    if (this.camera) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  setPerspective(perspective: PlayerPerspective) {
    const normalized: PlayerPerspective = perspective === 'third_person'
      || perspective === 'third_person_front'
      ? perspective
      : 'first_person';
    this.perspective = normalized;
    if (this.sceneRenderer?.setPlayerAvatarVisible) {
      this.sceneRenderer.setPlayerAvatarVisible(normalized !== 'first_person');
    }
  }

  setThirdPersonDistance(dist: number) {
    this.thirdPersonDistance = Math.max(1.5, Math.min(12, Number(dist) || 4));
  }

  togglePerspective() {
    const next: PlayerPerspective = this.perspective === 'first_person'
      ? 'third_person'
      : this.perspective === 'third_person'
        ? 'third_person_front'
        : 'first_person';
    this.setPerspective(next);
    if (this.ui) {
      this.ui.syncSettingsUI?.();
      const label = next === 'third_person'
        ? 'Third Person Back View'
        : next === 'third_person_front'
          ? 'Third Person Front View'
          : 'First Person View';
      this.ui.showToast(label);
    }
  }

  /**
   * The yaw the view actually renders with. A yaw-locking seat overrides free
   * look with its solved world orientation plus the player's bounded head-look
   * arc, so camera, avatar, minimap, and movement all agree while riding.
   */
  get viewYaw(): number {
    if (!this.isDriving || !this.drivenSeatLocksYaw) {
      return Number.isFinite(this.yaw) ? this.yaw : 0;
    }
    const lookOffset = Math.max(-SEAT_LOOK_YAW_LIMIT, Math.min(SEAT_LOOK_YAW_LIMIT, this.seatLookYaw));
    const seatWorld = this.drivenSeat
      ? this.drivenContraption?.getSeatWorldQuaternion?.(
        this.drivenSeat.componentId,
        this.drivenSeat.seatIndex
      )
      : null;
    if (!seatWorld?.isQuaternion) {
      return (Number.isFinite(this.yaw) ? this.yaw : 0) + lookOffset;
    }
    return quaternionForwardYaw(seatWorld) + lookOffset;
  }

  updateCameraPosition() {
    const eyePos = this.physics.getEyePosition();
    // Always rebuild the normal player look before deriving an offset. The
    // front-facing third-person camera reverses its render orientation below,
    // so reusing its quaternion on the next frame would make the two camera
    // positions alternate.
    const pitch = Number.isFinite(this.pitch) ? this.pitch : this.camera.rotation.x;
    const yaw = this.viewYaw;
    this.camera.rotation.set(pitch, yaw, 0, 'YXZ');
    if (this.perspective === 'third_person') {
      const backward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);
      this.camera.position.copy(eyePos).addScaledVector(backward, this.thirdPersonDistance);
    } else if (this.perspective === 'third_person_front') {
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.camera.position.copy(eyePos).addScaledVector(forward, this.thirdPersonDistance);
      this.camera.lookAt(eyePos);
    } else {
      this.camera.position.copy(eyePos);
    }
  }

  /**
   * Re-seat a mounted player from the vehicle's latest solved transform.
   * Contraption physics runs after PlayerController.update(), so doing this
   * again from the post-physics aim pass prevents the camera from rendering a
   * one-frame-old cockpit pose while a vehicle accelerates or rotates.
   */
  syncDrivenVehiclePose() {
    if (!this.isDriving || !this.drivenContraption) return false;
    const seat = this.drivenSeat;
    const seatWorld = seat
      ? this.drivenContraption.getSeatWorldPosition?.(seat.componentId, seat.seatIndex)
      : null;
    if (!seatWorld) {
      this.isDriving = false;
      this.contraptions.activeDrivable = null;
      this.drivenContraption = null;
      this.drivenSeat = null;
      this.drivenSeatLocksYaw = false;
      this.seatLookYaw = 0;
      this.physics.ridingContraption = null;
      return false;
    }
    this.physics.position.copy(seatWorld);
    this.physics.velocity.set(0, 0, 0);
    // Keep the free-look yaw tracking the locked view so dismounting, the
    // minimap, the avatar, and the multiplayer snapshot all continue from the
    // direction the player was actually facing.
    if (this.drivenSeatLocksYaw) this.yaw = this.viewYaw;
    return true;
  }

  updateSimulation(dt) {
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

  updateRender() {
    this.processBulkEditFrame();
    this.updateCameraPosition();
  }

  /** Compatibility one-call form used by focused controller tests. The game
   * loop invokes updateSimulation at 20 Hz and updateRender on every RAF. */
  update(dt) {
    this.processBulkEditFrame();
    this.updateSimulation(dt);
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
    const query = this.performAimRaycast('all');
    this.currentRaycast = query.worldHit || { hit: false };

    // Entity and terrain candidates are resolved by the shared raycast query,
    // using exact bent triangles for the same deformation rendered by the GPU.
    const contraptionHit = query.entityHit;
    const hovered = query.kind === 'entity' ? contraptionHit.contraption : null;
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
      if (this.activeTool === SpecialTool.WRENCH) {
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
  performAimRaycast(include = 'all', usePublishedCollision: boolean | undefined = undefined) {
    const eyePos = this.physics.getEyePosition();
    const eyeBent = PlayerController._bentEye.copy(eyePos);
    bendPoint(eyePos.x, eyePos.y, eyePos.z, eyeBent);
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
      maxDistance: 8,
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
            if (hit.point && this.brushSelection.contraption === contraption && this.brushSelection.nodeId === nodeId) {
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
      if (selectorActive) {
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

  getEntitySelectionBounds(blocks: any[], isMicro = false) {
    if (!blocks || blocks.length === 0) return null;
    if (isMicro) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const b of blocks) {
        const size = (b.size !== undefined && b.size !== null) ? b.size : 1;
        const bx = Math.round(b.localX * MICRO_DIVISIONS);
        const by = Math.round(b.localY * MICRO_DIVISIONS);
        const bz = Math.round(b.localZ * MICRO_DIVISIONS);
        const bSize = Math.max(1, Math.round(size * MICRO_DIVISIONS));
        minX = Math.min(minX, bx);
        minY = Math.min(minY, by);
        minZ = Math.min(minZ, bz);
        maxX = Math.max(maxX, bx + bSize - 1);
        maxY = Math.max(maxY, by + bSize - 1);
        maxZ = Math.max(maxZ, bz + bSize - 1);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
      return { minX, maxX, minY, maxY, minZ, maxZ };
    } else {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const b of blocks) {
        const size = b.size || 1;
        const bx = Math.floor(b.localX + 1e-6);
        const by = Math.floor(b.localY + 1e-6);
        const bz = Math.floor(b.localZ + 1e-6);
        const bSize = Math.max(1, Math.round(size));
        minX = Math.min(minX, bx);
        minY = Math.min(minY, by);
        minZ = Math.min(minZ, bz);
        maxX = Math.max(maxX, bx + bSize - 1);
        maxY = Math.max(maxY, by + bSize - 1);
        maxZ = Math.max(maxZ, bz + bSize - 1);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
      return { minX, maxX, minY, maxY, minZ, maxZ };
    }
  }

  expandEntitySelectionAxis(axis: 'x' | 'y' | 'z', direction: 1 | -1, steps: number, isMicro = false) {
    const contraption = this.selectedBlockSelection?.contraption || this.selectedSubtree?.contraption;
    const nodeId = this.selectedBlockSelection?.nodeId || this.selectedSubtree?.rootId;
    if (!contraption || !nodeId) return { ok: false, bounds: null, count: 0 };

    if (!this.selectedBlockSelection && this.selectedSubtree) {
      const nodeIds = this.selectedSubtree.nodeIds || this.collectSubtreeIds(contraption, nodeId);
      const subtreeBlocks = contraption.blocks.filter((b: any) => nodeIds.has(contraptionBlockOwnerId(contraption, b)));
      this.selectedBlockSelection = {
        contraption,
        nodeId,
        blocks: subtreeBlocks,
        bounds: this.getEntitySelectionBounds(subtreeBlocks, isMicro)
      };
      this.selectedSubtree = null;
    }

    if (!this.selectedBlockSelection) return { ok: false, bounds: null, count: 0 };

    if (!this.selectedBlockSelection.bounds) {
      this.selectedBlockSelection.bounds = this.getEntitySelectionBounds(this.selectedBlockSelection.blocks, isMicro);
    }
    const bounds = this.selectedBlockSelection.bounds;
    if (!bounds) return { ok: false, bounds: null, count: 0 };

    if (direction > 0) {
      if (axis === 'x') {
        bounds.maxX += steps;
        if (bounds.maxX < bounds.minX) bounds.maxX = bounds.minX;
      } else if (axis === 'y') {
        bounds.maxY += steps;
        if (bounds.maxY < bounds.minY) bounds.maxY = bounds.minY;
      } else if (axis === 'z') {
        bounds.maxZ += steps;
        if (bounds.maxZ < bounds.minZ) bounds.maxZ = bounds.minZ;
      }
    } else {
      if (axis === 'x') {
        bounds.minX -= steps;
        if (bounds.minX > bounds.maxX) bounds.minX = bounds.maxX;
      } else if (axis === 'y') {
        bounds.minY -= steps;
        if (bounds.minY > bounds.maxY) bounds.minY = bounds.maxY;
      } else if (axis === 'z') {
        bounds.minZ -= steps;
        if (bounds.minZ > bounds.maxZ) bounds.minZ = bounds.maxZ;
      }
    }

    if (this.selectorShape && this.selectorShape !== 'box') {
      const cornerA = { x: bounds.minX, y: bounds.minY, z: bounds.minZ };
      const cornerB = { x: bounds.maxX, y: bounds.maxY, z: bounds.maxZ };
      this.applyEntitySelectionShape(this.selectorShape, cornerA, cornerB);
      return { ok: true, bounds, count: this.selectedBlockSelection?.blocks?.length || 0 };
    }

    let minMeterX: number, maxMeterX: number;
    let minMeterY: number, maxMeterY: number;
    let minMeterZ: number, maxMeterZ: number;

    if (isMicro) {
      minMeterX = bounds.minX * MICRO_SIZE;
      maxMeterX = (bounds.maxX + 1) * MICRO_SIZE;
      minMeterY = bounds.minY * MICRO_SIZE;
      maxMeterY = (bounds.maxY + 1) * MICRO_SIZE;
      minMeterZ = bounds.minZ * MICRO_SIZE;
      maxMeterZ = (bounds.maxZ + 1) * MICRO_SIZE;
    } else {
      minMeterX = bounds.minX;
      maxMeterX = bounds.maxX + 1;
      minMeterY = bounds.minY;
      maxMeterY = bounds.maxY + 1;
      minMeterZ = bounds.minZ;
      maxMeterZ = bounds.maxZ + 1;
    }

    const matchingBlocks = isMicro
      ? (this.buildEntityMicroSelection(contraption, nodeId, (x: number, y: number, z: number) => (
          x >= bounds.minX && x <= bounds.maxX &&
          y >= bounds.minY && y <= bounds.maxY &&
          z >= bounds.minZ && z <= bounds.maxZ
        ), bounds) || [])
      : contraption.blocks.filter((b: any) => {
        const owner = contraptionBlockOwnerId(contraption, b);
        if (owner !== nodeId) return false;
        const s = b.size || 1;
        return (
          b.localX < maxMeterX - 1e-6 &&
          b.localX + s > minMeterX + 1e-6 &&
          b.localY < maxMeterY - 1e-6 &&
          b.localY + s > minMeterY + 1e-6 &&
          b.localZ < maxMeterZ - 1e-6 &&
          b.localZ + s > minMeterZ + 1e-6
        );
      });

    this.selectedBlockSelection.blocks = matchingBlocks;
    this.selectedBlockSelection.micro = isMicro;
    this.selectedBlockSelection.virtualMicro = matchingBlocks.some((b: any) => b.virtualMicro === true);
    this.selectedBlockSelection.shapeCells = null;
    contraption.clearSubtreeHighlight?.();
    contraption.highlightBlocks?.(matchingBlocks);

    const node = contraption.entityNodes?.get?.(nodeId);
    const frame = node?.group ? { object: node.group, pivot: (node.pivotLocal || new THREE.Vector3()).clone() } : null;
    // Keep the outer cuboid guide box visible while the axis gizmo expands the
    // box selection instead of hiding the hologram.
    this.sceneRenderer?.updateSelectionHologram?.(bounds, null, null, isMicro, frame);

    return { ok: true, bounds, count: matchingBlocks.length };
  }

  updateSelectionAxisGizmo() {
    if (this.activeTool !== SpecialTool.SELECTOR) {
      this.hoveredGizmoHandle = null;
      this.sceneRenderer?.clearSelectionAxisGizmo?.();
      return;
    }

    const isMicro = this.selectorMicroMode === true;
    let bounds: any = null;
    let frame: any = null;

    if (isMicro) {
      bounds = this.contraptions?.getMicroSelectionBounds?.();
    } else {
      if (this.contraptions && this.contraptions.selectionCornerA !== null && this.contraptions.selectionCornerB !== null) {
        bounds = this.contraptions.getSelectionBounds?.();
      }
    }

    if (!bounds) {
      if (this.selectedBlockSelection && this.selectedBlockSelection.contraption) {
        const contraption = this.selectedBlockSelection.contraption;
        const nodeId = this.selectedBlockSelection.nodeId;
        const node = contraption.entityNodes?.get?.(nodeId);
        if (node && node.group) {
          if (!this.selectedBlockSelection.bounds) {
            this.selectedBlockSelection.bounds = this.getEntitySelectionBounds(this.selectedBlockSelection.blocks, isMicro);
          }
          bounds = this.selectedBlockSelection.bounds;
          if (bounds) {
            frame = {
              object: node.group,
              pivot: (node.pivotLocal || new THREE.Vector3()).clone()
            };
          }
        }
      } else if (this.selectedSubtree && this.selectedSubtree.contraption) {
        // While the first box point is still pending the subtree bounds are just
        // the whole entity, so the XYZ resize gizmo stays hidden until the box
        // is completed (second click).
        const boxPending = !!this.selectorRange?.pointA && !this.selectorRange?.pointB;
        const contraption = this.selectedSubtree.contraption;
        const rootId = this.selectedSubtree.rootId;
        const node = contraption.entityNodes?.get?.(rootId);
        if (!boxPending && node && node.group && this.canEditEntityInternals(contraption)) {
          const nodeIds = this.selectedSubtree.nodeIds || this.collectSubtreeIds(contraption, rootId);
          const blocks = contraption.blocks.filter((b: any) => nodeIds.has(contraptionBlockOwnerId(contraption, b)));
          bounds = this.getEntitySelectionBounds(blocks, isMicro);
          if (bounds) {
            frame = {
              object: node.group,
              pivot: (node.pivotLocal || new THREE.Vector3()).clone()
            };
          }
        }
      }
    }

    if (!bounds) {
      this.hoveredGizmoHandle = null;
      this.sceneRenderer?.clearSelectionAxisGizmo?.();
      return;
    }

    this.sceneRenderer?.updateSelectionAxisGizmo?.(bounds, isMicro, frame);

    // If currently dragging, maintain active handle highlight
    if (this.activeGizmoDrag) {
      this.sceneRenderer?.highlightSelectionGizmoHandle?.(this.activeGizmoDrag.handleKey);
      return;
    }

    // When pointer is locked, raycast against gizmo handles from the crosshair.
    // The gizmo is drawn in bent space, so the pick ray must be bent too,
    // otherwise the handles miss by the torus distortion.
    if (this.isLocked) {
      const eyePos = this.physics?.getEyePosition?.() || this.camera.position;
      const forwardFlat = PlayerController._forwardFlat
        .set(0, 0, -1)
        .applyQuaternion(this.camera.quaternion);
      const eyeBent = bendPoint(eyePos.x, eyePos.y, eyePos.z, PlayerController._bentEye);
      const forwardBent = bendDirection(
        eyePos.x, eyePos.y, eyePos.z, forwardFlat, PlayerController._forwardBent
      );
      const hit = this.sceneRenderer?.raycastSelectionGizmoBent?.(eyeBent, forwardBent);
      this.hoveredGizmoHandle = hit;
      this.sceneRenderer?.highlightSelectionGizmoHandle?.(hit ? hit.handleKey : null);
    }
  }

  updateSelectionGizmoPointerHover(e: MouseEvent) {
    if (this.activeTool !== SpecialTool.SELECTOR || !this.sceneRenderer) return;
    if (!this.selectionGizmoRaycaster) {
      this.selectionGizmoRaycaster = new THREE.Raycaster();
    }
    const pointer = new THREE.Vector2(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1
    );
    this.selectionGizmoRaycaster.setFromCamera(pointer, this.camera);
    const flatOrigin = this.selectionGizmoRaycaster.ray.origin;
    const flatDirection = this.selectionGizmoRaycaster.ray.direction;
    const eyeBent = bendPoint(flatOrigin.x, flatOrigin.y, flatOrigin.z, PlayerController._bentEye);
    const directionBent = bendDirection(
      flatOrigin.x, flatOrigin.y, flatOrigin.z, flatDirection, PlayerController._forwardBent
    );
    const hit = this.sceneRenderer.raycastSelectionGizmoBent
      ? this.sceneRenderer.raycastSelectionGizmoBent(eyeBent, directionBent)
      : this.sceneRenderer.raycastSelectionGizmo(this.selectionGizmoRaycaster);
    this.hoveredGizmoHandle = hit;
    this.sceneRenderer.highlightSelectionGizmoHandle(hit ? hit.handleKey : null);
  }

  startGizmoDrag(hit: any, e: MouseEvent | null = null) {
    if (!hit) return;
    const isEntity = !!(this.selectedBlockSelection || this.selectedSubtree);
    this.activeGizmoDrag = {
      handleKey: hit.handleKey,
      axis: hit.axis,
      direction: hit.direction,
      isMicro: this.selectorMicroMode === true,
      isEntity,
      accumulatedDelta: 0,
      startX: e ? e.clientX : 0,
      startY: e ? e.clientY : 0,
      lastX: e ? e.clientX : 0,
      lastY: e ? e.clientY : 0
    };
    this.sound?.playWrenchClick?.();
  }

  updateGizmoDrag(e: MouseEvent) {
    if (!this.activeGizmoDrag) return;
    const drag = this.activeGizmoDrag;
    const isMicro = drag.isMicro;

    let center: THREE.Vector3 | null = null;
    let worldAxisVec: THREE.Vector3 | null = null;

    if (drag.isEntity) {
      const target = this.selectedBlockSelection?.contraption || this.selectedSubtree?.contraption;
      const nodeId = this.selectedBlockSelection?.nodeId || this.selectedSubtree?.rootId;
      if (!target || !nodeId) {
        this.releaseGizmoDrag();
        return;
      }
      let bounds = this.selectedBlockSelection?.bounds;
      if (!bounds) {
        const blocks = this.selectedBlockSelection?.blocks || (
          this.selectedSubtree ? target.blocks.filter((b: any) => (this.selectedSubtree.nodeIds || this.collectSubtreeIds(target, nodeId)).has(contraptionBlockOwnerId(target, b))) : null
        );
        bounds = this.getEntitySelectionBounds(blocks, isMicro);
      }
      if (!bounds) {
        this.releaseGizmoDrag();
        return;
      }

      const minWx = isMicro ? bounds.minX * MICRO_SIZE : bounds.minX;
      const maxWx = isMicro ? (bounds.maxX + 1) * MICRO_SIZE : bounds.maxX + 1;
      const minWy = isMicro ? bounds.minY * MICRO_SIZE : bounds.minY;
      const maxWy = isMicro ? (bounds.maxY + 1) * MICRO_SIZE : bounds.maxY + 1;
      const minWz = isMicro ? bounds.minZ * MICRO_SIZE : bounds.minZ;
      const maxWz = isMicro ? (bounds.maxZ + 1) * MICRO_SIZE : bounds.maxZ + 1;

      const localCenter = new THREE.Vector3(
        (minWx + maxWx) * 0.5,
        (minWy + maxWy) * 0.5,
        (minWz + maxWz) * 0.5
      );
      center = this.targetEntityLocalToWorld(target, nodeId, localCenter);

      const localAxis = new THREE.Vector3(
        drag.axis === 'x' ? 1 : 0,
        drag.axis === 'y' ? 1 : 0,
        drag.axis === 'z' ? 1 : 0
      );
      const quat = this.getTargetEntityWorldQuaternion(target, nodeId);
      worldAxisVec = localAxis.applyQuaternion(quat);
    } else {
      const bounds = isMicro
        ? this.contraptions.getMicroSelectionBounds()
        : this.contraptions.getSelectionBounds();
      if (!bounds) {
        this.releaseGizmoDrag();
        return;
      }

      const minWx = isMicro ? bounds.minX * MICRO_SIZE : bounds.minX;
      const maxWx = isMicro ? (bounds.maxX + 1) * MICRO_SIZE : bounds.maxX + 1;
      const minWy = isMicro ? bounds.minY * MICRO_SIZE : bounds.minY;
      const maxWy = isMicro ? (bounds.maxY + 1) * MICRO_SIZE : bounds.maxY + 1;
      const minWz = isMicro ? bounds.minZ * MICRO_SIZE : bounds.minZ;
      const maxWz = isMicro ? (bounds.maxZ + 1) * MICRO_SIZE : bounds.maxZ + 1;

      center = new THREE.Vector3(
        (minWx + maxWx) * 0.5,
        (minWy + maxWy) * 0.5,
        (minWz + maxWz) * 0.5
      );

      worldAxisVec = new THREE.Vector3(
        drag.axis === 'x' ? 1 : 0,
        drag.axis === 'y' ? 1 : 0,
        drag.axis === 'z' ? 1 : 0
      );
    }

    const v0 = center.clone().project(this.camera);
    const v1 = center.clone().add(worldAxisVec).project(this.camera);
    const screenDir = new THREE.Vector2(v1.x - v0.x, -(v1.y - v0.y));
    const len = screenDir.length();
    if (len < 1e-4) {
      screenDir.set(1, 0);
    } else {
      screenDir.divideScalar(len);
    }

    let dx = 0, dy = 0;
    if (this.isLocked) {
      dx = Number(e.movementX) || 0;
      dy = Number(e.movementY) || 0;
    } else {
      dx = (e.clientX - drag.lastX);
      dy = (e.clientY - drag.lastY);
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
    }

    const dot = (dx * screenDir.x + dy * screenDir.y) * drag.direction;
    drag.accumulatedDelta += dot;

    const pixelsPerStep = isMicro ? 8 : 16;
    if (Math.abs(drag.accumulatedDelta) >= pixelsPerStep) {
      const steps = Math.trunc(drag.accumulatedDelta / pixelsPerStep);
      drag.accumulatedDelta -= steps * pixelsPerStep;

      if (drag.isEntity) {
        const result = this.expandEntitySelectionAxis(
          drag.axis,
          drag.direction,
          steps,
          isMicro
        );
        if (result.ok) {
          this.sound?.playWrenchClick?.();
          this.updateSelectionAxisGizmo();
        }
      } else {
        const result = this.contraptions.expandSelectionAxis(
          drag.axis,
          drag.direction,
          steps,
          isMicro
        );

        if (result.ok) {
          this.sound?.playWrenchClick?.();
          if (this.selectorShape !== 'box') {
            const cylinderAxis = this.selectionShapeAnchor?.cylinderAxis || 'y';
            const stairsAxis = this.selectionShapeAnchor?.stairsAxis;
            if (isMicro) {
              const mb = this.contraptions.getMicroSelectionBounds();
              if (mb) {
                this.selectionShapeAnchor = {
                  cornerA: { x: mb.minX, y: mb.minY, z: mb.minZ },
                  cornerB: { x: mb.maxX, y: mb.maxY, z: mb.maxZ },
                  micro: true,
                  cylinderAxis,
                  stairsAxis
                };
              }
            } else {
              if (this.contraptions.selectionCornerA && this.contraptions.selectionCornerB) {
                this.selectionShapeAnchor = {
                  cornerA: { ...this.contraptions.selectionCornerA },
                  cornerB: { ...this.contraptions.selectionCornerB },
                  micro: false,
                  cylinderAxis,
                  stairsAxis
                };
              }
            }
            const anchorA = this.selectionShapeAnchor?.cornerA;
            const anchorB = this.selectionShapeAnchor?.cornerB;
            if (anchorA && anchorB) {
              const cells = computeSelectionCells(this.selectorShape, anchorA, anchorB, isMicro, cylinderAxis, stairsAxis);
              if (isMicro) {
                this.contraptions.microSelection = cells;
                this.contraptions.microBounds = null;
              } else {
                this.contraptions.connectedSelection = cells;
              }
            }
          }
          const updatedBounds = isMicro
            ? this.contraptions.getMicroSelectionBounds()
            : this.contraptions.getSelectionBounds();
          this.sceneRenderer?.updateSelectionAxisGizmo(updatedBounds, isMicro);
          this.sceneRenderer?.updateSelectionHologram(
            updatedBounds,
            this.contraptions.connectedSelection,
            this.contraptions.microSelection,
            isMicro && this.selectorShape !== 'box'
          );
        }
      }
    }
  }

  releaseGizmoDrag() {
    this.activeGizmoDrag = null;
  }
}

(PlayerController.prototype as any)._selectorShape = 'box';
