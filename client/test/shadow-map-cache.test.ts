import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ShadowMapCache, snapShadowToTexels } from '../src/engine/render/ShadowMapCache.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';

function fixture() {
  const scene = new THREE.Scene();
  const light = new THREE.DirectionalLight();
  light.position.set(40, 60, 20);
  scene.add(light, light.target);
  const caster: THREE.Mesh<THREE.BufferGeometry, THREE.Material> = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  caster.castShadow = true;
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  scene.add(caster, receiver);
  scene.updateMatrixWorld(true);
  const cache = new ShadowMapCache();
  const extras = [1, 1, 0];
  const frame = () => { scene.updateMatrixWorld(true); return cache.needsRender(scene, light.shadow, light, extras); };
  return { scene, light, caster, receiver, cache, extras, frame };
}

test('an unchanged shadow pass reuses the previous map', () => {
  const { frame, cache } = fixture();
  assert.equal(frame(), true, 'first frame renders');
  assert.equal(frame(), false);
  assert.equal(frame(), false);
  assert.deepEqual([cache.stats.rendered, cache.stats.reused], [1, 2]);
});

test('caster, light and global projection changes redraw the map', () => {
  const { frame, caster, light, extras, cache, scene } = fixture();
  frame();
  const changes: Array<[string, () => void]> = [
    ['caster moves', () => caster.position.x += 0.001],
    ['caster rotates', () => caster.rotation.y += 0.01],
    ['geometry is rewritten', () => { caster.geometry.attributes.position.needsUpdate = true; }],
    ['draw range shrinks', () => caster.geometry.setDrawRange(0, 6)],
    ['index is rewritten', () => { caster.geometry.index!.needsUpdate = true; }],
    ['material is swapped', () => { caster.material = new THREE.MeshBasicMaterial(); }],
    ['material is recompiled', () => { (caster.material as THREE.Material).needsUpdate = true; }],
    ['caster is hidden', () => { caster.visible = false; }],
    ['caster reappears', () => { caster.visible = true; }],
    ['caster stops casting', () => { caster.castShadow = false; }],
    ['caster casts again', () => { caster.castShadow = true; }],
    ['new caster is added', () => { const m = new THREE.Mesh(new THREE.BoxGeometry()); m.castShadow = true; scene.add(m); }],
    ['light moves', () => light.position.y += 1],
    ['shadow frustum changes', () => { light.shadow.camera.right = 99; }],
    ['shadow map is resized', () => light.shadow.mapSize.set(2048, 2048)],
    ['view correction changes', () => extras[1]++],
    ['projection changes', () => extras[0]++],
    ['coverage texture changes', () => extras[2]++],
  ];
  for (const [name, change] of changes) {
    change();
    assert.equal(frame(), true, name);
    assert.equal(frame(), false, `${name} settles`);
  }
  cache.invalidate();
  assert.equal(frame(), true, 'invalidate forces a redraw');
});

test('non-casters and hidden subtrees do not defeat reuse', () => {
  const { frame, receiver, scene } = fixture();
  const hidden = new THREE.Group();
  hidden.visible = false;
  const hiddenCaster = new THREE.Mesh(new THREE.BoxGeometry());
  hiddenCaster.castShadow = true;
  hidden.add(hiddenCaster);
  scene.add(hidden);
  frame();
  receiver.position.x += 5;
  hiddenCaster.position.x += 5;
  assert.equal(frame(), false);
});

test('reuse is bounded so unobservable state cannot stay stale forever', () => {
  const { frame, cache } = fixture();
  cache.maxReuseFrames = 3;
  const rendered = Array.from({ length: 9 }, () => frame());
  assert.deepEqual(rendered, [true, false, false, false, true, false, false, false, true]);
});

test('texel snapping keeps the light direction and lands on the texel grid', () => {
  const light = new THREE.DirectionalLight();
  const up = new THREE.Vector3(0.1, 1, -0.2).normalize();
  const direction = new THREE.Vector3(0.6, 0.7, 0.3).normalize();
  const extent = 60, mapSize = 2048, texel = 2 * extent / mapSize;
  const camera = new THREE.OrthographicCamera();
  for (const x of [0, 0.013, 17.31, -402.77]) {
    light.target.position.set(x, x * 0.37, -x * 0.11);
    light.position.copy(light.target.position).addScaledVector(direction, 80);
    const before = light.target.position.clone();
    snapShadowToTexels(light, up, extent, mapSize);
    const after = new THREE.Vector3().subVectors(light.position, light.target.position).normalize();
    assert.ok(after.distanceTo(direction) < 1e-12, 'direction unchanged');
    assert.ok(before.distanceTo(light.target.position) <= texel * Math.SQRT1_2 + 1e-9, 'moves less than a texel');
    // Light-space origin coordinates are whole texels in the shadow camera basis.
    camera.position.copy(light.position);
    camera.up.copy(up);
    camera.lookAt(light.target.position);
    camera.updateMatrixWorld(true);
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const cameraUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    for (const value of [light.target.position.dot(right), light.target.position.dot(cameraUp)]) {
      const texels = value / texel;
      assert.ok(Math.abs(texels - Math.round(texels)) < 1e-6, `on grid: ${texels}`);
    }
  }
});

test('the renderer decides shadow reuse once per presented frame', () => {
  const renderer = Object.create(SceneRenderer.prototype) as SceneRenderer;
  renderer.scene = new THREE.Scene();
  renderer.renderer = { shadowMap: { enabled: true } } as any;
  renderer.sunLight = new THREE.DirectionalLight();
  renderer.scene.add(renderer.sunLight);
  const shadow = renderer.sunLight.shadow;
  shadow.autoUpdate = false;
  const decide = (camera: THREE.Camera) => (renderer as any).decideShadowUpdate(camera);
  const camera = new THREE.PerspectiveCamera();

  (renderer as any).shadowDecisionPending = true;
  shadow.needsUpdate = false;
  decide(shadow.camera);
  assert.equal(shadow.needsUpdate, false, 'the nested shadow render does not decide');
  decide(camera);
  assert.equal(shadow.needsUpdate, true, 'first frame redraws');

  shadow.needsUpdate = false;
  decide(camera);
  assert.equal(shadow.needsUpdate, false, 'later scene passes in the same frame do not decide');
  (renderer as any).shadowDecisionPending = true;
  decide(camera);
  assert.equal(shadow.needsUpdate, false, 'unchanged frame reuses');
});
