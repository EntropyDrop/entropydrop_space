// Numeric owner table, isolated per rebuild. Coordinates and sizes are integral,
// periodic, and power-of-two aligned. A zero key denotes an empty hash slot.
function keyAt(x: i32, z: i32, size: i32): u32 {
  const level = i32(ctz<u32>(size));
  return u32(level * 33554432 + ((x & 16383) & -size) * 2048 + ((z & 2047) & -size)) + 1;
}

function slot(table: usize, mask: u32, key: u32): usize {
  let hash = key;
  hash ^= hash >> 16; hash *= 0x7feb352d;
  hash ^= hash >> 15; hash *= 0x846ca68b; hash ^= hash >> 16;
  let index = hash & mask;
  while (true) {
    const p = table + index * 8, found = load<u32>(p);
    if (found == 0 || found == key) return p;
    index = (index + 1) & mask;
  }
  return 0;
}

export function surfaceOwners(table: usize, mask: u32, cells: usize, count: i32): void {
  for (let i = 0; i < count; i++) {
    const cell = cells + i * 16;
    const key = keyAt(load<i32>(cell), load<i32>(cell + 4), load<i32>(cell + 8));
    const p = slot(table, mask, key);
    store<u32>(p, key); store<i32>(p + 4, load<i32>(cell + 12));
  }
}

function owner(table: usize, mask: u32, x: i32, z: i32, preferred: i32): usize {
  let p = slot(table, mask, keyAt(x, z, preferred));
  if (load<u32>(p) != 0) return p;
  for (let size = 1; size <= 64; size *= 2) {
    if (size == preferred) continue;
    p = slot(table, mask, keyAt(x, z, size));
    if (load<u32>(p) != 0) return p;
  }
  return 0;
}

export function surfaceConnections(table: usize, mask: u32, detail: usize,
  cells: usize, count: i32, output: usize): i32 {
  let written = 0;
  for (let i = 0; i < count; i++) {
    const c = cells + i * 16;
    const x = load<i32>(c), z = load<i32>(c + 4), size = load<i32>(c + 8), height = load<i32>(c + 12);
    let boundary = false;
    for (let cx = (x >> 4) - 1; cx <= ((x + size - 1) >> 4) + 1; cx++) {
      for (let cz = (z >> 4) - 1; cz <= ((z + size - 1) >> 4) + 1; cz++) {
        if (load<u8>(detail + (cz & 127) * 1024 + (cx & 1023)) != 0) boundary = true;
      }
    }
    for (let edge = 0; edge < 4; edge++) {
      let runStart = -1, runBottom = -1;
      for (let offset = 0; offset <= size; offset++) {
        const nx = edge == 0 ? x - 1 : edge == 1 ? x + size : x + offset;
        const nz = edge == 2 ? z - 1 : edge == 3 ? z + size : z + offset;
        const neighbor = offset < size ? owner(table, mask, nx, nz, size) : 0;
        const neighborHeight = neighbor ? load<i32>(neighbor + 4) : 0;
        let bottom = neighbor && height > neighborHeight ? neighborHeight : -1;
        if (neighbor) {
          const key = load<u32>(neighbor) - 1;
          const neighborSize = 1 << (key >> 25);
          if (size < neighborSize) {
            const rho = Math.max(1, 2048 / (Math.PI * 2) + height * 0.125 - 16);
            const angle = f64(neighborSize) / (2048 / (Math.PI * 2));
            const skirt = i32(Math.ceil((rho * (angle * angle) / 8 * 1.2 + 0.125) / 0.125));
            bottom = max(0, min(neighborHeight, height - skirt));
          }
          const origin = key & 33554431;
          if (offset < size && (boundary || (origin >> 20) != u32(x >> 9) || ((origin & 2047) >> 9) != u32(z >> 9))) bottom = 0;
        } else if (offset < size) bottom = 0;
        if (bottom >= 0 && bottom == runBottom) {
          if (runStart < 0) runStart = offset;
          continue;
        }
        if (runStart >= 0) {
          const p = output + written++ * 32;
          store<i32>(p, i);
          store<i32>(p + 4, edge < 2 ? x + (edge == 1 ? size : 0) : x + runStart);
          store<i32>(p + 8, edge >= 2 ? z + (edge == 3 ? size : 0) : z + runStart);
          store<i32>(p + 12, offset - runStart); store<i32>(p + 16, runBottom);
          store<i32>(p + 20, edge < 2 ? 1 : 0);
          store<i32>(p + 24, edge == 0 ? -1 : edge == 1 ? 1 : 0);
          store<i32>(p + 28, edge == 2 ? -1 : edge == 3 ? 1 : 0);
        }
        runBottom = bottom; runStart = bottom >= 0 ? offset : -1;
      }
    }
  }
  return written;
}
