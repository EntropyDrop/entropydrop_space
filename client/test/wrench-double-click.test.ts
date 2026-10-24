import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';

function fixture(t: test.TestContext) {
  const scene = new THREE.Scene();
  const entity = new Contraption(1, [
    { localX: 0, localY: 0, localZ: 0, size: 1, block: 1, entityId: 'base' },
    { localX: 2, localY: 0, localZ: 0, size: 1, block: 1, entityId: 'wheel' },
  ], new THREE.Vector3(0, 2, 0), scene, { rootComponentId: 'base', childEntities: [
    { id: 'wheel', parentId: 'base', pivot: [2.5, .5, .5] },
  ] });
  const other = new Contraption(2, [{ localX: 0, localY: 0, localZ: 0, size: 1, block: 1, entityId: 'other' }],
    new THREE.Vector3(4, 2, 0), scene, { rootComponentId: 'other' });
  entity.stopAllNodeScripts(); other.stopAllNodeScripts();
  const camera = new THREE.PerspectiveCamera(60, 1, .1, 1000);
  camera.position.set(1, 4, 7); camera.lookAt(entity.position); camera.updateMatrixWorld(true);
  const controller: any = Object.assign(Object.create(PlayerController.prototype), {
    _activeTool: SpecialTool.WRENCH, isLocked: true, pointerLockDesired: true,
    contraptions: { contraptions: [entity, other] }, camera, keys: {}, yaw: 0, pitch: 0, mouseSensitivity: .002,
    physics: { getEyePosition: () => camera.position.clone() },
    sceneRenderer: { setWrenchPivotGizmo() {}, clearWrenchPivotGizmo() {}, setWrenchTether() {} },
    ui: { showToast() {}, refresh() {} }, sound: { playWrenchClick() {} },
    updateAimRaycast() {}, refreshAimAfterPointerAction() {}, updateCameraRotation() {},
  });
  let scriptClicks = 0;
  controller.tryClickRunningEntity = () => { scriptClicks++; return false; };
  const actions: string[] = [];
  controller.performBasicAction = (command: any) => {
    actions.push(command.action);
    return PlayerController.prototype.performBasicAction.call(controller, command);
  };
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  const listeners = new Map<string, (event: any) => void>();
  const body = {};
  globalThis.document = { body, pointerLockElement: body,
    addEventListener: (name: string, handler: any) => listeners.set(name, handler) } as any;
  globalThis.window = { ...previousWindow,
    addEventListener: (name: string, handler: any) => listeners.set(name, handler) } as any;
  controller.setupEventListeners();
  t.after(() => {
    controller.releaseWrenchGizmoDrag(); controller.releaseWrenchGrab();
    globalThis.document = previousDocument; globalThis.window = previousWindow;
    entity.dispose(); other.dispose();
  });
  const down = (time: number, target = entity, nodeId = target.rootComponentId) => {
    controller.hoveredContraption = target;
    controller.hoveredContraptionHit = { contraption: target, entityId: nodeId, point: target.getEntityNodeWorldPosition(nodeId) };
    listeners.get('mousedown')!({ button: 0, timeStamp: time, clientX: 100, clientY: 100,
      preventDefault() {}, stopPropagation() {} });
  };
  const up = (time: number) => listeners.get('mouseup')!({ button: 0, timeStamp: time });
  return { controller, entity, other, actions, listeners, down, up, scriptClicks: () => scriptClicks };
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('two quick component taps start and stop the whole entity, and second mouseup preserves the result', async t => {
  const f = fixture(t);
  f.down(1000, f.entity, 'wheel'); f.up(1050);
  assert.equal(f.entity.isPhysicsSimulationEnabled(), false, 'one tap only grabs and releases');
  f.down(1150, f.entity, 'base'); f.up(1200); await settle();
  assert.equal(f.entity.isPhysicsSimulationEnabled(), true);
  assert.equal(f.controller.isEntityRunning(f.entity), true);
  assert.equal(f.controller.wrenchGrab, null);
  assert.deepEqual(f.actions, ['start-scripts']);
  assert.equal(f.scriptClicks(), 1, 'the second tap is consumed before script-click dispatch');
  f.down(2000, f.entity, 'wheel'); f.up(2050);
  f.down(2150, f.entity, 'wheel'); f.up(2200); await settle();
  assert.equal(f.entity.isPhysicsSimulationEnabled(), false);
  assert.equal(f.entity.scriptStatus, 'stopped');
  assert.deepEqual(f.actions, ['start-scripts', 'stop-scripts']);
});

for (const gesture of ['drag', 'hold', 'timeout', 'different entity', 'gizmo', 'blur', 'UI', 'suspend'] as const) {
  test(`${gesture} is excluded from Wrench double-click playback`, async t => {
    const f = fixture(t);
    if (gesture === 'gizmo') {
      f.controller.updateWrenchPivotGizmo({ contraption: f.entity, entityId: 'base' });
      f.controller.hoveredWrenchGizmoHandle = { handleKey: 'move-x', kind: 'move', axis: 'x' };
    }
    f.down(1000);
    if (gesture === 'drag') f.listeners.get('mousemove')!({ movementX: 12, movementY: 0 });
    f.up(gesture === 'hold' ? 1400 : 1050);
    if (gesture === 'blur') f.listeners.get('blur')!({});
    if (gesture === 'UI') {
      f.controller.ui.tryOpenEntityContextMenuAtPointer = () => true;
      f.down(1100); f.up(1120);
      f.controller.ui.tryOpenEntityContextMenuAtPointer = () => false;
    }
    if (gesture === 'suspend') {
      f.controller.setWorldPickingSuspended(true); f.controller.setWorldPickingSuspended(false);
    }
    f.down(gesture === 'timeout' ? 1500 : gesture === 'hold' ? 1500 : 1200,
      gesture === 'different entity' ? f.other : f.entity);
    f.up(1550); await settle();
    assert.equal(f.actions.includes('start-scripts'), false);
    assert.equal(f.entity.isPhysicsSimulationEnabled(), false);
  });
}

test('double-click playback respects server control permissions', async t => {
  const f = fixture(t);
  Object.assign(f.entity, { serverManaged: true, serverCanControl: false, serverDesiredRunState: 'running' });
  f.controller.serverEntityRunStateHandler = async () => assert.fail('occupied entity must not receive a request');
  f.down(1000); f.up(1050); f.down(1150); f.up(1200); await settle();
  assert.equal(f.entity.serverDesiredRunState, 'running');
  assert.deepEqual(f.actions, []);
});

test('a pending server toggle blocks repeated grabs and playback requests', async t => {
  const f = fixture(t);
  Object.assign(f.entity, { serverManaged: true, serverCanControl: true, serverDesiredRunState: 'running' });
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const requests: string[] = [];
  f.controller.serverEntityRunStateHandler = async (_: unknown, state: string) => { requests.push(state); await pending; };
  f.down(1000); f.up(1050); f.down(1150); f.up(1200);
  f.down(1300); f.up(1350); f.down(1400); f.up(1450);
  assert.deepEqual(requests, ['stopped']);
  assert.equal(f.controller.wrenchGrab == null, true);
  finish(); await settle();
});
