import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { bendPoint } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import type { SurfaceByteCache } from '../src/bootstrap/SurfaceDiskCache.ts';
import {
  createSpaceSurfaceSnapshotRemote,
  parseSurfaceZoneSnapshot,
  SURFACE_ZONE_HEADER_BYTES,
  LEGACY_SURFACE_ZONE_RECORD_BYTES as SURFACE_ZONE_RECORD_BYTES,
} from '../src/bootstrap/SpaceSurfaceSnapshot.ts';
import {
  DISTANT_SURFACE_SETTING_LIMITS,
  MAX_DISTANT_SURFACE_CELLS,
  DistantSurfaceLayer,
  normalizeDistantSurfaceSettings,
} from '@entropydrop/space-engine/render/DistantSurfaceLayer.ts';

function makeZoneBytes(zoneX = 0, zoneZ = 0, filled = false) {
  const records = 32 * 32 * 8 * 8;
  const bytes = new Uint8Array(SURFACE_ZONE_HEADER_BYTES + records * SURFACE_ZONE_RECORD_BYTES);
  bytes.set([0x45, 0x44, 0x53, 0x5a]);
  const view = new DataView(bytes.buffer);
  view.setUint8(4, 3);
  view.setUint8(5, 8);
  view.setUint8(6, 32);
  view.setUint8(7, 5);
  view.setUint16(8, zoneX, true);
  view.setUint16(10, zoneZ, true);
  view.setInt32(12, 20260827, true);
  view.setUint32(16, 1, true);
  view.setBigUint64(20, 7n, true);
  view.setUint32(28, records, true);
  const fillRecord = (index: number) => {
    const offset = SURFACE_ZONE_HEADER_BYTES + index * SURFACE_ZONE_RECORD_BYTES;
    view.setUint16(offset, 136, true);
    bytes.set([0x71, 0x8f, 0x61], offset + 2);
  };
  if (filled) {
    for (let index = 0; index < records; index++) fillRecord(index);
  } else {
    fillRecord(0);
  }
  return bytes;
}

function makeCoarseBytes(zoneX = 0, zoneZ = 0, size = 64, revision = 7) {
  const bytes = new Uint8Array(32 + (512 / size) ** 2 * 5);
  bytes.set(makeZoneBytes(zoneX, zoneZ).subarray(0, 32));
  const view = new DataView(bytes.buffer);
  view.setUint8(4, 4);
  view.setUint8(5, size);
  view.setBigUint64(20, BigInt(revision), true);
  view.setUint32(28, (512 / size) ** 2, true);
  for (let offset = 32; offset < bytes.length; offset += 5) {
    view.setUint16(offset, 136, true);
    bytes.set([0x71, 0x8f, 0x61], offset + 2);
  }
  return bytes;
}

function torusCamera(x = 8192, y = 100, z = 1024) {
  const camera = new THREE.PerspectiveCamera(75, 1.6, 0.1, 10_000);
  camera.position.copy(bendPoint(x, y, z));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

test('surface-zone binary parsing preserves identity, heights and colors', () => {
  const zone = parseSurfaceZoneSnapshot(makeZoneBytes(2, 3));
  assert.equal(zone.zoneX, 2);
  assert.equal(zone.zoneZ, 3);
  assert.equal(zone.seed, 20260827);
  assert.equal(zone.sourceTerrainRevision, 7);
  assert.equal(zone.heightsMicro.length, 65_536);
  assert.equal(zone.heightsMicro[0], 136);
  assert.deepEqual([...zone.colors.subarray(0, 3)], [0x71, 0x8f, 0x61]);
  assert.throws(() => parseSurfaceZoneSnapshot(makeZoneBytes().subarray(0, 40)), /snapshot/);
});

test('pixel-area settings clamp safely and migrate legacy error/distance settings', () => {
  assert.deepEqual(normalizeDistantSurfaceSettings({ subdivisionSizePx2: 0, renderDistanceChunks: 1,
    dataBudgetMiB: Infinity, lod32Distance: 3000, connectionDistance: 0 } as any),
  { subdivisionSizePx2: 1, renderDistanceChunks: 32, dataBudgetMiB: 256 });
  assert.deepEqual(normalizeDistantSurfaceSettings({ lod2Enabled: false } as any),
    { subdivisionSizePx2: 63, renderDistanceChunks: 2048, dataBudgetMiB: 256 });
  assert.deepEqual(normalizeDistantSurfaceSettings({ screenErrorPx: 0.5, maxDistance: 8500, dataBudgetMiB: 1024 } as any),
    { subdivisionSizePx2: 63, renderDistanceChunks: 2048, dataBudgetMiB: 1024 });
  assert.equal(normalizeDistantSurfaceSettings({ subdivisionSizePx2: 63 }).subdivisionSizePx2, 63);
});

test('pixel budget controls refinement without fixed distance gates', async () => {
    const layer = new DistantSurfaceLayer();
    const zone = parseSurfaceZoneSnapshot(makeZoneBytes(0, 0, true));
    // Tall alternating columns have real refinable detail; an almost flat
    // surface may correctly remain merged under the subpixel-error guard.
    zone.heightsMicro = Uint16Array.from(zone.heightsMicro, (_, i) => 136 + (i % 2) * 160);
    layer.updateView(torusCamera(0, 1000, 0), 1000);
    layer.setSettings({ subdivisionSizePx2: 256 });
    layer.installZone(zone);
    await layer.finalizeConnections();
    const relaxed = layer.mesh.geometry.instanceCount;
    layer.setSettings({ subdivisionSizePx2: 1 });
    await layer.finalizeConnections();
    assert.ok(layer.mesh.geometry.instanceCount > relaxed * 2,
      `1 px^2: ${layer.mesh.geometry.instanceCount}, 256 px^2: ${relaxed}`);
    const limited = new DistantSurfaceLayer();
    limited.setSettings({ renderDistanceChunks: 32 });
    limited.installZone(parseSurfaceZoneSnapshot(makeZoneBytes(4, 0, true)));
    assert.equal(limited.mesh.geometry.instanceCount, 0);
});

test('maximum exposed LOD controls remain within the surface instance budget', async () => {
  const layer = new DistantSurfaceLayer();
  layer.setNearField(512, 64, 8);
  layer.setSettings({ subdivisionSizePx2: DISTANT_SURFACE_SETTING_LIMITS.subdivisionSizePx2.min,
    renderDistanceChunks: DISTANT_SURFACE_SETTING_LIMITS.renderDistanceChunks.max });
  const template = parseSurfaceZoneSnapshot(makeZoneBytes(0, 0, true));
  for (let zoneX = 0; zoneX < 32; zoneX++) {
    for (let zoneZ = 0; zoneZ < 4; zoneZ++) {
      layer.installZone({ ...template, zoneX, zoneZ });
    }
  }
  await layer.finalizeConnections();

  assert.ok(layer.mesh.geometry.instanceCount < 512 * 1024);
});

test('adaptive surface emits 2/4/8/16/32/64 metre tiers instead of every fine sample', async () => {
  const layer = new DistantSurfaceLayer();
  layer.setNearField(0, 0, 8);
  for (let zoneX = 0; zoneX <= 6; zoneX++) {
    layer.installZone(parseSurfaceZoneSnapshot(makeZoneBytes(zoneX, 0, true)));
  }
  await layer.finalizeConnections();

  const count = layer.mesh.geometry.instanceCount;
  const sizeAttribute = layer.mesh.geometry.getAttribute('surfaceSize');
  const usedSizes = new Set<number>();
  for (let index = 0; index < count; index++) usedSizes.add(sizeAttribute.getX(index));
  assert.ok(usedSizes.size >= 3);
  assert.ok(usedSizes.has(64));
  assert.ok(count < 7 * 65_536);
  assert.ok(layer.sideMesh.geometry.instanceCount < count);
});

test('a fully populated torus stays inside the adaptive instance budget', async () => {
  const layer = new DistantSurfaceLayer();
  layer.setNearField(512, 64, 8);
  const template = parseSurfaceZoneSnapshot(makeZoneBytes(0, 0, true));
  for (let zoneX = 0; zoneX < 32; zoneX++) {
    for (let zoneZ = 0; zoneZ < 4; zoneZ++) {
      layer.installZone({ ...template, zoneX, zoneZ });
    }
  }
  await layer.finalizeConnections();

  assert.equal(layer.loadedZones.size, 128);
  assert.ok(layer.mesh.geometry.instanceCount >= 8192);
  assert.ok(layer.mesh.geometry.instanceCount < 350_000);
  assert.ok(layer.sideMesh.geometry.instanceCount < layer.mesh.geometry.instanceCount);
});

test('moving quantizes and frame-slices far topology without dropping the active surface', async () => {
  const layer = new DistantSurfaceLayer();
  layer.setNearField(0, 0, 8);
  layer.installZone(parseSurfaceZoneSnapshot(makeZoneBytes(0, 0, true)));
  await layer.finalizeConnections();
  const activeCount = layer.mesh.geometry.instanceCount;

  layer.setNearField(1, 0, 8);
  assert.equal((layer as any).connectionBuildPending, false);

  layer.setNearField(2, 0, 8);
  assert.ok((layer as any).connectionBuildPending || (layer as any).rebuildTimer);
  assert.equal(layer.mesh.geometry.instanceCount, activeCount);

  await layer.finalizeConnections();
  assert.equal((layer as any).connectionBuildPending, false);
  assert.ok(layer.mesh.geometry.instanceCount > 0);
});

test('backend zones populate one instanced far layer and retain a near-field cutout', async () => {
  const layer = new DistantSurfaceLayer();
  const zone = parseSurfaceZoneSnapshot(makeZoneBytes());
  layer.installZone(zone);
  await layer.finalizeConnections();

  assert.equal(layer.mesh.visible, true);
  assert.equal(layer.loadedZones.has('0,0'), true);
  assert.ok(layer.mesh.geometry.instanceCount > 0);
  assert.ok(layer.mesh.geometry.instanceCount < 65_536);
  assert.equal(layer.mesh.geometry.getAttribute('surfaceHeight').getX(0), 136);
  assert.equal(layer.mesh.geometry.getAttribute('surfaceOffset').getX(0), 0);
  assert.equal(layer.mesh.geometry.getAttribute('surfaceOffset').getY(0), 0);
  assert.equal(layer.mesh.geometry.getAttribute('surfaceSize').getX(0), 2);
  const topPositions = layer.mesh.geometry.getAttribute('position');
  const sidePositions = layer.sideMesh.geometry.getAttribute('position');
  const sideNormals = layer.sideMesh.geometry.getAttribute('normal');
  assert.equal(topPositions.count, 4);
  assert.equal(layer.mesh.geometry.index?.count, 6);
  assert.equal(sidePositions.count, 4);
  assert.equal(layer.sideMesh.geometry.index?.count, 6);
  assert.equal([...Array(sidePositions.count)].some((_, index) => sidePositions.getY(index) === 0), true);
  assert.equal([...Array(sideNormals.count)].every((_, index) => sideNormals.getY(index) === 0), true);
  const colorAttribute = layer.mesh.geometry.getAttribute('color') as THREE.InstancedBufferAttribute;
  const detailedTerrainColor = new THREE.Color().setHex(0x718f61);
  assert.ok(Math.abs(colorAttribute.getX(0) - detailedTerrainColor.r) <= 1 / 255);
  assert.ok(Math.abs(colorAttribute.getY(0) - detailedTerrainColor.g) <= 1 / 255);
  assert.ok(Math.abs(colorAttribute.getZ(0) - detailedTerrainColor.b) <= 1 / 255);

  const material = layer.mesh.material;
  assert.equal(material.isMeshStandardMaterial, true);
  assert.equal(material.flatShading, false, 'curved tops interpolate normals across LOD boundaries');
  assert.equal(material.roughness, 0.65);
  assert.equal(material.metalness, 0.15);
  assert.equal(material.side, THREE.FrontSide);
  assert.equal(layer.mesh.receiveShadow, false);
  assert.equal(layer.sideMesh.receiveShadow, false);
  const shader: any = {
    uniforms: {},
    vertexShader: '#include <common>\n#include <defaultnormal_vertex>\n#include <begin_vertex>\n#include <project_vertex>',
    fragmentShader: '#include <common>\n#include <color_fragment>',
  };
  material.onBeforeCompile(shader, null as any);
  assert.match(shader.vertexShader, /surfaceOffset/);
  assert.match(shader.vertexShader, /TORUS_SURFACE_POSITION/);
  assert.match(shader.vertexShader, /torusBend/);
  assert.match(shader.vertexShader, /position\.y \* surfaceHeight/);
  assert.match(shader.fragmentShader, /uTerrainHandoff/);
  assert.match(shader.fragmentShader, /texture2D/);
  assert.match(shader.fragmentShader, /discard/);

  const sideShader: any = {
    uniforms: {},
    vertexShader: '#include <common>\n#include <defaultnormal_vertex>\n#include <begin_vertex>\n#include <project_vertex>',
    fragmentShader: '#include <common>\n#include <color_fragment>',
  };
  layer.sideMesh.material.onBeforeCompile(sideShader, null as any);
  assert.equal(layer.sideMesh.material.side, THREE.FrontSide, 'correctly wound distant walls need no back-face shading');
  assert.match(sideShader.vertexShader, /surfaceBottomHeight/);
  assert.match(sideShader.vertexShader, /surfaceNormal/);
  assert.match(sideShader.vertexShader, /TORUS_SURFACE_AXIS/);
  assert.match(sideShader.vertexShader, /surfaceWinding/);
  assert.ok(layer.sideMesh.geometry.instanceCount > 0);
  assert.equal(layer.sideMesh.geometry.getAttribute('surfaceHeight').getX(0), 136);
  assert.equal(layer.sideMesh.geometry.getAttribute('surfaceBottomHeight').getX(0), 0);

  const detailMask = layer.detailMaskTexture.image.data as Uint8Array;
  assert.equal(detailMask[0], 0);
  layer.setDetailChunkReady(0, 0, true);
  assert.equal(detailMask[0], 255);
  layer.setDetailChunkReady(-1, -1, true);
  assert.equal(detailMask[detailMask.length - 1], 255);
  layer.setDetailChunkReady(0, 0, false);
  assert.equal(detailMask[0], 0);

  layer.removeZone(0, 0);
  assert.equal(layer.mesh.visible, false);
  assert.equal(layer.sideMesh.visible, false);
  assert.equal(layer.loadedZones.size, 0);
  assert.equal(layer.mesh.geometry.getAttribute('surfaceHeight').getX(0), 0);
});

test('surface connections close sparse terrain at 2000 metres', async () => {
  const layer = new DistantSurfaceLayer();
  layer.setNearField(0, 0, 8);
  layer.installZone(parseSurfaceZoneSnapshot(makeZoneBytes(4, 0)));
  await layer.finalizeConnections();

  assert.equal(layer.mesh.geometry.instanceCount, 1);
  assert.ok(layer.mesh.geometry.getAttribute('surfaceSize').getX(0) <= 64);
  assert.ok(layer.sideMesh.geometry.instanceCount > 0);
  assert.equal(layer.sideMesh.visible, true);
});

test('surface connections remain active around 3000 metres', async () => {
  const layer = new DistantSurfaceLayer();
  layer.setNearField(0, 0, 8);
  layer.installZone(parseSurfaceZoneSnapshot(makeZoneBytes(6, 0)));
  await layer.finalizeConnections();

  assert.equal(layer.mesh.geometry.instanceCount, 1);
  assert.ok(layer.mesh.geometry.getAttribute('surfaceSize').getX(0) <= 64);
  assert.ok(layer.sideMesh.geometry.instanceCount > 0);
  assert.equal(layer.sideMesh.visible, true);
});

test('surface connections remain closed beyond the old 4000 metre cutoff', async () => {
  const layer = new DistantSurfaceLayer();
  layer.setNearField(0, 0, 8);
  layer.installZone(parseSurfaceZoneSnapshot(makeZoneBytes(8, 0)));
  await layer.finalizeConnections();

  assert.equal(layer.mesh.geometry.instanceCount, 1);
  assert.ok(layer.mesh.geometry.getAttribute('surfaceSize').getX(0) <= 64);
  assert.ok(layer.sideMesh.geometry.instanceCount > 0);
  assert.equal(layer.sideMesh.visible, true);
});

test('surface-zone remote verifies and progressively installs manifest entries', async () => {
  const bytes = makeZoneBytes(0, 0);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const requests: { url: string; authorization: string | null }[] = [];
  const fetchImpl = async (input: string | URL | Request, options: RequestInit = {}) => {
    const url = String(input);
    requests.push({
      url,
      authorization: new Headers(options.headers).get('Authorization'),
    });
    if (url.endsWith('/surface-zones')) {
      return Response.json({
        schema_version: 3,
        samples_per_chunk_axis: 8,
        zone_size_chunks: 32,
        width_chunks: 32,
        length_chunks: 32,
        complete: true,
        zones: [{
          zone_x: 0,
          zone_z: 0,
          revision: 1,
          source_terrain_revision: 7,
          digest,
          byte_length: bytes.byteLength,
          url: `/space/api/v2/worlds/world-1/surface-zones/0/0?digest=${digest}`,
        }],
      });
    }
    return new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.entropydrop.surface-zone' },
    });
  };
  const remote = createSpaceSurfaceSnapshotRemote(
    'https://api.entropydrop.com',
    'test-token',
    '/space/api/v2/worlds/world-1/surface-zones',
    20260827,
    1,
    fetchImpl as typeof fetch,
  );
  const installed: string[] = [];
  const result = await remote.loadAll(zone => installed.push(`${zone.zoneX},${zone.zoneZ}`));
  const unchanged = await remote.loadAll(zone => installed.push(`${zone.zoneX},${zone.zoneZ}`));

  assert.deepEqual(result, { loaded: 1, complete: true });
  assert.deepEqual(unchanged, { loaded: 0, complete: true });
  assert.deepEqual(installed, ['0,0']);
  assert.equal(requests.length, 3);
  assert.equal(requests.every(request => request.authorization === 'Bearer test-token'), true);
  assert.match(requests[1].url, /digest=/);
});

test('surface-zone remote never forwards login credentials to a manifest-selected origin', async () => {
  let calls = 0;
  const remote = createSpaceSurfaceSnapshotRemote(
    'https://api.entropydrop.com',
    'test-token',
    '/space/api/v2/worlds/world-1/surface-zones',
    20260827,
    1,
    (async () => {
      calls++;
      return Response.json({
        schema_version: 3,
        samples_per_chunk_axis: 8,
        zone_size_chunks: 32,
        width_chunks: 32,
        length_chunks: 32,
        complete: true,
        zones: [{
          zone_x: 0,
          zone_z: 0,
          revision: 1,
          source_terrain_revision: 0,
          digest: '0'.repeat(64),
          byte_length: SURFACE_ZONE_HEADER_BYTES,
          url: 'https://attacker.invalid/snapshot',
        }],
      });
    }) as typeof fetch,
  );

  await assert.rejects(() => remote.loadAll(() => undefined), /authenticated API origin/);
  assert.equal(calls, 1);
});

test('coarse snapshots validate their lattice and can refine curvature without fine data', async () => {
    const bytes = makeCoarseBytes(16, 2);
    const zone = parseSurfaceZoneSnapshot(bytes);
    assert.equal(zone.sampleSize, 64);
    assert.equal(zone.heightsMicro.length, 64);
    const invalid = bytes.slice();
    invalid[5] = 63;
    assert.throws(() => parseSurfaceZoneSnapshot(invalid), /snapshot/);
    assert.throws(() => parseSurfaceZoneSnapshot(bytes.subarray(0, bytes.length - 1)), /snapshot/);
    const layer = new DistantSurfaceLayer();
    const camera = torusCamera(8192, 32, 1024);
    layer.updateView(camera, 800);
    layer.installZone(zone);
    await layer.finalizeConnections();
    const sizes = layer.mesh.geometry.getAttribute('surfaceSize');
    const count = layer.mesh.geometry.instanceCount;
    assert.ok(count > 64, 'the curved mesh needs more vertices than the 64 coarse records');
    let area = 0;
    for (let index = 0; index < count; index++) area += sizes.getX(index) ** 2;
    assert.equal(area, 512 ** 2, 'refining the mesh must preserve full zone coverage');
});

test('torus screen error preserves full world coverage and culls batches immediately on turns', async () => {
    const layer = new DistantSurfaceLayer();
    layer.setNearField(512, 64, 8);
    const template = parseSurfaceZoneSnapshot(makeZoneBytes(0, 0, true));
    for (let x = 0; x < 32; x++) for (let z = 0; z < 4; z++) {
      layer.installZone({ ...template, zoneX: x, zoneZ: z });
    }
    await layer.finalizeConnections();
    const camera = torusCamera();
    layer.updateView(camera, 800);
    await layer.finalizeConnections();
    assert.ok(layer.mesh.geometry.instanceCount < 128 * 65536 / 10);
    const sizes = layer.mesh.geometry.getAttribute('surfaceSize');
    let area = 0;
    for (let index = 0; index < layer.mesh.geometry.instanceCount; index++) area += sizes.getX(index) ** 2;
    assert.equal(area, 16384 * 2048);
    const visible = () => new Set(layer.mesh.children.filter(mesh => mesh.name.endsWith(':tops') && mesh.visible).map(mesh => mesh.name));
    const forward = visible();
    assert.ok(forward.size > 0 && forward.size < 128 * 16);
    assert.ok([...forward].some(name => name.startsWith('DistantSurface:0,')), 'the opposite ring across the hole stays visible');
    const direction = camera.getWorldDirection(new THREE.Vector3());
    camera.lookAt(camera.position.clone().sub(direction));
    camera.updateMatrixWorld(true);
    layer.updateView(camera, 800);
    assert.notDeepEqual(visible(), forward, 'turning changes draw visibility before any asynchronous rebuild');
    assert.equal(layer.mesh.geometry.drawRange.count, 0, 'aggregate buffers must not be drawn again');
    const batches = layer.mesh.children.filter(mesh => mesh.name.endsWith(':tops')) as THREE.Mesh<THREE.InstancedBufferGeometry>[];
    assert.equal(batches.reduce((sum, mesh) => sum + mesh.geometry.instanceCount, 0), layer.mesh.geometry.instanceCount);
});

test('replacing coarse data publishes complete batches and rejects an older terrain revision', async () => {
    const layer = new DistantSurfaceLayer();
    layer.updateView(torusCamera(8192, 32, 1024), 800);
    layer.installZone(parseSurfaceZoneSnapshot(makeCoarseBytes(16, 2)));
    await layer.finalizeConnections();
    const original = layer.mesh.children.find(mesh => mesh.name === 'DistantSurface:16,2:0,0:tops') as THREE.Mesh;
    const originalHeights = original.geometry.getAttribute('surfaceHeight').array.slice();
    const fine = parseSurfaceZoneSnapshot(makeZoneBytes(16, 2, true));
    fine.sourceTerrainRevision = 8;
    fine.heightsMicro.fill(160);
    layer.installZone(fine);
    assert.ok(layer.mesh.children.includes(original), 'the old draw stays attached during staging');
    await layer.finalizeConnections();
    assert.deepEqual(original.geometry.getAttribute('surfaceHeight').array, originalHeights,
      'staging must not mutate active buffer storage');
    const replacement = layer.mesh.children.find(mesh => mesh.name === 'DistantSurface:16,2:0,0:tops') as THREE.Mesh;
    assert.notEqual(replacement, original);
    assert.equal(replacement.geometry.getAttribute('surfaceHeight').getX(0), 160);
    layer.installZone(parseSurfaceZoneSnapshot(makeCoarseBytes(16, 2, 64, 7)));
    assert.equal(layer.mesh.children.find(mesh => mesh.name === replacement.name), replacement);
});

test('streaming installs every overview before refinement, then evicts offscreen fine data', async () => {
  const payloads = new Map<string, Uint8Array>();
  const manifest = {
    schema_version: 3, samples_per_chunk_axis: 8, zone_size_chunks: 32,
    width_chunks: 64, length_chunks: 32, complete: true,
    zones: [0, 1].map(x => {
      const fine = makeZoneBytes(x, 0, true);
      const coarse = makeCoarseBytes(x, 0);
      const entry = (bytes: Uint8Array, size: number) => {
        const url = `/zones/${x}/${size}`;
        payloads.set(url, bytes);
        return { sample_size: size, url, byte_length: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') };
      };
      return { zone_x: x, zone_z: 0, revision: 1, source_terrain_revision: 7,
        ...entry(fine, 2), lods: [entry(coarse, 64)] };
    }),
  };
  const requests: string[] = [];
  const remote = createSpaceSurfaceSnapshotRemote('https://api.entropydrop.com', 'token', '/surface-zones', 20260827, 1,
    (async input => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      return path === '/surface-zones' ? Response.json(manifest) : new Response(payloads.get(path)!.slice().buffer);
    }) as typeof fetch);
  let focus = 0;
  const installed: string[] = [];
  let budget = 700_000;
  const options = { getZoneDemand: (x: number) => ({ sampleSize: x === focus ? 2 : 64, priority: x === focus ? 0 : 1 }),
    getDataBudgetBytes: () => budget };
  await remote.loadAll(zone => installed.push(`${zone.zoneX}:${zone.sampleSize ?? 2}`), undefined, options);
  assert.deepEqual(installed.slice(0, 2).sort(), ['0:64', '1:64']);
  assert.deepEqual(installed.slice(2), ['0:2']);
  focus = 1;
  await remote.loadAll(zone => installed.push(`${zone.zoneX}:${zone.sampleSize ?? 2}`), undefined, options);
  assert.deepEqual(installed.slice(3), ['1:2'], 'looking away retains detail while it fits in the budget');
  budget = 400_000;
  await remote.loadAll(zone => installed.push(`${zone.zoneX}:${zone.sampleSize ?? 2}`), undefined, options);
  assert.deepEqual(installed.slice(4), ['0:64'], 'current visible demand evicts retained detail when necessary');
  assert.equal(requests.filter(path => path === '/surface-zones').length, 1, 'camera demand must not poll metadata every second');
  assert.equal(requests.filter(path => path === '/zones/0/64').length, 1, 'eviction reuses the bounded coarse cache');
  assert.equal(requests.filter(path => path.endsWith('/2')).length, 2);
});

test('LOD snapshots cannot spoof the manifest terrain revision', async () => {
  const bytes = makeCoarseBytes(0, 0, 64, 6);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const remote = createSpaceSurfaceSnapshotRemote('https://api.entropydrop.com', 'token', '/surface-zones', 20260827, 1,
    (async input => String(input).endsWith('/surface-zones') ? Response.json({
      schema_version: 3, samples_per_chunk_axis: 8, zone_size_chunks: 32,
      width_chunks: 32, length_chunks: 32, complete: true,
      zones: [{ zone_x: 0, zone_z: 0, revision: 1, source_terrain_revision: 7,
        digest: '0'.repeat(64), byte_length: 327712, url: '/fine',
        lods: [{ sample_size: 64, digest, byte_length: bytes.length, url: '/coarse' }] }],
    }) : new Response(bytes)) as typeof fetch);
  await assert.rejects(remote.loadAll(() => assert.fail('untrusted snapshot installed'), undefined,
    { getZoneDemand: () => ({ sampleSize: 64, priority: 0 }) }), /identity mismatch/);
});

test('surface-zone remote retries on HTTP 429 and succeeds', async () => {
  const bytes = makeCoarseBytes(0, 0, 64, 7);
  const digest = createHash('sha256').update(bytes).digest('hex');
  let attempts = 0;
  const remote = createSpaceSurfaceSnapshotRemote('https://api.entropydrop.com', 'token', '/surface-zones', 20260827, 1,
    (async input => {
      if (String(input).endsWith('/surface-zones')) {
        return Response.json({
          schema_version: 3, samples_per_chunk_axis: 8, zone_size_chunks: 32,
          width_chunks: 32, length_chunks: 32, complete: true,
          zones: [{ zone_x: 0, zone_z: 0, revision: 1, source_terrain_revision: 7,
            digest: '0'.repeat(64), byte_length: 327712, url: '/fine',
            lods: [{ sample_size: 64, digest, byte_length: bytes.length, url: '/coarse' }] }],
        });
      }
      attempts++;
      if (attempts === 1) {
        return new Response('Too many requests', { status: 429, headers: { 'Retry-After': '0' } });
      }
      return new Response(bytes);
    }) as typeof fetch);
  const installed: number[] = [];
  await remote.loadAll(zone => installed.push(zone.zoneX), undefined, { getZoneDemand: () => ({ sampleSize: 64, priority: 0 }) });
  assert.equal(attempts, 2, 'should have retried once after 429');
  assert.deepEqual(installed, [0]);
});


test('visible refinements stay within the raw working-set budget', async () => {
  const payloads = new Map<string, Uint8Array>();
  const zones = Array.from({ length: 16 }, (_, x) => {
    const entry = (size: number) => {
      const bytes = size === 2 ? makeZoneBytes(x, 0, true) : makeCoarseBytes(x, 0);
      const url = `/zones/${x}/${size}`;
      payloads.set(url, bytes);
      return { sample_size: size, url, byte_length: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') };
    };
    return { zone_x: x, zone_z: 0, revision: 1, source_terrain_revision: 7, ...entry(2), lods: [entry(64)] };
  });
  const remote = createSpaceSurfaceSnapshotRemote('https://api.entropydrop.com', 'token', '/surface-zones', 20260827, 1,
    (async input => {
      const path = new URL(String(input)).pathname;
      return path === '/surface-zones' ? Response.json({ schema_version: 3, samples_per_chunk_axis: 8,
        zone_size_chunks: 32, width_chunks: 512, length_chunks: 32, complete: true, zones,
      }) : new Response(payloads.get(path)!.slice().buffer);
    }) as typeof fetch);
  const installed = new Map<number, number>();
  await remote.loadAll(zone => installed.set(zone.zoneX, zone.sampleSize ?? 2), undefined,
    { getZoneDemand: x => ({ sampleSize: 2, priority: x }) });
  assert.equal(installed.size, 16, 'every zone must retain an overview');
  assert.equal([...installed.values()].filter(size => size === 2).length, 12);
  assert.equal(installed.get(0), 2, 'nearer zones get the budget first');
  assert.equal(installed.get(15), 64);
});

test('extreme zoom preserves whole-torus coverage within the geometry budget', async () => {
    const layer = new DistantSurfaceLayer();
    const template = parseSurfaceZoneSnapshot(makeCoarseBytes());
    for (let x = 0; x < 32; x++) for (let z = 0; z < 4; z++) {
      layer.installZone({ ...template, zoneX: x, zoneZ: z });
    }
    layer.updateView(torusCamera(), 1_000_000);
    await layer.finalizeConnections();
    const count = layer.mesh.geometry.instanceCount;
    assert.ok(count <= MAX_DISTANT_SURFACE_CELLS && count > 8192);
    const sizes = layer.mesh.geometry.getAttribute('surfaceSize');
    let area = 0;
    for (let i = 0; i < count; i++) area += sizes.getX(i) ** 2;
    assert.equal(area, 16384 * 2048, 'budget fallback must coarsen, never leave missing roots');
});

test('reenabling the torus stages current data and never resurrects a removed zone', async () => {
    const layer = new DistantSurfaceLayer();
    layer.installZone(parseSurfaceZoneSnapshot(makeCoarseBytes()));
    await layer.finalizeConnections();
    layer.setEnabled(false);
    layer.installZone(parseSurfaceZoneSnapshot(makeCoarseBytes(1, 0)));
    layer.setEnabled(true);
    assert.equal(layer.mesh.visible, false, 'enabling must wait for current data instead of blocking on a rebuild');
    layer.updateView(torusCamera(), 800);
    await layer.finalizeConnections();
    assert.equal(layer.mesh.visible, true);
    layer.setEnabled(false);
    layer.removeZone(0, 0);
    layer.removeZone(1, 0);
    layer.setEnabled(true);
    assert.equal(layer.mesh.visible, false);
    assert.equal(layer.mesh.geometry.instanceCount, 0);
    assert.equal(layer.mesh.children.filter(mesh => mesh.name.startsWith('DistantSurface:')).length, 0);
});

function v5Bytes() {
  const bytes = new Uint8Array(32 + 64 * 8 + 4 + 14 + 15);
  bytes.set(makeCoarseBytes(31, 3).subarray(0, 32));
  const view = new DataView(bytes.buffer);
  view.setUint8(4, 5); view.setUint8(7, 8);
  for (let i = 0; i < 64; i++) {
    view.setUint16(32 + i * 8, 160, true);
    view.setUint16(34 + i * 8, 128, true);
    bytes.set([113, 143, 97, 20], 36 + i * 8);
  }
  let offset = 32 + 64 * 8;
  view.setUint32(offset, 1, true); offset += 4;
  bytes.set([31, 31], offset);
  view.setBigUint64(offset + 2, 123n, true);
  view.setUint32(offset + 10, 1, true); offset += 14;
  [120, 320, 120, 8, 16, 8].forEach((v, i) => view.setUint16(offset + i * 2, v, true));
  bytes.set([255, 0, 0], offset + 12);
  return bytes;
}

test('v5 transmits conservative source errors and vertical solids even in the 64m overview', () => {
  const zone = parseSurfaceZoneSnapshot(v5Bytes());
  assert.equal(zone.sampleSize, 64);
  assert.equal(zone.minHeightsMicro![0], 128);
  assert.equal(zone.colorErrors![0], 20);
  const chunk = zone.detailChunks![0];
  assert.deepEqual([chunk.chunkX, chunk.chunkZ, chunk.revision], [1023, 127, 123]);
  assert.deepEqual([...chunk.boxes], [120, 320, 120, 8, 16, 8]);
  assert.deepEqual([...chunk.colors], [255, 0, 0]);
  assert.throws(() => parseSurfaceZoneSnapshot(v5Bytes().subarray(0, -1)), /surface chunk/);
  const invalid = v5Bytes();
  new DataView(invalid.buffer).setUint16(invalid.length - 15 + 6, 16, true);
  assert.throws(() => parseSurfaceZoneSnapshot(invalid), /solid bounds/);
});

test('downloaded residual error drives data refinement across the ring', async () => {
    const layer = new DistantSurfaceLayer();
    const zone = parseSurfaceZoneSnapshot(makeCoarseBytes(0, 2));
    zone.minHeightsMicro = new Uint16Array(64).fill(40);
    layer.updateView(torusCamera(8192, 100, 1024), 1600);
    layer.installZone(zone);
    assert.ok(layer.getZoneDemand(0, 2).sampleSize < 64);
    layer.setSettings({ subdivisionSizePx2: 256 });
    const relaxed = layer.getZoneDemand(0, 2).sampleSize;
    layer.setSettings({ subdivisionSizePx2: 1 });
    assert.ok(layer.getZoneDemand(0, 2).sampleSize < relaxed);
    await layer.finalizeConnections();
});

test('dirty or temporarily absent manifest entries retain last-good geometry', async () => {
  const bytes = makeCoarseBytes();
  const digest = createHash('sha256').update(bytes).digest('hex');
  const manifest = { schema_version: 3, samples_per_chunk_axis: 8, zone_size_chunks: 32,
    width_chunks: 32, length_chunks: 32, complete: false,
    zones: [{ zone_x: 0, zone_z: 0, revision: 1, source_terrain_revision: 7,
      digest: '0'.repeat(64), byte_length: 327712, url: '/fine',
      lods: [{ sample_size: 64, digest, byte_length: bytes.length, url: '/coarse' }] }] };
  let present = true;
  const remote = createSpaceSurfaceSnapshotRemote('https://api.entropydrop.com', 'token', '/surface-zones', 20260827, 1,
    (async input => String(input).endsWith('/surface-zones')
      ? Response.json({ ...manifest, zones: present ? manifest.zones : [] }) : new Response(bytes)) as typeof fetch);
  const options = { getZoneDemand: () => ({ sampleSize: 64, priority: 0 }) };
  let installed = 0;
  const first = await remote.loadAll(() => installed++, () => assert.fail('dirty is not a deletion'), options);
  assert.equal(first.complete, false);
  present = false;
  await remote.loadAll(() => installed++, () => assert.fail('missing is not a deletion'), options);
  assert.equal(installed, 1);
});

test('authored distant geometry survives coarse replacement, near handoff and stale responses', async () => {
  const layer = new DistantSurfaceLayer();
  const zone = parseSurfaceZoneSnapshot(v5Bytes());
  layer.installZone(zone);
  await layer.finalizeConnections();
  const group = layer.authoredChunks.group;
  assert.equal(group.children.length, 1);
  const first = group.children[0];
  const mask = layer.detailMaskTexture.image.data as Uint8Array;
  assert.equal(mask.at(-1), 128);
  layer.setDetailChunkReady(-1, -1, true);
  assert.equal(mask.at(-1), 255);
  layer.setDetailChunkReady(-1, -1, false);
  assert.equal(mask.at(-1), 128, 'far solids own the chunk immediately after near eviction');
  layer.authoredChunks.install({ ...zone.detailChunks![0], revision: Infinity }, true);
  const local = group.children[0];
  layer.installZone(zone);
  assert.equal(group.children[0], local, 'unacknowledged edits must survive server refresh');
  layer.authoredChunks.acknowledge(1023, 127, 124);
  layer.authoredChunks.install(zone.detailChunks![0]);
  assert.equal(group.children[0], local, 'an earlier accepted revision is still stale');
  layer.authoredChunks.install({ ...zone.detailChunks![0], revision: 124 });
  assert.notEqual(group.children[0], local);
  assert.notEqual(group.children[0], first);
  await layer.finalizeConnections();
});

test('unknown fine source errors refine only to the projected area budget', async () => {
  const layer = new DistantSurfaceLayer();
  try {
    const camera = torusCamera(8192, 100, 1024);
    layer.updateView(camera, 1600);
    const zone = parseSurfaceZoneSnapshot(makeCoarseBytes(0, 2));
    zone.minHeightsMicro = new Uint16Array(64).fill(0);
    layer.installZone(zone);
    assert.equal(layer.getZoneDemand(0, 2).sampleSize, 8, 'do not download 1m columns for subpixel footprints');
    layer.setSettings({ subdivisionSizePx2: 1 });
    assert.equal(layer.getZoneDemand(0, 2).sampleSize, 1, 'the quality control still requests real 1m source detail');
    await layer.finalizeConnections();
  } finally { layer.setEnabled(false); }
});

test('surface download completion does not wait for a moving camera to become idle', async () => {
  const layer = new DistantSurfaceLayer();
  layer.installZone(parseSurfaceZoneSnapshot(makeZoneBytes(0, 0, true)));
  const internals = layer as any;
  let resolve!: () => void;
  internals.connectionBuildPending = true;
  internals.pendingBuild = new Promise<void>(r => { resolve = r; });
  // Model an in-progress frame-sliced build. This must settle without its
  // completion, otherwise the client's next network poll cannot start.
  let completed = false;
  await layer.finalizeConnections(false).then(() => { completed = true; });
  assert.equal(completed, true);
  resolve();
  layer.setEnabled(false);
});

test('v6 keeps adjacent one-metre columns distinct at the near/far handoff', async () => {
  const count = 512 * 512;
  const bytes = new Uint8Array(36 + count * 8);
  bytes.set(makeZoneBytes().subarray(0, 32));
  const view = new DataView(bytes.buffer);
  bytes.set([6, 1, 32, 8], 4);
  view.setUint32(28, count, true);
  for (let i = 0; i < count; i++) {
    const h = (Math.floor(i / 512) % 2 ? 18 : 17) * 8;
    view.setUint16(32 + i * 8, h, true); view.setUint16(34 + i * 8, h, true);
    bytes.set([113, 143, 97], 36 + i * 8);
  }
  const zone = parseSurfaceZoneSnapshot(bytes);
  assert.equal(zone.sampleSize, 1);
  assert.equal(zone.heightsMicro[512] - zone.heightsMicro[0], 8);
  const layer = new DistantSurfaceLayer();
  layer.setNearField(0, 0, 4);
  layer.setDetailChunkReady(0, 0, true);
  layer.installZone(zone);
  await layer.finalizeConnections();
  const offsets = layer.mesh.geometry.getAttribute('surfaceOffset');
  const sizes = layer.mesh.geometry.getAttribute('surfaceSize');
  const heights = layer.mesh.geometry.getAttribute('surfaceHeight');
  const found = new Map<number, number>();
  for (let i = 0; i < layer.mesh.geometry.instanceCount; i++) {
    if (offsets.getY(i) === 0 && offsets.getX(i) < 2) {
      assert.equal(sizes.getX(i), 1);
      found.set(offsets.getX(i), heights.getX(i));
    }
  }
  assert.deepEqual([...found.values()].sort(), [136, 144]);
  layer.setEnabled(false);
});

test('cache pressure refines all visible zones before concentrating detail near the camera', async () => {
  const payloads = new Map<string, Uint8Array>();
  const zones = Array.from({ length: 3 }, (_, x) => {
    const level = (size: number) => {
      const bytes = size === 2 ? makeZoneBytes(x, 0, true) : makeCoarseBytes(x, 0, size);
      const url = `/z/${x}/${size}`;
      payloads.set(url, bytes);
      return {sample_size:size,url,byte_length:bytes.length,digest:createHash('sha256').update(bytes).digest('hex')};
    };
    return {zone_x:x,zone_z:0,revision:1,source_terrain_revision:7,...level(2),lods:[4,16,64].map(level)};
  });
  const remote = createSpaceSurfaceSnapshotRemote('https://api.entropydrop.com','token','/manifest',20260827,1,
    (async input => {
      const path = new URL(String(input)).pathname;
      // Downloads/digest checks may finish out of order. Exercise that case
      // deliberately instead of depending on Map insertion order below.
      if (path === '/z/0/64') await new Promise(resolve => setTimeout(resolve, 4));
      return path === '/manifest' ? Response.json({schema_version:5,samples_per_chunk_axis:8,zone_size_chunks:32,
        width_chunks:96,length_chunks:32,complete:true,zones}) : new Response(payloads.get(path)!.slice().buffer);
    }) as typeof fetch);
  const installed = new Map<number,number>();
  await remote.loadAll(z => installed.set(z.zoneX,z.sampleSize??2),undefined,
    {getZoneDemand:x=>({sampleSize:2,priority:x}),getDataBudgetBytes:()=>650_000});
  assert.deepEqual([...installed.entries()].sort(([a], [b]) => a - b), [[0,2],[1,4],[2,4]],
    'a budget boundary must not leave a visible neighbour at 64m');
});

test('new overviews trigger refinement immediately and updated fine zones never flash coarse', async () => {
  let revision = 7, overviewSeen = false;
  const installed: number[] = [];
  const remote = createSpaceSurfaceSnapshotRemote('https://api.entropydrop.com','token','/manifest',20260827,1,
    (async input => {
      const path = new URL(String(input)).pathname;
      const fine = makeZoneBytes(0,0,true); new DataView(fine.buffer).setBigUint64(20,BigInt(revision),true);
      const coarse = makeCoarseBytes(0,0,64,revision);
      const level = (size:number,bytes:Uint8Array) => ({sample_size:size,url:`/z/${size}`,byte_length:bytes.length,
        digest:createHash('sha256').update(bytes).digest('hex')});
      return path === '/manifest' ? Response.json({schema_version:5,samples_per_chunk_axis:8,zone_size_chunks:32,
        width_chunks:32,length_chunks:32,complete:false,zones:[{zone_x:0,zone_z:0,revision,source_terrain_revision:revision,
          ...level(2,fine),lods:[level(64,coarse)]}]}) : new Response(path.endsWith('/64')?coarse.buffer:fine.buffer);
    }) as typeof fetch);
  const install = (z: ReturnType<typeof parseSurfaceZoneSnapshot>) => {installed.push(z.sampleSize??2); overviewSeen=true;};
  const options = {getZoneDemand:()=>({sampleSize:overviewSeen?2:64,priority:0})};
  await remote.loadAll(install,undefined,options);
  assert.deepEqual(installed,[64,2]);
  revision++;
  options.getZoneDemand = () => ({sampleSize:64,priority:0});
  await remote.loadAll(install,undefined,options);
  assert.deepEqual(installed,[64,2,2], 'a new source revision retains the installed resolution even after residuals fall');
});

test('a complete v6 manifest fits with all seven authenticated digest URLs', async () => {
  const digest = 'a'.repeat(64);
  const zones = Array.from({length:128},(_,i)=>{
    const x=Math.floor(i/4), z=i%4;
    const base=`/space/api/v2/worlds/00000000-0000-4000-8000-000000000002/surface-zones/${x}/${z}`;
    const level=(size:number)=>({sample_size:size,digest,byte_length:36+(512/size)**2*8,
      url:`${base}?sample_size=${size}&digest=${digest}`});
    return {zone_x:x,zone_z:z,revision:1,source_terrain_revision:0,updating:false,
      ...level(1),lods:[2,4,8,16,32,64].map(level)};
  });
  const manifest={schema_version:6,samples_per_chunk_axis:16,zone_size_chunks:32,width_chunks:1024,
    length_chunks:128,complete:true,zones};
  assert.ok(JSON.stringify(manifest).length>256*1024);
  const remote=createSpaceSurfaceSnapshotRemote('https://api.entropydrop.com','token','/manifest',20260827,1,
    (async input=>String(input).endsWith('/manifest')?Response.json(manifest):new Response('',{status:503})) as typeof fetch);
  await assert.rejects(remote.loadAll(()=>{},undefined,{getZoneDemand:()=>({sampleSize:64,priority:0})}),
    /zone failed with HTTP 503/, 'metadata must parse and reach the download, not hit the old 256KiB limit');
});

test('rotation never changes resident demand, published meshes or rebuild counters', async () => {
  const layer = new DistantSurfaceLayer();
  const camera = torusCamera();
  layer.updateView(camera, 900);
  for (const [x, z] of [[0, 1], [0, 2], [15, 1], [16, 2]]) {
    layer.installZone(parseSurfaceZoneSnapshot(makeCoarseBytes(x, z)));
  }
  await layer.finalizeConnections();
  const demand = () => [...layer.loadedZones].map(key => {
    const [x, z] = key.split(',').map(Number);
    return layer.getZoneDemand(x, z);
  });
  const initial = demand();
  const publications = layer.mesh.userData.lodBuildStats.publications;
  const batches = [...layer.mesh.children];
  for (let turn = 0; turn < 24; turn++) {
    camera.rotateY(Math.PI / 3); camera.updateMatrixWorld(true);
    layer.updateView(camera, 900);
    assert.deepEqual(demand(), initial);
    await layer.finalizeConnections();
    assert.equal(layer.mesh.userData.lodBuildStats.publications, publications);
    assert.deepEqual(layer.mesh.children, batches);
  }
  layer.setEnabled(false);
});

test('resident 512m source zones cull as independent 128m draw tiles with exact coverage', async () => {
  const layer = new DistantSurfaceLayer(), camera = torusCamera(8200, 150, 1032);
  camera.fov = 30; camera.updateProjectionMatrix();
  camera.lookAt(bendPoint(8220, 17, 1060)); camera.updateMatrixWorld(true);
  layer.updateView(camera, 800);
  layer.installZone(parseSurfaceZoneSnapshot(makeCoarseBytes(16, 2)));
  await layer.finalizeConnections();
  const tops = layer.mesh.children.filter(mesh => mesh.name.endsWith(':tops')) as THREE.Mesh<THREE.InstancedBufferGeometry>[];
  assert.equal(tops.length, 16);
  assert.ok(tops.filter(mesh => mesh.visible).length < 16, 'a near camera must not submit the entire source zone');
  let area = 0;
  for (const mesh of tops) {
    const [tx, tz] = mesh.name.split(':')[2].split(',').map(Number);
    const offsets = mesh.geometry.getAttribute('surfaceOffset'), sizes = mesh.geometry.getAttribute('surfaceSize');
    for (let i = 0; i < mesh.geometry.instanceCount; i++) {
      assert.ok(offsets.getX(i) >= 8192 + tx * 128 && offsets.getX(i) + sizes.getX(i) <= 8192 + (tx + 1) * 128);
      assert.ok(offsets.getY(i) >= 1024 + tz * 128 && offsets.getY(i) + sizes.getX(i) <= 1024 + (tz + 1) * 128);
      area += sizes.getX(i) ** 2;
    }
  }
  assert.equal(area, 512 * 512, 'draw splitting must neither duplicate nor drop terrain');
  const build = layer.mesh.userData.lodBuildStats.publications;
  camera.rotateY(Math.PI); camera.updateMatrixWorld(true); layer.updateView(camera, 800);
  await layer.finalizeConnections();
  assert.equal(layer.mesh.userData.lodBuildStats.publications, build);
  layer.removeZone(16, 2);
  assert.equal(layer.mesh.children.filter(mesh => mesh.name.startsWith('DistantSurface:')).length, 0);
  layer.setEnabled(false);
});

test('returning to evicted fine data and reloading reuse verified disk bytes', async () => {
  const payloads = new Map<string, Uint8Array>(), saved = new Map<string, Uint8Array>();
  const cache: SurfaceByteCache = {
    async get(key) { return saved.get(key)?.slice(); },
    async put(key, bytes) { saved.set(key, bytes.slice()); },
    async remove(key) { saved.delete(key); },
  };
  const zones = [0, 1].map(x => {
    const level = (size: number) => {
      const bytes = size === 2 ? makeZoneBytes(x, 0, true) : makeCoarseBytes(x, 0);
      const url = `/z/${x}/${size}`;
      payloads.set(url, bytes);
      return { sample_size: size, url, byte_length: bytes.length,
        digest: createHash('sha256').update(bytes).digest('hex') };
    };
    return { zone_x: x, zone_z: 0, revision: 1, source_terrain_revision: 7, ...level(2), lods: [level(64)] };
  });
  let downloads = 0, manifests = 0, focus = 0;
  const create = () => createSpaceSurfaceSnapshotRemote('https://api.entropydrop.com', 'token', '/manifest', 20260827, 1,
    (async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/manifest') {
        manifests++;
        return Response.json({ schema_version: 5, samples_per_chunk_axis: 8, zone_size_chunks: 32,
          width_chunks: 64, length_chunks: 32, complete: true, zones });
      }
      downloads++;
      return new Response(payloads.get(path)!.slice().buffer);
    }) as typeof fetch, cache);
  const installed = new Map<number, number>();
  const options = { getZoneDemand: (x: number) => ({ sampleSize: 2, priority: x === focus ? 0 : 1000 }),
    getDataBudgetBytes: () => 400_000 };
  const install = (zone: any) => installed.set(zone.zoneX, zone.sampleSize ?? 2);
  const remote = create();
  await remote.loadAll(install, undefined, options);
  focus = 1;
  await remote.loadAll(install, undefined, options);
  assert.equal(installed.get(0), 64);
  const warmedDownloads = downloads;
  focus = 0;
  await remote.loadAll(install, undefined, options);
  assert.equal(installed.get(0), 2);
  assert.equal(downloads, warmedDownloads);
  await create().loadAll(install, undefined, options);
  assert.equal(manifests, 2, 'persistent cache must not bypass authenticated manifests');
  assert.equal(downloads, warmedDownloads);
  saved.set(zones[0].digest, new Uint8Array([0]));
  await create().loadAll(install, undefined, options);
  assert.equal(downloads, warmedDownloads + 1, 'corrupt cached data is redownloaded and reverified');
  const offlineCache: SurfaceByteCache = {
    async get() { throw new Error('storage disabled'); },
    async put() { throw new Error('quota'); },
    async remove() { throw new Error('quota'); },
  };
  Object.assign(cache, offlineCache);
  await create().loadAll(install, undefined, options);
  assert.equal(installed.get(0), 2, 'storage failures must not block valid network snapshots');
  let active = 0, peak = 0;
  await create().loadAll(async zone => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 1));
    install(zone); active--;
  }, undefined, options);
  assert.equal(peak, 1, 'parallel downloads must not burst-install several fine mip pyramids in one task');
});
