// Resident triangles and numeric Y/Z bucket lists. The host keeps texture
// decoding/sampling; these kernels handle occupancy and nearest geometry.
const BARY = memory.data<f64>([0, 0, 0]);

function bucket(ctx: usize, by: i32, bz: i32): usize {
  const y = by - load<i32>(ctx + 16), z = bz - load<i32>(ctx + 20);
  if (y < 0 || z < 0 || y >= load<i32>(ctx + 24) || z >= load<i32>(ctx + 28)) return 0;
  return usize(load<u32>(ctx + 4)) + usize(y * load<i32>(ctx + 28) + z) * 8;
}

function rayTriangle(t: usize, ox: f64, oy: f64, oz: f64): i32 {
  const ax = load<f64>(t) - ox, ay = load<f64>(t + 8) - oy, az = load<f64>(t + 16) - oz;
  const bx = load<f64>(t + 24) - ox, by = load<f64>(t + 32) - oy, bz = load<f64>(t + 40) - oz;
  const cx = load<f64>(t + 48) - ox, cy = load<f64>(t + 56) - oy, cz = load<f64>(t + 64) - oz;
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const det = e1y * (-e2z) + e1z * e2y;
  if (Math.abs(det) < 1e-12) return 0;
  const inv = 1 / det, tx = -ax, ty = -ay, tz = -az;
  const u = (ty * (-e2z) + tz * e2y) * inv;
  if (u < 0 || u > 1) return 0;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = qx * inv;
  if (v < 0 || u + v > 1) return 0;
  return (e2x * qx + e2y * qy + e2z * qz) * inv > 1e-9 ? 1 : 0;
}

function inside(ctx: usize, x: f64, y: f64, z: f64): bool {
  const size = load<f64>(ctx + 32);
  const list = bucket(ctx, i32(Math.floor(y / size)), i32(Math.floor(z / size)));
  if (!list) return false;
  const refs = usize(load<u32>(ctx + 8)), triangles = usize(load<u32>(ctx));
  const start = load<i32>(list), count = load<i32>(list + 4);
  let crossings = 0;
  for (let i = start; i < start + count; i++) {
    const t = triangles + usize(load<u32>(refs + i * 4)) * 72;
    if (Math.max(Math.max(load<f64>(t), load<f64>(t + 24)), load<f64>(t + 48)) <= x) continue;
    crossings += rayTriangle(t, x, y, z);
  }
  return crossings % 2 == 1;
}

function hash01(n: i32, salt: i32): f64 {
  let v = (n * 73856093) ^ (salt * 19349663);
  v = (v ^ i32(u32(v) >> 13)) * 1274126177;
  return 0.1 + 0.8 * (f64(u32(v ^ i32(u32(v) >> 16))) / 4294967296.0);
}

export function modelFill(ctx: usize, fallbackColor: i32): void {
  const sx = load<i32>(ctx + 40), sy = load<i32>(ctx + 44), sz = load<i32>(ctx + 48);
  const mx = load<i32>(ctx + 56), my = load<i32>(ctx + 60), mz = load<i32>(ctx + 64);
  const size = load<f64>(ctx + 72), jitter = size * 1e-3;
  const grid = usize(load<u32>(ctx + 80)), colors = usize(load<u32>(ctx + 88));
  for (let x = 0; x < sx; x++) for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) {
    const cell = (x * sy + y) * sz + z;
    if (load<u8>(grid + cell) == 1) continue;
    const wx = f64(x + mx) * size + size * 0.5;
    const wy = f64(y + my) * size + size * 0.5 + hash01(x, 1) * jitter;
    const wz = f64(z + mz) * size + size * 0.5 + hash01(z, 2) * jitter;
    if (inside(ctx, wx, wy, wz)) {
      store<u8>(grid + cell, 1);
      if (load<i32>(colors + cell * 4) < 0) store<i32>(colors + cell * 4, fallbackColor);
    }
  }
}

export function modelHollow(ctx: usize, hollow: bool): void {
  const sx = load<i32>(ctx + 40), sy = load<i32>(ctx + 44), sz = load<i32>(ctx + 48), stride = sy * sz;
  const grid = usize(load<u32>(ctx + 80)), output = usize(load<u32>(ctx + 84));
  if (!hollow) { memory.copy(output, grid, sx * stride); return; }
  memory.fill(output, 0, sx * stride);
  for (let x = 1; x < sx - 1; x++) for (let y = 1; y < sy - 1; y++) for (let z = 1; z < sz - 1; z++) {
    const cell = (x * sy + y) * sz + z;
    if (load<u8>(grid + cell) != 1) continue;
    if (!(load<u8>(grid + cell + stride) == 1 && load<u8>(grid + cell - stride) == 1
      && load<u8>(grid + cell + sz) == 1 && load<u8>(grid + cell - sz) == 1
      && load<u8>(grid + cell + 1) == 1 && load<u8>(grid + cell - 1) == 1)) store<u8>(output + cell, 1);
  }
}

function result(t: usize, px: f64, py: f64, pz: f64, u: f64, v: f64, w: f64): f64 {
  store<f64>(BARY, u); store<f64>(BARY + 8, v); store<f64>(BARY + 16, w);
  const qx = load<f64>(t) * u + load<f64>(t + 24) * v + load<f64>(t + 48) * w;
  const qy = load<f64>(t + 8) * u + load<f64>(t + 32) * v + load<f64>(t + 56) * w;
  const qz = load<f64>(t + 16) * u + load<f64>(t + 40) * v + load<f64>(t + 64) * w;
  return (px - qx) * (px - qx) + (py - qy) * (py - qy) + (pz - qz) * (pz - qz);
}

function closest(t: usize, px: f64, py: f64, pz: f64): f64 {
  const ax = load<f64>(t), ay = load<f64>(t + 8), az = load<f64>(t + 16);
  const bx = load<f64>(t + 24), by = load<f64>(t + 32), bz = load<f64>(t + 40);
  const cx = load<f64>(t + 48), cy = load<f64>(t + 56), cz = load<f64>(t + 64);
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return result(t, px, py, pz, 1, 0, 0);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return result(t, px, py, pz, 0, 1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return result(t, px, py, pz, 1 - v, v, 0); }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return result(t, px, py, pz, 0, 0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return result(t, px, py, pz, 1 - w, 0, w); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return result(t, px, py, pz, 0, 1 - w, w); }
  const denominator = va + vb + vc;
  if (Math.abs(denominator) < 1e-20) {
    const da = (px - ax) * (px - ax) + (py - ay) * (py - ay) + (pz - az) * (pz - az);
    const db = (px - bx) * (px - bx) + (py - by) * (py - by) + (pz - bz) * (pz - bz);
    const dc = (px - cx) * (px - cx) + (py - cy) * (py - cy) + (pz - cz) * (pz - cz);
    if (da <= db && da <= dc) return result(t, px, py, pz, 1, 0, 0);
    if (db <= dc) return result(t, px, py, pz, 0, 1, 0);
    return result(t, px, py, pz, 0, 0, 1);
  }
  const inverse = 1 / denominator, v = vb * inverse, w = vc * inverse;
  return result(t, px, py, pz, 1 - v - w, v, w);
}

// At most end-start records, each [cell, triangle, u, v, w].
export function modelNearest(ctx: usize, start: i32, end: i32, output: usize): i32 {
  const sx = load<i32>(ctx + 40), sy = load<i32>(ctx + 44), sz = load<i32>(ctx + 48), stride = sy * sz;
  const mx = load<i32>(ctx + 56), my = load<i32>(ctx + 60), mz = load<i32>(ctx + 64);
  const size = load<f64>(ctx + 72), bucketSize = load<f64>(ctx + 32);
  const grid = usize(load<u32>(ctx + 80)), effective = usize(load<u32>(ctx + 84));
  const triangles = usize(load<u32>(ctx)), refs = usize(load<u32>(ctx + 8)), visited = usize(load<u32>(ctx + 12));
  if (start == 0) memory.fill(visited, 0, load<u32>(ctx + 52) * 4);
  let count = 0;
  for (let cell = start; cell < end; cell++) {
    if (load<u8>(effective + cell) != 1) continue;
    const x = cell / stride, y = (cell / sz) % sy, z = cell % sz;
    if (!(x == 0 || x == sx - 1 || y == 0 || y == sy - 1 || z == 0 || z == sz - 1
      || load<u8>(grid + cell + stride) == 0 || load<u8>(grid + cell - stride) == 0
      || load<u8>(grid + cell + sz) == 0 || load<u8>(grid + cell - sz) == 0
      || load<u8>(grid + cell + 1) == 0 || load<u8>(grid + cell - 1) == 0)) continue;
    const px = f64(x + mx) * size + size * 0.5, py = f64(y + my) * size + size * 0.5, pz = f64(z + mz) * size + size * 0.5;
    const centerY = i32(Math.floor(py / bucketSize)), centerZ = i32(Math.floor(pz / bucketSize));
    let best = Infinity, bestTriangle = -1, u: f64 = 0, v: f64 = 0, w: f64 = 0;
    for (let by = centerY - 1; by <= centerY + 1; by++) for (let bz = centerZ - 1; bz <= centerZ + 1; bz++) {
      const list = bucket(ctx, by, bz);
      if (!list) continue;
      const first = load<i32>(list), length = load<i32>(list + 4);
      for (let i = first; i < first + length; i++) {
        const id = load<i32>(refs + i * 4);
        if (load<i32>(visited + id * 4) == cell + 1) continue;
        store<i32>(visited + id * 4, cell + 1);
        const distance = closest(triangles + usize(id) * 72, px, py, pz);
        if (distance < best) {
          best = distance; bestTriangle = id;
          u = load<f64>(BARY); v = load<f64>(BARY + 8); w = load<f64>(BARY + 16);
        }
      }
    }
    if (bestTriangle >= 0) {
      const out = output + usize(count++) * 40;
      store<f64>(out, cell); store<f64>(out + 8, bestTriangle);
      store<f64>(out + 16, u); store<f64>(out + 24, v); store<f64>(out + 32, w);
    }
  }
  return count;
}
