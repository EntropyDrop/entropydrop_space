// Minimal PNG decoder (8-bit RGB/RGBA, no interlace) using Node's zlib.
// Usage: import { decodePng } from './png-decode.mjs'
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

export function decodePng(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png: ' + file);
  let offset = 8;
  let width = 0, height = 0;
  let bitDepth = 0, colorType = 0;
  const idat = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('only 8-bit png supported');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('unsupported color type ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
  };
  let row = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const lineStart = y * (stride + 1) + 1;
    const prevRowStart = y > 0 ? (y - 1) * stride : 0;
    for (let x = 0; x < stride; x++) {
      const v = raw[lineStart + x];
      const a = x >= channels ? out[row + x - channels] : 0;
      const b = y > 0 ? out[prevRowStart + x] : 0;
      const c = (x >= channels && y > 0) ? out[prevRowStart + x - channels] : 0;
      let pv;
      switch (filter) {
        case 0: pv = v; break;
        case 1: pv = v + a; break;
        case 2: pv = v + b; break;
        case 3: pv = v + ((a + b) >> 1); break;
        case 4: pv = v + paeth(a, b, c); break;
        default: throw new Error('bad filter ' + filter);
      }
      out[row + x] = pv & 0xff;
    }
    row += stride;
  }
  return { width, height, channels, data: out };
}
