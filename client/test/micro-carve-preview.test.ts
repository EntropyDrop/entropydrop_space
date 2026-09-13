import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';

/**
 * The 8x8x8 spoon preview shows only surface grid lines, never the internal 7x7x7 grid.
 */

function makeRendererWithPreview() {
  const renderer = Object.create(SceneRenderer.prototype);
  renderer.scene = { add() {} };
  renderer.setupMicroCarvePreview();
  return renderer;
}

test('the micro-carve preview contains only surface line segments', () => {
  const renderer = makeRendererWithPreview();
  const gridLines = renderer.microCarveGroup.children[0];
  assert.ok(gridLines.isLineSegments);
  const pos = gridLines.geometry.attributes.position.array;

  // 3 axes × 2 surface orientations × 9 grid lines × 2 endpoints × 3 coordinates.
  assert.equal(pos.length, 3 * 2 * 9 * 2 * 2 * 3, 'the preview should contain 108 segments');

  const nearSurface = value => Math.abs(value) < 1e-9 || Math.abs(value - 1) < 1e-9;
  for (let i = 0; i < pos.length; i += 6) {
    const endpoints = [pos[i], pos[i + 1], pos[i + 2], pos[i + 3], pos[i + 4], pos[i + 5]];
    assert.ok(
      endpoints.some(nearSurface),
      `segment ${endpoints.join(',')} must have at least one endpoint on surface 0 or 1`
    );
  }
});

test('micro-carve preview positioning and visibility are correct', () => {
  const renderer = makeRendererWithPreview();

  renderer.setMicroCarvePreview(null);
  assert.equal(renderer.microCarveGroup.visible, false);

  renderer.setMicroCarvePreview({
    cellOrigin: new THREE.Vector3(2, 3, 4),
    microCenter: new THREE.Vector3(2.3, 3.1, 4.7)
  });
  assert.equal(renderer.microCarveGroup.visible, true);
  assert.deepEqual(renderer.microCarveGroup.position.toArray(), [2, 3, 4]);
  assert.equal(renderer.microCarveFocusCell.visible, true);
  assert.deepEqual(renderer.microCarveFocusCell.position.toArray(), [2.3, 3.1, 4.7]);

  renderer.setMicroCarvePreview({
    cellOrigin: new THREE.Vector3(2, 3, 4),
    microCenter: null
  });
  assert.equal(renderer.microCarveGroup.visible, true);
  assert.equal(renderer.microCarveFocusCell.visible, false, 'hide the highlight when no microcell is focused');
});

test('micro-carve preview applies entity quaternion orientation', () => {
  const renderer = makeRendererWithPreview();
  const tilted = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.5, -0.2));

  renderer.setMicroCarvePreview({
    cellOrigin: new THREE.Vector3(2, 3, 4),
    microCenter: new THREE.Vector3(2.3, 3.1, 4.7),
    quaternion: tilted
  });

  assert.equal(renderer.microCarveGroup.visible, true);
  assert.ok(Math.abs(renderer.microCarveGroup.quaternion.dot(tilted)) > 1 - 1e-12);
  assert.equal(renderer.microCarveFocusCell.visible, true);
  assert.ok(Math.abs(renderer.microCarveFocusCell.quaternion.dot(tilted)) > 1 - 1e-12);

  renderer.setMicroCarvePreview(null);
  assert.equal(renderer.microCarveGroup.visible, false);
  assert.equal(renderer.microCarveFocusCell.visible, false);
});

test('focusBlockGuide registers and positions a 1x1x1 X-ray wireframe', () => {
  const renderer = makeRendererWithPreview();
  renderer.setupFocusBlockGuide();
  renderer.setFocusBlockGuide({ x: 2.5, y: 3.5, z: 4.5 });
  assert.ok(renderer.focusBlockGuide, 'setup should create the wireframe');
  assert.equal(renderer.focusBlockGuide.visible, true);
  assert.deepEqual(renderer.focusBlockGuide.position.toArray(), [2.5, 3.5, 4.5], 'place the wireframe at the focused cell center');
  assert.deepEqual(renderer.focusBlockGuide.scale.toArray(), [1, 1, 1], 'standard cells keep the full 1.0 m guide');
  assert.equal((renderer.focusBlockGuide.material as any).depthTest, false, 'disable depth testing for X-ray visibility');

  // A 0.125 m micro target shrinks the guide to hug the micro block.
  renderer.setFocusBlockGuide({ x: 2.6, y: 3.5, z: 4.6 }, false, 0.2);
  assert.deepEqual(renderer.focusBlockGuide.scale.toArray(), [0.2, 0.2, 0.2], 'micro targets scale the guide down');
  assert.deepEqual(renderer.focusBlockGuide.position.toArray(), [2.6, 3.5, 4.6]);

  renderer.clearFocusBlockGuide();
  assert.equal(renderer.focusBlockGuide.visible, false);
});

test('focusBlockGuide applies and clears entity orientation', () => {
  const renderer: any = Object.create(SceneRenderer.prototype);
  renderer.scene = { add() {} };
  renderer.setupFocusBlockGuide();
  const tilted = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0.2, -0.3));

  renderer.setFocusBlockGuide({ x: 2.5, y: 3.5, z: 4.5 }, false, 1, tilted);
  assert.ok(Math.abs(renderer.focusBlockGuide.quaternion.dot(tilted)) > 1 - 1e-12);

  renderer.setFocusBlockGuide({ x: 2.5, y: 3.5, z: 4.5 });
  assert.deepEqual(renderer.focusBlockGuide.quaternion.toArray(), [0, 0, 0, 1], 'world guides reset stale entity tilt');
});

test('setBoxSelectionPreview creates a live block-aligned translucent box', () => {
  const renderer = makeRendererWithPreview();
  renderer.setupBoxSelectionPreview();
  renderer.setBoxSelectionPreview(
    { x: 1, y: 2, z: 3 },
    { x: 5, y: 6, z: 7 }
  );
  assert.ok(renderer.boxSelectionGroup.visible);
  assert.deepEqual(renderer.boxSelectionGroup.position.toArray(), [3.5, 4.5, 5.5], 'center should use cell centers and span+1');
  assert.deepEqual(renderer.boxSelectionFill.scale.toArray(), [5, 5, 5], 'box size should be span plus one cell');
  assert.equal((renderer.boxSelectionFill.material as any).depthTest, false, 'translucent fill should remain visible through geometry');
  assert.ok(
    renderer.boxSelectionFill.geometry.attributes.position.count > 24,
    'large selection faces need intermediate vertices for the torus shader to curve'
  );
  assert.ok(
    renderer.boxSelectionEdges.geometry.attributes.position.count / 2 > 12,
    'large selection outlines need segmented edges instead of twelve straight chords'
  );
  renderer.clearBoxSelectionPreview();
  assert.equal(renderer.boxSelectionGroup.visible, false);
});

test('setBoxSelectionPreview rounds fractional corners to confirmed-box geometry', () => {
  const renderer = makeRendererWithPreview();
  renderer.setupBoxSelectionPreview();
  // A surface hit such as 0.8 rounds to cell boundaries and covers both endpoint cells.
  renderer.setBoxSelectionPreview(
    { x: 0.8, y: 10.9, z: 30.1 },
    { x: 2.4, y: 12.6, z: 31.7 }
  );
  assert.deepEqual(renderer.boxSelectionGroup.position.toArray(), [1.5, 11.5, 31], 'center should include both endpoint cells');
  assert.deepEqual(renderer.boxSelectionFill.scale.toArray(), [3, 3, 2], 'size should equal span plus one');
});

test('entity box selection preview follows a tilted node frame', () => {
  const renderer: any = Object.create(SceneRenderer.prototype);
  renderer.scene = { add() {} };
  renderer.setupBoxSelectionPreview();
  const frame = new THREE.Group();
  frame.position.set(10, 20, 30);
  frame.quaternion.setFromEuler(new THREE.Euler(0, 0, Math.PI / 2));
  frame.updateMatrixWorld(true);

  renderer.setBoxSelectionPreview(
    { x: 0.1, y: 0.1, z: 0.1 },
    { x: 0.9, y: 0.9, z: 0.9 },
    false,
    { object: frame, pivot: new THREE.Vector3(0.5, 0.5, 0.5) }
  );

  assert.ok(Math.abs(renderer.boxSelectionGroup.quaternion.dot(frame.quaternion)) > 1 - 1e-12);
  assert.ok(renderer.boxSelectionGroup.position.distanceTo(frame.position) < 1e-12);
  assert.deepEqual(renderer.boxSelectionFill.scale.toArray(), [1, 1, 1]);

  renderer.setBoxSelectionPreview({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
  assert.deepEqual(renderer.boxSelectionGroup.quaternion.toArray(), [0, 0, 0, 1], 'world previews reset stale entity tilt');
});

test('entity box selection preview is clamped to real component bounds', () => {
  const renderer: any = Object.create(SceneRenderer.prototype);
  renderer.scene = { add() {} };
  renderer.setupBoxSelectionPreview();
  const frame = new THREE.Group();
  frame.position.set(10, 20, 30);
  frame.updateMatrixWorld(true);
  const entityFrame = {
    object: frame,
    pivot: new THREE.Vector3(1, 0.5, 0.5),
    bounds: {
      min: new THREE.Vector3(0, 0, 0),
      max: new THREE.Vector3(2, 1, 1)
    }
  };

  renderer.setBoxSelectionPreview(
    { x: 0.1, y: 0.1, z: 0.1 },
    { x: 100, y: 100, z: 100 },
    false,
    entityFrame
  );

  assert.deepEqual(renderer.boxSelectionFill.scale.toArray(), [2, 1, 1], 'cyan range stops at the component bounds');
  assert.ok(renderer.boxSelectionGroup.position.distanceTo(frame.position) < 1e-12);

  renderer.setBoxSelectionPreview(
    { x: 0.01, y: 0.01, z: 0.01 },
    { x: 100, y: 100, z: 100 },
    true,
    entityFrame
  );
  assert.deepEqual(renderer.boxSelectionFill.scale.toArray(), [2, 1, 1], 'micro preview is clamped to the same physical bounds');
});

test('confirmed selection hologram is torus-segmented and remains visible over terrain', () => {
  const renderer = makeRendererWithPreview();
  renderer.setupSelectionHologram();
  renderer.updateSelectionHologram({ minX: 10, maxX: 17, minY: 4, maxY: 7, minZ: 20, maxZ: 25 });

  assert.ok(renderer.selectionGroup.visible);
  assert.ok(renderer.selectionFill.geometry.attributes.position.count > 24);
  assert.ok(renderer.selectionWireframe.geometry.attributes.position.count / 2 > 12);
  assert.equal(renderer.selectionFill.material.depthTest, false);
  assert.equal(renderer.selectionWireframe.material.depthTest, false);
});

test('selection tessellation is capped and reused while its span stays unchanged', () => {
  const renderer = makeRendererWithPreview();
  renderer.setupBoxSelectionPreview();
  renderer.setBoxSelectionPreview({ x: 0, y: 0, z: 0 }, { x: 1000, y: 1000, z: 1000 });
  const geometry = renderer.boxSelectionFill.geometry;
  assert.ok(geometry.attributes.position.count < 30000, 'extreme boxes should respect the tessellation safety cap');

  renderer.setBoxSelectionPreview({ x: 1, y: 2, z: 3 }, { x: 1001, y: 1002, z: 1003 });
  assert.equal(renderer.boxSelectionFill.geometry, geometry, 'moving an equal-sized preview should reuse geometry');
});
