import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { CHUNK_SIZE_Y } from '@entropydrop/space-engine/voxel/Chunk.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { TextCreationSession, placeTextOnSurface, type TextCreationAnchor, type TextOrientation } from '../src/engine/controls/TextCreationSession.ts';
import { textMaskToVoxels, type TextVoxelOptions } from '../src/engine/voxel/TextVoxelizer.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { normalizeVoxelMaterialId } from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';
import { setTorusViewCorrection } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { transformAxis, transformScreenPoint, transformViewCamera } from '../src/engine/render/TransformGizmo.ts';

const options: TextVoxelOptions = { text: '\u4e2d\u6587', fontSize: 16, micro: true, color: 0x66bbcc, materialId: 0 };
const raster = (opts = options) => textMaskToVoxels([255, 0, 255, 255, 255, 0], 3, 2, opts);
const anchor = (normal = new THREE.Vector3(0, 0, 1)): TextCreationAnchor => ({
  point: new THREE.Vector3(4.5, 20, 6), normal, forward: new THREE.Vector3(0, 0, -1), target: null, nodeId: '',
});

test('alpha raster becomes a trimmed upright stencil with exact color and selectable cell size', () => {
  const micro = raster();
  assert.deepEqual(micro.slot.blocks.map(b => [b.dx, b.dy, b.dz]), [[0, .125, 0], [.25, .125, 0], [0, 0, 0], [.125, 0, 0]]);
  assert.equal(micro.width, .375); assert.equal(micro.height, .25);
  assert.ok(micro.slot.blocks.every(b => b.size === .125 && b.color === options.color && b.materialId === 0));
  const standard = raster({ ...options, micro: false });
  assert.equal(standard.width, 3); assert.equal(standard.height, 2);
  assert.ok(standard.slot.blocks.every(b => b.size === 1));
  assert.throws(() => textMaskToVoxels([0, 0], 2, 1, options), /visible text/);
  assert.throws(() => textMaskToVoxels(new Uint8Array(65537).fill(255), 65537, 1, options), /65,536/);
  assert.throws(() => textMaskToVoxels(new Uint8Array(257).fill(255), 257, 1, { ...options, micro: false }), /256 m/);
});

for (const micro of [true, false]) for (const axis of [0, 1, 2]) for (const sign of [-1, 1]) {
  test(`text lies outside surface on axis ${axis}, normal ${sign}, micro=${micro}`, () => {
    const focus = anchor(new THREE.Vector3().setComponent(axis, sign));
    const result = raster({ ...options, micro });
    const placement = placeTextOnSurface(result, focus);
    const minima = placement.slot.blocks.map(b => new THREE.Vector3(b.dx, b.dy, b.dz).add(placement.position));
    const min = Math.min(...minima.map(p => p.getComponent(axis)));
    const max = Math.max(...minima.map(p => p.getComponent(axis) + result.cellSize));
    assert.ok(sign > 0 ? min >= focus.point.getComponent(axis) : max <= focus.point.getComponent(axis));
    assert.ok(Math.abs(max - min - result.cellSize) < 1e-8, 'one cell thick along surface normal');
    assert.ok(minima.every(p => p.toArray().every(v => Math.abs(v / result.cellSize - Math.round(v / result.cellSize)) < 1e-8)));
  });
}

test('world height is validated before preview or construction', () => {
  const focus = anchor(); focus.point.y = CHUNK_SIZE_Y;
  assert.throws(() => placeTextOnSurface(raster(), focus), /world height/);
});

for (const orientation of ['vertical', 'horizontal'] as const) for (const micro of [true, false]) {
  test(`${orientation} text uses its selected plane and stays outside floors, walls and ceilings, micro=${micro}`, () => {
    for (const axis of [0, 1, 2]) for (const sign of [-1, 1]) {
      const focus = anchor(new THREE.Vector3().setComponent(axis, sign));
      const result = raster({ ...options, micro, materialId: 61 });
      const placement = placeTextOnSurface(result, focus, orientation);
      const box = new THREE.Box3();
      for (const block of placement.slot.blocks) {
        const min = new THREE.Vector3(block.dx, block.dy, block.dz).add(placement.position);
        box.expandByPoint(min); box.expandByPoint(min.clone().addScalar(result.cellSize));
        assert.ok(min.toArray().every(v => Number.isInteger(v / result.cellSize)));
        assert.equal(block.materialId, 61);
      }
      const size = box.getSize(new THREE.Vector3());
      assert.equal(size.y, orientation === 'vertical' ? result.height : result.cellSize);
      assert.ok(sign > 0 ? box.min.getComponent(axis) >= focus.point.getComponent(axis)
        : box.max.getComponent(axis) <= focus.point.getComponent(axis));
      assert.ok(Math.abs((sign > 0 ? box.min : box.max).getComponent(axis) - focus.point.getComponent(axis)) < result.cellSize,
        'the text remains in contact with the focused surface after snapping');
      assert.equal(placement.slot.blockCount, result.slot.blockCount);
    }
  });
}

test('vertical text faces the player from all four horizontal camera directions', () => {
  for (const forward of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)]) {
    const focus = anchor(new THREE.Vector3(0, 1, 0)); focus.forward = forward;
    const result = raster(); const placement = placeTextOnSurface(result, focus, 'vertical');
    const axis = forward.x ? 'x' : 'z';
    const minima = placement.slot.blocks.map(b => placement.position[axis] + (axis === 'x' ? b.dx : b.dz));
    assert.equal(Math.max(...minima) - Math.min(...minima), 0, 'the stencil faces back toward the player');
  }
});

test('session pins focus, updates previews, rejects stale generations and cancels without building', async () => {
  const calls: string[] = [];
  const pending: Array<(value: ReturnType<typeof raster>) => void> = [];
  let editable = true;
  const session = new TextCreationSession({
    refresh() {}, unlock() { calls.push('unlock'); }, requestLock() { calls.push('lock'); }, canEdit() { return editable; },
    preview(a, p) { return { slot: p.slot, position: p.position.clone() }; },
    build() { calls.push('build'); return true; },
  }, () => new Promise(resolve => pending.push(resolve)));
  const focus = anchor();
  session.open(focus, options.color, true); focus.point.set(999, 999, 999);
  session.edit({ text: '\u65b0\u6587\u5b57', color: 0xff0000, materialId: 61 });
  pending[1](raster({ ...options, color: 0xff0000, materialId: 61 })); await session.ready;
  const preview = session.getPreview()!;
  assert.ok(preview.position.x < 10); assert.equal(preview.slot.blocks![0].color, 0xff0000);
  pending[0](raster()); await Promise.resolve();
  assert.equal(session.getPreview()!.slot.blocks![0].color, 0xff0000, 'old font load cannot overwrite newer text');
  assert.equal(session.getPreview()!.slot.blocks![0].materialId, 61);
  assert.equal(session.view.materialId, 61);
  editable = false; assert.equal(session.view.canCreate, false); assert.equal(session.getPreview(), null);
  assert.equal(session.create(), false);
  editable = true; session.close();
  assert.equal(session.getPreview(), null); assert.deepEqual(calls, ['unlock', 'lock']);
});

function controllerHarness() {
  const c: any = Object.create(PlayerController.prototype);
  c.activeTool = SpecialTool.HAMMER; c.hammerMicroMode = true; c.selectedColor = options.color;
  c.camera = new THREE.PerspectiveCamera(); c.keys = { forward: true };
  const store = new SpaceUiStore();
  c.ui = store; c.unlock = () => store.setPointerLocked(false); c.requestLock = () => store.setPointerLocked(true);
  c.contraptions = { contraptions: [] }; c.world = {};
  c.currentRaycast = { hit: true, kind: 'standard', hitPos: { x: 4, y: 19, z: 6 }, entry: { x: 4.5, y: 20, z: 6.5 }, normal: { x: 0, y: 1, z: 0 } };
  (store as any).patch({ controller: c, hasStarted: true });
  (c.textCreation as any).voxelize = async (opts: TextVoxelOptions) => raster(opts);
  return { c, store };
}

test('Hammer T opens panel, suspends picking and movement; Escape cancels and resumes', async () => {
  const { c, store } = controllerHarness();
  c.hammerMicroMode = false;
  c.handleRightClick(null);
  assert.equal(c.textCreationView.open, false, 'RMB no longer creates text');
  c.handleKeyDown({ code: 'KeyT', preventDefault() {} }); await c.textCreation.ready;
  assert.equal(c.textCreationView.fontSize, 12);
  assert.equal(c.textCreationView.orientation, 'vertical');
  assert.equal(c.textCreationView.materialId, 0);
  assert.equal(c.textCreationView.micro, true, 'text defaults to micro independently of Hammer positioning');
  assert.equal(store.getSnapshot().textCreation.open, true); assert.equal(store.hasAnyModalOpen(), true);
  assert.equal(c.worldPickingSuspended, true); assert.equal(c.keys.forward, false);
  assert.ok(c.textCreationPreview); assert.equal(c.currentRaycast.hit, false);
  store.resumeFromCanvas();
  assert.equal(store.getSnapshot().textCreation.open, true, 'canvas clicks and drags keep the text panel open');
  assert.equal(store.getSnapshot().pointerLocked, false);
  c.handleKeyDown({ code: 'Digit1' }); assert.equal(c.activeTool, SpecialTool.HAMMER);
  assert.equal(store.handleEscape(), true); assert.equal(store.getSnapshot().textCreation.open, false);
  assert.equal(c.worldPickingSuspended, false); assert.equal(store.getSnapshot().pointerLocked, true);
});

test('text shortcut ignores repeats, modifiers, editable fields and suspended world input', () => {
  const { c, store } = controllerHarness();
  for (const patch of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true },
    { target: { tagName: 'TEXTAREA' } }, { target: { isContentEditable: true } }]) {
    c.handleKeyDown({ code: 'KeyT', preventDefault() {}, ...patch });
    assert.equal(c.textCreationView.open, false);
  }
  c.worldPickingSuspended = true;
  c.handleKeyDown({ code: 'KeyT', preventDefault() {} });
  assert.equal(c.textCreationView.open, false);
  c.worldPickingSuspended = false;
  store.toggleHelpModal(true);
  c.handleKeyDown({ code: 'KeyT', preventDefault() {} });
  assert.equal(c.textCreationView.open, false, 'other modal dialogs keep keyboard focus');
  store.toggleHelpModal(false);
  c.activeTool = SpecialTool.SHOVEL;
  c.handleKeyDown({ code: 'KeyT', preventDefault() {} });
  assert.equal(c.textCreationView.open, false);
});

test('text offsets snap to micro cells, survive edits, respect world height and reset on reopen', async () => {
  const { c, store } = controllerHarness();
  c.openTextCreation(); await c.textCreation.ready;
  const original = c.textCreationPreview.position.clone();
  c.textCreation.setOffset(new THREE.Vector3(.18, -.2, .32));
  assert.deepEqual(c.textCreation.offset.toArray(), [.125, -.25, .375]);
  assert.deepEqual(c.textCreationPreview.position.toArray(), original.add(c.textCreation.offset).toArray());
  assert.equal(store.getSnapshot().textCreation.offsetX, .125);
  c.textCreation.edit({ text: 'Moved text', fontSize: 24, color: 0xff0000, orientation: 'horizontal' });
  await c.textCreation.ready;
  assert.deepEqual(c.textCreation.offset.toArray(), [.125, -.25, .375]);
  c.textCreation.setOffset(new THREE.Vector3(.125, -1000, .375));
  assert.equal(c.textCreationPreview.position.y, 0);
  c.textCreation.setOffset(new THREE.Vector3(.125, 1000, .375));
  assert.equal(c.textCreationPreview.position.y, CHUNK_SIZE_Y - .125);
  assert.equal(c.textCreation.setOffset(new THREE.Vector3(NaN, 0, 0)), false);
  c.textCreation.close(false);
  c.textCreation.open(anchor(), options.color); await c.textCreation.ready;
  assert.deepEqual(c.textCreation.offset.toArray(), [0, 0, 0]);
  c.textCreation.close(false);
});

test('fractionally moved standard text builds micro voxels at exactly the preview coordinates', async () => {
  const { c } = controllerHarness();
  const commands: any[] = [];
  c.performBasicAction = (command: any) => { commands.push(command); return { placed: 1 }; };
  c.activateTool = () => {};
  c.openTextCreation(); await c.textCreation.ready;
  c.textCreation.edit({ micro: false }); await c.textCreation.ready;
  const standard = c.textCreationPreview;
  c.textCreation.setOffset(new THREE.Vector3(.125, -.25, .375));
  const preview = c.textCreationPreview;
  assert.equal(preview.slot.blockCount, standard.slot.blockCount * 512);
  assert.ok(preview.slot.blocks.every((b: any) => b.size === .125));
  assert.deepEqual(preview.position.toArray(), standard.position.clone().add(c.textCreation.offset).toArray());
  assert.equal(c.textCreation.create(), true);
  while (c.bulkEditJob) c.processBulkEditFrame(64, Infinity);
  assert.deepEqual(commands.map(command => command.micro), preview.slot.blocks.map((b: any) =>
    [preview.position.x + b.dx, preview.position.y + b.dy, preview.position.z + b.dz].map(v => v * 8)));
});

test('over-limit fractional standard text stays movable and recovers on the whole-cell grid', async () => {
  const { c } = controllerHarness();
  (c.textCreation as any).voxelize = async (opts: TextVoxelOptions) => textMaskToVoxels(new Uint8Array(129).fill(255), 129, 1, opts);
  c.openTextCreation(); await c.textCreation.ready;
  c.textCreation.edit({ micro: false }); await c.textCreation.ready;
  c.textCreation.setOffset(new THREE.Vector3(.125, 0, 0));
  assert.match(c.textCreationView.error, /65,536/);
  assert.equal(c.textCreationView.canCreate, false);
  assert.ok(c.textCreationPreview, 'keep the preview available for drag recovery');
  assert.equal(c.textCreation.create(), false);
  c.textCreation.setOffset(new THREE.Vector3(1, 0, 0));
  assert.equal(c.textCreationView.error, null);
  assert.equal(c.textCreationView.canCreate, true);
  c.textCreation.close(false);
});

for (const axis of ['x', 'y', 'z'] as const) test(`text ${axis.toUpperCase()} arrow drags in the rendered local frame while world picking is suspended`, async t => {
  const { c } = controllerHarness();
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  const listeners = new Map<string, (event: any) => void>();
  globalThis.document = { addEventListener: (name: string, callback: EventListener) => listeners.set(name, callback) } as any;
  globalThis.window = { addEventListener: (name: string, callback: EventListener) => listeners.set(name, callback) } as any;
  t.after(() => { c.textCreation.close(false); globalThis.document = previousDocument; globalThis.window = previousWindow; setTorusViewCorrection(null); });
  const rect = { left: 30, top: 20, width: 1000, height: 700 };
  c.sceneRenderer = { scene: new THREE.Scene(), renderer: { domElement: { getBoundingClientRect: () => rect } } };
  c.camera = new THREE.PerspectiveCamera(60, rect.width / rect.height, .1, 1000);
  c.camera.position.set(9, 24, 13); c.camera.lookAt(4.5, 20, 6.5);
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(.1, .4, -.2));
  // Exercise picking and dragging against rotated component axes as well as camera bend.
  const host = (c.textCreation as any).host;
  const originalPreview = host.preview;
  host.preview = (a: TextCreationAnchor, p: any) => ({ ...originalPreview(a, p), quaternion: rotation });
  c.openTextCreation(); await c.textCreation.ready;
  setTorusViewCorrection(c.camera.position);
  c.updateTextCreationGizmo();
  const group = c.sceneRenderer.textCreationGizmo as THREE.Group;
  assert.deepEqual([...new Set(group.children.map(child => child.userData.transformHandle))], ['move-x', 'move-y', 'move-z']);
  assert.ok(group.quaternion.angleTo(rotation) < 1e-7);
  assert.equal(c.worldPickingSuspended, true);
  c.setupEventListeners();
  const camera = transformViewCamera(c.camera);
  const project = (p: THREE.Vector3) => transformScreenPoint(p, camera, rect.width, rect.height);
  const start = project(group.localToWorld(transformAxis(axis).multiplyScalar(.97)))
    .add(new THREE.Vector2(rect.left + rect.width / 2, rect.top + rect.height / 2));
  const screenVector = project(group.position.clone().add(transformAxis(axis).applyQuaternion(rotation))).sub(project(group.position));
  const event = (delta: number) => ({ button: 0, clientX: start.x + screenVector.x * delta,
    clientY: start.y + screenVector.y * delta, preventDefault() {}, stopPropagation() {} });
  listeners.get('mousedown')!({ ...event(0), target: { closest: () => null } });
  listeners.get('mousemove')!(event(.3));
  assert.deepEqual(c.textCreation.offset.toArray(), [0, 0, 0], 'panel clicks cannot grab scene handles');
  listeners.get('mousedown')!(event(0));
  listeners.get('mousemove')!(event(.18));
  assert.deepEqual(c.textCreation.offset.toArray(), transformAxis(axis).multiplyScalar(.125).toArray());
  listeners.get('mousemove')!(event(-.2));
  assert.deepEqual(c.textCreation.offset.toArray(), transformAxis(axis).multiplyScalar(-.25).toArray().map(v => v || 0));
  listeners.get('mouseup')!({ button: 0 });
  listeners.get('mousemove')!(event(.5));
  assert.equal(c.textCreation.offset[axis], -.25, 'mouse release ends dragging');
  c.textCreation.close(false);
  assert.equal(c.sceneRenderer.textCreationGizmo, undefined);
  assert.equal(group.parent, null, 'closing disposes the overlay');
});

for (const orientation of ['vertical', 'horizontal'] as const) test(`${orientation} terrain text writes exactly the displayed micro cells and switches to Wrench`, async () => {
  const { c } = controllerHarness();
  const commands: any[] = [];
  c.performBasicAction = (command: any) => { commands.push(command); return { placed: 1 }; };
  c.activateTool = (tool: string) => { c.activeTool = tool; };
  c.openTextCreation(); await c.textCreation.ready;
  c.textCreation.edit({ materialId: 1, orientation }); await c.textCreation.ready;
  c.textCreation.setOffset(new THREE.Vector3(.125, .25, -.375));
  const preview = c.textCreationPreview;
  assert.equal(preview.materialId, 1);
  const expected = preview.slot.blocks.map((b: any) => [b.dx + preview.position.x, b.dy + preview.position.y, b.dz + preview.position.z].map(v => v * 8));
  assert.equal(c.textCreation.create(), true);
  assert.deepEqual(commands.map(command => command.micro), expected);
  assert.ok(commands.every(command => command.options.color === options.color));
  assert.ok(commands.every(command => command.options.materialId === 1));
  assert.equal(c.activeTool, SpecialTool.WRENCH); assert.equal(c.textCreationView.open, false);
});

test('switching orientation keeps the focus anchor and applies the newest plane to creation', async () => {
  const { c, store } = controllerHarness(); const commands: any[] = [];
  c.performBasicAction = (command: any) => { commands.push(command); return { placed: 1 }; };
  c.activateTool = () => {};
  c.openTextCreation(); await c.textCreation.ready;
  const focus = new THREE.Vector3(4.5, 20, 6.5);
  for (const orientation of ['horizontal', 'vertical', 'horizontal'] as TextOrientation[]) {
    c.textCreation.edit({ orientation }); await c.textCreation.ready;
    assert.equal(store.getSnapshot().textCreation.orientation, orientation);
    const preview = c.textCreationPreview;
    const expected = placeTextOnSurface(raster(c.textCreationView), { ...anchor(new THREE.Vector3(0, 1, 0)), point: focus }, orientation);
    assert.deepEqual(preview.position.toArray(), expected.position.toArray());
    assert.deepEqual(preview.slot.blocks, expected.slot.blocks);
  }
  const preview = c.textCreationPreview;
  assert.equal(c.textCreation.create(), true);
  assert.deepEqual(commands.map(command => command.micro), preview.slot.blocks.map((b: any) =>
    [preview.position.x + b.dx, preview.position.y + b.dy, preview.position.z + b.dz].map(v => v * 8)));
});

test('stopped component creation uses its local frame and skips both standard and micro occupied cells', () => {
  const { c } = controllerHarness();
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null);
  const target = manager.buildFromSlot({ kind: 'entity', rootComponentId: 'root', blocks: [
    { localX: 0, localY: 0, localZ: 0, size: 1, color: 0xffffff, entityId: 'root' },
    { localX: 1, localY: 0, localZ: 0, size: .125, color: 0xffffff, entityId: 'root' },
  ], childEntities: [], scripts: [], constraints: [] }, new THREE.Vector3(8, 20, 10), null, false)!;
  target.stopAllNodeScripts(); c.contraptions = manager;
  c.activateTool = (tool: string) => { c.activeTool = tool; };
  const placement = { slot: textMaskToVoxels([255, 255, 255], 3, 1, { ...options, materialId: 61 }).slot, position: new THREE.Vector3(.875, 0, 0) };
  try {
    assert.equal(c.buildTextVoxels({ ...anchor(), target, nodeId: 'root' }, placement), true);
    assert.equal(target.blocks.length, 3);
    assert.equal(target.blocks[2].localX, 1.125); assert.equal(target.blocks[2].size, .125);
    assert.equal(target.blocks[2].color, options.color); assert.equal(target.blocks[2].entityId, 'root');
    assert.equal(target.blocks[2].materialId, 61);
    assert.equal(target.blocks[0].color, 0xffffff); assert.equal(target.blocks[1].color, 0xffffff);
  } finally { manager.removeContraption(target, { skipSave: true }); }
});

test('moved text on a rotated component keeps local micro offsets through preview and construction', async () => {
  const { c } = controllerHarness();
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null);
  const target = manager.buildFromSlot({ kind: 'entity', rootComponentId: 'root', blocks: [
    { localX: 0, localY: 0, localZ: 0, size: 1, color: 0xffffff, entityId: 'root' },
  ], childEntities: [], scripts: [], constraints: [] }, new THREE.Vector3(8, 20, 10), null, false)!;
  target.stopAllNodeScripts(); c.contraptions = manager; c.activateTool = () => {};
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3);
  target.rootGroup.quaternion.copy(rotation);
  target.rootGroup.updateMatrixWorld(true);
  try {
    const focus = { ...anchor(), point: new THREE.Vector3(2, 1, 0), target, nodeId: 'root' };
    c.textCreation.open(focus, options.color); await c.textCreation.ready;
    c.textCreation.setOffset(new THREE.Vector3(.125, .25, -.375));
    const preview = c.textCreationPreview;
    const local = placeTextOnSurface(raster(), focus, 'vertical').position.add(c.textCreation.offset);
    const world = target.entityLocalToWorld('root', local.clone());
    assert.ok(preview.position.distanceTo(world) < 1e-8);
    assert.ok(preview.quaternion.angleTo(rotation) < 1e-7);
    const expected = preview.slot.blocks.map((b: any) => [b.dx + local.x, b.dy + local.y, b.dz + local.z]);
    assert.equal(c.textCreation.create(), true);
    assert.deepEqual(target.blocks.slice(1).map(b => [b.localX, b.localY, b.localZ]), expected);
    assert.ok(target.blocks.slice(1).every(b => b.size === .125));
  } finally { c.textCreation.close(false); manager.removeContraption(target, { skipSave: true }); }
});

test('generated text keeps fine strokes beyond the ordinary 200-voxel ghost threshold', () => {
  const renderer: any = Object.create(SceneRenderer.prototype);
  renderer.scene = new THREE.Scene(); renderer.setupInventoryPlacementPreview();
  const slot = textMaskToVoxels(new Uint8Array(21 * 21).map((_, i) => i % 2 ? 0 : 255), 21, 21, options).slot;
  assert.ok(slot.blockCount > 200);
  renderer.setInventoryPlacementPreview({ slot, position: new THREE.Vector3(), exactVoxels: true });
  const geometry = renderer.inventoryPlacementFill.geometry;
  const pos = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
  const index = geometry.getIndex(); let frontArea = 0;
  for (let i = 0; i < (index?.count ?? pos.count); i += 3) {
    const a = index ? index.getX(i) : i, b = index ? index.getX(i + 1) : i + 1, c = index ? index.getX(i + 2) : i + 2;
    if (normal.getZ(a) < .9) continue;
    const v = (j: number) => new THREE.Vector3().fromBufferAttribute(pos, j);
    frontArea += v(b).sub(v(a)).cross(v(c).sub(v(a))).length() / 2;
  }
  assert.equal(frontArea, slot.blockCount * .125 ** 2, 'every text pixel remains a separate exact voxel face');
  renderer.setInventoryPlacementPreview({ slot, position: new THREE.Vector3() });
  assert.notEqual(renderer.inventoryPlacementFill.geometry, geometry, 'changing detail mode invalidates the ghost cache');
});

for (const micro of [true, false]) for (const materialId of [0, 1, 61, 101]) test(`text stores ${micro ? 'micro' : 'standard'} terrain with material ${materialId} and skips occupied cells`, () => {
  const { c } = controllerHarness();
  const world = new World(new THREE.Scene()); c.world = world;
  const result = raster({ ...options, micro, materialId });
  const placement = { slot: result.slot, position: new THREE.Vector3(micro ? 4.875 : 4, 80, 6) };
  for (let x = 4; x < 8; x++) for (let z = 6; z < 8; z++) world.setBlock(x, 80, z, BlockTypes.AIR);
  world.setBlock(4, 80, 6, BlockTypes.COLOR_BLOCK, false, 0x112233);
  c.activateTool = () => {};
  assert.equal(c.buildTextVoxels(anchor(), placement), true);
  assert.equal(world.getBlockColor(4, 80, 6), 0x112233);
  if (micro) {
    assert.equal(world.getMicroBlock(39, 641, 48), null);
    assert.equal(world.getMicroBlock(41, 641, 48)?.color, options.color);
    assert.equal(normalizeVoxelMaterialId(world.getMicroBlock(41, 641, 48)?.materialId), materialId);
  }
  else {
    assert.equal(world.getBlockColor(6, 81, 6), options.color);
    assert.equal(world.getBlockMaterial(6, 81, 6), materialId);
  }
});

test('bulk text construction freezes its coordinates, colors and voxel size after accepting the preview', () => {
  const { c } = controllerHarness();
  const slot = textMaskToVoxels(new Uint8Array(300).fill(255), 100, 3, { ...options, materialId: 61 }).slot;
  const position = new THREE.Vector3(4, 80, 6);
  const writes: any[] = [];
  c.performBasicAction = (command: any) => { writes.push(command); return { placed: 1 }; };
  c.activateTool = () => {};
  assert.equal(c.buildTextVoxels(anchor(), { slot, position }), true);
  c.currentRaycast = { hit: false }; c.selectedColor = 0; c.hammerMicroMode = false; c.selectedMaterialId = 1;
  while (c.bulkEditJob) c.processBulkEditFrame(64, Infinity);
  assert.equal(writes.length, 300);
  assert.deepEqual(writes[0].micro, [32, 642, 48]);
  assert.ok(writes.every(command => command.action === 'place-micro' && command.options.color === options.color));
  assert.ok(writes.every(command => command.options.materialId === 61));
});

test('text material changes rebuild the ghost shading and restore ordinary Item ghosts', () => {
  const renderer: any = Object.create(SceneRenderer.prototype);
  renderer.scene = new THREE.Scene(); renderer.setupInventoryPlacementPreview();
  const pose = { slot: raster().slot, position: new THREE.Vector3(), exactVoxels: true };
  renderer.setInventoryPlacementPreview({ ...pose, materialId: 0 });
  const lit = renderer.inventoryPlacementFill.material;
  assert.equal(lit.isMeshStandardNodeMaterial, true);
  renderer.setInventoryPlacementPreview({ ...pose, materialId: 1 });
  const emissive = renderer.inventoryPlacementFill.material;
  assert.notEqual(emissive, lit); assert.equal(emissive.isMeshBasicNodeMaterial, true);
  assert.ok(emissive.colorNode && emissive.outputNode, 'emissive preview uses the shared surface and bloom shader');
  renderer.setInventoryPlacementPreview({ ...pose, materialId: 61 });
  assert.equal(renderer.inventoryPlacementFill.material.isMeshStandardNodeMaterial, true);
  assert.equal(renderer.inventoryPlacementFill.material.opacity, .38 * .4);
  assert.equal(renderer.inventoryPlacementFill.material.depthWrite, false);
  renderer.setInventoryPlacementPreview({ ...pose, materialId: 101 });
  assert.equal(renderer.inventoryPlacementFill.material.opacity, 0);
  assert.equal(renderer.inventoryPlacementWire.visible, true, 'the guide remains visible for fully transparent text');
  renderer.setInventoryPlacementPreview(pose);
  assert.equal(renderer.inventoryPlacementFill.material.isMeshBasicNodeMaterial, true);
  assert.equal(renderer.inventoryPlacementFill.material.opacity, .38);
});

test('tool switches and other modals discard the text preview; missing focus cannot open it', async () => {
  const { c, store } = controllerHarness();
  c.openTextCreation(); await c.textCreation.ready;
  c.activeTool = SpecialTool.SHOVEL;
  assert.equal(c.textCreationView.open, false); assert.equal(c.textCreationPreview, null);
  c.activeTool = SpecialTool.HAMMER;
  assert.equal(c.openTextCreation(), false, 'focus was cleared while editing');
  c.currentRaycast = { hit: true, entry: { x: 4, y: 20, z: 6 }, normal: { x: 0, y: 0, z: 1 } };
  c.openTextCreation(); await c.textCreation.ready;
  store.toggleHelpModal(true);
  assert.equal(c.textCreationView.open, false); assert.equal(store.getSnapshot().activeModal, 'help');
});
