import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import Attributes from 'three/src/renderers/common/Attributes.js';
import { AttributeType } from 'three/src/renderers/common/Constants.js';
import { SurfaceBatch } from '../src/render/SurfaceBatch.ts';

test('published surface buffers upload only on publication, including reused slots', () => {
  const make = () => new THREE.Mesh(new THREE.InstancedBufferGeometry(), new THREE.MeshStandardNodeMaterial());
  const source = make(), empty = make();
  source.geometry.setAttribute('surfaceHeight', new THREE.InstancedBufferAttribute(new Float32Array([17]), 1));
  const batch = new SurfaceBatch(new THREE.Group(), 'test', new THREE.Sphere(), make);
  let uploads = 0;
  // Exercise the actual WebGPU attribute manager: DynamicDrawUsage bypasses
  // version checks, whereas an explicitly published static buffer uploads once.
  const attributes = new Attributes({
    createAttribute() { uploads++; },
    updateAttribute() { uploads++; },
  } as unknown as ConstructorParameters<typeof Attributes>[0]);
  const render = () => attributes.update(batch.top.geometry.getAttribute('surfaceHeight'), AttributeType.VERTEX);
  try {
    for (const height of [17, 18, 19]) {
      source.geometry.getAttribute('surfaceHeight').setX(0, height);
      batch.submit(source, 0, 1, empty, 0, 0, false);
      const before = uploads;
      render();
      assert.equal(uploads, before + 1, 'a changed snapshot uploads even when a slot is reused');
      assert.equal(batch.top.geometry.getAttribute('surfaceHeight').getX(0), height);
      for (let frame = 0; frame < 120; frame++) render();
      assert.equal(uploads, before + 1, 'stationary frames must not upload the snapshot again');
    }
  } finally {
    batch.dispose(); source.geometry.dispose(); empty.geometry.dispose();
    source.material.dispose(); empty.material.dispose();
  }
});
