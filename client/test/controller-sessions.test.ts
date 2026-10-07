import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { PlayerCamera, type PlayerCameraPort } from '../src/engine/controls/PlayerCamera.ts';
import { PlacementSession, type PlacementSessionPort } from '../src/engine/controls/PlacementSession.ts';
import { SelectionSession, type SelectionSessionPort } from '../src/engine/controls/SelectionSession.ts';
import { ToolInteractionSession, type ToolInteractionSessionPort } from '../src/engine/controls/ToolInteractionSession.ts';
import { SpecialTool } from '../src/engine/controls/ControlBindings.ts';

test('tool sessions isolate held input and publish immutable frame edges', () => {
  // Keyboard state has no host dependencies; unimplemented effects must not run.
  const a = new ToolInteractionSession({} as ToolInteractionSessionPort);
  const b = new ToolInteractionSession({} as ToolInteractionSessionPort);
  a.recordEntityKeyDown('KeyW');
  a.recordEntityKeyDown('KeyW');
  const first = a.consumeEntityInputFrame();
  assert.deepEqual(first, { down: ['KeyW'], pressed: ['KeyW'], released: [] });
  assert.deepEqual(b.consumeEntityInputFrame(), { down: [], pressed: [], released: [] });
  a.recordEntityKeyUp('KeyW');
  assert.deepEqual(a.consumeEntityInputFrame(), { down: [], pressed: [], released: ['KeyW'] });
  assert.deepEqual(first.down, ['KeyW']);
  assert.ok(Object.isFrozen(first.down));
  a.recordEntityKeyDown('KeyW');
  a.resetEntityInputState();
  assert.deepEqual(a.consumeEntityInputFrame(), { down: [], pressed: [], released: [] });
});

test('leaving Hammer clears placement pose without leaking into another session', () => {
  const placement = new PlacementSession({} as PlacementSessionPort);
  const other = new PlacementSession({} as PlacementSessionPort);
  const tools = new ToolInteractionSession({
    clearHammerRotation: () => placement.clearHammerRotation(),
  } as ToolInteractionSessionPort);
  tools.activeTool = SpecialTool.HAMMER;
  placement.hammerRotationTurnsX = 1;
  placement.hammerRotationTurnsY = 3;
  other.hammerRotationTurnsX = 2;
  tools.activeTool = SpecialTool.SELECTOR;
  assert.equal(placement.hammerRotationTurnsX, 0);
  assert.equal(placement.hammerRotationTurnsY, 0);
  assert.equal(placement.hammerRotatedSlotCache, null);
  assert.equal(other.hammerRotationTurnsX, 2);
});

test('selection cleanup clears both owned range state and renderer effects', () => {
  const effects: string[] = [];
  const session = new SelectionSession({
    performBasicAction: () => { effects.push('clear-command'); return { ok: true }; },
    clearBrushSelection: () => effects.push('clear-brush'),
    sceneRenderer: {
      clearBoxSelectionPreview: () => effects.push('clear-box'),
      clearFocusBlockGuide: () => effects.push('clear-focus'),
      clearSelectionAxisGizmo: () => effects.push('clear-gizmo'),
    },
  } as unknown as SelectionSessionPort);
  session.selectionShapeAnchor = { cornerA: { x: 1, y: 2, z: 3 }, cornerB: null, micro: false };
  session.clearSelection();
  assert.equal(session.selectionShapeAnchor, null);
  assert.equal(session.selectorRange, null);
  assert.ok(effects.includes('clear-command'));
  assert.ok(effects.includes('clear-box'));
  assert.ok(effects.includes('clear-brush'));
});

test('camera sessions own independent perspective transitions and projections', () => {
  const make = () => new PlayerCamera({ camera: new THREE.PerspectiveCamera() } as PlayerCameraPort);
  const a = make();
  const b = make();
  a.setPerspective('third_person_front', false);
  a.setFov(200);
  a.yaw = 1.2;
  a.updateCameraRotation();
  assert.equal(a.fov, 120);
  assert.equal(b.fov, 75);
  assert.equal(b.getCameraPerspectiveTransition().perspective, 'first_person');
  assert.equal(a.getCameraPerspectiveTransition().perspective, 'third_person_front');
  assert.equal(b.viewYaw, 0);
});
