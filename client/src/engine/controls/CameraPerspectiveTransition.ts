import type { PlayerPerspective } from './PlayerController.ts';

export const CAMERA_PERSPECTIVE_TRANSITION_SECONDS = 0.28;

export interface CameraPerspectivePose {
  /** Fraction of the configured third-person distance, independent of player movement. */
  distance: number;
  /** Camera orbit around the current mouse-look frame: rear = 0, front = PI. */
  angle: number;
}

function targetPose(perspective: PlayerPerspective): CameraPerspectivePose {
  return {
    distance: perspective === 'first_person' ? 0 : 1,
    angle: perspective === 'third_person_front' ? Math.PI : 0
  };
}

/** Render-clock easing only; repeated physics/picking passes must not advance it. */
export class CameraPerspectiveTransition {
  perspective: PlayerPerspective;
  private current: CameraPerspectivePose;
  private transition: {
    from: CameraPerspectivePose;
    to: CameraPerspectivePose;
    elapsed: number;
  } | null = null;

  constructor(perspective: PlayerPerspective) {
    this.perspective = perspective;
    this.current = targetPose(perspective);
  }

  get pose(): CameraPerspectivePose {
    return { ...this.current };
  }

  setPerspective(perspective: PlayerPerspective, animate = true): void {
    if (!animate) {
      this.perspective = perspective;
      this.current = targetPose(perspective);
      this.transition = null;
      return;
    }
    if (perspective === this.perspective) return;
    this.perspective = perspective;
    const to = targetPose(perspective);
    // Orbit via the shortest arc instead of cutting through the player's body.
    const delta = to.angle - this.current.angle;
    to.angle = this.current.angle + Math.atan2(Math.sin(delta), Math.cos(delta));
    this.transition = { from: this.pose, to, elapsed: 0 };
  }

  advance(dt: number): void {
    const transition = this.transition;
    if (!transition || !Number.isFinite(dt) || dt <= 0) return;
    transition.elapsed += dt;
    const progress = Math.min(1, transition.elapsed / CAMERA_PERSPECTIVE_TRANSITION_SECONDS);
    const eased = progress * progress * (3 - 2 * progress);
    this.current = {
      distance: transition.from.distance + (transition.to.distance - transition.from.distance) * eased,
      angle: transition.from.angle + (transition.to.angle - transition.from.angle) * eased
    };
    if (progress === 1) {
      this.current = targetPose(this.perspective);
      this.transition = null;
    }
  }
}
