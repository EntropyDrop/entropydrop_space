import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';

function fixture(tool = SpecialTool.SHOVEL, micro = false) {
  const entity = new Contraption(1, [
    { localX: 0, localY: 0, localZ: 0, block: 1 },
    { localX: 2, localY: 1, localZ: 0, block: 1, size: micro ? 0.125 : 1 },
  ], new THREE.Vector3(0, 10, 0), new THREE.Scene(), {
    childEntities: [{ id: 'door', parentId: 'root', kind: 'child', pivot: [2, 1, 0], blockKeys: [['2', '1', '0']] }],
  });
  entity.scriptStatus = 'running';
  const point = entity.entityLocalToWorld('door', new THREE.Vector3(2.05, 1.05, 0.125));
  const eye = point.clone().add(new THREE.Vector3(0, 0, 3));
  const controller: any = Object.create(PlayerController.prototype);
  Object.assign(controller, { camera: new THREE.PerspectiveCamera(), activeTool: tool,
    contraptions: { contraptions: [entity] }, ui: {},
    performAimRaycast: () => ({ kind: 'entity', entityHit: { contraption: entity, entityId: 'door',
      kind: micro ? 'micro' : 'standard', block: entity.blocks[1], point, distance: 8 }, worldHit: null }),
  });
  Object.defineProperty(controller, 'cameraSession', { value: { getEyePosition: () => eye } });
  return { controller, entity, point, eye };
}

for (const tool of new Set(Object.values(SpecialTool))) {
  for (const micro of [false, true]) {
    test(`${tool} clicks a running child ${micro ? 'micro' : 'standard'} voxel without editing or stopping`, () => {
      const { controller, entity, point } = fixture(tool, micro);
      controller.handleLeftClick();
      const click = entity.pendingClickedBlocks[0];
      assert.equal(click.nodeId, 'door');
      assert.equal(click.kind, micro ? 'micro' : 'standard');
      assert.equal(click.size, micro ? 0.125 : 1);
      assert.deepEqual(click.position, [2, 1, 0]);
      assert.deepEqual(click.point, point.toArray());
      assert.equal(entity.scriptStatus, 'running');
      assert.equal(entity.blocks.length, 2);
    });
  }
}

test('real decoration raycasts include nested component transforms and respect closer surfaces', () => {
  const { controller, entity, point, eye } = fixture(SpecialTool.MODELING);
  entity.setComponentDecorations('door', [{ id: 'handle', position: [2, 1, 0.7], scale: [0.5, 0.5, 0.5] }]);
  entity.getEntityNode('door')!.group.rotation.y = 0.3;
  entity.getEntityNode('door')!.group.updateMatrixWorld(true);
  const center = entity.entityLocalToWorld('door', new THREE.Vector3(2, 1, 0.7));
  eye.copy(center).add(new THREE.Vector3(0, 0, 3));
  assert.equal(controller.tryClickRunningEntity(), true);
  const click = entity.pendingClickedBlocks[0];
  assert.equal(click.kind, 'decoration');
  assert.equal(click.nodeId, 'door');
  assert.equal(click.decorationId, 'handle');
  assert.deepEqual(click.position, [2, 1, 0.7]);
  assert.equal(click.size, null);
  const local = entity.worldToEntityLocal('door', new THREE.Vector3().fromArray(click.point));
  assert.ok(local.distanceTo(new THREE.Vector3().fromArray(click.localPoint)) < 1e-8);

  controller.performAimRaycast = () => ({ kind: 'world', worldHit: { distance: 0.1 }, entityHit: null });
  assert.equal(controller.tryClickRunningEntity(), false, 'terrain blocks a click through to decoration');
  controller.performAimRaycast = () => ({ kind: 'entity', worldHit: null, entityHit: {
    contraption: entity, entityId: 'root', block: entity.blocks[0], point, kind: 'standard', distance: 0.1 } });
  controller.tryClickRunningEntity();
  assert.equal(entity.pendingClickedBlocks[1].kind, 'standard', 'a closer voxel wins');
  entity.stopAllNodeScripts();
  assert.equal(controller.tryClickRunningEntity(), false);
});

test('all tools can click runtime decorations even when no physical voxel is under the crosshair', () => {
  const { controller, entity, eye } = fixture();
  entity.editRuntimeDecoration('root', 'panel', { position: [4, 2, 0], scale: [1, 1, 1] });
  const center = entity.entityLocalToWorld('root', new THREE.Vector3(4, 2, 0));
  eye.copy(center).add(new THREE.Vector3(0, 0, 3));
  controller.performAimRaycast = () => ({ kind: null, entityHit: null, worldHit: null });
  const tools = [...new Set(Object.values(SpecialTool))];
  controller.modeling = { deactivate() {} };
  for (const tool of tools) {
    controller.activeTool = tool;
    controller.handleLeftClick();
  }
  assert.equal(entity.pendingClickedBlocks.length, tools.length);
  for (const entry of entity.pendingClickedBlocks) {
    assert.equal(entry.kind, 'decoration');
    assert.equal(entry.nodeId, 'root');
    assert.equal(entry.decorationId, 'panel');
    assert.deepEqual(entry.position, [4, 2, 0]);
  }
  assert.deepEqual(entity.getComponentDecorations('root'), [], 'runtime-created decorations are selectable without authored geometry');
});

test('UI consumes clicks first, suspended picking ignores clicks, and server replicas route input once', async () => {
  const { controller, entity } = fixture(SpecialTool.WRENCH);
  controller.worldPickingSuspended = true;
  controller.handleLeftClick();
  assert.equal(entity.pendingClickedBlocks.length, 0);
  controller.worldPickingSuspended = false;
  controller.ui.tryToggleEntityPlaybackAtPointer = () => true;
  controller.handleLeftClick();
  assert.equal(entity.pendingClickedBlocks.length, 0);
  controller.ui = {};
  entity.serverManaged = true;
  entity.serverDesiredRunState = 'running';
  let routed: any;
  controller.setServerEntityClickHandler(async (target: Contraption, click: unknown) => { assert.equal(target, entity); routed = click; });
  controller.handleLeftClick();
  assert.equal(routed.nodeId, 'door');
  assert.equal(entity.pendingClickedBlocks.length, 0, 'wait for authoritative delivery, even on the executor browser');
  assert.equal(entity.scriptStatus, 'running');
});
