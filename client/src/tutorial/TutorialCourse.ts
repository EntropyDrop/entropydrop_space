/** Regular chapters use roughly 20 m intervals along the course. */
export const TUTORIAL_LESSON_STEP = { x: -158 / 8, z: 27 / 8 } as const;

/** Reserve extra room on both sides of the motor's single-line code example. */
function motorClearance(chapter: number) {
  const gaps = Number(chapter >= 11) + Number(chapter >= 12);
  return { x: -5 * gaps, z: gaps };
}

export function tutorialLessonHint(chapter: number) {
  const extra = motorClearance(chapter);
  return { x: 65420 / 8 + (chapter - 1) * TUTORIAL_LESSON_STEP.x + extra.x,
    z: 4568 / 8 + (chapter - 1) * TUTORIAL_LESSON_STEP.z + extra.z };
}

/** Continue from the center of the actual airborne chassis in chapter 09. */
export function tutorialVehicleStation(chapter: number) {
  const extra = motorClearance(chapter);
  return { x: 8014 + (chapter - 9) * TUTORIAL_LESSON_STEP.x + extra.x,
    z: 590 + (chapter - 9) * TUTORIAL_LESSON_STEP.z + extra.z };
}

export function tutorialWheelBounds() {
  const center = tutorialVehicleStation(10);
  return { minX: center.x - 1, maxX: center.x + 1, minY: 17, maxY: 17.5,
    minZ: center.z - 1, maxZ: center.z + 1 };
}

/** Horizontal cylinder used to practice rotating the micro selector. */
export function tutorialRotationBounds() {
  return { minX: 8032, maxX: 8036, minY: 17, maxY: 21, minZ: 584, maxZ: 590 };
}

/** The wheel-less pickup stays clear of the collision obstacle below chapter 09. */
export function tutorialChassisBounds() {
  const center = tutorialVehicleStation(9);
  const tireDiameter = tutorialWheelBounds().maxX - tutorialWheelBounds().minX;
  return { minX: center.x - tireDiameter * 2.25, maxX: center.x + tireDiameter * 2.25,
    minY: 24, maxY: 27.125, minZ: center.z - 2.125, maxZ: center.z + 2.125 };
}

/** Recessed axle faces put the tires beneath the flared wheel arches. */
export function tutorialChassisWheelMounts() {
  const bounds = tutorialChassisBounds();
  return [bounds.minX + 1.5, bounds.maxX - 1.5].flatMap(x => ([-1, 1] as const).map(side => ({
    x, y: bounds.minY + .5, z: side < 0 ? bounds.minZ + .5 : bounds.maxZ - .5, side,
  })));
}
