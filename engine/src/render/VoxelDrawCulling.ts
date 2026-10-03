/** Conservative handoff classification for a flat rectangle. The shader moves
 * side faces 0.01 m toward their owner; pad both sides to include that shift,
 * interpolation roundoff and boundary pixels. Periodic seams share ownership.
 * 0: no handoff, 1: mixed/fading, 2: every possible fragment is fully replaced. */
export function voxelHandoffMode(data: ArrayLike<number>, bounds: readonly number[]): 0 | 1 | 2 {
  const minX = Math.floor((bounds[0] - .02) / 16), maxX = Math.floor((bounds[1] + .02) / 16);
  const minZ = Math.floor((bounds[2] - .02) / 16), maxZ = Math.floor((bounds[3] + .02) / 16);
  let any = false, full = true;
  for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
    const index = (((z % 128 + 128) % 128) * 1024 + (x % 1024 + 1024) % 1024) * 2;
    const near = data[index], authored = data[index + 1] > 127;
    any ||= near > 0 || authored;
    full &&= near === 255 || authored;
    if (any && !full) return 1;
  }
  return full ? 2 : any ? 1 : 0;
}
