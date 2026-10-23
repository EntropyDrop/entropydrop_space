import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { StaticTerrainGroup } from '../src/render/StaticTerrainGroup.ts';

function fixture(optimized: boolean) {
  const root = new THREE.Group(), group = new StaticTerrainGroup(), leaf = new THREE.Mesh();
  group.matrixCachingEnabled = optimized;
  leaf.matrixAutoUpdate = false; root.position.set(2, 3, 4); group.position.set(7, 8, 9);
  root.add(group); group.add(leaf); return { root, group, leaf };
}

test('static matrices match Three across force, manual changes, reparenting and new children', () => {
  const a = fixture(true), b = fixture(false);
  const operations = [
    (f: ReturnType<typeof fixture>) => f.root.updateMatrixWorld(),
    (f: ReturnType<typeof fixture>) => f.root.updateMatrixWorld(),
    (f: ReturnType<typeof fixture>) => { f.leaf.matrix.makeTranslation(4, 5, 6); f.group.updateMatrixWorld(true); },
    (f: ReturnType<typeof fixture>) => { f.leaf.matrixWorld.makeTranslation(99, 99, 99); f.group.updateMatrixWorld(true); },
    (f: ReturnType<typeof fixture>) => { f.root.position.x++; f.root.updateMatrixWorld(); },
    (f: ReturnType<typeof fixture>) => { f.group.remove(f.leaf); f.root.add(f.leaf); f.root.updateMatrixWorld(); f.group.add(f.leaf); f.root.updateMatrixWorld(); },
    (f: ReturnType<typeof fixture>) => { const leaf = new THREE.Mesh(); leaf.matrixAutoUpdate = false; f.group.add(leaf); f.root.updateMatrixWorld(); },
    (f: ReturnType<typeof fixture>) => { f.leaf.matrixWorldAutoUpdate = false; f.leaf.matrixWorld.makeTranslation(12, 13, 14); f.root.updateMatrixWorld(); },
    (f: ReturnType<typeof fixture>) => { f.leaf.matrixWorldAutoUpdate = true; f.group.updateMatrixWorld(true); },
    (f: ReturnType<typeof fixture>) => { f.leaf.matrix.makeTranslation(21, 22, 23); f.leaf.matrixWorldNeedsUpdate = true; f.group.matrixAutoUpdate = false; f.group.updateMatrixWorld(); },
    (f: ReturnType<typeof fixture>) => { f.leaf.matrix.makeTranslation(31, 32, 33); f.group.updateMatrixWorld(); },
    (f: ReturnType<typeof fixture>) => { f.group.updateWorldMatrix(true, true); f.root.updateMatrixWorld(); },
    (f: ReturnType<typeof fixture>) => { f.leaf.add(new THREE.Object3D()); f.leaf.children[0].position.x = 12; f.root.updateMatrixWorld(); },
  ];
  for (const operation of operations) {
    operation(a); operation(b);
    const matrices = (root: THREE.Object3D) => { const values: number[][] = []; root.traverse(o => values.push(o.matrixWorld.toArray())); return values; };
    assert.deepEqual(matrices(a.root), matrices(b.root));
  }
});

test('unchanged leaves skip multiplication while custom update callbacks still run', () => {
  const { root, group, leaf } = fixture(true);
  let multiplies = 0, customUpdates = 0;
  const multiply = leaf.matrixWorld.multiplyMatrices;
  leaf.matrixWorld.multiplyMatrices = function (a, b) { multiplies++; return multiply.call(this, a, b); };
  const custom = new THREE.Object3D(); custom.matrixAutoUpdate = false;
  custom.updateMatrixWorld = function (force) { customUpdates++; THREE.Object3D.prototype.updateMatrixWorld.call(this, force); };
  group.add(custom);
  root.updateMatrixWorld(); root.updateMatrixWorld(); root.updateMatrixWorld();
  assert.equal(multiplies, 1); assert.equal(customUpdates, 3);
  group.matrixCachingEnabled = false; root.updateMatrixWorld();
  group.matrixCachingEnabled = true; root.position.y++; root.updateMatrixWorld();
  assert.equal(multiplies, 3);
});

test('terrain-owned leaves follow dirty transforms, parent changes and reattachment', () => {
  const a = fixture(true), b = fixture(false);
  a.group.registerStaticLeaf(a.leaf); b.group.registerStaticLeaf(b.leaf);
  let multiplies = 0;
  const multiply = a.leaf.matrixWorld.multiplyMatrices;
  a.leaf.matrixWorld.multiplyMatrices = function (x, y) { multiplies++; return multiply.call(this, x, y); };
  const operations = [
    (f: ReturnType<typeof fixture>) => f.root.updateMatrixWorld(),
    (f: ReturnType<typeof fixture>) => f.root.updateMatrixWorld(),
    (f: ReturnType<typeof fixture>) => { f.leaf.position.x = 12; f.leaf.updateMatrix(); f.root.updateMatrixWorld(); },
    (f: ReturnType<typeof fixture>) => { f.leaf.matrix.makeTranslation(4, 5, 6); f.leaf.matrixWorldNeedsUpdate = true; f.root.updateMatrixWorld(); },
    (f: ReturnType<typeof fixture>) => { f.root.position.y++; f.root.updateMatrixWorld(); },
    (f: ReturnType<typeof fixture>) => { f.root.add(f.leaf); f.root.updateMatrixWorld(); f.group.add(f.leaf); f.root.updateMatrixWorld(); },
    (f: ReturnType<typeof fixture>) => { f.group.updateWorldMatrix(true, true); f.root.updateMatrixWorld(); },
  ];
  for (const operation of operations) {
    operation(a); operation(b);
    assert.deepEqual(a.leaf.matrixWorld.elements, b.leaf.matrixWorld.elements);
  }
  assert.equal(multiplies, 7);
});
