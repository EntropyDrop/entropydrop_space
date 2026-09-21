// Exact seven-u32 authored boxes: x,y,z,width,height,depth,sRGB.
export function solidRuns(heights: usize, procedural: usize, edits: usize, editCount: i32,
  micro: usize, microCount: i32, output: usize, columns: usize): i32 {
  // Store color+1; zero is air. Standard block ids other than 1 are not distant solids.
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
    const base = i32(load<u16>(heights + (x * 16 + z) * 2));
    for (let y = 0; y < 256; y++) {
      const index = (y * 16 + z) * 16 + x;
      let value: u32 = 0;
      if (procedural != 0) {
        const p = procedural + index * 4;
        if (load<u8>(p) == 1) value = (u32(load<u8>(p + 1)) << 16 | u32(load<u8>(p + 2)) << 8 | load<u8>(p + 3)) + 1;
      } else if (y <= base) value = (y == base ? 0x718f61 : y >= base - 3 ? 0x806b5c : 0x66707d) + 1;
      store<u32>(columns + index * 4, value);
    }
  }
  for (let i = 0; i < editCount; i++) {
    const p = edits + i * 20;
    const x = load<i32>(p), y = load<i32>(p + 4), z = load<i32>(p + 8);
    if (x < 0 || x >= 16 || y < 0 || y >= 256 || z < 0 || z >= 16) continue;
    store<u32>(columns + ((y * 16 + z) * 16 + x) * 4, load<i32>(p + 12) == 1 ? load<u32>(p + 16) + 1 : 0);
  }
  let count = 0;
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
    let previous: u32 = 0, start = 0;
    for (let y = 0; y <= 256; y++) {
      const value = y < 256 ? load<u32>(columns + ((y * 16 + z) * 16 + x) * 4) : 0;
      if (value == previous) continue;
      if (previous != 0) {
        const p = output + count++ * 28;
        store<u32>(p, x * 8); store<u32>(p + 4, start * 8); store<u32>(p + 8, z * 8);
        store<u32>(p + 12, 8); store<u32>(p + 16, (y - start) * 8); store<u32>(p + 20, 8); store<u32>(p + 24, previous - 1);
      }
      previous = value; start = y;
    }
  }
  memory.copy(output + count * 28, micro, microCount * 28);
  return count + microCount;
}

function sameGroup(a: usize, b: usize, axis: i32): bool {
  for (let field = 0; field < 7; field++) {
    if (field != axis && field != axis + 3 && load<u32>(a + field * 4) != load<u32>(b + field * 4)) return false;
  }
  return true;
}

// Group IDs follow first appearance, and sorting is stable within each group.
// This preserves Python dict/sorted order as well as the exact encoded solids.
export function mergeSolidRuns(input: usize, count: i32, axis: i32, output: usize,
  table: usize, tableMask: u32, groups: usize, indices: usize, temporary: usize): i32 {
  memory.fill(table, 0, (tableMask + 1) * 4);
  for (let i = 0; i < count; i++) {
    const box = input + i * 28;
    let hash: u32 = 2166136261;
    for (let f = 0; f < 7; f++) if (f != axis && f != axis + 3) { hash ^= load<u32>(box + f * 4); hash *= 16777619; }
    hash ^= hash >> 16;
    let slot = hash & tableMask;
    while (load<u32>(table + slot * 4) != 0 && !sameGroup(box, input + (load<u32>(table + slot * 4) - 1) * 28, axis)) slot = (slot + 1) & tableMask;
    if (load<u32>(table + slot * 4) == 0) store<u32>(table + slot * 4, i + 1);
    store<u32>(groups + i * 4, load<u32>(table + slot * 4) - 1);
    store<i32>(indices + i * 4, i);
  }
  for (let width = 1; width < count; width *= 2) {
    for (let start = 0; start < count; start += width * 2) {
      const middle = min(start + width, count), end = min(start + width * 2, count);
      let a = start, b = middle;
      for (let out = start; out < end; out++) {
        let takeA = b >= end;
        if (a < middle && b < end) {
          const ia = load<i32>(indices + a * 4), ib = load<i32>(indices + b * 4);
          const ga = load<i32>(groups + ia * 4), gb = load<i32>(groups + ib * 4);
          takeA = ga < gb || (ga == gb && load<u32>(input + ia * 28 + axis * 4) <= load<u32>(input + ib * 28 + axis * 4));
        }
        const index = takeA ? a++ : b++;
        store<i32>(temporary + out * 4, load<i32>(indices + index * 4));
      }
    }
    const swap = indices; indices = temporary; temporary = swap;
  }
  let written = 0, lastGroup = -1;
  for (let i = 0; i < count; i++) {
    const index = load<i32>(indices + i * 4), group = load<i32>(groups + index * 4);
    const box = input + index * 28, current = output + (written - 1) * 28;
    const size = (axis + 3) * 4, coordinate = axis * 4;
    if (written > 0 && group == lastGroup
      && load<u32>(current + coordinate) + load<u32>(current + size) == load<u32>(box + coordinate)
      && load<u32>(current + size) + load<u32>(box + size) <= 16) {
      store<u32>(current + size, load<u32>(current + size) + load<u32>(box + size));
    } else { memory.copy(output + written++ * 28, box, 28); }
    lastGroup = group;
  }
  return written;
}
