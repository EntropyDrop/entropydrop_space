import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as THREE from 'three/webgpu';
import { DistantVoxelLayer, VOXEL_PUBLICATION_BUDGET_BYTES } from '../src/render/DistantVoxelLayer.ts';
import { TerrainHandoff, TERRAIN_FADE_MS } from '../src/render/TerrainHandoff.ts';
import { SurfaceBatch } from '../src/render/SurfaceBatch.ts';
import { bendPoint } from '../src/torus/TorusWorld.ts';
import type { SurfaceZoneSnapshot } from '../src/voxel/SurfaceZoneSnapshot.ts';
import { createCooperativeVoxelLodPort, type VoxelLodPort, type VoxelLodCommand } from '../src/render/VoxelLodService.ts';
import { NodeVoxelLodWorker } from './helpers/voxel-lod-worker.ts';
import type { VoxelLodTile } from '../src/render/VoxelLodPlanner.ts';

function source(revision = 1, tint = 128, count = 128): SurfaceZoneSnapshot {
  return { zoneX: 16, zoneZ: 2, seed: 42, terrainGeneratorVersion: 3, sourceTerrainRevision: revision,
    zoneSizeChunks: 32, samplesPerChunkAxis: 16, sampleSize: 1,
    heightsMicro: new Uint16Array(0), colors: new Uint8Array(0),
    voxelMips: [1, 2, 4, 8, 16, 32, 64].map(cellSize => {
      const faces = new Uint8Array((cellSize === 1 ? count : 2) * 16), view = new DataView(faces.buffer);
      for (let i = 0; i < faces.length / 16; i++) {
        view.setUint16(i * 16, Math.floor(i / (faces.length / 32)) * 128 * 8, true);
        view.setUint16(i * 16 + 2, 64 * 8, true);
        view.setUint16(i * 16 + 6, cellSize * 8, true); view.setUint16(i * 16 + 8, cellSize * 8, true);
        faces[i * 16 + 10] = 3; faces[i * 16 + 11] = 1;
        faces.set([tint, 192, 255], i * 16 + 12);
      }
      return { cellSize, faces };
    }) };
}
const camera = bendPoint(8200, 120, 1032), frustum = new THREE.Frustum();
function tick(layer: DistantVoxelLayer, area = 1, budget = 100000) {
  layer.updateView(frustum, camera, 720, area, 32768, budget);
}
test('empty layers do not start workers or advertise pending work', () => {
  const handoff = new TerrainHandoff();
  let creations = 0;
  const layer = new DistantVoxelLayer(handoff.texture, { workerFactory: () => {
    creations++; return createCooperativeVoxelLodPort();
  } });
  try {
    tick(layer); tick(layer, 64);
    assert.equal(creations, 0);
    assert.equal(layer.hasPendingWork, false);
  } finally { layer.dispose(); handoff.texture.dispose(); }
});
async function drain(layer: DistantVoxelLayer, area = 1, budget = 100000) {
  const deadline = performance.now() + 10000;
  do {
    tick(layer, area, budget);
    assert.ok(performance.now() < deadline, 'streaming must make progress without further camera movement');
    if (layer.hasPendingWork) await delay(4);
  } while (layer.hasPendingWork);
  await delay(TERRAIN_FADE_MS + 10); tick(layer, area, budget);
}
function geometryDigest(layer: DistantVoxelLayer) {
  const hash = createHash('sha256');
  for (const mesh of [...layer.group.children].sort((a, b) => a.name.localeCompare(b.name)) as THREE.Mesh<THREE.InstancedBufferGeometry>[]) {
    assert.ok(!mesh.name.includes('previous'), 'comparison requires settled fades');
    hash.update(mesh.name);
    for (const name of ['voxelOffset', 'voxelSpan', 'voxelDirection', 'voxelEmission', 'color']) {
      const attribute = mesh.geometry.getAttribute(name), array = attribute.array;
      hash.update(new Uint8Array(array.buffer, array.byteOffset,
        mesh.geometry.instanceCount * attribute.itemSize * array.BYTES_PER_ELEMENT));
    }
  }
  return hash.digest('hex');
}

test('hidden settled tiles finish arena publication before the first camera turn', async () => {
  const handoff = new TerrainHandoff();
  const layer = new DistantVoxelLayer(handoff.texture, { synchronous: true });
  const visible = new THREE.Frustum();
  for (const plane of visible.planes) plane.set(new THREE.Vector3(), 1);
  const hidden = visible.clone(); hidden.planes[0].constant = -10000;
  const update = (view: THREE.Frustum) => layer.updateView(view, camera, 720, 1, 32768, 100000);
  try {
    update(hidden); layer.setMergedBuffersEnabled(true); layer.install(source());
    await delay(TERRAIN_FADE_MS + 10);
    for (let i = 0; i < 100; i++) {
      update(hidden);
      if (!layer.hasPendingWork && !layer.hasPendingTransitions) break;
    }
    assert.equal(layer.hasPendingWork, false);
    const stats = layer.group.userData.voxelArenaStats;
    assert.ok(stats.residentFaces > 0, 'offscreen unowned faces must already reside in shared storage');
    assert.equal(stats.visibleFaces, 0);
    const sources = layer.group.children.filter(mesh => mesh.userData.voxelArenaCompatible) as THREE.Mesh[];
    assert.ok(sources.every(mesh => mesh.material === mesh.userData.opaqueMaterial));
    assert.ok(sources.every(mesh => !mesh.geometry.getAttribute('voxelOffset')));
    const pages = stats.pages, faces = stats.residentFaces;
    update(visible);
    assert.equal(stats.pages, pages, 'turning must not create more GPU pages');
    assert.equal(stats.residentFaces, faces);
    assert.equal(stats.copyFaces, 0, 'turning must not repack resident faces');
    assert.equal(layer.hasPendingWork, false);
    assert.ok(stats.visibleFaces > 0);
  } finally { layer.dispose(); handoff.texture.dispose(); }
});

for (const backend of ['worker', 'cooperative'] as const) test(`${backend} preserves geometry, budgets and rotation residency`, async () => {
  const handoff = new TerrainHandoff(), snapshot = source();
  const layer = new DistantVoxelLayer(handoff.texture, { workerFactory: () => backend === 'worker'
    ? new NodeVoxelLodWorker() : createCooperativeVoxelLodPort() });
  const reference = new DistantVoxelLayer(handoff.texture, { synchronous: true });
  try {
    layer.install(snapshot);
    assert.equal(layer.hasZone(16, 2), false, 'queued input must not claim render coverage');
    assert.equal(layer.group.children.length, 0, 'install must not synchronously index or publish');
    reference.install(snapshot);
    await drain(layer); await drain(reference);
    assert.equal(layer.hasZone(16, 2), true);
    assert.deepEqual(layer.group.userData.voxelLodStats, reference.group.userData.voxelLodStats);
    assert.equal(geometryDigest(layer), geometryDigest(reference));
    assert.equal(snapshot.voxelMips![0].faces.length, 128 * 16, 'source buffers must not be detached');
    const publications = layer.group.userData.voxelLodWorkStats.publications;
    const backwards = frustum.clone(); backwards.planes[0].constant -= 10000;
    layer.updateView(backwards, camera, 720, 1, 32768, 100000);
    assert.equal(layer.hasPendingWork, false);
    assert.equal(layer.group.userData.voxelLodWorkStats.publications, publications);
    assert.ok(layer.group.children.every(mesh => !mesh.visible), 'turns affect culling immediately');
    await drain(layer, 1, 2); await drain(reference, 1, 2);
    assert.ok(layer.group.userData.voxelLodStats.effectiveAreaPx2 > 1);
    assert.equal(geometryDigest(layer), geometryDigest(reference));
    await drain(layer); await drain(reference);
    assert.equal(layer.group.userData.voxelLodStats.effectiveAreaPx2, 1);
    assert.equal(geometryDigest(layer), geometryDigest(reference));
  } finally { layer.dispose(); reference.dispose(); handoff.texture.dispose(); }
});

test('replacement retains coverage, rejects stale revisions and remove/reinstall cannot resurrect old output', async () => {
  const handoff = new TerrainHandoff();
  const layer = new DistantVoxelLayer(handoff.texture, { workerFactory: () => new NodeVoxelLodWorker() });
  try {
    layer.install(source(1, 30)); await drain(layer);
    const before = [...layer.group.children];
    layer.install(source(2, 90)); tick(layer);
    assert.ok(before.every(mesh => layer.group.children.includes(mesh)), 'old geometry survives preparation');
    assert.equal(layer.hasZone(16, 2), true);
    layer.install(source(3, 180)); layer.install(source(2, 60));
    await drain(layer);
    for (const mesh of layer.group.children as THREE.Mesh[]) assert.equal(mesh.geometry.getAttribute('color').getX(0), 180 / 255);
    layer.install(source(4, 45)); tick(layer);
    layer.removeZone(16, 2);
    assert.equal(layer.group.children.length, 0);
    layer.install(source(5, 220)); await drain(layer);
    for (const mesh of layer.group.children as THREE.Mesh[]) assert.equal(mesh.geometry.getAttribute('color').getX(0), 220 / 255);
    layer.setActive(false); layer.removeZone(16, 2); layer.setActive(true);
    tick(layer);
    assert.equal(layer.group.children.length, 0);
    assert.equal(layer.hasPendingWork, false);
  } finally { layer.dispose(); handoff.texture.dispose(); }
});

test('worker creation and runtime failures fall back without abandoning pending terrain', async () => {
  for (const failure of ['creation', 'runtime'] as const) {
    let port: VoxelLodPort;
    const handoff = new TerrainHandoff();
    const layer = new DistantVoxelLayer(handoff.texture, { workerFactory: () => {
      if (failure === 'creation') throw new Error('fixture: workers unavailable');
      return port = { onmessage: null, onerror: null, postMessage() {}, terminate() {} };
    } });
    try {
      layer.install(source()); tick(layer);
      if (failure === 'runtime') port!.onerror?.({ message: 'fixture: worker lost' });
      await drain(layer);
      assert.equal(layer.group.userData.voxelLodWorkStats.backend, 'cooperative');
      assert.equal(layer.hasZone(16, 2), true);
      assert.equal(layer.preparationError, null, 'successful cooperative fallback must not block entry');
    } finally { layer.dispose(); handoff.texture.dispose(); }
  }
});

test('source transfers are bounded per frame and identical immutable sources do no work', async () => {
  const commands: VoxelLodCommand[] = [], handoff = new TerrainHandoff();
  const layer = new DistantVoxelLayer(handoff.texture, { workerFactory: () => ({
    onmessage: null, onerror: null, postMessage(command) { commands.push(command); }, terminate() {},
  }) });
  const snapshot = source(1, 128, 100000);
  try {
    layer.install(snapshot);
    assert.equal(commands.length, 0, 'no full snapshot clone at install time');
    for (let i = 0; i < 50 && !commands.some(command => command.type === 'end'); i++) {
      commands.length = 0; tick(layer);
      const bytes = commands.reduce((sum, command) => sum + (command.type === 'part' ? command.bytes.byteLength : 0), 0);
      assert.ok(bytes <= 512 * 1024 && bytes <= VOXEL_PUBLICATION_BUDGET_BYTES);
      assert.ok(commands.every(command => command.type !== 'part' || command.bytes.byteLength <= 256 * 1024));
    }
    assert.ok(commands.some(command => command.type === 'end'));
    commands.length = 0;
    layer.install({ ...snapshot }); tick(layer);
    assert.ok(!commands.some(command => command.type === 'begin'), 'same retained source skips reindexing');
  } finally { layer.dispose(); handoff.texture.dispose(); }
});

test('prepared publication adopts arrays and never hides an unbudgeted third generation', () => {
  const root = new THREE.Group();
  const batch = new SurfaceBatch(root, 'prepared', new THREE.Sphere(), () =>
    new THREE.Mesh(new THREE.InstancedBufferGeometry(), new THREE.MeshStandardNodeMaterial()));
  const a = new THREE.InstancedBufferAttribute(new Uint16Array([1, 2, 3]), 3);
  const b = new THREE.InstancedBufferAttribute(new Uint16Array([4, 5, 6]), 3);
  try {
    batch.submitPrepared({ voxelOffset: a }, 1, false, 0);
    assert.equal(batch.top.geometry.getAttribute('voxelOffset'), a);
    const old = batch.top;
    batch.submitPrepared({ voxelOffset: b }, 1, true, 10);
    assert.equal(old.geometry.getAttribute('voxelOffset'), a);
    assert.equal(batch.submitPrepared({ voxelOffset: a }, 1, true, 20), false);
    batch.advance(TERRAIN_FADE_MS + 11);
    assert.equal(batch.top.geometry.getAttribute('voxelOffset'), b);
    assert.equal(root.children.length, 1);
  } finally { batch.dispose(); }
});

test('publication obeys the byte budget across frames and empty tiles clear old coverage', async () => {
  let port: VoxelLodPort;
  const commands: VoxelLodCommand[] = [], handoff = new TerrainHandoff();
  const layer = new DistantVoxelLayer(handoff.texture, { workerFactory: () => port = {
    onmessage: null, onerror: null, postMessage(command) { commands.push(command); }, terminate() {},
  } });
  try {
    layer.install(source()); tick(layer);
    const begin = commands.find(command => command.type === 'begin')!;
    const build = commands.find(command => command.type === 'build')!;
    assert.ok(begin.type === 'begin' && build.type === 'build');
    const tiles: VoxelLodTile[] = [0, 1, 2].map(tile => ({ key: begin.key, token: begin.token, tile,
      count: 30000, bounds: [0, 0, 0, 100], flatBounds: [0, 128, 0, 128],
      offset: new Uint16Array(90000), span: new Uint16Array(60000),
      color: new Uint8Array(90000), direction: new Uint8Array(30000), emission: new Uint8Array(30000) }));
    const first = tiles[0];
    port!.onmessage?.({ data: { type: 'tiles', id: build.id, tiles } });
    tick(layer);
    assert.ok(layer.group.userData.voxelLodWorkStats.publications < 3, '1.35 MB cannot all publish in one frame');
    for (let i = 0; i < 10 && layer.group.userData.voxelLodWorkStats.publications < 3; i++) {
      tick(layer);
      assert.ok(layer.group.userData.voxelLodWorkStats.publicationBytes <= VOXEL_PUBLICATION_BUDGET_BYTES);
    }
    assert.equal(layer.group.userData.voxelLodWorkStats.publications, 3);
    assert.ok(commands.some(command => command.type === 'ack'));
    const empty = { ...first, count: 0, offset: new Uint16Array(0), span: new Uint16Array(0),
      color: new Uint8Array(0), direction: new Uint8Array(0), emission: new Uint8Array(0) };
    port!.onmessage?.({ data: { type: 'tiles', id: build.id, tiles: [empty] } });
    tick(layer);
    await delay(TERRAIN_FADE_MS + 10); tick(layer);
    assert.ok(!layer.group.children.some(mesh => mesh.name.includes(':0:')), 'removed geometry fades out completely');
  } finally { layer.dispose(); handoff.texture.dispose(); }
});

test('shared immutable sources survive alias removal and continue using live sources', async () => {
  const handoff = new TerrainHandoff(), snapshot = source();
  const layer = new DistantVoxelLayer(handoff.texture, { workerFactory: () => new NodeVoxelLodWorker() });
  try {
    layer.install(snapshot);
    layer.install({ ...snapshot, zoneX: 17 });
    await drain(layer);
    assert.ok(layer.hasZone(16, 2) && layer.hasZone(17, 2));
    layer.removeZone(17, 2);
    layer.install({ ...snapshot, zoneX: 18 });
    await drain(layer);
    assert.ok(layer.hasZone(16, 2) && layer.hasZone(18, 2));
    assert.equal(layer.group.userData.voxelLodWorkStats.error, '');
  } finally { layer.dispose(); handoff.texture.dispose(); }
});

test('movement coalesces behind an in-flight build and settles at the latest view', async () => {
  const handoff = new TerrainHandoff();
  const layer = new DistantVoxelLayer(handoff.texture, { workerFactory: () => new NodeVoxelLodWorker() });
  const reference = new DistantVoxelLayer(handoff.texture);
  try {
    const snapshot = source(1, 128, 10000);
    layer.install(snapshot); reference.install(snapshot);
    for (let i = 0; i < 30; i++) {
      layer.updateView(frustum, bendPoint(8000 + i * 8, 120, 1032), 720, 1, 32768, 100000);
      await delay(2);
    }
    await drain(layer); await drain(reference);
    assert.equal(layer.hasPendingWork, false);
    assert.equal(geometryDigest(layer), geometryDigest(reference));
  } finally { layer.dispose(); reference.dispose(); handoff.texture.dispose(); }
});
