import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MicroVoxelLayer } from '../src/voxel/MicroVoxelLayer.ts';
import { DistantSurfaceLayer } from '../src/render/DistantSurfaceLayer.ts';
import { bendPoint } from '../src/torus/TorusWorld.ts';
import { getTerrainKernels, setTerrainKernelMode, type TerrainKernelMode } from '../src/wasm/TerrainKernels.ts';
import { prepareSurfaceSelection } from '../src/wasm/SurfaceSelection.ts';
import type { SurfaceZoneSnapshot } from '../src/voxel/SurfaceZoneSnapshot.ts';

function microSnapshot(layer: MicroVoxelLayer) {
  return [...layer.meshChunks].sort(([a], [b]) => a.localeCompare(b)).map(([key, mesh]) => ({
    key, attributes: Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([name, attr]) => [name, attr.array.slice()])),
    indices: mesh.geometry.index!.array.slice(), groups: mesh.geometry.groups,
    position: mesh.position.toArray(), sphere: mesh.userData.bentSphere,
  }));
}

function populateMicro(layer: MicroVoxelLayer) {
  for (let x = 0; x < 18; x++) for (let y = 1; y < 19; y++) for (let z = 0; z < 18; z++) {
    if ((x * 17 + y * 11 + z * 13) % 5 === 0) continue;
    const color = [0, 0xffffff, 0x12abef, 0x806030][(x + y + z) % 4];
    layer.set(x, y, z, color, null, (x + z) % 2);
  }
  for (const x of [0, 131071]) for (const z of [0, 16383]) for (const y of [1999, 2000]) {
    layer.set(x, y, z, 0xff8800, null, y % 2);
  }
}

for (const enabled of [true, false]) test(`WASM micro geometry matches JS byte-for-byte (color management ${enabled})`, () => {
  const previous = setTerrainKernelMode('js'), colorManagement = THREE.ColorManagement.enabled;
  const js = new MicroVoxelLayer(), wasm = new MicroVoxelLayer();
  try {
    THREE.ColorManagement.enabled = enabled;
    populateMicro(js); populateMicro(wasm);
    js.updateMesh();
    setTerrainKernelMode('wasm'); wasm.updateMesh();
    assert.deepEqual(microSnapshot(wasm), microSnapshot(js));
  } finally {
    setTerrainKernelMode(previous); THREE.ColorManagement.enabled = colorManagement;
  }
});

test('WASM micro halo packing can pause, survive other kernel calls, and reject an edited revision', t => {
  const previous = setTerrainKernelMode('wasm');
  const layer = new MicroVoxelLayer() as any;
  try {
    layer.set(0, 16, 0, 0xffffff); layer.updateMesh();
    const mesh = layer.mesh;
    populateMicro(layer);
    let now = 0;
    const timer = t.mock.method(performance, 'now', () => ++now);
    for (let i = 0; i < 200 && layer.activeMeshBuild?.phase !== 'wasm-pack'; i++) {
      layer.updateMesh(Infinity, null, null, 0);
    }
    assert.equal(layer.activeMeshBuild?.phase, 'wasm-pack');
    assert.equal(layer.mesh, mesh, 'staging must not replace live geometry');
    layer.set(0, 16, 0, 0xff0055, null, 1);
    const records = new Uint8Array(8 * 4);
    for (let i = 0; i < 5000 && layer.dirty; i++) {
      getTerrainKernels()!.reduceSurfaceRecords(records, 2);
      layer.updateMesh(Infinity, null, null, 0);
    }
    timer.mock.restore();
    assert.equal(layer.dirty, false);
    const expected = new MicroVoxelLayer();
    populateMicro(expected); expected.set(0, 16, 0, 0xff0055, null, 1);
    setTerrainKernelMode('js'); expected.updateMesh();
    assert.deepEqual(microSnapshot(layer), microSnapshot(expected));
  } finally { setTerrainKernelMode(previous); }
});

test('WASM micro meshing retains every face in a worst-case checkerboard partition', () => {
  const previous = setTerrainKernelMode('js');
  try {
    const js = new MicroVoxelLayer(), wasm = new MicroVoxelLayer();
    for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) {
      if ((x + y + z) % 2) continue;
      js.set(x, y, z, 0x0088ff, null, y % 2); wasm.set(x, y, z, 0x0088ff, null, y % 2);
    }
    js.updateMesh(); setTerrainKernelMode('wasm'); wasm.updateMesh();
    assert.equal(wasm.meshChunks.get('0,0,0')!.geometry.index!.count, 2048 * 6 * 6);
    assert.deepEqual(microSnapshot(wasm), microSnapshot(js));
  } finally { setTerrainKernelMode(previous); }
});

function zone(sampleSize: number, zoneX = 0, zoneZ = 0): SurfaceZoneSnapshot {
  const count = (512 / sampleSize) ** 2;
  const heightsMicro = Uint16Array.from({ length: count }, (_, i) => i % 17 === 0 ? 0 : 120 + i % 71);
  return { sampleSize, zoneX, zoneZ, seed: 20260922, terrainGeneratorVersion: 2,
    sourceTerrainRevision: 0, zoneSizeChunks: 32, samplesPerChunkAxis: 16 / sampleSize,
    heightsMicro, minHeightsMicro: Uint16Array.from(heightsMicro, h => Math.max(0, h - 25)),
    colors: Uint8Array.from({ length: count * 3 }, (_, i) => (i * 13) & 255), colorErrors: new Uint8Array(count).fill(20) };
}

function surfaceSnapshot(layer: DistantSurfaceLayer) {
  return [layer.mesh, layer.sideMesh].map(mesh => ({ count: mesh.geometry.instanceCount,
    attributes: Object.fromEntries(Object.entries(mesh.geometry.attributes)
      .filter(([, a]) => a instanceof THREE.InstancedBufferAttribute)
      .map(([name, a]) => [name, a.array.slice(0, mesh.geometry.instanceCount * a.itemSize)])),
  }));
}

async function surfaceScenario(mode: TerrainKernelMode) {
  setTerrainKernelMode(mode);
  const layer = new DistantSurfaceLayer(), snapshots = [];
  try {
    layer.installZone(zone(4)); layer.installZone(zone(16, 31, 3)); layer.installZone(zone(64, 16, 2));
    const camera = new THREE.PerspectiveCamera(75, 1.6, 0.1, 10000);
    for (const [x, y, z] of [[0, 100, 0], [20, 95, 20], [16360, 150, 2030], [8192, 80, 1024], [0, 100, 0]]) {
      camera.position.copy(bendPoint(x, y, z)); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
      layer.updateView(camera, 1000);
      await layer.finalizeConnections(); snapshots.push(surfaceSnapshot(layer));
    }
    layer.setDetailChunkReady(0, 0, true); layer.setDetailChunkReady(1023, 127, true);
    await layer.finalizeConnections(); snapshots.push(surfaceSnapshot(layer));
    layer.installZone({ ...zone(2), sourceTerrainRevision: 1 });
    await layer.finalizeConnections(); snapshots.push(surfaceSnapshot(layer));
    layer.setDetailChunkReady(0, 0, false); layer.removeZone(31, 3);
    await layer.finalizeConnections(); snapshots.push(surfaceSnapshot(layer));
    for (const subdivisionSizePx2 of [1, 256, 63]) {
      layer.setSettings({ subdivisionSizePx2 });
      await layer.finalizeConnections(); snapshots.push(surfaceSnapshot(layer));
    }
    return snapshots;
  } finally { layer.setEnabled(false); }
}

test('WASM LOD matches JS through camera motion, hysteresis, torus seams, handoff and source replacement', async () => {
  const previous = setTerrainKernelMode('js');
  try { assert.deepEqual(await surfaceScenario('wasm'), await surfaceScenario('js')); }
  finally { setTerrainKernelMode(previous); }
});

test('WASM subdivision is bounded, respects capacity, and retains caller-owned state across yields', () => {
  const previous = setTerrainKernelMode('wasm');
  try {
    const kernel = getTerrainKernels()!, fixture = zone(1), lookup = Uint8Array.from({ length: 256 }, (_, i) => i);
    const mips = kernel.buildSurfaceMips(fixture, lookup), mask = new Uint8Array(1024 * 128).fill(255);
    const root = prepareSurfaceSelection(mips, 1, 0, 0, 0, 0, mask, new Uint8Array(683), bendPoint(0, 80, 0), 32768, 63, 720);
    let leaves = 0, calls = 0;
    while (root.work[0]) {
      const result = kernel.selectSurfaceBatch(root, 0);
      assert.ok(result.length <= 256 * 3);
      leaves += result.length / 3; calls++;
      kernel.reduceSurfaceRecords(new Uint8Array(32), 2);
    }
    assert.equal(leaves, 4096); assert.ok(calls > 16);
    root.work.set([3, 0, 0, 64]);
    assert.notDeepEqual(kernel.selectSurfaceBatch(root, 491520), new Int32Array([0, 0, 64]),
      'the previous geometry ceiling must not silently disable high-detail refinement');
    root.work.set([3, 0, 0, 64]);
    assert.deepEqual(kernel.selectSurfaceBatch(root, 1015808), new Int32Array([0, 0, 64]));
  } finally { setTerrainKernelMode(previous); }
});

test('WASM connection sessions are isolated across rebuilds and other terrain calls', () => {
  const previous = setTerrainKernelMode('wasm');
  try {
    const kernel = getTerrainKernels()!, mask = new Uint8Array(1024 * 128);
    const a = kernel.createSurfaceConnections(2, mask)!, b = kernel.createSurfaceConnections(1, mask)!;
    const cell = new Int32Array([0, 0, 1, 200]);
    a.add(cell); a.add(new Int32Array([1, 0, 1, 180])); b.add(cell);
    const first = a.edges(cell);
    b.edges(cell); kernel.reduceSurfaceRecords(new Uint8Array(32), 2);
    assert.deepEqual(a.edges(cell), first); assert.notDeepEqual(b.edges(cell), first);
    assert.throws(() => b.add(cell), /capacity/);
    assert.throws(() => b.edges(new Int32Array([0, 0, 0, 200])), /Invalid surface cell/);
    assert.throws(() => b.edges(new Int32Array([1, 0, 2, 200])), /Invalid surface cell/);
    assert.ok(kernel.createSurfaceConnections(1048576, mask), 'maximum LOD budget still fits the bounded WASM arena');
    assert.equal(kernel.createSurfaceConnections(1048577, mask), null);
  } finally { setTerrainKernelMode(previous); }
});
