import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { DistantChunkLayer } from '../src/render/DistantChunkLayer.ts';
import { TerrainHandoff, TERRAIN_FADE_MS } from '../src/render/TerrainHandoff.ts';

function fixture() {
  const handoff = new TerrainHandoff(), coverage: boolean[] = [];
  const layer = new DistantChunkLayer(handoff.texture, (_x, _z, ready) => coverage.push(ready));
  const boxes = new Uint16Array(256 * 6), colors = new Uint8Array(256 * 3).fill(128);
  for (let i = 0; i < 256; i++) boxes.set([i % 16 * 8, 80, Math.floor(i / 16) * 8, 8, 8, 8], i * 6);
  const source = {chunkX:0,chunkZ:0,revision:1,boxes,colors};
  layer.install(source);
  const internals = layer as any, entry = internals.entries.get('0,0');
  const camera = entry.bounds.center.clone().add(new THREE.Vector3(2000, 0, 0));
  const tick = () => layer.updateView(new THREE.Frustum(), camera, Infinity, 720);
  return { layer, internals, entry, source, handoff, coverage, tick };
}

test('asynchronous proxies retain ownership and use complementary coverage until retirement', t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const f = fixture(), original = f.entry.mesh;
  let retired = false; original.addEventListener('dispose', () => retired = true);
  t.after(() => f.handoff.texture.dispose());
  f.tick();
  assert.equal(f.layer.group.children[0], original, 'keep exact geometry until the replacement is ready');
  assert.equal(f.layer.hasPendingWork, true);
  f.tick();
  const proxy = f.entry.mesh;
  assert.notEqual(proxy, original);
  assert.deepEqual(proxy.userData.authoredCoverage.toArray(), [0, 0]);
  assert.deepEqual(original.userData.authoredCoverage.toArray(), [0, 1]);
  now = TERRAIN_FADE_MS / 2; f.tick();
  assert.deepEqual(proxy.userData.authoredCoverage.toArray(), [0, .5]);
  assert.deepEqual(original.userData.authoredCoverage.toArray(), [.5, 1]);
  assert.deepEqual(f.coverage, [true], 'proxy LOD must never clear authored ownership');
  now = TERRAIN_FADE_MS; f.tick();
  assert.equal(retired, true);
  assert.equal(f.layer.group.children.length, 1);
  assert.equal(f.layer.hasPendingWork, false);
  assert.equal(proxy.geometry.index.count < 256 * 32 * 3, true);
  f.handoff.setReady(0, 0, true, false); f.tick();
  assert.equal(proxy.visible, false, 'fully resident near geometry suppresses the distant draw');
  f.handoff.setReady(0, 0, false, false); f.tick();
  assert.equal(proxy.visible, true);
});

test('a late worker result cannot replace a newer local revision', t => {
  const f = fixture(); t.after(() => f.handoff.texture.dispose());
  f.tick();
  f.layer.install({...f.source,revision:2}, true);
  const current = f.layer.group.children[0];
  f.tick();
  assert.equal(f.layer.group.children[0], current);
  assert.equal(f.internals.entries.get('0,0').revision, 2);
  f.layer.acknowledge(0, 0, 10);
  f.layer.install({...f.source,revision:9});
  assert.equal(f.layer.group.children[0], current);
  f.tick();
  assert.equal(f.layer.group.children.includes(current), true, 'valid replacement cross-fades the latest source');
});

test('disabling cancels pending generation; disposal releases replacement buffers', t => {
  const f = fixture(); t.after(() => f.handoff.texture.dispose());
  f.tick(); f.layer.setActive(false); f.tick();
  assert.equal(f.layer.hasPendingWork, false);
  assert.equal(f.layer.group.children.length, 1);
  f.layer.setActive(true); f.tick(); f.tick();
  const proxy = f.entry.mesh;
  let disposed = false; proxy.geometry.addEventListener('dispose', () => disposed = true);
  f.layer.dispose();
  assert.equal(disposed, true);
  assert.equal(f.layer.group.children.length, 0);
  assert.equal(f.layer.hasPendingWork, false);
});
