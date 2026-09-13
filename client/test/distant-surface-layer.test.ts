import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import {
  createSpaceSurfaceSnapshotRemote,
  parseSurfaceZoneSnapshot,
  SURFACE_ZONE_HEADER_BYTES,
  SURFACE_ZONE_RECORD_BYTES,
} from '../src/bootstrap/SpaceSurfaceSnapshot.ts';
import {
  DISTANT_SURFACE_SETTING_LIMITS,
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

test('distant-surface settings snap to safe ordered thresholds', () => {
  assert.deepEqual(normalizeDistantSurfaceSettings({
    lod2Distance: 999,
    lod4Distance: 100,
    lod8Distance: 100,
    lod16Distance: 100,
    lod32Distance: 100,
    maxDistance: 100,
    connectionDistance: -100,
    lod4Enabled: false,
  }), {
    lod2Distance: 500,
    lod4Distance: 550,
    lod8Distance: 600,
    lod16Distance: 650,
    lod32Distance: 700,
    maxDistance: 750,
    connectionDistance: 0,
    lod2Enabled: true,
    lod4Enabled: false,
    lod8Enabled: true,
    lod16Enabled: true,
    lod32Enabled: true,
    lod64Enabled: true,
  });
});

test('disabled LOD tiers fall through to the next enabled tier and the limit culls farther cells', () => {
  const layer = new DistantSurfaceLayer();
  layer.setNearField(0, 0, 8);
  layer.setSettings({ lod2Enabled: false, lod4Enabled: false, maxDistance: 1650 });
  layer.installZone(parseSurfaceZoneSnapshot(makeZoneBytes(0, 0, true)));
  assert.equal(layer.mesh.geometry.getAttribute('surfaceSize').getX(0), 8);

  const limited = new DistantSurfaceLayer();
  limited.setNearField(0, 0, 8);
  limited.setSettings({ maxDistance: 1650 });
  limited.installZone(parseSurfaceZoneSnapshot(makeZoneBytes(4, 0, true)));
  assert.equal(limited.mesh.geometry.instanceCount, 0);
});

test('settings can extend the 32 metre tier and rebuild the live topology', async () => {
  const layer = new DistantSurfaceLayer();
  layer.setNearField(0, 0, 8);
  const settings = layer.setSettings({ lod32Distance: 3000, connectionDistance: 0 });
  assert.equal(settings.lod32Distance, 3000);
  assert.equal(settings.connectionDistance, 0);
  layer.installZone(parseSurfaceZoneSnapshot(makeZoneBytes(4, 0, true)));
  await layer.finalizeConnections();

  const sizes = layer.mesh.geometry.getAttribute('surfaceSize');
  assert.equal(sizes.getX(0), 32);
  assert.equal(layer.sideMesh.geometry.instanceCount, 0);
});

test('maximum exposed LOD controls remain within the surface instance budget', async () => {
  const layer = new DistantSurfaceLayer();
  layer.setNearField(512, 64, 8);
  layer.setSettings({
    lod2Distance: DISTANT_SURFACE_SETTING_LIMITS.lod2Distance.max,
    lod4Distance: DISTANT_SURFACE_SETTING_LIMITS.lod4Distance.max,
    lod8Distance: DISTANT_SURFACE_SETTING_LIMITS.lod8Distance.max,
    lod16Distance: DISTANT_SURFACE_SETTING_LIMITS.lod16Distance.max,
    lod32Distance: DISTANT_SURFACE_SETTING_LIMITS.lod32Distance.max,
    maxDistance: DISTANT_SURFACE_SETTING_LIMITS.maxDistance.max,
    connectionDistance: 0,
  });
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
  assert.deepEqual([...usedSizes].sort((a, b) => a - b), [2, 4, 8, 16, 32, 64]);
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
  assert.ok(layer.mesh.geometry.instanceCount > 150_000);
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
  assert.equal((layer as any).connectionBuildPending, true);
  assert.equal(layer.mesh.geometry.instanceCount, activeCount);

  for (let attempt = 0; attempt < 200 && (layer as any).connectionBuildPending; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
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
  assert.equal(material.flatShading, true);
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
  assert.match(shader.fragmentShader, /uSurfaceDetailMask/);
  assert.match(shader.fragmentShader, /texture2D/);
  assert.match(shader.fragmentShader, /discard/);

  const sideShader: any = {
    uniforms: {},
    vertexShader: '#include <common>\n#include <defaultnormal_vertex>\n#include <begin_vertex>\n#include <project_vertex>',
    fragmentShader: '#include <common>\n#include <color_fragment>',
  };
  layer.sideMesh.material.onBeforeCompile(sideShader, null as any);
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

test('surface connections extend through 4000 metres while the 32 metre tier stops at 1600', async () => {
  const layer = new DistantSurfaceLayer();
  layer.setNearField(0, 0, 8);
  layer.installZone(parseSurfaceZoneSnapshot(makeZoneBytes(4, 0)));
  await layer.finalizeConnections();

  assert.equal(layer.mesh.geometry.instanceCount, 1);
  assert.equal(layer.mesh.geometry.getAttribute('surfaceSize').getX(0), 64);
  assert.ok(layer.sideMesh.geometry.instanceCount > 0);
  assert.equal(layer.sideMesh.visible, true);
});

test('surface connections remain active for 64 metre samples around 3000 metres', async () => {
  const layer = new DistantSurfaceLayer();
  layer.setNearField(0, 0, 8);
  layer.installZone(parseSurfaceZoneSnapshot(makeZoneBytes(6, 0)));
  await layer.finalizeConnections();

  assert.equal(layer.mesh.geometry.instanceCount, 1);
  assert.equal(layer.mesh.geometry.getAttribute('surfaceSize').getX(0), 64);
  assert.ok(layer.sideMesh.geometry.instanceCount > 0);
  assert.equal(layer.sideMesh.visible, true);
});

test('surface connections stop beyond 4000 metres', async () => {
  const layer = new DistantSurfaceLayer();
  layer.setNearField(0, 0, 8);
  layer.installZone(parseSurfaceZoneSnapshot(makeZoneBytes(8, 0)));
  await layer.finalizeConnections();

  assert.equal(layer.mesh.geometry.instanceCount, 1);
  assert.equal(layer.mesh.geometry.getAttribute('surfaceSize').getX(0), 64);
  assert.equal(layer.sideMesh.geometry.instanceCount, 0);
  assert.equal(layer.sideMesh.visible, false);
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
