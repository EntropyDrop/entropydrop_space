import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { voxelHandoffMode } from '../src/render/VoxelDrawCulling.ts';
import { VoxelLodPlanner, type VoxelLodTile } from '../src/render/VoxelLodPlanner.ts';

test('handoff opacity updates the GPU each step but invalidates visibility only at class boundaries', () => {
  const handoff = new TerrainHandoff();
  handoff.setReady(0, 0, true, true, 0); handoff.advance(100);
  const visibility = handoff.texture.userData.voxelVisibilityVersion, version = handoff.texture.version;
  handoff.advance(200);
  assert.ok(handoff.texture.version > version, 'the intermediate opacity still uploads');
  assert.equal(handoff.texture.userData.voxelVisibilityVersion, visibility);
  handoff.advance(400);
  assert.ok(handoff.texture.userData.voxelVisibilityVersion > visibility, 'complete coverage changes culling');
  const full = handoff.texture.userData.voxelVisibilityVersion;
  handoff.setReady(0, 0, false, true, 500); handoff.advance(510);
  assert.ok(handoff.texture.userData.voxelVisibilityVersion > full, 'eviction restores hidden faces at the first fading step');
  handoff.texture.dispose();
});
import { DistantVoxelLayer } from '../src/render/DistantVoxelLayer.ts';
import { TerrainHandoff, TERRAIN_FADE_MS } from '../src/render/TerrainHandoff.ts';
import { bendPoint, computeBentBoundsSphere, projectBentPointForView,
  projectBentSphereForView, setTorusViewCorrection } from '../src/torus/TorusWorld.ts';
import type { SurfaceZoneSnapshot } from '../src/voxel/SurfaceZoneSnapshot.ts';

function source(height = 8, zoneX = 0, zoneZ = 0): SurfaceZoneSnapshot {
  const faces = new Uint8Array(6 * 16), data = new DataView(faces.buffer);
  for (let direction = 0; direction < 6; direction++) {
    const at = direction * 16;
    data.setUint16(at, 8 * 8, true); data.setUint16(at + 2, height * 8, true);
    data.setUint16(at + 4, 8 * 8, true);
    data.setUint16(at + 6, 8, true); data.setUint16(at + 8, 16, true);
    faces[at + 10] = direction; faces[at + 12] = 128;
  }
  return { zoneX, zoneZ, seed: 42, terrainGeneratorVersion: 3, sourceTerrainRevision: height,
    zoneSizeChunks: 32, samplesPerChunkAxis: 16, sampleSize: 1,
    heightsMicro: new Uint16Array(0), colors: new Uint8Array(0), voxelMips: [{ cellSize: 64, faces }] };
}

test('handoff culling requires complete coverage, preserves fades and checks interior chunks', () => {
  const handoff = new TerrainHandoff(), rect = [1, 47, 1, 47];
  assert.equal(voxelHandoffMode(handoff.data, rect), 0);
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) handoff.setReady(x, z, true, false);
  assert.equal(voxelHandoffMode(handoff.data, rect), 2);
  handoff.setReady(1, 1, false, false);
  assert.equal(voxelHandoffMode(handoff.data, rect), 1, 'four covered corners do not imply covered interior');
  handoff.setReady(1, 1, true, true, 0); handoff.advance(200);
  assert.equal(voxelHandoffMode(handoff.data, rect), 1, 'partially faded coverage is still rendered');
  handoff.advance(400);
  assert.equal(voxelHandoffMode(handoff.data, rect), 2);
  handoff.setReady(1, 1, false, false); handoff.setAuthored(1, 1);
  assert.equal(voxelHandoffMode(handoff.data, rect), 2, 'authored ownership independently replaces far terrain');
  handoff.texture.dispose();
});

test('handoff classification wraps both seams and conservatively includes boundary faces', () => {
  const handoff = new TerrainHandoff();
  handoff.setReady(-1, -1, true, false); handoff.setReady(0, 0, true, false);
  assert.equal(voxelHandoffMode(handoff.data, [-15, -1, -15, -1]), 2);
  assert.equal(voxelHandoffMode(handoff.data, [16385, 16399, 2049, 2063]), 2);
  assert.equal(voxelHandoffMode(handoff.data, [0, 1, 0, 1]), 1, 'edge faces can belong to either adjacent chunk');
  assert.equal(voxelHandoffMode(handoff.data, [-1, 1, -1, 1]), 1);
  handoff.texture.dispose();
});

test('worker bounds contain all six face directions and bent triangles at periodic seams', () => {
  for (const [x, z] of [[0, 0], [31, 3], [-1, -1]]) {
    const snapshot = source(248, x, z), planner = new VoxelLodPlanner();
    for (const _ of planner.install({ key: 'test', x, z, token: 1, mips: snapshot.voxelMips! })) {}
    const build = planner.build({ camera: [0, 0, 0], focal: 720, area: 64, distance: 32768,
      faceBudget: 100, hasView: true });
    const tiles: VoxelLodTile[] = [];
    for (const tile of build) if (tile && tile.count) tiles.push(tile);
    assert.equal(tiles.length, 1);
    const tile = tiles[0], sphere = new THREE.Sphere(new THREE.Vector3(...tile.bounds.slice(0, 3)), tile.bounds[3]);
    assert.deepEqual(tile.flatBounds, [x * 512 + 8, x * 512 + 10, z * 512 + 8, z * 512 + 10]);
    for (let i = 0; i < tile.count; i++) for (const u of [0, .5, 1]) for (const v of [0, .5, 1]) {
      const axis = tile.direction[i] >> 1;
      const point = bendPoint(x * 512 + tile.offset[i * 3] / 8 + (axis === 0 ? 0 : axis === 1 ? v * 2 : u),
        tile.offset[i * 3 + 1] / 8 + (axis === 1 ? 0 : axis === 0 ? u : v * 2),
        z * 512 + tile.offset[i * 3 + 2] / 8 + (axis === 2 ? 0 : axis === 0 ? v * 2 : u));
      assert.ok(sphere.containsPoint(point), `direction ${tile.direction[i]} must remain inside its culling bound`);
    }
    const loose = computeBentBoundsSphere({ minX: x * 512, maxX: x * 512 + 128,
      minY: 0, maxY: 256, minZ: z * 512, maxZ: z * 512 + 128 });
    assert.ok(sphere.radius < loose.radius / 20, 'empty vertical space is excluded');
  }
});

test('complete near coverage skips draws and eviction restores resident geometry without a rebuild', () => {
  const handoff = new TerrainHandoff(), layer = new DistantVoxelLayer(handoff.texture);
  const camera = bendPoint(16, 20, 16), frustum = new THREE.Frustum();
  const tick = () => layer.updateView(frustum, camera, 720, 64, 32768);
  try {
    layer.install(source()); tick();
    const mesh = layer.group.children[0] as THREE.Mesh;
    const attributes = mesh.geometry.attributes, publications = layer.group.userData.voxelLodWorkStats.publications;
    assert.equal(mesh.visible, true);
    handoff.setReady(0, 0, true, false); tick();
    assert.equal(mesh.visible, false);
    layer.setDrawOptimizationsEnabled(false); tick();
    assert.equal(mesh.visible, true, 'reference submission retains fragment-only ownership');
    layer.setDrawOptimizationsEnabled(true); tick();
    assert.equal(mesh.visible, false);
    handoff.setReady(0, 0, false, true, 0); handoff.advance(100); tick();
    assert.equal(mesh.visible, true, 'far geometry returns at the start of the outgoing fade');
    assert.equal(mesh.geometry.attributes, attributes);
    assert.equal(layer.group.userData.voxelLodWorkStats.publications, publications);
  } finally { layer.dispose(); handoff.texture.dispose(); }
});

test('tight bounds also cover the camera-local projection correction', () => {
  try {
    setTorusViewCorrection(new THREE.Vector3(8200, 180, 1032));
    for (const x of [8200, 8300, 8420, 8600]) {
      const sphere = computeBentBoundsSphere({ minX: x, maxX: x + 8, minY: 170, maxY: 190, minZ: 1024, maxZ: 1040 });
      const projected = projectBentSphereForView(sphere);
      for (const dx of [0, 4, 8]) for (const y of [170, 180, 190]) for (const z of [1024, 1032, 1040]) {
        assert.ok(projected.containsPoint(projectBentPointForView(bendPoint(x + dx, y, z))));
      }
    }
  } finally { setTorusViewCorrection(null); }
});

test('tight visibility covers both generations until the terrain transition ends', t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const handoff = new TerrainHandoff(), layer = new DistantVoxelLayer(handoff.texture);
  const frustum = new THREE.Frustum(), camera = bendPoint(16, 20, 16);
  const tick = () => layer.updateView(frustum, camera, 720, 64, 32768);
  try {
    layer.install(source()); tick();
    const low = layer.group.children[0] as THREE.Mesh;
    const point = bendPoint(8, 8, 8), high = bendPoint(8, 248, 8);
    const normal = point.clone().sub(high).normalize();
    frustum.planes[0].set(normal, -normal.dot(point) + 4); tick();
    assert.equal(low.visible, true);
    layer.install(source(248)); tick();
    assert.equal(layer.group.children.length, 2);
    assert.ok(layer.group.children.every(mesh => mesh.visible), 'incoming tight bounds cannot cull the outgoing mesh');
    now = TERRAIN_FADE_MS + 1; tick();
    assert.equal(layer.group.children.length, 1);
    assert.equal(layer.group.children[0].visible, false, 'settled tight bounds cull at a stationary camera');
    layer.setDrawOptimizationsEnabled(false); tick();
    assert.equal(layer.group.children[0].visible, true);
  } finally { layer.dispose(); handoff.texture.dispose(); }
});

test('opaque terrain is used only without handoff or generation fading', t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const handoff = new TerrainHandoff(), layer = new DistantVoxelLayer(handoff.texture);
  const camera = bendPoint(16, 20, 16), frustum = new THREE.Frustum();
  const tick = () => layer.updateView(frustum, camera, 720, 64, 32768);
  const material = (mesh: THREE.Object3D) => (mesh as THREE.Mesh).material as any;
  try {
    layer.install(source()); tick();
    const mesh = layer.group.children[0], geometry = (mesh as THREE.Mesh).geometry;
    const opaque = material(mesh);
    assert.equal(opaque.maskNode, null, 'settled unowned terrain has no discard in its pipeline');
    assert.equal(opaque.userData.torusNode, true);
    assert.ok(opaque.outputNode, 'emission and lit output remain present');
    layer.setOpaqueFastPathEnabled(false);
    const masked = material(mesh); assert.ok(masked.maskNode?.isNode);
    layer.setOpaqueFastPathEnabled(true); assert.equal(material(mesh), opaque);
    layer.setDrawOptimizationsEnabled(false); assert.equal(material(mesh), masked);
    layer.setDrawOptimizationsEnabled(true); tick(); assert.equal(material(mesh), opaque);
    assert.equal((mesh as THREE.Mesh).geometry, geometry, 'switching pipelines never rebuilds geometry');

    handoff.setReady(0, 0, true, true, now); now = 100; handoff.advance(now); tick();
    assert.equal(material(mesh), masked, 'incoming near detail must keep handoff dithering');
    now = TERRAIN_FADE_MS + 1; handoff.advance(now); tick(); assert.equal(mesh.visible, false);
    handoff.setReady(0, 0, false, true, now); now += 100; handoff.advance(now); tick();
    assert.equal(mesh.visible, true); assert.equal(material(mesh), masked, 'outgoing near detail also stays masked');
    now += TERRAIN_FADE_MS; handoff.advance(now); tick(); assert.equal(material(mesh), opaque);

    layer.install(source(24)); tick(); now += 50; tick();
    assert.equal(layer.group.children.length, 2);
    assert.ok(layer.group.children.every(object => material(object) === masked), 'both geometry generations keep the transition mask');
    now += TERRAIN_FADE_MS + 1; tick();
    assert.equal(layer.group.children.length, 1);
    assert.equal(material(layer.group.children[0]), opaque, 'stationary completion restores the fast path');

    handoff.setAuthored(0, 0); tick();
    assert.equal(layer.group.children[0].visible, false);
    assert.equal(material(layer.group.children[0]), masked, 'authored ownership cannot enter the opaque path');
  } finally { layer.dispose(); handoff.texture.dispose(); }
});

test('both shared terrain pipelines are released with the ownership texture', () => {
  const handoff = new TerrainHandoff(), layer = new DistantVoxelLayer(handoff.texture);
  layer.install(source()); layer.updateView(new THREE.Frustum(), bendPoint(16,20,16),720,64,32768);
  const { opaqueMaterial, maskedMaterial } = layer.group.children[0].userData;
  let disposed = 0;
  for (const material of [opaqueMaterial, maskedMaterial]) material.addEventListener('dispose', () => disposed++);
  layer.dispose(); assert.equal(disposed, 0, 'shared materials outlive individual mesh slots');
  handoff.texture.dispose(); assert.equal(disposed, 2);
});

test('far command cache invalidates publication, visibility and GPU buffer replacement, not stable views', () => {
  const handoff = new TerrainHandoff(), layer = new DistantVoxelLayer(handoff.texture);
  const camera = bendPoint(16, 20, 16), frustum = new THREE.Frustum();
  const tick = () => layer.updateView(frustum, camera, 720, 64, 32768);
  try {
    assert.equal(layer.getCommandCachingEnabled(), false, 'unsupported consumers use ordinary rendering');
    layer.setCommandCachingEnabled(true); layer.install(source()); tick();
    const stable = layer.group.version; tick();
    assert.equal(layer.group.version, stable);
    layer.setCommandCachingEnabled(true); assert.equal(layer.group.version, stable);
    handoff.setReady(0, 0, true, false); tick();
    assert.ok(layer.group.version > stable);
    const hidden = layer.group.version; tick(); assert.equal(layer.group.version, hidden);
    handoff.setReady(0, 0, false, false); tick();
    assert.ok(layer.group.version > hidden);
    const visible = layer.group.version;
    (layer.group.children[0] as THREE.Mesh).geometry.dispose();
    assert.ok(layer.group.version > visible, 'same-sized pooled geometry can replace native buffers');
    const beforePublish = layer.group.version; layer.install(source(248)); tick();
    assert.ok(layer.group.version > beforePublish);
  } finally { layer.dispose(); handoff.texture.dispose(); }
});

test('shared storage survives edited generations, handoff fades, culling and zone removal', t => {
  let now=0;t.mock.method(performance,'now',()=>now);
  const handoff=new TerrainHandoff(),layer=new DistantVoxelLayer(handoff.texture);
  const camera=bendPoint(16,20,16),frustum=new THREE.Frustum();
  const tick=()=>layer.updateView(frustum,camera,720,64,32768);
  const originals=()=>layer.group.children.filter(mesh=>!mesh.userData.voxelArena) as THREE.Mesh<THREE.InstancedBufferGeometry>[];
  try {
    layer.setMergedBuffersEnabled(true);layer.install(source());tick();
    const old=originals()[0];assert.equal(old.geometry.getAttribute('voxelOffset'),undefined);
    assert.equal(layer.group.userData.voxelArenaStats.visibleFaces,6);
    layer.install(source(80));now=100;tick();
    assert.equal(originals().length,2);
    assert.ok(originals().every(mesh=>mesh.visible&&mesh.geometry.getAttribute('voxelOffset')),'both fade generations use ordinary complete attributes');
    now=TERRAIN_FADE_MS+1;tick();assert.equal(originals().length,1);
    assert.equal(layer.group.userData.voxelArenaStats.visibleFaces,6);
    handoff.setReady(0,0,true,true,now);handoff.advance(now+100);tick();
    assert.equal(originals()[0].geometry.getAttribute('voxelOffset'),undefined,'ownership fading keeps immutable shared storage');
    assert.ok(layer.group.children.some(mesh=>mesh.userData.voxelArena && mesh.visible
      && (mesh as THREE.Mesh).material === mesh.userData.maskedMaterial),'shared storage draws the handoff shader while coverage fades');
    handoff.advance(now+TERRAIN_FADE_MS);tick();assert.equal(layer.group.userData.voxelArenaStats.visibleFaces,0);
    handoff.setReady(0,0,false,false);tick();assert.equal(layer.group.userData.voxelArenaStats.visibleFaces,6);
    layer.setMergedBuffersEnabled(false);
    assert.equal(originals()[0].geometry.getAttribute('voxelOffset').getY(0),80*8);
    layer.setMergedBuffersEnabled(true);tick();layer.removeZone(0,0);tick();
    assert.equal(layer.group.children.length,0);assert.equal(layer.group.userData.voxelArenaStats.bytes,0);
  } finally {layer.dispose();handoff.texture.dispose();}
});
