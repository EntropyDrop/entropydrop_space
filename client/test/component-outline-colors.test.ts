import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { COMPONENT_OUTLINE_COLORS } from '@entropydrop/space-engine/render/ComponentOutlineColors.ts';
import { rangePreviewFrame } from '../src/engine/controls/SelectionGeometry.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';

test('component range previews, focused cells and confirmed boxes agree on depth color, then reset for world selections', () => {
  const entity = new Contraption(1, ['chassis', 'arm', 'hand'].map((entityId, index) => ({
    localX: index, localY: 0, localZ: 0, block: 1, entityId
  })), new THREE.Vector3(0, 10, 0), new THREE.Scene(), {
    rootComponentId: 'chassis', childEntities: [
      { id: 'arm', parentId: 'chassis', pivot: [1, 0, 0] },
      { id: 'hand', parentId: 'arm', pivot: [2, 0, 0] }
    ]
  });
  const renderer = Object.create(SceneRenderer.prototype) as SceneRenderer;
  renderer.scene = new THREE.Scene();
  renderer.setupBoxSelectionPreview();
  renderer.setupSelectionHologram();
  renderer.setupFocusBlockGuide();
  const colorOf = (mesh: THREE.Mesh) => (mesh.material as THREE.MeshStandardMaterial).color.getHex();
  try {
    for (const [nodeId, depth] of [['arm', 1], ['hand', 2]] as const) {
      const frame = rangePreviewFrame({ contraption: entity, nodeId })!;
      const point = { x: depth, y: 0, z: 0 };
      const bounds = { minX: depth, maxX: depth, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
      assert.equal(frame.color, depth % 2 === 0 ? 0xffffff : 0x000000);
      renderer.setBoxSelectionPreview(point, point, false, frame);
      renderer.updateSelectionHologram(bounds, null, null, false, frame);
      renderer.setFocusBlockGuide(point, true, 1, null, frame.color);
      for (const mesh of [renderer.boxSelectionEdges, renderer.selectionWireframe, renderer.focusBlockGuide]) {
        assert.equal(colorOf(mesh), frame.color);
        assert.equal(colorOf(mesh.children[0] as THREE.Mesh), frame.color, 'the faint pass uses the same depth color');
      }
      renderer.setBoxSelectionPreview(point, point);
      renderer.updateSelectionHologram(bounds);
      renderer.setFocusBlockGuide(point);
      for (const mesh of [renderer.boxSelectionEdges, renderer.selectionWireframe, renderer.focusBlockGuide]) {
        assert.equal(colorOf(mesh), COMPONENT_OUTLINE_COLORS[0], 'world guides must not inherit the last component color');
      }
    }
  } finally {
    entity.dispose();
    for (const mesh of [renderer.boxSelectionEdges, renderer.selectionWireframe, renderer.focusBlockGuide]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
});
