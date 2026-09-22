/** Packed standard cells and eighth-metre details in crop-local coordinates. */
export interface TerrainLabRegion {
  width: number;
  depth: number;
  height: number;
  voxels: Uint32Array;
  details: Uint32Array;
}

export function finishTerrainLabRegion(width: number, depth: number, height: number,
  cells: Uint16Array, palette: { color: number; emission: number }[], micros: Map<number, number>,
  colorAt: (id: number, x: number, y: number, z: number) => number): TerrainLabRegion {
  const layer = width * depth, voxels = new Uint32Array(cells.length), details: number[] = [];
  for (let y = 0; y < height; y++) for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
    const index = x + z * width + y * layer, id = cells[index];
    if (id) voxels[index] = (0x80000000 | colorAt(id, x, y, z) | (palette[id].emission > 0 ? 1 << 24 : 0)) >>> 0;
  }
  for (const [key, packed] of micros) {
    const mx = key % (width * 8), mz = Math.floor(key / (width * 8)) % (depth * 8), my = Math.floor(key / (layer * 64));
    if (!cells[(mx >> 3) + (mz >> 3) * width + (my >> 3) * layer]) details.push(mx, my, mz, packed);
  }
  return { width, depth, height, voxels, details: new Uint32Array(details) };
}

export function generatePaddedTerrainLabRegion<T extends { sizeX: number; sizeZ: number }>(config: T,
  includeDetails: boolean, generate: (config: T, includeDetails: boolean) => TerrainLabRegion, padding: number) {
  const width = Math.max(1, Math.floor(config.sizeX)), depth = Math.max(1, Math.floor(config.sizeZ));
  const padded = generate({ ...config, sizeX: width + padding * 2, sizeZ: depth + padding * 2 }, includeDetails);
  const voxels = new Uint32Array(width * depth * padded.height), details: number[] = [];
  for (let y = 0; y < padded.height; y++) for (let z = 0; z < depth; z++) {
    const offset = padding + (z + padding) * padded.width + y * padded.width * padded.depth;
    voxels.set(padded.voxels.subarray(offset, offset + width), z * width + y * width * depth);
  }
  for (let i = 0; i < padded.details.length; i += 4) {
    const x = padded.details[i] - padding * 8, z = padded.details[i + 2] - padding * 8;
    if (x >= 0 && z >= 0 && x < width * 8 && z < depth * 8)
      details.push(x, padded.details[i + 1], z, padded.details[i + 3]);
  }
  return { width, depth, height: padded.height, voxels, details: new Uint32Array(details) };
}
