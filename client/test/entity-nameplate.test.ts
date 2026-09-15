import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { applyCameraBend, bendPoint, setWorldShapeMode, setWorldProjectionAnchor, TORUS_SIZE_X } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { entityDisplayName, entityRunStatus, EntityNameplateProjector } from '../src/ui/react/utils/entityNameplate.ts';

test('labels show names and local/remote executor names without confusing frozen playback with Stop', () => {
  const local: any = { id: 'one', rootComponentName: 'Walker', scriptStatus: 'running' };
  assert.equal(entityDisplayName(local), 'Walker');
  assert.equal(entityRunStatus(local, 'Alice').text, 'Running · Alice');
  assert.equal(entityRunStatus({ ...local, scriptStatus: 'stopped' }, 'Alice').text, 'Stopped');
  assert.equal(entityRunStatus({ ...local, isWrenchGrabbed: true }).running, false);
  assert.equal(entityRunStatus({ scriptStatus: 'stopped', isPhysicsSimulationEnabled: () => true }, 'Alice').text,
    'Running · Alice', 'script-free entities still run physics');
  const remote = { ...local, scriptStatus: 'stopped', serverManaged: true, serverExecutesLocally: false,
    serverDesiredRunState: 'running', serverOwnerName: 'Alice', serverExecutorName: 'Alice',
    serverExecutionLeaseExpiresAt: new Date(20_000).toISOString() };
  assert.deepEqual(entityRunStatus(remote, 'Bob', 10_000), {
    running: true, tone: 'running', icon: 'play', caption: 'Alice', text: 'Running · Alice'
  });
  assert.equal(entityRunStatus(remote, 'Bob', 20_001).text, 'Starting · waiting for Alice');
  assert.equal(entityRunStatus({ ...remote, serverDesiredRunState: 'stopped' }, 'Bob', 10_000).text, 'Stopped');
});

test('server hosting is explicitly distinguished even though browser simulation is stopped', () => {
  const hosted = { serverManaged: true, serverExecutionMode: 'hosted', serverHostingEnabled: true,
    serverDesiredRunState: 'running', scriptStatus: 'stopped', serverExecutorName: 'wrong browser' };
  assert.deepEqual(entityRunStatus(hosted), {
    running: true, tone: 'hosted', icon: 'play', caption: 'Server hosting', text: 'Server hosting · running'
  });
  assert.equal(entityRunStatus({ ...hosted, serverHostingEnabled: false }).text, 'Server hosting · paused');
  assert.equal(entityRunStatus({ ...hosted, serverDesiredRunState: 'stopped' }).text, 'Server hosting · stopped');
});

test('icon status keeps executor/hosting captions and full tooltip descriptions', () => {
  assert.deepEqual(entityRunStatus({ scriptStatus: 'stopped' }, 'Alice'), {
    running: false, tone: 'stopped', icon: 'stop', caption: '', text: 'Stopped'
  });
  const running = entityRunStatus({ scriptStatus: 'running' }, 'Running · Alice');
  assert.equal(running.icon, 'play');
  assert.equal(running.caption, 'Running · Alice', 'executor names are not parsed out of formatted status text');
  const waiting = entityRunStatus({ serverManaged: true, serverDesiredRunState: 'running', serverOwnerName: 'Alice' });
  assert.equal(waiting.icon, 'waiting');
  assert.equal(waiting.caption, 'Alice');
  assert.equal(waiting.text, 'Starting · waiting for Alice');
  const paused = entityRunStatus({ serverManaged: true, serverExecutionMode: 'hosted', serverDesiredRunState: 'running' });
  assert.equal(paused.icon, 'pause');
  assert.equal(paused.caption, 'Server hosting');
  assert.equal(paused.text, 'Server hosting · paused');
  assert.equal(entityRunStatus({ serverManaged: true, serverExecutionMode: 'hosted', serverHostingEnabled: true,
    serverDesiredRunState: 'stopped' }).icon, 'stop');
});

function entityAndCamera(mode: 'earth' | 'torus') {
  setWorldShapeMode(mode);
  setWorldProjectionAnchor(10, 10, true);
  const entity = new Contraption('plate', [{ localX: 0, localY: 0, localZ: 0, color: 0xff9900, size: 1, entityId: 'root' }],
    new THREE.Vector3(10, 16, 10), new THREE.Scene(), { rootComponentName: 'Plate' });
  const camera = new THREE.PerspectiveCamera(75, 800 / 600, 0.1, 10000);
  camera.position.set(10.5, 17.3, 17);
  camera.lookAt(10.5, 17.3, 10.5);
  applyCameraBend(camera);
  camera.updateMatrixWorld(true);
  return { entity, camera };
}

for (const mode of ['earth', 'torus'] as const) {
  test(`nameplates follow bent ${mode} camera and presentation transforms, not camera/geometry helpers`, () => {
    const { entity, camera } = entityAndCamera(mode);
    const projector = new EntityNameplateProjector();
    const viewport = { width: 800, height: 600 };
    const before = projector.project(entity, camera, viewport)!;
    const expected = bendPoint(10.5, 17.3, 10.5, new THREE.Vector3()).project(camera);
    assert.ok(before && Math.abs(before.x - (expected.x + 1) * 400) < 1e-7
      && Math.abs(before.y - (1 - expected.y) * 300) < 1e-7);
    const originalPosition = camera.position.clone();
    entity.rootGroup.position.x += 0.8; // presentation-only movement
    const after = projector.project(entity, camera, viewport)!;
    assert.ok(after.x > before.x + 20);
    assert.ok(camera.position.equals(originalPosition), 'overlay must not bend the camera twice');
    entity.setCollisionSimulationEnabled(false);
    assert.ok(projector.project(entity, camera, viewport), 'collision-disabled visible entities keep their labels');
    entity.dispose();
  });
}

test('projector hides behind-camera/offscreen/empty entities and invalidates authored geometry bounds', () => {
  const { entity, camera } = entityAndCamera('earth');
  const projector = new EntityNameplateProjector();
  const viewport = { width: 800, height: 600 };
  const before = projector.project(entity, camera, viewport)!;
  entity.blocks.push({ localX: 0, localY: 1, localZ: 0, size: 1, color: 0xff9900, entityId: 'root' });
  entity.rebuildAfterBlockChange();
  const after = projector.project(entity, camera, viewport)!;
  assert.ok(after.y < before.y - 20, 'new geometry raises the overhead anchor');
  entity.rootGroup.position.z += 20;
  assert.equal(projector.project(entity, camera, viewport), null);
  entity.rootGroup.position.z -= 20;
  entity.rootGroup.position.x += 100;
  assert.equal(projector.project(entity, camera, viewport), null);
  entity.dispose();
  assert.equal(projector.project({ blocks: [], entityNodes: new Map() }, camera, viewport), null);
});

test('labels project consistently across the periodic world seam', () => {
  const { entity, camera } = entityAndCamera('torus');
  const projector = new EntityNameplateProjector();
  const viewport = { width: 800, height: 600 };
  const before = projector.project(entity, camera, viewport)!;
  entity.rootGroup.position.x += TORUS_SIZE_X;
  const after = projector.project(entity, camera, viewport)!;
  assert.ok(Math.abs(before.x - after.x) < 1e-7 && Math.abs(before.y - after.y) < 1e-7);
  entity.dispose();
});

test('moving nested components update the overhead bounds without rescanning every authored voxel', () => {
  setWorldShapeMode('earth');
  setWorldProjectionAnchor(10, 10, true);
  const entity = new Contraption('arm', [0, 3].map(y => ({ localX: 0, localY: y, localZ: 0, size: 1, color: 0xf2a93b })),
    new THREE.Vector3(10, 16, 10), new THREE.Scene(), {
      childEntities: [{ id: 'arm', parentId: 'root', kind: 'child', pivot: [0, 3, 0], blockKeys: [['0', '3', '0']] }]
    });
  const camera = new THREE.PerspectiveCamera(75, 800 / 600, 0.1, 10000);
  camera.position.set(10.5, 20, 25);
  camera.lookAt(10.5, 20, 10.5);
  applyCameraBend(camera);
  camera.updateMatrixWorld(true);
  let scans = 0;
  const iterate = entity.blocks[Symbol.iterator].bind(entity.blocks);
  entity.blocks[Symbol.iterator] = function* () { scans++; yield* iterate(); };
  const projector = new EntityNameplateProjector();
  const viewport = { width: 800, height: 600 };
  const before = projector.project(entity, camera, viewport)!;
  for (let i = 0; i < 10; i++) assert.ok(projector.project(entity, camera, viewport));
  const arm = entity.entityNodes.get('arm')!;
  arm.group.position.y += 2;
  const after = projector.project(entity, camera, viewport)!;
  assert.ok(after.y < before.y - 20);
  assert.equal(scans, 1, 'authored bounds are scanned once and transformed per component thereafter');
  entity.dispose();
});
