import test from 'node:test';
import assert from 'node:assert/strict';
import { surfaceSubdivisionWorldArea, surfaceSubdivisionDistance, SURFACE_AREA_HYSTERESIS } from '../src/render/SurfaceSubdivision.ts';

test('subdivision uses area in square pixels, not a linear pixel-error threshold', () => {
  const area = surfaceSubdivisionWorldArea(8, 16, 16);
  const splitAt = surfaceSubdivisionDistance(area, 1000, 720, 63);
  assert.ok(Math.abs(area * (720 / splitAt) ** 2 - 63) < 1e-10);
  assert.equal(surfaceSubdivisionDistance(area, 1000, 720, 63 * 4), splitAt / 2);
  assert.equal(surfaceSubdivisionDistance(area, 1000, 1440, 63), splitAt * 2);
  assert.ok(surfaceSubdivisionDistance(area, 1000, 720, 63 * SURFACE_AREA_HYSTERESIS) > splitAt,
    'existing finer nodes survive moving back across their split boundary');
});

test('column bounds include vertical facades, but negligible residuals stay merged', () => {
  assert.ok(surfaceSubdivisionWorldArea(8, 80, 0) > surfaceSubdivisionWorldArea(8, 16, 16) * 10);
  assert.equal(surfaceSubdivisionDistance(1000000, 0, 720, 63), 0);
  assert.equal(surfaceSubdivisionDistance(1000000, 0.1, 720, 63), 144);
});
