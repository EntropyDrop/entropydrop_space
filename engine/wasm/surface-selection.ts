// Each call visits at most 256 nodes; the DFS frontier and hysteresis are
// caller-owned snapshots so subdivision can yield without sharing live memory.
export function surfaceSelect(heights: usize, minima: usize, errors: usize,
  trigX: usize, trigZ: usize, detail: usize, splits: usize, work: usize,
  parameters: usize, output: usize): i32 {
  const cameraX = load<f64>(parameters), cameraY = load<f64>(parameters + 8), cameraZ = load<f64>(parameters + 16);
  const maxDistance = load<f64>(parameters + 24), areaPx2 = load<f64>(parameters + 32), pixelScale = load<f64>(parameters + 40);
  const sampleSize = load<f64>(parameters + 48);
  let visibleCount = load<f64>(parameters + 56), tolerance = load<f64>(parameters + 64);
  let length = load<i32>(work), written = 0;
  const R: f64 = 16384 / (Math.PI * 2), rho: f64 = 2048 / (Math.PI * 2);
  for (let visited = 0; visited < 256 && length > 0; visited++) {
    const size = load<i32>(work + length-- * 4), z = load<i32>(work + length-- * 4), x = load<i32>(work + length-- * 4);
    const axis = 64 / size, index = (axis * axis - 1) / 3 + (x / size) * axis + z / size;
    const sourceSize = max(size, i32(sampleSize)), sourceAxis = 64 / sourceSize;
    const source = (sourceAxis * sourceAxis - 1) / 3 + (x / sourceSize) * sourceAxis + z / sourceSize;
    const height = load<u16>(heights + source * 2), minimum = load<u16>(minima + source * 2);
    const highY = f64(height) * 0.125, lowY = f64(minimum) * 0.125;
    const centerRho = Math.min(rho + ((highY + lowY) / 2 - 16), R - 1);
    const ct = load<f64>(trigX + (x * 2 + size) * 16), st = load<f64>(trigX + (x * 2 + size) * 16 + 8);
    const cp = load<f64>(trigZ + (z * 2 + size) * 16), sp = load<f64>(trigZ + (z * 2 + size) * 16 + 8);
    const radial = R + centerRho * cp;
    const dx = cameraX - radial * ct, dy = cameraY - centerRho * sp, dz = cameraZ - radial * st;
    const boundRho = Math.max(Math.abs(Math.min(rho + lowY - 16, R - 1)), Math.abs(Math.min(rho + highY - 16, R - 1)));
    const scale = Math.max(1, Math.max((R + boundRho) / R, boundRho / rho));
    const deltaY = highY - lowY;
    const radius = Math.sqrt(f64(size) * size * 2 + deltaY * deltaY) * 0.5 * scale + 1e-6;
    const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz) - radius);
    tolerance = Math.min(tolerance, Math.abs(distance - maxDistance));
    if (distance > maxDistance) continue;
    const angle = f64(size) / rho;
    const curvature = Math.max(1, rho + highY - 16) * (angle * angle) / 8 * 1.2;
    const error = f64(size) > sampleSize ? deltaY + curvature + f64(size) * f64(load<f32>(errors + source * 4)) * 0.25 : curvature;
    const splitByte = splits + (index >> 3), splitBit = 1 << (index & 7);
    const threshold = areaPx2 * ((load<u8>(splitByte) & splitBit) != 0 ? 0.65 : 1);
    // Keep this rotation-independent projected face-area bound in parity with
    // SurfaceSubdivision.ts. Half-pixel residuals can stay merged.
    const worldArea = f64(size) * (f64(size) + 2 * Math.max(0, deltaY)) * scale * scale;
    const splitDistance = Math.min(Math.sqrt(worldArea / threshold), error / 0.5) * pixelScale;
    let boundary = false;
    for (let cx = x / 16; cx <= (x + size - 1) / 16 + 2; cx++) {
      for (let cz = z / 16; cz <= (z + size - 1) / 16 + 2; cz++) {
        const ownership = load<u8>(detail + cx * 6 + cz);
        if (ownership == 255 || (size > 16 && ownership != 0)) boundary = true;
      }
    }
    if (size > 1 && (distance < splitDistance || boundary) && visibleCount < 1015808) {
      if (!boundary) tolerance = Math.min(tolerance, Math.max(0,
        Math.min(Math.sqrt(worldArea / (areaPx2 * 0.65)), error / 0.5) * pixelScale - distance));
      store<u8>(splitByte, load<u8>(splitByte) | splitBit);
      const half = size / 2;
      // Reverse push order preserves the existing X-first depth-first traversal.
      for (let child = 3; child >= 0; child--) {
        store<i32>(work + ++length * 4, x + (child & 1) * half);
        store<i32>(work + ++length * 4, z + (child >> 1) * half);
        store<i32>(work + ++length * 4, half);
      }
    } else {
      if (size > 1) tolerance = Math.min(tolerance, Math.max(0,
        distance - Math.min(Math.sqrt(worldArea / areaPx2), error / 0.5) * pixelScale));
      store<u8>(splitByte, load<u8>(splitByte) & ~splitBit);
      store<i32>(output + written * 12, x); store<i32>(output + written * 12 + 4, z); store<i32>(output + written * 12 + 8, size);
      written++;
      if (height != 0) visibleCount++;
    }
  }
  store<i32>(work, length); store<f64>(parameters + 64, tolerance);
  return written;
}
