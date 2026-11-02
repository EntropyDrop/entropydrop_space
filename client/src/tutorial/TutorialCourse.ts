/** Regular chapters use roughly 20 m intervals along the course. */
export const TUTORIAL_LESSON_STEP = { x: -158 / 8, z: 27 / 8 } as const;

/** Reserve room for the motor code example and Modeling beyond the driving lane. */
function courseClearance(chapter: number) {
  const gaps = Number(chapter >= 10) + Number(chapter >= 11);
  // Modeling starts beyond the driving lane, leaving room to stop the car.
  const openSpace = Number(chapter >= 12) + Number(chapter >= 13);
  return { x: -5 * gaps + openSpace * TUTORIAL_LESSON_STEP.x,
    z: gaps + openSpace * TUTORIAL_LESSON_STEP.z };
}

export function tutorialLessonHint(chapter: number) {
  const extra = courseClearance(chapter);
  return { x: 65420 / 8 + (chapter - 1) * TUTORIAL_LESSON_STEP.x + extra.x,
    z: 4568 / 8 + (chapter - 1) * TUTORIAL_LESSON_STEP.z + extra.z };
}

/** Vehicle lessons begin with the wheel in chapter 09, then its code in 10. */
export function tutorialVehicleStation(chapter: number) {
  const extra = courseClearance(chapter);
  return { x: 8014 + (chapter - 9) * TUTORIAL_LESSON_STEP.x + extra.x,
    z: 590 + (chapter - 9) * TUTORIAL_LESSON_STEP.z + extra.z };
}

/** Wheel sits one metre above the ground for selection without flying. */
export function tutorialWheelBounds() {
  const center = tutorialVehicleStation(9);
  return { minX: center.x - 1, maxX: center.x + 1, minY: 18, maxY: 18.5,
    minZ: center.z - 1, maxZ: center.z + 1 };
}

/** Horizontal cylinder used to practice rotating the micro selector. */
export function tutorialRotationBounds() {
  return { minX: 8032, maxX: 8036, minY: 17, maxY: 21, minZ: 584, maxZ: 590 };
}

/** The stopped lesson car already contains its chassis and three driven wheels. */
export const TUTORIAL_CHASSIS_ENTITY_ID = 'tutorial-chassis';

/** Pickup bodywork is centered on the wheel-installation workbench. */
export function tutorialChassisBounds() {
  const bench = tutorialVehicleWorkbench();
  const center = { x: (bench.minX + bench.maxX) / 2, z: (bench.minZ + bench.maxZ) / 2 };
  const tireDiameter = tutorialWheelBounds().maxX - tutorialWheelBounds().minX;
  return { minX: center.x - tireDiameter * 2.25, maxX: center.x + tireDiameter * 2.25,
    minY: bench.maxY, maxY: bench.maxY + 3.125, minZ: center.z - 2.125, maxZ: center.z + 2.125 };
}

/** Recessed axle faces put the tires beneath the flared wheel arches. */
export function tutorialChassisWheelMounts() {
  const bounds = tutorialChassisBounds();
  return [bounds.minX + 1.5, bounds.maxX - 1.5].flatMap(x => ([-1, 1] as const).map(side => ({
    x, y: bounds.minY + .5, z: side < 0 ? bounds.minZ + .5 : bounds.maxZ - .5, side,
  })));
}

/** Right rear faces the approach and accepts lesson 10's unchanged +30 RPM wheel. */
export function tutorialMissingWheelMount() {
  return tutorialChassisWheelMounts()[2];
}

/** The narrow workbench supports the rails and leaves all four tires clear. */
export function tutorialVehicleWorkbench() {
  const station = tutorialVehicleStation(11);
  const minX = Math.floor(station.x) - 5, minZ = Math.floor(station.z) - 1;
  return { minX, maxX: minX + 11, minY: 17, maxY: 19, minZ, maxZ: minZ + 3 };
}

export const TUTORIAL_MODELING_ENTITY_ID = 'tutorial-modeling-base';
export const TUTORIAL_MODELING_EXAMPLE_ID = 'tutorial-modeling-example';
export const TUTORIAL_RAMP_DIMENSIONS = [4, 0.25, 3] as const;
export const TUTORIAL_RAMP_ROTATION_Z = -30;

/** Standard terrain blocks form the empty pad the player assembles. */
export function tutorialModelingOrigin() {
  const station = tutorialVehicleStation(13);
  return { x: Math.floor(station.x) - 2, y: 17, z: Math.floor(station.z) - 4 };
}

export function tutorialFinishPosition() {
  const station = tutorialVehicleStation(13);
  return { x: station.x - 18, z: station.z - 18 * TUTORIAL_LESSON_STEP.z / TUTORIAL_LESSON_STEP.x };
}
