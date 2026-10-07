import type { CollisionBounds } from '@entropydrop/space-engine/physics/CollisionGeometry.ts';
import { ActionDomain } from '@entropydrop/space-engine/actions/BasicActions.ts';
import { bendDirection, bendPointForView } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { MICRO_DIVISIONS, MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import * as THREE from 'three';
import type { Point3, SelectionFrame, SelectionGizmoHandle, SelectionGizmoHit } from '../render/PreviewTypes.ts';
import { SpecialTool } from './ControlBindings.ts';
import type { PlayerController } from './PlayerController.ts';
import { contraptionBlockOwnerId } from './SelectionGeometry.ts';
import type { ComponentBlockSelection, ComponentRange, ComponentSelection, SubtreeSelection, SelectedVoxel, SelectionGizmoDrag } from './SelectionTypes.ts';
import { computeSelectionCells, type SelectorShape, type StairsOrientation } from './SelectorShapes.ts';

export interface SelectionSessionPort {
  activeTool: PlayerController['activeTool'];
  boxSelectionPreview: PlayerController['boxSelectionPreview'];
  buildEntityMicroSelection: PlayerController['buildEntityMicroSelection'];
  camera: PlayerController['camera'];
  canEditEntityInternals: PlayerController['canEditEntityInternals'];
  clearBrushSelection: PlayerController['clearBrushSelection'];
  collectSubtreeIds: PlayerController['collectSubtreeIds'];
  contraptions: PlayerController['contraptions'];
  focusBlockPreview: PlayerController['focusBlockPreview'];
  getEntitySelectionBounds: PlayerController['getEntitySelectionBounds'];
  getTargetEntityWorldQuaternion: PlayerController['getTargetEntityWorldQuaternion'];
  handleRunningEntityInteraction: PlayerController['handleRunningEntityInteraction'];
  hasActiveSelection: PlayerController['hasActiveSelection'];
  isLocked: PlayerController['isLocked'];
  performBasicAction: PlayerController['performBasicAction'];
  physics: PlayerController['physics'];
  requireConfirmedSelection: PlayerController['requireConfirmedSelection'];
  sceneRenderer: PlayerController['sceneRenderer'];
  sound: PlayerController['sound'];
  targetEntityLocalToWorld: PlayerController['targetEntityLocalToWorld'];
  ui: PlayerController['ui'];
  worldPickingSuspended: PlayerController['worldPickingSuspended'];
}

/** Owns selection state, shape edits and selection gizmo gestures. */
export class SelectionSession {
  private readonly _forwardBent = new THREE.Vector3();
  private readonly _forwardFlat = new THREE.Vector3();
  private readonly _bentEye = new THREE.Vector3();
  private readonly host: SelectionSessionPort;
  constructor(host: SelectionSessionPort) { this.host = host; }
  selectedSubtree: SubtreeSelection | null = null;
  selectedBlockSelection: ComponentBlockSelection | null = null;
  selectorLevel: ComponentSelection | null = null;
  selectorRange: ComponentRange | null = null;
  selectorMicroMode = false;
  selectorShape: SelectorShape = 'box';
  selectionShapeAnchor: { cornerA: Point3; cornerB: Point3 | null; micro: boolean; cylinderAxis?: 'x' | 'y' | 'z'; stairsAxis?: 'x' | 'z'; stairsOrientation?: StairsOrientation } | null = null;
  hoveredGizmoHandle: SelectionGizmoHit | null = null;
  activeGizmoDrag: SelectionGizmoDrag | null = null;
  selectionGizmoRaycaster: THREE.Raycaster | null = null;

  clearSelection() {
    this.selectedSubtree?.contraption?.clearSubtreeHighlight?.();
    this.selectedBlockSelection?.contraption?.clearSubtreeHighlight?.();
    const result = this.host.performBasicAction({ domain: ActionDomain.SELECTION, action: 'clear' });
    this.selectedSubtree = null;
    this.selectedBlockSelection = null;
    this.selectorLevel = null;
    this.selectorRange = null;
    this.selectionShapeAnchor = null;
    this.hoveredGizmoHandle = null;
    this.releaseGizmoDrag();
    this.host.clearBrushSelection();
    this.host.boxSelectionPreview = null;
    this.host.focusBlockPreview = null;
    this.host.sceneRenderer?.clearBoxSelectionPreview?.();
    this.host.sceneRenderer?.clearFocusBlockGuide?.();
    this.host.sceneRenderer?.clearSelectionAxisGizmo?.();
    if (this.host.sceneRenderer && this.host.contraptions) {
      this.host.sceneRenderer.updateSelectionHologram(null, null, null);
    }
    return result;
  }

  toggleSelectorMicroMode() {
    this.selectorMicroMode = !this.selectorMicroMode;
    if (this.selectedBlockSelection?.contraption?.clearSubtreeHighlight) {
      this.selectedBlockSelection.contraption.clearSubtreeHighlight();
    }
    this.selectedBlockSelection = null;
    this.selectorLevel = null;
    this.selectorRange = null;
    this.selectionShapeAnchor = null;
    this.host.contraptions?.clearSelection?.();
    if (this.host.ui) {
      this.host.ui.updateToolPanelMode?.();
      this.host.ui.renderHotbar?.();
      this.host.ui.showToast(this.selectorMicroMode
        ? 'Selector: MICRO mode · Shift+click toggles micro cells · Tab switches to STANDARD'
        : 'Selector: STANDARD mode · Tab switches to MICRO');
    }
    return this.selectorMicroMode;
  }

  setSelectorShape(shape: SelectorShape) {
    this.selectorShape = shape;
    this.applySelectionShape(shape);
    // Publish only after recomputing cells/highlights. The UI's setSelectorShape
    // is a player command that delegates here, not a notification callback.
    this.host.ui?.updateToolPanelMode?.();
  }

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
      const nodeIds = this.selectedSubtree?.nodeIds || this.host.collectSubtreeIds(contraption, nodeId);
      const subtreeBlocks = contraption.blocks.filter((b: SelectedVoxel) => nodeIds.has(contraptionBlockOwnerId(contraption, b)));
      this.selectedBlockSelection = {
        contraption,
        nodeId,
        blocks: subtreeBlocks,
        bounds: this.host.getEntitySelectionBounds(subtreeBlocks, isMicro)
      };
      this.selectedSubtree = null;
    }

    if (!this.selectedBlockSelection) return;

    let bounds = this.selectedBlockSelection.bounds;
    if (!bounds) {
      bounds = this.host.getEntitySelectionBounds(this.selectedBlockSelection.blocks, isMicro);
      this.selectedBlockSelection.bounds = bounds;
    }
    if (!bounds) return;

    const cornerA = anchorA || this.selectionShapeAnchor?.cornerA || { x: bounds.minX, y: bounds.minY, z: bounds.minZ };
    const cornerB = anchorB || this.selectionShapeAnchor?.cornerB || { x: bounds.maxX, y: bounds.maxY, z: bounds.maxZ };
    const cylinderAxis = this.selectionShapeAnchor?.cylinderAxis || 'y';
    const stairsAxis = this.selectionShapeAnchor?.stairsAxis;
    const stairsOrientation = this.resolveStairsOrientation(cornerA, cornerB, stairsAxis);

    this.selectionShapeAnchor = {
      cornerA: { ...cornerA },
      cornerB: { ...cornerB },
      micro: isMicro,
      cylinderAxis,
      stairsAxis,
      stairsOrientation
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

    let matchingBlocks: SelectedVoxel[] = [];
    let shapeCells: Point3[] | null = null;

    if (isMicro) {
      // Virtual micro selection: synthesize 0.125 m cells over covered 1 m blocks
      // without mutating the entity. Del/F/P/G subdivide lazily.
      if (shape === 'box') {
        matchingBlocks = this.host.buildEntityMicroSelection(contraption, nodeId, (x: number, y: number, z: number) => (
          x >= bounds.minX && x <= bounds.maxX &&
          y >= bounds.minY && y <= bounds.maxY &&
          z >= bounds.minZ && z <= bounds.maxZ
        ), bounds) || [];
      } else {
        shapeCells = computeSelectionCells(shape, cornerA, cornerB, true, cylinderAxis, stairsAxis, stairsOrientation);
        const cellSet = new Set(shapeCells.map(c => `${c.x},${c.y},${c.z}`));
        matchingBlocks = this.host.buildEntityMicroSelection(contraption, nodeId, (x: number, y: number, z: number) => (
          cellSet.has(`${x},${y},${z}`)
        ), bounds) || [];
      }
    } else {
      const hasMicroInComponent = contraption.blocks.some((b: SelectedVoxel) => contraptionBlockOwnerId(contraption, b) === nodeId && (b.size || 1) < 1);
      if (shape === 'box') {
        const matchingMicro: SelectedVoxel[] = [];
        const matchingStandard: SelectedVoxel[] = [];
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
        shapeCells = computeSelectionCells(shape, cornerA, cornerB, isMicro, cylinderAxis, stairsAxis, stairsOrientation);
        const cellSet = new Set(shapeCells.map(c => `${c.x},${c.y},${c.z}`));
        const matchingMicro: SelectedVoxel[] = [];
        const matchingStandard: SelectedVoxel[] = [];
        for (const b of contraption.blocks) {
          // Skip blocks owned by other components (parent/root/siblings) instead
          // of aborting: only this component's own blocks may match the shape.
          if (contraptionBlockOwnerId(contraption, b) !== nodeId) continue;
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
    this.selectedBlockSelection.virtualMicro = matchingBlocks.some((b: SelectedVoxel) => b.virtualMicro === true);
    this.selectedBlockSelection.shapeCells = shapeCells;
    if (this.host.contraptions) {
      this.host.contraptions.entitySelection = {
        kind: 'entity-blocks', contraption, nodeId, blocks: matchingBlocks, components: [nodeId]
      };
    }
    contraption.clearSubtreeHighlight?.();
    contraption.highlightBlocks?.(matchingBlocks);
    this.updateSelectionAxisGizmo();

    const node = contraption.entityNodes?.get?.(nodeId);
    const frame = node?.group ? { object: node.group, pivot: (node.pivotLocal || new THREE.Vector3()).clone() } : null;
    if (shape === 'box' || !shapeCells || shapeCells.length === 0) {
      // Micro bounds are expressed in 0.125 m grid units, so the outer guide box
      // must be scaled by MICRO_SIZE too.
      this.host.sceneRenderer?.updateSelectionHologram?.(bounds, null, null, isMicro, frame);
    } else if (isMicro) {
      this.host.sceneRenderer?.updateSelectionHologram?.(bounds, null, shapeCells, true, frame);
    } else {
      this.host.sceneRenderer?.updateSelectionHologram?.(bounds, shapeCells, null, false, frame);
    }
  }

  applySelectionShape(shape: SelectorShape = this.selectorShape) {
    if (this.selectedBlockSelection || this.selectedSubtree) {
      this.applyEntitySelectionShape(shape);
      return;
    }
    if (!this.host.contraptions) return;
    const isMicro = this.selectorMicroMode === true;

    // Resolve anchor corners
    let cornerA = this.selectionShapeAnchor?.cornerA;
    let cornerB = this.selectionShapeAnchor?.cornerB;

    if (!cornerA || !cornerB) {
      if (isMicro) {
        const mb = this.host.contraptions.getMicroSelectionBounds?.();
        if (mb) {
          cornerA = { x: mb.minX, y: mb.minY, z: mb.minZ };
          cornerB = { x: mb.maxX, y: mb.maxY, z: mb.maxZ };
        }
      } else {
        if (this.host.contraptions.selectionCornerA && this.host.contraptions.selectionCornerB) {
          cornerA = this.host.contraptions.selectionCornerA;
          cornerB = this.host.contraptions.selectionCornerB;
        } else {
          const bounds = this.host.contraptions.getSelectionBounds?.();
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
    const stairsOrientation = this.resolveStairsOrientation(cornerA, cornerB, stairsAxis);

    this.selectionShapeAnchor = {
      cornerA: { ...cornerA },
      cornerB: { ...cornerB },
      micro: isMicro,
      cylinderAxis,
      stairsAxis,
      stairsOrientation
    };

    if (shape === 'box') {
      if (isMicro) {
        const minX = Math.min(cornerA.x, cornerB.x);
        const maxX = Math.max(cornerA.x, cornerB.x);
        const minY = Math.min(cornerA.y, cornerB.y);
        const maxY = Math.max(cornerA.y, cornerB.y);
        const minZ = Math.min(cornerA.z, cornerB.z);
        const maxZ = Math.max(cornerA.z, cornerB.z);
        this.host.contraptions.microBounds = { minX, minY, minZ, maxX, maxY, maxZ };
        this.host.contraptions.microSelection = this.host.contraptions.materializeMicroBox?.(minX, minY, minZ, maxX, maxY, maxZ) || [];
      } else {
        this.host.contraptions.connectedSelection = null;
        this.host.contraptions.selectionCornerA = { ...cornerA };
        this.host.contraptions.selectionCornerB = { ...cornerB };
      }
    } else {
      const cells = computeSelectionCells(shape, cornerA, cornerB, isMicro, cylinderAxis, stairsAxis, stairsOrientation);
      if (isMicro) {
        this.host.contraptions.microSelection = cells;
        this.host.contraptions.microBounds = null;
      } else {
        this.host.contraptions.selectionCornerA = { ...cornerA };
        this.host.contraptions.selectionCornerB = { ...cornerB };
        this.host.contraptions.connectedSelection = cells;
      }
    }

    const bounds = isMicro
      ? (shape === 'box'
        ? this.host.contraptions.getMicroSelectionBounds?.()
        : {
          minX: Math.min(cornerA.x, cornerB.x),
          maxX: Math.max(cornerA.x, cornerB.x),
          minY: Math.min(cornerA.y, cornerB.y),
          maxY: Math.max(cornerA.y, cornerB.y),
          minZ: Math.min(cornerA.z, cornerB.z),
          maxZ: Math.max(cornerA.z, cornerB.z)
        })
      : this.host.contraptions.getSelectionBounds?.();
    this.host.sceneRenderer?.updateSelectionAxisGizmo?.(bounds, isMicro);
    this.host.sceneRenderer?.updateSelectionHologram?.(
      bounds,
      this.host.contraptions.connectedSelection,
      this.host.contraptions.microSelection,
      isMicro && shape !== 'box'
    );
  }

  rotateSelection(direction: number = 1, axis: 'x' | 'y' = 'y'): boolean {
    if (!this.host.requireConfirmedSelection('rotating')) return false;
    if (!this.host.contraptions || !this.host.hasActiveSelection()) {
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
          const blocks = this.selectedBlockSelection?.blocks || contraption.blocks.filter((b: SelectedVoxel) => (this.selectedSubtree?.nodeIds || this.host.collectSubtreeIds(contraption, nodeId)).has(contraptionBlockOwnerId(contraption, b)));
          const bounds = this.selectedBlockSelection?.bounds || this.host.getEntitySelectionBounds(blocks || [], isMicro);
          if (bounds) {
            cornerA = { x: bounds.minX, y: bounds.minY, z: bounds.minZ };
            cornerB = { x: bounds.maxX, y: bounds.maxY, z: bounds.maxZ };
          }
        }
      } else if (isMicro) {
        const mb = this.host.contraptions.getMicroSelectionBounds?.();
        if (mb) {
          cornerA = { x: mb.minX, y: mb.minY, z: mb.minZ };
          cornerB = { x: mb.maxX, y: mb.maxY, z: mb.maxZ };
        }
      } else {
        if (this.host.contraptions.selectionCornerA && this.host.contraptions.selectionCornerB) {
          cornerA = { ...this.host.contraptions.selectionCornerA };
          cornerB = { ...this.host.contraptions.selectionCornerB };
        } else {
          const bounds = this.host.contraptions.getSelectionBounds?.();
          if (bounds) {
            cornerA = { x: bounds.minX, y: bounds.minY, z: bounds.minZ };
            cornerB = { x: bounds.maxX, y: bounds.maxY, z: bounds.maxZ };
          }
        }
      }
    }

    if (!cornerA || !cornerB) return false;

    // Geometric stairs/cylinders are oriented inside their fixed selector box.
    // Rotating their occupied cells must not move or resize that box.
    if ((this.selectorShape === 'stairs' || this.selectorShape === 'cylinder') &&
      this.rotateSelectionShapeInBounds(direction, axis, cornerA, cornerB)) {
      return true;
    }

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
      this.host.sound?.playWrenchClick?.();
      this.host.ui?.updateToolPanelMode?.();
      return true;
    }

    if (this.selectorShape === 'box') {
      if (isMicro) {
        this.host.contraptions.microBounds = {
          minX: newMinX, minY: newMinY, minZ: newMinZ,
          maxX: newMaxX, maxY: newMaxY, maxZ: newMaxZ
        };
        this.host.contraptions.microSelection = this.host.contraptions.materializeMicroBox?.(
          newMinX, newMinY, newMinZ, newMaxX, newMaxY, newMaxZ
        ) || [];
      } else {
        this.host.contraptions.connectedSelection = null;
        this.host.contraptions.selectionCornerA = { ...newCornerA };
        this.host.contraptions.selectionCornerB = { ...newCornerB };
      }
    } else {
      const cells = computeSelectionCells(this.selectorShape, newCornerA, newCornerB, isMicro, newCylinderAxis, newStairsAxis);
      if (isMicro) {
        this.host.contraptions.microSelection = cells;
        this.host.contraptions.microBounds = null;
      } else {
        this.host.contraptions.selectionCornerA = { ...newCornerA };
        this.host.contraptions.selectionCornerB = { ...newCornerB };
        this.host.contraptions.connectedSelection = cells;
      }
    }

    const bounds = isMicro
      ? this.host.contraptions.getMicroSelectionBounds?.()
      : this.host.contraptions.getSelectionBounds?.();
    this.host.sceneRenderer?.updateSelectionAxisGizmo?.(bounds, isMicro);
    this.host.sceneRenderer?.updateSelectionHologram?.(
      bounds,
      this.host.contraptions.connectedSelection,
      this.host.contraptions.microSelection,
      isMicro && this.selectorShape !== 'box'
    );

    this.host.sound?.playWrenchClick?.();
    this.host.ui?.updateToolPanelMode?.();
    return true;
  }

  resolveStairsOrientation(
    cornerA: { x: number; y: number; z: number },
    cornerB: { x: number; y: number; z: number },
    stairsAxis?: 'x' | 'z'
  ): StairsOrientation {
    const current = this.selectionShapeAnchor?.stairsOrientation;
    if (current && current.runAxis !== current.riseAxis) return { ...current };

    const dx = cornerB.x - cornerA.x;
    const dz = cornerB.z - cornerA.z;
    const runAxis = stairsAxis || (Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z');
    return {
      runAxis,
      riseAxis: 'y',
      runDirection: (runAxis === 'x' ? dx : dz) < 0 ? -1 : 1,
      riseDirection: cornerB.y - cornerA.y < 0 ? -1 : 1
    };
  }

  rotateSelectionShapeInBounds(
    direction: number,
    rotationAxis: 'x' | 'y',
    cornerA: { x: number; y: number; z: number },
    cornerB: { x: number; y: number; z: number }
  ) {
    const cylinderAxis = this.selectionShapeAnchor?.cylinderAxis || 'y';
    const stairsAxis = this.selectionShapeAnchor?.stairsAxis || (
      Math.abs(cornerB.x - cornerA.x) >= Math.abs(cornerB.z - cornerA.z) ? 'x' : 'z'
    );
    let stairsOrientation: StairsOrientation | undefined;

    if (this.selectorShape === 'cylinder') {
      let nextCylinderAxis = cylinderAxis;
      if (rotationAxis === 'y') {
        if (cylinderAxis === 'x') nextCylinderAxis = 'z';
        else if (cylinderAxis === 'z') nextCylinderAxis = 'x';
      } else {
        if (cylinderAxis === 'y') nextCylinderAxis = 'z';
        else if (cylinderAxis === 'z') nextCylinderAxis = 'y';
      }
      this.selectionShapeAnchor = {
        cornerA: { ...cornerA },
        cornerB: { ...cornerB },
        micro: this.selectorMicroMode === true,
        cylinderAxis: nextCylinderAxis,
        stairsAxis,
        stairsOrientation: this.selectionShapeAnchor?.stairsOrientation
      };
    } else {
      const orientation = this.resolveStairsOrientation(cornerA, cornerB, stairsAxis);
      const rotateDirection = (vector: { axis: 'x' | 'y' | 'z'; sign: 1 | -1 }) => {
        const value = { x: 0, y: 0, z: 0 };
        value[vector.axis] = vector.sign;
        const positive = direction > 0;
        let rotated: typeof value;
        if (rotationAxis === 'y') {
          rotated = positive
            ? { x: -value.z, y: value.y, z: value.x }
            : { x: value.z, y: value.y, z: -value.x };
        } else {
          rotated = positive
            ? { x: value.x, y: -value.z, z: value.y }
            : { x: value.x, y: value.z, z: -value.y };
        }
        const nextAxis = (['x', 'y', 'z'] as const).find(key => rotated[key] !== 0)!;
        return { axis: nextAxis, sign: rotated[nextAxis] as 1 | -1 };
      };
      const run = rotateDirection({ axis: orientation.runAxis, sign: orientation.runDirection });
      const rise = rotateDirection({ axis: orientation.riseAxis, sign: orientation.riseDirection });
      stairsOrientation = {
        runAxis: run.axis,
        runDirection: run.sign,
        riseAxis: rise.axis,
        riseDirection: rise.sign
      };
      this.selectionShapeAnchor = {
        cornerA: { ...cornerA },
        cornerB: { ...cornerB },
        micro: this.selectorMicroMode === true,
        cylinderAxis,
        stairsAxis: run.axis === 'z' ? 'z' : 'x',
        stairsOrientation
      };
    }

    this.applySelectionShape(this.selectorShape);
    this.host.sound?.playWrenchClick?.();
    this.host.ui?.updateToolPanelMode?.();
    return true;
  }

  expandEntitySelectionAxis(axis: 'x' | 'y' | 'z', direction: 1 | -1, steps: number, isMicro = false) {
    const contraption = this.selectedBlockSelection?.contraption || this.selectedSubtree?.contraption;
    const nodeId = this.selectedBlockSelection?.nodeId || this.selectedSubtree?.rootId;
    if (!contraption || !nodeId) return { ok: false, bounds: null, count: 0 };

    if (!this.selectedBlockSelection && this.selectedSubtree) {
      const nodeIds = this.selectedSubtree?.nodeIds || this.host.collectSubtreeIds(contraption, nodeId);
      const subtreeBlocks = contraption.blocks.filter((b: SelectedVoxel) => nodeIds.has(contraptionBlockOwnerId(contraption, b)));
      this.selectedBlockSelection = {
        contraption,
        nodeId,
        blocks: subtreeBlocks,
        bounds: this.host.getEntitySelectionBounds(subtreeBlocks, isMicro)
      };
      this.selectedSubtree = null;
    }

    if (!this.selectedBlockSelection) return { ok: false, bounds: null, count: 0 };

    if (!this.selectedBlockSelection.bounds) {
      this.selectedBlockSelection.bounds = this.host.getEntitySelectionBounds(this.selectedBlockSelection.blocks, isMicro);
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
      ? (this.host.buildEntityMicroSelection(contraption, nodeId, (x: number, y: number, z: number) => (
        x >= bounds.minX && x <= bounds.maxX &&
        y >= bounds.minY && y <= bounds.maxY &&
        z >= bounds.minZ && z <= bounds.maxZ
      ), bounds) || [])
      : contraption.blocks.filter((b: SelectedVoxel) => {
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
    this.selectedBlockSelection.virtualMicro = matchingBlocks.some((b: SelectedVoxel) => b.virtualMicro === true);
    this.selectedBlockSelection.shapeCells = null;
    contraption.clearSubtreeHighlight?.();
    contraption.highlightBlocks?.(matchingBlocks);

    const node = contraption.entityNodes?.get?.(nodeId);
    const frame = node?.group ? { object: node.group, pivot: (node.pivotLocal || new THREE.Vector3()).clone() } : null;
    // Keep the outer cuboid guide box visible while the axis gizmo expands the
    // box selection instead of hiding the hologram.
    this.host.sceneRenderer?.updateSelectionHologram?.(bounds, null, null, isMicro, frame);

    return { ok: true, bounds, count: matchingBlocks.length };
  }

  updateSelectionAxisGizmo() {
    if (this.host.worldPickingSuspended) {
      this.hoveredGizmoHandle = null;
      this.host.sceneRenderer?.clearSelectionAxisGizmo?.();
      return;
    }
    if (this.host.activeTool !== SpecialTool.SELECTOR) {
      this.hoveredGizmoHandle = null;
      this.host.sceneRenderer?.clearSelectionAxisGizmo?.();
      return;
    }

    const isMicro = this.selectorMicroMode === true;
    let bounds: CollisionBounds | null | undefined = null;
    let frame: SelectionFrame | null = null;

    if (isMicro) {
      bounds = this.host.contraptions?.getMicroSelectionBounds?.();
    } else {
      if (this.host.contraptions && this.host.contraptions.selectionCornerA !== null && this.host.contraptions.selectionCornerB !== null) {
        bounds = this.host.contraptions.getSelectionBounds?.();
      }
    }

    if (!bounds) {
      if (this.selectedBlockSelection && this.selectedBlockSelection.contraption) {
        const contraption = this.selectedBlockSelection.contraption;
        const nodeId = this.selectedBlockSelection.nodeId;
        const node = contraption.entityNodes?.get?.(nodeId);
        if (node && node.group) {
          if (!this.selectedBlockSelection.bounds) {
            this.selectedBlockSelection.bounds = this.host.getEntitySelectionBounds(this.selectedBlockSelection.blocks, isMicro);
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
        if (!boxPending && node && node.group && this.host.canEditEntityInternals(contraption)) {
          const nodeIds = this.selectedSubtree?.nodeIds || this.host.collectSubtreeIds(contraption, rootId);
          const blocks = contraption.blocks.filter((b: SelectedVoxel) => nodeIds.has(contraptionBlockOwnerId(contraption, b)));
          bounds = this.host.getEntitySelectionBounds(blocks || [], isMicro);
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
      this.host.sceneRenderer?.clearSelectionAxisGizmo?.();
      return;
    }

    this.host.sceneRenderer?.updateSelectionAxisGizmo?.(bounds, isMicro, frame);

    // If currently dragging, maintain active handle highlight
    if (this.activeGizmoDrag) {
      this.host.sceneRenderer?.highlightSelectionGizmoHandle?.(this.activeGizmoDrag.handleKey);
      return;
    }

    // When pointer is locked, raycast against gizmo handles from the crosshair.
    // The gizmo is drawn in bent space, so the pick ray must be bent too,
    // otherwise the handles miss by the torus distortion.
    if (this.host.isLocked) {
      const eyePos = this.host.physics?.getEyePosition?.() || this.host.camera.position;
      const forwardFlat = this._forwardFlat
        .set(0, 0, -1)
        .applyQuaternion(this.host.camera.quaternion);
      const eyeBent = bendPointForView(eyePos.x, eyePos.y, eyePos.z, this._bentEye);
      const forwardBent = bendDirection(
        eyePos.x, eyePos.y, eyePos.z, forwardFlat, this._forwardBent
      );
      const hit = this.host.sceneRenderer?.raycastSelectionGizmoBent?.(eyeBent, forwardBent);
      this.hoveredGizmoHandle = hit ?? null;
      this.host.sceneRenderer?.highlightSelectionGizmoHandle?.(hit ? hit.handleKey : null);
    }
  }

  updateSelectionGizmoPointerHover(e: MouseEvent) {
    if (this.host.worldPickingSuspended) {
      this.hoveredGizmoHandle = null;
      this.host.sceneRenderer?.highlightSelectionGizmoHandle?.(null);
      return null;
    }
    if (this.host.activeTool !== SpecialTool.SELECTOR || !this.host.sceneRenderer) return;
    if (!this.selectionGizmoRaycaster) {
      this.selectionGizmoRaycaster = new THREE.Raycaster();
    }
    const pointer = new THREE.Vector2(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1
    );
    this.selectionGizmoRaycaster.setFromCamera(pointer, this.host.camera);
    const flatOrigin = this.selectionGizmoRaycaster.ray.origin;
    const flatDirection = this.selectionGizmoRaycaster.ray.direction;
    const eyeBent = bendPointForView(flatOrigin.x, flatOrigin.y, flatOrigin.z, this._bentEye);
    const directionBent = bendDirection(
      flatOrigin.x, flatOrigin.y, flatOrigin.z, flatDirection, this._forwardBent
    );
    const hit = this.host.sceneRenderer.raycastSelectionGizmoBent
      ? this.host.sceneRenderer.raycastSelectionGizmoBent(eyeBent, directionBent)
      : this.host.sceneRenderer.raycastSelectionGizmo(this.selectionGizmoRaycaster);
    this.hoveredGizmoHandle = hit ?? null;
    this.host.sceneRenderer.highlightSelectionGizmoHandle(hit ? hit.handleKey : null);
  }

  startGizmoDrag(hit: SelectionGizmoHandle | null, e: MouseEvent | null = null) {
    if (!hit) return;
    if (this.host.handleRunningEntityInteraction(this.selectedBlockSelection?.contraption || this.selectedSubtree?.contraption || null)) return;
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
    this.host.sound?.playWrenchClick?.();
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
          this.selectedSubtree ? target.blocks.filter((b: SelectedVoxel) => (this.selectedSubtree?.nodeIds || this.host.collectSubtreeIds(target, nodeId)).has(contraptionBlockOwnerId(target, b))) : null
        );
        bounds = this.host.getEntitySelectionBounds(blocks || [], isMicro);
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
      center = this.host.targetEntityLocalToWorld(target, nodeId, localCenter);

      const localAxis = new THREE.Vector3(
        drag.axis === 'x' ? 1 : 0,
        drag.axis === 'y' ? 1 : 0,
        drag.axis === 'z' ? 1 : 0
      );
      const quat = this.host.getTargetEntityWorldQuaternion(target, nodeId);
      worldAxisVec = localAxis.applyQuaternion(quat);
    } else {
      const bounds = isMicro
        ? this.host.contraptions.getMicroSelectionBounds()
        : this.host.contraptions.getSelectionBounds();
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

    const v0 = center.clone().project(this.host.camera);
    const v1 = center.clone().add(worldAxisVec).project(this.host.camera);
    const screenDir = new THREE.Vector2(v1.x - v0.x, -(v1.y - v0.y));
    const len = screenDir.length();
    if (len < 1e-4) {
      screenDir.set(1, 0);
    } else {
      screenDir.divideScalar(len);
    }

    let dx = 0, dy = 0;
    if (this.host.isLocked) {
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
          this.host.sound?.playWrenchClick?.();
          this.updateSelectionAxisGizmo();
        }
      } else {
        const result = this.host.contraptions.expandSelectionAxis(
          drag.axis,
          drag.direction,
          steps,
          isMicro
        );

        if (result.ok) {
          this.host.sound?.playWrenchClick?.();
          if (this.selectorShape !== 'box') {
            const cylinderAxis = this.selectionShapeAnchor?.cylinderAxis || 'y';
            const stairsAxis = this.selectionShapeAnchor?.stairsAxis;
            const stairsOrientation = this.selectionShapeAnchor?.stairsOrientation;
            if (isMicro) {
              const mb = this.host.contraptions.getMicroSelectionBounds();
              if (mb) {
                this.selectionShapeAnchor = {
                  cornerA: { x: mb.minX, y: mb.minY, z: mb.minZ },
                  cornerB: { x: mb.maxX, y: mb.maxY, z: mb.maxZ },
                  micro: true,
                  cylinderAxis,
                  stairsAxis,
                  stairsOrientation
                };
              }
            } else {
              if (this.host.contraptions.selectionCornerA && this.host.contraptions.selectionCornerB) {
                this.selectionShapeAnchor = {
                  cornerA: { ...this.host.contraptions.selectionCornerA },
                  cornerB: { ...this.host.contraptions.selectionCornerB },
                  micro: false,
                  cylinderAxis,
                  stairsAxis,
                  stairsOrientation
                };
              }
            }
            const anchorA = this.selectionShapeAnchor?.cornerA;
            const anchorB = this.selectionShapeAnchor?.cornerB;
            if (anchorA && anchorB) {
              const cells = computeSelectionCells(this.selectorShape, anchorA, anchorB, isMicro, cylinderAxis, stairsAxis, stairsOrientation);
              if (isMicro) {
                this.host.contraptions.microSelection = cells;
                this.host.contraptions.microBounds = null;
              } else {
                this.host.contraptions.connectedSelection = cells;
              }
            }
          }
          const updatedBounds = isMicro
            ? this.host.contraptions.getMicroSelectionBounds()
            : this.host.contraptions.getSelectionBounds();
          this.host.sceneRenderer?.updateSelectionAxisGizmo(updatedBounds, isMicro);
          this.host.sceneRenderer?.updateSelectionHologram(
            updatedBounds,
            this.host.contraptions.connectedSelection,
            this.host.contraptions.microSelection,
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
