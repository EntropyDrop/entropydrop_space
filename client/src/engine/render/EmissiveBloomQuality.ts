export const EMISSIVE_BLOOM_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export type EmissiveBloomQuality = typeof EMISSIVE_BLOOM_LEVELS[number];

export const DEFAULT_EMISSIVE_BLOOM_QUALITY: EmissiveBloomQuality = 'medium';
export const EMISSIVE_BLOOM_SETTING_KEY = 'space_setting_emissive_bloom';

export const EMISSIVE_BLOOM_PRESETS = {
  off: { label: 'Off', strength: 0, maxSize: 0 },
  low: { label: 'Low', strength: 0.13, maxSize: 768 },
  medium: { label: 'Medium', strength: 0.32, maxSize: 1280 },
  high: { label: 'High', strength: 0.58, maxSize: 1920 },
} as const;

export function normalizeEmissiveBloomQuality(value: unknown): EmissiveBloomQuality {
  return EMISSIVE_BLOOM_LEVELS.includes(value as EmissiveBloomQuality)
    ? value as EmissiveBloomQuality
    : DEFAULT_EMISSIVE_BLOOM_QUALITY;
}
