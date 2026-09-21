// Halo layout: x-fastest, then z, then y; token 0 is air, otherwise
// 1 + sRGB + material * 2^24. A partition is at most 16^3 cells.
function sample(halo: usize, x: i32, y: i32, z: i32): i32 {
  return load<i32>(halo + ((y + 1) * 324 + (z + 1) * 18 + x + 1) * 4);
}

export function microMesh(halo: usize, height: i32, minY: i32, mask: usize, quads: usize,
  positions: usize, normals: usize, colors: usize, indices: usize, linear: usize, counts: usize): i32 {
  let count = 0;
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const width = u == 1 ? height : 16, rows = v == 1 ? height : 16;
    const depth = axis == 1 ? height : 16;
    for (let slice = -1; slice < depth; slice++) {
      for (let j = 0; j < rows; j++) for (let i = 0; i < width; i++) {
        const x = axis == 0 ? slice : u == 0 ? i : j;
        const y = axis == 1 ? slice : u == 1 ? i : j;
        const z = axis == 2 ? slice : u == 2 ? i : j;
        const a = sample(halo, x, y, z);
        const b = sample(halo, x + (axis == 0 ? 1 : 0), y + (axis == 1 ? 1 : 0), z + (axis == 2 ? 1 : 0));
        store<i32>(mask + (j * width + i) * 4, a != 0 && b == 0 && slice >= 0 ? a
          : a == 0 && b != 0 && slice + 1 < depth ? -b : 0);
      }
      for (let index = 0; index < width * rows;) {
        const value = load<i32>(mask + index * 4);
        if (value == 0) { index++; continue; }
        const i = index % width, j = index / width;
        let w = 1, h = 1;
        while (i + w < width && load<i32>(mask + (index + w) * 4) == value) w++;
        while (j + h < rows) {
          let matches = true;
          for (let k = 0; k < w; k++) if (load<i32>(mask + (index + h * width + k) * 4) != value) { matches = false; break; }
          if (!matches) break;
          h++;
        }
        const q = quads + count++ * 32;
        store<i32>(q, axis == 0 ? slice + 1 : u == 0 ? i : j);
        store<i32>(q + 4, axis == 1 ? slice + 1 : u == 1 ? i : j);
        store<i32>(q + 8, axis == 2 ? slice + 1 : u == 2 ? i : j);
        store<i32>(q + 12, axis); store<i32>(q + 16, w); store<i32>(q + 20, h);
        store<i32>(q + 24, value > 0 ? 1 : 0); store<i32>(q + 28, abs(value) - 1);
        for (let row = 0; row < h; row++) memory.fill(mask + (index + row * width) * 4, 0, w * 4);
        index += w;
      }
    }
  }
  let written = 0;
  for (let material = 0; material < 2; material++) {
    const start = written;
    for (let i = 0; i < count; i++) {
      const q = quads + i * 32, token = load<u32>(q + 28);
      if (i32(token >> 24) != material) continue;
      const axis = load<i32>(q + 12), u = (axis + 1) % 3, v = (axis + 2) % 3;
      const positive = load<i32>(q + 24) != 0;
      const shade: f64 = material == 1 ? 1 : axis == 1 ? (positive ? 1 : 0.6) : 0.85;
      const r = i32(Math.floor(load<f64>(linear + ((token >> 16) & 255) * 8) * shade * 255 + 0.5));
      const g = i32(Math.floor(load<f64>(linear + ((token >> 8) & 255) * 8) * shade * 255 + 0.5));
      const b = i32(Math.floor(load<f64>(linear + (token & 255) * 8) * shade * 255 + 0.5));
      for (let vertex = 0; vertex < 4; vertex++) {
        const alongU = positive ? (vertex == 1 || vertex == 2 ? 1 : 0) : (vertex >= 2 ? 1 : 0);
        const alongV = positive ? (vertex >= 2 ? 1 : 0) : (vertex == 1 || vertex == 2 ? 1 : 0);
        const offset = (written * 4 + vertex) * 3;
        for (let channel = 0; channel < 3; channel++) {
          const position = load<i32>(q + channel * 4) + (channel == 1 ? minY : 0)
            + (channel == u ? load<i32>(q + 16) * alongU : 0) + (channel == v ? load<i32>(q + 20) * alongV : 0);
          store<u16>(positions + (offset + channel) * 2, position);
          store<i8>(normals + offset + channel, channel == axis ? (positive ? 127 : -127) : 0);
          store<u8>(colors + offset + channel, channel == 0 ? r : channel == 1 ? g : b);
        }
      }
      for (let k = 0; k < 6; k++) {
        const value = written * 4 + (k == 0 || k == 3 ? 0 : k == 1 ? 1 : k == 5 ? 3 : 2);
        if (count * 4 <= 65535) store<u16>(indices + (written * 6 + k) * 2, value);
        else store<u32>(indices + (written * 6 + k) * 4, value);
      }
      written++;
    }
    store<u32>(counts + material * 4, (written - start) * 6);
  }
  return written;
}
