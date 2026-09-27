// Box: center[3], axes[9], halfExtents[3]. Pair output: normal[3], depth,
// featurePoint[3], faceSupport. Terrain pairs reverse the separating normal.
const AXES = memory.data(45 * 8);
const SUPPORT = memory.data(8 * 8);

function support(box: usize, nx: f64, ny: f64, nz: f64, sign: f64, out: usize): void {
  let best = -Infinity, sx: f64 = 0, sy: f64 = 0, sz: f64 = 0, count = 0;
  for (let vertex = 0; vertex < 8; vertex++) {
    let projection: f64 = 0;
    let x = load<f64>(box), y = load<f64>(box + 8), z = load<f64>(box + 16);
    for (let k = 0; k < 3; k++) {
      const axis = box + 24 + k * 24;
      const ax = load<f64>(axis), ay = load<f64>(axis + 8), az = load<f64>(axis + 16);
      const amount = (((vertex >> k) & 1) != 0 ? 1.0 : -1.0) * load<f64>(box + 96 + k * 8);
      projection += amount * (ax * nx + ay * ny + az * nz);
      x += ax * amount; y += ay * amount; z += az * amount;
    }
    const score = sign * projection;
    if (score > best + 1e-7) { best = score; sx = x; sy = y; sz = z; count = 1; }
    else if (best - score <= 1e-7) { sx += x; sy += y; sz += z; count++; }
  }
  const inverse = 1.0 / f64(count);
  store<f64>(out, sx * inverse); store<f64>(out + 8, sy * inverse);
  store<f64>(out + 16, sz * inverse); store<f64>(out + 24, count);
}

export function obbContacts(pairs: usize, count: i32, output: usize, terrain: bool): void {
  for (let pair = 0; pair < count; pair++) {
    const a = pairs + usize(pair) * 240, b = a + 120, out = output + usize(pair) * 64;
    store<f64>(out + 24, 0);
    memory.copy(AXES, a + 24, 72); memory.copy(AXES + 72, b + 24, 72);
    let axes = 6;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const aa = a + 24 + i * 24, bb = b + 24 + j * 24;
      const ax = load<f64>(aa), ay = load<f64>(aa + 8), az = load<f64>(aa + 16);
      const bx = load<f64>(bb), by = load<f64>(bb + 8), bz = load<f64>(bb + 16);
      const x = ay * bz - az * by, y = az * bx - ax * bz, z = ax * by - ay * bx;
      if (x * x + y * y + z * z > 1e-10) {
        const p = AXES + axes++ * 24;
        store<f64>(p, x); store<f64>(p + 8, y); store<f64>(p + 16, z);
      }
    }
    const sign = terrain ? -1.0 : 1.0;
    const dx = (load<f64>(b) - load<f64>(a)) * sign;
    const dy = (load<f64>(b + 8) - load<f64>(a + 8)) * sign;
    const dz = (load<f64>(b + 16) - load<f64>(a + 16)) * sign;
    let depth = Infinity, nx: f64 = 0, ny: f64 = 0, nz: f64 = 0;
    for (let i = 0; i < axes; i++) {
      const p = AXES + i * 24;
      let x = load<f64>(p), y = load<f64>(p + 8), z = load<f64>(p + 16);
      const length = Math.sqrt(x * x + y * y + z * z), inv = 1 / (length == 0 ? 1 : length);
      x *= inv; y *= inv; z *= inv;
      let ra: f64 = 0, rb: f64 = 0;
      for (let k = 0; k < 3; k++) {
        const aa = a + 24 + k * 24, bb = b + 24 + k * 24;
        ra += load<f64>(a + 96 + k * 8) * Math.abs(load<f64>(aa) * x + load<f64>(aa + 8) * y + load<f64>(aa + 16) * z);
        rb += load<f64>(b + 96 + k * 8) * Math.abs(load<f64>(bb) * x + load<f64>(bb + 8) * y + load<f64>(bb + 16) * z);
      }
      const signed = dx * x + dy * y + dz * z;
      const overlap = ra + rb - Math.abs(signed);
      if (overlap <= 1e-7) { depth = 0; break; }
      if (overlap < depth) { depth = overlap; const direction = signed >= 0 ? 1.0 : -1.0; nx = x * direction; ny = y * direction; nz = z * direction; }
    }
    if (!(depth > 0) || !isFinite(depth)) continue;
    store<f64>(out, nx); store<f64>(out + 8, ny); store<f64>(out + 16, nz); store<f64>(out + 24, depth);
    if (terrain) {
      store<f64>(out + 32, load<f64>(b) + (Math.abs(nx) > 1e-6 ? load<f64>(b + 96) * Math.sign(nx) : 0));
      store<f64>(out + 40, load<f64>(b + 8) + (Math.abs(ny) > 1e-6 ? load<f64>(b + 104) * Math.sign(ny) : 0));
      store<f64>(out + 48, load<f64>(b + 16) + (Math.abs(nz) > 1e-6 ? load<f64>(b + 112) * Math.sign(nz) : 0));
    } else {
      support(a, nx, ny, nz, 1, SUPPORT); support(b, nx, ny, nz, -1, SUPPORT + 32);
      for (let k = 0; k < 3; k++) store<f64>(out + 32 + k * 8, (load<f64>(SUPPORT + k * 8) + load<f64>(SUPPORT + 32 + k * 8)) * 0.5);
      store<f64>(out + 56, load<f64>(SUPPORT + 24) >= 3 && load<f64>(SUPPORT + 56) >= 3 ? 1 : 0);
    }
  }
}
