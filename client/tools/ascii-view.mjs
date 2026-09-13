// Render a probe grid JSON as ASCII art (2x1 cells for aspect).
// Usage: node tools/ascii-view.mjs <probe.json> [label]
import { readFileSync } from 'node:fs';
import process from 'node:process';

const file = process.argv[2];
const label = process.argv[3] || '';
const out = JSON.parse(readFileSync(file, 'utf8'));

const chars = ' .:-=+*#%@';
const skyChars = '░▒▓█'; // for sky-ish blues

function classify(r, g, b) {
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (b - r > 40 && b > 120 && b >= g) return 'SKY';
  if (g - r > 12 && g - b > 12) return 'GRN';
  if (lum < 24) return 'BLK';
  return 'LUM';
}

// If this is a focus dump (has .codes with 4-bit channels), render it.
if (out.codes) {
  const rows = out.codes;
  console.log(`== ${label} focus region fx=${out.fx} fy=${out.fy} w=${out.fw} h=${out.fh} scale=${out.scale} (image-top first) ==`);
  const quant = (v) => ' .:-=+*#%@'[Math.min(9, Math.floor(v / 16))];
  for (const row of rows) {
    let line = '';
    for (const code of row) {
      const r = (code >> 10) & 0x1f, g = (code >> 5) & 0x1f, b = code & 0x1f;
      const R = r * 16, G = g * 16, B = b * 16;
      const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      const sky = B - R > 40 && B > 120 && B >= G;
      const grn = G - R > 12 && G - B > 12;
      let ch;
      if (sky) ch = 'S';
      else if (grn) ch = quant(R + G + B - 64);
      else ch = lum < 24 ? 'B' : quant(lum);
      line += ch;
    }
    console.log(line);
  }
  const buckets = new Map();
  for (const row of rows) for (const code of row) {
    const r = (code >> 10) & 0x1f, g = (code >> 5) & 0x1f, b = code & 0x1f;
    const key = `${r >> 1},${g >> 1},${b >> 1}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  const total = rows.length * rows[0].length;
  console.log('top focus colors:');
  [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([key, count]) => {
    const [r, g, b] = key.split(',').map(Number);
    console.log(`  rgb(${r * 32},${g * 32},${b * 32}) ${(100 * count / total).toFixed(1)}%`);
  });
  process.exit(0);
}

// Print in two passes: luminance map, and semantic class map
console.log(`== ${label} ${out.width}x${out.height} ==`);
console.log('--- luminance (top of image first; readPixels y=0 is bottom) ---');
for (let gy = out.grid.length - 1; gy >= 0; gy--) {
  let line = '';
  for (const code of out.grid[gy]) {
    const r = (code >> 16) & 0xff, g = (code >> 8) & 0xff, b = code & 0xff;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    line += chars[Math.min(chars.length - 1, Math.floor((lum / 255) * chars.length))];
  }
  console.log(line);
}
console.log('--- class map: S=sky G=green terrain B=black .=other ---');
for (let gy = out.grid.length - 1; gy >= 0; gy--) {
  let line = '';
  for (const code of out.grid[gy]) {
    const r = (code >> 16) & 0xff, g = (code >> 8) & 0xff, b = code & 0xff;
    const c = classify(r, g, b);
    line += c === 'SKY' ? 'S' : c === 'GRN' ? 'G' : c === 'BLK' ? 'B' : '.';
  }
  console.log(line);
}
// Averages of key regions
function avgOf(rows) {
  let r = 0, g = 0, b = 0, n = 0;
  for (const row of rows) for (const code of row) {
    r += (code >> 16) & 0xff; g += (code >> 8) & 0xff; b += code & 0xff; n++;
  }
  return [`avg rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`];
}
const S = out.grid.length;
const topThird = out.grid.slice(0, Math.floor(S / 3));
const midThird = out.grid.slice(Math.floor(S / 3), Math.floor(2 * S / 3));
const botThird = out.grid.slice(Math.floor(2 * S / 3));
console.log('top:', ...avgOf(topThird));
console.log('mid:', ...avgOf(midThird));
console.log('bottom:', ...avgOf(botThird));
