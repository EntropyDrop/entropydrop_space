import * as THREE from 'three';
import { TORUS_SIZE_X, TORUS_SIZE_Z, unwrapPeriodicNear } from '@entropydrop/space-engine/torus/TorusWorld.ts';

export interface EntityBodyPose {
  id: string;
  position: number[];
  quaternion: number[];
  velocity: number[];
  angularVelocity: number[];
  collisionEnabled?: boolean;
}

export interface EntityPoseFrame {
  entity_id: string;
  execution_epoch: number;
  sequence: number;
  revision: number;
  definition_digest: string;
  lease_expires_at: string;
  bodies: EntityBodyPose[];
}

const vector = (v: unknown, n: number, bound: number) => Array.isArray(v) && v.length === n
  && v.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= bound);

export function parseEntityPose(value: any): EntityPoseFrame | null {
  if (!value || typeof value.entity_id !== 'string' || value.entity_id.length > 128
    || !Number.isSafeInteger(value.execution_epoch) || value.execution_epoch < 1
    || !Number.isSafeInteger(value.sequence) || value.sequence < 0
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !/^[a-f0-9]{64}$/.test(value.definition_digest || '')
    || typeof value.lease_expires_at !== 'string' || !Number.isFinite(Date.parse(value.lease_expires_at))
    || !Array.isArray(value.bodies) || !value.bodies.length || value.bodies.length > 128) return null;
  const ids = new Set<string>();
  for (const body of value.bodies) {
    if (typeof body?.id !== 'string' || !body.id || body.id.length > 128 || ids.has(body.id)
      || !vector(body.position, 3, 1e7) || !vector(body.quaternion, 4, 1)
      || Math.abs(body.quaternion.reduce((sum: number, x: number) => sum + x * x, 0) - 1) > 0.01
      || !vector(body.velocity, 3, 1e4) || !vector(body.angularVelocity, 3, 1e4)) return null;
    if (body.collisionEnabled !== undefined && typeof body.collisionEnabled !== 'boolean') return null;
    ids.add(body.id);
  }
  const origin = value.bodies[0].position;
  if (origin[1] < -1000 || origin[1] > 10000 || value.bodies.some((body: EntityBodyPose) =>
    body.position.some((v, i) => Math.abs(v - origin[i]) > 256))) return null;
  return value;
}

/** A bounded jitter buffer, sampled by collision and rendering from one timeline.
 * No replica integration/extrapolation: an interrupted stream holds its last pose.
 */
export class EntityPoseBuffer {
  private samples: Array<{ frame: EntityPoseFrame; at: number }> = [];
  private lastSequence = -1;
  private epoch = 0;

  push(frame: EntityPoseFrame, receivedAt: number) {
    if (frame.execution_epoch < this.epoch) return false;
    if (frame.execution_epoch > this.epoch) {
      this.samples = [];
      this.lastSequence = -1;
      this.epoch = frame.execution_epoch;
    }
    if (frame.sequence <= this.lastSequence) return false;
    const last = this.samples[this.samples.length - 1];
    let at = last ? last.at + (frame.sequence - this.lastSequence) * 50 : receivedAt;
    // Sequence is the authoritative fixed-tick clock, not packet arrival time.
    // A suspended/slow executor or long outage starts a fresh clock anchor.
    if (Math.abs(at - receivedAt) > 250) {
      this.samples = [];
      at = receivedAt;
    }
    this.lastSequence = frame.sequence;
    this.samples.push({ frame, at });
    if (this.samples.length > 12) this.samples.shift();
    return true;
  }

  sample(now: number, reference: { x: number; z: number }): EntityBodyPose[] | null {
    if (!this.samples.length) return null;
    const target = now - 100;
    while (this.samples.length > 2 && this.samples[1].at <= target) this.samples.shift();
    const a = this.samples[0];
    const b = this.samples.find(s => s.at >= target) || this.samples[this.samples.length - 1];
    const alpha = a === b ? 1 : THREE.MathUtils.clamp((target - a.at) / Math.max(1, b.at - a.at), 0, 1);
    const previous = new Map(a.frame.bodies.map(body => [body.id, body]));
    return b.frame.bodies.map(body => {
      const old = previous.get(body.id) || body;
      const start = new THREE.Vector3().fromArray(old.position);
      start.x = unwrapPeriodicNear(start.x, reference.x, TORUS_SIZE_X);
      start.z = unwrapPeriodicNear(start.z, reference.z, TORUS_SIZE_Z);
      const end = new THREE.Vector3().fromArray(body.position);
      end.x = unwrapPeriodicNear(end.x, start.x, TORUS_SIZE_X);
      end.z = unwrapPeriodicNear(end.z, start.z, TORUS_SIZE_Z);
      return { ...body, position: start.lerp(end, alpha).toArray(),
        quaternion: new THREE.Quaternion().fromArray(old.quaternion)
          .slerp(new THREE.Quaternion().fromArray(body.quaternion), alpha).normalize().toArray() };
    });
  }
}
