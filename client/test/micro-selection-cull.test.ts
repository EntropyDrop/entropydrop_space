import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';

test('micro selection hologram renders unified outer bounding box like standard selection', () => {
  const renderer = Object.create(SceneRenderer.prototype);
  renderer.scene = new THREE.Scene();
  renderer.setupSelectionHologram();

  // Create a solid 2x2x2 cube of 8 microcells (coords 0..1 in x, y, z)
  const microCells: Array<{ x: number; y: number; z: number }> = [];
  for (let x = 0; x < 2; x++) {
    for (let y = 0; y < 2; y++) {
      for (let z = 0; z < 2; z++) {
        microCells.push({ x, y, z });
      }
    }
  }

  renderer.updateSelectionHologram(null, null, microCells);

  // Micro selection now uses unified selectionGroup (same as standard selection)
  assert.ok(renderer.selectionGroup.visible);
  assert.equal(renderer.selectionMicroCellsGroup.visible, false);

  // Bounds should span 2 microcells = 0.25m in each dimension
  assert.ok(Math.abs(renderer.selectionGroup.scale.x - 0.25) < 1e-4);
  assert.ok(Math.abs(renderer.selectionGroup.scale.y - 0.25) < 1e-4);
  assert.ok(Math.abs(renderer.selectionGroup.scale.z - 0.25) < 1e-4);

  // Center should be (0.125, 0.125, 0.125) = (0.125, 0.125, 0.125)
  assert.ok(Math.abs(renderer.selectionGroup.position.x - 0.125) < 1e-4);
  assert.ok(Math.abs(renderer.selectionGroup.position.y - 0.125) < 1e-4);
  assert.ok(Math.abs(renderer.selectionGroup.position.z - 0.125) < 1e-4);
});

test('entity block selection highlight renders single outer bounding box wireframe per node', () => {
  const contraption = Object.create(Contraption.prototype);
  contraption.entityNodes = new Map();
  const rootNode = { id: 'root', group: new THREE.Group(), pivotLocal: new THREE.Vector3(0, 0, 0) };
  contraption.entityNodes.set('root', rootNode);
  contraption.subtreeHighlightBoxes = [];
  contraption.clearSubtreeHighlight = Contraption.prototype.clearSubtreeHighlight.bind(contraption);

  // 2 adjacent microblocks: (0, 0, 0) and (0.125, 0, 0)
  const blocks = [
    { entityId: 'root', localX: 0, localY: 0, localZ: 0, size: 0.125 },
    { entityId: 'root', localX: 0.125, localY: 0, localZ: 0, size: 0.125 }
  ];

  contraption.highlightBlocks(blocks);

  assert.equal(contraption.subtreeHighlightBoxes.length, 1, 'should combine into 1 highlight box per node');
  const lineSegments = contraption.subtreeHighlightBoxes[0].group;
  const linePos = lineSegments.geometry.attributes.position;

  // Single outer bounding box wireframe has exactly 12 edges (24 vertices)
  assert.equal(linePos.count, 24, 'outer bounding box should have exactly 12 edges (24 vertices)');
});

test('non-box micro shape hologram renders culled micro-voxel mesh in selectionMicroCellsGroup', () => {
  const renderer = Object.create(SceneRenderer.prototype);
  renderer.scene = new THREE.Scene();
  renderer.setupSelectionHologram();

  // Cylinder/sphere microcells: e.g. 5 points
  const microCells = [
    { x: 1, y: 1, z: 0 },
    { x: 0, y: 1, z: 1 },
    { x: 1, y: 1, z: 1 },
    { x: 2, y: 1, z: 1 },
    { x: 1, y: 1, z: 2 }
  ];

  renderer.updateSelectionHologram(null, null, microCells, true);

  // When isMicroShape is true, selectionMicroCellsGroup is used
  assert.equal(renderer.selectionGroup.visible, false);
  assert.equal(renderer.selectionMicroCellsGroup.visible, true);
  assert.equal(renderer.selectionMicroCellsGroup.children.length, 2, 'should have fill mesh and line segments');
});
