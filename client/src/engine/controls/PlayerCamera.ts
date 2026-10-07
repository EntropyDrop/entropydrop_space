import * as THREE from 'three';
import { CameraPerspectiveTransition } from './CameraPerspectiveTransition.ts';
import { type PlayerPerspective } from './ControlBindings.ts';
import type { PlayerController } from './PlayerController.ts';

export interface PlayerCameraPort {
  camera: PlayerController['camera'];
  physics: PlayerController['physics'];
  sceneRenderer: PlayerController['sceneRenderer'];
  ui: PlayerController['ui'];
}

/** Owns free-look angles, perspective transitions and camera projection settings. */
export class PlayerCamera {
  private readonly host: PlayerCameraPort;
  constructor(host: PlayerCameraPort) { this.host = host; }
  pitch = 0;
  yaw = 0;
  fov = 75;
  perspective: PlayerPerspective = 'first_person';
  thirdPersonDistance = 4;
  cameraPerspectiveTransition?: CameraPerspectiveTransition;

  setFov(fov: number) {
    this.fov = Math.max(40, Math.min(120, Number(fov) || 75));
    if (this.host.camera) {
      this.host.camera.fov = this.fov;
      this.host.camera.updateProjectionMatrix();
    }
  }

  setPerspective(perspective: PlayerPerspective, animate = true) {
    const normalized: PlayerPerspective = perspective === 'third_person'
      || perspective === 'third_person_front'
      ? perspective
      : 'first_person';
    const transition = this.getCameraPerspectiveTransition();
    this.perspective = normalized;
    transition.setPerspective(normalized, animate);
    this.syncCameraViewVisibility();
  }

  setThirdPersonDistance(dist: number) {
    this.thirdPersonDistance = Math.max(1.5, Math.min(12, Number(dist) || 4));
  }

  togglePerspective() {
    const next: PlayerPerspective = this.perspective === 'first_person'
      ? 'third_person'
      : this.perspective === 'third_person'
        ? 'third_person_front'
        : 'first_person';
    this.setPerspective(next);
    if (this.host.ui) {
      this.host.ui.syncSettingsUI?.();
      const label = next === 'third_person'
        ? 'Third Person Back View'
        : next === 'third_person_front'
          ? 'Third Person Front View'
          : 'First Person View';
      this.host.ui.showToast(label);
    }
  }

  get viewYaw(): number {
    return Number.isFinite(this.yaw) ? this.yaw : 0;
  }

  getCameraPerspectiveTransition(): CameraPerspectiveTransition {
    const perspective = this.perspective || 'first_person';
    if (!this.cameraPerspectiveTransition) {
      this.cameraPerspectiveTransition = new CameraPerspectiveTransition(perspective);
    } else if (this.cameraPerspectiveTransition.perspective !== perspective) {
      // Legacy callers may assign perspective directly rather than using the setter.
      this.cameraPerspectiveTransition.setPerspective(perspective, false);
    }
    return this.cameraPerspectiveTransition;
  }

  syncCameraViewVisibility() {
    const pose = this.getCameraPerspectiveTransition().pose;
    const distance = pose.distance * this.thirdPersonDistance;
    // Hide the body near the eye, and show the viewmodel only once back in
    // first person. This avoids flying through the head or carrying a floating hand.
    this.host.sceneRenderer?.setPlayerAvatarVisible?.(
      distance >= 0.65,
      this.perspective === 'first_person' && distance < 0.08 && Math.abs(pose.angle) < 0.08
    );
  }

  updateCameraRotation(): THREE.Vector3 {
    const { angle } = this.getCameraPerspectiveTransition().pose;
    // Derive every pose from current free look, never from the previous render
    // quaternion (which is reversed in front view). Mouse look itself is not eased.
    const pitch = Number.isFinite(this.pitch) ? this.pitch : this.host.camera.rotation.x;
    const yaw = this.viewYaw;
    const look = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    const orbitDirection = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle)).applyQuaternion(look);
    if (Math.abs(angle) < 1e-9) {
      this.host.camera.rotation.set(pitch, yaw, 0, 'YXZ');
    } else {
      const rotation = new THREE.Matrix4().lookAt(orbitDirection, new THREE.Vector3(), this.host.camera.up);
      this.host.camera.quaternion.setFromRotationMatrix(rotation);
    }
    return orbitDirection;
  }

  updateCameraPosition() {
    const eyePos = this.host.physics.getEyePosition();
    const orbitDirection = this.updateCameraRotation();
    const { distance } = this.getCameraPerspectiveTransition().pose;
    this.host.camera.position.copy(eyePos).addScaledVector(orbitDirection, distance * this.thirdPersonDistance);
    this.syncCameraViewVisibility();
  }
}
