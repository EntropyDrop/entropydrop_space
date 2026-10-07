import type { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import * as THREE from 'three';
import type { PlayerController } from './PlayerController.ts';

export interface DrivingSessionPort {
  contraptions: PlayerController['contraptions'];
  hoveredContraption: PlayerController['hoveredContraption'];
  hoveredContraptionHit: PlayerController['hoveredContraptionHit'];
  physics: PlayerController['physics'];
  resetEntityInputState: PlayerController['resetEntityInputState'];
  ui: PlayerController['ui'];
}

/** Owns seat occupancy and synchronizes the rider with solved vehicle poses. */
export class DrivingSession {
  private readonly host: DrivingSessionPort;
  constructor(host: DrivingSessionPort) { this.host = host; }
  isDriving = false;
  drivenContraption: Contraption | null = null;
  drivenSeat: { componentId: string; seatIndex: number } | null = null;
  drivenSeatFixedOrientation = false;

  toggleDriveVehicle() {
    if (this.isDriving) {
      const vehicle = this.drivenContraption;
      const seat = this.drivenSeat;
      this.isDriving = false;
      this.host.contraptions.activeDrivable = null;
      this.drivenContraption = null;
      this.drivenSeat = null;
      this.drivenSeatFixedOrientation = false;
      this.host.resetEntityInputState();

      if (vehicle) {
        // Leave beside the vehicle instead of teleporting two metres upward.
        // The bounding sphere keeps the player's AABB outside even when the
        // vehicle is rotated, while preserving its current altitude/velocity.
        // A seat orientation wins over the chassis axis so the player is set
        // down where the seat faces instead of inside a swung-out hull.
        const seatRotation = seat
          ? vehicle.getSeatWorldQuaternion?.(seat.componentId, seat.seatIndex)
          : null;
        const exitDirection = new THREE.Vector3(1, 0, 0).applyQuaternion(
          seatRotation?.isQuaternion ? seatRotation : vehicle.quaternion
        );
        exitDirection.y = 0;
        if (exitDirection.lengthSq() < 1e-6) exitDirection.set(1, 0, 0);
        exitDirection.normalize();
        const exitDistance = vehicle.boundingRadius + this.host.physics.width + 0.25;
        this.host.physics.position.copy(vehicle.position).addScaledVector(exitDirection, exitDistance);
        this.host.physics.velocity.copy(vehicle.velocity);
        this.host.physics.isOnGround = false;
        this.host.physics.ridingContraption = null;
      }

      if (this.host.ui) this.host.ui.showToast(`Left the driver seat`);
      return;
    }

    const target = this.host.hoveredContraptionHit?.contraption || this.host.hoveredContraption;
    const hit = this.host.hoveredContraptionHit;
    const hitPoint = hit?.point;
    const focusPoint = hit?.block && target?.getBlockWorldCenter
      ? target.getBlockWorldCenter(hit.block)
      : hitPoint?.isVector3
        ? hitPoint
        : hitPoint
          ? new THREE.Vector3(Number(hitPoint.x), Number(hitPoint.y), Number(hitPoint.z))
          : null;
    const seat = target && focusPoint ? target.getNearestSeat?.(focusPoint) : null;

    if (target && seat) {
      if (target.serverManaged === true && target.serverCanControl !== true) {
        this.host.ui?.showToast?.('This entity is read-only or occupied by another endpoint', { tone: 'warning' });
        return;
      }
      this.host.resetEntityInputState();
      this.isDriving = true;
      this.drivenContraption = target;
      this.drivenSeat = { componentId: seat.componentId, seatIndex: seat.seatIndex };
      this.drivenSeatFixedOrientation = seat.fixedOrientation === true;
      this.host.contraptions.activeDrivable = target;
      if (this.host.ui) this.host.ui.showToast(`Mounted! Key behavior is defined by the ctx.input script · [C] program [V] leave`);
    } else {
      if (this.host.ui) this.host.ui.showToast(`Aim at an entity block with a configured seat, then press V`);
    }
  }

  refreshDrivenSeatOrientation() {
    if (!this.isDriving || !this.drivenSeat || !this.drivenContraption) {
      this.drivenSeatFixedOrientation = false;
      return;
    }
    // Read current metadata, not the getNearestSeat snapshot from mounting.
    // self.setSeats can replace the configuration while the rider stays seated.
    if (this.drivenContraption.getComponentSeats) {
      const seats = this.drivenContraption.getComponentSeats(this.drivenSeat.componentId);
      this.drivenSeatFixedOrientation = seats?.[this.drivenSeat.seatIndex]?.fixedOrientation === true;
    }
  }

  get bodyQuaternion(): THREE.Quaternion | null {
    this.refreshDrivenSeatOrientation();
    if (!this.drivenSeatFixedOrientation || !this.drivenSeat) return null;
    const seatWorld = this.drivenContraption?.getSeatWorldQuaternion?.(
      this.drivenSeat.componentId,
      this.drivenSeat.seatIndex
    );
    return seatWorld?.isQuaternion ? seatWorld : null;
  }

  syncDrivenVehiclePose() {
    if (!this.isDriving || !this.drivenContraption) return false;
    const seat = this.drivenSeat;
    const seatWorld = seat
      ? this.drivenContraption.getSeatWorldPosition?.(seat.componentId, seat.seatIndex)
      : null;
    if (!seatWorld) {
      this.isDriving = false;
      this.host.contraptions.activeDrivable = null;
      this.drivenContraption = null;
      this.drivenSeat = null;
      this.drivenSeatFixedOrientation = false;
      this.host.physics.ridingContraption = null;
      return false;
    }
    this.host.physics.position.copy(seatWorld);
    this.host.physics.velocity.set(0, 0, 0);
    this.refreshDrivenSeatOrientation();
    return true;
  }
}
