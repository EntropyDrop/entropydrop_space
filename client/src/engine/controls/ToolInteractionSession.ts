import type { BrushSelection } from './SelectionTypes.ts';
import { ActionDomain } from '@entropydrop/space-engine/actions/BasicActions.ts';
import { MAX_SELECTION_BOUNDS } from '@entropydrop/space-engine/constants/SpaceConstants.ts';
import { MICRO_DIVISIONS, MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import * as THREE from 'three';
import type { Point3 } from '../render/PreviewTypes.ts';
import { RESERVED_ENTITY_INPUT_CODES, SpecialTool } from './ControlBindings.ts';
import type { PlayerController } from './PlayerController.ts';
import { contraptionRootId } from './SelectionGeometry.ts';

export interface ToolInteractionSessionPort {
  applySelectionShape: PlayerController['applySelectionShape'];
  boxSelectionPreview: PlayerController['boxSelectionPreview'];
  bulkEditJob: PlayerController['bulkEditJob'];
  canEditEntityInternals: PlayerController['canEditEntityInternals'];
  canPlaceStandardAt: PlayerController['canPlaceStandardAt'];
  clearHammerRotation: PlayerController['clearHammerRotation'];
  clearSelection: PlayerController['clearSelection'];
  clearWrenchPivotDisplay: PlayerController['clearWrenchPivotDisplay'];
  contraptions: PlayerController['contraptions'];
  currentRaycast: PlayerController['currentRaycast'];
  focusBlockPreview: PlayerController['focusBlockPreview'];
  handleBrushRightClick: PlayerController['handleBrushRightClick'];
  handleRunningEntityInteraction: PlayerController['handleRunningEntityInteraction'];
  hoveredContraption: PlayerController['hoveredContraption'];
  hoveredContraptionHit: PlayerController['hoveredContraptionHit'];
  hoveredGizmoHandle: PlayerController['hoveredGizmoHandle'];
  hoveredWrenchGizmoHandle: PlayerController['hoveredWrenchGizmoHandle'];
  inventoryPlacementPreview: PlayerController['inventoryPlacementPreview'];
  keys: PlayerController['keys'];
  microCarvePreview: PlayerController['microCarvePreview'];
  modeling: PlayerController['modeling'];
  paintTargetedBlock: PlayerController['paintTargetedBlock'];
  particles: PlayerController['particles'];
  pasteInventorySlot: PlayerController['pasteInventorySlot'];
  performAimRaycast: PlayerController['performAimRaycast'];
  performBasicAction: PlayerController['performBasicAction'];
  physics: PlayerController['physics'];
  releaseGizmoDrag: PlayerController['releaseGizmoDrag'];
  releaseWrenchGizmoDrag: PlayerController['releaseWrenchGizmoDrag'];
  releaseWrenchGrab: PlayerController['releaseWrenchGrab'];
  rotateActiveInventoryItem: PlayerController['rotateActiveInventoryItem'];
  sampleTargetedColor: PlayerController['sampleTargetedColor'];
  sceneRenderer: PlayerController['sceneRenderer'];
  selectedBlockSelection: PlayerController['selectedBlockSelection'];
  selectedColor: PlayerController['selectedColor'];
  selectedMaterialId: PlayerController['selectedMaterialId'];
  selectedSubtree: PlayerController['selectedSubtree'];
  selectionShapeAnchor: PlayerController['selectionShapeAnchor'];
  selectorLevel: PlayerController['selectorLevel'];
  selectorMicroCellFromRaycast: PlayerController['selectorMicroCellFromRaycast'];
  selectorMicroMode: PlayerController['selectorMicroMode'];
  selectorOnEntityClick: PlayerController['selectorOnEntityClick'];
  selectorRange: PlayerController['selectorRange'];
  selectorShape: PlayerController['selectorShape'];
  sound: PlayerController['sound'];
  startGizmoDrag: PlayerController['startGizmoDrag'];
  startWrenchGizmoDrag: PlayerController['startWrenchGizmoDrag'];
  startWrenchGrab: PlayerController['startWrenchGrab'];
  ui: PlayerController['ui'];
}

/** Owns tool switching, command gestures and per-frame entity keyboard input. */
export class ToolInteractionSession {
  private readonly host: ToolInteractionSessionPort;
  constructor(host: ToolInteractionSessionPort) { this.host = host; }
  _activeTool = '';
  toolUseSequence = 0;
  entityInputDown = new Set<string>();
  entityInputPressed = new Set<string>();
  entityInputReleased = new Set<string>();
  brushMicroMode = false;
  brushSelection: BrushSelection | null = null;
  worldPickingSuspended = false;
  pendingInteractionStops = new WeakSet<object>();

  get activeTool(): string {
    return this._activeTool;
  }

  set activeTool(tool: string) {
    const prev = this._activeTool;
    if (prev === tool) return;
    // Hammer rotation is a placement-only pose. Leaving (or entering) a tool
    // must never carry that pose into a later Hammer session.
    this.host.clearHammerRotation();
    if ((prev === SpecialTool.SELECTOR || prev === SpecialTool.SUPER_GLUE) &&
      (tool !== SpecialTool.SELECTOR && tool !== SpecialTool.SUPER_GLUE)) {
      this.host.clearSelection();
    }
    if (tool === SpecialTool.BRUSH) {
      this.host.hoveredContraption?.clearFocusHighlight?.();
    }
    if (prev === SpecialTool.BRUSH && tool !== SpecialTool.BRUSH) {
      this.clearBrushSelection();
    }
    if (prev === SpecialTool.WRENCH && tool !== SpecialTool.WRENCH) {
      this.host.releaseWrenchGizmoDrag();
      this.host.releaseWrenchGrab();
      this.host.clearWrenchPivotDisplay();
    }
    if (prev === SpecialTool.MODELING && tool !== SpecialTool.MODELING) this.host.modeling.deactivate();
    this._activeTool = tool;
  }

  setWorldPickingSuspended(suspended: boolean): void {
    const next = Boolean(suspended);
    if (this.worldPickingSuspended === next) return;
    this.worldPickingSuspended = next;
    if (!next) return;

    this.host.modeling?.deactivate();
    this.host.releaseWrenchGizmoDrag();
    this.host.releaseGizmoDrag();
    this.host.releaseWrenchGrab();

    const hovered = this.host.hoveredContraptionHit?.contraption || this.host.hoveredContraption;
    if (hovered) {
      hovered.setHighlighted?.(false);
      hovered.clearFocusHighlight?.();
    }
    this.host.currentRaycast = { hit: false };
    this.host.hoveredContraption = null;
    this.host.hoveredContraptionHit = null;
    this.host.hoveredGizmoHandle = null;
    this.host.hoveredWrenchGizmoHandle = null;
    this.host.microCarvePreview = null;
    this.host.focusBlockPreview = null;
    this.host.boxSelectionPreview = null;
    this.host.inventoryPlacementPreview = null;
    this.host.clearWrenchPivotDisplay();

    this.host.sceneRenderer?.setCursor?.(null);
    this.host.sceneRenderer?.setMicroCarvePreview?.(null);
    this.host.sceneRenderer?.clearFocusBlockGuide?.();
    this.host.sceneRenderer?.clearBoxSelectionPreview?.();
    this.host.sceneRenderer?.setInventoryPlacementPreview?.(null);
    this.host.sceneRenderer?.clearSelectionAxisGizmo?.();
    this.host.sceneRenderer?.highlightSelectionGizmoHandle?.(null);
  }

  clearBrushSelection() {
    this.brushSelection = null;
    if (this.activeTool === SpecialTool.BRUSH) {
      this.host.boxSelectionPreview = null;
      this.host.sceneRenderer?.clearBoxSelectionPreview?.();
      this.host.hoveredContraption?.clearFocusHighlight?.();
    }
  }

  recordEntityKeyDown(code: string) {
    if (!code || RESERVED_ENTITY_INPUT_CODES.has(code)) return false;
    if (!this.entityInputDown.has(code)) {
      this.entityInputPressed.add(code);
    }
    this.entityInputDown.add(code);
    return true;
  }

  recordEntityKeyUp(code: string) {
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

  handleLeftClick(e: MouseEvent | null = null) {
    if (this.worldPickingSuspended) return false;
    if (this.host.ui?.tryToggleEntityPlaybackAtPointer?.(e)) return true;
    if (this.host.ui?.tryOpenEntityContextMenuAtPointer?.(e)) return true;
    if (this.activeTool === SpecialTool.MODELING) return this.host.modeling.leftDown(e);
    if (this.host.bulkEditJob) {
      this.host.ui?.showToast?.(`Please wait for ${this.host.bulkEditJob.label.toLowerCase()} to finish`);
      return false;
    }
    // Count accepted game clicks, including swings into empty space. DOM/UI
    // clicks never reach this method unless the game owns pointer lock.
    this.toolUseSequence = (this.toolUseSequence || 0) + 1;
    // Consume one physical attempt before compound voxel actions can dispatch.
    if ([SpecialTool.SHOVEL, SpecialTool.SPOON, SpecialTool.BRUSH].includes(this.activeTool)
      && !(this.activeTool === SpecialTool.BRUSH && this.brushSelection)
      && this.host.handleRunningEntityInteraction(this.host.hoveredContraptionHit?.contraption)) return false;
    const selectorTool = this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE;
    const selectorTarget = this.host.hoveredGizmoHandle
      ? this.host.selectedBlockSelection?.contraption || this.host.selectedSubtree?.contraption
      : this.host.hoveredContraptionHit?.contraption;
    if (selectorTool && this.host.handleRunningEntityInteraction(selectorTarget)) return false;
    // Selector XYZ coordinate axis gizmo dragging
    if (this.activeTool === SpecialTool.SELECTOR && this.host.hoveredGizmoHandle) {
      this.host.startGizmoDrag(this.host.hoveredGizmoHandle, e);
      return;
    }

    // Hammer owns inventory construction. Selection never places inventory
    // contents, so copying and building remain distinct tool modes.
    if (this.activeTool === SpecialTool.HAMMER) {
      this.host.pasteInventorySlot(!!(e?.shiftKey || this.host.keys?.crouch));
      return;
    }

    if (this.activeTool === SpecialTool.WRENCH) {
      if (this.host.hoveredWrenchGizmoHandle) {
        this.host.startWrenchGizmoDrag(this.host.hoveredWrenchGizmoHandle, e);
        return;
      }
      this.host.startWrenchGrab();
      return;
    }

    // 1. Shovel -> remove one standard 1x1x1 cell or entity block. If pointing at
    // micro-geometry, remove the micro cells contained in that standard cell.
    if (this.activeTool === SpecialTool.SHOVEL) {
      if (this.host.hoveredContraptionHit) {
        const hit = this.host.hoveredContraptionHit;
        const c = hit.contraption;
        const targetNodeId = hit.entityId ?? contraptionRootId(c);
        const hitCell = hit.cell;
        let result;

        if (hit.kind === 'micro') {
          result = this.host.performBasicAction({
            domain: ActionDomain.ENTITY,
            action: 'clear-cell',
            target: { contraption: c },
            nodeId: targetNodeId,
            cell: hitCell,
            microOnly: true
          });
          if (result.empty) {
            if (this.host.ui) this.host.ui.showToast(`Entity #${c.id} fully dismantled`);
          } else if (result.ok) {
            this.host.ui?.notifyContraptionStructureChanged(c);
            if (this.host.ui) {
              this.host.ui.showToast(`Shovel removed ${result.removed} micro voxels (1 standard cell) from [${targetNodeId}]`);
            }
          }
        } else {
          result = this.host.performBasicAction({
            domain: ActionDomain.ENTITY,
            action: 'remove-standard',
            target: { contraption: c },
            nodeId: targetNodeId,
            cell: hitCell
          });
          if (result.empty) {
            if (this.host.ui) this.host.ui.showToast(`Entity #${c.id} fully dismantled`);
          } else if (result.ok) {
            this.host.ui?.notifyContraptionStructureChanged(c);
            if (this.host.ui) {
              this.host.ui.showToast(`Shovel removed 1 standard block from [${targetNodeId}]`);
            }
          }
        }
        if ((result?.removed || 0) > 0) {
          this.host.particles.emitBlockBreak(hit.point, hit.color || this.host.selectedColor, 12);
          this.host.sound.playBlockBreak({ kind: 'standard', count: result.removed });
        }
        return;
      }

      if (!this.host.currentRaycast.hit) return;
      let result;
      if (this.host.currentRaycast.kind === 'micro') {
        const mp = this.host.currentRaycast.microPos;
        const wx = Math.floor(mp.x / MICRO_DIVISIONS);
        const wy = Math.floor(mp.y / MICRO_DIVISIONS);
        const wz = Math.floor(mp.z / MICRO_DIVISIONS);
        result = this.host.performBasicAction({
          domain: ActionDomain.WORLD,
          action: 'clear-cell',
          cell: { x: wx, y: wy, z: wz },
          microOnly: true
        });
        if (result.removed && this.host.ui) this.host.ui.showToast(`Shovel removed ${result.removed} micro voxels (1 standard cell)`);
      } else {
        const hp = this.host.currentRaycast.hitPos;
        result = this.host.performBasicAction({ domain: ActionDomain.WORLD, action: 'remove-standard', cell: hp });
        if ((result.removed || 0) > 0) {
          this.host.particles.emitBlockBreak(hp, this.host.currentRaycast.color || this.host.selectedColor, 12);
        }
      }
      if ((result?.removed || 0) > 0) {
        this.host.sound.playBlockBreak({ kind: 'standard', count: result.removed });
      }
      return;
    }

    // 2. Spoon -> subdivide a standard block, then edit individual micro cells.
    if (this.activeTool === SpecialTool.SPOON) {
      if (this.host.hoveredContraptionHit) {
        const hit = this.host.hoveredContraptionHit;
        const c = hit.contraption;
        const targetNodeId = hit.entityId ?? contraptionRootId(c);
        const hitCell = hit.cell;
        let result;

        if (hit.kind === 'micro' && hit.block) {
          result = this.host.performBasicAction({
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
            if (this.host.ui) this.host.ui.showToast(`Entity #${c.id} fully micro-carved away`);
          } else if (result.ok) {
            this.host.ui?.notifyContraptionStructureChanged(c);
            if (this.host.ui) {
              this.host.ui.showToast(`Spoon removed 1 micro voxel from [${targetNodeId}]`);
            }
          }
        } else {
          const carved = [
            Math.round((hit.placeMicroPos.localX - hit.normal.x * MICRO_SIZE) * MICRO_DIVISIONS),
            Math.round((hit.placeMicroPos.localY - hit.normal.y * MICRO_SIZE) * MICRO_DIVISIONS),
            Math.round((hit.placeMicroPos.localZ - hit.normal.z * MICRO_SIZE) * MICRO_DIVISIONS)
          ];
          result = this.host.performBasicAction({
            domain: ActionDomain.ENTITY,
            action: 'subdivide-standard',
            target: { contraption: c },
            nodeId: targetNodeId,
            cell: hitCell,
            micro: carved
          });
          if (result.ok) {
            this.host.ui?.notifyContraptionStructureChanged(c);
            if (this.host.ui) {
              this.host.ui.showToast(`Carved 1 micro voxel out of a subdivided block on [${targetNodeId}] (511 left)`);
            }
          }
        }
        if ((result?.removed || 0) > 0) {
          this.host.particles.emitBlockBreak(hit.point, hit.color || this.host.selectedColor, 4);
          this.host.sound.playBlockBreak({ kind: 'micro', count: result.removed });
        }
        return;
      }

      if (!this.host.currentRaycast.hit) return;
      const publishedHit = this.host.currentRaycast;
      const publishedCell = publishedHit.kind === 'micro'
        ? {
          x: Math.floor(publishedHit.microPos.x / MICRO_DIVISIONS),
          y: Math.floor(publishedHit.microPos.y / MICRO_DIVISIONS),
          z: Math.floor(publishedHit.microPos.z / MICRO_DIVISIONS),
        }
        : publishedHit.hitPos;

      const carve = (hit: { kind: string; microPos: Point3; hitPos: Point3; normal: Point3; entry?: Point3 }) => {
        if (hit.kind === 'micro') {
          return this.host.performBasicAction({
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
          : this.host.physics.getEyePosition();
        const clamp = (value: number, base: number) => Math.max(base * MICRO_DIVISIONS, Math.min(
          base * MICRO_DIVISIONS + MICRO_DIVISIONS - 1,
          value,
        ));
        const carveMicro = [
          clamp(Math.floor((entry.x + normal.x * 0.02) * MICRO_DIVISIONS), hp.x),
          clamp(Math.floor((entry.y + normal.y * 0.02) * MICRO_DIVISIONS), hp.y),
          clamp(Math.floor((entry.z + normal.z * 0.02) * MICRO_DIVISIONS), hp.z),
        ];
        return this.host.performBasicAction({
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
        const liveQuery = this.host.performAimRaycast('all', false);
        const liveHit = liveQuery.kind === 'world' ? liveQuery.worldHit : null;
        const liveCell = liveHit?.kind === 'micro' && 'microPos' in liveHit && liveHit.microPos
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
        if (carvedHit.kind === 'standard' && this.host.ui) {
          this.host.ui.showToast(`Carved 1 micro voxel out of ${result.subdivided} (511 left)`);
        }
        this.host.particles.emitBlockBreak(carvedHit.hitPos, carvedHit.color, 4);
        this.host.sound.playBlockBreak({ kind: 'micro', count: result.removed });
      }
      return;
    }

    // 3. Brush -> Paint / Override block color directly, or cancel pending 2-point selection
    if (this.activeTool === SpecialTool.BRUSH) {
      if (this.brushSelection) {
        this.clearBrushSelection();
        this.host.sound?.playWrenchClick?.();
        if (this.host.ui) this.host.ui.showToast('Brush selection cancelled');
        return;
      }
      this.host.paintTargetedBlock();
      return;
    }

    // 4. Pipette -> Pick / Sample block color directly
    if (this.activeTool === SpecialTool.PIPETTE) {
      this.host.sampleTargetedColor();
      return;
    }

    // 5. Tool: Selector — entity/component level selection, 2-point block box,
    //    and R/T copy. Inventory construction belongs exclusively to Hammer.
    if (this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE) {
      const isMultiSelect = !!(e?.shiftKey || this.host.keys.crouch);

      const worldPoint = this.host.currentRaycast && this.host.currentRaycast.hit
        ? new THREE.Vector3(this.host.currentRaycast.hitPos.x, this.host.currentRaycast.hitPos.y, this.host.currentRaycast.hitPos.z)
        : null;

      // When in preselected state (completed selection without an in-progress 2-point drag),
      // a plain left click on any block (entity or world) dismisses the selection and returns to unselected.
      // A subtree-only selection created by Shift+click on an editable level also
      // counts as preselected. Running interactions are consumed before this branch.
      const isEntityBoxInProgress = !!(this.host.selectorRange && this.host.selectorRange.pointA && !this.host.selectorRange.pointB);
      const isWorldBoxInProgress = !!(this.host.contraptions && this.host.contraptions.selectionCornerA !== null && this.host.contraptions.selectionCornerB === null);
      const isEditableSubtreeSelection = !!(
        this.host.selectedSubtree?.contraption &&
        this.host.selectedBlockSelection === null &&
        this.host.canEditEntityInternals(this.host.selectedSubtree.contraption)
      );
      const isPreselected = !!(
        isEditableSubtreeSelection ||
        (this.host.selectedBlockSelection && this.host.selectedBlockSelection.blocks?.length > 0) ||
        (this.host.contraptions && typeof this.host.contraptions.hasValidSelection === 'function' && this.host.contraptions.hasValidSelection())
      );
      const clickedAnyBlock = !!(this.host.hoveredContraptionHit || worldPoint);
      if (!isMultiSelect && !isEntityBoxInProgress && !isWorldBoxInProgress && isPreselected && clickedAnyBlock) {
        this.host.clearSelection();
        return;
      }

      if (this.host.hoveredContraptionHit) {
        // If world selection was in progress (cornerA was set on world terrain), but point 2 hits an entity:
        if (this.host.contraptions && this.host.contraptions.selectionCornerA !== null && this.host.contraptions.selectionCornerB === null) {
          this.host.contraptions.selectionCornerA = null;
          this.host.contraptions.selectionCornerB = null;
          this.host.boxSelectionPreview = null;
          this.host.sceneRenderer?.clearBoxSelectionPreview?.();
          this.host.ui?.showToast?.('A selection that starts in the world cannot end on an entity.', { tone: 'warning' });
          return;
        }
        // Entity/component hit:
        //   First click  → select that component level (auto-highlights its subtree, not its parent).
        //   Second click → advance the 2-point box selection for that level's own blocks only.
        //   Shift+click  → multi-select / toggle individual blocks or micro-blocks.
        this.host.selectorOnEntityClick(this.host.hoveredContraptionHit, e);
        return;
      }

      // Micro selection mode (Tab) targets the 0.125 m cell under the crosshair
      // instead of the whole standard cell.
      const microCell = this.host.selectorMicroMode ? this.host.selectorMicroCellFromRaycast() : null;
      const targetPoint = microCell
        ? new THREE.Vector3(microCell.x / MICRO_DIVISIONS, microCell.y / MICRO_DIVISIONS, microCell.z / MICRO_DIVISIONS)
        : worldPoint;
      if (!targetPoint) return;

      // Shift + world click: exit entity box-selection level, enter world single-cell mode.
      if (isMultiSelect && worldPoint) {
        if (this.host.selectedSubtree) {
          this.host.selectedSubtree.contraption.clearSubtreeHighlight();
          this.host.selectedSubtree = null;
        }
        if (this.host.selectedBlockSelection) {
          this.host.selectedBlockSelection.contraption.clearSubtreeHighlight();
        }
        this.host.selectedBlockSelection = null;
        this.host.selectorLevel = null;
        this.host.selectorRange = null;
        const info = this.host.performBasicAction({
          domain: ActionDomain.SELECTION,
          action: 'toggle-cell',
          point: targetPoint,
          micro: this.host.selectorMicroMode === true
        }).selection;
        if (info?.rejected && this.host.ui) {
          this.host.ui.showToast(`Selected cell lies outside the ${MAX_SELECTION_BOUNDS}×${MAX_SELECTION_BOUNDS}×${MAX_SELECTION_BOUNDS} limit`, { tone: 'warning' });
        }
        return;
      }

      // If entity selection was in progress (corner 1 on entity), but corner 2 is clicked on world:
      if (this.host.selectorRange && this.host.selectorRange.pointA && !this.host.selectorRange.pointB && worldPoint) {
        this.host.selectorRange = null;
        this.host.selectorLevel = null;
        this.host.boxSelectionPreview = null;
        this.host.sceneRenderer?.clearBoxSelectionPreview?.();
        this.host.ui?.showToast?.('A selection that starts on an entity must end on that same entity.', { tone: 'warning' });
        return;
      }

      // World hit (no active entity box-selection): clear entity/component state and enter
      // world 2-point box mode. Previously this would unconditionally re-enter "re-box entity
      // level", causing selectorLevel to persist after G-assembly so clicks outside the entity
      // could never start a world selection. Now: world click = world box; entity click = re-box
      // entity level. A click that hits nothing (sky) intentionally leaves the current entity
      // selection untouched — missing a shot must not cancel an in-progress 2-point box.
      if (worldPoint) {
        if (this.host.selectedSubtree) {
          this.host.selectedSubtree.contraption.clearSubtreeHighlight();
          this.host.selectedSubtree = null;
        }
        if (this.host.selectedBlockSelection) {
          this.host.selectedBlockSelection.contraption.clearSubtreeHighlight();
        }
        this.host.selectedBlockSelection = null;
        this.host.selectorLevel = null;
        this.host.selectorRange = null;

        const hp = worldPoint;
        if (isMultiSelect) {
          const info = this.host.performBasicAction({
            domain: ActionDomain.SELECTION,
            action: 'toggle-cell',
            point: targetPoint,
            micro: this.host.selectorMicroMode === true
          }).selection;
          if (info?.rejected && this.host.ui) {
            this.host.ui.showToast(`Selected cell lies outside the ${MAX_SELECTION_BOUNDS}×${MAX_SELECTION_BOUNDS}×${MAX_SELECTION_BOUNDS} limit`, { tone: 'warning' });
          }
        } else {
          // 2-point world box: cornerA then cornerB define the diagonal AABB.
          // In micro mode the confirmed box materializes into the existing
          // micro voxels it contains; a plain click on the completed set clears it.
          if (this.host.selectorMicroMode && Array.isArray(this.host.contraptions?.microSelection)) {
            this.host.clearSelection();
          } else if (this.host.contraptions.selectionCornerA === null) {
            this.host.performBasicAction({
              domain: ActionDomain.SELECTION,
              action: 'corner-a',
              point: targetPoint,
              micro: this.host.selectorMicroMode === true
            });
            this.host.selectionShapeAnchor = {
              cornerA: this.host.selectorMicroMode && microCell ? { ...microCell } : { x: Math.floor(hp.x), y: Math.floor(hp.y), z: Math.floor(hp.z) },
              cornerB: null,
              micro: this.host.selectorMicroMode === true
            };
          } else if (this.host.contraptions.selectionCornerB === null) {
            const cornerResult = this.host.performBasicAction({
              domain: ActionDomain.SELECTION,
              action: 'corner-b',
              point: targetPoint,
              micro: this.host.selectorMicroMode === true
            });
            const ptB = this.host.selectorMicroMode && microCell ? { ...microCell } : { x: Math.floor(hp.x), y: Math.floor(hp.y), z: Math.floor(hp.z) };
            if (this.host.selectionShapeAnchor) {
              this.host.selectionShapeAnchor.cornerB = ptB;
            } else {
              this.host.selectionShapeAnchor = {
                cornerA: this.host.selectorMicroMode && microCell ? { ...microCell } : { x: Math.floor(hp.x), y: Math.floor(hp.y), z: Math.floor(hp.z) },
                cornerB: ptB,
                micro: this.host.selectorMicroMode === true
              };
            }
            if (this.host.selectorShape !== 'box') {
              this.host.applySelectionShape(this.host.selectorShape);
            }
            if (cornerResult?.clamped && this.host.ui) {
              this.host.ui.showToast(`Selection exceeds ${MAX_SELECTION_BOUNDS}×${MAX_SELECTION_BOUNDS}×${MAX_SELECTION_BOUNDS} limit · clamped to bounds`, { tone: 'warning' });
            }
          } else {
            // Box already complete — next plain click clears it and resets to idle.
            this.host.clearSelection();
          }
        }
      }
      return;
    }
  }

  handleRightClick(e: MouseEvent | null = null) {
    if (this.worldPickingSuspended) return false;
    if (this.host.ui?.tryOpenEntityContextMenuAtPointer?.(e)) return true;
    if (this.activeTool === SpecialTool.MODELING) return this.host.modeling.beginCreation(e);
    // Selector RMB opens the complete action menu. Pointer lock is released by
    // the UI bridge so the player can choose an item, then restored on close.
    if (this.activeTool === SpecialTool.SELECTOR || this.activeTool === SpecialTool.SUPER_GLUE) {
      this.host.ui?.showSelectorContextMenu?.({
        x: Number(e?.clientX),
        y: Number(e?.clientY)
      });
      return true;
    }
    // Wrench RMB opens the same entity action menu as the nameplate ellipsis.
    if (this.activeTool === SpecialTool.WRENCH) {
      const target = this.host.hoveredContraptionHit?.contraption || this.host.hoveredContraption;
      if (!target) {
        this.host.ui?.showToast?.('Wrench: point at an entity to open its actions');
        return false;
      }
      return this.host.ui?.showEntityContextMenu?.(target, {
        x: Number(e?.clientX),
        y: Number(e?.clientY)
      }) ?? false;
    }
    if (this.host.bulkEditJob) {
      this.host.ui?.showToast?.(`Please wait for ${this.host.bulkEditJob.label.toLowerCase()} to finish`);
      return false;
    }
    if ([SpecialTool.SHOVEL, SpecialTool.SPOON, SpecialTool.BRUSH].includes(this.activeTool)
      && this.host.handleRunningEntityInteraction(this.host.hoveredContraptionHit?.contraption)) return false;
    const isRecolorModifier = e && (e.shiftKey || this.host.keys.crouch);

    // 1. Shovel -> place one standard block, replacing micro cells in the cell.
    // When Shift is held, recolor the targeted block without placing a new one.
    if (this.activeTool === SpecialTool.SHOVEL) {
      if (isRecolorModifier) {
        this.host.paintTargetedBlock();
        return;
      }

      if (this.host.hoveredContraptionHit) {
        const hit = this.host.hoveredContraptionHit;
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

        const result = this.host.performBasicAction({
          domain: ActionDomain.ENTITY,
          action: 'place-standard',
          target: { contraption: c },
          nodeId: targetNodeId,
          cell: targetCell,
          color: this.host.selectedColor,
          options: { color: this.host.selectedColor, materialId: this.host.selectedMaterialId }
        });
        if (!result.ok) {
          if (result.reason === 'occupied' && this.host.ui) {
            this.host.ui.showToast('Target cell is occupied; the shovel never overwrites existing geometry');
          }
          return;
        }
        this.host.ui?.notifyContraptionStructureChanged(c);
        this.host.sound.playBlockPlace();
        if (this.host.ui) {
          this.host.ui.showToast(`Added 1 standard block to [${targetNodeId}]`);
        }
        return;
      }

      if (!this.host.currentRaycast.hit) return;

      let target;
      if (this.host.currentRaycast.kind === 'micro') {
        // Carved cell is treated as one block: target = neighbor along the normal
        const mp = this.host.currentRaycast.microPos;
        const normal = this.host.currentRaycast.normal;
        target = {
          x: Math.floor(mp.x / MICRO_DIVISIONS) + (normal?.x || 0),
          y: Math.floor(mp.y / MICRO_DIVISIONS) + (normal?.y || 0),
          z: Math.floor(mp.z / MICRO_DIVISIONS) + (normal?.z || 0)
        };
      } else {
        target = this.host.currentRaycast.placePos;
      }
      if (!this.host.canPlaceStandardAt(target)) return;
      const result = this.host.performBasicAction({
        domain: ActionDomain.WORLD,
        action: 'place-standard',
        cell: target,
        color: this.host.selectedColor,
        options: { color: this.host.selectedColor, materialId: this.host.selectedMaterialId }
      });
      if (!result.ok && result.reason === 'occupied') {
        if (this.host.ui) this.host.ui.showToast('Target cell is occupied; the shovel never overwrites existing geometry');
        return;
      }
      this.host.sound.playBlockPlace();
      return;
    }

    // 2. Spoon -> place one 1/5-scale micro block on the targeted surface.
    // When Shift is held, recolor the targeted micro block.
    if (this.activeTool === SpecialTool.SPOON) {
      if (isRecolorModifier) {
        this.host.paintTargetedBlock();
        return;
      }

      if (this.host.hoveredContraptionHit) {
        const hit = this.host.hoveredContraptionHit;
        const c = hit.contraption;
        const targetNodeId = hit.entityId ?? contraptionRootId(c);
        const placePos = hit.placeMicroPos;
        const mx = Math.round(placePos.localX * MICRO_DIVISIONS) / MICRO_DIVISIONS;
        const my = Math.round(placePos.localY * MICRO_DIVISIONS) / MICRO_DIVISIONS;
        const mz = Math.round(placePos.localZ * MICRO_DIVISIONS) / MICRO_DIVISIONS;

        const result = this.host.performBasicAction({
          domain: ActionDomain.ENTITY,
          action: 'place-micro',
          target: { contraption: c },
          nodeId: targetNodeId,
          micro: [Math.round(mx * MICRO_DIVISIONS), Math.round(my * MICRO_DIVISIONS), Math.round(mz * MICRO_DIVISIONS)],
          color: this.host.selectedColor,
          options: { color: this.host.selectedColor, materialId: this.host.selectedMaterialId }
        });

        if (result.ok) {
          this.host.ui?.notifyContraptionStructureChanged(c);
          this.host.sound.playBlockPlace();
          if (this.host.ui) {
            this.host.ui.showToast(`Added 1 micro voxel to [${targetNodeId}]`);
          }
        }
        return;
      }

      if (!this.host.currentRaycast.hit) return;

      let targetMicro = this.host.currentRaycast.placeMicroPos;
      if (this.host.currentRaycast.kind === 'standard') {
        const normal = this.host.currentRaycast.normal;
        const entry = this.host.currentRaycast.entry
          ? new THREE.Vector3(this.host.currentRaycast.entry.x, this.host.currentRaycast.entry.y, this.host.currentRaycast.entry.z)
          : this.host.physics.getEyePosition();
        entry.x += normal.x * 0.02;
        entry.y += normal.y * 0.02;
        entry.z += normal.z * 0.02;
        targetMicro = {
          x: Math.floor(entry.x * MICRO_DIVISIONS),
          y: Math.floor(entry.y * MICRO_DIVISIONS),
          z: Math.floor(entry.z * MICRO_DIVISIONS)
        };
      }
      const result = targetMicro && this.host.performBasicAction({
        domain: ActionDomain.WORLD,
        action: 'place-micro',
        micro: targetMicro,
        color: this.host.selectedColor,
        options: { color: this.host.selectedColor, materialId: this.host.selectedMaterialId }
      });
      if (result?.ok) {
        this.host.sound.playBlockPlace();
      }
      return;
    }

    // 3. Brush -> Right-click 2-point box selection and dye region
    if (this.activeTool === SpecialTool.BRUSH) {
      this.host.handleBrushRightClick();
      return;
    }

    // 4. Pipette -> Sample color on right click as well
    if (this.activeTool === SpecialTool.PIPETTE) {
      this.host.sampleTargetedColor();
      return;
    }

    // Hammer RMB rotates the active inventory item 90 degrees around Y axis,
    // centered at the integer/grid-aligned center of the object.
    if (this.activeTool === SpecialTool.HAMMER) {
      return this.host.rotateActiveInventoryItem();
    }

    return;
  }

  toggleBrushMicroMode() {
    this.brushMicroMode = !this.brushMicroMode;
    if (this.host.ui) {
      this.host.ui.updateToolPanelMode?.();
      this.host.ui.renderHotbar?.();
      this.host.ui.showToast(this.brushMicroMode
        ? 'Brush: MICRO mode (0.125 m) · Tab switches to STANDARD'
        : 'Brush: STANDARD mode (1.0 m) · Tab switches to MICRO');
    }
    return this.brushMicroMode;
  }
}
