import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { TerrainHandoff } from '../src/render/TerrainHandoff.ts';
import { hookSceneMaterials, cullChunks, getWorldProjectionRevision, setTorusViewCorrection } from '../src/torus/TorusWorld.ts';
import { createVoxelEmissiveMaterial } from '../src/render/VoxelEmission.ts';
import { float } from 'three/tsl';

const materialOf = (mesh: THREE.Mesh) => mesh.material as THREE.NodeMaterial;

test('settled near terrain shares the original unmasked material and exact deformation nodes', () => {
  const handoff = new TerrainHandoff(); handoff.enabled.value = true;
  const source = new THREE.MeshStandardNodeMaterial({ flatShading: true, roughness: .65, metalness: .15,
    vertexColors: true, shadowSide: THREE.DoubleSide });
  const meshes = [0, 16].map(x => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), source);
    mesh.position.x = x; return mesh;
  });
  handoff.setReady(0, 0, true, false);
  for (const mesh of meshes) handoff.hook(mesh);
  assert.equal(materialOf(meshes[0]), source);
  const masked = materialOf(meshes[1]);
  assert.notEqual(masked, source);
  assert.ok(masked.maskNode?.isNode);
  assert.equal(source.maskNode, null);
  assert.equal((masked as THREE.MeshStandardNodeMaterial).flatShading, true);
  assert.equal((masked as THREE.MeshStandardNodeMaterial).roughness, .65);
  assert.equal((masked as THREE.MeshStandardNodeMaterial).metalness, .15);
  assert.equal(masked.vertexColors, true);
  assert.equal(masked.shadowSide, THREE.DoubleSide);
  assert.equal(masked.positionNode, source.positionNode);
  assert.equal(masked.normalNode, source.normalNode);
  const position = masked.positionNode;
  hookSceneMaterials(meshes[1]);
  assert.equal(masked.positionNode, position, 'a cloned bent material never bends twice');
  handoff.setReady(1, 0, true, false); handoff.hook(meshes[1]);
  assert.equal(materialOf(meshes[1]), source);
  handoff.setOpaqueFastPathEnabled(false);
  for (const mesh of meshes) handoff.hook(mesh);
  assert.equal(materialOf(meshes[0]), masked, 'one transition variant is shared across chunks');
  assert.equal(materialOf(meshes[1]), masked);
  handoff.texture.dispose();
});

test('near terrain reclassifies fade reversal, disabled handoffs and wrapped nested mesh origins', () => {
  const handoff = new TerrainHandoff(); handoff.enabled.value = true;
  const root = new THREE.Group(); root.position.set(-16, 0, -16);
  const meshes = [0, 16].map(x => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial());
    mesh.position.x = x; root.add(mesh); return mesh;
  });
  handoff.setReady(1023, 127, true, true, 0); handoff.advance(200); handoff.hook(root);
  assert.ok(materialOf(meshes[0]).maskNode);
  handoff.advance(400); handoff.hook(root);
  assert.equal(materialOf(meshes[0]).maskNode, null);
  assert.ok(materialOf(meshes[1]).maskNode, 'another child origin has independent coverage');
  handoff.setReady(-1, -1, false, true, 400); handoff.advance(401); handoff.hook(root);
  assert.ok(materialOf(meshes[0]).maskNode, 'outgoing fades return to masking on the next draw');
  handoff.enabled.value = false; handoff.hook(root);
  assert.ok(meshes.every(mesh => materialOf(mesh).maskNode === null));
  handoff.enabled.value = true; handoff.hook(root);
  assert.ok(meshes.every(mesh => materialOf(mesh).maskNode !== null));
  handoff.texture.dispose();
});

test('near variants preserve existing masks, transparent settings and emissive target callbacks', () => {
  const handoff = new TerrainHandoff(); handoff.enabled.value = true;
  const solid = new THREE.MeshStandardNodeMaterial({ transparent: true, opacity: .5, depthWrite: false });
  solid.maskNode = float(1).greaterThan(0);
  const emissive = createVoxelEmissiveMaterial(), mesh = new THREE.Mesh(new THREE.BoxGeometry(), [solid, emissive]);
  handoff.hook(mesh);
  const masked = mesh.material as THREE.NodeMaterial[];
  assert.notEqual(masked[0].maskNode, solid.maskNode);
  assert.equal(masked[0].transparent, true); assert.equal(masked[0].opacity, .5);
  assert.equal(masked[0].depthWrite, false);
  assert.equal(masked[1].outputNode, emissive.outputNode);
  assert.equal(masked[1].onBeforeRender, emissive.onBeforeRender);
  handoff.setReady(0, 0, true, false); handoff.hook(mesh);
  const opaque = mesh.material as THREE.NodeMaterial[];
  assert.equal(opaque[0], solid); assert.equal(opaque[0].maskNode, solid.maskNode);
  assert.equal(opaque[1], emissive);
  handoff.texture.dispose();
});

test('near variants are owned by each handoff and retire once without disposing source materials', () => {
  const first = new TerrainHandoff(), second = new TerrainHandoff();
  first.enabled.value = second.enabled.value = true;
  const source = new THREE.MeshStandardNodeMaterial();
  const a = new THREE.Mesh(new THREE.BoxGeometry(), source), b = a.clone();
  first.hook(a); second.hook(b);
  assert.notEqual(a.material, b.material);
  let sourceDisposals = 0, aDisposals = 0, bDisposals = 0;
  source.addEventListener('dispose', () => sourceDisposals++);
  materialOf(a).addEventListener('dispose', () => aDisposals++);
  materialOf(b).addEventListener('dispose', () => bDisposals++);
  first.texture.dispose();
  assert.equal(aDisposals, 1); assert.equal(bDisposals, 0); assert.equal(sourceDisposals, 0);
  source.dispose(); second.texture.dispose();
  assert.equal(aDisposals, 1); assert.equal(bDisposals, 1); assert.equal(sourceDisposals, 1);
});

test('shadow-free views cull nearby terrain behind the camera and restore it for shadow passes', () => {
  setTorusViewCorrection(null);
  const camera = new THREE.PerspectiveCamera(65, 1.6, .1, 1000);
  camera.updateMatrixWorld(true);
  const make = (z: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial());
    Object.assign(mesh.userData, { standardChunkKey: '0,0', bentSphere: { cx: 0, cy: 0, cz: z, radius: 1 },
      bentSphereRevision: getWorldProjectionRevision() });
    return mesh;
  };
  const front = make(-30), back = make(30), micro = make(30);
  const world = { chunks: new Map([['0,0', { mesh: front }], ['1,0', { mesh: back }]]),
    microVoxels: { renderMeshes: new Map([['0,0', micro]]) } };
  cullChunks(camera, world, false);
  assert.equal(front.visible, true); assert.equal(back.visible, false); assert.equal(micro.visible, false);
  cullChunks(camera, world, true);
  assert.equal(back.visible, true); assert.equal(micro.visible, true);
  assert.equal(back.castShadow, true); assert.equal(micro.castShadow, true);
  camera.rotation.y = Math.PI; camera.updateMatrixWorld(true); cullChunks(camera, world, false);
  assert.equal(front.visible, false); assert.equal(back.visible, true); assert.equal(micro.visible, true);
});
