import { tutorialChassisBounds, tutorialRotationBounds, tutorialWheelBounds } from './TutorialCourse.ts';

const rotation = tutorialRotationBounds(), chassis = tutorialChassisBounds(), wheel = tutorialWheelBounds();
const marker = (chapter: number, label: string, x: number, y: number, z: number, color: number) =>
  ({ chapter, label, x, y, z, color });

/** Labels point at the actual micro cells; they never change selection geometry. */
export const tutorialSelectionMarkers = [
  marker(8, 'A', rotation.maxX - .125, rotation.minY, rotation.maxZ - .125, 0x3bc1f2),
  marker(8, 'B · Far corner', rotation.minX, rotation.maxY - .125, rotation.minZ, 0x5af23b),
  marker(9, 'A · Front bumper', chassis.minX, chassis.minY, chassis.minZ, 0x3bc1f2),
  marker(9, 'B · Rear antenna', chassis.maxX - .125, chassis.maxY - .125, chassis.maxZ - .125, 0x5af23b),
  marker(10, 'A', wheel.minX, wheel.maxY - .125, wheel.maxZ - .125, 0x3bc1f2),
  marker(10, 'B · Far corner', wheel.maxX - .125, wheel.minY, wheel.minZ, 0x5af23b),
].map(point => ({ ...point, subject: point.chapter === 10
  ? { x: (wheel.minX + wheel.maxX) / 2, y: wheel.minY, z: (wheel.minZ + wheel.maxZ) / 2 }
  : point }));

const exercises = [8, 9, 10].map(chapter => {
  const pair = tutorialSelectionMarkers.filter(marker => marker.chapter === chapter);
  return { chapter, x: (pair[0].x + pair[1].x) / 2, z: (pair[0].z + pair[1].z) / 2 };
});

export function nearbyTutorialSelectionChapter(player: { x: number; z: number }): number | null {
  let chapter: number | null = null, nearest = 18;
  for (const exercise of exercises) {
    const distance = Math.hypot(player.x - exercise.x, player.z - exercise.z);
    if (distance < nearest) { nearest = distance; chapter = exercise.chapter; }
  }
  return chapter;
}
