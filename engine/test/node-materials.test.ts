import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { alignedInstanceAttribute, alignedVertexAttribute, asNodeMaterial } from '../src/render/NodeMaterials.ts';
import { voxelFaceBudget, VOXEL_GPU_BYTES_PER_FACE, VOXEL_RESIDENT_BYTES_PER_FACE } from '../src/render/DistantVoxelLayer.ts';

test('WebGPU uploads align RGB and signed normals without changing their values', () => {
  const colors=alignedVertexAttribute(new Uint8Array([0,127,255,12,34,56]),3,true);
  assert.equal(colors.itemSize,4);assert.equal(colors.count,2);
  assert.deepEqual([...colors.array],[0,127,255,255,12,34,56,255]);
  const normals=alignedVertexAttribute(new Int8Array([-127,0,127]),3,true);
  assert.equal(normals.getX(0),-1);assert.equal(normals.getZ(0),1);
  assert.equal(normals.array.byteLength%4,0);
  const sides=alignedInstanceAttribute(new Int8Array([-127,127,0,-127]),2,true);
  assert.equal(sides.normalized,false);assert.deepEqual([...sides.array],[-1,1,0,-1]);
  const offset=alignedInstanceAttribute(new Uint16Array([0,2048,65535]),3);
  assert.ok(offset.array instanceof Float32Array);assert.equal(offset.getZ(0),65535);
});

test('helper conversion shares live color updates, caches identity and forwards disposal', () => {
  const classic=new THREE.LineBasicMaterial({color:0x123456,depthTest:false});
  const node=asNodeMaterial(classic);
  assert.equal(node.type,'LineBasicNodeMaterial');assert.equal(asNodeMaterial(classic),node);
  assert.equal(node.depthTest,false);classic.color.setHex(0xff3300);
  assert.equal((node as THREE.LineBasicNodeMaterial).color.getHex(),0xff3300);
  let disposed=0;node.addEventListener('dispose',()=>disposed++);classic.dispose();assert.equal(disposed,1);
});

test('voxel budget covers publication attributes and indexed resident pages', () => {
  const attributes=[alignedInstanceAttribute(new Uint16Array(3),3),alignedInstanceAttribute(new Uint16Array(2),2),
    alignedInstanceAttribute(new Uint8Array(1),1),alignedInstanceAttribute(new Uint8Array(1),1),
    alignedInstanceAttribute(new Uint8Array(3),3,true)];
  assert.equal(attributes.reduce((sum,a)=>sum+a.array.byteLength,0),VOXEL_GPU_BYTES_PER_FACE);
  const budget = 128 * 1024 * 1024, faces = voxelFaceBudget(128);
  assert.ok(VOXEL_RESIDENT_BYTES_PER_FACE >= 16 + 6 * 4 + 32 / 16);
  assert.ok(faces * VOXEL_RESIDENT_BYTES_PER_FACE <= budget);
  assert.ok((faces + 1) * VOXEL_RESIDENT_BYTES_PER_FACE > budget);
});
