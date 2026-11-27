// Halo layout: x-fastest, then z, then y; token 0 is air, otherwise
// 1 + sRGB + material * 2^24 (u32, up to material 201 -> 0xCA000000).
// mask holds 256 u32 tokens followed by 256 u8 face-direction flags (1 = +axis, 0 = -axis).
@inline function isTranslucent(id: i32): bool { return id >= 2 && id <= 101; }
@inline function isEmissive(id: i32): bool { return id == 1 || (id >= 102 && id <= 201); }
@inline function materialBucket(id: i32): i32 { return isEmissive(id) ? 1 : isTranslucent(id) ? 2 : 0; }
@inline function materialAlpha(id: i32): u8 {
  if (isTranslucent(id)) return u8(101 - id);
  if (id == 1) return 50;
  if (id >= 102 && id <= 201) return u8(id - 101);
  return 255;
}

function sample(halo: usize, x: i32, y: i32, z: i32): u32 {
  return load<u32>(halo + ((y + 1) * 324 + (z + 1) * 18 + x + 1) * 4);
}

export function microMesh(halo: usize, height: i32, minY: i32, mask: usize, quads: usize,
  positions: usize, normals: usize, colors: usize, indices: usize, linear: usize, counts: usize): i32 {
  const maskDir = mask + 1024;
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
        const cell = j * width + i;
        const aMat = a != 0 ? i32((a - 1) >> 24) : 0;
        const bMat = b != 0 ? i32((b - 1) >> 24) : 0;
        if (a != 0 && (b == 0 || (isTranslucent(bMat) && !isTranslucent(aMat))) && slice >= 0) {
          store<u32>(mask + cell * 4, a);
          store<u8>(maskDir + cell, 1);
        } else if (b != 0 && (a == 0 || (isTranslucent(aMat) && !isTranslucent(bMat))) && slice + 1 < depth) {
          store<u32>(mask + cell * 4, b);
          store<u8>(maskDir + cell, 0);
        } else {
          store<u32>(mask + cell * 4, 0);
          store<u8>(maskDir + cell, 0);
        }
      }
      for (let index = 0; index < width * rows;) {
        const value = load<u32>(mask + index * 4);
        if (value == 0) { index++; continue; }
        const dir = load<u8>(maskDir + index);
        const i = index % width, j = index / width;
        let w = 1, h = 1;
        while (i + w < width && load<u32>(mask + (index + w) * 4) == value && load<u8>(maskDir + index + w) == dir) w++;
        while (j + h < rows) {
          let matches = true;
          for (let k = 0; k < w; k++) {
            const at = index + h * width + k;
            if (load<u32>(mask + at * 4) != value || load<u8>(maskDir + at) != dir) { matches = false; break; }
          }
          if (!matches) break;
          h++;
        }
        const q = quads + count++ * 32;
        store<i32>(q, axis == 0 ? slice + 1 : u == 0 ? i : j);
        store<i32>(q + 4, axis == 1 ? slice + 1 : u == 1 ? i : j);
        store<i32>(q + 8, axis == 2 ? slice + 1 : u == 2 ? i : j);
        store<i32>(q + 12, axis); store<i32>(q + 16, w); store<i32>(q + 20, h);
        store<i32>(q + 24, i32(dir)); store<u32>(q + 28, value - 1);
        for (let row = 0; row < h; row++) memory.fill(mask + (index + row * width) * 4, 0, w * 4);
        index += w;
      }
    }
  }
  let written = 0;
  for (let material = 0; material < 3; material++) {
    const start = written;
    for (let i = 0; i < count; i++) {
      const q = quads + i * 32, token = load<u32>(q + 28);
      const id = i32(token >> 24);
      if (materialBucket(id) != material) continue;
      const axis = load<i32>(q + 12), u = (axis + 1) % 3, v = (axis + 2) % 3;
      const positive = load<i32>(q + 24) != 0;
      const shade: f64 = material == 1 ? 1 : axis == 1 ? (positive ? 1 : 0.6) : 0.85;
      const r = material == 1 ? i32((token >> 16) & 255)
        : i32(Math.floor(load<f64>(linear + ((token >> 16) & 255) * 8) * shade * 255 + 0.5));
      const g = material == 1 ? i32((token >> 8) & 255)
        : i32(Math.floor(load<f64>(linear + ((token >> 8) & 255) * 8) * shade * 255 + 0.5));
      const b = material == 1 ? i32(token & 255)
        : i32(Math.floor(load<f64>(linear + (token & 255) * 8) * shade * 255 + 0.5));
      for (let vertex = 0; vertex < 4; vertex++) {
        const alongU = positive ? (vertex == 1 || vertex == 2 ? 1 : 0) : (vertex >= 2 ? 1 : 0);
        const alongV = positive ? (vertex >= 2 ? 1 : 0) : (vertex == 1 || vertex == 2 ? 1 : 0);
        const offset = (written * 4 + vertex) * 3;
        for (let channel = 0; channel < 3; channel++) {
          const position = load<i32>(q + channel * 4) + (channel == 1 ? minY : 0)
            + (channel == u ? load<i32>(q + 16) * alongU : 0) + (channel == v ? load<i32>(q + 20) * alongV : 0);
          store<u16>(positions + (offset + channel) * 2, position);
          store<i8>(normals + offset + channel, channel == axis ? (positive ? 127 : -127) : 0);
          store<u8>(colors + (written * 4 + vertex) * 4 + channel, channel == 0 ? r : channel == 1 ? g : b);
        }
      }
      const alpha = materialAlpha(id);
      for (let vertex = 0; vertex < 4; vertex++) store<u8>(colors + (written * 4 + vertex) * 4 + 3, alpha);
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
