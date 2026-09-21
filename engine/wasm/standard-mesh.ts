const QUADS: usize = memory.data<u8>([
  0,1,1, 1,1,1, 1,1,0, 0,1,0,
  0,0,0, 1,0,0, 1,0,1, 0,0,1,
  1,1,0, 1,0,0, 0,0,0, 0,1,0,
  0,1,1, 0,0,1, 1,0,1, 1,1,1,
  0,1,0, 0,0,0, 0,0,1, 0,1,1,
  1,1,1, 1,0,1, 1,0,0, 1,1,0,
]);

export function standardFaces(blocks: usize, colors: usize, materials: usize, neighbors: usize,
  minY: i32, maxY: i32, faces: usize, table: usize, counts: usize): i32 {
  memory.fill(table, 0, 32768 * 16);
  let count = 0;
  const height = maxY - minY + 1;
  for (let y = minY; y <= maxY; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const index = (y * 16 + z) * 16 + x;
    if (load<u8>(blocks + index) == 0) continue;
    const color = load<u32>(colors + index * 4), material = load<u8>(materials + index);
    for (let face = 0; face < 6; face++) {
      const nx = x + (face == 4 ? -1 : face == 5 ? 1 : 0);
      const ny = y + (face == 1 ? -1 : face == 0 ? 1 : 0);
      const nz = z + (face == 2 ? -1 : face == 3 ? 1 : 0);
      let neighbor = 0;
      if (ny >= 0 && ny < 256) {
        if (nx >= 0 && nx < 16 && nz >= 0 && nz < 16) neighbor = load<u8>(blocks + (ny * 16 + nz) * 16 + nx);
        else neighbor = load<u16>(neighbors + ((face - 2) * height * 16 + (y - minY) * 16 + (face < 4 ? x : z)) * 2);
      }
      if ((neighbor & 255) != 0) continue;
      const cut = (neighbor & 256) != 0;
      if (cut && face >= 2) {
        // Match the reference's numeric run key and first-face output order.
        const key = u64((face * 16 + x) * 16 + z) * 0x1000000 + color + u64(material) * 0x100000000;
        let hash = u32(key) ^ u32(key >> 32);
        hash ^= hash >> 16; hash *= 0x7feb352d; hash ^= hash >> 15;
        let slot = hash & 32767;
        while (load<u32>(table + slot * 16 + 8) != 0 && load<u64>(table + slot * 16) != key) slot = (slot + 1) & 32767;
        const entry = table + slot * 16, old = load<u32>(entry + 8);
        if (old != 0) {
          const previous = faces + (old - 1) * 32;
          if (load<i32>(previous + 4) + load<i32>(previous + 28) == y) {
            store<i32>(previous + 28, load<i32>(previous + 28) + 1); continue;
          }
        }
        store<u64>(entry, key); store<u32>(entry + 8, count + 1);
      }
      const p = faces + count++ * 32;
      store<i32>(p, x); store<i32>(p + 4, y); store<i32>(p + 8, z); store<i32>(p + 12, face);
      store<i32>(p + 16, cut ? 1 : 0); store<u32>(p + 20, color); store<i32>(p + 24, material); store<i32>(p + 28, 1);
    }
  }
  memory.fill(counts, 0, 8);
  for (let i = 0; i < count; i++) {
    const material = load<i32>(faces + i * 32 + 24);
    if (material < 2) store<i32>(counts + material * 4, load<i32>(counts + material * 4) + 6);
  }
  return count;
}

export function standardMesh(faces: usize, faceCount: i32, vertexCount: i32,
  positions: usize, normals: usize, colors: usize, indices: usize, linear: usize): void {
  let written = 0;
  for (let material = 0; material < 2; material++) for (let i = 0; i < faceCount; i++) {
    const p = faces + i * 32;
    if (load<i32>(p + 24) != material) continue;
    const face = load<i32>(p + 12), color = load<u32>(p + 20);
    const shade: f64 = material == 1 || face == 0 || load<i32>(p + 16) != 0 ? 1 : face == 1 ? 0.6 : 0.85;
    for (let v = 0; v < 4; v++) for (let c = 0; c < 3; c++) {
      const offset = (written * 4 + v) * 3 + c;
      const vertex = load<u8>(QUADS + face * 12 + v * 3 + c);
      store<u16>(positions + offset * 2, load<i32>(p + c * 4) + vertex * (c == 1 ? load<i32>(p + 28) : 1));
      const normal = c == 0 ? (face == 4 ? -127 : face == 5 ? 127 : 0)
        : c == 1 ? (face == 1 ? -127 : face == 0 ? 127 : 0) : (face == 2 ? -127 : face == 3 ? 127 : 0);
      store<i8>(normals + offset, normal);
      const channel = (color >> ((2 - c) * 8)) & 255;
      store<u8>(colors + offset, i32(Math.floor(load<f64>(linear + channel * 8) * shade * 255 + 0.5)));
    }
    for (let k = 0; k < 6; k++) {
      const value = written * 4 + (k == 0 || k == 3 ? 0 : k == 1 ? 1 : k == 5 ? 3 : 2);
      if (vertexCount <= 65535) store<u16>(indices + (written * 6 + k) * 2, value);
      else store<u32>(indices + (written * 6 + k) * 4, value);
    }
    written++;
  }
}
