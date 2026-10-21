import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { buildSelectionHighlightGeometry, createSelectionHighlightMaterial, SELECTION_HIGHLIGHT_SURFACE_OFFSET } from '../src/render/SelectionHighlight.ts';
import { bendPoint, bendDirection, hookSceneMaterials } from '../src/torus/TorusWorld.ts';

test('selection tint keeps occlusion and offsets the surface before torus bending without grazing-angle bias', () => {
  const material = createSelectionHighlightMaterial();
  assert.equal(material.depthTest, true, 'terrain must still hide buried faces');
  assert.equal(material.depthWrite, false, 'the preview must not hide terrain');
  assert.equal(material.polygonOffsetFactor, 0, 'slope-dependent bias can reveal buried faces at grazing angles');
  const offset = material.positionNode;
  assert.ok(offset, 'coplanar faces get a small physical separation');
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  hookSceneMaterials(mesh);
  const bent = material.positionNode;
  assert.notEqual(bent, offset);
  hookSceneMaterials(mesh);
  assert.equal(material.positionNode, bent, 'scene scans must not accumulate surface offsets');
  mesh.geometry.dispose();
  material.dispose();
});

test('a twelve-metre selected ground face stays above curved tutorial terrain instead of cutting through it', () => {
  const origin = new THREE.Vector3(8180, 16, 562);
  const geometry = buildSelectionHighlightGeometry([
    { minX: 8180, minY: 16, minZ: 562, maxX: 8192, maxY: 17, maxZ: 574 },
  ], origin);
  const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal'), indices = geometry.getIndex()!;
  const clearance = (points: THREE.Vector3[], offset: number) => {
    const center = points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / 3);
    const surface = bendPoint(center.x, center.y, center.z);
    const up = bendDirection(center.x, center.y, center.z, { x: 0, y: 1, z: 0 });
    const drawn = points.reduce((sum, point) => sum.add(bendPoint(point.x, point.y + offset, point.z)), new THREE.Vector3()).multiplyScalar(1 / 3);
    return drawn.sub(surface).dot(up);
  };
  const oldFace = [new THREE.Vector3(8180, 17, 562), new THREE.Vector3(8192, 17, 562), new THREE.Vector3(8192, 17, 574)];
  assert.ok(clearance(oldFace, 0) < -0.01, 'the old large triangle visibly sinks into the terrain');
  let topTriangles = 0;
  for (let i = 0; i < indices.count; i += 3) {
    const a = indices.getX(i);
    if (normal.getY(a) !== 1) continue;
    const points = [a, indices.getX(i + 1), indices.getX(i + 2)]
      .map(index => new THREE.Vector3().fromBufferAttribute(position, index).add(origin));
    assert.ok(clearance(points, SELECTION_HIGHLIGHT_SURFACE_OFFSET) > 0.001, 'every top triangle stays separated from the ground');
    topTriangles++;
  }
  assert.ok(topTriangles > 2);
  geometry.dispose();
});

test('the largest selection tessellates its surface only and preserves exact action bounds', () => {
  const geometry = buildSelectionHighlightGeometry([
    { minX: 0, minY: 0, minZ: 0, maxX: 256, maxY: 256, maxZ: 256 },
  ], { x: 0, y: 0, z: 0 });
  assert.ok(geometry.getAttribute('position').count < 400_000, 'indexed faces avoid generating the whole selected volume');
  geometry.computeBoundingBox();
  assert.deepEqual(geometry.boundingBox!.min.toArray(), [0, 0, 0]);
  assert.deepEqual(geometry.boundingBox!.max.toArray(), [256, 256, 256]);
  geometry.dispose();
});
