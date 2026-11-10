/** Convert the mesher's original paired triangles to four perimeter edges.
 * Keep vertex IDs intact: packed far shaders decode face/corner from them. */
export function quadPerimeterIndices(source: ArrayLike<number>): Uint32Array {
  if (source.length % 6) throw Error('Terrain is not a sequence of paired triangles');
  const result = new Uint32Array(source.length / 6 * 8);
  for (let i = 0, out = 0; i < source.length; i += 6, out += 8) {
    const a = source[i], b = source[i + 1], c = source[i + 2], d = source[i + 5];
    if (source[i + 3] !== a || source[i + 4] !== c || a === b || a === c || a === d || b === c || b === d || c === d)
      throw Error(`Unexpected terrain quad at index ${i}`);
    result.set([a, b, b, c, c, d, d, a], out);
  }
  return result;
}
