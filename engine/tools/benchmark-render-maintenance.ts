import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { SurfaceBatch } from '../src/render/SurfaceBatch.ts';

// Isolates settled batch bookkeeping. This is CPU work, not a GPU/FPS test.
// An optional old SurfaceBatch.ts path permits a reproducible before/after run.
const reference = process.argv[2];
let Reference = SurfaceBatch;
if (reference) {
  const source = readFileSync(reference, 'utf8')
    .replace("'three'", JSON.stringify(import.meta.resolve('three')))
    .replace("'./TerrainHandoff.ts'", JSON.stringify(new URL('../src/render/TerrainHandoff.ts', import.meta.url).href));
  Reference = (await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`)).SurfaceBatch;
}

function measure(Batch: typeof SurfaceBatch) {
  const root = new THREE.Group();
  const make = () => {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('height', new THREE.InstancedBufferAttribute(new Float32Array([10]), 1));
    geometry.instanceCount = 1;
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  };
  const source = make();
  const batches = Array.from({ length: 1024 }, (_, i) => {
    const batch = new Batch(root, String(i), new THREE.Sphere(), () => {
      const mesh = make(); mesh.geometry.instanceCount = 0; return mesh;
    });
    batch.submit(source, 0, 1, source, 0, 1, false, 0);
    batch.advance(6000);
    return batch;
  });
  const frame = () => { for (const batch of batches) { batch.advance(10000); batch.setVisible(true); } };
  for (let i = 0; i < 1000; i++) frame();
  const samples = [];
  for (let sample = 0; sample < 9; sample++) {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) frame();
    samples.push((performance.now() - start) / 1000);
  }
  for (const batch of batches) batch.dispose();
  source.geometry.dispose(); source.material.dispose();
  samples.sort((a, b) => a - b);
  return { batches: batches.length, frameMedianMs: samples[4], frameMaxMs: samples[8] };
}

if (reference) console.log('Reference:', JSON.stringify(measure(Reference)));
console.log('Current:', JSON.stringify(measure(SurfaceBatch)));
