import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { bendPoint, hookSceneMaterials, TORUS_R, TORUS_RHO, TORUS_GREF, TORUS_SIZE_Z } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { CHUNK_SIZE_Y } from '@entropydrop/space-engine/voxel/Chunk.ts';
import type { SurfaceZoneSnapshot } from '@entropydrop/space-engine/voxel/SurfaceZoneSnapshot.ts';
import { buildLinkedWorldZone, linkedWorldTransform, LINKED_WORLD_CLEARANCE, LINKED_WORLD_CENTER_OFFSET,
  LINKED_WORLD_TERRAIN_TUBE_RADIUS, LINKED_WORLD_ROTATION_PERIOD_SECONDS,
  LINKED_WORLD_ROTATION_CYCLE_SECONDS } from '../src/engine/render/LinkedWorldGeometry.ts';
import { LinkedWorldSnapshots, selectSnapshotWorlds, LINKED_WORLDS_SETTING_KEY, type LinkedWorldState } from '../src/bootstrap/LinkedWorldSnapshots.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

const worlds = ['nature', 'copper-metropolis', 'aether-archipelago'].map((slug, i) => ({
  id: `world-${i}`, slug, name: slug, seed: 42 + i, terrain_generator_version: i + 1, joined: true,
}));
function zone(): SurfaceZoneSnapshot {
  const faces = new Uint8Array(16), view = new DataView(faces.buffer);
  view.setUint16(2, 64 * 8, true);
  view.setUint16(6, 64 * 8, true); view.setUint16(8, 64 * 8, true);
  faces[10] = 3; faces.set([100, 150, 200], 12);
  return { zoneX: 0, zoneZ: 0, seed: 42, terrainGeneratorVersion: 1, sourceTerrainRevision: 0,
    zoneSizeChunks: 32, samplesPerChunkAxis: 16, sampleSize: 64,
    heightsMicro: new Uint16Array(64), colors: new Uint8Array(192), voxelMips: [{ cellSize: 64, faces }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function snapshotMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse(object => { if (object instanceof THREE.Mesh) meshes.push(object); });
  return meshes;
}

test('three equal rings form an open chain throughout rotation: adjacent links interlock, ends remain unlinked', () => {
  assert.deepEqual(linkedWorldTransform(0, 150).elements, new THREE.Matrix4().elements);
  const count = 2048;
  for (let elapsed = 0; elapsed <= LINKED_WORLD_ROTATION_CYCLE_SECONDS; elapsed += 90) {
    const rings = ([0, 1, 2] as const).map(slot => {
      const transform = linkedWorldTransform(slot, elapsed);
      const center = new THREE.Vector3().applyMatrix4(transform);
      assert.deepEqual(center.toArray(), [slot === 0 ? 0 : slot === 1 ? -LINKED_WORLD_CENTER_OFFSET : LINKED_WORLD_CENTER_OFFSET, 0, 0]);
      assert.ok(Math.abs(new THREE.Vector3(TORUS_R, 0, 0).applyMatrix4(transform).distanceTo(center) - TORUS_R) < 1e-9);
      return { center, normal: new THREE.Vector3(0, 1, 0).transformDirection(transform),
        points: Array.from({length: count}, (_, sample) => {
          // Offset samples so plane crossings do not land exactly on endpoints.
          const angle = (sample + .271) * 2 * Math.PI / count;
          return new THREE.Vector3(TORUS_R * Math.cos(angle), 0, TORUS_R * Math.sin(angle)).applyMatrix4(transform);
        }) };
    });
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
      const a = rings[i], b = rings[j];
      let separation = Infinity, signedPiercings = 0;
      for (let sample = 0; sample < count; sample++) {
        const p = a.points[sample], q = a.points[(sample + 1) % count];
        const delta = p.clone().sub(b.center), height = delta.dot(b.normal);
        separation = Math.min(separation, Math.hypot(height,
          Math.sqrt(Math.max(0, delta.lengthSq() - height * height)) - TORUS_R));
        const nextHeight = q.clone().sub(b.center).dot(b.normal);
        if (height * nextHeight < 0) {
          const crossing = p.clone().lerp(q, height / (height - nextHeight));
          if (crossing.distanceTo(b.center) < TORUS_R) signedPiercings += nextHeight > height ? 1 : -1;
        }
      }
      assert.equal(Math.abs(signedPiercings), i === 0 ? 1 : 0, `phase ${elapsed}, linking number for ${i}/${j}`);
      assert.ok(Math.abs(separation - 2 * TORUS_R / 3) < .05, `phase ${elapsed}, clearance for ${i}/${j}`);
      assert.ok(separation - 2 * TORUS_RHO >= LINKED_WORLD_CLEARANCE.referenceSurface - 1e-9);
    }
    assert.ok(rings[1].center.distanceTo(rings[2].center) > 2 * (TORUS_R + LINKED_WORLD_TERRAIN_TUBE_RADIUS),
      'end links have disjoint enclosing spheres, so cannot interlock');
  }
});

test('full-height terrain stays in separated tube envelopes through the chain', () => {
  const maximumTubeRadius = TORUS_RHO + (CHUNK_SIZE_Y - TORUS_GREF) * (1 + TORUS_RHO / TORUS_R);
  assert.equal(LINKED_WORLD_TERRAIN_TUBE_RADIUS, maximumTubeRadius);
  assert.ok(Math.abs(LINKED_WORLD_CLEARANCE.referenceSurface - 1086.497744840672) < 1e-8);
  assert.ok(Math.abs(LINKED_WORLD_CLEARANCE.terrainEnvelope - 546.497744840672) < 1e-8);
  for (const slot of [0, 1, 2] as const) {
    const transform = linkedWorldTransform(slot, 193);
    const centerline = new THREE.Vector3(TORUS_R, 0, 0).applyMatrix4(transform);
    for (const y of [0, TORUS_GREF, CHUNK_SIZE_Y]) for (let z = 0; z < TORUS_SIZE_Z; z += 4) {
      const distance = bendPoint(0, y, z).applyMatrix4(transform).distanceTo(centerline);
      assert.ok(distance <= maximumTubeRadius + 1e-9);
    }
  }
  assert.ok(LINKED_WORLD_CLEARANCE.terrainEnvelope > 0);
});

test('snapshot geometry uses bent coordinates, local world transforms and outward surface winding', () => {
  const transform = linkedWorldTransform(1), geometry = buildLinkedWorldZone(zone(), transform);
  const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
  assert.equal(positions.count, 24, '64m quads subdivide into four curved 32m quads');
  const actual = new THREE.Vector3().fromBufferAttribute(positions, 0);
  const expected = bendPoint(0, 64, 0).applyMatrix4(transform);
  assert.ok(actual.distanceTo(expected) < .001);
  const outward = bendPoint(0, 65, 0).applyMatrix4(transform).sub(expected).normalize();
  assert.ok(new THREE.Vector3().fromBufferAttribute(normals, 0).dot(outward) > .98);
  assert.ok(geometry.boundingSphere && Number.isFinite(geometry.boundingSphere.radius));
  geometry.dispose();
});

test('legacy fine snapshots are coarsened to bounded snapshot geometry and retain tall terrain', () => {
  const source = zone(); delete source.voxelMips;
  source.sampleSize = 2;
  source.heightsMicro = new Uint16Array(256 * 256);
  source.colors = new Uint8Array(256 * 256 * 3).fill(100);
  source.heightsMicro[17 * 256 + 17] = 128 * 8;
  const geometry = buildLinkedWorldZone(source, linkedWorldTransform(0));
  assert.ok(geometry.getAttribute('position').count > 0);
  assert.ok(geometry.getAttribute('position').count < 1000);
  const empty = buildLinkedWorldZone(zone(), linkedWorldTransform(0));
  geometry.dispose(); empty.dispose();
});

test('catalog selects two distinct companions and prefers the three public worlds', () => {
  assert.deepEqual(selectSnapshotWorlds({ worlds: [worlds[2], worlds[0], worlds[1], worlds[1]] }, worlds[1].id)
    .map(world => world.id), [worlds[0].id, worlds[2].id]);
  assert.throws(() => selectSnapshotWorlds({ worlds: [worlds[0]] }, worlds[0].id), /Two additional/);
  assert.throws(() => selectSnapshotWorlds({ worlds: [{ ...worlds[0], seed: NaN }] }, 'other'), /Invalid/);
});

test('one-shot snapshots publish atomically, replace overview meshes, skip picking/bending and dispose on disable', async () => {
  const scene = new THREE.Scene(), states: LinkedWorldState[] = [], requests: Array<[string, string]> = [];
  let passes = 0, disposed = 0;
  const layer = new LinkedWorldSnapshots({ scene, apiOrigin: 'http://localhost:8000', token: 'test', currentWorldId: worlds[0].id,
    onState: state => states.push(state),
    fetchImpl: async (input, init) => {
      requests.push([String(input), init?.method ?? 'GET']);
      return new Response(JSON.stringify({ worlds: worlds.map(world => ({ ...world, joined: false })) }));
    },
    createRemote: () => ({ loadAll: async onZone => {
      passes++;
      assert.equal(scene.children.length, 0, 'partial snapshot worlds stay hidden');
      await onZone(zone()); await onZone(zone());
      return { loaded: 1, complete: true };
    } }),
  });
  assert.equal(requests.length, 0, 'off performs no work');
  await layer.setEnabled(true);
  assert.equal(layer.getState().status, 'ready');
  assert.equal(passes, 2);
  assert.equal(scene.children.length, 1);
  const group = scene.children[0];
  const meshes = snapshotMeshes(group);
  assert.equal(meshes.length, 2, 'overview/detail publications cannot leave overlapping copies');
  const material = meshes[0].material as THREE.Material;
  hookSceneMaterials(scene);
  assert.equal(material.userData.torusNode, undefined, 'pre-bent snapshots cannot be bent again');
  const allMeshes = snapshotMeshes(group);
  const materials = new Set(allMeshes.map(mesh => mesh.material as THREE.Material));
  for (const child of allMeshes) {
    const hits: THREE.Intersection[] = [];
    child.raycast(new THREE.Raycaster(), hits);
    assert.deepEqual(hits, []);
    child.geometry.addEventListener('dispose', () => { disposed++; });
  }
  for (const ownedMaterial of materials) {
    assert.equal(ownedMaterial.userData.torusNode, undefined);
    ownedMaterial.addEventListener('dispose', () => { disposed++; });
  }
  await layer.setEnabled(true);
  assert.equal(passes, 2, 'enabled snapshots are not refreshed');
  assert.deepEqual(requests.map(([url, method]) => [new URL(url).pathname, method]), [
    ['/space/api/v2/worlds', 'GET'], ['/space/api/v2/worlds/world-1/join', 'POST'], ['/space/api/v2/worlds/world-2/join', 'POST'],
  ]);
  await layer.setEnabled(false);
  assert.equal(disposed, allMeshes.length + materials.size);
  assert.equal(scene.children.length, 0);
  assert.equal(states.at(-1)?.status, 'off');
  await layer.setEnabled(true);
  assert.equal(passes, 4, 're-enabling loads a new snapshot');
  layer.dispose();
});

test('end links spin slowly and independently without moving their planes, changing snapshots or advancing the live world', async () => {
  const scene = new THREE.Scene(), live = new THREE.Group();
  live.position.set(12, 34, 56); scene.add(live);
  let downloads = 0;
  const layer = new LinkedWorldSnapshots({ scene, apiOrigin: 'http://localhost:8000', token: 'test', currentWorldId: worlds[0].id,
    onState: () => {}, fetchImpl: async () => new Response(JSON.stringify({ worlds })),
    createRemote: () => ({ loadAll: async onZone => {
      downloads++; layer.update(30);
      await onZone(zone()); return { loaded: 1, complete: true };
    } }),
  });
  layer.update(50);
  await layer.setEnabled(true);
  scene.updateMatrixWorld(true);
  const group = scene.children[1], meshes = snapshotMeshes(group);
  const left = meshes[0].parent!, right = meshes[1].parent!;
  assert.equal(left.parent!.parent, group);
  assert.equal(right.parent!.parent, group, 'end links have independent placements');
  assert.equal(snapshotMeshes(group).length, 2, 'no gimbal shafts or bearings remain');
  assert.equal(left.rotation.y, 0);
  assert.equal(Math.abs(right.rotation.y), 0, 'loading time does not advance rotation');
  const arrays = meshes.map(mesh => mesh.geometry.getAttribute('position').array), copies = arrays.map(array => array.slice());
  const liveMatrix = live.matrixWorld.clone();
  const originalPoint = new THREE.Vector3().fromBufferAttribute(meshes[0].geometry.getAttribute('position'), 0).applyMatrix4(meshes[0].matrixWorld);
  let elapsed = 0;
  const checkPlacement = () => {
    scene.updateMatrixWorld(true);
    for (let index = 0; index < 2; index++) {
      const slot = index === 0 ? 1 : 2, base = linkedWorldTransform(slot), expected = linkedWorldTransform(slot, elapsed);
      meshes[index].matrixWorld.elements.forEach((value, i) => assert.ok(Math.abs(value - expected.elements[i]) < 1e-10));
      assert.ok(new THREE.Vector3(0, 1, 0).transformDirection(meshes[index].matrixWorld)
        .distanceTo(new THREE.Vector3(0, 1, 0).transformDirection(base)) < 1e-9);
      for (let sample = 0; sample < 16; sample++) {
        const angle = sample * Math.PI / 8;
        const point = new THREE.Vector3(TORUS_R * Math.cos(angle), 0, TORUS_R * Math.sin(angle))
          .applyMatrix4(meshes[index].matrixWorld).applyMatrix4(base.clone().invert());
        assert.ok(Math.abs(point.y) < 1e-9 && Math.abs(Math.hypot(point.x, point.z) - TORUS_R) < 1e-9,
          'spin leaves each circle and its clearance unchanged');
      }
    }
  };
  checkPlacement();
  for (let frame = 0; frame < 60; frame++) layer.update(1 / 60);
  elapsed = 1;
  assert.ok(Math.abs(left.rotation.y - 2 * Math.PI / LINKED_WORLD_ROTATION_PERIOD_SECONDS[0]) < 1e-12);
  assert.ok(Math.abs(right.rotation.y + 2 * Math.PI / LINKED_WORLD_ROTATION_PERIOD_SECONDS[1]) < 1e-12);
  checkPlacement();
  assert.ok(new THREE.Vector3().fromBufferAttribute(meshes[0].geometry.getAttribute('position'), 0)
    .applyMatrix4(meshes[0].matrixWorld).distanceTo(originalPoint) > 20, 'terrain visibly moves around the ring');
  for (const dt of [29, 150, 540, 360, 600, 480]) {
    elapsed += dt; layer.update(dt); checkPlacement();
  }
  assert.equal(elapsed, LINKED_WORLD_ROTATION_CYCLE_SECONDS);
  assert.ok(new THREE.Vector3().fromBufferAttribute(meshes[0].geometry.getAttribute('position'), 0)
    .applyMatrix4(meshes[0].matrixWorld).distanceTo(originalPoint) < 1e-8);
  assert.deepEqual(live.matrixWorld.elements, liveMatrix.elements);
  meshes.forEach((mesh, index) => {
    assert.equal(mesh.geometry.getAttribute('position').array, arrays[index]);
    assert.deepEqual(arrays[index], copies[index], 'animation never rebuilds snapshot vertices');
  });
  assert.equal(downloads, 2, 'animation never refreshes snapshots');
  const phase = left.rotation.y;
  for (const invalid of [NaN, Infinity, -1, 0]) layer.update(invalid);
  assert.equal(left.rotation.y, phase);
  layer.dispose(); layer.update(10);
  assert.equal(left.rotation.y, phase, 'disabled layers stop advancing');
  await layer.setEnabled(true);
  const newLeft = snapshotMeshes(scene.children[1])[0].parent!;
  assert.equal(newLeft.rotation.y, 0, 're-enabling resets rotation');
  layer.update(1);
  assert.ok(Math.abs(newLeft.rotation.y - 2 * Math.PI / LINKED_WORLD_ROTATION_PERIOD_SECONDS[0]) < 1e-12,
    'speed is independent of frame subdivision');
  layer.dispose();
});

test('disable aborts requests and late publications cannot resurrect an old load after re-enable', async () => {
  const scene = new THREE.Scene(), oldLoad = deferred<void>();
  let calls = 0, signal: AbortSignal | undefined;
  const layer = new LinkedWorldSnapshots({ scene, apiOrigin: 'http://localhost:8000', token: 'test', currentWorldId: worlds[0].id,
    onState: () => {}, fetchImpl: async (_url, init) => {
      signal ??= init?.signal as AbortSignal;
      return new Response(JSON.stringify({ worlds }));
    },
    createRemote: () => ({ loadAll: async onZone => {
      if (++calls === 1) await oldLoad.promise;
      await onZone(zone());
      return { loaded: 1, complete: true };
    } }),
  });
  const first = layer.setEnabled(true);
  while (!calls) await new Promise(resolve => setTimeout(resolve, 0));
  await layer.setEnabled(false);
  assert.equal(signal?.aborted, true);
  await layer.setEnabled(true);
  oldLoad.resolve(); await first;
  assert.equal(layer.getState().status, 'ready');
  assert.equal(scene.children.length, 1);
  assert.equal(snapshotMeshes(scene.children[0]).length, 2);
  layer.dispose();
});

test('incomplete and failed snapshots leave the live scene intact and can be retried', async () => {
  const scene = new THREE.Scene(), live = new THREE.Group(); scene.add(live);
  let complete = false;
  const layer = new LinkedWorldSnapshots({ scene, apiOrigin: 'http://localhost:8000', token: 'test', currentWorldId: worlds[0].id,
    onState: () => {}, fetchImpl: async () => new Response(JSON.stringify({ worlds })),
    createRemote: () => ({ loadAll: async onZone => { await onZone(zone()); return { loaded: 1, complete }; } }),
  });
  await layer.setEnabled(true);
  assert.equal(layer.getState().status, 'error');
  assert.deepEqual(scene.children, [live]);
  complete = true; await layer.setEnabled(true);
  assert.equal(layer.getState().status, 'ready');
  layer.dispose(); assert.deepEqual(scene.children, [live]);
});

test('saved opt-in restores after connecting, persists toggles and tolerates unavailable local storage', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>([[LINKED_WORLDS_SETTING_KEY, 'true']]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as any).localStorage;
  });
  const store = new SpaceUiStore(), applied: boolean[] = [];
  assert.equal(store.getSnapshot().linkedWorlds.enabled, false);
  store.connectLinkedWorlds(enabled => {
    applied.push(enabled); store.setLinkedWorldState({ enabled, status: enabled ? 'loading' : 'off', message: '' });
  });
  assert.equal(store.getSnapshot().linkedWorlds.enabled, true);
  store.setLinkedWorldsEnabled(false);
  assert.equal(values.get(LINKED_WORLDS_SETTING_KEY), 'false');
  assert.deepEqual(applied, [true, false]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('blocked'); } });
  assert.doesNotThrow(() => store.setLinkedWorldsEnabled(true));
  store.connectLinkedWorlds(enabled => applied.push(enabled));
  assert.equal(applied.at(-1), false);
});
