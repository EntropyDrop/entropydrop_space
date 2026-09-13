import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CrossPlaneImpostorLod, IMPOSTOR_TEXTURE_SIZE, IMPOSTOR_CACHE_LIMIT, type ImpostorSource } from '../src/engine/render/CrossPlaneImpostor.ts';
import { DetachedBlockImpostors, separateDetachedBlocks } from '../src/engine/render/DetachedBlockImpostors.ts';
import { VoxelImpostorSources } from '../src/engine/render/VoxelImpostorSources.ts';
import { Chunk } from '@entropydrop/space-engine/voxel/Chunk.ts';
import { LowPolyMesher } from '@entropydrop/space-engine/mesher/LowPolyMesher.ts';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { TORUS_SIZE_X } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';

function box(color = 0xff0000, x = 0, y = 0, z = 0, size: number[] = [1, 1, 1]) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial({ color }));
  mesh.position.set(x, y, z);
  return mesh;
}

function source(meshes = [box()]): ImpostorSource {
  const parent = new THREE.Group();
  parent.add(...meshes);
  return { key: parent, parent, meshes, bounds: new THREE.Box3().setFromObject(parent) };
}

function proxy(input: ImpostorSource) {
  return input.parent.children.find(child => child.name === 'CrossPlaneImpostor') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
}

const far = new THREE.Vector3(0, 0, 150);

test('a finished far proxy has two crossed planes and separate front/back color projections', () => {
  const lod = new CrossPlaneImpostorLod();
  const input = source([box(0xff0000, 0, 0, 0.6), box(0x0000ff, 0, 0, -0.6)]);
  lod.beginRender([input], far, Infinity);
  const mesh = proxy(input);
  assert.ok(mesh?.visible);
  assert.equal(mesh.geometry.getAttribute('position').count, 8);
  assert.equal(mesh.geometry.index.count, 12, 'four triangles replace all source faces');
  const image = mesh.material.map.image as { data: Uint8Array; width: number; height: number };
  const size = IMPOSTOR_TEXTURE_SIZE;
  const pixel = (view: number, x = size / 2, y = size / 2) => [...image.data.subarray((y * image.width + view * size + x) * 4, (y * image.width + view * size + x) * 4 + 4)];
  assert.deepEqual(pixel(0), [255, 0, 0, 255]);
  assert.deepEqual(pixel(1), [0, 0, 255, 255]);
  assert.equal(mesh.material.transparent, false);
  assert.equal(mesh.material.alphaTest, 0.5);
  assert.equal(mesh.material.depthWrite, true);
  const shader: any = { uniforms: {}, vertexShader: '#include <project_vertex>', fragmentShader: '#include <map_fragment>' };
  mesh.material.onBeforeCompile(shader, null);
  assert.match(shader.fragmentShader, /gl_FrontFacing/);
  assert.match(shader.vertexShader, /torusBend/);
  assert.ok(input.meshes.every(mesh => !mesh.visible));
  lod.endRender();
  assert.ok(input.meshes.every(mesh => mesh.visible));
  assert.equal(mesh.visible, false, 'physics/editor code must never inherit impostor visibility');
  input.parent.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1));
  assert.ok(ray.intersectObject(input.parent, true).every(hit => hit.object !== mesh), 'the cached proxy must not intercept picking');
  lod.dispose();
});

test('silhouette textures retain holes instead of drawing a filled bounding rectangle', () => {
  const input = source([
    box(0xff0000, -1, 0, 0, [0.25, 2.25, 0.25]), box(0xff0000, 1, 0, 0, [0.25, 2.25, 0.25]),
    box(0xff0000, 0, -1, 0, [2, 0.25, 0.25]), box(0xff0000, 0, 1, 0, [2, 0.25, 0.25]),
  ]);
  const lod = new CrossPlaneImpostorLod();
  lod.beginRender([input], far, Infinity);
  const { data, width } = proxy(input).material.map.image as any;
  assert.equal(data[(32 * width + 32) * 4 + 3], 0);
  assert.equal(data[(32 * width + 2) * 4 + 3], 255);
  lod.dispose();
});

test('distance hysteresis, high viewpoints, selection protection and torus seams restore full geometry', () => {
  const input = source();
  const lod = new CrossPlaneImpostorLod();
  lod.beginRender([input], far, Infinity);
  const cached = proxy(input);
  lod.endRender();
  lod.beginRender([input], new THREE.Vector3(0, 0, 75), 0);
  assert.equal(cached.visible, true, 'moving slightly back across the entry distance should not flicker');
  lod.endRender();
  lod.beginRender([input], new THREE.Vector3(0, 0, 60), 0);
  assert.equal(input.meshes[0].visible, true);
  lod.endRender();
  lod.beginRender([input], new THREE.Vector3(0, 200, 100), 0);
  assert.equal(cached.visible, false, 'crossed vertical planes are unsuitable from above');
  lod.endRender();
  lod.beginRender([{ ...input, protected: true }], far, 0);
  assert.equal(cached.visible, false);
  lod.endRender();
  lod.beginRender([input], new THREE.Vector3(TORUS_SIZE_X - 2, 0, 0), 0);
  assert.equal(cached.visible, false, 'wrapping across the seam is still a nearby object');
  lod.dispose();
});

test('baking is budgeted and a color change cannot display a stale silhouette', t => {
  const input = source([box(0xff0000, 0, 0, 0, [4, 4, 4])]);
  const lod = new CrossPlaneImpostorLod();
  let time = 0;
  t.mock.method(performance, 'now', () => time += 0.5);
  lod.beginRender([input], far, 2);
  assert.equal(proxy(input), undefined, 'incomplete baking must retain the source mesh');
  assert.equal(input.meshes[0].visible, true);
  lod.endRender();
  lod.beginRender([input], far, Infinity);
  const old = proxy(input);
  let disposed = 0;
  old.material.map.addEventListener('dispose', () => disposed++);
  lod.endRender();
  (input.meshes[0].material as THREE.MeshBasicMaterial).color.setHex(0x00ff00);
  lod.beginRender([input], far, 0);
  assert.equal(disposed, 1);
  assert.equal(old.parent, null);
  assert.equal(input.meshes[0].visible, true);
  lod.endRender();
  lod.beginRender([input], far, Infinity);
  assert.notEqual(proxy(input), old);
  lod.dispose();
});

test('published geometry and attribute replacement invalidate a cached silhouette', () => {
  const input = source();
  const lod = new CrossPlaneImpostorLod();
  lod.beginRender([input], far, Infinity);
  const old = proxy(input);
  lod.endRender();
  input.meshes[0].geometry = new THREE.BoxGeometry(2, 3, 4);
  lod.beginRender([input], far, 0);
  assert.equal(old.parent, null);
  assert.equal(input.meshes[0].visible, true, 'the new published mesh renders until its bake is ready');
  lod.endRender();
  lod.beginRender([input], far, Infinity);
  const rebuilt = proxy(input);
  assert.equal(rebuilt.geometry.boundingBox.max.y, 1.5);
  lod.endRender();
  const geometry = input.meshes[0].geometry;
  geometry.setAttribute('position', geometry.getAttribute('position').clone());
  lod.beginRender([input], far, 0);
  assert.equal(rebuilt.parent, null, 'a new version-zero buffer is still a source change');
  lod.dispose();
});

test('source deletion and the cache limit release proxy resources without disposing original geometry', () => {
  const lod = new CrossPlaneImpostorLod();
  const input = source();
  let originalDisposals = 0;
  input.meshes[0].geometry.addEventListener('dispose', () => originalDisposals++);
  lod.beginRender([input], far, Infinity);
  const old = proxy(input);
  let releases = 0;
  old.material.addEventListener('dispose', () => releases++);
  lod.endRender();
  lod.beginRender([], far, 0);
  assert.equal(releases, 1);
  assert.equal(originalDisposals, 0);
  const inputs = Array.from({ length: IMPOSTOR_CACHE_LIMIT + 10 }, () => source());
  lod.beginRender(inputs, far, 0);
  assert.equal((lod as any).records.size, IMPOSTOR_CACHE_LIMIT);
  lod.dispose();
});

function floatingBlocksChunk() {
  const chunk = new Chunk(0, 0, null);
  // Ground is connected to boundaries. Nine floating colored cubes are not.
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setLocalBlock(x, 0, z, BlockTypes.COLOR_BLOCK, 0x808080);
  for (const x of [3, 7, 11]) for (const z of [3, 7, 11]) chunk.setLocalBlock(x, 8, z, BlockTypes.COLOR_BLOCK, 0xff0000);
  chunk.hasUserEdits = true;
  chunk.publishedDataVersion = chunk.dataVersion;
  chunk.mesh = new LowPolyMesher().buildChunkMesh(chunk);
  return chunk;
}

function finish<T>(job: Generator<void, T>) {
  let next = job.next();
  while (!next.done) next = job.next();
  return next.value;
}

test('detached block grouping preserves continuous ground and uses only the floating geometry bounds', () => {
  const chunk = floatingBlocksChunk();
  const mesh = chunk.mesh.children[0];
  const originalCount = mesh.geometry.index.count;
  const part = finish(separateDetachedBlocks(chunk, mesh));
  assert.ok(part);
  assert.equal(part.bounds.min.y, 8);
  assert.equal(part.bounds.max.y, 9);
  assert.equal(part.helper.geometry.index.count + part.remainder.index.count, originalCount);
  const input = { key: part.helper, parent: chunk.mesh, meshes: [part.helper], bounds: part.bounds };
  const lod = new CrossPlaneImpostorLod();
  lod.beginRender([input], new THREE.Vector3(8, 8, 200), Infinity);
  assert.equal(proxy(input).geometry.boundingBox.min.y, 8, 'unused ground vertices must not stretch the atlas');
  lod.dispose();
});

test('the world collector swaps only detached faces while drawing and restores them before edits', () => {
  const chunk = floatingBlocksChunk();
  const world = { chunks: new Map([['0,0', chunk]]), activeChunkKeys: new Set(['0,0']) };
  const collector = new DetachedBlockImpostors();
  const camera = new THREE.Vector3(8, 8, 200);
  const [input] = [...collector.sources(world, camera, Infinity)];
  assert.ok(input);
  const mainMesh = chunk.mesh.children[0];
  const original = mainMesh.geometry;
  const lod = new CrossPlaneImpostorLod();
  lod.beginRender([input], camera, Infinity);
  assert.notEqual(mainMesh.geometry, original);
  assert.ok(mainMesh.geometry.index.count < original.index.count);
  assert.equal(mainMesh.visible, true, 'continuous ground still renders');
  lod.endRender();
  assert.equal(mainMesh.geometry, original);
  lod.dispose();
  collector.dispose();
});

test('entity collection preserves articulated parent frames and exempts the edited entity', () => {
  const entity = new Contraption(1, [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }], new THREE.Vector3(), new THREE.Scene());
  const collector = new VoxelImpostorSources();
  const world = { chunks: new Map(), activeChunkKeys: new Set() };
  const [input] = [...collector.sources(world, [entity], far, new Set([entity]))];
  assert.equal(input.parent, (entity.entityNodes.get(entity.rootComponentId) as any).voxelChunkGroup);
  assert.equal(input.protected, true);
  collector.dispose();
});

test('micro terrain stays connected across world seams and delayed neighbor publication', () => {
  const mesh = box();
  mesh.userData = { bentSpan: 2, occupiedMinY: 8, occupiedMaxY: 10, standardChunkKey: '0,0' };
  const parent = new THREE.Group();
  parent.add(mesh);
  const meshes = new Map([['0,0,4', mesh]]);
  const world = { chunks: new Map(), activeChunkKeys: new Set(['0,0']), terrainVersion: 1, microVoxels: { meshChunks: meshes } };
  const collector = new VoxelImpostorSources();
  assert.equal([...collector.sources(world, [], far, new Set())].length, 1);
  // Publishing a neighboring mesh does not bump the terrain edit counter.
  meshes.set(`${TORUS_SIZE_X / 2 - 1},0,4`, box());
  assert.equal([...collector.sources(world, [], far, new Set())].length, 0);
  meshes.delete(`${TORUS_SIZE_X / 2 - 1},0,4`);
  meshes.set('0,0,5', box());
  assert.equal([...collector.sources(world, [], far, new Set())].length, 0);
  collector.dispose();
});

function staticBuilding() {
  const scene = new THREE.Scene();
  const world: any = { chunks: new Map(), activeChunkKeys: new Set(['0,0']) };
  const manager = new ContraptionManager(scene, world, null, null);
  const entity = new Contraption(42, [
    { localX: 0, localY: 0, localZ: 0, size: 16, color: 0xff0000, block: BlockTypes.COLOR_BLOCK },
    { localX: 48, localY: 0, localZ: 0, size: 16, color: 0x0000ff, block: BlockTypes.COLOR_BLOCK },
  ], new THREE.Vector3(100, 20, 100), scene, { rootComponentId: 'castle', bodyType: 'static' });
  entity.quaternion.setFromEuler(new THREE.Euler(0, 0.4, 0));
  entity.updateTransform();
  manager.registerContraption(entity);
  const key = manager.getContraptionChunk(entity).id;
  world.activeChunkKeys = new Set([key]);
  const collector = new VoxelImpostorSources();
  const lod = new CrossPlaneImpostorLod(scene);
  const camera = entity.position.clone().add(new THREE.Vector3(0, 0, 60));
  const inputs = () => [...collector.sources(world, manager.contraptions, camera, new Set(), manager)];
  const visibleProxies = () => scene.children.filter(child => child.name === 'CrossPlaneImpostor' && child.visible);
  const dispose = () => { lod.dispose(); collector.dispose(); manager.removeContraption(manager.contraptions[0]); };
  return { scene, world, manager, entity, key, collector, lod, camera, inputs, visibleProxies, dispose };
}

test('a large static building remains visible after real entity chunk unload and disappears when deleted', () => {
  const fixture = staticBuilding();
  const { lod, manager, entity, world, scene, camera, inputs, visibleProxies } = fixture;
  const [input] = inputs();
  input.parent.updateWorldMatrix(true, false);
  const expectedFrame = input.parent.matrixWorld.clone();
  lod.beginRender([input], camera, Infinity);
  assert.equal(visibleProxies().length, 0, 'nearby buildings remain detailed inside the configured threshold');
  assert.equal(scene.children.filter(child => child.name === 'CrossPlaneImpostor').length, 1, 'prewarm before the unload boundary');
  lod.endRender();

  world.activeChunkKeys = new Set(['200,200']);
  manager.syncContraptionsToLoadedChunks();
  assert.equal(manager.contraptions.length, 0);
  assert.equal(entity.rootGroup.parent, null, 'the real full geometry has been removed by streaming');
  lod.beginRender(inputs(), camera, 0);
  const [distant] = visibleProxies() as THREE.Mesh[];
  assert.ok(distant, 'the independent scene layer must outlive the unloaded parent');
  assert.equal(distant.geometry.index.count, 12);
  assert.ok(distant.matrix.equals(expectedFrame), 'preserve the rotated building position');
  const [cached] = (lod as any).records.values();
  assert.equal(cached.source, null, 'do not retain a disposed entity hierarchy');
  assert.equal(cached.snapshots.length, 0, 'retain only the small baked proxy');
  lod.endRender();

  lod.setEntitySettings({ maxDistance: 500 });
  lod.beginRender(inputs(), camera.clone().add(new THREE.Vector3(2000, 0, 0)), 0);
  assert.equal(visibleProxies().length, 0, 'respect the far visibility limit');
  lod.endRender();
  manager.deleteDormantContraption(entity.publicId);
  lod.beginRender(inputs(), camera, 0);
  assert.equal(distant.parent, null, 'deletion must not leave a ghost castle');
  lod.dispose(); fixture.collector.dispose();
});

test('entity plane thresholds change immediately for loaded and streamed-out sources without rebuilding', () => {
  const scene = new THREE.Scene();
  const input = { ...source(), kind: 'entity' as const, retain: () => true };
  scene.add(input.parent);
  const lod = new CrossPlaneImpostorLod(scene);
  const camera = new THREE.Vector3(0, 0, 300);
  lod.setEntitySettings({ startDistance: 400, maxDistance: 1000 });
  lod.beginRender([input], camera, Infinity);
  const cached = scene.children.find(child => child.name === 'CrossPlaneImpostor');
  assert.ok(cached);
  assert.equal(cached.visible, false);
  lod.endRender();
  lod.setEntitySettings({ startDistance: 80 });
  lod.beginRender([input], camera, 0);
  assert.equal(cached.visible, true, 'the configured entry threshold is live');
  lod.endRender();
  lod.setEntitySettings({ maxDistance: 200 });
  lod.beginRender([input], camera, 0);
  assert.equal(cached.visible, false);
  assert.equal(input.meshes[0].visible, false, 'exceeding the plane limit must not bring back a full far mesh');
  lod.endRender();
  assert.equal(input.meshes[0].visible, true, 'the editor still sees the full source');
  scene.remove(input.parent);
  lod.beginRender([], camera, 0);
  assert.equal(cached.visible, false);
  lod.endRender();
  lod.setEntitySettings({ maxDistance: 1000 });
  lod.beginRender([], camera, 0);
  assert.equal(cached.visible, true, 'expanding the independent range reuses the cached silhouette');
  lod.dispose();
});

test('pending building bakes survive unload and reloading replaces the retained proxy with full geometry', () => {
  const fixture = staticBuilding();
  const { lod, manager, world, camera, inputs, visibleProxies, key } = fixture;
  lod.beginRender(inputs(), camera, 0);
  assert.equal(visibleProxies().length, 0);
  lod.endRender();
  world.activeChunkKeys = new Set(['200,200']);
  manager.syncContraptionsToLoadedChunks();
  lod.beginRender(inputs(), camera, Infinity);
  const [oldProxy] = visibleProxies();
  assert.ok(oldProxy, 'a pending CPU projection can finish after full meshes are disposed');
  lod.endRender();
  world.activeChunkKeys = new Set([key]);
  manager.syncContraptionsToLoadedChunks();
  assert.equal(manager.contraptions.length, 1);
  const restored = inputs();
  lod.beginRender(restored, camera, 0);
  assert.equal(oldProxy.parent, null, 'freshly loaded geometry invalidates the old proxy');
  assert.ok(restored.every(source => source.meshes.every(mesh => mesh.visible)));
  assert.equal(visibleProxies().length, 0, 'never overlap the detailed building with a retained ghost');
  fixture.dispose();
});

test('online AOI cleanup can release dormant full entities while independently retaining their planes', () => {
  const fixture = staticBuilding();
  const { lod, manager, world, camera, collector, entity, visibleProxies } = fixture;
  const remote = new Set<string>();
  const inputs = () => [...collector.sources(world, manager.contraptions, camera, new Set(), manager, id => remote.has(id))];
  lod.beginRender(inputs(), camera, Infinity);
  lod.endRender();
  world.activeChunkKeys = new Set(['200,200']);
  manager.syncContraptionsToLoadedChunks();
  remote.add(entity.publicId);
  manager.deleteDormantContraption(entity.publicId);
  assert.equal(manager.getDormantContraptionCount(), 0);
  lod.beginRender(inputs(), camera, 0);
  assert.equal(visibleProxies().length, 1, 'render retention is independent of both active and dormant entity storage');
  lod.endRender();
  remote.delete(entity.publicId);
  lod.beginRender(inputs(), camera, 0);
  assert.equal(visibleProxies().length, 0);
  lod.dispose(); collector.dispose();
});
