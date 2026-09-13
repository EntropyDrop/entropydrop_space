export type LightingQuality = 'low' | 'medium' | 'high' | 'ultra';

export const DEFAULT_LIGHTING_QUALITY: LightingQuality = 'medium';
export const LIGHTING_QUALITY_SETTING_KEY = 'space_setting_lighting_quality';
export const LIGHTING_QUALITY_LEVELS = ['low', 'medium', 'high', 'ultra'] as const;

interface LightingPreset {
  readonly label: string;
  readonly description: string;
  readonly shadowMapSize: number;
  readonly shadowExtent: number;
  readonly sunColor: number;
  readonly sunIntensity: number;
  readonly hemisphereIntensity: number;
  readonly hemisphereSkyColor: number;
  readonly hemisphereGroundColor: number;
  readonly fillIntensity: number;
  readonly exposure: number;
  readonly skyGradient: number;
  readonly sunGlow: number;
}

/** Medium preserves the existing daylight look and GPU budget. */
export const LIGHTING_PRESETS: Readonly<Record<LightingQuality, LightingPreset>> = {
  low: {
    label: 'Low',
    description: 'Simple daylight without real-time shadows · fastest',
    shadowMapSize: 0,
    shadowExtent: 45,
    sunColor: 0xfffaed,
    sunIntensity: 1.25,
    hemisphereIntensity: 1.0,
    hemisphereSkyColor: 0xffffff,
    hemisphereGroundColor: 0x556644,
    fillIntensity: 0,
    exposure: 1.15,
    skyGradient: 0.35,
    sunGlow: 0,
  },
  medium: {
    label: 'Medium',
    description: 'Natural daylight with local soft shadows · balanced',
    shadowMapSize: 1024,
    shadowExtent: 45,
    sunColor: 0xfffaed,
    sunIntensity: 1.5,
    hemisphereIntensity: 0.8,
    hemisphereSkyColor: 0xffffff,
    hemisphereGroundColor: 0x556644,
    fillIntensity: 0,
    exposure: 1.15,
    skyGradient: 0.55,
    sunGlow: 0,
  },
  high: {
    label: 'High',
    description: 'Warm sunlight, cool fill and detailed soft shadows',
    shadowMapSize: 2048,
    shadowExtent: 48,
    sunColor: 0xffefd6,
    sunIntensity: 1.85,
    hemisphereIntensity: 0.65,
    hemisphereSkyColor: 0xd6eaff,
    hemisphereGroundColor: 0x697454,
    fillIntensity: 0.18,
    exposure: 1.12,
    skyGradient: 0.68,
    sunGlow: 0.16,
  },
  ultra: {
    label: 'Ultra',
    description: 'Shader-pack look · cinematic clouds, sun rays, bloom and contact shadows · highest GPU cost',
    shadowMapSize: 4096,
    shadowExtent: 64,
    sunColor: 0xffdfad,
    sunIntensity: 3.2,
    hemisphereIntensity: 0.85,
    hemisphereSkyColor: 0xb8d9ff,
    hemisphereGroundColor: 0x879c61,
    fillIntensity: 0.24,
    exposure: 1.08,
    skyGradient: 0.78,
    sunGlow: 0.24,
  },
};

export function normalizeLightingQuality(value: unknown): LightingQuality {
  return LIGHTING_QUALITY_LEVELS.includes(value as LightingQuality)
    ? value as LightingQuality
    : DEFAULT_LIGHTING_QUALITY;
}
