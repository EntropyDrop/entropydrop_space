import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { VoxelFaceArena, type VoxelFaceMesh } from '../src/render/VoxelFaceArena.ts';
import { voxelBlockBackFacing } from '../src/render/VoxelFaceVisibility.ts';
import { bendTorusPoint, setWorldProjection } from '../src/torus/TorusWorld.ts';

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

for (const cached of [true, false]) test(`optional torus backfaces restore stationary maps and survive projection/fade changes (cached=${cached})`, () => {
  const group = new THREE.BundleGroup(), mesh = source(32, 0), bounds = new Float32Array(24);
  for (const [block, z] of [0, 1024].entries()) {
    const p = bendTorusPoint(0, 16, z);
    bounds.set([p.x, p.y, p.z, 20, 0, 0, 0, 2, -8, 8, z - 8, z + 8], block * 12);
  }
  mesh.geometry.userData.voxelVisibility = bounds; group.add(mesh);
  const arena = new VoxelFaceArena(group, make), camera = bendTorusPoint(8192, 180, 1024);
  arena.setViewOptimizationsEnabled(cached);
  const frustum = new THREE.Frustum(); frustum.planes.forEach(p => p.setComponents(0, 0, 0, 1));
  const coverage = new THREE.DataTexture(new Uint8Array(1024 * 128 * 2), 1024, 128, THREE.RGFormat);
  const tick = () => { arena.setView(camera, frustum, coverage, true); arena.restoreSources(); arena.sync(Infinity); };
  try {
    setWorldProjection('torus'); tick();
    assert.equal(arena.stats.visibleFaces, 32, 'default is unchanged');
    const original = Array.from(arena.pages[0].map.array), resident = arena.stats.residentFaces;
    assert.equal((arena as any).surfaceProxies.has(bounds), false, 'off creates no coefficients');
    arena.setTorusBackfaceCullingEnabled(true); tick();
    assert.equal(arena.stats.visibleFaces, 16);
    assert.equal(arena.pages[0].map.array[0], 16, 'the opposite inner wall remains');
    assert.equal(arena.stats.residentFaces, resident);
    const version = arena.pages[0].map.version;
    arena.setTorusBackfaceCullingEnabled(true); tick();
    assert.equal(arena.pages[0].map.version, version, 'same choice keeps the draw map');
    setWorldProjection('flat'); tick(); assert.equal(arena.stats.visibleFaces, 32);
    setWorldProjection('torus'); tick(); assert.equal(arena.stats.visibleFaces, 16);
    camera.copy(bendTorusPoint(0, 180, 0)); tick();
    assert.equal(arena.pages[0].map.array[0], 0, 'classification follows the camera');
    mesh.userData.terrainCoverage = new THREE.Vector2(.2, 1); tick();
    assert.equal(mesh.visible, true, 'fading sources retain the ordinary path');
    assert.ok(mesh.geometry.getAttribute('voxelOffset'));
    mesh.userData.terrainCoverage.set(0, 1); camera.copy(bendTorusPoint(8192, 180, 1024)); tick();
    assert.equal(arena.stats.visibleFaces, 16);
    arena.setTorusBackfaceCullingEnabled(false); tick();
    assert.equal(arena.stats.visibleFaces, 32);
    assert.deepEqual(Array.from(arena.pages[0].map.array), original, 'off restores the full map without moving');
    assert.equal((arena as any).surfaceProxies.has(bounds), false, 'off releases coefficients');
  } finally { arena.dispose(); coverage.dispose(); setWorldProjection('torus'); }
});

test('visibility-only updates reuse membership and residency while additions and disposal force maintenance', () => {
  const group = new THREE.BundleGroup(), a = source(65, 0), b = source(64, 512);
  group.add(a, b); const arena = new VoxelFaceArena(group, make);
  try {
    settle(arena);
    const passes = arena.stats.maintenancePasses, lists = arena.stats.sourceListBuilds;
    const resident = arena.stats.residentFaces, bytes = arena.stats.bytes;
    for (let i = 0; i < 10; i++) {
      arena.restoreSources(); const visible = i % 2 === 0; b.visible = visible; arena.sync(Infinity, undefined, true);
      assert.equal(arena.stats.visibleFaces, visible ? 129 : 65);
    }
    assert.equal(arena.stats.maintenancePasses, passes); assert.equal(arena.stats.sourceListBuilds, lists);
    assert.equal(arena.stats.residentFaces, resident); assert.equal(arena.stats.bytes, bytes);
    arena.restoreSources(); b.visible = true;
    const c = source(32, 1024); group.add(c); arena.sync(Infinity, undefined, true);
    assert.equal(arena.stats.residentFaces, 161); assert.equal(arena.stats.sourceListBuilds, lists + 1);
    arena.restoreSources(); a.geometry.dispose(); a.geometry = source(17, 0).geometry;
    arena.sync(Infinity, undefined, true); assert.equal(arena.stats.residentFaces, 113);
    arena.restoreSources(); arena.incrementalMaintenance = false; arena.sync(Infinity, undefined, true);
    const reference = arena.pages.map(page => Array.from(page.map.array));
    arena.restoreSources(); arena.incrementalMaintenance = true; arena.sync(Infinity, undefined, true);
    assert.deepEqual(arena.pages.map(page => Array.from(page.map.array)), reference);
  } finally { arena.dispose(); }
});

test('bounded publication releases duplicate attributes and reconstructs all face data exactly', () => {
  const group = new THREE.BundleGroup(), a = source(10000, 16384), b = source(63, -512);
  group.add(b,a); const before = snapshot(a), arena = new VoxelFaceArena(group, make);
  try {
    arena.sync(Infinity,128); assert.equal(arena.stats.copyFaces,128); assert.equal(arena.hasPendingWork,true);
    assert.ok(a.geometry.getAttribute('voxelOffset')); assert.equal(a.visible,true);
    settle(arena); assert.equal(arena.stats.visibleFaces,10063); assert.equal(arena.stats.paddedFaces,10064);
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
    assert.equal(runs[0].userData.voxelArenaBase,0); assert.equal(runs[1].userData.voxelArenaBase,4);
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

test('coarse clocks cannot starve the last pending source behind settled entries', t => {
  const group = new THREE.BundleGroup(), a = source(64, 0); group.add(a);
  const arena = new VoxelFaceArena(group, make);
  try {
    settle(arena);
    const b = source(8000, 512); group.add(b);
    let clock = 0;
    t.mock.method(performance, 'now', () => ++clock);
    arena.restoreSources(); arena.sync(.75);
    assert.equal(arena.stats.copyFaces, 4096, 'one bounded slice must publish even with 1ms clock ticks');
    assert.equal(arena.hasPendingWork, true);
    arena.restoreSources(); arena.sync(.75);
    assert.equal(arena.hasPendingWork, false);
    assert.equal(b.geometry.getAttribute('voxelOffset'), undefined);
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

test('visibility guards reuse maps during motion and restore faces on reversal and coverage fades', () => {
  const group = new THREE.BundleGroup(), mesh = source(32, 0);
  mesh.geometry.userData.voxelVisibility = new Float32Array([0, 0, 0, 1, 1, 0, 0, 0, 5, 6, 5, 6, 0, 0, 0, 1, 1, 0, 0, 0, 5, 6, 5, 6]);
  mesh.userData.maskedMaterial = new THREE.MeshStandardNodeMaterial(); mesh.material = mesh.userData.maskedMaterial;
  mesh.userData.terrainCoverage = new THREE.Vector2(0, 1); group.add(mesh);
  const data = new Uint8Array(1024 * 128 * 2), coverage = new THREE.DataTexture(data, 1024, 128, THREE.RGFormat);
  const arena = new VoxelFaceArena(group, make), camera = new THREE.Vector3(-1000, 0, 0), frustum = new THREE.Frustum();
  const tick = () => { arena.setView(camera, frustum, coverage, true); arena.restoreSources(); arena.sync(Infinity); };
  try {
    tick(); assert.equal(arena.stats.visibleFaces, 0); assert.equal(arena.stats.backFaces, 32);
    const page = arena.pages[0], version = page.map.version;
    camera.x += 10; tick(); assert.equal(page.map.version, version, 'small motion reuses the conservative map');
    camera.x = 1000; tick(); assert.equal(arena.stats.visibleFaces, 32);
    data[0] = 255; coverage.needsUpdate = true; tick(); assert.equal(arena.stats.coveredFaces, 32);
    data[0] = 128; coverage.needsUpdate = true; tick(); assert.equal(arena.stats.visibleFaces, 32, 'partial coverage retains the masked far draw');
    assert.equal(mesh.geometry.getAttribute('voxelOffset'), undefined, 'coverage changes do not recreate geometry');
  } finally { arena.dispose(); coverage.dispose(); }
});

function cullingFixture(cached: boolean, clustered = false) {
  const group = new THREE.BundleGroup(), mesh = source(16 * 96, 0), bounds = new Float32Array(96 * 12);
  for (let i = 0; i < 96; i++) {
    const angle = i * Math.PI * 2 / 96;
    bounds.set([Math.sin(angle) * (clustered ? 50 : 1000) + (clustered ? 800 : 0),
      (i % 7 - 3) * 80, Math.cos(angle) * (clustered ? 50 : 1000) - (clustered ? 800 : 0),
      20, Math.sin(angle), 0, Math.cos(angle), i % 3 ? 2 : .01, 5, 6, 5, 6], i * 12);
  }
  mesh.geometry.userData.voxelVisibility = bounds;
  mesh.userData.maskedMaterial = new THREE.MeshStandardNodeMaterial(); mesh.material = mesh.userData.maskedMaterial;
  group.add(mesh);
  const arena = new VoxelFaceArena(group, make); arena.setViewOptimizationsEnabled(cached);
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, .1, 10000), frustum = new THREE.Frustum();
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  const data = new Uint8Array(1024 * 128 * 2), coverage = new THREE.DataTexture(data, 1024, 128, THREE.RGFormat);
  const tick = (mask = coverage) => {
    camera.updateMatrixWorld(); camera.updateProjectionMatrix();
    frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), THREE.WebGPUCoordinateSystem);
    arena.setView(camera.position, frustum, mask, true); arena.restoreSources(); arena.sync(Infinity);
  };
  return { arena, mesh, bounds, camera, frustum, data, coverage, tick };
}

test('cached rotation tests preserve exact maps through position, coverage, material and texture changes', () => {
  const a = cullingFixture(true, true), b = cullingFixture(false, true);
  const textures: THREE.DataTexture[] = [];
  try {
    a.tick(); b.tick(); const positionTests = a.arena.stats.positionBlockTests;
    for (let frame = 1; frame <= 70; frame++) {
      for (const f of [a, b]) {
        f.camera.rotation.y = frame * .13;
        if (frame === 20) f.camera.position.x = 35;
        if (frame === 30 || frame === 40) { f.data[0] = frame === 30 ? 255 : 128; f.coverage.needsUpdate = true; }
        if (frame === 50) f.mesh.material = f.mesh.userData.opaqueMaterial;
        if (frame === 60) f.mesh.material = f.mesh.userData.maskedMaterial;
        if (frame >= 65) {
          if (textures.length < 2) {
            for (let i = 0; i < 2; i++) { const data = f.data.slice(); data[0] = 255;
              const texture = new THREE.DataTexture(data, 1024, 128, THREE.RGFormat);
              texture.version = f.coverage.version; textures.push(texture); }
          }
          f.tick(textures[f === a ? 0 : 1]);
        } else f.tick();
      }
      for (const key of ['visibleFaces', 'backFaces', 'outsideFaces', 'coveredFaces', 'paddedFaces', 'draws'] as const)
        assert.equal(a.arena.stats[key], b.arena.stats[key], `${key} at frame ${frame}`);
      assert.deepEqual(a.arena.pages.map(p => p.map.array), b.arena.pages.map(p => p.map.array));
      if (frame < 20) assert.equal(a.arena.stats.positionBlockTests, positionTests, 'rotation reuses position-only work');
    }
    assert.equal(a.arena.stats.coveredFaces, 16 * 96, 'a new texture with the same version invalidates coverage');
    assert.ok(a.arena.stats.blockCacheBytes > 0);
  } finally {
    for (const f of [a, b]) { f.arena.dispose(); f.coverage.dispose(); assert.equal(f.arena.stats.blockCacheBytes, 0); }
    textures.forEach(t => t.dispose());
  }
});

test('cluster plane masks preserve exact reference maps and reasons across view and coverage changes', () => {
  for (const size of [4, 16, 32, 64]) {
    const candidate = cullingFixture(true), reference = cullingFixture(false);
    (candidate.arena as any).visibilityClusterSize = size;
    try {
      for (let frame = 0; frame < 160; frame++) {
        for (const f of [candidate, reference]) {
          f.camera.position.set(Math.sin(frame * .29) * 1024, (frame % 13) * 30, Math.cos(frame * .23) * 600);
          f.camera.rotation.set(Math.sin(frame * .11), frame * .23, 0);
          f.camera.fov = 30 + frame % 100; f.camera.aspect = .6 + (frame % 5) * .5;
          f.camera.near = frame % 7 ? .1 : 400; f.camera.far = frame % 11 ? 10000 : 700;
          f.data[0] = frame % 3 === 0 ? 255 : frame % 3 === 1 ? 128 : 0; f.coverage.needsUpdate = true;
          f.mesh.material = frame % 5 ? f.mesh.userData.maskedMaterial : f.mesh.userData.opaqueMaterial;
          if (frame === 80) {
            const next = f.bounds.slice(); next[0] += 120; f.mesh.geometry.userData.voxelVisibility = next;
            (f.arena as any).resetView = true;
          }
          f.tick();
        }
        for (const key of ['visibleFaces', 'backFaces', 'outsideFaces', 'coveredFaces', 'paddedFaces', 'draws'] as const)
          assert.equal(candidate.arena.stats[key], reference.arena.stats[key], `${size}/${frame}/${key}`);
        assert.deepEqual(candidate.arena.pages.map(p => p.map.array), reference.arena.pages.map(p => p.map.array));
      }
      (candidate.arena as any).visibilityClusterSize = 0;
      (candidate.arena as any).resetView = true; candidate.tick(); reference.tick();
      assert.deepEqual(candidate.arena.pages.map(p => p.map.array), reference.arena.pages.map(p => p.map.array));
    } finally {
      for (const f of [candidate, reference]) { f.arena.dispose(); f.coverage.dispose(); assert.equal(f.arena.stats.blockCacheBytes, 0); }
    }
  }
});

test('cached rotation guards retain every sphere intersecting the current frustum', () => {
  const f = cullingFixture(true);
  // Wide normal cones disable back-face rejection, isolating frustum guards.
  for (let i = 0; i < 96; i++) f.bounds[i * 12 + 7] = 2;
  f.mesh.material = f.mesh.userData.opaqueMaterial;
  let rejected = 0;
  try {
    for (let frame = 0; frame < 180; frame++) {
      f.camera.rotation.y = frame * .017;
      f.camera.position.set(Math.sin(frame * .09) * 30, 0, Math.cos(frame * .09) * 30);
      f.tick();
      const page = f.arena.pages[0], drawn = new Set<number>();
      for (let i = 0; i < f.arena.stats.paddedFaces / 16; i++) drawn.add(f.arena.getCompactMapsEnabled() ? (page.map.array[i * 4] >>> 5) / 16 : page.map.array[i * 8] / 16);
      rejected += 96 - drawn.size;
      for (let block = 0; block < 96; block++) {
        const at = block * 12, sphere = new THREE.Sphere(new THREE.Vector3(f.bounds[at], f.bounds[at + 1], f.bounds[at + 2]), f.bounds[at + 3]);
        if (f.frustum.intersectsSphere(sphere)) assert.ok(drawn.has(block), `visible block ${block} at frame ${frame}`);
      }
    }
    assert.ok(rejected > 1000, 'the guard test exercises actual rejection');
  } finally { f.arena.dispose(); f.coverage.dispose(); }
});

test('wide reuse retains currently visible blocks through guard crossings, FOV, clipping and teleports', () => {
  const f = cullingFixture(true); f.mesh.material = f.mesh.userData.opaqueMaterial;
  let rejected = 0, checked = 0;
  try {
    for (let frame = 0; frame < 360; frame++) {
      const edge = [0, 15.9, 31.999, 32, 32.001, 63.999, 64.001, -32.001][frame % 8];
      f.camera.position.set(edge, Math.sin(frame * .41) * 42, frame % 19 === 0 ? 600 : Math.cos(frame * .17) * 31.9);
      f.camera.rotation.set(Math.sin(frame * .37) * .3, frame * .0599, 0);
      f.camera.fov = [35, 75, 120][Math.floor(frame / 17) % 3];
      f.camera.aspect = [.7, 16 / 9, 2.8][Math.floor(frame / 23) % 3];
      f.camera.near = frame % 29 === 0 ? 80 : .1;
      f.camera.far = frame % 31 === 0 ? 650 : 10000;
      f.tick();
      const page = f.arena.pages[0], drawn = new Set<number>();
      for (let i = 0; i < f.arena.stats.paddedFaces / 16; i++) drawn.add(page.map.array[i * 8] / 16);
      rejected += 96 - drawn.size;
      for (let block = 0; block < 96; block++) {
        const at = block * 12, sphere = new THREE.Sphere(new THREE.Vector3(f.bounds[at], f.bounds[at + 1], f.bounds[at + 2]), f.bounds[at + 3]);
        const near = sphere.center.distanceTo(f.camera.position) - sphere.radius <= 256;
        const facing = !voxelBlockBackFacing(f.bounds, at, f.camera.position.x, f.camera.position.y, f.camera.position.z);
        if (near || (facing && f.frustum.intersectsSphere(sphere))) {
          checked++; assert.ok(drawn.has(block), `required block ${block} at frame ${frame}`);
        }
      }
    }
    assert.ok(checked > 1000); assert.ok(rejected > 1000);
  } finally { f.arena.dispose(); f.coverage.dispose(); }
});

test('translation reuse crosses the old guard and refreshes at the new guard', () => {
  const f = cullingFixture(true);
  try {
    f.tick(); const count = f.arena.stats.positionBlockTests;
    for (const x of [16, 24, 31.999]) { f.camera.position.x = x; f.tick(); assert.equal(f.arena.stats.positionBlockTests, count); }
    f.camera.position.x = 32; f.tick(); assert.ok(f.arena.stats.positionBlockTests > count);
    const after = f.arena.stats.positionBlockTests;
    f.camera.position.x = -32; f.tick(); assert.ok(f.arena.stats.positionBlockTests > after, 'rapid reversal refreshes');
  } finally { f.arena.dispose(); f.coverage.dispose(); }
});

for (const cached of [true, false]) test(`empty-frustum recovery bypasses reuse slack (cached=${cached})`, () => {
  const f = cullingFixture(cached); f.mesh.material = f.mesh.userData.opaqueMaterial;
  const tick = () => { f.arena.setView(f.camera.position, f.frustum, f.coverage, true); f.arena.restoreSources(); f.arena.sync(Infinity); };
  try {
    for (const p of f.frustum.planes) p.setComponents(0, 0, 0, .2);
    tick(); const visible = f.arena.stats.visibleFaces; assert.ok(visible > 0);
    f.frustum.planes[0].constant = -.2; tick(); assert.equal(f.arena.stats.visibleFaces, 0);
    f.frustum.planes[0].constant = .2; tick(); assert.equal(f.arena.stats.visibleFaces, visible);
  } finally { f.arena.dispose(); f.coverage.dispose(); }
});

test('geometry publication and projection changes replace stale visibility under a stationary camera', () => {
  const f = cullingFixture(true); f.mesh.material = f.mesh.userData.opaqueMaterial;
  try {
    f.tick(); setWorldProjection('flat'); f.tick(); assert.equal(f.arena.stats.visibleFaces, 16 * 96);
    setWorldProjection('torus'); f.tick(); assert.ok(f.arena.stats.visibleFaces < 16 * 96);
    f.mesh.geometry.dispose(); f.mesh.geometry = source(16, 0).geometry;
    f.mesh.geometry.userData.voxelVisibility = new Float32Array([0, 0, -1000, 10, 0, 0, 1, 2, 5, 6, 5, 6]);
    f.tick(); assert.equal(f.arena.stats.residentFaces, 16); assert.equal(f.arena.stats.visibleFaces, 16);
    f.mesh.geometry.dispose(); f.mesh.geometry = source(16, 0).geometry;
    f.mesh.geometry.userData.voxelVisibility = new Float32Array([0, 0, 1000, 10, 0, 0, 1, 2, 5, 6, 5, 6]);
    f.tick(); assert.equal(f.arena.stats.residentFaces, 16); assert.equal(f.arena.stats.visibleFaces, 0);
  } finally { setWorldProjection('torus'); f.arena.dispose(); f.coverage.dispose(); }
});

// Decode the actual draw arguments and index buffers into the ordered GPU face
// records/corners. This checks topology across partial blocks and run barriers.
function submittedVertices(arena: VoxelFaceArena) {
  const output: unknown[] = [];
  const draws = arena.pages.flatMap(page => page.runs.filter(mesh => mesh.visible).map(mesh => ({ page, mesh })))
    .sort((a, b) => a.mesh.renderOrder - b.mesh.renderOrder);
  for (const { page, mesh } of draws) {
    const geometry = mesh.geometry, indices = geometry.index!.array;
    const instances = geometry.isInstancedBufferGeometry ? geometry.instanceCount : 1;
    for (let instance = 0; instance < instances; instance++) for (let i = 0; i < geometry.drawRange.count; i++) {
      const vertex = indices[geometry.drawRange.start + i], face = Math.floor(vertex / 4) + instance * (indices.length / 6);
      if (face >= mesh.userData.voxelArenaFaces) continue;
      const compact = arena.getCompactMapsEnabled(), stride = compact ? 4 : 8;
      const at = (Math.floor(face / 16) + mesh.userData.voxelArenaBase) * stride, local = face % 16;
      const start = compact ? page.map.array[at] >>> 5 : page.map.array[at];
      const count = compact ? page.map.array[at] & 31 : page.map.array[at + 1];
      const valid = local < count, record = (start + Math.min(local, count - 1)) * 4;
      const origin = compact ? page.map.array.slice(at + 1, at + 4) : page.map.array.slice(at + 2, at + 5);
      if (!valid) continue;
      output.push([mesh.renderOrder, mesh.material === page.mesh.userData.maskedMaterial, valid, vertex % 4,
        ...origin, ...page.data.array.slice(record, record + 4)]);
    }
  }
  return output;
}

test('block instances preserve triangle order, partial blocks and material/unmerged barriers', () => {
  const group = new THREE.BundleGroup(), a = source(17, 0), barrier = source(7, 512), b = source(33, 1024), c = source(5, 1536);
  barrier.userData.voxelArenaCompatible = false;
  b.userData.maskedMaterial = new THREE.MeshStandardNodeMaterial(); b.material = b.userData.maskedMaterial;
  group.add(a, barrier, b, c);
  const arena = new VoxelFaceArena(group, () => {
    const mesh = make(); mesh.userData.opaqueMaterial = mesh.material;
    mesh.userData.maskedMaterial = new THREE.MeshStandardNodeMaterial(); return mesh;
  });
  try {
    arena.setBlockInstancingEnabled(true);
    settle(arena); const expected = submittedVertices(arena), page = arena.pages[0];
    assert.ok(expected.length > 0); assert.equal(page.mesh.geometry.index!.array.byteLength, 768);
    assert.equal(arena.stats.draws, 3); const bytes = arena.stats.bytes, dataVersion = page.data.version;
    for (const blocks of [false, true, false, true]) {
      arena.restoreSources(); arena.setBlockInstancingEnabled(blocks); arena.sync(Infinity);
      assert.deepEqual(submittedVertices(arena), expected);
      assert.equal(page.data.version, dataVersion, 'changing draw layout does not republish faces');
      assert.equal(arena.stats.residentFaces, 55); assert.equal(arena.stats.visibleFaces, 55);
      assert.equal(arena.stats.bytes, blocks ? bytes : bytes - 768 + 256 * 1024 * 6 * 4);
      assert.equal(a.geometry.getAttribute('voxelOffset'), undefined);
    }
    arena.restoreSources(); group.remove(b); arena.sync(Infinity);
    const changed = submittedVertices(arena);
    arena.restoreSources(); arena.setBlockInstancingEnabled(false); arena.sync(Infinity);
    assert.deepEqual(submittedVertices(arena), changed, 'removal updates both layouts identically');
  } finally { arena.dispose(); }
});

test('drawing reference switches retain storage and release replaced materials exactly once', () => {
  const group = new THREE.BundleGroup(), mesh = source(33, 0); group.add(mesh);
  const retired = new Map<THREE.Material, number>();
  const arena = new VoxelFaceArena(group, () => {
    const page = make(); page.userData.opaqueMaterial = page.material;
    page.userData.maskedMaterial = new THREE.MeshStandardNodeMaterial();
    for (const material of [page.material, page.userData.maskedMaterial]) {
      retired.set(material, 0); material.addEventListener('dispose', () => retired.set(material, retired.get(material)! + 1));
    }
    return page;
  });
  try {
    arena.setBlockInstancingEnabled(true);
    settle(arena); const page = arena.pages[0], data = page.data, map = page.map, index = page.mesh.geometry.index;
    arena.restoreSources(); arena.setBlockInstancingEnabled(false); arena.sync(Infinity);
    assert.equal(page.data, data); assert.equal(page.map, map); assert.notEqual(page.mesh.geometry.index, index);
    assert.deepEqual([...retired.values()], [1, 1, 0, 0]);
    arena.setBlockInstancingEnabled(false); assert.equal(retired.size, 4, 'idempotent switches do not create materials');
    let disposals = 0; page.mesh.geometry.addEventListener('dispose', () => disposals++);
    arena.setBlockInstancingEnabled(true); assert.equal(disposals, 1);
    arena.setBlockInstancingEnabled(true); assert.equal(disposals, 1);
    arena.dispose(); assert.deepEqual([...retired.values()], [1, 1, 1, 1, 1, 1]);
  } finally { arena.dispose(); }
});


test('compact maps preserve ordered faces, origins and tails through switches and publication', () => {
  const group = new THREE.BundleGroup(), a = source(17, -16384), b = source(33, 512), barrier = source(7, 0);
  barrier.userData.voxelArenaCompatible = false;
  b.userData.maskedMaterial = new THREE.MeshStandardNodeMaterial(); b.material = b.userData.maskedMaterial;
  a.userData.voxelOrigin.y = 17.25; b.userData.voxelOrigin.z = 16384;
  group.add(a, barrier, b); const arena = new VoxelFaceArena(group, make);
  try {
    assert.equal(arena.getCompactMapsEnabled(), false, 'experimental maps must not become the default without full-frame evidence');
    arena.setCompactMapsEnabled(true);
    settle(arena); const expected = submittedVertices(arena), page = arena.pages[0], data = page.data;
    const compactBytes = arena.stats.bytes, compactUpload = arena.stats.mapUploadBytes;
    assert.equal(page.map.count, 256 * 1024 / 16);
    for (const enabled of [false, true, false, true]) {
      arena.restoreSources(); arena.setCompactMapsEnabled(enabled); arena.sync(Infinity);
      assert.deepEqual(submittedVertices(arena), expected);
      assert.equal(page.data, data); assert.equal(arena.stats.residentFaces, 50);
      assert.equal(arena.stats.bytes, compactBytes + (enabled ? 0 : 256 * 1024));
      assert.equal(arena.stats.mapUploadBytes, compactUpload * (enabled ? 1 : 2));
    }
    arena.restoreSources(); group.remove(a); const c = source(19, 1024); group.add(c); settle(arena);
    const changed = submittedVertices(arena);
    arena.restoreSources(); arena.setCompactMapsEnabled(false); arena.sync(Infinity);
    assert.deepEqual(submittedVertices(arena), changed, 'reused ranges and new partial blocks decode identically');
  } finally { arena.dispose(); }
});

test('compact map addresses remain lossless at the last page block for every tail count', () => {
  const group = new THREE.BundleGroup(), a = source(256 * 1024 - 16, 0); group.add(a);
  const arena = new VoxelFaceArena(group, make);
  try {
    arena.setCompactMapsEnabled(true); settle(arena);
    for (let count = 1; count <= 16; count++) {
      arena.restoreSources(); const tail = source(count, -512); group.add(tail); settle(arena);
      const page = arena.pages[0], at = (page.map.count - 1) * 4, address = page.map.array[at];
      assert.equal(arena.pages.length, 1); assert.equal(address >>> 5, 256 * 1024 - 16);
      assert.equal(address & 31, count); assert.ok(address < 2 ** 23);
      arena.restoreSources(); group.remove(tail); arena.sync(Infinity);
    }
  } finally { arena.dispose(); }
});

test('map switches retire GPU storage once per renderer without retaining previous layouts', () => {
  const group = new THREE.BundleGroup(); group.add(source(17, 0));
  const arena = new VoxelFaceArena(group, make), deleted: unknown[][] = [[], []];
  arena.setCompactMapsEnabled(true); settle(arena); const page = arena.pages[0], old = page.map;
  for (const row of deleted) {
    const renderer = { _attributes: { delete: (a: unknown) => row.push(a) } };
    for (let i = 0; i < 2; i++) page.mesh.onBeforeRender(renderer as any,
      null as any, null as any, page.mesh.geometry, page.mesh.material, null as any);
  }
  arena.setCompactMapsEnabled(false); const reference = page.map;
  arena.setCompactMapsEnabled(false); assert.equal(page.map, reference);
  arena.setCompactMapsEnabled(true); const compact = page.map;
  arena.dispose(); arena.dispose();
  for (const row of deleted) assert.deepEqual(row, [old, reference, page.data, compact]);
});

for (const cached of [false, true]) test(`flat blocks outside the camera can cull inside the torus flattening radius (cached=${cached})`, () => {
  const group = new THREE.BundleGroup(), mesh = source(32, 0), data = new Float32Array(24);
  data.set([0, 0, -100, 2, 0, 0, 0, 2, 0, 1, 0, 1], 0);
  data.set([0, 0, 100, 2, 0, 0, 0, 2, 0, 1, 0, 1], 12);
  mesh.geometry.userData.voxelVisibility = data; mesh.geometry.userData.voxelProjection = 'flat'; group.add(mesh);
  const arena = new VoxelFaceArena(group, make), camera = new THREE.PerspectiveCamera(70, 16/9, .1, 1024);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(camera.projectionMatrix);
  const coverage = new THREE.DataTexture(new Uint8Array(1024*128*2),1024,128,THREE.RGFormat);
  arena.setViewOptimizationsEnabled(cached);
  const tick = () => {arena.setView(camera.position, frustum, coverage, true);arena.restoreSources();arena.sync(Infinity);};
  try {
    setWorldProjection('flat');arena.setFlatBlockCullingEnabled(false);tick();assert.equal(arena.stats.visibleFaces,32);
    const original = Array.from(arena.pages[0].map.array);
    arena.setFlatBlockCullingEnabled(true);tick();assert.equal(arena.stats.visibleFaces,16);assert.equal(arena.stats.outsideFaces,16);
    assert.equal(arena.pages[0].map.array[0],0,'the visible front block remains');
    arena.setFlatBlockCullingEnabled(false);tick();assert.deepEqual(Array.from(arena.pages[0].map.array),original);
    arena.setFlatBlockCullingEnabled(true);setWorldProjection('torus');mesh.geometry.userData.voxelProjection='torus';tick();
    assert.equal(arena.stats.visibleFaces,32,'torus keeps the flattening exemption');
  } finally {arena.dispose();coverage.dispose();setWorldProjection('torus');}
});
