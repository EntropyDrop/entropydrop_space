import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { VoxelFaceArena, type VoxelFaceMesh } from '../src/render/VoxelFaceArena.ts';

function source(count: number, x: number): VoxelFaceMesh {
  const geometry = new THREE.InstancedBufferGeometry();
  const offset = new Float32Array(count * 3), span = new Float32Array(count * 2), color = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) { offset.set([i, 16, 24], i * 3); span.set([8, 16], i * 2); color.set([17, 128, 255, 255], i * 4); }
  for (const [name, array, size, normalized] of [
    ['voxelOffset', offset, 3, false], ['voxelSpan', span, 2, false],
    ['voxelDirection', new Float32Array(count).fill(5), 1, false],
    ['voxelEmission', new Float32Array(count).fill(1), 1, false], ['color', color, 4, true],
  ] as const) geometry.setAttribute(name, new THREE.InstancedBufferAttribute(array, size, normalized));
  geometry.instanceCount = count;
  const material = new THREE.MeshStandardNodeMaterial(), mesh = new THREE.Mesh(geometry, material);
  mesh.userData.voxelArenaCompatible = true; mesh.userData.opaqueMaterial = material; mesh.userData.voxelOrigin = new THREE.Vector3(x, 0, -512);
  return mesh;
}
const make = () => new THREE.Mesh(new THREE.InstancedBufferGeometry(), new THREE.MeshStandardNodeMaterial());
function settle(arena: VoxelFaceArena) {
  for (let i = 0; i < 100; i++) { arena.restoreSources(); arena.sync(Infinity); if (!arena.hasPendingWork) return; }
  assert.fail('arena did not settle');
}
const snapshot = (mesh: VoxelFaceMesh) => Object.fromEntries(Object.entries(mesh.geometry.attributes)
  .map(([name, attribute]) => [name, Array.from(attribute.array)]));

test('bounded publication releases duplicate attributes and reconstructs all face data exactly', () => {
  const group = new THREE.BundleGroup(), a = source(10000, 16384), b = source(63, -512);
  group.add(b,a); const before = snapshot(a), arena = new VoxelFaceArena(group, make);
  try {
    arena.sync(Infinity,128); assert.equal(arena.stats.copyFaces,128); assert.equal(arena.hasPendingWork,true);
    assert.ok(a.geometry.getAttribute('voxelOffset')); assert.equal(a.visible,true);
    settle(arena); assert.equal(arena.stats.visibleFaces,10063); assert.equal(arena.stats.paddedFaces,10112);
    assert.equal(arena.stats.draws,1); assert.equal(a.geometry.getAttribute('voxelOffset'),undefined);
    assert.equal(arena.stats.releasedSourceBytes,10063*32);
    const page=arena.pages[0], version=page.map.version, dataVersion=page.data.version;
    assert.equal(page.map.usage,THREE.StaticDrawUsage);
    arena.restoreSources(); arena.sync(); assert.equal(page.map.version,version); assert.equal(page.data.version,dataVersion);
    arena.restoreSources(); a.visible=false; arena.sync(); assert.equal(arena.stats.visibleFaces,63);
    assert.equal(page.data.version,dataVersion); arena.dispose(); assert.deepEqual(snapshot(a),before);
    assert.equal(a.visible,false); assert.equal(b.visible,true);
  } finally { arena.dispose(); }
  assert.deepEqual(group.children,[b,a]);
});

test('unmerged draws split runs to preserve coplanar ordering', () => {
  const group=new THREE.BundleGroup(), a=source(64,0), middle=source(64,512), b=source(64,1024);
  middle.material=new THREE.MeshStandardNodeMaterial(); group.add(b,middle,a);
  const arena=new VoxelFaceArena(group,make);
  try {
    settle(arena); const runs=arena.pages.flatMap(page=>page.runs).filter(mesh=>mesh.visible);
    assert.deepEqual(runs.map(mesh=>mesh.renderOrder),[a.id,b.id]); assert.equal(middle.renderOrder,middle.id);
    assert.equal(runs[0].userData.voxelArenaBase,0); assert.equal(runs[1].userData.voxelArenaBase,1);
    arena.restoreSources(); middle.visible=false; arena.sync(); assert.equal(arena.stats.draws,1); assert.equal(runs[1].visible,false);
  } finally { arena.dispose(); }
  assert.equal(middle.renderOrder,0);
});

test('fades restore attributes, replacements invalidate records, removed ranges are reused', () => {
  const group=new THREE.BundleGroup(), a=source(64,0), b=source(64,512); group.add(a,b);
  const before=snapshot(a), arena=new VoxelFaceArena(group,make);
  try {
    settle(arena); const page=arena.pages[0]; arena.restoreSources(); a.material=new THREE.MeshStandardNodeMaterial(); arena.sync();
    assert.deepEqual(snapshot(a),before); assert.equal(a.visible,true); assert.equal(arena.stats.visibleFaces,64);
    a.material=a.userData.opaqueMaterial; settle(arena); assert.equal(arena.pages[0],page);
    arena.restoreSources(); const replacement=source(65,0); a.geometry.dispose(); a.geometry=replacement.geometry;
    settle(arena); assert.equal(arena.stats.visibleFaces,129);
    arena.restoreSources(); group.remove(a); arena.sync(); assert.equal(arena.stats.residentFaces,64);
    const c=source(64,1024); group.add(c); settle(arena); assert.equal(arena.pages.length,1);
    group.remove(b,c); arena.restoreSources(); arena.sync(); assert.equal(arena.pages.length,0);
  } finally { arena.dispose(); }
});

test('updates during partial publication never replace visible sources early', () => {
  const group=new THREE.BundleGroup(), a=source(8000,0); group.add(a); const arena=new VoxelFaceArena(group,make);
  try {
    arena.sync(Infinity,128); a.geometry.getAttribute('voxelOffset').setX(0,42); a.geometry.getAttribute('voxelOffset').needsUpdate=true;
    settle(arena); arena.dispose(); assert.equal(a.geometry.getAttribute('voxelOffset').getX(0),42);
  } finally { arena.dispose(); }
});

test('retirement notifies renderers before deleting attributes; storage is disposed exactly once', () => {
  const group=new THREE.BundleGroup(), a=source(65,0); group.add(a); const arena=new VoxelFaceArena(group,make), deleted:unknown[]=[];
  let retired=0; a.geometry.addEventListener('dispose',()=>{if(a.geometry.getAttribute('voxelOffset'))retired++;});
  settle(arena); assert.equal(retired,1); const page=arena.pages[0];
  const renderer={_attributes:{delete(attribute:unknown){deleted.push(attribute);}}};
  for(let i=0;i<2;i++)page.mesh.onBeforeRender(renderer as any,null as any,null as any,page.mesh.geometry,page.mesh.material,null as any);
  arena.dispose(); arena.dispose(); assert.deepEqual(deleted,[page.data,page.map]);
});

test('permanent teardown does not reconstruct discarded source buffers', () => {
  const group=new THREE.BundleGroup(),a=source(65,0);group.add(a);
  const arena=new VoxelFaceArena(group,make);settle(arena);arena.dispose(false);
  assert.equal(arena.pages.length,0);assert.equal(a.geometry.getAttribute('voxelOffset'),undefined);
});
