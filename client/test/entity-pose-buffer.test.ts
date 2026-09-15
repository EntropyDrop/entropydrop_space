import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EntityPoseBuffer, parseEntityPose, type EntityPoseFrame } from '../src/engine/network/EntityPoseBuffer.ts';
import { TORUS_SIZE_X } from '@entropydrop/space-engine/torus/TorusWorld.ts';

function frame(sequence = 1, x = 0, epoch = 1): EntityPoseFrame {
  return { entity_id: 'entity', execution_epoch: epoch, sequence, revision: 1,
    definition_digest: 'a'.repeat(64), lease_expires_at: '2026-09-15T08:00:08Z',
    bodies: [{ id: 'root', position: [x, 0, 0], quaternion: [0, 0, 0, 1],
      velocity: [20, 0, 0], angularVelocity: [0, 1, 0] }] };
}

test('entity pose buffer interpolates position and shortest quaternion arc on a delayed timeline', () => {
  const buffer = new EntityPoseBuffer();
  const end = frame(2, 2);
  end.bodies[0].quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI).toArray();
  assert.equal(buffer.push(frame(), 1000), true);
  buffer.push(end, 1050);
  const sample = buffer.sample(1125, { x: 0, z: 0 })![0];
  assert.equal(sample.position[0], 1);
  assert.ok(Math.abs(new THREE.Quaternion().fromArray(sample.quaternion).angleTo(new THREE.Quaternion()) - Math.PI / 2) < 1e-9);
  assert.equal(buffer.sample(5000, { x: 0, z: 0 })![0].position[0], 2, 'no extrapolation of stale velocity');
});

test('entity pose buffer rejects duplicate/out-of-order and old execution epochs, resets on takeover', () => {
  const buffer = new EntityPoseBuffer();
  buffer.push(frame(10, 10), 1000);
  assert.equal(buffer.push(frame(10, 99), 1100), false);
  assert.equal(buffer.push(frame(9, 99), 1200), false);
  assert.equal(buffer.push(frame(1, 20, 2), 1300), true);
  assert.equal(buffer.push(frame(100, 99, 1), 1400), false);
  assert.equal(buffer.sample(1450, { x: 0, z: 0 })![0].position[0], 20);
});

test('entity pose interpolation unwraps torus seams near the collider rather than crossing the world', () => {
  const buffer = new EntityPoseBuffer();
  buffer.push(frame(1, TORUS_SIZE_X - 1), 1000);
  buffer.push(frame(2, 1), 1050);
  assert.equal(buffer.sample(1125, { x: TORUS_SIZE_X, z: 0 })![0].position[0], TORUS_SIZE_X);
});

test('bursty packet arrivals retain the source fixed-tick spacing rather than accelerate a collider', () => {
  const buffer = new EntityPoseBuffer();
  buffer.push(frame(1, 0), 1000);
  buffer.push(frame(2, 1), 1095);
  buffer.push(frame(3, 2), 1096);
  assert.equal(buffer.sample(1175, { x: 0, z: 0 })![0].position[0], 1.5);
});

test('entity pose validation rejects malformed, unbounded and duplicate body data', () => {
  assert.ok(parseEntityPose(frame()));
  for (const change of [{ position: [NaN, 0, 0] }, { quaternion: [0, 0, 0, 0] },
    { velocity: [Infinity, 0, 0] }, { angularVelocity: [1e8, 0, 0] }]) {
    assert.equal(parseEntityPose({ ...frame(), bodies: [{ ...frame().bodies[0], ...change }] }), null);
  }
  assert.equal(parseEntityPose({ ...frame(), bodies: frame().bodies.concat(frame().bodies) }), null);
  assert.equal(parseEntityPose({ ...frame(), execution_epoch: 0 }), null);
});
