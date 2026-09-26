import { colorToHex, normalizeColor } from './BlockTypes.ts';
import { normalizeVoxelMaterialId, VoxelMaterialIds } from './VoxelMaterials.ts';

export const MAX_GRADIENT_STOPS = 5;

export interface GradientStop {
  color: string;
  position: number;
}

export interface PaletteEntry {
  name: string;
  hex: string;
  stops: GradientStop[];
  materialId: number;
}

function clamp01(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

export function normalizeGradientStops(value: unknown, fallback: string | number = '#f2a93b'): GradientStop[] {
  const source = Array.isArray(value) ? value.slice(0, MAX_GRADIENT_STOPS) : [];
  const stops = source.map((stop: any, index) => ({
    color: colorToHex(normalizeColor(stop?.color ?? stop?.hex ?? stop ?? fallback)).toLowerCase(),
    position: Math.round(clamp01(stop?.position ?? (source.length <= 1 ? 0 : index / (source.length - 1))) * 1000) / 1000,
  })).sort((left, right) => left.position - right.position);
  if (stops.length === 0) {
    stops.push({ color: colorToHex(normalizeColor(fallback)).toLowerCase(), position: 0 });
  }
  return stops;
}

export function normalizePaletteEntry(value: any, fallbackName = 'Custom'): PaletteEntry {
  const legacyColor = value?.hex ?? value?.color ?? value ?? '#f2a93b';
  const stops = normalizeGradientStops(value?.stops, legacyColor);
  return {
    name: typeof value?.name === 'string' && value.name ? value.name : fallbackName,
    hex: stops[0].color,
    stops,
    materialId: normalizeVoxelMaterialId(value?.materialId ?? VoxelMaterialIds.DEFAULT),
  };
}

export function gradientCss(stops: GradientStop[]): string {
  const normalized = normalizeGradientStops(stops);
  if (normalized.length === 1) return normalized[0].color;
  return `linear-gradient(90deg, ${normalized.map(stop => `${stop.color} ${Math.round(stop.position * 1000) / 10}%`).join(', ')})`;
}

export function sampleGradientColor(stops: GradientStop[], progress: number): number {
  const normalized = normalizeGradientStops(stops);
  const t = clamp01(progress);
  let left = normalized[0];
  let right = normalized[normalized.length - 1];
  for (let index = 1; index < normalized.length; index += 1) {
    if (t <= normalized[index].position) {
      left = normalized[index - 1];
      right = normalized[index];
      break;
    }
  }
  if (t <= left.position || right.position <= left.position) return normalizeColor(left.color);
  if (t >= right.position) return normalizeColor(right.color);
  const amount = (t - left.position) / (right.position - left.position);
  const from = normalizeColor(left.color);
  const to = normalizeColor(right.color);
  const channel = (shift: number) => Math.round(
    ((from >> shift) & 0xff) + (((to >> shift) & 0xff) - ((from >> shift) & 0xff)) * amount,
  );
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}
