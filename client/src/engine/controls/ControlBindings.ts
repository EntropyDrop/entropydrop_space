// Global editor/game commands stay engine-owned and are not exposed to entity
// programs, avoiding collisions between scripts and C/V/tool shortcuts.
export const RESERVED_ENTITY_INPUT_CODES = new Set([
  'Escape',
  'Backspace', 'Delete',
  'F3', 'F5',
  'KeyC', 'KeyE', 'KeyF', 'KeyG', 'KeyR', 'KeyV',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'
]);

export function isPerspectiveToggleCode(code: string) {
  return code === 'F3' || code === 'F5';
}

export type PlayerPerspective = 'first_person' | 'third_person' | 'third_person_front';

export const SpecialTool = {
  SELECTOR: 'selector',     // 1. Selector (world/component selection and copy)
  HAMMER: 'hammer',         // 2. Hammer (preview/place inventory items)
  WRENCH: 'wrench',         // 3. Wrench (show pivot XYZ, hold to grab, right start/stop)
  SHOVEL: 'shovel',         // 4. Shovel (remove / place 1x1x1 standard blocks)
  SPOON: 'spoon',           // 5. Spoon (carve 8x8x8 micro voxels)
  BRUSH: 'brush',           // 6. Brush (repaint block colors)
  MODELING: 'modeling',     // 7. Modeling (visual-only decoration cubes)
  PIPETTE: 'pipette',       // Legacy alias; color sampling is part of Brush
  SUPER_GLUE: 'selector'    // alias for backwards compatibility
};
