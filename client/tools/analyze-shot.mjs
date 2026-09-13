// Analyze a screenshot: dominant colors + sampled bands.
// Usage: node tools/analyze-shot.mjs <png> [label]
import { decodePng } from './png-decode.mjs';
import process from 'node:process';

const file = process.argv[2];
const label = process.argv[3] || file;
const { width, height, channels, data } = decodePng(file);
console.log(`== ${label} ${width}x${height} ch=${channels} ==`);

const px = (x, y) => {
  const i = (y * width + x) * channels;
  return [data[i], data[i + 1], data[i + 2]];
};

// Top colors (quantized to 4 bits/channel)
const counts = new Map();
for (let y = 0; y < height; y += 2) {
  for (let x = 0; x < width; x += 2) {
    const [r, g, b] = px(x, y);
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
}
const total = Math.round((width / 2) * (height / 2));
const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
for (const [key, count] of top) {
  const r = ((key >> 8) & 0xf) * 17, g = ((key >> 4) & 0xf) * 17, b = (key & 0xf) * 17;
  console.log(`  rgb(${r},${g},${b})  ${(100 * count / total).toFixed(1)}%`);
}

// Sample bands: rows at 10%, 25%, 50%, 75%, 90% of height — average color
for (const frac of [0.1, 0.25, 0.5, 0.75, 0.9]) {
  const y = Math.floor(height * frac);
  let r = 0, g = 0, b = 0;
  for (let x = 0; x < width; x += 4) {
    const [pr, pg, pb] = px(x, y);
    r += pr; g += pg; b += pb;
  }
  const n = Math.ceil(width / 4);
  console.log(`  row ${String(frac).padStart(3)} (y=${y}): avg rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`);
}

// Non-sky fraction in central third (sky ~ rgb(116,185,255) fogged toward terrain)
let nonSky = 0, sampled = 0;
for (let y = Math.floor(height * 0.25); y < Math.floor(height * 0.75); y += 2) {
  for (let x = Math.floor(width * 0.33); x < Math.floor(width * 0.67); x += 2) {
    const [r, g, b] = px(x, y);
    // sky is very blue-dominant: b - r > 100
    if (!(b - r > 100 && b > 150)) nonSky++;
    sampled++;
  }
}
console.log(`  central non-sky fraction: ${(100 * nonSky / sampled).toFixed(1)}%`);
