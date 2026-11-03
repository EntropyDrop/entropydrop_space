export type OfflineSurfaceMode = 'bounded' | 'repeat' | 'full';

/** Full coverage uses every district's own coordinates, never template aliases. */
export function offlineSurfacePlan(mode: OfflineSurfaceMode, matched = false) {
  if (mode === 'full') {
    const zones: [number, number][] = [];
    for (let x = 0; x < 32; x++) for (let z = 0; z < 4; z++) zones.push([x, z]);
    // Publish nearby districts first; readiness still requires all 128.
    zones.sort((a, b) => Math.hypot(a[0] - 16, a[1] - 2) - Math.hypot(b[0] - 16, b[1] - 2));
    return { zones, total: zones.length, repeatWorld: false };
  }
  const repeatWorld = mode === 'repeat' && !matched;
  const zones = matched ? [[15, 1], [15, 2], [16, 1], [16, 2]]
    : repeatWorld ? [[16, 2]] : [[15, 1], [15, 2], [16, 1], [16, 2], [0, 1], [0, 2], [31, 1], [31, 2]];
  return { zones, total: repeatWorld ? 128 : zones.length, repeatWorld };
}
