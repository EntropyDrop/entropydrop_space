/** Integer-only counterpart of tools/minecraft-matched/.../TerrainSpec.java.
 * Coordinates are metres; solids are standard unit cubes with no detail cells. */
export const MATCHED_SIZE = 1024;
export const MATCHED_SEED = 42;
export const MATCHED_ORIGIN_X = 7680;
export const MATCHED_ORIGIN_Z = 512;
export const TERRAIN_GENERATOR_MATCHED = 10;

export function matchedHash(x: number, y: number, z: number, seed: number) {
  let h = Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x5f356495) ^ Math.imul(z, 0x6c8e9cf5) ^ seed;
  h = Math.imul(h ^ h >>> 16, 0x7feb352d);
  h = Math.imul(h ^ h >>> 15, 0x846ca68b);
  return (h ^ h >>> 16) >>> 0;
}
function noise(x: number, z: number, step: number, mask: number, seed: number) {
  const gx = Math.floor(x / step), gz = Math.floor(z / step), fx = x - gx * step, fz = z - gz * step;
  const a = (matchedHash(gx, 0, gz, seed) & mask) * (step - fx) + (matchedHash(gx + 1, 0, gz, seed) & mask) * fx;
  const b = (matchedHash(gx, 0, gz + 1, seed) & mask) * (step - fx) + (matchedHash(gx + 1, 0, gz + 1, seed) & mask) * fx;
  return Math.floor((a * (step - fz) + b * fz) / (step * step));
}
export function matchedHeight(x: number, z: number, seed = MATCHED_SEED) {
  if (x < 0 || z < 0 || x >= MATCHED_SIZE || z >= MATCHED_SIZE) return -1;
  return 8 + noise(x, z, 64, 63, seed) + noise(x, z, 16, 15, seed ^ 0x13579bdf);
}
export function matchedColorIndex(x: number, y: number, z: number, seed = MATCHED_SEED) {
  return matchedHash(x, y, z, seed ^ 0x2468ace0) >>> 24;
}
export function matchedColor(index: number) { return 0x404040 + (matchedHash(index, 0, 0, 0x31415926) & 0x7f7f7f); }
