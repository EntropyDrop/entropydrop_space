import { TORUS_SIZE_X, TORUS_SIZE_Z, wrapX, wrapZ } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import type { PlayerPhysics } from '@entropydrop/space-engine/physics/PlayerPhysics.ts';
import type { PlayerController } from '../engine/controls/PlayerController.ts';

export interface NavigationTarget {
  x: number;
  y: number;
  z: number;
}

export interface NavigationUiBridge {
  showToast(message: string): void;
  refresh(): void;
}

/** Pure navigation controller. React owns its form and visual state. */
export class NavigationSystem {
  physics: PlayerPhysics;
  controller: PlayerController;
  ui: NavigationUiBridge | null;

  isNavigating = false;
  target: NavigationTarget | null = null;
  cruiseSpeed = 40.0;
  minSpeed = 6.0;
  decelDistance = 25.0;
  arrivalThreshold = 0.6;

  constructor(
    physics: PlayerPhysics,
    controller: PlayerController,
    ui: NavigationUiBridge | null = null
  ) {
    this.physics = physics;
    this.controller = controller;
    this.ui = ui;
  }

  startFromInputValues(xValue: string, yValue: string, zValue: string): boolean {
    const rawX = parseFloat(xValue);
    const rawY = parseFloat(yValue);
    const rawZ = parseFloat(zValue);
    if (Number.isNaN(rawX) || Number.isNaN(rawZ)) {
      this.ui?.showToast('Please enter valid coordinates (X, Z)');
      return false;
    }
    const targetY = Number.isNaN(rawY)
      ? Math.max(20, this.physics.position.y)
      : Math.max(0, Math.min(256, rawY));
    this.startNavigation(wrapX(rawX), targetY, wrapZ(rawZ));
    return true;
  }

  startNavigation(targetX: number, targetY: number, targetZ: number): void {
    if (this.controller?.isDriving) {
      this.controller.toggleDriveVehicle?.();
    }
    this.target = { x: wrapX(targetX), y: targetY, z: wrapZ(targetZ) };
    this.isNavigating = true;
    this.physics.isFlying = true;
    this.physics.velocity.set(0, 0, 0);
    this.ui?.refresh();
    void this.controller?.requestLock?.();
    this.ui?.showToast(`Navigation Engaged: (${this.target.x.toFixed(0)}, ${targetY.toFixed(0)}, ${this.target.z.toFixed(0)})`);
  }

  stopNavigation(reason: 'arrived' | 'cancelled' = 'cancelled'): void {
    if (!this.isNavigating && !this.target) return;
    this.isNavigating = false;
    this.target = null;
    this.physics.velocity.set(0, 0, 0);
    this.ui?.refresh();
    this.ui?.showToast(reason === 'arrived' ? 'Target Reached' : 'Navigation Disengaged');
  }

  update(dt: number): void {
    if (!this.isNavigating || !this.target) return;
    const clampedDt = Math.min(dt, 0.1);

    this.physics.capturePreviousPosition?.();

    let dx = wrapX(this.target.x) - wrapX(this.physics.position.x);
    if (dx > TORUS_SIZE_X / 2) dx -= TORUS_SIZE_X;
    else if (dx < -TORUS_SIZE_X / 2) dx += TORUS_SIZE_X;

    let dz = wrapZ(this.target.z) - wrapZ(this.physics.position.z);
    if (dz > TORUS_SIZE_Z / 2) dz -= TORUS_SIZE_Z;
    else if (dz < -TORUS_SIZE_Z / 2) dz += TORUS_SIZE_Z;

    const dy = this.target.y - this.physics.position.y;
    const distance = Math.hypot(dx, dy, dz);
    if (distance <= this.arrivalThreshold) {
      this.physics.position.x = wrapX(this.target.x);
      this.physics.position.y = this.target.y;
      this.physics.position.z = wrapZ(this.target.z);
      this.physics.velocity.set(0, 0, 0);
      this.stopNavigation('arrived');
      return;
    }

    let speed = this.cruiseSpeed;
    if (distance < this.decelDistance) {
      speed = Math.max(this.minSpeed, this.cruiseSpeed * Math.sqrt(distance / this.decelDistance));
    }
    const step = Math.min(distance, speed * clampedDt);
    const moveX = (dx / distance) * step;
    const moveY = (dy / distance) * step;
    const moveZ = (dz / distance) * step;

    this.physics.position.x = wrapX(this.physics.position.x + moveX);
    this.physics.position.y += moveY;
    this.physics.position.z = wrapZ(this.physics.position.z + moveZ);

    if (clampedDt > 0) {
      this.physics.velocity.set(moveX / clampedDt, moveY / clampedDt, moveZ / clampedDt);
    }
    this.physics.isFlying = true;
    this.physics.isOnGround = false;
  }
}
