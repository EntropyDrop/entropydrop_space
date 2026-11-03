import type { VoxelLodTile } from '../../engine/src/render/VoxelLodPlanner.ts';
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Preserve the 16-byte face ABI and every visibility float exactly. */
export function packDistantTile(tile: VoxelLodTile, reference = false): Buffer {
  if (!tile.visibility || tile.visibility.length !== Math.ceil(tile.count / 16) * 12)
    throw Error('Missing face visibility metadata');
  const data = Buffer.allocUnsafe(tile.count * 16 + tile.visibility.byteLength);
  const words = LITTLE_ENDIAN && !reference
    ? new Uint32Array(data.buffer, data.byteOffset, tile.count * 4) : undefined;
  for (let i = 0; i < tile.count; i++) {
    const a = (tile.offset[i*3] | tile.offset[i*3+1] << 16) >>> 0;
    const b = (tile.offset[i*3+2] | tile.span[i*2] << 16) >>> 0;
    const c = (tile.span[i*2+1] | tile.direction[i] << 16 | 3 << 19) >>> 0;
    const d = (((tile.emission[i] ? 2 : 1) << 24) | tile.color[i*3] << 16 | tile.color[i*3+1] << 8 | tile.color[i*3+2]) >>> 0;
    if (words) { words[i*4] = a; words[i*4+1] = b; words[i*4+2] = c; words[i*4+3] = d; }
    else { const at = i * 16; data.writeUInt32LE(a, at); data.writeUInt32LE(b, at+4);
      data.writeUInt32LE(c, at+8); data.writeUInt32LE(d, at+12); }
  }
  if (words) Buffer.from(tile.visibility.buffer, tile.visibility.byteOffset, tile.visibility.byteLength).copy(data, tile.count * 16);
  else for (let i = 0; i < tile.visibility.length; i++) data.writeFloatLE(tile.visibility[i], tile.count*16+i*4);
  return data;
}
