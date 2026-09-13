import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';

/**
 * The shovel cursor keeps a 1x1x1 standard-cell outline over a 0.125 microblock because
 * the shovel removes every microblock in that standard cell.
 */

function makeController(tool) {
  const controller = Object.create(PlayerController.prototype);
  controller.activeTool = tool;
  controller.currentRaycast = { hit: false };
  return controller;
}

test('shovel focus on a microblock keeps a 1x1x1 standard-cell outline', () => {
  const controller = makeController(SpecialTool.SHOVEL);
  // Microcell (18,3,10) belongs to standard cell (2,0,1).
  controller.currentRaycast = { hit: true, kind: 'micro', microPos: { x: 18, y: 3, z: 10 }, size: 0.125 };
  const cursor = controller.getCursorHighlight();
  assert.deepEqual(cursor.pos, { x: 2, y: 0, z: 1 });
  assert.equal(cursor.size, 1, 'the outline must remain 1x1x1');
});

test('shovel focus on a standard block keeps a 1x1x1 outline', () => {
  const controller = makeController(SpecialTool.SHOVEL);
  controller.currentRaycast = { hit: true, kind: 'standard', hitPos: { x: 3, y: 4, z: 5 }, size: 1 };
  const cursor = controller.getCursorHighlight();
  assert.deepEqual(cursor.pos, { x: 3, y: 4, z: 5 });
  assert.equal(cursor.size, 1);
});

test('other tools keep a 0.2 outline when focused on a microblock', () => {
  const controller = makeController(SpecialTool.BRUSH);
  controller.currentRaycast = {
    hit: true,
    kind: 'micro',
    microPos: { x: 18, y: 3, z: 10 },
    hitPos: { x: 2.4, y: 0.6, z: 1.4 },
    size: 0.125
  };
  const cursor = controller.getCursorHighlight();
  assert.deepEqual(cursor.pos, { x: 2.4, y: 0.6, z: 1.4 });
  assert.equal(cursor.size, 0.125);
});

test('no hit produces no cursor', () => {
  const controller = makeController(SpecialTool.SHOVEL);
  controller.currentRaycast = { hit: false };
  assert.equal(controller.getCursorHighlight(), null);
});

test('a pointer action immediately re-picks and publishes the updated micro cursor', () => {
  const controller = makeController(SpecialTool.SPOON);
  const calls = [];
  controller.sceneRenderer = {
    setCursor(pos, size) {
      calls.push(['cursor', pos, size]);
    },
    setMicroCarvePreview(preview) {
      calls.push(['micro-preview', preview]);
    }
  };
  controller.updateAimRaycast = () => {
    controller.currentRaycast = {
      hit: true,
      kind: 'micro',
      microPos: { x: 13, y: 4, z: 8 },
      hitPos: { x: 2.6, y: 0.8, z: 1.6 },
      size: 0.125
    };
    controller.microCarvePreview = { cellOrigin: { x: 2, y: 0, z: 1 } };
    calls.push(['raycast']);
  };

  controller.refreshAimAfterPointerAction();

  assert.deepEqual(calls, [
    ['raycast'],
    ['cursor', { x: 2.6, y: 0.8, z: 1.6 }, 0.125],
    ['micro-preview', { cellOrigin: { x: 2, y: 0, z: 1 } }]
  ]);
});

test('focusing on a block of a large entity displays small wireframe on the pointed block', () => {
  const controller = makeController(SpecialTool.HAMMER);
  const dummyContraption = {
    rootComponentId: 'root',
    quaternion: new THREE.Quaternion(),
    getBlockWorldCenter(block) {
      return new THREE.Vector3(block.localX + 0.5, block.localY + 0.5, block.localZ + 0.5);
    }
  };
  controller.hoveredContraptionHit = {
    contraption: dummyContraption,
    entityId: 'root',
    block: { localX: 10, localY: 5, localZ: 2, size: 1 },
    cell: { x: 10, y: 5, z: 2 },
    kind: 'standard'
  };
  const cursor = controller.getCursorHighlight();
  assert.ok(cursor);
  assert.equal(cursor.size, 1);
  assert.deepEqual(cursor.center, new THREE.Vector3(10.5, 5.5, 2.5));
  assert.deepEqual(cursor.pos, { x: 10, y: 5, z: 2 });
  assert.equal(cursor.isEntity, true);
});

test('shovel focus on an entity microblock keeps a 1x1x1 standard cell outline', () => {
  const controller = makeController(SpecialTool.SHOVEL);
  const dummyContraption = {
    rootComponentId: 'root',
    quaternion: new THREE.Quaternion(),
    entityLocalToWorld(nodeId, vec) {
      return vec.clone();
    }
  };
  controller.hoveredContraptionHit = {
    contraption: dummyContraption,
    entityId: 'root',
    block: { localX: 2.25, localY: 0.375, localZ: 1.125, size: 0.125 },
    cell: { x: 2, y: 0, z: 1 },
    kind: 'micro'
  };
  const cursor = controller.getCursorHighlight();
  assert.ok(cursor);
  assert.equal(cursor.size, 1, 'shovel must keep 1x1x1 outline on entity microblock');
  assert.deepEqual(cursor.center, new THREE.Vector3(2.5, 0.5, 1.5));
  assert.deepEqual(cursor.pos, { x: 2, y: 0, z: 1 });
});

test('other tools on an entity microblock display 0.125 outline', () => {
  const controller = makeController(SpecialTool.BRUSH);
  const dummyContraption = {
    rootComponentId: 'root',
    quaternion: new THREE.Quaternion(),
    getBlockWorldCenter(block) {
      return new THREE.Vector3(block.localX + 0.0625, block.localY + 0.0625, block.localZ + 0.0625);
    }
  };
  controller.hoveredContraptionHit = {
    contraption: dummyContraption,
    entityId: 'root',
    block: { localX: 2.25, localY: 0.375, localZ: 1.125, size: 0.125 },
    kind: 'micro'
  };
  const cursor = controller.getCursorHighlight();
  assert.ok(cursor);
  assert.equal(cursor.size, 0.125);
  assert.deepEqual(cursor.center, new THREE.Vector3(2.3125, 0.4375, 1.1875));
});

test('entity focus wireframe inherits entity rotation quaternion', () => {
  const controller = makeController(SpecialTool.HAMMER);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);
  const dummyContraption = {
    rootComponentId: 'root',
    quaternion: q,
    getBlockWorldCenter(block) {
      return new THREE.Vector3(5, 5, 5);
    }
  };
  controller.hoveredContraptionHit = {
    contraption: dummyContraption,
    entityId: 'root',
    block: { localX: 0, localY: 0, localZ: 0, size: 1 },
    kind: 'standard'
  };
  const cursor = controller.getCursorHighlight();
  assert.ok(cursor);
  assert.deepEqual(cursor.quaternion, q);
});

test('SceneRenderer setCursor positions and rotates cursorMesh', () => {
  const cursorMesh = {
    position: new THREE.Vector3(),
    scale: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    visible: false
  };
  const renderer = {
    cursorMesh,
    setCursor: SceneRenderer.prototype.setCursor
  };
  const center = new THREE.Vector3(10.5, 5.5, 2.5);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  renderer.setCursor({ x: 10, y: 5, z: 2 }, 1, q, center);

  assert.equal(cursorMesh.visible, true);
  assert.deepEqual(cursorMesh.position, center);
  assert.deepEqual(cursorMesh.quaternion, q);
  assert.equal(cursorMesh.scale.x, 1);
});
