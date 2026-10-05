import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ModelingTool } from '../src/engine/controls/ModelingTool.ts';
import { getInventoryPreviewBlocks } from '../src/engine/render/SceneRenderer.ts';
import { TransformGizmo, transformAxis, transformScreenPoint, transformViewCamera, type TransformHandle } from '../src/engine/render/TransformGizmo.ts';
import { bendPointForView, setTorusViewCorrection } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { PlayerController } from '../src/engine/controls/PlayerController.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

function fixture() {
  const entity = new Contraption(1, [{ localX: 0, localY: 0, localZ: 0, size: 1, block: 1, color: 1, entityId: 'base' }],
    new THREE.Vector3(), new THREE.Scene(), { rootComponentId: 'base' });
  let saves = 0, unlocks = 0;
  const controller: any = { contraptions: { contraptions: [entity], saveEntitiesToStorage: () => saves++ },
    selectedColor: 0x112233, selectedMaterialId: 1, ui: {}, unlock: () => unlocks++,
    canEditEntityInternals: (value) => value.serverCanEdit !== false,
    handleRunningEntityInteraction: () => false };
  return { entity, controller, tool: new ModelingTool(controller), saves: () => saves, unlocks: () => unlocks };
}

test('create auto-selects, edit, duplicate, delete, undo and redo persist decoration definitions', () => {
  const f = fixture();
  try {
    f.tool.placement = { target: { contraption: f.entity, componentId: 'base' }, value: { id: 'preview', color: 0x112233 } };
    assert.equal(f.tool.create(), true);
    assert.equal(f.unlocks(), 0, 'creation must keep the game pointer locked');
    assert.equal(f.entity.getDecorationCount(), 1);
    assert.equal(f.tool.change({ scale: [2, 0.25, 1] }), true);
    assert.deepEqual(f.tool.getSelection().value.scale, [2, 0.25, 1]);
    assert.equal(f.tool.duplicate(), true);
    assert.equal(f.entity.getDecorationCount(), 2);
    assert.equal(f.tool.remove(), true);
    assert.equal(f.entity.getDecorationCount(), 1);
    assert.equal(f.tool.undo(), true);
    assert.equal(f.entity.getDecorationCount(), 2);
    assert.equal(f.tool.undo(true), true);
    assert.equal(f.entity.getDecorationCount(), 1);
    assert.equal(f.saves(), 6);
  } finally { f.tool.deactivate(); f.entity.dispose(); }
});

function dragFixture() {
  const f = fixture();
  f.controller.activeTool = 'modeling';
  f.controller.camera = new THREE.PerspectiveCamera(60, 1.5, 0.1, 1000);
  f.controller.camera.position.set(4, 3, 6);
  f.controller.camera.lookAt(0, 0, 0);
  f.controller.sceneRenderer = { renderer: { domElement: { getBoundingClientRect: () => ({ width: 900, height: 600 }) } } };
  f.entity.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3);
  f.entity.updateTransform();
  f.entity.setComponentDecorations('base', [{ id: 'trim', color: 1,
    rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 6).toArray() }]);
  f.tool.hovered = { contraption: f.entity, componentId: 'base', decorationId: 'trim' };
  setTorusViewCorrection(f.controller.camera.position);
  f.tool.selectHovered();
  const start = f.tool.getSelection()!.value;
  const position = f.entity.entityLocalToWorld('base', new THREE.Vector3());
  const rotation = f.entity.getEntityNode('base').group.getWorldQuaternion(new THREE.Quaternion())
    .multiply(new THREE.Quaternion().fromArray(start.rotation!));
  const screenDelta = (axis: 'x' | 'y' | 'z', amount: number, kind = 'move') => {
    const worldAxis = transformAxis(axis).applyQuaternion(rotation);
    let origin = position.clone(), vector = worldAxis;
    if (kind === 'rotate') {
      const radial = new THREE.Vector3(0, 1, 0).applyQuaternion(rotation);
      vector = worldAxis.clone().cross(radial);
      origin.add(radial);
    }
    const camera = transformViewCamera(f.controller.camera);
    return transformScreenPoint(origin.clone().add(vector), camera, 900, 600)
      .sub(transformScreenPoint(origin, camera, 900, 600)).multiplyScalar(amount);
  };
  const handle = (kind: 'move' | 'rotate' | 'scale', axis: 'x' | 'y' | 'z'): TransformHandle => ({
    key: `${kind}-${axis}`, kind, axis, worldPoint: position.clone().add(new THREE.Vector3(0, 1, 0).applyQuaternion(rotation)) });
  return { ...f, start, screenDelta, handle };
}

test('drag follows decoration local axes on a rotated owner, previews without saving, and commits one undo step', () => {
  const f = dragFixture();
  try {
    const originalBodyPose = f.entity.position.toArray();
    const originalRotation = f.entity.quaternion.toArray();
    const blocks = JSON.stringify(f.entity.blocks);
    assert.equal(f.tool.beginDrag(f.handle('move', 'x'), { clientX: 0, clientY: 0 }), true);
    for (const distance of [0.25, 0.5, 1]) {
      const delta = f.screenDelta('x', distance);
      f.tool.updateDrag({ clientX: delta.x, clientY: delta.y, shiftKey: false });
    }
    assert.equal(f.saves(), 0);
    assert.deepEqual(f.entity.getComponentDecorations('base'), [f.start]);
    const mesh = f.entity.decorationGroups.get('base')!.children[0];
    const expected = transformAxis('x').applyQuaternion(new THREE.Quaternion().fromArray(f.start.rotation!));
    assert.ok(mesh.position.clone().add(f.entity.getEntityNode('base').pivotLocal).distanceTo(expected) < 1e-8);
    assert.equal(f.tool.endDrag(), true);
    assert.equal(f.saves(), 1);
    assert.ok(new THREE.Vector3().fromArray(f.tool.getSelection()!.value.position!).distanceTo(expected) < 1e-8);
    assert.equal(f.tool.undo(), true);
    assert.deepEqual(f.tool.getSelection()!.value, f.start);
    assert.equal(f.tool.undo(), false);
    assert.deepEqual(f.entity.position.toArray(), originalBodyPose);
    assert.deepEqual(f.entity.quaternion.toArray(), originalRotation);
    assert.equal(JSON.stringify(f.entity.blocks), blocks);
  } finally { f.tool.deactivate(); f.entity.dispose(); setTorusViewCorrection(null); }
});

test('rotation, nonuniform resize and Shift snapping preserve other transform components', () => {
  for (const kind of ['rotate', 'scale'] as const) {
    const f = dragFixture();
    try {
      assert.equal(f.tool.beginDrag(f.handle(kind, 'x'), { clientX: 0, clientY: 0 }), true);
      const amount = kind === 'rotate' ? Math.PI / 6 + 0.03 : 0.31;
      const delta = f.screenDelta('x', amount, kind);
      f.tool.updateDrag({ clientX: delta.x, clientY: delta.y, shiftKey: true });
      assert.equal(f.tool.endDrag(), true);
      const value = f.tool.getSelection()!.value;
      if (kind === 'rotate') {
        const expected = new THREE.Quaternion().fromArray(f.start.rotation!).multiply(new THREE.Quaternion().setFromAxisAngle(transformAxis('x'), Math.PI / 6));
        assert.ok(new THREE.Quaternion().fromArray(value.rotation!).angleTo(expected) < 1e-7);
        assert.equal(value.scale, undefined);
      } else {
        assert.deepEqual(value.scale, [1.25, 1, 1]);
        assert.deepEqual(value.rotation, f.start.rotation);
      }
      assert.equal(value.position, undefined);
    } finally { f.tool.deactivate(); f.entity.dispose(); setTorusViewCorrection(null); }
  }
});

test('Esc cancels a preview, preserves selection and opens precise values; stale or unauthorized drags cannot commit', () => {
  const f = dragFixture();
  try {
    const begin = () => {
      assert.equal(f.tool.beginDrag(f.handle('scale', 'x'), { clientX: 0, clientY: 0 }), true);
      const delta = f.screenDelta('x', 0.5);
      f.tool.updateDrag({ clientX: delta.x, clientY: delta.y, shiftKey: false });
    };
    begin();
    assert.equal(f.tool.precisionOpen, false);
    assert.equal(f.tool.openPrecision(), true);
    assert.equal(f.tool.precisionOpen, true);
    assert.equal(f.tool.isDragging, false);
    assert.deepEqual(f.tool.getSelection()!.value, f.start);
    assert.deepEqual(f.entity.decorationGroups.get('base')!.children[0].scale.toArray(), [1, 1, 1]);
    assert.equal(f.saves(), 0);
    begin();
    f.entity.setComponentDecorations('base', [{ ...f.start, color: 2 }]);
    assert.equal(f.tool.endDrag(), false);
    assert.equal(f.tool.getSelection()!.value.color, 2);
    begin();
    f.entity.serverCanEdit = false;
    assert.equal(f.tool.endDrag(), false);
    assert.equal(f.saves(), 0);
    assert.equal(f.tool.beginDrag(f.handle('move', 'x'), { clientX: 0, clientY: 0 }), false);
  } finally { f.tool.deactivate(); f.entity.dispose(); setTorusViewCorrection(null); }
});

test('gizmo picks movement arrows and scale cubes separately in the rendered bent coordinate space', () => {
  const gizmo = new TransformGizmo();
  const camera = new THREE.PerspectiveCamera(60, 1.5, 0.1, 1000);
  camera.position.set(4, 3, 6); camera.lookAt(0, 0, 0);
  setTorusViewCorrection(camera.position);
  try {
    const view = transformViewCamera(camera);
    gizmo.setPose(new THREE.Vector3(), new THREE.Quaternion(), 1);
    for (const kind of ['move', 'scale'] as const) {
      for (const axis of ['x', 'y', 'z'] as const) {
        const point = transformAxis(axis).multiplyScalar(kind === 'move' ? 0.97 : 1.38);
        const bent = bendPointForView(point.x, point.y, point.z);
        const ray = new THREE.Ray(view.position.clone(), bent.sub(view.position).normalize());
        assert.equal(gizmo.pick(ray)?.key, `${kind}-${axis}`);
      }
    }
    for (const axis of ['x', 'y', 'z'] as const) {
      const u = axis === 'x' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const v = transformAxis(axis).cross(u);
      const angle = -0.12 * Math.PI + 16 / 64 * Math.PI * 1.75;
      const point = u.multiplyScalar(Math.cos(angle) * 0.76).addScaledVector(v, Math.sin(angle) * 0.76);
      const ray = new THREE.Ray(view.position.clone(), bendPointForView(point.x, point.y, point.z).sub(view.position).normalize());
      assert.equal(gizmo.pick(ray)?.key, `rotate-${axis}`);
    }
  } finally { gizmo.dispose(); setTorusViewCorrection(null); }
});

test('only the precise-value panel captures the free cursor; resuming preserves selection', () => {
  const f = fixture();
  const store = new SpaceUiStore();
  let locks = 0;
  f.controller.requestLock = () => { locks++; };
  f.controller.activeTool = 'modeling';
  f.controller.modeling = f.tool;
  try {
    store.setController(f.controller);
    f.controller.activeTool = 'modeling';
    store.startGame();
    locks = 0;
    f.entity.setComponentDecorations('base', [{ id: 'trim', color: 1 }]);
    f.tool.selected = { contraption: f.entity, componentId: 'base', decorationId: 'trim' };
    assert.equal(f.tool.capturesPointer(), false);
    f.tool.openPrecision();
    store.resumeFromCanvas();
    assert.equal(locks, 0);
    f.tool.continueBuilding();
    assert.equal(locks, 1);
    assert.equal(f.tool.getSelection()!.decorationId, 'trim');
    assert.equal(f.tool.precisionOpen, false);
  } finally { f.tool.deactivate(); f.entity.dispose(); }
});

test('locked gizmo dragging accumulates relative motion instead of stale client coordinates', () => {
  const f = dragFixture();
  try {
    f.controller.isLocked = true;
    assert.equal(f.unlocks(), 0);
    assert.equal(f.tool.beginDrag(f.handle('move', 'x'), { clientX: 600, clientY: 300 }), true);
    const delta = f.screenDelta('x', 0.5);
    for (let i = 0; i < 2; i++) {
      f.tool.updateDrag({ clientX: 600, clientY: 300, movementX: delta.x, movementY: delta.y });
    }
    assert.equal(f.tool.endDrag(), true);
    const expected = transformAxis('x').applyQuaternion(new THREE.Quaternion().fromArray(f.start.rotation!));
    assert.ok(new THREE.Vector3().fromArray(f.tool.getSelection()!.value.position!).distanceTo(expected) < 1e-8);
    assert.equal(f.controller.isLocked, true);
    assert.equal(f.unlocks(), 0);
  } finally { f.tool.deactivate(); f.entity.dispose(); setTorusViewCorrection(null); }
});

function creationFixture() {
  const f = dragFixture();
  f.controller.isLocked = true;
  const value = { id: 'preview', color: 0x123456, position: [0, 0.5, 0] as [number, number, number] };
  f.tool.placement = { target: { contraption: f.entity, componentId: 'base' }, value };
  const node = f.entity.getEntityNode('base');
  const worldRotation = node.group.getWorldQuaternion(new THREE.Quaternion());
  const origin = f.entity.entityLocalToWorld('base', new THREE.Vector3());
  const camera = transformViewCamera(f.controller.camera);
  const screenAxis = (axis: 'x' | 'z') => transformScreenPoint(origin.clone().add(transformAxis(axis).applyQuaternion(worldRotation)), camera, 900, 600)
    .sub(transformScreenPoint(origin, camera, 900, 600));
  const deltaFor = (x: number, z: number) => screenAxis('x').multiplyScalar(x).add(screenAxis('z').multiplyScalar(z));
  return { ...f, deltaFor };
}

test('right click has no ghost and creates one default cube only on release, preserving pointer lock', () => {
  const f = creationFixture();
  try {
    const count = f.entity.getDecorationCount();
    const tool = f.tool as any;
    assert.equal(tool.preview, null);
    assert.equal(f.tool.beginCreation({ clientX: 100, clientY: 100 }), true);
    assert.equal(f.entity.getDecorationCount(), count);
    assert.equal(tool.preview, null);
    f.tool.updateCreation({ clientX: 100, clientY: 100, movementX: 1, movementY: 1 });
    assert.equal(tool.preview, null, 'small click jitter must not create a preview');
    assert.equal(f.tool.endCreation(), true);
    assert.equal(f.tool.endCreation(), false);
    assert.equal(f.entity.getDecorationCount(), count + 1);
    assert.equal(f.tool.getSelection()!.value.scale, undefined);
    assert.deepEqual(f.tool.getSelection()!.value.position, [0, 0.5, 0]);
    assert.equal(f.saves(), 1);
    assert.equal(f.unlocks(), 0);
    assert.equal(f.controller.isLocked, true);
    assert.equal(tool.preview, null);
    f.tool.update({ kind: null });
    assert.equal(tool.preview, null, 'aiming after placement must not bring back an idle ghost');
  } finally { f.tool.deactivate(); f.entity.dispose(); setTorusViewCorrection(null); }
});

test('RMB drawing previews anchored dimensions on a rotated component and commits one undoable cube', () => {
  const f = creationFixture();
  try {
    const before = f.entity.getComponentDecorations('base');
    const bodyPosition = f.entity.position.toArray(), bodyRotation = f.entity.quaternion.toArray();
    assert.equal(f.tool.beginCreation({ clientX: 0, clientY: 0 }), true);
    const delta = f.deltaFor(-2, 3);
    assert.equal(f.tool.updateCreation({ clientX: 0, clientY: 0, movementX: delta.x, movementY: delta.y }), true);
    assert.ok((f.tool as any).preview.visible);
    assert.equal(f.saves(), 0);
    assert.deepEqual(f.entity.getComponentDecorations('base'), before);
    let prevented = false;
    assert.equal(f.tool.creationWheel({ deltaY: -1, preventDefault: () => { prevented = true; } }), true);
    assert.equal(prevented, true);
    assert.ok(new THREE.Vector3().fromArray(f.tool.creationDimensions!).distanceTo(new THREE.Vector3(2, 1.25, 3)) < 1e-8);
    assert.equal(f.tool.endCreation(), true);
    const added = f.tool.getSelection()!.value;
    assert.ok(new THREE.Vector3().fromArray(added.scale!).distanceTo(new THREE.Vector3(2, 1.25, 3)) < 1e-8);
    assert.ok(new THREE.Vector3().fromArray(added.position!).distanceTo(new THREE.Vector3(-1, 0.625, 1.5)) < 1e-8);
    assert.equal(f.saves(), 1);
    assert.equal((f.tool as any).preview, null);
    assert.deepEqual(f.entity.position.toArray(), bodyPosition);
    assert.deepEqual(f.entity.quaternion.toArray(), bodyRotation);
    assert.equal(f.tool.undo(), true);
    assert.deepEqual(f.entity.getComponentDecorations('base'), before);
    assert.equal(f.tool.undo(), false);
  } finally { f.tool.deactivate(); f.entity.dispose(); setTorusViewCorrection(null); }
});

test('drawing cancellation, lost permission and departed owners never leave a preview or create a cube', () => {
  for (const reason of ['escape', 'unlock', 'deactivate', 'permission', 'departed']) {
    const f = creationFixture();
    try {
      const before = f.entity.getComponentDecorations('base');
      f.tool.beginCreation();
      const delta = f.deltaFor(2, 2);
      f.tool.updateCreation({ clientX: 0, clientY: 0, movementX: delta.x, movementY: delta.y });
      if (reason === 'escape') f.tool.openPrecision();
      if (reason === 'unlock') f.tool.onPointerUnlocked();
      if (reason === 'deactivate') f.tool.deactivate();
      if (reason === 'permission') f.entity.serverCanEdit = false;
      if (reason === 'departed') f.controller.contraptions.contraptions = [];
      assert.equal(f.tool.endCreation(), false, reason);
      assert.deepEqual(f.entity.getComponentDecorations('base'), before, reason);
      assert.equal(f.saves(), 0, reason);
      assert.equal((f.tool as any).preview, null, reason);
    } finally { f.tool.deactivate(); f.entity.dispose(); setTorusViewCorrection(null); }
  }
});

test('drawing snaps dimensions and a read-only target cannot begin creation', () => {
  const f = creationFixture();
  try {
    f.entity.serverCanEdit = false;
    assert.equal(f.tool.beginCreation(), false);
    f.entity.serverCanEdit = true;
    assert.equal(f.tool.beginCreation(), true);
    const delta = f.deltaFor(1.29, -0.29);
    f.tool.updateCreation({ clientX: 0, clientY: 0, movementX: delta.x, movementY: delta.y, shiftKey: true });
    assert.deepEqual(f.tool.creationDimensions, [1.25, 1, 0.25]);
    f.tool.cancelDrag();
    assert.equal(f.tool.endCreation(), false);
    assert.equal(f.saves(), 0);
  } finally { f.tool.deactivate(); f.entity.dispose(); setTorusViewCorrection(null); }
});

test('an edge-on drawing plane rejects a drag instead of creating an accidental default cube', () => {
  const f = creationFixture();
  try {
    f.controller.camera.position.set(5, 0, 5);
    f.controller.camera.lookAt(0, 0, 0);
    setTorusViewCorrection(f.controller.camera.position);
    assert.equal(f.tool.beginCreation(), true);
    f.tool.updateCreation({ clientX: 0, clientY: 0, movementX: 50, movementY: 50 });
    f.tool.update({ kind: null });
    assert.equal((f.tool as any).preview, null);
    assert.equal(f.tool.endCreation(), false);
    assert.equal(f.saves(), 0);
    assert.equal(f.tool.beginCreation(), true);
    assert.equal(f.tool.endCreation(), true, 'a simple click remains available at the same angle');
  } finally { f.tool.deactivate(); f.entity.dispose(); setTorusViewCorrection(null); }
});

test('game mouse events drag without rotating the view, commit on the matching release, then resume mouse look', t => {
  const f = creationFixture();
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  const listeners = new Map<string, (event: any) => void>();
  const body = {};
  globalThis.document = { body, pointerLockElement: body, addEventListener: (name, callback) => listeners.set(name, callback) } as any;
  globalThis.window = { addEventListener: (name, callback) => listeners.set(name, callback) } as any;
  t.after(() => { globalThis.document = previousDocument; globalThis.window = previousWindow; f.tool.deactivate(); f.entity.dispose(); setTorusViewCorrection(null); });
  const controller = Object.setPrototypeOf(f.controller, PlayerController.prototype);
  Object.assign(controller, { modeling: f.tool, pointerLockDesired: true, yaw: 0.3, pitch: 0.2,
    mouseSensitivity: 0.002, ignoreNextLockedMouseMove: false, updateCameraRotation() {},
    updateAimRaycast() {}, refreshAimAfterPointerAction() {}, releaseWrenchGizmoDrag() {}, releaseWrenchGrab() {}, releaseGizmoDrag() {},
    resetEntityInputState() {}, clearWrenchPivotDisplay() {} });
  controller.setupEventListeners();
  f.tool.clearSelection();
  const point = { clientX: 500, clientY: 300 };
  listeners.get('mousedown')!({ ...point, button: 0 });
  assert.equal(f.tool.getSelection()!.decorationId, 'trim');
  assert.equal(f.tool.isDragging, true);
  listeners.get('mousemove')!({ ...point, movementX: 30, movementY: 20 });
  assert.equal(controller.yaw, 0.3);
  assert.equal(controller.pitch, 0.2);
  assert.equal(f.saves(), 0);
  listeners.get('mouseup')!({ button: 2 });
  assert.equal(f.tool.isDragging, true, 'RMB release cannot complete an LMB drag');
  listeners.get('mouseup')!({ button: 0 });
  assert.equal(f.saves(), 1);
  assert.equal(controller.isLocked, true);
  assert.equal(f.unlocks(), 0);
  listeners.get('mousemove')!({ ...point, movementX: 10, movementY: 5 });
  assert.ok(Math.abs(controller.yaw - 0.28) < 1e-10);
  assert.ok(Math.abs(controller.pitch - 0.19) < 1e-10);
  listeners.get('mousedown')!({ ...point, button: 2 });
  const delta = f.deltaFor(1, 2);
  listeners.get('mousemove')!({ ...point, movementX: delta.x, movementY: delta.y });
  const count = f.entity.getDecorationCount();
  listeners.get('mouseup')!({ button: 0 });
  assert.equal(f.entity.getDecorationCount(), count);
  listeners.get('mouseup')!({ button: 2 });
  assert.equal(f.entity.getDecorationCount(), count + 1);
  assert.equal(f.saves(), 2);
  listeners.get('mousedown')!({ ...point, button: 2 });
  listeners.get('mousemove')!({ ...point, movementX: delta.x, movementY: delta.y });
  listeners.get('blur')!({});
  listeners.get('mouseup')!({ button: 2 });
  assert.equal(f.entity.getDecorationCount(), count + 1, 'blur cancels an unfinished right drag');
  assert.equal((f.tool as any).preview, null);
});

test('modeling Escape is routed to exact values, leaving the decoration selected', () => {
  const f = fixture();
  let prevented = false;
  try {
    f.entity.setComponentDecorations('base', [{ id: 'trim', color: 1 }]);
    f.tool.selected = { contraption: f.entity, componentId: 'base', decorationId: 'trim' };
    f.controller.activeTool = 'modeling';
    f.controller.modeling = f.tool;
    f.controller.recordEntityKeyDown = () => {};
    PlayerController.prototype.handleKeyDown.call(f.controller, { code: 'Escape', preventDefault: () => { prevented = true; } } as any);
    assert.equal(prevented, true);
    assert.equal(f.tool.precisionOpen, true);
    assert.equal(f.tool.getSelection()!.decorationId, 'trim');
  } finally { f.tool.deactivate(); f.entity.dispose(); }
});

test('read-only edits and stale undo history cannot mutate other entity data', () => {
  const f = fixture();
  try {
    f.tool.placement = { target: { contraption: f.entity, componentId: 'base' }, value: { id: 'preview', color: 1 } };
    f.entity.serverCanEdit = false;
    assert.equal(f.tool.create(), false);
    assert.equal(f.entity.getDecorationCount(), 0);
    f.entity.serverCanEdit = true;
    f.tool.create();
    f.entity.setComponentDecorations('base', [{ id: 'other', color: 2 }]);
    assert.equal(f.tool.undo(), false);
    assert.deepEqual(f.entity.getComponentDecorations('base'), [{ id: 'other', color: 2 }]);
  } finally { f.tool.deactivate(); f.entity.dispose(); }
});

test('presentation includes decoration TRS while placement geometry keeps its physical voxel shape', () => {
  const slot: any = { kind: 'entity', rootComponentId: 'base', blocks: [{ localX: 0, localY: 0, localZ: 0, size: 1, entityId: 'base' }],
    decorations: [{ id: 'trim', color: 1, position: [5, 0, 0], scale: [2, 0.1, 1], rotation: [0, Math.sin(0.2), 0, Math.cos(0.2)] }] };
  assert.equal(getInventoryPreviewBlocks(slot).length, 1);
  const visual = getInventoryPreviewBlocks(slot, true);
  assert.equal(visual.length, 2);
  assert.deepEqual(visual[1].center.toArray(), [5, 0, 0]);
  assert.deepEqual(visual[1].scale.toArray(), [2, 0.1, 1]);
  assert.ok(visual[1].quaternion.angleTo(new THREE.Quaternion().fromArray(slot.decorations[0].rotation)) < 1e-9);
});
