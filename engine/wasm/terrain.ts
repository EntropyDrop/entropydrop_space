// Allocation-free kernels. The host owns scratch memory from byte 65536 onward.
// Keep arithmetic in f64: voxel rounding and LOD tie-breaking are wire contracts.
export { microMesh } from './micro-mesh';
export { surfaceOwners, surfaceConnections } from './surface-connections';
export { surfaceSelect } from './surface-selection';
export { solidRuns, mergeSolidRuns } from './authored-solids';
export { standardFaces, standardMesh } from './standard-mesh';
export { collisionSamples } from './collision-samples';
const GRAD = memory.data<i8>([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

export function abiVersion(): i32 { return 1; }

function corner(p: usize, x: f64, y: f64, z: f64, i: i32, j: i32, k: i32): f64 {
  let t = 0.6 - x * x - y * y - z * z;
  if (t < 0) return 0;
  const g = GRAD + usize(load<u8>(p + i + load<u8>(p + j + load<u8>(p + k))) % 12) * 3;
  t *= t;
  return t * t * (f64(load<i8>(g)) * x + f64(load<i8>(g + 1)) * y + f64(load<i8>(g + 2)) * z);
}

function noise(p: usize, x: f64, y: f64, z: f64): f64 {
  const s = (x + y + z) * (1.0 / 3.0);
  const i = i32(Math.floor(x + s)), j = i32(Math.floor(y + s)), k = i32(Math.floor(z + s));
  const t = f64(i + j + k) * (1.0 / 6.0);
  const x0 = x - (f64(i) - t), y0 = y - (f64(j) - t), z0 = z - (f64(k) - t);
  let i1 = 0, j1 = 0, k1 = 0, i2 = 0, j2 = 0, k2 = 0;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; i2 = 1; j2 = 1; }
    else if (x0 >= z0) { i1 = 1; i2 = 1; k2 = 1; }
    else { k1 = 1; i2 = 1; k2 = 1; }
  } else {
    if (y0 < z0) { k1 = 1; j2 = 1; k2 = 1; }
    else if (x0 < z0) { j1 = 1; j2 = 1; k2 = 1; }
    else { j1 = 1; i2 = 1; j2 = 1; }
  }
  const ii = i & 255, jj = j & 255, kk = k & 255;
  return 32 * (corner(p, x0, y0, z0, ii, jj, kk)
    + corner(p, x0 - i1 + 1.0 / 6.0, y0 - j1 + 1.0 / 6.0, z0 - k1 + 1.0 / 6.0, ii + i1, jj + j1, kk + k1)
    + corner(p, x0 - i2 + 2.0 / 6.0, y0 - j2 + 2.0 / 6.0, z0 - k2 + 2.0 / 6.0, ii + i2, jj + j2, kk + k2)
    + corner(p, x0 - 1 + 3.0 / 6.0, y0 - 1 + 3.0 / 6.0, z0 - 1 + 3.0 / 6.0, ii + 1, jj + 1, kk + 1));
}

// Trigonometry is tabulated once per axis by the host, not four times per column.
// Both JS and Python use their existing libm, avoiding a terrain-version change.
export function natureHeights(p: usize, tx: usize, tz: usize, out: usize, axis: i32,
  ox: f64, oz: f64, width: f64, length: f64): void {
  const major = width / (2 * Math.PI), minor = length / (2 * Math.PI);
  for (let x = 0; x < axis; x++) for (let z = 0; z < axis; z++) {
    const radius = major + minor * load<f64>(tz + z * 16);
    const px = radius * load<f64>(tx + x * 16);
    const py = radius * load<f64>(tx + x * 16 + 8);
    const pz = minor * load<f64>(tz + z * 16 + 8);
    let h = Math.floor(16 + noise(p, px * 0.018, py * 0.018, pz * 0.018) * 3.4
      + noise(p, px * 0.052, py * 0.052, pz * 0.052) * 1.2 + 0.5);
    const dx = ox + x - width / 2, dz = oz + z - length / 2;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance < 26) {
      const blend = Math.max(0, Math.min(1, (distance - 10) / 16));
      h = Math.floor(16 * (1 - blend) + h * blend + 0.5);
    }
    store<u16>(out + (x * axis + z) * 2, u16(Math.max(11, Math.min(21, h))));
  }
}

export function natureSurface(heights: usize, out: usize, count: i32): void {
  for (let i = 0; i < count; i++) {
    const h = (load<u16>(heights + i * 2) + 1) * 8;
    store<u16>(out + i * 8, h); store<u16>(out + i * 8 + 2, h);
    store<u32>(out + i * 8 + 4, 0x00618f71);
  }
}

export function clearChunk(blocks: usize, colors: usize, defaultColor: u32): void {
  memory.fill(blocks, 0, 65536);
  for (let i = 0; i < 65536; i++) store<u32>(colors + i * 4, defaultColor);
}

export function fillNature(heights: usize, blocks: usize, colors: usize, defaultColor: u32): i32 {
  let maximum = 0;
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
    const h = i32(load<u16>(heights + (x * 16 + z) * 2));
    maximum = max(maximum, h);
    // Nature is capped at y=21. Write only that slab; the host has already reset
    // the remaining air. This avoids copying a mostly empty 256-metre chunk.
    for (let y = 0; y <= 21; y++) {
      const i = x + z * 16 + y * 256;
      store<u8>(blocks + i, y <= h ? 1 : 0);
      store<u32>(colors + i * 4, y > h ? defaultColor
        : y == h ? 0x718f61 : y >= h - 3 ? 0x806b5c : 0x66707d);
    }
  }
  return maximum;
}

// Solid ops: seven i32 values (clipped x0,y0,z0,x1,y1,z1,color), ordered paints.
export function paintBoxes(ops: usize, count: i32, blocks: usize, colors: usize): void {
  for (let op = 0; op < count; op++, ops += 28) {
    const x0 = load<i32>(ops), y0 = load<i32>(ops + 4), z0 = load<i32>(ops + 8);
    const x1 = load<i32>(ops + 12), y1 = load<i32>(ops + 16), z1 = load<i32>(ops + 20);
    const color = load<u32>(ops + 24);
    for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) {
      const start = y * 256 + z * 16;
      for (let x = x0; x < x1; x++) {
        store<u8>(blocks + start + x, color == 0 ? 0 : 1);
        store<u32>(colors + (start + x) * 4, color);
      }
    }
  }
}

// Micro ops retain their unclipped endpoints so clipping cannot create new shell
// faces at chunk borders. Output order and duplicate cells match the JS grammar.
export function paintMicro(ops: usize, count: i32, blocks: usize, out: usize): i32 {
  let cells = 0;
  for (let op = 0; op < count; op++, ops += 28) {
    const x0 = load<i32>(ops), y0 = load<i32>(ops + 4), z0 = load<i32>(ops + 8);
    const x1 = load<i32>(ops + 12), y1 = load<i32>(ops + 16), z1 = load<i32>(ops + 20);
    const color = load<u32>(ops + 24);
    for (let y = max(0, y0); y < min(2048, y1); y++)
      for (let z = max(0, z0); z < min(128, z1); z++)
        for (let x = max(0, x0); x < min(128, x1); x++) {
          if (x > x0 && x + 1 < x1 && y > y0 && y + 1 < y1 && z > z0 && z + 1 < z1) continue;
          if (load<u8>(blocks + (x >> 3) + (z >> 3) * 16 + (y >> 3) * 256) != 0) continue;
          const target = out + cells++ * 16;
          store<u32>(target, x); store<u32>(target + 4, y);
          store<u32>(target + 8, z); store<u32>(target + 12, color);
        }
  }
  return cells;
}

export function occupiedBounds(blocks: usize): i32 {
  let low = 256, high = -1;
  for (let y = 0; y < 256; y++) for (let i = 0; i < 256; i++) {
    if (load<u8>(blocks + y * 256 + i) == 0) continue;
    low = min(low, y); high = y; break;
  }
  return (low << 16) | (high + 1);
}

// Backend packed sRGB LOD: peak height (first on ties), minimum height,
// peak RGB and conservative accumulated byte colour error.
export function reduceSurfaceBytes(input: usize, output: usize, axis: i32): void {
  const next = axis / 2;
  for (let x = 0; x < next; x++) for (let z = 0; z < next; z++) {
    const start = input + (x * 2 * axis + z * 2) * 8;
    let peak = start, low: u16 = 65535;
    for (let dx = 0; dx < 2; dx++) for (let dz = 0; dz < 2; dz++) {
      const child = start + (dx * axis + dz) * 8;
      if (load<u16>(child) > load<u16>(peak)) peak = child;
      low = min(low, load<u16>(child + 2));
    }
    let error = 0;
    for (let dx = 0; dx < 2; dx++) for (let dz = 0; dz < 2; dz++) {
      const child = start + (dx * axis + dz) * 8;
      let delta = 0;
      for (let c = 4; c < 7; c++) delta = max(delta, abs(i32(load<u8>(child + c)) - i32(load<u8>(peak + c))));
      error = max(error, load<u8>(child + 7) + delta);
    }
    const target = output + (x * next + z) * 8;
    store<u64>(target, load<u64>(peak));
    store<u16>(target + 2, low); store<u8>(target + 7, min(255, error));
  }
}

// Frontend LOD uses linear RGB and float32 errors, preserving existing semantics.
export function surfaceBase(h: usize, c: usize, m: usize, e: usize, lookup: usize,
  oh: usize, oc: usize, om: usize, oe: usize, axis: i32, size: i32, legacy: i32): f64 {
  let residual: f64 = 0;
  for (let x = 0; x < axis; x++) for (let z = 0; z < axis; z++) {
    const i = x * axis + z;
    const source = legacy != 0 ? ((x / 8 * 32 + z / 8) * 8 + x % 8) * 8 + z % 8 : i;
    const height = load<u16>(h + source * 2);
    const low = m == 0 ? height : load<u16>(m + i * 2);
    const error = e == 0 ? f32(0) : f32(Math.min(1, f64(load<u8>(e + i)) / 255 * 2.4));
    store<u16>(oh + i * 2, height); store<u16>(om + i * 2, low);
    store<f32>(oe + i * 4, error);
    for (let channel = 0; channel < 3; channel++)
      store<u8>(oc + i * 3 + channel, load<u8>(lookup + load<u8>(c + source * 3 + channel)));
    residual = Math.max(residual, f64(i32(height) - i32(low)) * 0.125 + size * f64(error) * 0.25);
  }
  return residual;
}

export function reduceSurface(h: usize, c: usize, m: usize, e: usize,
  oh: usize, oc: usize, om: usize, oe: usize, axis: i32, size: i32): f64 {
  const next = axis / 2;
  let residual: f64 = 0;
  for (let x = 0; x < next; x++) for (let z = 0; z < next; z++) {
    const start = x * 2 * axis + z * 2;
    let peak = start, low: u16 = 65535;
    for (let dx = 0; dx < 2; dx++) for (let dz = 0; dz < 2; dz++) {
      const child = start + dx * axis + dz;
      if (load<u16>(h + child * 2) > load<u16>(h + peak * 2)) peak = child;
      low = min(low, load<u16>(m + child * 2));
    }
    let error: f64 = 0;
    for (let dx = 0; dx < 2; dx++) for (let dz = 0; dz < 2; dz++) {
      const child = start + dx * axis + dz;
      let delta = 0;
      for (let channel = 0; channel < 3; channel++)
        delta = max(delta, abs(i32(load<u8>(c + child * 3 + channel)) - i32(load<u8>(c + peak * 3 + channel))));
      error = Math.max(error, f64(load<f32>(e + child * 4)) + f64(delta) / 255);
    }
    const i = x * next + z, height = load<u16>(h + peak * 2);
    const storedError = f32(Math.min(1, error));
    store<u16>(oh + i * 2, height); store<u16>(om + i * 2, low);
    store<f32>(oe + i * 4, storedError);
    for (let channel = 0; channel < 3; channel++) store<u8>(oc + i * 3 + channel, load<u8>(c + peak * 3 + channel));
    residual = Math.max(residual, f64(i32(height) - i32(low)) * 0.125 + size * f64(storedError) * 0.25);
  }
  return residual;
}
