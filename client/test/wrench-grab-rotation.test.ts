import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { ContraptionPhysics } from '@entropydrop/space-engine/physics/ContraptionPhysics.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { worldStub } from './fixtures.ts';

const UP = new THREE.Vector3(0, 1, 0);

function fixture(t: test.TestContext, bodyType: 'dynamic' | 'kinematic' = 'dynamic', yaw = .7) {
  const scene = new THREE.Scene();
  const world = worldStub({ getBlock: () => 0, raycast: () => ({ hit: false as const }),
    raycastMicro: () => ({ hit: false as const }), microVoxels: { get: () => null } });
  const manager = new ContraptionManager(scene, world, null, null);
  manager.setPhysics(new ContraptionPhysics(world));
  const entity = new Contraption(1, [
    { localX: 0, localY: 0, localZ: 0, block: 1, entityId: 'base' },
    { localX: 1, localY: 0, localZ: 0, block: 1, entityId: 'base' },
    { localX: 3, localY: 0, localZ: 0, block: 1, entityId: 'wheel' },
    { localX: 3, localY: 1, localZ: 0, block: 1, entityId: 'wheel' },
  ], new THREE.Vector3(-2, 1, -6), scene, { rootComponentId: 'base', bodyType, useGravity: false,
    childEntities: [{ id: 'wheel', parentId: 'base', pivot: [3.5, 1, .5], useGravity: false }] });
  entity.stopAllNodeScripts();
  entity.quaternion.setFromEuler(new THREE.Euler(.22, .4, -.17));
  entity.updateTransform(); entity.syncKinematicBodies(0);
  entity.setNodeBodyType('wheel', 'dynamic');
  manager.registerContraption(entity);
  const point = entity.getBlockWorldCenter(entity.blocks[2]);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 3, 1); camera.lookAt(point); camera.updateMatrixWorld(true);
  const controller: any = Object.assign(Object.create(PlayerController.prototype), {
    _activeTool: SpecialTool.WRENCH, contraptions: manager, world, camera, yaw, pitch: 0,
    hoveredContraption: entity, hoveredContraptionHit: { contraption: entity, entityId: 'wheel', point },
    physics: { update() {}, position: camera.position, velocity: new THREE.Vector3(),
      getEyePosition: () => camera.position.clone() },
    sceneRenderer: { setWrenchTether() {} }, ui: { showToast() {} }, sound: { playWrenchClick() {} },
  });
  t.after(() => { controller.releaseWrenchGrab(); entity.dispose(); });
  const step = (frames = 1) => {
    let maxAnchorError = 0;
    for (let i = 0; i < frames; i++) {
      controller.updateSimulation(1 / 20); manager.update(1 / 20, null);
      const grab = controller.wrenchGrab;
      if (grab) maxAnchorError = Math.max(maxAnchorError, entity.entityLocalToWorld('base', grab.localPoint)
        .distanceTo(grab.lastTargetPosition));
    }
    return maxAnchorError;
  };
  const anchor = () => entity.entityLocalToWorld('base', controller.wrenchGrab.localPoint);
  return { entity, manager, controller, camera, step, anchor };
}

for (const type of ['dynamic', 'kinematic'] as const) test(`held ${type} entity turns with body yaw around an off-center child grip and retains its pose on release`, t => {
  const f = fixture(t, type);
  if (type === 'kinematic') f.entity.setNodeBodyMass('base', 1e9);
  const initial = f.entity.quaternion.clone();
  const childPosition = f.entity.getEntityNode('wheel')!.localPosition.clone();
  assert.equal(f.controller.startWrenchGrab(), true);
  f.step(2);
  assert.ok(f.entity.quaternion.angleTo(initial) < 1e-7, 'picking up does not snap orientation to the player');
  const startAnchor = f.anchor();
  f.controller.yaw += Math.PI / 2;
  const expected = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI / 2).multiply(initial);
  const maxAnchorError = f.step(100);
  assert.ok(f.entity.quaternion.angleTo(expected) < 1e-4);
  assert.ok(maxAnchorError < .15, `rotation keeps the off-center grip stable, error=${maxAnchorError}`);
  assert.ok(f.anchor().distanceTo(startAnchor) < .01);
  assert.ok(f.entity.getEntityNode('wheel')!.localPosition.distanceTo(childPosition) < 1e-7);
  assert.ok(f.entity.getEntityNodeWorldQuaternion('wheel').angleTo(expected) < 1e-4);
  const finalPosition = f.entity.position.clone(), finalRotation = f.entity.quaternion.clone();
  f.controller.releaseWrenchGrab();
  f.controller.yaw += .5; f.step(3);
  assert.ok(f.entity.position.distanceTo(finalPosition) < 1e-7);
  assert.ok(f.entity.quaternion.angleTo(finalRotation) < 1e-7);
  assert.equal(f.entity.getNodeBodyType('base'), type);
  assert.equal(f.entity.getNodeBodyType('wheel'), 'dynamic');
  assert.equal(f.entity.isPhysicsSimulationEnabled(), false);
  assert.ok(f.entity.angularVelocity.length() < 1e-9);
});

test('body and camera turning together preserve the held orientation offset while following the new aiming ray', t => {
  const f = fixture(t);
  const initial = f.entity.quaternion.clone();
  f.controller.startWrenchGrab();
  const turn = new THREE.Quaternion().setFromAxisAngle(UP, -Math.PI / 2);
  f.controller.yaw -= Math.PI / 2; f.camera.quaternion.premultiply(turn);
  f.step(140);
  assert.ok(f.entity.quaternion.angleTo(turn.clone().multiply(initial)) < 1e-4);
  assert.ok(f.anchor().distanceTo(f.controller.wrenchGrab.lastTargetPosition) < .03);
});

test('camera pitch and front-view changes do not rotate the held entity', t => {
  const f = fixture(t);
  const initial = f.entity.quaternion.clone();
  f.controller.startWrenchGrab();
  f.controller.pitch = .6; f.camera.rotation.x += .6;
  f.step(30);
  f.controller.setPerspective('third_person_front', false);
  f.camera.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.PI));
  f.step(30);
  assert.ok(f.entity.quaternion.angleTo(initial) < 1e-7);
});

test('crossing the body yaw wrap takes the short turn instead of spinning the held entity', t => {
  const f = fixture(t, 'dynamic', Math.PI - .02);
  const initial = f.entity.quaternion.clone();
  f.controller.startWrenchGrab(); f.controller.yaw = -Math.PI + .02;
  f.step();
  assert.ok(f.entity.angularVelocity.length() < .5);
  f.step(80);
  assert.ok(f.entity.quaternion.angleTo(new THREE.Quaternion().setFromAxisAngle(UP, .04).multiply(initial)) < 1e-4);
});

test('a fixed seat body rotation carries the grabbed entity even while free look stays unchanged', t => {
  const f = fixture(t);
  const initial = f.entity.quaternion.clone();
  const body = new THREE.Quaternion().setFromEuler(new THREE.Euler(.1, .7, -.2));
  const originalBody = body.clone();
  Object.defineProperty(f.controller, 'bodyQuaternion', { get: () => body });
  f.controller.startWrenchGrab();
  body.premultiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(.3, .4, .2)));
  f.step(100);
  assert.ok(f.entity.quaternion.angleTo(body.clone().multiply(originalBody.invert()).multiply(initial)) < 1e-4);
});
