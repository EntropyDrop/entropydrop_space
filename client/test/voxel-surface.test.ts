import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { parseSurfaceZoneSnapshot, MAX_SURFACE_ZONE_BYTES } from '../src/bootstrap/SpaceSurfaceSnapshot.ts';
import { encodeVoxelLevels } from '@entropydrop/space-engine/worldgen/VoxelSurfaceGenerator.ts';
import { DistantSurfaceLayer } from '@entropydrop/space-engine/render/DistantSurfaceLayer.ts';
import { bendPoint } from '@entropydrop/space-engine/torus/TorusWorld.ts';

function fixture() {
  // At 8m source resolution, a floating bottom face at y=64 and its upper face
  // at 72 survive alongside a coarser, independently closed 3D mip ladder.
  const levels = [8,16,32,64].map(cellSize => {
    const faces = new Uint8Array(32), view = new DataView(faces.buffer);
    for (let i = 0; i < 2; i++) {
      const at = i*16;
      view.setUint16(at + 2, (64 + i*cellSize)*8, true);
      view.setUint16(at + 6, cellSize*8, true); view.setUint16(at + 8, cellSize*8, true);
      faces[at+10] = 2+i; faces[at+11] = 1; faces.set([128,192,255], at+12);
    }
    return { cellSize, faces };
  });
  const trailer = encodeVoxelLevels(levels), records = 64*64;
  const bytes = new Uint8Array(36+records*8+trailer.length), view = new DataView(bytes.buffer);
  bytes.set([69,68,83,90,7,8,32,8]);
  view.setUint16(8,16,true); view.setUint16(10,2,true); view.setInt32(12,42,true); view.setUint32(16,3,true);
  view.setUint32(28,records,true);
  view.setUint16(32,72*8,true); view.setUint16(34,64*8,true);
  bytes.set(trailer, 36+records*8);
  return bytes;
}

test('v7 decodes a complete 3D mip ladder and rejects malformed faces', () => {
  const bytes = fixture(), snapshot = parseSurfaceZoneSnapshot(bytes);
  assert.deepEqual(snapshot.voxelMips?.map(level => level.cellSize), [8,16,32,64]);
  assert.equal(snapshot.voxelMips![0].faces[11], 1);
  const truncated = bytes.slice(0,-1);
  assert.throws(() => parseSurfaceZoneSnapshot(truncated), /Truncated/);
  const corrupt = bytes.slice(); corrupt[36+64*64*8+8+8+10] = 6;
  assert.throws(() => parseSurfaceZoneSnapshot(corrupt), /face bounds/);
  const noLadder = bytes.slice(0,36+64*64*8);
  assert.throws(() => parseSurfaceZoneSnapshot(noLadder), /volumetric/);
});

test('dense voxel snapshots above 32 MiB decode without removing the size bound', () => {
  const small = fixture(), header = 36 + 64 * 64 * 8 + 8, count = 2_100_000;
  const facesAt = header + 8, oldEnd = facesAt + 32, faceBytes = count * 16;
  const large = new Uint8Array(small.length + faceBytes - 32);
  large.set(small.subarray(0, facesAt));
  new DataView(large.buffer).setUint32(header + 4, count, true);
  for (let i = 0; i < count; i++) large.set(small.subarray(facesAt, facesAt + 16), facesAt + i * 16);
  large.set(small.subarray(oldEnd), facesAt + faceBytes);
  assert.ok(large.length > 32 * 1024 * 1024);
  assert.equal(parseSurfaceZoneSnapshot(large).voxelMips![0].faces.length, faceBytes);
  const oversized = new Uint8Array(MAX_SURFACE_ZONE_BYTES + 1);
  oversized.set(small);
  assert.throws(() => parseSurfaceZoneSnapshot(oversized), /Invalid Space surface-zone snapshot/);
});

test('volumetric zones never emit legacy pillars, preserve underside and hand off to detail', async () => {
  const layer = new DistantSurfaceLayer();
  layer.installZone(parseSurfaceZoneSnapshot(fixture()));
  const camera = new THREE.PerspectiveCamera(75,1.6,.1,10000);
  camera.position.copy(bendPoint(8192,100,1024));
  camera.lookAt(bendPoint(8192,64,1040)); camera.updateMatrixWorld();
  layer.updateView(camera,720);
  await layer.finalizeConnections();
  assert.equal(layer.mesh.geometry.instanceCount, 0);
  assert.equal(layer.sideMesh.geometry.instanceCount, 0);
  const directions: number[] = [];
  layer.voxels.group.traverse(object => {
    const geometry = (object as THREE.Mesh).geometry;
    const attribute = geometry?.getAttribute('voxelDirection');
    if (attribute) for (let i = 0; i < (geometry as THREE.InstancedBufferGeometry).instanceCount; i++) directions.push(attribute.getX(i));
  });
  assert.ok(directions.includes(2) && directions.includes(3));
  const face = layer.voxels.group.children.find(object =>
    (object as THREE.Mesh<THREE.InstancedBufferGeometry>).geometry.instanceCount > 0) as THREE.Mesh;
  assert.ok(face.geometry.getAttribute('voxelOffset').array instanceof Uint16Array);
  assert.ok(face.geometry.getAttribute('voxelSpan').array instanceof Uint16Array);
  assert.equal(face.geometry.getAttribute('voxelOffset').getY(0), 64 * 8,
    'packed coordinates retain exact eighth-metre units');
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  (face.material as THREE.Material).onBeforeCompile(shader as THREE.WebGLProgramParametersWithUniforms,
    {} as THREE.WebGLRenderer);
  assert.deepEqual((shader.uniforms as any).uVoxelOrigin.value.toArray(), [8192,0,1024],
    'the per-zone shader origin restores world coordinates before torus bending');
  assert.match(shader.vertexShader, /uVoxelOrigin \+ voxelOffset \* \.125/);
  layer.setDetailChunkReady(512,64,true,true);
  assert.equal(layer.handoff.data[(64*1024+512)*2],255);
  layer.setDetailChunkReady(512,64,false,true);
  assert.equal(layer.handoff.data[(64*1024+512)*2],0);
  const objects = layer.voxels.group.children.length;
  camera.lookAt(bendPoint(8180,80,1010)); camera.updateMatrixWorld();
  layer.updateView(camera,720);
  assert.equal(layer.voxels.group.children.length,objects,'rotation does not rebuild geometry');
  layer.removeZone(16,2);
  assert.equal(layer.voxels.group.children.length,0);
  layer.setEnabled(false);
});
