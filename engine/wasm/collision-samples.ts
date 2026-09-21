// Match Vector3.sub(pivot).applyMatrix4(matrix), including its homogeneous divide.
// The matrix table is 20 f64s per owner: matrix[16], pivot[3], enabled[1].
export function collisionSamples(points: usize, owners: usize, count: i32, matrices: usize, output: usize): i32 {
  let written = 0;
  for (let i = 0; i < count; i++) {
    const matrix = matrices + load<u32>(owners + i * 4) * 160;
    if (load<f64>(matrix + 152) == 0) continue;
    const x = load<f64>(points + i * 24) - load<f64>(matrix + 128);
    const y = load<f64>(points + i * 24 + 8) - load<f64>(matrix + 136);
    const z = load<f64>(points + i * 24 + 16) - load<f64>(matrix + 144);
    const w = 1 / (load<f64>(matrix + 24) * x + load<f64>(matrix + 56) * y + load<f64>(matrix + 88) * z + load<f64>(matrix + 120));
    for (let c = 0; c < 3; c++) {
      const value = (load<f64>(matrix + c * 8) * x + load<f64>(matrix + (c + 4) * 8) * y
        + load<f64>(matrix + (c + 8) * 8) * z + load<f64>(matrix + (c + 12) * 8)) * w;
      store<f64>(output + written * 24 + c * 8, value);
    }
    written++;
  }
  return written;
}
