import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { ActionDomain } from '@entropydrop/space-engine/actions/BasicActions.ts';

/**
 * Brush tool:
 * - left-click paints a single block (or cancels pending 2-point selection).
 * - right-click only operates on stopped entities.
 * - does not show component bounding box (focusHighlight).
 * - only allows box-selecting blocks within the same component; out-of-range cancels.
 */

function makeController(overrides = {}) {
  const controller = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.BRUSH;
  controller.hoveredContraptionHit = null;
  controller.hoveredContraption = null;
  controller.currentRaycast = { hit: false };
  controller.sound = { playWrenchClick() {}, playBlockPlace() {} };
  controller.particles = { emitBlockBreak() {} };
  controller.ui = { setBuildColor() {}, showToast() {} };
  controller.brushSelection = null;
  controller.brushMicroMode = false;
  controller.selectedColor = 0xff0044;
  controller.sceneRenderer = { clearBoxSelectionPreview() {} };
  controller.canEditEntityInternals = (c: any) => c?.scriptStatus === 'stopped' || c?.canEditInternalSelection?.() !== false;
  Object.assign(controller, overrides);
  return controller;
}

test('brush left-click paints', () => {
  let painted = false;
  const controller = makeController({
    paintTargetedBlock: () => { painted = true; }
  });
  controller.handleLeftClick();
  assert.equal(painted, true, 'brush left-click must paint');
});

test('brush left-click cancels pending 2-point selection and does not paint', () => {
  let painted = false;
  const toasts: string[] = [];
  let clicks = 0;
  let previewCleared = false;
  const controller = makeController({
    brushSelection: {
      contraption: { clearFocusHighlight() {} },
      nodeId: 'root',
      pointA: new THREE.Vector3(1, 2, 3),
      rawWorldA: new THREE.Vector3(1, 2, 3),
      micro: false
    },
    sound: { playWrenchClick: () => { clicks++; } },
    ui: { showToast: (msg: string) => toasts.push(msg) },
    paintTargetedBlock: () => { painted = true; },
    sceneRenderer: { clearBoxSelectionPreview: () => { previewCleared = true; } }
  });

  controller.handleLeftClick();
  assert.equal(controller.brushSelection, null, 'brushSelection must be cleared on left-click');
  assert.equal(painted, false, 'must not paint when cancelling pending selection');
  assert.equal(clicks, 1, 'wrench click sound should play on cancellation');
  assert.ok(previewCleared, 'preview must be cleared');
  assert.ok(toasts.some(t => t.includes('Brush selection cancelled')));
});

test('brush right-click ignores non-entity (world terrain) and does not start selection', () => {
  const controller = makeController({
    currentRaycast: { hit: true, hitPos: { x: 2.3, y: 4.1, z: 6.8 } },
    hoveredContraptionHit: null
  });

  controller.handleRightClick(null);
  assert.equal(controller.brushSelection, null, 'must not start selection on non-entity');
});

test('brush right-click on running entity does not start selection', () => {
  const toasts: string[] = [];
  const runningContraption = {
    scriptStatus: 'running',
    canEditInternalSelection: () => false
  };
  const controller = makeController({
    hoveredContraptionHit: {
      contraption: runningContraption,
      entityId: 'root',
      point: new THREE.Vector3(1, 2, 3)
    },
    canEditEntityInternals: () => false,
    ui: { showToast: (msg: string) => toasts.push(msg) }
  });

  controller.handleRightClick(null);
  assert.equal(controller.brushSelection, null, 'must not start selection on running entity');
  assert.ok(toasts.some(t => t.includes('within 1 second')));
});

test('brush right-click first click on stopped entity picks corner 1 without showing component bounding box', () => {
  const toasts: string[] = [];
  let clicks = 0;
  let focusCleared = false;
  const fakeContraption = {
    clearFocusHighlight: () => { focusCleared = true; },
    scriptStatus: 'stopped'
  };
  const controller = makeController({
    hoveredContraptionHit: {
      contraption: fakeContraption,
      entityId: 'arm_node',
      point: new THREE.Vector3(2, 4, 6)
    },
    rangePointToLocal: (_sel: any, pt: any) => pt.clone(),
    sound: { playWrenchClick: () => { clicks++; } },
    ui: { showToast: (msg: string) => toasts.push(msg) }
  });

  controller.handleRightClick(null);
  assert.ok(controller.brushSelection, 'brushSelection must be set after first right click');
  assert.equal(controller.brushSelection.contraption, fakeContraption);
  assert.equal(controller.brushSelection.nodeId, 'arm_node');
  assert.equal(clicks, 1, 'wrench click sound should play on first corner pick');
  assert.equal(focusCleared, true, 'focusHighlight must be cleared (no component bounding box)');
  assert.ok(toasts.some(t => t.includes('Brush [1/2] picked corner on [arm_node]')));
});

test('brush right-click second click on same component dyes the region and clears selection', () => {
  const actions: any[] = [];
  let blockPlacedSound = false;
  let subtreeHighlightCleared = false;
  let focusHighlightCleared = false;
  const fakeContraption = {
    clearSubtreeHighlight: () => { subtreeHighlightCleared = true; },
    clearFocusHighlight: () => { focusHighlightCleared = true; },
    scriptStatus: 'stopped'
  };

  const controller = makeController({
    brushSelection: {
      contraption: fakeContraption,
      nodeId: 'arm_node',
      pointA: new THREE.Vector3(1, 1, 1),
      rawWorldA: new THREE.Vector3(1, 1, 1),
      micro: false
    },
    hoveredContraptionHit: {
      contraption: fakeContraption,
      entityId: 'arm_node',
      point: new THREE.Vector3(3, 3, 3)
    },
    rangePointToLocal: (_sel: any, pt: any) => pt.clone(),
    sound: { playBlockPlace: () => { blockPlacedSound = true; } },
    performBasicAction: (cmd: any) => {
      actions.push(cmd);
      if (cmd.action === 'entity-box') {
        return { ok: true, selection: { blocks: [{ localX: 1, localY: 1, localZ: 1 }] } };
      }
      if (cmd.action === 'paint-blocks') {
        return { ok: true, painted: 1 };
      }
      return { ok: true };
    }
  });

  controller.handleRightClick(null);

  assert.equal(controller.brushSelection, null, 'brushSelection must be cleared after dyeing');
  assert.equal(blockPlacedSound, true, 'block place sound should play after dyeing');
  assert.equal(subtreeHighlightCleared, true, 'selection highlights must be cleared');
  assert.equal(focusHighlightCleared, true, 'focus highlight must remain cleared');

  const entityBox = actions.find(a => a.action === 'entity-box');
  assert.ok(entityBox, 'entity-box action invoked');
  assert.equal(entityBox.nodeId, 'arm_node', 'must box select within arm_node component only');

  const paintBlocks = actions.find(a => a.action === 'paint-blocks');
  assert.ok(paintBlocks, 'paint-blocks action invoked');
  assert.equal(paintBlocks.color, 0xff0044);
});

test('brush right-click second click on different component cancels selection', () => {
  const toasts: string[] = [];
  let clicks = 0;
  const fakeContraption = {
    scriptStatus: 'stopped',
    clearFocusHighlight() {}
  };

  const controller = makeController({
    brushSelection: {
      contraption: fakeContraption,
      nodeId: 'arm_node',
      pointA: new THREE.Vector3(1, 1, 1),
      rawWorldA: new THREE.Vector3(1, 1, 1),
      micro: false
    },
    hoveredContraptionHit: {
      contraption: fakeContraption,
      entityId: 'leg_node', // Different component!
      point: new THREE.Vector3(3, 3, 3)
    },
    sound: { playWrenchClick: () => { clicks++; } },
    ui: { showToast: (msg: string) => toasts.push(msg) }
  });

  controller.handleRightClick(null);

  assert.equal(controller.brushSelection, null, 'must cancel when clicking outside component');
  assert.equal(clicks, 1, 'click sound on cancel');
  assert.ok(toasts.some(t => t.includes('outside component')));
});

test('brush right-click second click on world terrain cancels selection', () => {
  const toasts: string[] = [];
  let clicks = 0;
  const fakeContraption = {
    scriptStatus: 'stopped',
    clearFocusHighlight() {}
  };

  const controller = makeController({
    brushSelection: {
      contraption: fakeContraption,
      nodeId: 'arm_node',
      pointA: new THREE.Vector3(1, 1, 1),
      rawWorldA: new THREE.Vector3(1, 1, 1),
      micro: false
    },
    hoveredContraptionHit: null, // Pointing at world terrain!
    sound: { playWrenchClick: () => { clicks++; } },
    ui: { showToast: (msg: string) => toasts.push(msg) }
  });

  controller.handleRightClick(null);

  assert.equal(controller.brushSelection, null, 'must cancel when clicking outside entity');
  assert.equal(clicks, 1, 'click sound on cancel');
  assert.ok(toasts.some(t => t.includes('outside component')));
});

test('brush updateMicroCarvePreview sets boxSelectionPreview only for same component', () => {
  const fakeContraption = {
    entityNodes: new Map([
      ['arm_node', { group: { matrixWorld: new THREE.Matrix4() } }]
    ])
  };
  const controller = makeController({
    hoveredContraptionHit: {
      contraption: fakeContraption,
      entityId: 'arm_node',
      point: new THREE.Vector3(8.9, 9.1, 10.2)
    },
    rangePointToPreviewGrid: (_sel: any, pt: any) => pt.clone(),
    worldPointToRangePreviewGrid: (_sel: any, pt: any) => pt.clone(),
    rangePreviewFrame: () => ({ position: new THREE.Vector3(), quaternion: new THREE.Quaternion() })
  });
  controller.brushSelection = {
    contraption: fakeContraption,
    nodeId: 'arm_node',
    pointA: new THREE.Vector3(1, 2, 3),
    rawWorldA: new THREE.Vector3(1, 2, 3),
    micro: false
  };

  // 1. Same component -> boxSelectionPreview is populated
  controller.updateMicroCarvePreview();
  assert.ok(controller.boxSelectionPreview, 'boxSelectionPreview must be populated for same component');

  // 2. Different component -> boxSelectionPreview is cleared
  controller.hoveredContraptionHit.entityId = 'other_node';
  controller.updateMicroCarvePreview();
  assert.equal(controller.boxSelectionPreview, null, 'boxSelectionPreview must be null for different component');
});

test('switching tools away from Brush clears brushSelection', () => {
  const controller = makeController();
  controller.brushSelection = {
    contraption: { clearFocusHighlight() {} },
    nodeId: 'root',
    pointA: new THREE.Vector3(1, 2, 3),
    rawWorldA: new THREE.Vector3(1, 2, 3),
    micro: false
  };

  controller.activeTool = SpecialTool.SHOVEL;
  assert.equal(controller.brushSelection, null, 'brushSelection must reset when tool switches away');
});

test('the six-tool hotbar includes Brush with 2-point dye description', () => {
  assert.equal(SpecialTool.PIPETTE, 'pipette');
  const source = readFileSync(new URL('../src/ui/react/store/SpaceUiStore.ts', import.meta.url), 'utf8');
  const hotbarDefinition = source.slice(source.indexOf('const HOTBAR_SLOTS = ['), source.indexOf('const EMPTY_SELECTOR'));
  assert.match(hotbarDefinition, /SpecialTool\.WRENCH/);
  assert.match(hotbarDefinition, /SpecialTool\.HAMMER/);
  assert.match(hotbarDefinition, /SpecialTool\.SELECTOR/);
  assert.match(hotbarDefinition, /SpecialTool\.BRUSH/);
  assert.match(hotbarDefinition, /2-point dye/);
  assert.doesNotMatch(hotbarDefinition, /SpecialTool\.PIPETTE/);
});

test('hovering contraption with Brush tool clears focus highlight and does not show component bounding box', () => {
  const source = readFileSync(new URL('../src/engine/controls/PlayerController.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /else if \(this\.activeTool === SpecialTool\.BRUSH\) \{\s*this\.hoveredContraption\.setHighlighted\(true\);\s*this\.hoveredContraption\.clearFocusHighlight\(\);/,
    'PlayerController hover branch must clear focus highlight and omit component bounding box for Brush'
  );
});

test('brush aiming at stopped entity in standard mode shows 1.0m crosshair guide', () => {
  const fakeContraption = {
    entityNodes: new Map([
      ['arm_node', { group: { matrixWorld: new THREE.Matrix4(), updateWorldMatrix() {} } }]
    ]),
    entityLocalToWorld: (_nodeId: string, v: THREE.Vector3) => v.clone(),
    scriptStatus: 'stopped'
  };

  const controller = makeController({
    brushMicroMode: false,
    hoveredContraptionHit: {
      contraption: fakeContraption,
      entityId: 'arm_node',
      cell: { x: 3, y: 4, z: 5 },
      point: new THREE.Vector3(3.5, 4.5, 5.5)
    }
  });

  controller.updateMicroCarvePreview();
  assert.ok(controller.focusBlockPreview, 'focusBlockPreview must be set for stopped entity');
  assert.equal(controller.focusBlockPreview.cellSize, 1, 'cellSize must be 1.0 in standard mode');
  assert.deepEqual(
    { x: controller.focusBlockPreview.center.x, y: controller.focusBlockPreview.center.y, z: controller.focusBlockPreview.center.z },
    { x: 3.5, y: 4.5, z: 5.5 }
  );
  assert.equal(controller.focusBlockPreview.active, false, 'active must be false before point 1');
});

test('brush aiming at stopped entity in micro mode shows 0.125m crosshair guide', () => {
  const fakeContraption = {
    entityNodes: new Map([
      ['arm_node', { group: { matrixWorld: new THREE.Matrix4(), updateWorldMatrix() {} } }]
    ]),
    getBlockWorldCenter: (b: any) => new THREE.Vector3(b.localX + 0.1, b.localY + 0.1, b.localZ + 0.1),
    scriptStatus: 'stopped'
  };

  const controller = makeController({
    brushMicroMode: true,
    hoveredContraptionHit: {
      contraption: fakeContraption,
      entityId: 'arm_node',
      block: { localX: 1.0, localY: 2.0, localZ: 3.0, size: 0.125 },
      cell: { x: 1, y: 2, z: 3 },
      point: new THREE.Vector3(1.1, 2.1, 3.1)
    }
  });

  controller.updateMicroCarvePreview();
  assert.ok(controller.focusBlockPreview, 'focusBlockPreview must be set in micro mode');
  assert.equal(controller.focusBlockPreview.cellSize, 0.125, 'cellSize must be 0.2 in micro mode');
  assert.deepEqual(
    { x: controller.focusBlockPreview.center.x, y: controller.focusBlockPreview.center.y, z: controller.focusBlockPreview.center.z },
    { x: 1.1, y: 2.1, z: 3.1 }
  );
});

test('brush crosshair guide turns active (orange) when 2-point box is in progress', () => {
  const fakeContraption = {
    entityNodes: new Map([
      ['arm_node', { group: { matrixWorld: new THREE.Matrix4(), updateWorldMatrix() {} } }]
    ]),
    entityLocalToWorld: (_nodeId: string, v: THREE.Vector3) => v.clone(),
    scriptStatus: 'stopped'
  };

  const controller = makeController({
    brushMicroMode: false,
    brushSelection: {
      contraption: fakeContraption,
      nodeId: 'arm_node',
      pointA: new THREE.Vector3(1, 1, 1),
      rawWorldA: new THREE.Vector3(1, 1, 1),
      micro: false
    },
    hoveredContraptionHit: {
      contraption: fakeContraption,
      entityId: 'arm_node',
      cell: { x: 3, y: 4, z: 5 },
      point: new THREE.Vector3(3.5, 4.5, 5.5)
    },
    rangePointToPreviewGrid: (_sel: any, pt: any) => pt.clone(),
    worldPointToRangePreviewGrid: (_sel: any, pt: any) => pt.clone(),
    rangePreviewFrame: () => ({ position: new THREE.Vector3(), quaternion: new THREE.Quaternion() })
  });

  controller.updateMicroCarvePreview();
  assert.ok(controller.focusBlockPreview);
  assert.equal(controller.focusBlockPreview.active, true, 'active must be true when brushSelection is pending');
});

test('brush aiming at running entity or terrain shows no crosshair guide', () => {
  const runningContraption = {
    scriptStatus: 'running',
    canEditInternalSelection: () => false
  };

  // 1. Running entity
  const controller = makeController({
    hoveredContraptionHit: {
      contraption: runningContraption,
      entityId: 'arm_node',
      cell: { x: 1, y: 1, z: 1 }
    },
    canEditEntityInternals: () => false
  });
  controller.updateMicroCarvePreview();
  assert.equal(controller.focusBlockPreview, null, 'running entity must show no guide');

  // 2. World terrain
  controller.hoveredContraptionHit = null;
  controller.currentRaycast = { hit: true, hitPos: { x: 10, y: 5, z: 20 } };
  controller.updateMicroCarvePreview();
  assert.equal(controller.focusBlockPreview, null, 'world terrain must show no guide');
});
