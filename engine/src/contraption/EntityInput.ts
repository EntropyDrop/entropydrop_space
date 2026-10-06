import * as THREE from 'three';
import { MICRO_DIVISIONS } from '../voxel/MicroGrid.ts';
import type { RuntimeSeat } from './EntityTypes.ts';

/** Input adapters validate unknown values before they enter runtime state. */
export function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function asVector3(value: unknown, fallback: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
  if (value instanceof THREE.Vector3) return value.clone();
  if (Array.isArray(value)) {
    return new THREE.Vector3(Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0);
  }
  if (value && typeof value === 'object') {
    return new THREE.Vector3(Number('x' in value ? value.x : 0) || 0, Number('y' in value ? value.y : 0) || 0, Number('z' in value ? value.z : 0) || 0);
  }
  return fallback.clone();
}

export function asQuaternion(value: unknown, fallback: THREE.Quaternion = new THREE.Quaternion()): THREE.Quaternion {
  if (value instanceof THREE.Quaternion) return value.clone().normalize();
  if (Array.isArray(value) && value.length >= 4) {
    const components = value.slice(0, 4).map(Number);
    if (components.every(Number.isFinite)) {
      const quaternion = new THREE.Quaternion(
        components[0],
        components[1],
        components[2],
        components[3]
      );
      if (quaternion.lengthSq() > 1e-12) return quaternion.normalize();
    }
    return fallback.clone().normalize();
  }
  if (Array.isArray(value) && value.length >= 3) {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(
      Number(value[0]) || 0,
      Number(value[1]) || 0,
      Number(value[2]) || 0,
      'YXZ'
    ));
  }
  return fallback.clone();
}

export function isFiniteVector3Array(value: unknown): value is unknown[] {
  return Array.isArray(value)
    && value.length >= 3
    && Number.isFinite(Number(value[0]))
    && Number.isFinite(Number(value[1]))
    && Number.isFinite(Number(value[2]));
}

export function isMicroOffset(value: unknown): value is unknown[] {
  return isFiniteVector3Array(value)
    && value.slice(0, 3).every(part => Number.isInteger(Number(part))
      && Number(part) >= 0 && Number(part) < MICRO_DIVISIONS);
}

export function normalizeSeats(value: unknown): RuntimeSeat[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((seat: unknown) => {
    const record = readRecord(seat);
    const position = Array.isArray(seat) ? seat : record.position;
    if (!Array.isArray(position) || position.length < 3) return [];
    const normalized = position.slice(0, 3).map(Number);
    if (!normalized.every(Number.isFinite)) return [];
    const requestedRotation = record.rotation;
    let rotation: [number, number, number, number] = [0, 0, 0, 1];
    if (requestedRotation !== undefined && requestedRotation !== null) {
      const components = Array.isArray(requestedRotation)
        ? requestedRotation.slice(0, 4).map(Number)
        : [readRecord(requestedRotation).x, readRecord(requestedRotation).y, readRecord(requestedRotation).z, readRecord(requestedRotation).w].map(Number);
      if (components.length < 4 || !components.every(Number.isFinite)) return [];
      const quaternion = new THREE.Quaternion(
        components[0], components[1], components[2], components[3]
      );
      if (quaternion.lengthSq() <= 1e-12) return [];
      rotation = quaternion.normalize().toArray() as [number, number, number, number];
    }
    return [{
      position: normalized as [number, number, number],
      rotation,
      fixedOrientation: (Array.isArray(seat) ? false : record.fixedOrientation) === true
    }];
  });
}
