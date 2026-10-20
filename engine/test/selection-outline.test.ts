import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { hookSceneMaterials } from '../src/torus/TorusWorld.ts';
import { SelectionOutlineGeometry, createSelectionOutline, createSelectionOutlineMaterial, updateSelectionOutlineGeometry } from '../src/render/SelectionOutline.ts';

test('visible and occluded outline passes share resized geometry and the same world transform', () => {
  const outline = createSelectionOutline(new SelectionOutlineGeometry(), createSelectionOutlineMaterial(0xff9f43));
  const occluded = outline.children[0] as THREE.Mesh;
  let disposed = 0;
  outline.geometry.addEventListener('dispose', () => disposed++);

  updateSelectionOutlineGeometry(outline, 3, 2, 0.125);
  assert.equal(disposed, 1, 'resizing releases the previous shared geometry once');
  assert.equal(occluded.geometry, outline.geometry);
  const resized = outline.geometry;
  updateSelectionOutlineGeometry(outline, 3, 2, 0.125);
  assert.equal(outline.geometry, resized, 'an unchanged size reuses both passes');

  outline.position.set(4, 12, 3);
  outline.quaternion.setFromEuler(new THREE.Euler(0.3, 0.7, 0.2));
  outline.scale.set(3, 2, 0.125);
  outline.updateMatrixWorld(true);
  assert.ok(occluded.matrixWorld.equals(outline.matrixWorld), 'both passes follow the same component frame');
  outline.geometry.dispose();
  outline.material.dispose();
});

test('outlines sharing a pulsing material reuse and release the same occluded material', () => {
  const material = createSelectionOutlineMaterial(0x2ed573);
  const geometry = new SelectionOutlineGeometry();
  const first = createSelectionOutline(geometry, material);
  const second = createSelectionOutline(geometry, material);
  const occluded = first.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardNodeMaterial>;
  assert.equal((second.children[0] as THREE.Mesh).material, occluded.material);
  material.color.setHex(0xff3300);
  assert.equal(occluded.material.color.getHex(), 0xff3300, 'color changes reach both passes');
  assert.equal(occluded.material.roughness, material.roughness, 'the faint pass keeps the same surface lighting');
  assert.equal(occluded.material.metalness, material.metalness);
  assert.equal(occluded.material.depthFunc, THREE.GreaterDepth, 'only hidden fragments use the faint pass');
  assert.equal(occluded.material.depthWrite, false, 'outlines cannot hide other scene geometry');
  hookSceneMaterials(first);
  assert.ok(material.normalNode && occluded.material.normalNode, 'both lit passes transform their normals with the torus');
  let disposed = 0;
  occluded.material.addEventListener('dispose', () => disposed++);
  material.dispose();
  assert.equal(disposed, 1, 'the shared faint material is released with its visible material');
  geometry.dispose();
});
