import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_GRADIENT_STOPS,
  gradientCss,
  normalizeGradientStops,
  normalizePaletteEntry,
  sampleGradientColor,
} from '../src/voxel/Palette.ts';

test('palette entries normalize, sort, and cap gradients at five stops', () => {
  const stops = normalizeGradientStops([
    { color: '#ffffff', position: 1 },
    { color: '#445566', position: 0.5 },
    { color: '#112233', position: 0 },
    { color: '#778899', position: 0.75 },
    { color: '#abcdef', position: 0.25 },
    { color: '#000000', position: 0.1 },
  ]);

  assert.equal(stops.length, MAX_GRADIENT_STOPS);
  assert.deepEqual(stops.map(stop => stop.position), [0, 0.25, 0.5, 0.75, 1]);
  assert.equal(normalizePaletteEntry({ stops, materialId: 999 }).materialId, 0);
});

test('gradient sampling interpolates RGB between neighboring stops', () => {
  const stops = [
    { color: '#000000', position: 0 },
    { color: '#ff0000', position: 0.5 },
    { color: '#ffffff', position: 1 },
  ];

  assert.equal(sampleGradientColor(stops, 0), 0x000000);
  assert.equal(sampleGradientColor(stops, 0.25), 0x800000);
  assert.equal(sampleGradientColor(stops, 0.75), 0xff8080);
  assert.equal(sampleGradientColor(stops, 1), 0xffffff);
  assert.equal(
    gradientCss(stops),
    'linear-gradient(90deg, #000000 0%, #ff0000 50%, #ffffff 100%)',
  );
});
