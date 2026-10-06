import { requireValue } from './fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Chunk } from '../src/voxel/Chunk.ts';
import { LowPolyMesher } from '../src/mesher/LowPolyMesher.ts';
import { MicroVoxelLayer } from '../src/voxel/MicroVoxelLayer.ts';
import { Contraption } from '../src/contraption/Contraption.ts';
import { setTerrainKernelMode } from '../src/wasm/TerrainKernels.ts';
import { createVoxelEmissiveMaterial, createVoxelEmissionMaskUniform } from '../src/render/VoxelEmission.ts';

function tint(mesh: THREE.Mesh, materialId: number) {
  const group = mesh.geometry.groups.find(group => group.materialIndex === materialId)!;
  assert.ok(group);
  const vertex = mesh.geometry.index?.getX(group.start) ?? group.start;
  const colors = mesh.geometry.getAttribute('color');
  return [colors.getX(vertex), colors.getY(vertex), colors.getZ(vertex)].map(v => Math.round(v * 255));
}

for (const mode of ['js', 'wasm'] as const) {
  test(`${mode} standard and micro rebuilds retain emissive tints down to the darkest color byte`, () => {
    const previous = setTerrainKernelMode(mode);
    try {
      const mesher = new LowPolyMesher();
      const chunk = new Chunk(0, 0, null);
      const micros = new MicroVoxelLayer();
      for (const color of [0xff0000, 0x00ff00, 0x0000ff, 0x010203, 0x000001, 0x888888, 0]) {
        const expected = [color >> 16, color >> 8 & 255, color & 255];
        chunk.setLocalBlock(2, 5, 2, 1, color, 1);
        micros.set(2, 5, 2, color, null, 1);
        // Repeated neighboring edits remesh already placed emissive voxels.
        for (const block of [1, 0, 1]) {
          chunk.setLocalBlock(3, 5, 2, block, 0x888888, 0);
          if (block) micros.set(3, 5, 2, 0x888888);
          else micros.delete(3, 5, 2);
          const mesh = mesher.buildChunkMesh(chunk).children[0] as THREE.Mesh;
          micros.updateMesh();
          assert.deepEqual(tint(mesh, 1), expected);
          assert.deepEqual(tint(micros.mesh!, 1), expected);
          assert.equal(chunk.getLocalMaterial(2, 5, 2), 1);
          assert.equal(micros.getMaterial(2, 5, 2), 1);
          if (block) {
            const lit = new THREE.Color(0x888888);
            assert.deepEqual(tint(mesh, 0), [lit.r, lit.g, lit.b].map(v => Math.round(v * 255)));
          }
          mesh.geometry.dispose();
        }
      }
    } finally { setTerrainKernelMode(previous); }
  });
}

test('entity and terrain meshes feed the same emissive tint and shader', () => {
  const entity = new Contraption(1000, [{ localX: 0, localY: 0, localZ: 0,
    block: 1, color: 0x010203, materialId: 1, size: 1, entityId: 'root' }],
  new THREE.Vector3(), new THREE.Scene());
  try {
    const mesh = [...requireValue(requireValue(entity.getEntityNode('root')).voxelChunks).values()][0] as THREE.Mesh;
    const chunk = new Chunk(0, 0, null);
    chunk.setLocalBlock(2, 5, 2, 1, 0x010203, 1);
    const terrain = new LowPolyMesher().buildChunkMesh(chunk).children[0] as THREE.Mesh;
    assert.deepEqual(tint(mesh, 1), tint(terrain, 1));
    const entityMaterial = (mesh.material as THREE.Material[])[1];
    const terrainMaterial = (terrain.material as THREE.Material[])[1];
    for (const material of [entityMaterial, terrainMaterial] as any[]) {
      assert.equal(material.type, "MeshBasicNodeMaterial");
      assert.ok(material.colorNode?.isNode);
      assert.ok(material.outputNode?.isNode);
    }
    terrain.geometry.dispose();
  } finally { entity.dispose(); }
});

test('emission uses scene tone mapping and only marks opted-in HDR buffers', () => {
  const material = createVoxelEmissiveMaterial();
  const mask = createVoxelEmissionMaskUniform(material);
  const geometry = new THREE.BoxGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  const camera = new THREE.PerspectiveCamera();
  const scene = new THREE.Scene();
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  let renderTarget: THREE.WebGLRenderTarget | null = null;
  const renderer = { getRenderTarget: () => renderTarget } as THREE.WebGLRenderer;
  try {
    const draw = () => material.onBeforeRender(renderer, scene, camera, geometry, mesh, new THREE.Group());
    assert.equal(material.toneMapped, true);
    assert.equal(material.fog, false);
    assert.ok(material.colorNode?.isNode);
    assert.ok(material.outputNode?.isNode);
    draw();
    assert.equal(mask.value, 0, 'direct rendering remains opaque');
    renderTarget = target;
    draw();
    assert.equal(mask.value, 0, 'ordinary preview targets remain opaque');
    target.texture.userData.voxelEmissionMask = true;
    draw();
    assert.equal(mask.value, 1, 'HDR scene stores emission coverage separately from radiance');
    renderTarget = null;
    draw();
    assert.equal(mask.value, 0, 'leaving Ultra clears the emission marker on shared materials');
  } finally { geometry.dispose(); material.dispose(); target.dispose(); }
});
