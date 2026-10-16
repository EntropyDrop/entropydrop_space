import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Contraption } from '../src/contraption/Contraption.ts';
import { DecorationBatchMesh } from '../src/contraption/DecorationMeshes.ts';
import { bendPointForView } from '../src/torus/TorusWorld.ts';
import type { DecorationDefinition } from '../src/contraption/Decorations.ts';

const decorations = (count: number): DecorationDefinition[] => Array.from({ length: count }, (_, i) => ({
  id: `d${String(i).padStart(3, '0')}`, position: [i * 1.25 + 4, 1, 0], scale: [1, .5, 2],
  color: i % 2 ? 0x123456 : 0xee3322, ...(i % 3 ? {} : { materialId: 1 }),
}));
function fixture(count: number) {
  return new Contraption(1, [{ localX: 0, localY: 0, localZ: 0, size: 1, color: 1, block: 1, entityId: 'base' }],
    new THREE.Vector3(), new THREE.Scene(), { rootComponentId: 'base', decorations: decorations(count) });
}
const batches = (entity: Contraption) => entity.decorationGroups.get('base')!.children
  .filter((object): object is DecorationBatchMesh => object instanceof DecorationBatchMesh);
function assertInstances(entity: Contraption) {
  const values = entity.getRuntimeComponentDecorations('base');
  const group = entity.decorationGroups.get('base')!;
  const pivot = entity.getEntityNode('base')!.pivotLocal;
  const actual = new THREE.Matrix4();
  for (const batch of batches(entity)) {
    const emissive = batch.name === 'DecorationBatch:1';
    const expected = values.filter(value => (value.materialId === 1) === emissive).map(value => {
      const handle = group.children.find(object => object.userData.decorationId === value.id)!;
      assert.equal(handle.visible, false, 'handles must not issue individual draw calls');
      assert.ok(handle.position.distanceTo(new THREE.Vector3().fromArray(value.position || [0, 0, 0]).sub(pivot)) < 1e-8);
      handle.updateMatrix();
      return { value, matrix: handle.matrix.elements.map(Math.fround) };
    });
    assert.equal(batch.instanceCount, expected.length);
    for (let i = 0; i < batch.instanceCount; i++) {
      batch.getMatrixAt(i, actual);
      const index = expected.findIndex(item => item.matrix.every((value, axis) => value === actual.elements[axis]));
      assert.notEqual(index, -1, 'each rendered instance has exactly one matching authored transform');
      const [{ value }] = expected.splice(index, 1);
      const color = emissive ? new THREE.Color().setRGB((value.color >> 16 & 255) / 255, (value.color >> 8 & 255) / 255, (value.color & 255) / 255)
        : new THREE.Color(value.color);
      const colors = batch.tintAttribute;
      assert.deepEqual([colors.getX(i), colors.getY(i), colors.getZ(i)], color.toArray().map(Math.fround));
    }
  }
  assert.equal(batches(entity).reduce((sum, batch) => sum + batch.instanceCount, 0), values.length);
}

test('hundreds of decorations use two draws while preserving colors, bounds, flat and bent picking', () => {
  const entity = fixture(336);
  try {
    assert.equal(batches(entity).length, 2);
    assertInstances(entity);
    assert.ok(entity.getVisualWorldBounds().max.x >= 423);
    const origin = new THREE.Vector3(4, 1, 4), direction = new THREE.Vector3(0, 0, -1);
    assert.equal(entity.raycastDecorations(origin, direction, 8, false)?.decorationId, 'd000');
    const start = bendPointForView(4, 1, 4), end = bendPointForView(4, 1, 0);
    assert.equal(entity.raycastDecorations(start, end.sub(start).normalize(), 8, true)?.decorationId, 'd000');
    entity.setDecorationSelection({ componentId: 'base', decorationId: 'd000' });
    const outline = entity.decorationGroups.get('base')!.getObjectByName('DecorationSelection')!;
    assert.ok(outline.position.equals(entity.decorationGroups.get('base')!.children[0].position));
    const resources = batches(entity).map(batch => [batch, batch.geometry, batch.material, batch.instanceMatrix]);
    entity.editRuntimeDecoration('base', 'd005', { color: 0x00ff88, scale: [2, 3, 4], position: [20, 2, 1] });
    assert.deepEqual(batches(entity).map(batch => [batch, batch.geometry, batch.material, batch.instanceMatrix]), resources);
    assertInstances(entity);
  } finally { entity.dispose(); }
});

test('batch growth, swap removal and material migration preserve every remaining instance', () => {
  const entity = fixture(7);
  try {
    assert.equal(batches(entity).length, 0);
    for (const value of decorations(40).slice(7)) {
      const { id, ...patch } = value;
      entity.editRuntimeDecoration('base', id, patch);
      assertInstances(entity);
    }
    for (const id of ['d001', 'd006', 'd039', 'd000']) {
      entity.editRuntimeDecoration('base', id, undefined, true);
      assertInstances(entity);
    }
    for (const materialId of [1, 0, 1, 0]) {
      entity.editRuntimeDecoration('base', 'd005', { materialId, color: 0x44ee66 });
      assertInstances(entity);
    }
    for (const value of entity.getRuntimeComponentDecorations('base')) entity.editRuntimeDecoration('base', value.id, undefined, true);
    assert.equal(batches(entity).length, 0);
    entity.editRuntimeDecoration('base', 'new', { color: 0x223344 });
    assertInstances(entity);
    const disposable = batches(entity)[0];
    let disposed = 0;
    disposable.geometry.addEventListener('dispose', () => disposed++);
    entity.clearRuntimeDecorations();
    assert.equal(disposed, 1, 'instance buffers are released on Stop/rebuild');
    assert.deepEqual(entity.getRuntimeComponentDecorations('base'), decorations(7));
  } finally { entity.dispose(); }
});

test('batch buffers follow interpolation and settle without changing checkpoints or static instance buffers', () => {
  const entity = fixture(16);
  try {
    const group = entity.decorationGroups.get('base')!;
    const handle = group.children.find(object => object.userData.decorationId === 'd000')!;
    const batch = batches(entity).find(mesh => mesh.name === 'DecorationBatch:1')!;
    const before = handle.position.clone();
    entity.capturePreviousEntityTransforms();
    entity.editRuntimeDecoration('base', 'd000', { position: [10, 4, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] });
    const after = handle.position.clone(), saved = entity.captureRuntimeDecorations();
    const rendered = new THREE.Matrix4();
    for (const alpha of [0, .25, .5, 1]) {
      entity.beginRenderInterpolation(alpha);
      assert.ok(handle.position.distanceTo(before.clone().lerp(after, alpha)) < 1e-8);
      handle.updateMatrix();
      batch.getMatrixAt(0, rendered);
      assert.deepEqual(rendered.elements, handle.matrix.elements.map(Math.fround));
      assert.deepEqual(entity.captureRuntimeDecorations(), saved);
      entity.endRenderInterpolation();
      assertInstances(entity);
    }
    entity.capturePreviousEntityTransforms();
    const versions = batches(entity).map(mesh => mesh.instanceMatrix.version);
    entity.beginRenderInterpolation(.5);
    entity.endRenderInterpolation();
    assert.deepEqual(batches(entity).map(mesh => mesh.instanceMatrix.version), versions, 'static poses do not upload instance buffers');
    assert.ok(batch.instanceMatrix.updateRanges.length <= 1, 'unrendered simulation cannot accumulate dirty ranges');
  } finally { entity.dispose(); }
});
