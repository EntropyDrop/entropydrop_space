import * as THREE from 'three';
import { CameraPerspectiveTransition } from './CameraPerspectiveTransition.ts';
import { THIRD_PERSON_DISTANCE_LIMITS, type PlayerPerspective } from './ControlBindings.ts';
import type { PlayerController } from './PlayerController.ts';
import { ThirdPersonFraming } from './ThirdPersonFraming.ts';

const UPRIGHT = new THREE.Quaternion();

export interface PlayerCameraPort {
  camera: PlayerController['camera'];
  bodyQuaternion: PlayerController['bodyQuaternion'];
  isDriving: PlayerController['isDriving'];
  drivenContraption: PlayerController['drivenContraption'];
  physics: PlayerController['physics'];
  sceneRenderer: PlayerController['sceneRenderer'];
  ui: PlayerController['ui'];
}

/** Owns free-look angles, perspective transitions and camera projection settings. */
export class PlayerCamera {
  private readonly host: PlayerCameraPort;
  private readonly bodyTilt = new THREE.Quaternion();
  private readonly inverseBodyHeading = new THREE.Quaternion();
  private dashFov = 0;
  private readonly framing = new ThirdPersonFraming();
  private framingVehicle: PlayerController['drivenContraption'] = null;
  private vehicleZoom = 1;
  private followDistance: number | null = null;
  constructor(host: PlayerCameraPort) { this.host = host; }
  pitch = 0;
  yaw = 0;
  fov = 75;
  perspective: PlayerPerspective = 'first_person';
  thirdPersonDistance: number = THIRD_PERSON_DISTANCE_LIMITS.default;
  cameraPerspectiveTransition?: CameraPerspectiveTransition;

  setFov(fov: number) {
    this.fov = Math.max(40, Math.min(120, Number(fov) || 75));
    this.applyFov();
  }

  private applyFov() {
    if (this.host.camera) {
      const fov = Math.min(120, this.fov + this.dashFov);
      if (Math.abs(this.host.camera.fov - fov) > 1e-5) {
        this.host.camera.fov = fov;
        this.host.camera.updateProjectionMatrix();
      }
    }
  }

  /** Subtle speed feedback, advanced once per render without changing aim. */
  updateMotion(dt: number) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    const firstPerson = 1 - this.getCameraPerspectiveTransition().pose.distance;
    const target = (this.host.physics.dashIntensity || 0) * 4.5 * firstPerson;
    const response = target > this.dashFov ? 22 : 14;
    this.dashFov = THREE.MathUtils.damp(this.dashFov, target, response, Math.min(dt, 0.1));
    if (target === 0 && this.dashFov < 0.001) this.dashFov = 0;
    this.applyFov();
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
    const { min, max, default: fallback } = THIRD_PERSON_DISTANCE_LIMITS;
    this.thirdPersonDistance = THREE.MathUtils.clamp(Number(dist) || fallback, min, max);
  }

  private getFramingVehicle() {
    const vehicle = this.host.isDriving ? this.host.drivenContraption : null;
    if (vehicle !== this.framingVehicle) {
      this.framingVehicle = vehicle;
      this.vehicleZoom = 1;
    }
    return vehicle;
  }

  zoomThirdPerson(deltaPixels: number) {
    if (!Number.isFinite(deltaPixels) || deltaPixels === 0) return;
    const factor = Math.exp(THREE.MathUtils.clamp(deltaPixels, -250, 250) * 0.002);
    if (this.getFramingVehicle()) {
      // Keep manual zoom relative to the vehicle fit, independently of walking.
      // Zooming in stops at the framing limit instead of clipping the hull.
      this.vehicleZoom = THREE.MathUtils.clamp(this.vehicleZoom * factor, 1, 8);
    } else {
      this.setThirdPersonDistance(this.thirdPersonDistance * factor);
      this.host.ui?.setCameraDistance?.(this.thirdPersonDistance);
    }
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
    const distance = pose.distance * (this.followDistance ?? this.thirdPersonDistance);
    // Hide the body near the eye, and show the viewmodel only once back in
    // first person. This avoids flying through the head or carrying a floating hand.
    this.host.sceneRenderer?.setPlayerAvatarVisible?.(
      distance >= 0.65,
      this.perspective === 'first_person' && distance < 0.08 && Math.abs(pose.angle) < 0.08
    );
  }

  updateCameraRotation(): THREE.Vector3 {
    const { angle, distance } = this.getCameraPerspectiveTransition().pose;
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
    // Split the body's rotation into tilt and heading. Only inherit tilt so
    // a seat cannot lock free look or add its heading to the mouse yaw.
    const body = this.host.bodyQuaternion;
    this.bodyTilt.identity();
    if (body) {
      const headingLength = Math.hypot(body.y, body.w);
      // Heading is undefined exactly upside down. Retain the last heading
      // there so a continuous roll does not flip the camera at inversion.
      if (headingLength > 1e-8) {
        this.inverseBodyHeading.set(0, -body.y / headingLength, 0, body.w / headingLength);
      }
      this.bodyTilt.copy(body).multiply(this.inverseBodyHeading);
      // Fade with the existing perspective transition, including reversals.
      this.bodyTilt.slerp(UPRIGHT, THREE.MathUtils.clamp(distance, 0, 1));
      this.host.camera.quaternion.premultiply(this.bodyTilt);
      orbitDirection.applyQuaternion(this.bodyTilt);
    } else {
      this.inverseBodyHeading.identity();
    }
    return orbitDirection;
  }

  /** Eye anchor for both camera placement and crosshair picking, before orbit. */
  getEyePosition() {
    const eyePos = this.host.physics.getEyePosition();
    // The rider's eye offset follows the same body frame as the camera, so
    // banking moves the cockpit eye with the head instead of above the seat.
    if (!this.bodyTilt.equals(UPRIGHT)) {
      eyePos.sub(this.host.physics.position).applyQuaternion(this.bodyTilt).add(this.host.physics.position);
    }
    return eyePos;
  }

  updateCameraPosition(dt = 0) {
    const orbitDirection = this.updateCameraRotation();
    const eyePos = this.getEyePosition();
    const { distance } = this.getCameraPerspectiveTransition().pose;
    const vehicle = this.getFramingVehicle();
    if (distance > 0) {
      const minimum = this.framing.measure(this.host.camera, eyePos, vehicle, this.host.physics.getAABB?.());
      const target = Math.max(this.thirdPersonDistance, minimum) * (vehicle ? this.vehicleZoom : 1);
      if (this.followDistance === null) this.followDistance = target;
      if (Number.isFinite(dt) && dt > 0) {
        this.followDistance = THREE.MathUtils.damp(this.followDistance, target, 10, dt);
      }
      // Fit immediately after mounting, turning or resizing; ease back inward.
      this.followDistance = Math.max(minimum, this.followDistance);
    } else {
      this.followDistance = this.thirdPersonDistance;
    }
    this.host.camera.position.copy(eyePos).addScaledVector(orbitDirection, distance * this.followDistance);
    this.syncCameraViewVisibility();
  }
}
