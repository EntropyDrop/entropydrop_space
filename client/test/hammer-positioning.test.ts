import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

function makeController(kind = 'blockset') {
  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.HAMMER;
  controller.inventorySlots = [{
    kind, name: 'Micro cube', rootComponentId: 'root', blockCount: 1,
    blocks: [{ dx: 0, dy: 0, dz: 0, localX: 0, localY: 0, localZ: 0, size: 0.125, color: 0x48dbfb }],
  }];
  controller.selectedInventoryIndex = 0;
  controller.currentRaycast = {
    hit: true, kind: 'standard', hitPos: { x: 4, y: 5, z: -3 },
    entry: { x: 4.46, y: 6, z: -2.27 }, normal: { x: 0, y: 1, z: 0 },
  };
  controller.hoveredContraptionHit = null;
  controller.world = {};
  return controller;
}

function pressTab(controller: any, extra: Record<string, unknown> = {}) {
  let prevented = false;
  controller.handleKeyDown({ code: 'Tab', preventDefault() { prevented = true; }, ...extra });
  return prevented;
}

test('Hammer Tab switches the preview grid immediately and preserves the item and rotation', () => {
  const controller = makeController();
  const ui = new SpaceUiStore();
  (ui as any).patch({ controller });
  controller.ui = ui;
  controller.hammerRotationTurnsY = 1;
  const slot = controller.getActiveHammerInventoryItem();
  controller.updateInventoryPlacementPreview();
  assert.equal(controller.hammerMicroMode, false, 'standard positioning is the default');
  assert.deepEqual(controller.inventoryPlacementPreview.position.toArray(), [4, 6, -3]);

  assert.equal(pressTab(controller), true);
  assert.equal(controller.hammerMicroMode, true);
  assert.equal(ui.getSnapshot().hammerMicro, true, 'the visible badge updates on the same key press');
  assert.deepEqual(controller.inventoryPlacementPreview.position.toArray(), [4.375, 6, -2.375]);
  assert.equal(controller.getActiveHammerInventoryItem(), slot);
  assert.equal(controller.hammerRotationTurnsY, 1);
  assert.equal(controller.selectedInventoryIndex, 0);
  assert.equal(controller.activeInventoryCategory, 'item');

  pressTab(controller, { repeat: true });
  assert.equal(controller.hammerMicroMode, true, 'holding Tab must not cycle repeatedly');
  pressTab(controller);
  assert.equal(controller.hammerMicroMode, false);
  assert.equal(ui.getSnapshot().hammerMicro, false);
  assert.deepEqual(controller.inventoryPlacementPreview.position.toArray(), [4, 6, -3]);

  pressTab(controller, { target: { tagName: 'INPUT' } });
  assert.equal(controller.hammerMicroMode, false, 'typing in a field keeps normal Tab navigation');
});

for (const micro of [false, true]) {
  test(`Hammer ${micro ? 'micro' : 'standard'} positioning builds at the exact ghost origin`, () => {
    const controller = makeController();
    controller.hammerMicroMode = micro;
    controller.updateInventoryPlacementPreview();
    const origin = controller.inventoryPlacementPreview.position.clone();
    const actions: any[] = [];
    controller.performBasicAction = (action: any) => { actions.push(action); return { placed: 1 }; };
    controller.activateTool = () => {};
    assert.equal(controller.pasteInventorySlot(), true);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].action, 'place-micro');
    assert.deepEqual(actions[0].micro, origin.multiplyScalar(8).toArray());
  });
}

test('Hammer snaps entity terrain origins on either grid and samples support after horizontal snapping', () => {
  const controller = makeController('entity');
  const sampled: THREE.Vector3[] = [];
  controller.world = {
    raycast(origin: THREE.Vector3) {
      sampled.push(origin.clone());
      return { hit: true, distance: origin.y - 5.125 };
    },
  };
  for (const [micro, expected] of [[false, [4, 6, -2]], [true, [4.375, 5.125, -2.375]]] as const) {
    controller.hammerMicroMode = micro;
    sampled.length = 0;
    const pose = controller.getInventoryPlacementPose(controller.inventorySlots[0]);
    assert.deepEqual(pose.position.toArray(), expected);
    assert.equal(sampled[0].x, expected[0] + 0.0625);
    assert.equal(sampled[0].z, expected[2] + 0.0625);
    assert.ok(pose.position.y >= 5.125, 'coarse positioning cannot sink into micro terrain');
  }
});

test('Hammer installation switches grids in the rotated target component frame', () => {
  const controller = makeController('entity');
  const origin = new THREE.Vector3(10.13, 7.07, -2.11);
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, Math.PI / 6, -0.1));
  const target = {
    entityLocalToWorld(_nodeId: string, point: THREE.Vector3) { return point.clone().applyQuaternion(rotation).add(origin); },
    worldToEntityLocal(_nodeId: string, point: THREE.Vector3) { return point.clone().sub(origin).applyQuaternion(rotation.clone().invert()); },
    getEntityNodeWorldQuaternion() { return rotation.clone(); },
  };
  controller.hoveredContraptionHit = {
    point: target.entityLocalToWorld('arm', new THREE.Vector3(2.07, 1.2, -0.13)),
    worldNormal: new THREE.Vector3(0, 1, 0).applyQuaternion(rotation),
    normal: new THREE.Vector3(0, 1, 0), contraption: target, entityId: 'arm',
  };
  for (const [micro, expected] of [[false, [2, 2, 0]], [true, [2, 1.25, -0.25]]] as const) {
    controller.hammerMicroMode = micro;
    const pose = controller.getInventoryPlacementPose(controller.inventorySlots[0]);
    const local = target.worldToEntityLocal('arm', pose.position);
    assert.ok(local.distanceTo(new THREE.Vector3(...expected)) < 1e-8);
    assert.ok(pose.quaternion.angleTo(rotation) < 1e-8);
  }
});

test('Hammer hides the black target-cell wireframe on terrain and entities in either mode', () => {
  const controller = makeController();
  for (const micro of [false, true]) {
    controller.hammerMicroMode = micro;
    controller.hoveredContraptionHit = null;
    assert.equal(controller.getCursorHighlight(), null);
    controller.hoveredContraptionHit = { point: new THREE.Vector3(), kind: 'micro' };
    assert.equal(controller.getCursorHighlight(), null);
  }
  controller.hoveredContraptionHit = null;
  controller.activeTool = SpecialTool.SHOVEL;
  assert.ok(controller.getCursorHighlight(), 'other tools retain the target-cell outline');
});
