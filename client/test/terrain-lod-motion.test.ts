import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TerrainHandoff, TERRAIN_FADE_MS } from '@entropydrop/space-engine/render/TerrainHandoff.ts';
import { SurfaceBatch } from '@entropydrop/space-engine/render/SurfaceBatch.ts';
import { DistantSurfaceLayer } from '@entropydrop/space-engine/render/DistantSurfaceLayer.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { bendPoint, cullChunks, setWorldShapeMode } from '@entropydrop/space-engine/torus/TorusWorld.ts';

function source(height: number) {
  const mesh = new THREE.Mesh(new THREE.InstancedBufferGeometry(), new THREE.MeshStandardMaterial());
  mesh.geometry.setAttribute('surfaceHeight', new THREE.InstancedBufferAttribute(new Float32Array([height]), 1));
  mesh.geometry.instanceCount = 1;
  return mesh;
}

test('rapid AOI reversal continues from existing coverage and periodic seams share the same fade', () => {
  const handoff = new TerrainHandoff();
  handoff.enabled.value = true;
  handoff.setAuthored(1023, 127);
  handoff.setReady(-1, -1, true, true, 0);
  assert.equal(handoff.data.at(-2), 0);
  handoff.advance(200);
  assert.equal(handoff.data.at(-2), 128);
  handoff.setReady(1023, 127, false, true, 200);
  assert.equal(handoff.data.at(-2), 128, 'reversing must not restart at full opacity');
  handoff.advance(300);
  assert.ok(handoff.data.at(-2)! >= 63 && handoff.data.at(-2)! <= 65);
  assert.equal(handoff.retains(-1, -1), true);
  handoff.advance(401);
  assert.equal(handoff.retains(-1, -1), false);
  assert.equal(handoff.data.at(-1), 255, 'authored ownership survives near eviction');
  handoff.setReady(-1, -1, true, false, 402);
  assert.equal(handoff.data.at(-2), 255, 'no far coverage means no fade-in hole');
});

test('successive source arrivals keep complementary generations immutable and coalesce to three buffers', () => {
  const root = new THREE.Group(), windows: THREE.Vector2[] = [];
  const batch = new SurfaceBatch(root, '0,0', new THREE.Sphere(), (_side, coverage) => {
    windows.push(coverage);
    const mesh = source(0); mesh.geometry.instanceCount = 0; return mesh;
  });
  batch.submit(source(100), 0, 1, source(100), 0, 1, false, 0);
  const first = batch.top, firstAttribute = first.geometry.getAttribute('surfaceHeight');
  batch.submit(source(200), 0, 1, source(200), 0, 1, true, 10);
  const second = batch.top;
  batch.advance(210);
  assert.equal(firstAttribute.getX(0), 100);
  assert.equal(root.children.length, 4);
  // The two drawn ranges cover every sample exactly once, including endpoints.
  const active = windows.filter((_, i) => i % 2 === 0).filter(w => w.x !== 0 || w.y !== 1);
  assert.deepEqual(active.map(w => w.toArray()).sort((a, b) => a[0] - b[0]), [[0, 0.5], [0.5, 1]]);
  for (let revision = 201; revision < 220; revision++) {
    batch.submit(source(revision), 0, 1, source(revision), 0, 1, true, 220);
  }
  assert.equal(windows.length, 6, 'only three geometry pairs may exist during a burst');
  assert.equal(batch.top, second);
  assert.equal(second.geometry.getAttribute('surfaceHeight').getX(0), 200);
  batch.advance(410);
  assert.equal(batch.top.geometry.getAttribute('surfaceHeight').getX(0), 219);
  batch.advance(810);
  assert.equal(root.children.length, 2);
  const settled = batch.top, attribute = settled.geometry.getAttribute('surfaceHeight');
  assert.equal(batch.submit(source(219), 0, 1, source(219), 0, 1, true, 900), false);
  assert.equal(batch.top, settled);
  assert.equal(batch.top.geometry.getAttribute('surfaceHeight'), attribute);
  batch.advance(6000);
  assert.equal(first.geometry.getAttribute('surfaceHeight'), undefined, 'idle previous buffers release their peak capacity');
  assert.equal(batch.top.geometry.getAttribute('surfaceHeight'), attribute, 'idle cleanup must leave the live draw intact');
  batch.dispose();
  assert.equal(root.children.length, 0);
});

function cameraAt(x: number, y: number, z: number) {
  const camera = new THREE.PerspectiveCamera(65, 1.6, 0.1, 12000);
  camera.position.copy(bendPoint(x, y, z));
  camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  return camera;
}

function flatZone(x: number, z: number) {
  return { zoneX: x, zoneZ: z, seed: 20260827, terrainGeneratorVersion: 1,
    sourceTerrainRevision: 1, sampleSize: 64, samplesPerChunkAxis: 0.25, zoneSizeChunks: 32,
    heightsMicro: new Uint16Array(64).fill(136), colors: new Uint8Array(192).fill(120) };
}

test('turning changes only culling; walking reuses distant roots and unchanged GPU buffers', async () => {
  setWorldShapeMode('torus');
  const layer = new DistantSurfaceLayer();
  try {
    const camera = cameraAt(8192, 100, 1024);
    layer.updateView(camera, 800);
    for (let x = 0; x < 4; x++) layer.installZone(flatZone(x, 2));
    await layer.finalizeConnections();
    const before = layer.mesh.children.filter(m => m.name.endsWith(':tops')) as THREE.Mesh[];
    const buffers = before.map(m => m.geometry.getAttribute('surfaceHeight'));
    const publications = layer.mesh.userData.lodBuildStats.publications;
    for (let i = 0; i < 40; i++) {
      camera.rotateY(0.1); camera.updateMatrixWorld(true); layer.updateView(camera, 800);
    }
    await layer.finalizeConnections();
    assert.equal(layer.mesh.userData.lodBuildStats.publications, publications);
    camera.position.x += 10; camera.updateMatrixWorld(true); layer.updateView(camera, 800);
    await layer.finalizeConnections();
    assert.equal(layer.mesh.userData.lodBuildStats.reusedRoots, 4 * 64);
    assert.equal(layer.mesh.userData.lodBuildStats.reusedSideZones, 4);
    for (let i = 0; i < before.length; i++) {
      assert.ok(layer.mesh.children.includes(before[i]));
      assert.equal(before[i].geometry.getAttribute('surfaceHeight'), buffers[i]);
    }
  } finally { layer.setEnabled(false); setWorldShapeMode('earth'); }
});

test('near standard and micro meshes remain visible and resident until the outgoing fade finishes', async () => {
  setWorldShapeMode('torus');
  const world = new World(new THREE.Scene(), 20260827);
  const layer = world.distantSurface;
  try {
    const camera = cameraAt(8, 40, 8);
    world.setRenderDistance(4); world.updateChunksAround(8, 8, false);
    layer.updateView(camera, 800); layer.installZone(flatZone(0, 0));
    await layer.finalizeConnections();
    world.setBlock(3, 40, 3, 1, false, 0xff0000);
    world.setMicroBlock(24, 350, 24, 0x0000ff);
    const chunk = world.getChunk(0, 0)!;
    (world as any).publishChunkMesh(chunk, world.mesher.buildChunkMeshData(chunk));
    world.microVoxels.updateMesh();
    layer.updateHandoffs(performance.now() + TERRAIN_FADE_MS + 1);
    world.updateChunksAround(300, 8, false);
    cullChunks(camera, world);
    assert.equal(chunk.mesh!.visible, true);
    const micro = [...world.microVoxels.meshChunks.values()][0];
    assert.equal(micro.visible, true);
    (world as any).processPendingChunkEvictions(performance.now(), 100);
    assert.ok(chunk.mesh, 'retained meshes cannot be disposed mid-fade');
    layer.updateHandoffs(performance.now() + TERRAIN_FADE_MS + 1);
    cullChunks(camera, world);
    assert.equal(chunk.mesh!.visible, false);
    assert.equal(micro.visible, false);
    (world as any).processPendingChunkEvictions(performance.now(), 100);
    assert.equal(chunk.mesh, null);
    assert.equal(layer.authoredChunks.has(0, 0), true);
    setWorldShapeMode('earth'); layer.updateHandoffs();
    assert.equal(layer.handoff.enabled.value, false);
  } finally { layer.setEnabled(false); setWorldShapeMode('earth'); }
});
