import * as THREE from 'three';
import { unbendDirection } from '@entropydrop/space-engine/torus/TorusWorld.ts';

export const ENTITY_PREVIEW_FORCE_LIMIT_RATIO = 0.72;

export function calculatePreviewDragForce(
  cameraQuaternion: THREE.Quaternion | null,
  deltaX: number,
  deltaY: number,
  maxForce: number,
  flatReferencePoint: THREE.Vector3 | null = null
) {
  const dx = Number(deltaX) || 0;
  const dy = Number(deltaY) || 0;
  const dragLength = Math.hypot(dx, dy);
  const safeMaxForce = Math.max(0, Number(maxForce) || 0);
  const forceLimit = safeMaxForce * ENTITY_PREVIEW_FORCE_LIMIT_RATIO;
  if (dragLength < 0.5 || forceLimit <= 0) return new THREE.Vector3();

  const orientation = cameraQuaternion?.isQuaternion
    ? cameraQuaternion
    : new THREE.Quaternion();
  const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(orientation);
  const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(orientation);
  // The preview camera lives in the torus-bent render space, while physics
  // forces live in the flat simulation space. Convert both screen axes back at
  // the grabbed point before composing the force; otherwise the displayed
  // arrow rotates with the entity's position around the torus.
  if (flatReferencePoint?.isVector3) {
    unbendDirection(
      flatReferencePoint.x,
      flatReferencePoint.y,
      flatReferencePoint.z,
      cameraRight,
      cameraRight
    ).normalize();
    unbendDirection(
      flatReferencePoint.x,
      flatReferencePoint.y,
      flatReferencePoint.z,
      cameraUp,
      cameraUp
    ).normalize();
  }
  const direction = cameraRight.multiplyScalar(dx)
    .addScaledVector(cameraUp, -dy)
    .normalize();
  const magnitude = Math.min(forceLimit, (dragLength / 140) * forceLimit);
  return direction.multiplyScalar(magnitude);
}
