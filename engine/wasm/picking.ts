// Four already-projected corners per quad. Preserve Three's plane/barycentric
// arithmetic, inclusive edges, triangle order and last-hit distance tie break.
export function rayQuads(quads: usize, count: i32, ray: usize, output: usize, distance: f64): void {
  const ox = load<f64>(ray), oy = load<f64>(ray + 8), oz = load<f64>(ray + 16);
  const dx = load<f64>(ray + 24), dy = load<f64>(ray + 32), dz = load<f64>(ray + 40);
  store<f64>(output, -1);
  for (let i = 0; i < count; i++) {
    const quad = quads + usize(i) * 96;
    for (let triangle = 0; triangle < 2; triangle++) {
      const b = quad + (triangle == 0 ? 24 : 48), c = quad + (triangle == 0 ? 48 : 72);
      const ax = load<f64>(quad), ay = load<f64>(quad + 8), az = load<f64>(quad + 16);
      const bx = load<f64>(b), by = load<f64>(b + 8), bz = load<f64>(b + 16);
      const cx = load<f64>(c), cy = load<f64>(c + 8), cz = load<f64>(c + 16);
      const ux = cx - bx, uy = cy - by, uz = cz - bz;
      const vx = ax - bx, vy = ay - by, vz = az - bz;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const inverse = 1 / (length == 0 ? 1 : length);
      nx *= inverse; ny *= inverse; nz *= inverse;
      const constant = -(ax * nx + ay * ny + az * nz);
      const denominator = nx * dx + ny * dy + nz * dz;
      const originDistance = nx * ox + ny * oy + nz * oz + constant;
      let t: f64 = 0;
      if (denominator == 0) { if (originDistance != 0) continue; }
      else { t = -originDistance / denominator; if (t < 0) continue; }
      const px = dx * t + ox, py = dy * t + oy, pz = dz * t + oz;
      const v0x = cx - ax, v0y = cy - ay, v0z = cz - az;
      const v1x = bx - ax, v1y = by - ay, v1z = bz - az;
      const v2x = px - ax, v2y = py - ay, v2z = pz - az;
      const d00 = v0x * v0x + v0y * v0y + v0z * v0z;
      const d01 = v0x * v1x + v0y * v1y + v0z * v1z;
      const d02 = v0x * v2x + v0y * v2y + v0z * v2z;
      const d11 = v1x * v1x + v1y * v1y + v1z * v1z;
      const d12 = v1x * v2x + v1y * v2y + v1z * v2z;
      const denom = d00 * d11 - d01 * d01;
      if (denom == 0) continue;
      const inv = 1 / denom;
      const u = (d11 * d02 - d01 * d12) * inv, v = (d00 * d12 - d01 * d02) * inv;
      const w = 1 - u - v;
      if (!(w >= -1e-5 && v >= -1e-5 && u >= -1e-5)) continue;
      const ex = ox - px, ey = oy - py, ez = oz - pz;
      const hitDistance = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (hitDistance > distance + 1e-9) continue;
      distance = hitDistance;
      store<f64>(output, i); store<f64>(output + 8, triangle);
      store<f64>(output + 16, w); store<f64>(output + 24, v); store<f64>(output + 32, u);
      store<f64>(output + 40, distance);
    }
  }
}
