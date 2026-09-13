import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';

/**
 * Spoon-focus 8x8x8 preview tests for updateMicroCarvePreview coordinate conversion.
 */

function makeController(tool) {
  const controller = Object.create(PlayerController.prototype);
  controller.activeTool = tool;
  controller.hoveredContraptionHit = null;
  controller.currentRaycast = { hit: false };
  controller.contraptions = { hasChildSelection: () => false };
  controller.microCarvePreview = null;
  return controller;
}

test('tools other than the spoon produce no preview', () => {
  const controller = makeController(SpecialTool.BRUSH);
  controller.currentRaycast = { hit: true, kind: 'standard', hitPos: { x: 3, y: 4, z: 5 } };
  controller.updateMicroCarvePreview();
  assert.equal(controller.microCarvePreview, null);
});

test('spoon over a world standard block previews its 8x8x8 grid', () => {
  const controller = makeController(SpecialTool.SPOON);
  controller.currentRaycast = { hit: true, kind: 'standard', hitPos: { x: 3, y: 4, z: 5 } };
  controller.updateMicroCarvePreview();
  assert.deepEqual(controller.microCarvePreview.cellOrigin.toArray(), [3, 4, 5]);
  assert.equal(controller.microCarvePreview.microCenter, null);
});

test('spoon over a world microblock highlights it within the parent standard cell', () => {
  const controller = makeController(SpecialTool.SPOON);
  // Microcell (18,3,10) belongs to standard cell (2,0,1).
  controller.currentRaycast = { hit: true, kind: 'micro', microPos: { x: 18, y: 3, z: 10 } };
  controller.updateMicroCarvePreview();
  assert.deepEqual(controller.microCarvePreview.cellOrigin.toArray(), [2, 0, 1]);
  assert.deepEqual(
    controller.microCarvePreview.microCenter.toArray(),
    [(18 + 0.5) * 0.125, (3 + 0.5) * 0.125, (10 + 0.5) * 0.125]
  );
});

test('spoon preview over an entity microblock follows the entity transform', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    77,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: 0.25, localY: 0.125, localZ: 0.125, size: 0.125, block: BlockTypes.COLOR_BLOCK }
    ],
    new THREE.Vector3(10, 20, 30),
    scene,
    { rootComponentId: 'root' }
  ) as any;
  const controller = makeController(SpecialTool.SPOON);
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'root',
    cell: { x: 0, y: 0, z: 0 },
    kind: 'micro',
    block: contraption.blocks[1]
  };
  controller.updateMicroCarvePreview();

  const preview = controller.microCarvePreview;
  assert.ok(preview, 'an entity microblock hit should produce a preview');
  // Standard-cell corner is entity-local (0,0,0), or world (10,20,30).
  assert.ok(Math.abs(preview.cellOrigin.x - 10) < 1e-6);
  assert.ok(Math.abs(preview.cellOrigin.y - 20) < 1e-6);
  assert.ok(Math.abs(preview.cellOrigin.z - 30) < 1e-6);
  // Microcell center is local (0.3125,0.1875,0.1875) plus entity origin (10,20,30).
  assert.ok(Math.abs(preview.microCenter.x - 10.3125) < 1e-6);
  assert.ok(Math.abs(preview.microCenter.y - 20.1875) < 1e-6);
  assert.ok(Math.abs(preview.microCenter.z - 30.1875) < 1e-6);
});

test('spoon over an entity standard block shows the grid without a microcell highlight', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    78,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(0, 0, 0),
    scene,
    { rootComponentId: 'root' }
  ) as any;
  const controller = makeController(SpecialTool.SPOON);
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'root',
    cell: { x: 0, y: 0, z: 0 },
    kind: 'standard',
    block: contraption.blocks[0]
  };
  controller.updateMicroCarvePreview();
  assert.deepEqual(controller.microCarvePreview.cellOrigin.toArray(), [0, 0, 0]);
  assert.equal(controller.microCarvePreview.microCenter, null);
});

test('spoon over a tilted entity inherits the entity quaternion orientation', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    79,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(5, 5, 5),
    scene,
    { rootComponentId: 'root' }
  ) as any;
  const tiltedEuler = new THREE.Euler(0.5, 0.25, -0.75);
  const rootNode = contraption.entityNodes.get('root');
  rootNode.group.quaternion.setFromEuler(tiltedEuler);
  rootNode.group.updateMatrixWorld(true);

  const controller = makeController(SpecialTool.SPOON);
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'root',
    cell: { x: 0, y: 0, z: 0 },
    kind: 'standard',
    block: contraption.blocks[0]
  };
  controller.updateMicroCarvePreview();

  const preview = controller.microCarvePreview;
  assert.ok(preview, 'preview should be created for tilted entity');
  assert.ok(preview.quaternion, 'quaternion should be included');
  const expectedQuat = new THREE.Quaternion().setFromEuler(tiltedEuler);
  assert.ok(Math.abs(preview.quaternion.dot(expectedQuat)) > 1 - 1e-6, 'quaternion should match the entity rotation');
});

test('no hit produces no preview', () => {
  const controller = makeController(SpecialTool.SPOON);
  controller.currentRaycast = { hit: false };
  controller.updateMicroCarvePreview();
  assert.equal(controller.microCarvePreview, null);
});

test('selector hover shows no focus wireframe before entity selection', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    1,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  const controller = makeController(SpecialTool.SELECTOR);
  controller.selectorRange = null; // Nothing selected.
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'root',
    cell: { x: 0, y: 0, z: 0 }
  };
  controller.updateMicroCarvePreview();
  assert.equal(controller.focusBlockPreview, null, 'an unselected entity should show no focus wireframe');
  assert.equal(controller.microCarvePreview, null);
});

test('selector shows no focus guide when not pointing at an entity', () => {
  const controller = makeController(SpecialTool.SELECTOR);
  controller.hoveredContraptionHit = null;
  controller.currentRaycast = { hit: true, kind: 'standard', hitPos: { x: 3, y: 4, z: 5 } };
  controller.updateMicroCarvePreview();
  assert.equal(controller.microCarvePreview, null);
  assert.equal(controller.focusBlockPreview, null, 'world hits use the existing black cursor, not a cyan guide');
});

test('selector hover shows a focus wireframe after selecting that entity', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    1,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  const controller = makeController(SpecialTool.SELECTOR);
  controller.selectorRange = { contraption, nodeId: 'root', pointA: null, pointB: null };
  controller.hoveredContraptionHit = { contraption, entityId: 'root', cell: { x: 0, y: 0, z: 0 } };
  controller.updateMicroCarvePreview();
  assert.ok(controller.focusBlockPreview, 'hover should show the wireframe after selection');
  assert.equal(controller.focusBlockPreview.center.y, 10.5, 'standard target centers the guide on the 1 m cell');
  assert.equal(controller.focusBlockPreview.cellSize, 1);
});

test('selector focus preview inherits a tilted entity orientation', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    1,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  contraption.quaternion.setFromEuler(new THREE.Euler(0.35, 0.2, -0.4));
  contraption.rootGroup.updateMatrixWorld(true);
  const controller = makeController(SpecialTool.SELECTOR);
  controller.selectorRange = { contraption, nodeId: 'root', pointA: null, pointB: null };
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'root',
    cell: { x: 0, y: 0, z: 0 }
  };

  controller.updateMicroCarvePreview();

  const expectedCenter = contraption.getBlockWorldCenter(contraption.blocks[0]);
  assert.ok(
    controller.focusBlockPreview.center.distanceTo(expectedCenter) < 1e-12,
    'focus guide center should rotate with the tilted block'
  );
  assert.ok(
    Math.abs(controller.focusBlockPreview.quaternion.dot(contraption.quaternion)) > 1 - 1e-12,
    'focus guide orientation should match the tilted root'
  );
});

test('selector hover on entity B shows no guide while entity A is selected', () => {
  const scene = new THREE.Scene();
  const entityA = new Contraption(
    1,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  const entityB = new Contraption(
    2,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(10, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  const controller = makeController(SpecialTool.SELECTOR);
  controller.selectorRange = { contraption: entityA, nodeId: 'root', pointA: null, pointB: null };
  controller.hoveredContraptionHit = { contraption: entityB, entityId: 'root', cell: { x: 0, y: 0, z: 0 } };
  controller.updateMicroCarvePreview();
  assert.equal(controller.focusBlockPreview, null, 'an unselected entity should show no focus wireframe');
});

test('focus wireframe is inactive before point 1 and active after point 1', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    1,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  const controller = makeController(SpecialTool.SELECTOR);
  controller.selectorLevel = { contraption, nodeId: 'root' };
  controller.selectorRange = { contraption, nodeId: 'root', pointA: null, pointB: null };
  controller.hoveredContraptionHit = { contraption, entityId: 'root', cell: { x: 0, y: 0, z: 0 } };

  // Waiting for point 1.
  controller.updateMicroCarvePreview();
  assert.equal(controller.focusBlockPreview.active, false, 'waiting for point 1 should use the inactive state');

  // Point 1 is set.
  controller.selectorRange.pointA = new THREE.Vector3(0.5, 10.5, 0.5);
  controller.updateMicroCarvePreview();
  assert.equal(controller.focusBlockPreview.active, true, 'point 1 should use the active state');
});

test('boxSelectionPreview follows the crosshair after point 1 is set', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    1,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  const controller = makeController(SpecialTool.SELECTOR);
  controller.selectorLevel = { contraption, nodeId: 'root' };
  // Anchor the range point in node-local space and convert it back for preview.
  const p1World = new THREE.Vector3(0.5, 10.5, 0.5);
  const p1Local = contraption.entityNodes.get('root').group.worldToLocal(p1World.clone());
  controller.selectorRange = { contraption, nodeId: 'root', pointA: p1Local, pointB: null };

  // Entity hover previews in the node's voxel grid and carries its live frame.
  controller.hoveredContraptionHit = { contraption, entityId: 'root', cell: { x: 0, y: 0, z: 0 }, point: new THREE.Vector3(1.5, 11.5, 1.5) };
  controller.updateMicroCarvePreview();
  assert.ok(controller.boxSelectionPreview, 'point 1 should enable a live preview');
  assert.deepEqual(controller.boxSelectionPreview.pointA.toArray(), [0.5, 0.5, 0.5], 'anchor should use entity-local voxel coordinates');
  assert.deepEqual(controller.boxSelectionPreview.cursor.toArray(), [1.5, 1.5, 1.5], 'cursor should use the same voxel grid');
  assert.equal(controller.boxSelectionPreview.frame.object, contraption.entityNodes.get('root').group);
  assert.deepEqual(controller.boxSelectionPreview.frame.bounds.min.toArray(), [0, 0, 0]);
  assert.deepEqual(controller.boxSelectionPreview.frame.bounds.max.toArray(), [1, 1, 1]);

  // World hits are projected into that same tilted/local frame.
  controller.hoveredContraptionHit = null;
  controller.currentRaycast = { hit: true, kind: 'standard', hitPos: { x: 3, y: 4, z: 5 } };
  controller.updateMicroCarvePreview();
  assert.ok(controller.boxSelectionPreview, 'world hits should also show a live preview');
  assert.deepEqual(controller.boxSelectionPreview.pointA.toArray(), [0.5, 0.5, 0.5], 'the anchor should stay on the original block');
  assert.deepEqual(controller.boxSelectionPreview.cursor.toArray(), [3, -6, 5]);
});

test('no point 1 or no hit produces no box preview', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    1,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(0, 10, 0),
    scene,
    { rootComponentId: 'root' }
  );
  const controller = makeController(SpecialTool.SELECTOR);
  controller.selectorLevel = { contraption, nodeId: 'root' };
  controller.selectorRange = { contraption, nodeId: 'root', pointA: null, pointB: null };
  controller.hoveredContraptionHit = { contraption, entityId: 'root', cell: { x: 0, y: 0, z: 0 }, point: new THREE.Vector3(1, 1, 1) };
  controller.updateMicroCarvePreview();
  assert.equal(controller.boxSelectionPreview, null, 'waiting for point 1 should show no preview');

  controller.selectorRange.pointA = new THREE.Vector3(0, 0, 0);
  controller.selectorRange.pointB = new THREE.Vector3(1, 1, 1); // Selection complete.
  controller.updateMicroCarvePreview();
  assert.equal(controller.boxSelectionPreview, null, 'completed selection should show no preview');
});

test('world two-point preview follows the crosshair after cornerA until confirmation', () => {
  const controller = makeController(SpecialTool.SELECTOR);
  controller.contraptions.selectionCornerA = { x: 2, y: 3, z: 4 };
  controller.contraptions.selectionCornerB = null;
  controller.currentRaycast = { hit: true, kind: 'standard', hitPos: { x: 6.7, y: 7.2, z: 8.9 } };
  controller.updateMicroCarvePreview();
  assert.ok(controller.boxSelectionPreview, 'cornerA should enable live preview');
  assert.deepEqual(controller.boxSelectionPreview.pointA, { x: 2, y: 3, z: 4 }, 'preview should start at cornerA');
  assert.deepEqual(controller.boxSelectionPreview.cursor, { x: 6, y: 7, z: 8 }, 'preview should follow the crosshair with cell rounding');

  // Moving the crosshair updates the preview.
  controller.currentRaycast = { hit: true, kind: 'standard', hitPos: { x: 1.2, y: 3.4, z: 5.6 } };
  controller.updateMicroCarvePreview();
  assert.deepEqual(controller.boxSelectionPreview.cursor, { x: 1, y: 3, z: 5 }, 'preview should update with the crosshair');

  // Pointing at the sky removes the preview.
  controller.currentRaycast = { hit: false };
  controller.updateMicroCarvePreview();
  assert.equal(controller.boxSelectionPreview, null, 'no hit should show no preview');
});

test('world two-point preview follows an entity hover hit', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    99,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(10, 20, 30),
    scene,
    { rootComponentId: 'root' }
  ) as any;
  const controller = makeController(SpecialTool.SELECTOR);
  controller.contraptions.selectionCornerA = { x: 0, y: 0, z: 0 };
  controller.contraptions.selectionCornerB = null;
  controller.hoveredContraptionHit = {
    contraption,
    entityId: 'root',
    cell: { x: 0, y: 0, z: 0 },
    point: new THREE.Vector3(10.8, 20.8, 30.8)
  };
  controller.updateMicroCarvePreview();
  assert.ok(controller.boxSelectionPreview, 'entity hover should preview during a world box');
  assert.deepEqual(controller.boxSelectionPreview.pointA, { x: 0, y: 0, z: 0 });
  assert.deepEqual(controller.boxSelectionPreview.cursor, { x: 10, y: 20, z: 30 }, 'cursor should round to the entity hit cell');
});

test('world two-point selection shows no preview before cornerA or after cornerB', () => {
  const controller = makeController(SpecialTool.SELECTOR);
  controller.currentRaycast = { hit: true, kind: 'standard', hitPos: { x: 3, y: 4, z: 5 } };

  // Point 1 is unset.
  controller.contraptions.selectionCornerA = null;
  controller.contraptions.selectionCornerB = null;
  controller.updateMicroCarvePreview();
  assert.equal(controller.boxSelectionPreview, null, 'waiting for point 1 should show no preview');

  // The second click has confirmed the selection.
  controller.contraptions.selectionCornerA = { x: 1, y: 2, z: 3 };
  controller.contraptions.selectionCornerB = { x: 5, y: 6, z: 7 };
  controller.updateMicroCarvePreview();
  assert.equal(controller.boxSelectionPreview, null, 'the hologram replaces live preview after confirmation');
});
