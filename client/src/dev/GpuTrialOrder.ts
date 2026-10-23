/** Alternate ABBA and BAAB. Each role occupies every position equally over
 * eight observations, including identical-code controls. */
export function gpuTrialTreatment(index: number, seed?: number) {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid GPU trial index.');
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff))
    throw new Error('Invalid GPU trial seed.');
  const quartet = Math.floor(index / 4), position = index % 4;
  // Randomize which order comes first in each balanced pair. This avoids
  // repeatedly aligning the same order with a periodic camera/compositor.
  let mixed = (Math.floor(index / 8) ^ (seed ?? 0)) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b);
  const flip = seed !== undefined && (((mixed ^ (mixed >>> 16)) & 1) === 1);
  const reverse = (quartet % 2 === 1) !== flip;
  const candidate = (position === 1 || position === 2) !== reverse;
  return { index, quartet, position, order: reverse ? 'BAAB' as const : 'ABBA' as const,
    role: candidate ? 'candidate' as const : 'reference' as const };
}
