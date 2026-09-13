export interface EntityImpostorSettings {
  startDistance: number;
  maxDistance: number;
}

export const ENTITY_IMPOSTOR_SETTING_KEY = 'space_setting_entity_impostors';
export const DEFAULT_ENTITY_IMPOSTOR_SETTINGS: Readonly<EntityImpostorSettings> = Object.freeze({
  startDistance: 80,
  maxDistance: 8500,
});
export const ENTITY_IMPOSTOR_SETTING_LIMITS = Object.freeze({
  startDistance: Object.freeze({ min: 40, max: 1000, step: 20 }),
  maxDistance: Object.freeze({ min: 200, max: 8500, step: 100 }),
});

export function normalizeEntityImpostorSettings(value: Partial<EntityImpostorSettings> | null = {}): EntityImpostorSettings {
  const snap = (key: keyof EntityImpostorSettings) => {
    const limits = ENTITY_IMPOSTOR_SETTING_LIMITS[key];
    const raw = value?.[key];
    const number = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_ENTITY_IMPOSTOR_SETTINGS[key];
    return Math.max(limits.min, Math.min(limits.max, Math.round(number / limits.step) * limits.step));
  };
  const startDistance = snap('startDistance');
  return { startDistance, maxDistance: Math.max(snap('maxDistance'), Math.ceil((startDistance + 100) / 100) * 100) };
}
