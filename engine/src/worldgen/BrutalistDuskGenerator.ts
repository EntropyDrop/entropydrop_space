import { acceptsTerrainFeature, type TerrainFeaturePolicy } from './TerrainFeaturePolicy.ts';
// Ported from entropydrop_frontend/src/pages/terrainLab/brutalistDusk.ts.
// Preserve solid interiors for collisions and seven-level volumetric LOD.
import { finishTerrainLabRegion } from './TerrainLabRegion.ts';
/** A weathered, inhabited concrete megastructure. Standalone, deterministic.
 * Only 1m and 0.125m cubes; only normal and emissive materials.
 * Output coordinates are crop-local cube lower corners. */
export interface BrutalistDuskConfig extends TerrainFeaturePolicy {
  sizeX: number; sizeY: number; sizeZ: number;
  offsetX: number; offsetZ: number; yCutoff: number; seed: number;
  brutalHeight: number; brutalDensity: number; brutalWeathering: number;
  brutalTransit: number; brutalPeople: number; brutalLights: number; brutalGlow: number;
}

export const BRUTALIST_DUSK_DEFAULTS = {
  brutalHeight: 142, brutalDensity: 0.85, brutalWeathering: 0.75,
  brutalTransit: 1, brutalPeople: 0.55, brutalLights: 0.4, brutalGlow: 0.3,
};


interface Footprint { x: number; z: number; w: number; d: number }
interface Structure extends Footprint { bottom: number; top: number; role: 'pier' | 'hall' | 'neighbour' }

const MICRO = 0.125;
const C = {
  concrete: 0x86827b, pale: 0xaaa394, darkConcrete: 0x63666a, stained: 0x54564f,
  road: 0x343941, steel: 0x393d40, glass: 0x1c2d36, rust: 0x775040,
  red: 0x943c35, cream: 0xc9bba2, warm: 0xffc588, cyan: 0x78c4d4, signal: 0xff5449,
};
// Original facade glyphs, indexed by Latin transliteration.
const LETTERS: Record<string, string[]> = {
  'P': ['1111', '1001', '1001', '1001', '1001'], 'R': ['1110', '1001', '1110', '1000', '1000'],
  'O': ['0110', '1001', '1001', '1001', '0110'], 'G': ['1111', '1000', '1000', '1000', '1000'],
  'E': ['111', '100', '110', '100', '111'], 'S': ['0111', '1000', '1000', '1000', '0111'],
  'N': ['1001', '1001', '1111', '1001', '1001'], 'A': ['0110', '1001', '1111', '1001', '1001'],
  'U': ['1001', '1001', '0111', '0001', '1110'], 'K': ['1001', '1010', '1100', '1010', '1001'],
};

function hash(x: number, z: number, salt: number, seed: number) {
  let n = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(salt, 1442695041) ^ seed;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
const unit = (n: number) => Math.max(0, Math.min(1, n));
function tint(color: number, amount: number) {
  const channel = (shift: number) => Math.min(255, Math.max(0, Math.round(((color >> shift) & 255) * amount)));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

export function generateBrutalistDuskRegion(config: BrutalistDuskConfig, includeDetails = true) {
  const width = Math.max(1, Math.floor(config.sizeX)), depth = Math.max(1, Math.floor(config.sizeZ));
  const ceiling = Math.max(1, Math.floor(Math.min(config.sizeY, config.yCutoff)));
  const ox = Math.floor(config.offsetX - width / 2), oz = Math.floor(config.offsetZ - depth / 2);
  const seed = Math.floor(config.seed), height = Math.max(80, Math.min(148, Math.floor(config.brutalHeight)));
  const weather = unit(config.brutalWeathering), density = unit(config.brutalDensity), lights = unit(config.brutalLights);
  const layer = width * depth, cells = new Uint16Array(layer * ceiling);
  const palette = [{ color: 0, emission: 0, weathered: false }];
  const ids = new Map<string, number>();
  const micros = new Map<number, number>();
  const openings: { x: number; y: number; z: number; w: number; h: number; d: number }[] = [];
  const near = (r: Footprint, margin = 0) => r.x < ox + width + margin && r.x + r.w > ox - margin && r.z < oz + depth + margin && r.z + r.d > oz - margin;
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, color: number, emission = 0, weathered = true) => {
    const x0 = Math.max(0, Math.floor(x - ox)), x1 = Math.min(width, Math.floor(x + w - ox));
    const z0 = Math.max(0, Math.floor(z - oz)), z1 = Math.min(depth, Math.floor(z + d - oz));
    const y0 = Math.max(0, Math.floor(y)), y1 = Math.min(ceiling, Math.floor(y + h));
    if (x0 >= x1 || z0 >= z1 || y0 >= y1) return;
    const key = `${color}:${emission}:${weathered}`;
    let id = color === 0 ? 0 : ids.get(key);
    if (id === undefined) { id = palette.length; ids.set(key, id); palette.push({ color, emission, weathered }); }
    for (let iy = y0; iy < y1; iy++) for (let iz = z0; iz < z1; iz++) cells.fill(id, x0 + iz * width + iy * layer, x1 + iz * width + iy * layer);
  };
  const micro = (x: number, y: number, z: number, color: number, intensity = 0) => {
    if (!includeDetails) return;
    x = Math.round(x * 8) / 8; y = Math.round(y * 8) / 8; z = Math.round(z * 8) / 8;
    if (x < ox || x + MICRO > ox + width || z < oz || z + MICRO > oz + depth || y < 0 || y + MICRO > ceiling) return;
    const key = (x - ox) * 8 + (z - oz) * 8 * width * 8 + y * 8 * layer * 64;
    micros.set(key, (color | (intensity > 0 ? 1 << 24 : 0)) >>> 0);
  };
  const detail = (x: number, y: number, z: number, w: number, h: number, d: number, color: number, emission = 0) => {
    if (!includeDetails) return;
    if (!near({ x, z, w, d }) || y >= ceiling || y + h <= 0) return;
    // Micro boxes retain their shell rather than stretching a cube to a third size.
    for (let iy = 0; iy < h; iy += MICRO) for (let iz = 0; iz < d; iz += MICRO) for (let ix = 0; ix < w; ix += MICRO) {
      if (ix && iy && iz && ix + MICRO < w && iy + MICRO < h && iz + MICRO < d) continue;
      micro(x + ix, y + iy, z + iz, color, emission);
    }
  };
  const line = (x: number, y: number, z: number, length: number, axis: 'x' | 'y' | 'z', color: number, emission = 0) => {
    if (!includeDetails) return;
    if (!near({ x, z, w: axis === 'x' ? length : 1, d: axis === 'z' ? length : 1 })) return;
    for (let i = 0; i < length; i += MICRO) micro(x + (axis === 'x' ? i : 0), y + (axis === 'y' ? i : 0), z + (axis === 'z' ? i : 0), color, emission);
  };
  const railing = (x: number, y: number, z: number, length: number, alongX: boolean) => {
    if (!includeDetails) return;
    line(x, y + 1, z, length, alongX ? 'x' : 'z', C.steel);
    line(x, y + 0.5, z, length, alongX ? 'x' : 'z', C.steel);
    for (let i = 0; i < length; i += 2) line(x + (alongX ? i : 0), y, z + (alongX ? 0 : i), 1.125, 'y', C.steel);
  };
  const lettering = (x: number, y: number, z: number, word: string, pixel: number, color: number, emission = 0) => {
    if (!includeDetails) return;
    let cursor = 0;
    for (const letter of word) {
      const glyph = LETTERS[letter];
      glyph.forEach((row, gy) => [...row].forEach((bit, gx) => {
        if (bit === '1') detail(x + cursor + gx * pixel, y + (4 - gy) * pixel, z, pixel, pixel, MICRO, color, emission);
      }));
      cursor += (glyph[0].length + 1) * pixel;
    }
  };
  const roof = (r: Structure, elaborate: boolean) => {
    const { x, z, w, d, top } = r;
    box(x, top, z, w, 1, d, C.darkConcrete);
    box(x, top + 1, z, w, 1, 1, C.concrete);
    box(x, top + 1, z + d - 1, w, 1, 1, C.concrete);
    box(x, top + 1, z, 1, 1, d, C.concrete);
    box(x + w - 1, top + 1, z, 1, 1, d, C.concrete);
    const salt = hash(x, z, 30, seed);
    box(x + 3, top + 1, z + 3, 3, 2 + Math.floor(salt * 3), 4, C.steel);
    for (let u = 0; u < 3; u++) line(x + 3.25 + u, top + 3.125, z + 3.25, 3.5, 'z', C.pale);
    const mast = elaborate ? 9 + Math.floor(salt * 7) : 3 + Math.floor(salt * 5);
    const mx = x + Math.floor(w / 2), mz = z + 4;
    box(mx, top + 1, mz, 1, Math.floor(mast / 2), 1, C.steel);
    detail(mx + 0.375, top + mast / 2, mz + 0.375, 0.25, mast / 2 + 1, 0.25, C.rust);
    if (lights > 0) detail(mx + 0.25, top + mast + 1, mz + 0.25, 0.5, 0.25, 0.5, C.signal, 1.7);
    if (elaborate) {
      for (let j = 0; j < 4; j++) {
        const px = x + w - 3 - (j % 2) * 2, pz = z + d - 3 - Math.floor(j / 2) * 2;
        line(px, top + 1, pz, 6, 'y', C.rust);
        if (j < 2) line(px, top + 6, pz - 2, 2.125, 'z', C.rust);
      }
      railing(x + 2, top + 1, z + 2, w - 4, true);
    }
  };

  const facade = (r: Structure, wall: number, monumental: boolean) => {
    const { x, z, w, d, bottom, top } = r;
    const floorHeight = monumental ? 5 : 4 + Math.floor(hash(x, z, 32, seed) * 2);
    for (let face = 0; face < 4; face++) {
      const side = face >= 2, far = face % 2 === 1, length = side ? d : w;
      const faceBox = (u: number, y: number, span: number, high: number, color: number, inset = 0) => box(
        side ? x + (far ? w - 1 - inset : inset) : x + u, y,
        side ? z + u : z + (far ? d - 1 - inset : inset), side ? 1 : span, high, side ? span : 1, color);
      for (let y = bottom + 4; y < top - 3; y += floorHeight) {
        // Large service walls interrupt the occupied bands, keeping a heavy silhouette.
        if (monumental && r.role === 'pier' && (y < top * 0.16 || (y > top * 0.49 && y < top * 0.6))) continue;
        for (let u = 2; u < length - 3; u += 4) {
          const random = hash(x + u, z + face, y, seed);
          if (random < 0.1) continue;
          faceBox(u, y, 2, 2, 0);
          faceBox(u, y, 2, 2, C.glass, 1);
          // Glazing lies inside a one-metre recess. Frames and mullions are actual micro cubes.
          const px = side ? x + (far ? w - 0.875 : 0.75) : x + u;
          const pz = side ? z + u : z + (far ? d - 0.875 : 0.75);
          line(px, y + 0.875, pz, 2, side ? 'z' : 'x', C.steel);
          if (random < lights) {
            const glow = random < lights * 0.65 ? C.warm : random < lights * 0.9 ? C.cyan : C.signal;
            detail(px, y + 1.125, pz, side ? MICRO : 1.625, 0.5, side ? 1.625 : MICRO, glow, 1.2);
          }
        }
        if ((y - bottom - 4) % (floorHeight * 3) === 0) faceBox(1, y - 1, length - 2, 1, C.darkConcrete);
      }
      if (monumental) {
        // Deep pilasters, protruding service ducts and interrupted rain streaks.
        for (let u = 1; u < length - 1; u += Math.max(5, length - 4)) {
          box(side ? x + (far ? w : -1) : x + u, bottom,
            side ? z + u : z + (far ? d : -1), side ? 1 : 2, top - bottom - 2, side ? 2 : 1, wall);
        }
        const px = side ? x + (far ? w + 0.125 : -0.5) : x + length - 4;
        const pz = side ? z + length - 4 : z + (far ? d + 0.125 : -0.5);
        detail(px, bottom + 2, pz, 0.375, Math.max(1, top - bottom - 8), 0.375, C.rust);
        for (let y = bottom + 4; y < top - 4; y += 9) {
          detail(px - 0.125, y, pz - 0.125, 0.625, 0.125, 0.625, C.steel);
        }
      }
    }
  };
  const building = (r: Structure, wall: number, monumental = false) => {
    box(r.x, r.bottom, r.z, r.w, r.top - r.bottom, r.d, wall);
    facade(r, wall, monumental);
    roof(r, monumental);
  };

  box(ox, 0, oz, width, 1, depth, C.road);
  // District anchors are coarse and jittered. The small-scale city is not tiled.
  const region = 256;
  for (let rx = Math.floor((ox + 128) / region) - 1; rx <= Math.floor((ox + width + 128) / region) + 1; rx++) {
    for (let rz = Math.floor((oz + 128) / region) - 1; rz <= Math.floor((oz + depth + 128) / region) + 1; rz++) {
      const cx = rx * region + Math.floor(hash(rx, rz, 1, seed) * 9) - 4;
      const cz = rz * region + Math.floor(hash(rx, rz, 2, seed) * 9) - 4;
      // Context strips can extend beyond the district anchor by up to 136m.
      if (!near({ x: cx - 144, z: cz - 144, w: 288, d: 288 })) continue;
      const random = (salt: number) => hash(rx, rz, salt, seed);
      const scaled = (fraction: number) => Math.floor(height * fraction);
      const front = cz + 4, left = cx - 43, right = cx + 24 + Math.floor(random(3) * 4);
      const beamY = scaled(0.67), lowerY = scaled(0.35);
      if (acceptsTerrainFeature(config, cx, cz, 100)) {
        const pierLeft: Structure = { x: left, z: front, w: 16, d: 21, bottom: 2, top: scaled(0.79 + random(5) * 0.07), role: 'pier' };
        const pierRight: Structure = { x: right, z: front - 3, w: 16, d: 25, bottom: 2, top: scaled(0.87 + random(6) * 0.07), role: 'pier' };
        const core: Structure = { x: cx - 10, z: cz - 34, w: 21, d: 23, bottom: 2, top: height, role: 'pier' };
        for (const pier of [pierLeft, pierRight, core]) {
          box(pier.x - 2, 1, pier.z - 2, pier.w + 4, 3, pier.d + 4, C.darkConcrete);
          building(pier, C.concrete, true);
        }
        building({ x: cx - 52, z: cz - 47, w: 16, d: 19, bottom: 2, top: scaled(0.64), role: 'pier' }, C.darkConcrete, true);
        building({ x: cx + 30, z: cz - 47, w: 18, d: 19, bottom: 2, top: scaled(0.72), role: 'pier' }, C.concrete, true);
        // Different occupied volumes clasp the shafts, with sheltered undersides and
        // mechanical floors. Their cantilevers are short relative to the bearing core.
        const pods: Structure[] = [
          { x: left - 6, z: front - 1, w: 26, d: 24, bottom: scaled(0.72), top: pierLeft.top + 3, role: 'hall' },
          { x: left - 4, z: front + 1, w: 23, d: 24, bottom: scaled(0.32), top: scaled(0.32) + 10, role: 'hall' },
          { x: right - 4, z: front - 6, w: 25, d: 32, bottom: scaled(0.59), top: scaled(0.59) + 13, role: 'hall' },
          { x: right - 2, z: front - 4, w: 23, d: 30, bottom: scaled(0.29), top: scaled(0.29) + 11, role: 'hall' },
        ];
        for (const pod of pods) {
          building(pod, C.concrete);
          box(pod.x - 1, pod.bottom - 2, pod.z - 1, pod.w + 2, 2, pod.d + 2, C.darkConcrete);
          box(pod.x - 1, pod.top + 1, pod.z - 1, pod.w + 2, 1, pod.d + 2, C.pale);
          railing(pod.x - 0.75, pod.top + 2, pod.z + pod.d + 0.75, pod.w + 1.5, true);
          for (let j = 0; j < 3; j++) line(pod.x, pod.bottom - 1.5 + j * 0.375, pod.z + pod.d + 1, pod.w, 'x', C.rust);
          // Recessed, continuous mechanical galleries; individual bays light independently.
          const gy = pod.bottom + 2;
          box(pod.x + 2, gy, pod.z + pod.d - 2, pod.w - 4, 2, 1, C.glass);
          box(pod.x + 2, gy, pod.z + pod.d - 1, pod.w - 4, 2, 1, 0);
          box(pod.x + pod.w - 2, gy, pod.z + 2, 1, 2, pod.d - 4, C.glass);
          box(pod.x + pod.w - 1, gy, pod.z + 2, 1, 2, pod.d - 4, 0);
          for (let u = 2; u < pod.w - 3; u += 4) {
            line(pod.x + u, gy, pod.z + pod.d - 0.875, 2, 'y', C.steel);
            if (hash(pod.x + u, pod.z, 61, seed) < lights + 0.2 && lights > 0) detail(pod.x + u + 0.5, gy + 0.875, pod.z + pod.d - 0.875, 2.25, 0.375, MICRO, u % 3 ? C.signal : C.cyan, 1.8);
          }
          for (let u = 2; u < pod.d - 3; u += 4) {
            line(pod.x + pod.w - 0.875, gy, pod.z + u, 2, 'y', C.steel);
            if (hash(pod.x, pod.z + u, 62, seed) < lights + 0.2 && lights > 0) detail(pod.x + pod.w - 0.875, gy + 0.875, pod.z + u + 0.5, MICRO, 0.375, 2.25, u % 3 ? C.cyan : C.warm, 1.5);
          }
          for (let u = 4; u < pod.w - 3; u += 6) {
            box(pod.x + u, pod.bottom - 5, pod.z + pod.d - 2, 2, 3, 2, C.darkConcrete);
          }
        }
        // Open pilotis at the feet, while corner walls continue to carry the tower.
        for (const opening of [
          { x: left + 5, y: 5, z: front, w: 6, h: scaled(0.2), d: 21 },
          { x: right + 5, y: 5, z: front - 3, w: 6, h: scaled(0.19), d: 25 },
        ]) {
          openings.push(opening);
          box(opening.x, opening.y, opening.z, opening.w, opening.h, opening.d, 0);
        }
        // Habitable crossbeams bear on solid piers; an open central portal remains below.
        const hall: Structure = { x: left + 5, z: front + 2, w: right - left + 7, d: 15, bottom: beamY, top: beamY + 11, role: 'hall' };
        building(hall, C.concrete);
        box(hall.x, beamY - 2, hall.z, hall.w, 2, hall.d, C.darkConcrete);
        lettering(cx - 21, beamY + 8, hall.z + hall.d, 'PROGRESS', 0.625, C.red);
        // A lower, thinner bridge provides scale without closing the monumental opening.
        box(left + 8, lowerY, front - 4, right - left, 3, 7, C.darkConcrete);
        railing(left + 8, lowerY + 3, front + 2.75, right - left, true);
        // Two rear connections occupy different levels and orientations.
        box(cx - 38, scaled(0.53), cz - 36, 30, 7, 10, C.concrete);
        box(cx + 7, scaled(0.74), cz - 31, 29, 7, 10, C.concrete);
        box(right + 3, scaled(0.57), cz - 36, 8, 6, front - cz + 42, C.darkConcrete);
        // Stepped concrete knees transfer the crossbeam loads back into the tower shafts.
        for (let i = 0; i < 27; i++) {
          box(left + 10 + Math.floor(i * 0.65), beamY - 27 + i, front + 10, 5, 3, 5, C.concrete);
          box(right + 1 - Math.floor(i * 0.65), beamY - 27 + i, front + 10, 5, 3, 5, C.concrete);
        }
        // A broad equipment floor is cantilevered only a few metres beyond the core.
        const crownY = height - 22;
        box(core.x - 3, crownY, core.z - 3, core.w + 6, 3, core.d + 6, C.darkConcrete);
        for (let i = 0; i < 5; i++) box(core.x + i * 4, crownY + 1, core.z + core.d + 3, 2, 1, 1, C.cyan, lights > 0 ? 1.1 : 0, false);
        lettering(core.x + 3, height - 8, core.z + core.d, 'SSSR', 0.5, C.red);
        lettering(right, beamY - 20, pierRight.z + pierRight.d, 'NAUKA', 0.625, C.cream);
        // Vertically stacked enamel wayfinding on the central service core.
        box(core.x + 3, scaled(0.37), core.z + core.d, 3, 14, 1, C.red, 0, false);
        [...'SSSR'].forEach((letter, index) => lettering(core.x + 3.5, scaled(0.37) + 10.5 - index * 3, core.z + core.d + 1, letter, 0.375, C.cream, lights > 0 ? 0.9 : 0));
        // A grounded auxiliary stair/service block and an occupied cross-passage.
        building({ x: cx - 9, z: cz - 4, w: 15, d: 13, bottom: 2, top: scaled(0.31), role: 'pier' }, C.darkConcrete);
        box(cx - 11, scaled(0.29), cz - 4, 20, 4, 16, C.concrete);
        lettering(cx - 8, scaled(0.29) + 1, cz + 12, 'PROGRESS', 0.375, C.cream, lights > 0 ? 0.7 : 0);
        // A small red star is relief geometry, not a decal or a third material.
        const star = ['0001000', '0011100', '1111111', '0111110', '0011100', '0110110', '1100011'];
        star.forEach((row, y) => [...row].forEach((bit, x) => {
          if (bit === '1') detail(left + 5 + x * 0.5, pierLeft.top - 8 + (6 - y) * 0.5, front + 23, 0.5, 0.5, 0.25, C.red);
        }));
      }

      // Context blocks use variable-width strips, independent heights and setbacks.
      let z = cz - 119;
      let row = 0;
      while (z < cz + 117) {
        const d = 11 + Math.floor(hash(rx, row, 200, seed) * 9);
        let x = cx - 119, column = 0;
        while (x < cx + 116) {
          const h = (salt: number) => hash(x, z, salt, seed);
          const w = 10 + Math.floor(h(201) * 11);
          const footprint = { x, z, w, d };
          const inCore = x < cx + 58 && x + w > cx - 60 && z < cz + 36 && z + d > cz - 55;
          const inTransit = (z < cz + 55 && z + d > cz + 38) || (x < cx + 77 && x + w > cx + 58);
          if (!inCore && !inTransit && near(footprint, 2) && acceptsTerrainFeature(config, x + w / 2, z + d / 2, Math.hypot(w, d) / 2 + 5) && h(202) < density) {
            const far = z < cz - 55 ? 1.35 : z > cz + 55 ? 0.4 : 1;
            const top = Math.floor((19 + h(203) * 46) * far);
            const wall = h(204) < 0.4 ? C.darkConcrete : h(204) < 0.8 ? C.concrete : C.pale;
            box(x - 1, 1, z - 1, w + 2, 1, d + 2, C.darkConcrete);
            const shoulder = h(205) < 0.5 ? Math.floor(top * 0.62) : top;
            building({ ...footprint, bottom: 2, top: shoulder, role: 'neighbour' }, wall);
            if (shoulder < top) building({ x: x + 2 + column % 2, z: z + 2, w: w - 5, d: d - 4, bottom: shoulder + 1, top, role: 'neighbour' }, wall);
          }
          x += w + 5 + Math.floor(h(206) * 6); column++;
        }
        z += d + 5 + Math.floor(hash(rx, row, 207, seed) * 6); row++;
      }

      const person = (x: number, y: number, z: number, salt: number) => {
        if (!includeDetails) return;
        const cloth = [0x766652, 0x4e6060, 0x8b463d, 0x393d47, 0xada18a][Math.floor(hash(x * 8, z * 8, salt, seed) * 5)];
        detail(x, y, z, 0.125, 0.75, 0.25, C.steel);
        detail(x + 0.25, y, z, 0.125, 0.75, 0.25, C.steel);
        detail(x, y + 0.75, z, 0.375, 0.625, 0.25, cloth);
        detail(x + 0.125, y + 1.375, z, 0.25, 0.25, 0.25, 0xc59c7d);
        line(x - 0.125, y + 0.75, z, 0.5, 'y', cloth);
        line(x + 0.375, y + 0.75, z, 0.5, 'y', cloth);
      };
      const train = (x: number, y: number, z: number) => {
        for (let car = 0; car < 3; car++) {
          const px = x + car * 9;
          box(px, y, z, 8, 1, 3, C.steel, 0, false);
          box(px, y + 1, z, 8, 1, 3, C.red, 0, false);
          box(px, y + 2, z, 8, 1, 3, C.cream, 0, false);
          detail(px, y + 3, z, 8, 0.375, 3, C.darkConcrete);
          for (let j = 1; j < 7; j += 2) {
            detail(px + j, y + 2.125, z + 3, 1.25, 0.625, MICRO, C.warm, lights > 0 ? 0.7 : 0);
            detail(px + j, y + 2.125, z - MICRO, 1.25, 0.625, MICRO, C.glass);
          }
          detail(px + 7.875, y + 1, z + 0.5, 0.25, 0.25, 0.25, C.warm, lights > 0 ? 1.5 : 0);
          if (car < 2) detail(px + 8, y + 0.5, z + 1, 1, 0.5, 1, C.steel);
        }
      };
      if (config.brutalTransit > 0 && acceptsTerrainFeature(config, cx, cz, 146)) {
        const rail = (x: number, z: number, length: number, level: number, alongX: boolean) => {
          const stamp = (a: number, y: number, b: number, len: number, h: number, wide: number, color: number) => box(x + (alongX ? a : b), y, z + (alongX ? b : a), alongX ? len : wide, h, alongX ? wide : len, color);
          stamp(0, level - 2, 0, length, 2, 7, C.darkConcrete);
          for (let u = 8; u < length; u += 17 + Math.floor(hash(cx + u, cz, 300, seed) * 9)) {
            stamp(u, 1, 2, 3, level - 3, 3, C.concrete);
            stamp(u - 2, level - 5, 0, 7, 3, 7, C.concrete);
          }
          for (const b of [1.75, 3.5]) line(x + (alongX ? 0 : b), level + 0.125, z + (alongX ? b : 0), length, alongX ? 'x' : 'z', C.steel);
          for (let u = 0; u < length; u += 1.5) line(x + (alongX ? u : 1), level, z + (alongX ? 1 : u), 3.5, alongX ? 'z' : 'x', C.rust);
          railing(x, level, z, length, alongX);
          railing(x + (alongX ? 0 : 6.875), level, z + (alongX ? 6.875 : 0), length, alongX);
        };
        const level = Math.max(14, Math.floor(height * 0.145)), railZ = cz + 43;
        rail(cx - 121, railZ, 242, level, true);
        if (config.brutalTransit > 0.5) rail(cx + 65, cz - 121, 242, level + 14, false);
        // Station: deck, columns, canopy, access stairs and passengers share real levels.
        box(cx - 55, level - 2, railZ + 7, 48, 2, 7, C.concrete);
        for (let u = 0; u < 48; u += 12) {
          box(cx - 53 + u, 1, railZ + 10, 2, level - 3, 2, C.concrete);
          box(cx - 53 + u, level, railZ + 10, 1, 5, 1, C.steel);
        }
        box(cx - 55, level + 5, railZ + 8, 48, 1, 6, C.darkConcrete);
        lettering(cx - 44, level - 1.75, railZ + 14, 'PROGRESS', 0.25, C.cream);
        line(cx - 54, level + 4.75, railZ + 8.5, 44, 'x', C.warm, lights > 0 ? 1 : 0);
        railing(cx - 55, level, railZ + 13.875, 48, true);
        for (let i = 0; i < level; i++) box(cx - 9 + i, level - 1 - i, railZ + 8, 1, 1 + i, 4, C.darkConcrete);
        train(cx - 45 + Math.floor(random(310) * 20), level, railZ + 1);
        for (let i = 0; i < 40; i++) {
          const h = hash(cx + i, cz, 311, seed);
          if (h < unit(config.brutalPeople)) person(cx - 54 + hash(i, cx, 312, seed) * 44, level, railZ + 8.5 + hash(i, cz, 313, seed) * 4, i);
        }
      }
      // Paved civic square and small-scale lamp pools in front of the main portal.
      if (acceptsTerrainFeature(config, cx, cz + 32, 28)) {
        box(cx - 24, 1, cz + 26, 43, 1, 12, C.darkConcrete);
        for (let u = 0; u < 6; u++) {
          const x = cx - 22 + u * 7;
          detail(x, 2, cz + 35, 0.25, 4, 0.25, C.steel);
          detail(x - 0.375, 6, cz + 34.75, 1, 0.25, 0.75, C.warm, lights > 0 ? 1.4 : 0);
          if (hash(cx + u, cz, 340, seed) < config.brutalPeople) person(x + 2.5, 2, cz + 32, u);
        }
      }
      // Road paint, utility covers and parked service vehicles establish metre scale.
      for (let x = cx - 119; x < cx + 119; x += 8) {
        if (!acceptsTerrainFeature(config, x + 2, cz + 64, 5)) continue;
        line(x, 1, cz + 65, 3, 'x', C.pale);
        if (hash(x, cz, 345, seed) > 0.75) {
          detail(x, 1, cz + 61, 3.5, 0.5, 1.5, C.steel);
          detail(x + 0.75, 1.5, cz + 61.125, 2, 0.625, 1.25, C.darkConcrete);
          detail(x + 3.5, 1.25, cz + 61.125, 0.125, 0.25, 0.25, C.warm, lights > 0 ? 1 : 0);
          detail(x + 3.5, 1.25, cz + 62.125, 0.125, 0.25, 0.25, C.warm, lights > 0 ? 1 : 0);
        }
      }
    }
  }

  // Carved pilotis must clear ornaments as well as standard cubes.
  for (const key of micros.keys()) {
    const mx = key % (width * 8), mz = Math.floor(key / (width * 8)) % (depth * 8), my = Math.floor(key / (layer * 64));
    const wx = ox + (mx + 0.5) / 8, wz = oz + (mz + 0.5) / 8, y = my / 8;
    if (openings.some(o => wx >= o.x && wx < o.x + o.w && wz >= o.z && wz < o.z + o.d && y >= o.y && y < o.y + o.h))
      micros.delete(key);
  }
  return finishTerrainLabRegion(width, depth, ceiling, cells, palette, micros, (id, x, y, z) => {
    const { color, emission, weathered } = palette[id], wx = x + ox, wz = z + oz;
    if (!weathered || emission) return color;
    const patch = hash(Math.floor(wx / 4), Math.floor(wz / 4), Math.floor(y / 7) + 400, seed);
    const streak = hash(wx, wz, 401, seed) < 0.16 ? Math.max(0, Math.sin(y * 0.065 + hash(wx, wz, 402, seed) * 6)) * 0.18 : 0;
    const shade = 1 - weather * ((1 - patch) * 0.14 + streak + hash(wx, wz, y + 403, seed) * 0.035);
    return tint(color, shade);
  });
}

/** The civic square in front of the central portal has a clear, solid landing. */
export function brutalistDuskSpawnAnchor(seed: number) {
  return { x: Math.floor(hash(0, 0, 1, Math.floor(seed)) * 9) - 4 - 8,
    z: Math.floor(hash(0, 0, 2, Math.floor(seed)) * 9) - 4 + 28 };
}
