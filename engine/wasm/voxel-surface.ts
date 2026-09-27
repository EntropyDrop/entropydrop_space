// Volumetric LOD uses x-fastest 64^3 bricks stacked in a 64x256x64 column.
// Zero is air; bit 31 marks occupancy, bit 24 emission, and bits 0..23 sRGB.
export function voxelColumnChunk(column: usize, blocks: usize, colors: usize, materials: usize,
  ox: i32, oz: i32, top: i32): i32 {
  let occupied = 0;
  for (let y = 0; y <= top; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const source = x + z * 16 + y * 256;
    if (load<u8>(blocks + source) == 0) continue;
    const brick = y >> 6;
    const target = brick * 262144 + ox + x + (y & 63) * 64 + (oz + z) * 4096;
    store<u32>(column + target * 4, 0x80000000 | load<u32>(colors + source * 4)
      | (u32(load<u8>(materials + source)) << 24));
    occupied |= 1 << brick;
  }
  return occupied;
}

export function voxelColumnMicro(column: usize, micro: usize, count: i32, ox: i32, oz: i32): i32 {
  let occupied = 0;
  for (let i = 0; i < count; i++, micro += 16) {
    const mx = load<u32>(micro), my = load<u32>(micro + 4), mz = load<u32>(micro + 8);
    if (mx >= 128 || my >= 2048 || mz >= 128) return -1;
    const y = i32(my >> 3), brick = y >> 6;
    const target = column + (brick * 262144 + ox + i32(mx >> 3) + (y & 63) * 64
      + (oz + i32(mz >> 3)) * 4096) * 4;
    // Solids win; the first micro ornament in an empty 1m cell is stable.
    if (load<u32>(target) == 0) store<u32>(target, 0x80000000 | load<u32>(micro + 12));
    occupied |= 1 << brick;
  }
  return occupied;
}

export function voxelColumnRecords(column: usize, output: usize, occupied: i32): void {
  for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) {
    let high = -1, low = 256;
    let color: u32 = 0;
    for (let brick = 0; brick < 4; brick++) {
      if ((occupied & (1 << brick)) == 0) continue;
      const base = column + (brick * 262144 + x + z * 4096) * 4;
      for (let y = 0; y < 64; y++) {
        const value = load<u32>(base + y * 256);
        if (value != 0) { high = brick * 64 + y; low = min(low, high); color = value; }
      }
    }
    const at = output + (x * 64 + z) * 8;
    store<u16>(at, (high + 1) * 8);
    store<u16>(at + 2, high < 0 ? 0 : low * 8);
    store<u8>(at + 4, color >> 16); store<u8>(at + 5, color >> 8);
    store<u8>(at + 6, color); store<u8>(at + 7, 0);
  }
}

export function reduceVoxelBrick(data: usize, axis: i32, output: usize): void {
  const n = axis / 2;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let count = 0, red = 0, green = 0, blue = 0, emissive = 0;
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const value = load<u32>(data + (x * 2 + dx + (y * 2 + dy) * axis + (z * 2 + dz) * axis * axis) * 4);
      if (value == 0) continue;
      count++; red += i32(value >> 16 & 255); green += i32(value >> 8 & 255); blue += i32(value & 255);
      emissive += i32(value >> 24 & 1);
    }
    // Positive integer ratios match Math.round, including half ties.
    const value = count == 0 ? 0 : 0x80000000 | (emissive * 2 >= count ? 1 << 24 : 0)
      | ((red * 2 + count) / (count * 2)) << 16
      | ((green * 2 + count) / (count * 2)) << 8 | ((blue * 2 + count) / (count * 2));
    store<u32>(output + (x + y * n + z * n * n) * 4, value);
  }
}

// Write the existing 16-byte wire faces directly, in JS traversal order.
export function meshVoxelBrick(data: usize, axis: i32, size: i32, ox: i32, oy: i32, oz: i32,
  mask: usize, output: usize, capacity: i32): i32 {
  let count = 0;
  const limit = max(1, 8 / size);
  for (let dim = 0; dim < 3; dim++) {
    const u = (dim + 1) % 3;
    const stride = dim == 0 ? 1 : dim == 1 ? axis : axis * axis;
    const strideU = dim == 0 ? axis : dim == 1 ? axis * axis : 1;
    const strideV = dim == 0 ? axis * axis : dim == 1 ? 1 : axis;
    for (let positive = 0; positive < 2; positive++) for (let plane = 0; plane < axis; plane++) {
      for (let j = 0; j < axis; j++) for (let i = 0; i < axis; i++) {
        const index = plane * stride + i * strideU + j * strideV;
        const value = load<u32>(data + index * 4), neighbour = plane + (positive != 0 ? 1 : -1);
        const visible = value != 0 && (neighbour < 0 || neighbour >= axis
          || load<u32>(data + (index + (positive != 0 ? stride : -stride)) * 4) == 0);
        store<u32>(mask + (i + j * axis) * 4, visible ? value : 0);
      }
      for (let j = 0; j < axis; j++) for (let i = 0; i < axis;) {
        const value = load<u32>(mask + (i + j * axis) * 4);
        if (value == 0) { i++; continue; }
        let width = 1, height = 1;
        while (width < limit && i + width < axis && load<u32>(mask + (i + width + j * axis) * 4) == value) width++;
        while (height < limit && j + height < axis) {
          let matches = true;
          for (let k = 0; k < width; k++) {
            if (load<u32>(mask + (i + k + (j + height) * axis) * 4) != value) { matches = false; break; }
          }
          if (!matches) break;
          height++;
        }
        if (count >= capacity) return -1;
        const at = output + count++ * 16;
        store<u16>(at, (ox + (dim == 0 ? plane + positive : u == 0 ? i : j) * size) * 8);
        store<u16>(at + 2, (oy + (dim == 1 ? plane + positive : u == 1 ? i : j) * size) * 8);
        store<u16>(at + 4, (oz + (dim == 2 ? plane + positive : u == 2 ? i : j) * size) * 8);
        store<u16>(at + 6, width * size * 8); store<u16>(at + 8, height * size * 8);
        store<u8>(at + 10, dim * 2 + positive); store<u8>(at + 11, value >> 24 & 1);
        store<u8>(at + 12, value >> 16); store<u8>(at + 13, value >> 8);
        store<u8>(at + 14, value); store<u8>(at + 15, 0);
        for (let y = 0; y < height; y++) memory.fill(mask + (i + (j + y) * axis) * 4, 0, width * 4);
        i += width;
      }
    }
  }
  return count;
}
