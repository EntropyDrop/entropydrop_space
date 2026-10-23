import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { bendPointForView, setTorusViewCorrection } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { transformAxis, transformScreenPoint, transformViewCamera } from '../src/engine/render/TransformGizmo.ts';

const blockSet = () => ({ kind: 'blockset', name: 'Cube', blockCount: 1,
  blocks: [{ dx: 0, dy: 0, dz: 0, size: 1, color: 0x48dbfb, materialId: 1 }] });
const entitySlot = () => ({ kind: 'entity', name: 'Module', rootComponentId: 'root', blockCount: 1,
  blocks: [{ localX: 0, localY: 0, localZ: 0, size: 1, color: 0x48dbfb, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }],
  scripts: [], enabled: [], childEntities: [], constraints: [] });

function harness(slot: any = blockSet(), micro = false) {
  const c: any = Object.create(PlayerController.prototype);
  c.activeTool = SpecialTool.HAMMER;
  c.hammerMicroMode = micro;
  c.inventorySlots = [slot]; c.selectedInventoryIndex = 0;
  c.isLocked = true; c.pointerLockDesired = true;
  c.keys = { forward: true }; c.world = {}; c.contraptions = { contraptions: [] };
  c.currentRaycast = { hit: true, hitPos: { x: 4, y: 19, z: 6 },
    entry: { x: 4.5, y: 20, z: 6.5 }, normal: { x: 0, y: 1, z: 0 } };
  c.tryClickRunningEntity = () => false;
  const store = new SpaceUiStore(); c.ui = store;
  c.requestLock = () => { c.isLocked = true; store.setPointerLocked(true); };
  c.unlock = () => { c.isLocked = false; store.setPointerLocked(false); };
  c.activateTool = (tool: string) => { c.activeTool = tool; };
  (store as any).patch({ controller: c, hasStarted: true, pointerLocked: true });
  const commands: any[] = [];
  c.performBasicAction = (command: any) => { commands.push(command); return { placed: 1 }; };
  return { c, store, commands };
}

for (const micro of [false, true]) test(`LMB pins a ghost and Enter places it on the ${micro ? 'MICRO' : 'STD'} grid`, () => {
  const slot = blockSet();
  const { c, store, commands } = harness(slot, micro);
  c.unlock = () => assert.fail('entering placement preview must retain pointer lock');
  assert.equal(c.handleLeftClick(), true);
  assert.equal(c.keys.forward, true, 'preview keeps normal movement input');
  assert.equal(c.isLocked, true);
  assert.equal(c.pointerLockDesired, true);
  assert.equal(store.getSnapshot().pointerLocked, true);
  assert.equal(store.getSnapshot().hammerPlacementActive, true);
  assert.equal(c.activeTool, SpecialTool.HAMMER);
  assert.equal(commands.length, 0);
  const initial = c.inventoryPlacementPreview.position.clone();
  const step = micro ? .125 : 1;
  c.hammerPlacement.moveAlongAxis('x', 1.4 * step);
  c.hammerPlacement.moveAlongAxis('y', 2.4 * step);
  c.hammerPlacement.moveAlongAxis('z', -1.6 * step);
  const origin = c.inventoryPlacementPreview.position.clone();
  assert.ok(origin.equals(initial.add(new THREE.Vector3(step, 2 * step, -2 * step))));
  c.currentRaycast = { hit: false }; c.updateInventoryPlacementPreview();
  assert.deepEqual(c.inventoryPlacementPreview.position.toArray(), origin.toArray(), 'aim changes cannot move the pinned ghost');
  c.handleLeftClick(); store.resumeFromCanvas();
  assert.equal(commands.length, 0, 'extra clicks cannot confirm or restart construction');
  assert.equal(c.isLocked, true, 'canvas clicks preserve pointer lock');
  c.handleKeyDown({ code: 'Enter', repeat: true, preventDefault() {} });
  c.handleKeyDown({ code: 'Enter', target: { tagName: 'INPUT' }, preventDefault() {} });
  assert.equal(commands.length, 0);
  c.handleKeyDown({ code: 'Enter', preventDefault() {} });
  while (c.bulkEditJob) c.processBulkEditFrame(64, Infinity);
  assert.equal(commands.length, micro ? 512 : 1);
  assert.ok(commands.every(command => command.action === (micro ? 'place-micro' : 'place-standard') && command.options.materialId === 1));
  if (micro) {
    for (let axis = 0; axis < 3; axis++) {
      assert.equal(Math.min(...commands.map(command => command.micro[axis])) / 8, origin.getComponent(axis));
      assert.equal((Math.max(...commands.map(command => command.micro[axis])) + 1) / 8, origin.getComponent(axis) + 1);
    }
  } else {
    assert.deepEqual(commands[0].cell, { x: origin.x, y: origin.y, z: origin.z });
  }
  assert.equal(slot.blocks[0].size, 1, 'backpack data stays unchanged');
  assert.equal(c.activeTool, SpecialTool.WRENCH);
  assert.equal(c.hammerPlacementActive, false);
  assert.equal(store.getSnapshot().hammerPlacementActive, false);
});

test('RMB cancels before entity context actions; no geometry or entity is created', () => {
  const { c, commands } = harness();
  c.handleLeftClick();
  c.hammerPlacement.moveAlongAxis('x', 1);
  c.ui.tryOpenEntityContextMenuAtPointer = () => { assert.fail('cancel must precede context menus'); };
  assert.equal(c.handleRightClick(), true);
  assert.equal(c.hammerPlacementActive, false); assert.equal(c.inventoryPlacementPreview, null);
  assert.equal(c.activeTool, SpecialTool.HAMMER); assert.equal(commands.length, 0);
});

for (const reason of ['tool', 'slot', 'modal', 'suspend'] as const) test(`${reason} changes clear the pending placement`, () => {
  const { c, store, commands } = harness();
  c.handleLeftClick();
  if (reason === 'tool') c.activeTool = SpecialTool.SHOVEL;
  else if (reason === 'slot') c.selectedInventoryIndex = 1;
  else if (reason === 'modal') { (store as any).patch({ activeModal: 'inventory' }); c.updateInventoryPlacementPreview(); }
  else c.setWorldPickingSuspended(true);
  assert.equal(c.hammerPlacementActive, false); assert.equal(commands.length, 0);
});

test('an independent entity is created and started only on Enter, at the frozen adjusted pose', () => {
  const { c, commands } = harness(entitySlot());
  const manager: any = new ContraptionManager(new THREE.Scene(), null, null, null);
  c.contraptions = manager;
  c.handleLeftClick();
  assert.equal(manager.contraptions.length, 0); assert.equal(commands.length, 0);
  c.hammerPlacement.moveAlongAxis('y', 1.3);
  const pose = c.inventoryPlacementPreview;
  const expected = new THREE.Vector3(.5, .5, .5).applyQuaternion(pose.quaternion).add(pose.position);
  c.currentRaycast = { hit: false };
  c.handleKeyDown({ code: 'NumpadEnter', preventDefault() {} });
  assert.equal(manager.contraptions.length, 1);
  assert.ok(manager.contraptions[0].getBlockWorldCenter(manager.contraptions[0].blocks[0]).distanceTo(expected) < 1e-8);
  assert.deepEqual(commands.map(command => command.action), ['start-scripts']);
});

test('installation adjusts in the rotated component grid and preserves the chosen target until confirmation', () => {
  const { c, commands } = harness(entitySlot());
  const manager: any = new ContraptionManager(new THREE.Scene(), null, null, null);
  const target = manager.buildFromSlot(entitySlot(), new THREE.Vector3(4, 19, 6), null, false);
  target.stopAllNodeScripts();
  target.quaternion.setFromEuler(new THREE.Euler(.1, .4, -.2)); target.updateTransform();
  c.contraptions = manager;
  c.hoveredContraptionHit = { contraption: target, entityId: 'root',
    point: target.entityLocalToWorld('root', new THREE.Vector3(.5, .5, 1)),
    normal: new THREE.Vector3(0, 0, 1), worldNormal: new THREE.Vector3(0, 0, 1).applyQuaternion(target.quaternion) };
  c.handleLeftClick({ shiftKey: true });
  assert.equal(target.blocks.length, 1);
  const start = c.inventoryPlacementPreview.position.clone();
  c.hammerPlacement.moveAlongAxis('z', -1);
  assert.equal(c.hammerPlacement.confirm(), false, 'overlapping installation stays a preview');
  assert.equal(c.hammerPlacementActive, true); assert.equal(target.blocks.length, 1);
  c.hammerPlacement.moveAlongAxis('z', 1);
  c.hammerPlacement.moveAlongAxis('z', 1.4);
  assert.ok(c.inventoryPlacementPreview.position.distanceTo(start.add(new THREE.Vector3(0, 0, 1).applyQuaternion(target.quaternion))) < 1e-8);
  const expected = new THREE.Vector3(.5, .5, .5).applyQuaternion(c.inventoryPlacementPreview.quaternion).add(c.inventoryPlacementPreview.position);
  c.hoveredContraptionHit = null; c.currentRaycast = { hit: false };
  assert.equal(c.hammerPlacement.confirm(), true);
  assert.equal(manager.contraptions.length, 1); assert.equal(target.blocks.length, 2);
  assert.ok(target.getBlockWorldCenter(target.blocks[1]).distanceTo(expected) < 1e-8);
  assert.equal(commands.length, 0, 'component installation does not start scripts');
});

test('MICRO placement of a mixed Item keeps static voxels and entities in the same frame', () => {
  const terrain = blockSet(), entity = { ...entitySlot(), itemPosition: [3, 0, 0], itemRotation: [0, 0, 0, 1] };
  const { c, commands } = harness({ kind: 'item', name: 'Mixed', blockSet: terrain,
    entityList: [entity], blocks: [...terrain.blocks, ...entity.blocks] }, true);
  c.contraptions = new ContraptionManager(new THREE.Scene(), null, null, null);
  c.handleLeftClick(); c.hammerPlacement.moveAlongAxis('x', .125);
  const origin = c.inventoryPlacementPreview.position.clone();
  assert.equal(c.hammerPlacement.confirm(), true);
  while (c.bulkEditJob) c.processBulkEditFrame(64, Infinity);
  const voxels = commands.filter(command => command.action === 'place-micro');
  assert.equal(voxels.length, 512);
  assert.equal(Math.min(...voxels.map(command => command.micro[0])) / 8, origin.x);
  const built = c.contraptions.contraptions[0];
  assert.equal(built.blocks.length, 512, 'MICRO mode subdivides the authored entity geometry');
  assert.ok(built.getBlockWorldCenter(built.blocks[0]).distanceTo(origin.clone().add(new THREE.Vector3(3.0625, .0625, .0625))) < 1e-8);
});

test('STD adjustment keeps large geometry standard while MICRO enforces subdivision limits', () => {
  const slot = blockSet();
  slot.blocks = Array.from({ length: 129 }, (_, dx) => ({ ...slot.blocks[0], dx })); slot.blockCount = 129;
  const { c, commands } = harness(slot);
  c.handleLeftClick();
  const origin = c.inventoryPlacementPreview.position.clone();
  c.hammerPlacement.moveAlongAxis('x', .125);
  assert.ok(c.inventoryPlacementPreview.position.equals(origin), 'subcell motion cannot move a STD preview');
  c.hammerPlacement.moveAlongAxis('x', .7);
  assert.ok(c.inventoryPlacementPreview.position.equals(origin.add(new THREE.Vector3(1, 0, 0))));
  assert.equal(c.hammerPlacement.confirm(), true);
  assert.equal(commands.length, 129); assert.ok(commands.every(command => command.action === 'place-standard'));
  const micro = harness(slot, true);
  assert.equal(micro.c.handleLeftClick(), false);
  assert.equal(micro.c.hammerPlacementActive, false); assert.equal(micro.commands.length, 0);
});

for (const micro of [false, true]) for (const locked of [false, true]) for (const axis of ['x', 'y', 'z'] as const) test(`${axis.toUpperCase()} handle uses ${micro ? 'MICRO' : 'STD'} steps with ${locked ? 'locked crosshair' : 'free cursor'} input`, t => {
  const { c, commands } = harness(blockSet(), micro);
  const step = micro ? .125 : 1;
  c.isLocked = locked; c.pointerLockDesired = locked;
  c.yaw = 0; c.pitch = 0; c.mouseSensitivity = .002;
  let lookUpdates = 0;
  c.updateCameraRotation = () => { lookUpdates++; };
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  const listeners = new Map<string, (event: any) => void>();
  const body = {};
  globalThis.document = { body, pointerLockElement: locked ? body : null,
    addEventListener: (name: string, callback: any) => listeners.set(name, callback) } as any;
  globalThis.window = { addEventListener: (name: string, callback: any) => listeners.set(name, callback) } as any;
  t.after(() => { c.cancelHammerPlacement(false); globalThis.document = previousDocument; globalThis.window = previousWindow; setTorusViewCorrection(null); });
  const rect = { left: 30, top: 20, width: 1000, height: 700 };
  c.sceneRenderer = { scene: new THREE.Scene(), renderer: { domElement: { getBoundingClientRect: () => rect } } };
  c.camera = new THREE.PerspectiveCamera(60, rect.width / rect.height, .1, 1000);
  c.camera.position.set(9, 24, 13); c.camera.lookAt(4.5, 20.5, 6.5);
  setTorusViewCorrection(c.camera.position);
  c.handleLeftClick(); c.setupEventListeners(); c.setupPointerLock();
  const group = c.sceneRenderer.hammerPlacementGizmo as THREE.Group;
  const aimAtHandle = () => {
    const point = group.localToWorld(transformAxis(axis).multiplyScalar(.97));
    const view = transformViewCamera(c.camera);
    const frame = view.quaternion.clone().multiply(c.camera.quaternion.clone().invert());
    view.lookAt(bendPointForView(point.x, point.y, point.z));
    c.camera.quaternion.copy(frame.invert().multiply(view.quaternion));
  };
  assert.deepEqual([...new Set(group.children.map(child => child.userData.transformHandle))], ['move-x', 'move-y', 'move-z']);
  const origin = c.inventoryPlacementPreview.position.clone();
  if (locked) {
    listeners.get('mousemove')!({ movementX: 10, movementY: -5 });
    assert.equal(c.yaw, -.02); assert.equal(c.pitch, .01);
    assert.equal(lookUpdates, 1, 'mouse look remains available before dragging');
    assert.ok(c.inventoryPlacementPreview.position.equals(origin));
    aimAtHandle();
    c.updateInventoryPlacementPreview();
  }
  const camera = transformViewCamera(c.camera);
  const project = (p: THREE.Vector3) => transformScreenPoint(p, camera, rect.width, rect.height);
  const start = project(group.localToWorld(transformAxis(axis).multiplyScalar(.97)))
    .add(new THREE.Vector2(rect.left + rect.width / 2, rect.top + rect.height / 2));
  const vector = project(group.position.clone().add(transformAxis(axis))).sub(project(group.position));
  const event = (distance: number) => ({ button: 0, clientX: locked ? 9 : start.x + vector.x * distance,
    clientY: locked ? 11 : start.y + vector.y * distance,
    movementX: vector.x * distance, movementY: vector.y * distance, preventDefault() {}, stopPropagation() {} });
  listeners.get('mousedown')!({ ...event(0), target: { closest: () => null } });
  listeners.get('mousemove')!(event(.3));
  assert.ok(c.inventoryPlacementPreview.position.equals(origin), 'HUD clicks cannot grab axes');
  const looksBeforeDrag = lookUpdates;
  listeners.get('mousedown')!(event(0));
  assert.equal(c.hammerPlacement.isDragging, true, 'locked picking uses the crosshair instead of stale client coordinates');
  listeners.get('mousemove')!(event(1.4 * step));
  assert.ok(c.inventoryPlacementPreview.position.equals(origin.clone().add(transformAxis(axis).multiplyScalar(step))));
  listeners.get('mousemove')!(event((locked ? -3 : -1.6) * step));
  const expected = origin.clone().add(transformAxis(axis).multiplyScalar(-2 * step));
  assert.ok(c.inventoryPlacementPreview.position.equals(expected));
  assert.equal(lookUpdates, looksBeforeDrag, 'dragging moves the preview without turning the camera');
  listeners.get('mouseup')!({ button: 0 }); listeners.get('mousemove')!(event(.5));
  assert.ok(c.inventoryPlacementPreview.position.equals(expected));
  if (locked) {
    assert.equal(c.isLocked, true);
    assert.equal(lookUpdates, looksBeforeDrag + 1, 'mouse release restores normal look');
    aimAtHandle();
    listeners.get('mousedown')!(event(0));
    assert.equal(c.hammerPlacement.isDragging, true);
    (document as any).pointerLockElement = null;
    listeners.get('pointerlockchange')!({});
    assert.equal(c.hammerPlacement.isDragging, false, 'losing pointer lock ends the drag');
  }
  listeners.get('mousedown')!({ ...event(0), button: 2 });
  assert.equal(commands.length, 0); assert.equal(c.hammerPlacementActive, false);
  assert.equal(c.sceneRenderer.hammerPlacementGizmo, undefined); assert.equal(group.parent, null);
});
