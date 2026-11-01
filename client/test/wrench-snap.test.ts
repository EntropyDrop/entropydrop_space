import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { captureWrenchSnap, findWrenchSnap, translateWrenchEntity } from '../src/engine/controls/WrenchSnap.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

function fixture(t: test.TestContext) {
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null);
  const create = (x: number, blocks = [0], size = 1) => {
    const entity = new Contraption(manager.nextId++, blocks.map(localX => ({
      localX, localY: 0, localZ: 0, size, block: 1, entityId: 'root'
    })), new THREE.Vector3(x, 0, 0), manager.scene);
    entity.stopAllNodeScripts(); manager.registerContraption(entity);
    return entity;
  };
  const target = create(0), source = create(1.2);
  const messages: string[] = [];
  let saves = 0;
  manager.saveEntitiesToStorage = () => { saves++; return true; };
  const controller: any = Object.assign(Object.create(PlayerController.prototype), {
    _activeTool: SpecialTool.WRENCH, contraptions: manager,
    ui: { showToast: (message: string) => messages.push(message), refresh() {},
      notifyContraptionRemoved() {}, notifyContraptionStructureChanged() {} },
    sceneRenderer: { setWrenchTether() {}, clearWrenchPivotGizmo() {} },
    clearSelection() {}, camera: new THREE.PerspectiveCamera(), yaw: 0, pitch: 0,
    physics: { update() {} },
  });
  t.after(() => { for (const entity of manager.contraptions) entity.dispose(); });
  const snap = () => {
    const result = findWrenchSnap(source, manager.contraptions)!;
    assert.ok(result);
    translateWrenchEntity(source, result.offset);
    controller.wrenchSnapTarget = captureWrenchSnap(source, result.target, result.nodeId);
  };
  return { source, target, manager, controller, create, snap, messages, saves: () => saves };
}

test('Wrench snaps real faces, including rotated micro voxels, without changing orientation', t => {
  const f = fixture(t);
  const result = findWrenchSnap(f.source, f.manager.contraptions)!;
  assert.equal(result.target, f.target);
  assert.ok(result.offset.distanceTo(new THREE.Vector3(-.2, 0, 0)) < 1e-7);
  f.source.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);
  f.target.quaternion.copy(f.source.quaternion);
  f.source.position.copy(f.target.position).add(new THREE.Vector3(1.2, 0, 0).applyQuaternion(f.target.quaternion));
  for (const entity of [f.source, f.target]) entity.updateTransform();
  const rotated = findWrenchSnap(f.source, f.manager.contraptions)!;
  assert.ok(rotated.offset.distanceTo(new THREE.Vector3(-.2, 0, 0).applyQuaternion(f.target.quaternion)) < 1e-7);
  const tinyTarget = f.create(10, [0], .125), tinySource = f.create(10.2, [0], .125);
  const tiny = findWrenchSnap(tinySource, [tinySource, tinyTarget])!;
  assert.ok(Math.abs(tiny.offset.x + .075) < 1e-7);
});

test('snap ignores empty space, running, hosted, read-only, held, and occupied targets', t => {
  const f = fixture(t);
  for (const fields of [
    { scriptStatus: 'running' }, { serverManaged: true, serverCanEdit: false },
    { serverManaged: true, serverCanEdit: true, serverCanControl: false },
    { serverExecutionMode: 'hosted' }, { isWrenchGrabbed: true },
    { physicsSimulationEnabled: true }
  ]) {
    const before = Object.fromEntries(Object.keys(fields).map(key => [key, (f.target as any)[key]]));
    Object.assign(f.target, fields);
    assert.equal(findWrenchSnap(f.source, [f.source, f.target]), null);
    Object.assign(f.target, before);
  }
  const hollow = f.create(10, [0, 4]), middle = f.create(12);
  assert.equal(findWrenchSnap(middle, [hollow, middle]), null);
  f.source.position.y += 2; f.source.updateTransform();
  assert.equal(findWrenchSnap(f.source, [f.source, f.target]), null);
});

test('snapping ends free dragging and remains locked until explicitly detached', t => {
  const f = fixture(t);
  f.source.isWrenchGrabbed = true; f.source.setPhysicsSimulationEnabled(true);
  f.controller.wrenchGrab = { contraption: f.source, active: true, bodyId: 'root' };
  assert.equal(f.controller.updateWrenchSnap(f.source), true);
  const snappedPosition = f.source.position.clone();
  for (let i = 0; i < 20; i++) {
    assert.equal(f.controller.updateWrenchSnap(f.source, new THREE.Vector3(.2, 0, 0)), true);
    assert.ok(f.source.position.distanceTo(snappedPosition) < 1e-7);
  }
  assert.equal(f.source.isPhysicsSimulationEnabled(), false);
  assert.equal(f.controller.updateWrenchSnap(f.source, new THREE.Vector3(2, 0, 0)), true);
  assert.ok(f.source.position.distanceTo(snappedPosition) < 1e-7);
  assert.equal(f.controller.wrenchGrab, null);
  f.controller.releaseWrenchGrab();
  assert.equal(f.source.isWrenchGrabbed, false);
  assert.equal(f.source.isPhysicsSimulationEnabled(), false);
  assert.equal(f.controller.getWrenchSnapTarget()?.target, f.target);
  assert.ok(f.saves() > 0);
  f.controller.hoveredContraption = f.source;
  assert.equal(f.controller.startWrenchGrab(), false, 'body clicks cannot select or grab the locked part');
  assert.equal(f.controller.detachWrenchSnappedEntity(), true);
  assert.equal(f.controller.getWrenchSnapTarget(), null);
  assert.equal(f.controller.updateWrenchSnap(f.source), false, 'detaching lets the next drag leave without immediately reattaching');
  translateWrenchEntity(f.source, new THREE.Vector3(0, 2, 0));
  assert.equal(f.controller.updateWrenchSnap(f.source), false);
  translateWrenchEntity(f.source, new THREE.Vector3(0, -2, 0));
  assert.equal(f.controller.updateWrenchSnap(f.source), true, 'the mount attracts again after leaving its capture area');
  f.snap();
  f.target.setPhysicsSimulationEnabled(true);
  assert.equal(f.controller.getWrenchSnapTarget(), null);
  f.target.setPhysicsSimulationEnabled(false);
  f.source.position.x += 1; f.source.updateTransform();
  assert.equal(f.controller.getWrenchSnapTarget(), null);
});

test('point-grab simulation snaps and aiming elsewhere cannot move the locked part', t => {
  const f = fixture(t);
  f.controller.camera.position.set(1.7, .5, 4);
  f.controller.camera.lookAt(f.source.position);
  f.controller.hoveredContraption = f.source;
  f.controller.hoveredContraptionHit = { contraption: f.source, entityId: 'root', point: f.source.position.clone() };
  const requested = f.source.position.clone();
  f.controller.getWrenchTargetPosition = () => requested.clone();
  assert.equal(f.controller.startWrenchGrab(), true);
  for (let i = 0; i < 10; i++) f.controller.updateSimulation(.05);
  assert.equal(f.controller.getWrenchSnapTarget()?.target?.id, f.target.id);
  assert.ok(Math.abs(f.source.position.x - 1.5) < 1e-7);
  assert.equal(f.controller.wrenchGrab, null);
  requested.x += 2;
  f.controller.updateSimulation(.05);
  assert.equal(f.controller.getWrenchSnapTarget()?.target, f.target);
  assert.ok(Math.abs(f.source.position.x - 1.5) < 1e-7);
  assert.equal(f.source.isPhysicsSimulationEnabled(), false);
  f.controller.releaseWrenchGrab();
});

test('locked XYZ adjustments use the target grid and reject penetration', t => {
  const f = fixture(t); f.snap();
  const start = f.source.position.clone();
  assert.equal(f.controller.nudgeWrenchSnappedEntity('x', -1), false, 'cannot step inside the target');
  assert.equal(f.controller.nudgeWrenchSnappedEntity('y', 1), true);
  assert.ok(f.source.position.distanceTo(start.clone().add(new THREE.Vector3(0, 1, 0))) < 1e-8);
  assert.equal(f.controller.nudgeWrenchSnappedEntity('y', -1), true);
  assert.ok(f.source.position.distanceTo(start) < 1e-8);
  assert.equal(f.controller.getWrenchSnapTarget()?.target, f.target);
  f.controller.updateWrenchPivotGizmo({ contraption: f.target, entityId: 'root' });
  assert.equal(f.controller.wrenchPivotTarget.contraption, f.source, 'hovering another body cannot change the locked XYZ frame');
});

test('locked gizmo rounds motion to micro grid steps in a rotated target frame', t => {
  const f = fixture(t);
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);
  f.target.quaternion.copy(rotation); f.target.updateTransform();
  f.source.position.copy(f.target.position).add(new THREE.Vector3(1.2, 0, 0).applyQuaternion(rotation));
  f.source.quaternion.copy(rotation); f.source.updateTransform();
  // A micro component uses 0.125 m refinement even beside a standard block.
  f.source.blocks[0].size = .125;
  f.snap();
  f.controller.updateWrenchPivotGizmo(null);
  const start = f.source.position.clone();
  f.controller.wrenchScreenVector = () => new THREE.Vector2(100, 0);
  assert.equal(f.controller.startWrenchGizmoDrag({ kind: 'rotate', axis: 'x', handleKey: 'rotate-x' }), false);
  assert.equal(f.controller.startWrenchGizmoDrag({ kind: 'move', axis: 'z', handleKey: 'move-z' }), true);
  f.controller.updateWrenchGizmoDrag({ clientX: 5, clientY: 0 });
  assert.ok(f.source.position.distanceTo(start) < 1e-8, 'less than half a cell does not move');
  f.controller.updateWrenchGizmoDrag({ clientX: 10, clientY: 0 });
  assert.ok(f.source.position.distanceTo(start.clone().add(new THREE.Vector3(0, 0, .125).applyQuaternion(rotation))) < 1e-8);
  f.controller.updateWrenchGizmoDrag({ clientX: 25, clientY: 0 });
  assert.ok(f.source.position.distanceTo(start.clone().add(new THREE.Vector3(0, 0, .25).applyQuaternion(rotation))) < 1e-8);
  assert.equal(f.controller.releaseWrenchGizmoDrag(), true);
  assert.equal(f.source.isWrenchGrabbed, false);
  assert.equal(f.source.isPhysicsSimulationEnabled(), false);
  assert.equal(f.controller.getWrenchSnapTarget()?.target, f.target);
});

test('a pending remote merge cannot be submitted twice and removes the source only after acknowledgement', async t => {
  const f = fixture(t); f.snap(); f.manager.entityPersistenceMode = 'remote';
  let acknowledge!: () => void;
  f.controller.serverEntityMergeHandler = () => new Promise<void>(resolve => { acknowledge = resolve; });
  const pending = f.controller.mergeWrenchSnappedEntity(f.source);
  assert.equal(f.controller.wrenchMergeBusy, true);
  assert.equal(f.manager.contraptions.length, 2);
  assert.equal(await f.controller.mergeWrenchSnappedEntity(f.source), false);
  assert.equal(await f.controller.performEntityMenuAction(f.target, 'start'), false);
  acknowledge();
  assert.equal(await pending, true);
  assert.deepEqual(f.manager.contraptions, [f.target]);
});

test('Merge preserves source geometry, authored pivot, hierarchy, scripts and decorations as a target component', async t => {
  const f = fixture(t);
  f.manager.removeContraption(f.source);
  const source = new Contraption(10, [
    { localX: 0, localY: 0, localZ: 0, block: 1, entityId: 'root' },
    { localX: 2, localY: 0, localZ: 0, size: .125, block: 1, color: 0xff0000, entityId: 'arm' }
  ], new THREE.Vector3(1.2, 0, 0), f.manager.scene, {
    rootComponentId: 'root', rootPivotOverride: [.25, .5, .5], localCenter: [.25, .5, .5],
    childEntities: [{ id: 'arm', parentId: 'root', bodyType: 'dynamic', mass: 4 }],
    decorations: [{ id: 'panel', position: [.5, 1, 0], color: 0x123456 }],
    constraints: [{ id: 'joint', bodyA: 'root', bodyB: 'arm', type: 'hinge' }]
  });
  source.setNodeScript('root', 'const arm = self.child("arm");');
  source.stopAllNodeScripts(); f.manager.registerContraption(source);
  const found = findWrenchSnap(source, f.manager.contraptions)!;
  assert.ok(found); translateWrenchEntity(source, found.offset);
  f.controller.wrenchSnapTarget = captureWrenchSnap(source, f.target, 'root');
  const positions = source.blocks.map(block => source.getBlockWorldCenter(block));
  assert.equal(await f.controller.mergeWrenchSnappedEntity(source), true);
  assert.deepEqual(f.manager.contraptions, [f.target]);
  assert.equal(f.target.getEntityNode('root_2')?.parentId, 'root');
  assert.equal(f.target.getEntityNode('arm')?.parentId, 'root_2');
  assert.equal(f.target.getNodeBodyType('root_2'), 'kinematic');
  assert.equal(f.target.getRigidBody('arm')!.mass, 4);
  assert.equal(f.target.getComponentDecorations('root_2')[0].id, 'panel');
  assert.match(f.target.getNodeScript('root_2'), /self.child/);
  f.target.blocks.slice(1).forEach((block, index) => {
    assert.ok(f.target.getBlockWorldCenter(block).distanceTo(positions[index]) < 1e-7, `block ${index} must retain its snapped pose`);
  });
  assert.equal(f.target.isPhysicsSimulationEnabled(), false);
  assert.equal(f.controller.getWrenchSnapTarget(), null);
});

test('failed remote merge rolls back installed components and keeps both entities', async t => {
  const f = fixture(t); f.snap();
  f.manager.entityPersistenceMode = 'remote';
  f.controller.serverEntityMergeHandler = async (source: Contraption, target: Contraption) => {
    assert.equal(source, f.source); assert.equal(target, f.target);
    assert.equal(target.blocks.length, 2);
    assert.equal(f.controller.wrenchMergeBusy, true);
    throw new Error('offline');
  };
  assert.equal(await f.controller.mergeWrenchSnappedEntity(f.source), false);
  assert.equal(f.manager.contraptions.length, 2);
  assert.equal(f.target.blocks.length, 1);
  assert.equal(f.target.entityNodes.size, 1);
  assert.equal(f.controller.wrenchMergeBusy, false);
  assert.equal(f.source.isWrenchGrabbed, false);
  assert.match(f.messages.at(-1)!, /both entities were kept/);
});

test('HUD captures the snapped source and consumes pointer-lock Merge clicks before tool actions', t => {
  const f = fixture(t); f.snap();
  const store = new SpaceUiStore();
  (store as any).patch({ controller: f.controller, contraptions: f.manager, pointerLocked: true });
  assert.equal(store.getSnapshot().wrenchSnap?.source, f.source);
  let merged: unknown;
  f.controller.mergeWrenchSnappedEntity = async (source: unknown) => { merged = source; return true; };
  const button = { dataset: { entityMergeId: f.source.publicId }, disabled: false };
  const original = globalThis.document;
  const originalWindow = globalThis.window;
  globalThis.window = { innerWidth: 1024, innerHeight: 768 } as any;
  globalThis.document = { elementFromPoint: (x: number, y: number) => {
    assert.equal(x, window.innerWidth / 2); assert.equal(y, window.innerHeight / 2);
    return { closest: (selector: string) => selector === '[data-entity-merge-id]' ? button : null };
  } } as any;
  t.after(() => { globalThis.document = original; globalThis.window = originalWindow; });
  assert.equal(store.tryMergeEntityAtPointer({ clientX: 1, clientY: 2 }), true);
  assert.equal(merged, f.source);
  const start = f.source.position.clone();
  Object.assign(button.dataset, { snapAxis: 'y', snapSteps: '1' });
  assert.equal(store.tryMergeEntityAtPointer({ clientX: 1, clientY: 2 }), true);
  assert.equal(f.source.position.y, start.y + 1, 'the locked crosshair routes grid buttons before world clicks');
  Object.assign(button.dataset, { snapAxis: undefined, snapSteps: undefined, snapDetach: 'true' });
  assert.equal(store.tryMergeEntityAtPointer({ clientX: 1, clientY: 2 }), true);
  assert.equal(f.controller.getWrenchSnapTarget(), null);
  f.controller.ui = { tryMergeEntityAtPointer: () => true };
  f.controller.startWrenchGrab = () => assert.fail('HUD click must not start another drag');
  assert.equal(f.controller.handleLeftClick(), true);
});
