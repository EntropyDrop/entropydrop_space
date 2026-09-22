// Ported from entropydrop_frontend/src/pages/terrainLab/colossusHarbor.ts.
// Keep solid interiors for collisions and volumetric LOD; retain the original 1/8m details.
import { finishTerrainLabRegion } from './TerrainLabRegion.ts';
/** Infinite coordinate-addressed estuaries, sculptural sanctuaries and working harbours.
 * Geometry is exclusively 1m / 0.125m cubes; Y is the bottom of each cube.
 * Planning is independent of the visible crop, including neighbouring districts. */
export interface HarborConfig {
  sizeX: number; sizeY: number; sizeZ: number; offsetX: number; offsetZ: number; yCutoff: number; seed: number;
  harborRelief: number; harborStatues: number; harborScale: number; harborCity: number;
  harborIndustry: number; harborTransit: number; harborSteam: number; harborWear: number; harborGlow: number;
}
export const HARBOR_DEFAULTS = { harborRelief: 1, harborStatues: 0.85, harborScale: 1,
  harborCity: 0.85, harborIndustry: 1, harborTransit: 0.85, harborSteam: 0.5, harborWear: 0.65, harborGlow: 0.25 };
export const SCULPTURE_FAMILIES = ['winged', 'guardian', 'sage', 'enthroned', 'atlas', 'lion', 'eagle'] as const;
export type SculptureFamily = typeof SCULPTURE_FAMILIES[number];
interface Point { x: number; y: number; z: number }

export interface SculptureSite {
  id: string; x: number; z: number; base: number; height: number; family: SculptureFamily;
  pose: number; stone: number; crown: number; spread: number; lean: number; mirror: number; group: string;
}
export interface HarborFactory { id: string; x: number; z: number; base: number; variant: number; height: number; priority: number }
const M = 0.125, WATER = 12;
const C = { rock: 0x696450, ledge: 0x91856a, grass: 0x596145, dark: 0x333b3c, stone: 0xc3b493,
  trim: 0xac9873, bronze: 0x907346, steel: 0x77848a, roof: 0x4b6063, water: 0x456c7d,
  window: 0x273c44, warm: 0xfac981, cyan: 0x5edbec, brick: 0x8a7560, smoke: 0xabb1ae };
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const smooth = (v: number) => { const t = clamp(v); return t * t * (3 - 2 * t); };
function hash(x: number, z: number, salt: number, seed: number) {
  let h = Math.imul(x ^ seed ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16) ^ z, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13) ^ salt, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x: number, z: number, seed: number, salt: number) {
  const ix = Math.floor(x), iz = Math.floor(z), u = smooth(x - ix), v = smooth(z - iz);
  const a = hash(ix, iz, salt, seed), b = hash(ix + 1, iz, salt, seed);
  const c = hash(ix, iz + 1, salt, seed), d = hash(ix + 1, iz + 1, salt, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
const fbm = (x: number, z: number, seed: number, salt: number) => noise(x, z, seed, salt) * 0.57
  + noise(x * 2.17 + 13, z * 2.17 - 19, seed, salt + 1) * 0.29
  + noise(x * 4.39 - 21, z * 4.39 + 47, seed, salt + 2) * 0.14;
const tint = (c: number, t: number) => {
  const f = (n: number) => Math.round(clamp(((c >> n) & 255) * t, 0, 255));
  return (f(16) << 16) | (f(8) << 8) | f(0);
};

export function harborChannel(z: number, basin: number, config: HarborConfig) {
  const seed = Math.floor(config.seed);
  return { center: basin * 620 + (hash(basin, 0, 1, seed) - 0.5) * 100
      + (noise(z / 620, basin * 9.3, seed, 2) - 0.5) * 158
      + (noise(z / 182, basin * 7.7, seed, 3) - 0.5) * 58,
    radius: 22 + noise(z / 310, basin * 11.7, seed, 4) * 25 };
}

export function sampleColossusHarbor(x: number, z: number, config: HarborConfig) {
  const seed = Math.floor(config.seed), nearest = Math.round(x / 620);
  let distance = Infinity, basin = nearest, river = harborChannel(z, nearest, config);
  for (let b = nearest - 1; b <= nearest + 1; b++) {
    const r = harborChannel(z, b, config), d = Math.abs(x - r.center);
    if (d < distance) { distance = d; river = r; basin = b; }
  }
  const bank = x < river.center ? -1 : 1, inland = Math.max(0, distance - river.radius);
  const warp = fbm(x / 190, z / 233, seed, 10), rough = fbm(x / 28, z / 34, seed, 15);
  const mountain = smooth((inland - 22) / 140) * (bank < 0 ? 60 : 43)
    + smooth((inland - 150) / 90) * (25 + warp * 25);
  const gullies = Math.pow(1 - Math.abs(fbm(x / 61 + z / 500, z / 87, seed, 21) * 2 - 1), 16);
  const height = distance < river.radius ? WATER - 3 - Math.floor((1 - distance / river.radius) * 5)
    : WATER + 2 + inland * 0.027 + mountain * clamp(config.harborRelief, 0.65, 1.3)
      + (rough - 0.4) * (4 + smooth(inland / 80) * 11) - gullies * smooth(inland / 100) * 8;
  return { height: Math.max(3, Math.floor(height)), bank, basin, distance, inland, ...river, water: distance < river.radius };
}

function survey(x: number, z: number, r: number, config: HarborConfig) {
  return Math.max(...[-r, 0, r].flatMap(dx => [-r, 0, r].map(dz => sampleColossusHarbor(x + dx, z + dz, config).height)));
}

/** Family permutations prevent identical neighbours. Proportions and poses are
 * separate continuous variables, so sculptures are not scaled copies of a mesh. */
export function planColossusHarbor(config: HarborConfig, margin = 150) {
  const seed = Math.floor(config.seed), statues: SculptureSite[] = [], factories: HarborFactory[] = [];
  const x0 = config.offsetX - config.sizeX / 2 - margin, x1 = config.offsetX + config.sizeX / 2 + margin;
  const z0 = config.offsetZ - config.sizeZ / 2 - margin, z1 = config.offsetZ + config.sizeZ / 2 + margin;
  for (let basin = Math.floor(x0 / 620) - 1; basin <= Math.ceil(x1 / 620) + 1; basin++) {
    for (let sector = Math.floor(z0 / 224) - 1; sector <= Math.ceil(z1 / 224) + 1; sector++) {
      const r = (s: number) => hash(basin, sector, s, seed), z = Math.round((sector + (r(30) - 0.5) * 0.6) * 224);
      const river = harborChannel(z, basin, config), x = Math.round(river.center - river.radius - 78 - r(31) * 12);
      const group = `${basin}:${sector}`;
      // A new shuffled bag per seven districts balances subject matter without
      // repeating the geometry, terrain or the order of the next seven districts.
      const bag = [...SCULPTURE_FAMILIES].sort((a, b) => hash(basin, Math.floor(sector / 7), 1011 + SCULPTURE_FAMILIES.indexOf(a), seed)
        - hash(basin, Math.floor(sector / 7), 1011 + SCULPTURE_FAMILIES.indexOf(b), seed));
      const primary = bag[((sector % 7) + 7) % 7];
      const choices = [primary, ...SCULPTURE_FAMILIES.filter(f => f !== primary)
        .sort((a, b) => r(100 + SCULPTURE_FAMILIES.indexOf(a)) - r(100 + SCULPTURE_FAMILIES.indexOf(b)))];
      if (r(32) < config.harborStatues && x > x0 - 80 && x < x1 + 80 && z > z0 - 80 && z < z1 + 80) {
        const count = 3 + Math.floor(r(33) * 2);
        for (let i = 0; i < count; i++) {
          const family = choices[i], height = (i === 0 ? 65 + r(34) * 13 : 32 + r(35 + i) * 16) * config.harborScale;
          const layout = Math.floor(r(115) * 3), angles = [[-1.2, 1.1, 3], [-1.6, 1.05, -0.05], [-0.85, 1.65, 2.8]][layout];
          const angle = (angles[Math.max(0, i - 1)] ?? 0) + (r(116) - 0.5) * 0.4;
          const distance = 39 + r(117 + i) * 15;
          const sx = Math.round(x + (i === 0 ? 0 : Math.sin(angle) * distance));
          const sz = Math.round(z + (i === 0 ? 0 : Math.cos(angle) * distance) + (r(40 + i) - 0.5) * 9);
          const foot = height * (family === 'lion' ? 0.21 : family === 'eagle' ? 0.13 : 0.17);
          statues.push({ id: `${group}:${i}`, group, x: sx, z: sz, base: survey(sx, sz, foot + 2, config) + 3,
            height, family, pose: r(50 + i), stone: Math.floor(r(60 + i) * 4), crown: Math.floor(r(70 + i) * 3),
            spread: 0.84 + r(80 + i) * 0.34, lean: (r(90 + i) - 0.5) * 0.12, mirror: r(110 + i) > 0.5 ? 1 : -1 });
        }
      }
      const fz = z + Math.round((r(120) - 0.5) * 72), fr = harborChannel(fz, basin, config);
      const fx = Math.round(fr.center + fr.radius + 42 + r(121) * 20);
      if (r(122) < config.harborIndustry && fx > x0 - 55 && fx < x1 + 55 && fz > z0 - 55 && fz < z1 + 55) {
        factories.push({ id: group, x: fx, z: fz, base: survey(fx, fz, 30, config) + 1,
          variant: Math.floor(r(123) * 4), height: 42 + Math.floor(r(124) * 21), priority: r(125) });
      }
    }
  }
  return { statues: statues.sort((a, b) => a.id.localeCompare(b.id)), factories: factories.sort((a, b) => a.id.localeCompare(b.id)) };
}

export function generateHarborRegion(config: HarborConfig, includeDetails = true) {
  const width = Math.max(1, Math.floor(config.sizeX)), depth = Math.max(1, Math.floor(config.sizeZ));
  const ceiling = Math.max(1, Math.floor(Math.min(config.sizeY, config.yCutoff))), seed = Math.floor(config.seed);
  const ox = Math.floor(config.offsetX - width / 2), oz = Math.floor(config.offsetZ - depth / 2), layer = width * depth;
  const cells = new Uint16Array(layer * ceiling), terrain = new Float32Array(layer);
  const palette = [{ color: 0, emission: 0 }], ids = new Map<string, number>(), micros = new Map<number, number>();
  const plan = planColossusHarbor(config, 180);
  const buildings: { x: number; z: number; base: number; height: number; family: number; width: number; depth: number }[] = [];
  const transit: { x: number; y: number; z: number; bank: number }[] = [], boats: Point[] = [];
  const near = (x: number, z: number, rx: number, rz = rx) => x + rx >= ox && x - rx < ox + width && z + rz >= oz && z - rz < oz + depth;
  const get = (x: number, y: number, z: number) => x >= 0 && x < width && z >= 0 && z < depth && y >= 0 && y < ceiling ? cells[x + z * width + y * layer] : 0;
  const material = (color: number, emission = 0) => {
    if (!color) return 0;
    const key = `${color}:${emission}`, old = ids.get(key); if (old) return old;
    const id = palette.length; ids.set(key, id); palette.push({ color, emission }); return id;
  };
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, color: number, emission = 0) => {
    const x0 = Math.max(0, Math.floor(x) - ox), x1 = Math.min(width, Math.floor(x + w) - ox);
    const z0 = Math.max(0, Math.floor(z) - oz), z1 = Math.min(depth, Math.floor(z + d) - oz);
    const y0 = Math.max(0, Math.floor(y)), y1 = Math.min(ceiling, Math.floor(y + h));
    if (x0 >= x1 || z0 >= z1 || y0 >= y1) return;
    const id = material(color, emission);
    for (let iy = y0; iy < y1; iy++) for (let iz = z0; iz < z1; iz++) cells.fill(id, x0 + iz * width + iy * layer, x1 + iz * width + iy * layer);
  };
  const micro = (x: number, y: number, z: number, color: number, emission = 0) => {
    if (!includeDetails) return;
    x = Math.round(x * 8) / 8; y = Math.round(y * 8) / 8; z = Math.round(z * 8) / 8;
    if (x < ox || z < oz || x + M > ox + width || z + M > oz + depth || y < 0 || y + M > ceiling) return;
    const key = (x - ox) * 8 + (z - oz) * width * 64 + y * layer * 512;
    micros.set(key, ((color) | (emission > 0 ? 1 << 24 : 0)) >>> 0);
  };
  const line = (a: Point, b: Point, color: number, emission = 0) => {
    if (!includeDetails) return;
    if (!near((a.x + b.x) / 2, (a.z + b.z) / 2, Math.abs(a.x - b.x) / 2 + 1, Math.abs(a.z - b.z) / 2 + 1)) return;
    const n = Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z)) * 8);
    for (let i = 0; i <= n; i++) { const t = n ? i / n : 0; micro(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t, color, emission); }
  };
  const detail = (x: number, y: number, z: number, w: number, h: number, d: number, c: number, e = 0) => {
    if (!includeDetails) return;
    if (!near(x + w / 2, z + d / 2, w / 2 + 1, d / 2 + 1)) return;
    for (let dy = 0; dy < h; dy += M) for (let dz = 0; dz < d; dz += M) for (let dx = 0; dx < w; dx += M) {
      if (dx && dy && dz && dx + M < w && dy + M < h && dz + M < d) continue;
      micro(x + dx, y + dy, z + dz, c, e);
    }
  };
  const ellipsoid = (p: Point, rx: number, ry: number, rz: number, c: number, e = 0) => {
    if (!near(p.x, p.z, rx + 1, rz + 1)) return;
    for (let y = Math.max(0, Math.floor(p.y - ry)); y < Math.min(ceiling, p.y + ry); y++) {
      for (let z = Math.max(oz, Math.floor(p.z - rz)); z < Math.min(oz + depth, p.z + rz); z++) {
        for (let x = Math.max(ox, Math.floor(p.x - rx)); x < Math.min(ox + width, p.x + rx); x++) {
          if (((x + 0.5 - p.x) / rx) ** 2 + ((y + 0.5 - p.y) / ry) ** 2 + ((z + 0.5 - p.z) / rz) ** 2 <= 1) box(x, y, z, 1, 1, 1, c, e);
        }
      }
    }
  };
  const capsule = (a: Point, b: Point, ra: number, rb: number, c: number) => {
    const r = Math.max(ra, rb), dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, length2 = dx * dx + dy * dy + dz * dz;
    if (!near((a.x + b.x) / 2, (a.z + b.z) / 2, Math.abs(dx) / 2 + r + 1, Math.abs(dz) / 2 + r + 1)) return;
    for (let y = Math.max(0, Math.floor(Math.min(a.y, b.y) - r)); y < Math.min(ceiling, Math.max(a.y, b.y) + r); y++) {
      for (let z = Math.max(oz, Math.floor(Math.min(a.z, b.z) - r)); z < Math.min(oz + depth, Math.max(a.z, b.z) + r); z++) {
        for (let x = Math.max(ox, Math.floor(Math.min(a.x, b.x) - r)); x < Math.min(ox + width, Math.max(a.x, b.x) + r); x++) {
          const t = length2 ? clamp(((x + 0.5 - a.x) * dx + (y + 0.5 - a.y) * dy + (z + 0.5 - a.z) * dz) / length2) : 0;
          const radius = ra + (rb - ra) * t;
          if ((x + 0.5 - a.x - dx * t) ** 2 + (y + 0.5 - a.y - dy * t) ** 2 + (z + 0.5 - a.z - dz * t) ** 2 <= radius * radius) box(x, y, z, 1, 1, 1, c);
        }
      }
    }
  };
  // Faces use a micro-voxel skin around a standard-voxel interior. Refining only
  // boundary cells preserves the two resolutions without tessellating whole statues.
  const carvedEllipsoid = (p: Point, rx: number, ry: number, rz: number, c: number) => {
    if (!near(p.x, p.z, rx + 1, rz + 1)) return;
    const inside = (x: number, y: number, z: number) => ((x - p.x) / rx) ** 2 + ((y - p.y) / ry) ** 2 + ((z - p.z) / rz) ** 2 <= 1;
    for (let y = Math.max(0, Math.floor(p.y - ry)); y < Math.min(ceiling, p.y + ry); y++) {
      for (let z = Math.max(oz, Math.floor(p.z - rz)); z < Math.min(oz + depth, p.z + rz); z++) {
        for (let x = Math.max(ox, Math.floor(p.x - rx)); x < Math.min(ox + width, p.x + rx); x++) {
          const farX = Math.abs(x - p.x) > Math.abs(x + 1 - p.x) ? x : x + 1;
          const farY = Math.abs(y - p.y) > Math.abs(y + 1 - p.y) ? y : y + 1;
          const farZ = Math.abs(z - p.z) > Math.abs(z + 1 - p.z) ? z : z + 1;
          if (inside(farX, farY, farZ)) { box(x, y, z, 1, 1, 1, c); continue; }
          if (!inside(clamp(p.x, x, x + 1), clamp(p.y, y, y + 1), clamp(p.z, z, z + 1))) continue;
          if (!includeDetails) continue;
          for (let dz = 0; dz < 1; dz += M) for (let dy = 0; dy < 1; dy += M) for (let dx = 0; dx < 1; dx += M) {
            const xx = x + dx + M / 2, yy = y + dy + M / 2, zz = z + dz + M / 2;
            if (inside(xx, yy, zz) && (!inside(xx + M, yy, zz) || !inside(xx - M, yy, zz) || !inside(xx, yy + M, zz)
              || !inside(xx, yy - M, zz) || !inside(xx, yy, zz + M) || !inside(xx, yy, zz - M))) micro(x + dx, y + dy, z + dz, c);
          }
        }
      }
    }
  };
  const rail = (a: Point, b: Point) => {
    if (!includeDetails) return;
    for (const h of [0.625, 1.25]) line({ ...a, y: a.y + h }, { ...b, y: b.y + h }, C.bronze);
    const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 3);
    for (let i = 0; i <= n; i++) { const t = n ? i / n : 0, p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }; line(p, { ...p, y: p.y + 1.25 }, C.dark); }
  };
  const ring = (p: Point, r: number, c: number, e = 0, vertical = false) => {
    if (!includeDetails) return;
    if (!near(p.x, p.z, r + 1)) return;
    for (let a = 0; a < Math.PI * 2; a += M / r) micro(p.x + Math.cos(a) * r, p.y + (vertical ? Math.sin(a) * r : 0), p.z + (vertical ? 0 : Math.sin(a) * r), c, e);
  };
  const person = (x: number, y: number, z: number, variant: number) => {
    if (!includeDetails) return;
    for (const dx of [0, 0.375]) detail(x + dx, y, z, 0.25, 0.75, 0.25, C.dark);
    detail(x, y + 0.75, z, 0.625, 0.625, 0.375, [0x634c3a, 0x52626d, 0x72745b][variant % 3]);
    detail(x + 0.125, y + 1.375, z, 0.375, 0.375, 0.375, 0xb99775);
    for (const dx of [-0.125, 0.625]) detail(x + dx, y + 0.65, z, M, 0.625, 0.25, C.dark);
  };

  const rockIds = [C.rock, C.ledge, 0x5b5c50, 0x79705b, C.grass].map(c => material(c)), waterId = material(C.water);
  for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
    const wx = ox + x, wz = oz + z, s = sampleColossusHarbor(wx, wz, config); terrain[x + z * width] = s.height;
    const strata = Math.floor(fbm(wx / 230, wz / 270, seed, 130) * 8);
    for (let y = 0; y < Math.min(ceiling, s.height); y++) cells[x + z * width + y * layer] = rockIds[y === s.height - 1 && s.inland > 30 && hash(wx, wz, 131, seed) < 0.35 ? 4 : Math.floor((y + strata) / 5) % 9 === 0 ? 1 : Math.floor((y + strata) / 5) % 4 === 0 ? 2 : 0];
    if (s.water) for (let y = s.height; y < Math.min(WATER, ceiling); y++) cells[x + z * width + y * layer] = waterId;
    if (s.water && hash(wx, wz, 132, seed) < 0.014) line({ x: wx, y: WATER, z: wz }, { x: wx + 0.875, y: WATER, z: wz + 0.25 }, 0x87a1a2);
  }

  const stoneColors = [0xc3b697, 0xa8a899, 0xbcaa8c, 0x80908b];
  for (const s of plan.statues) {
    const H = s.height, base = s.base + 5, stone = stoneColors[s.stone], recess = tint(stone, 0.71), edge = tint(stone, 1.06);
    if (!near(s.x, s.z, H * 0.85)) continue;
    const p = (x: number, y: number, z: number): Point => ({ x: s.x + (x * s.mirror + y * s.lean) * H, y: base + y * H, z: s.z + z * H });
    const e = (x: number, y: number, z: number, rx: number, ry: number, rz: number, color = stone) => ellipsoid(p(x, y, z), rx * H, ry * H, rz * H, color);
    const fine = (x: number, y: number, z: number, rx: number, ry: number, rz: number, color = stone) => carvedEllipsoid(p(x, y, z), rx * H, ry * H, rz * H, color);
    const limb = (a: [number, number, number], b: [number, number, number], r: number, t = r, color = stone) => capsule(p(...a), p(...b), r * H, t * H, color);
    const groove = (a: [number, number, number], b: [number, number, number], color = recess) => line(p(...a), p(...b), color);
    const radius = Math.ceil(H * (s.family === 'lion' ? 0.23 : 0.18));
    box(s.x - radius - 2, 0, s.z - radius - 2, radius * 2 + 4, s.base + 1, radius * 2 + 4, C.rock);
    box(s.x - radius - 3, s.base, s.z - radius - 3, radius * 2 + 6, 2, radius * 2 + 6, C.trim);
    box(s.x - radius, s.base + 2, s.z - radius, radius * 2, 3, radius * 2, stone);
    for (let i = 0; i < 6; i++) box(s.x - 5 - i, s.base - i, s.z + radius + i, 10 + i * 2, 1, 1, C.trim);
    // Plinth inscription is relief, not a texture or a repeated word billboard.
    for (let i = -4; i <= 4; i++) if (hash(s.x, s.z, 140 + i, seed) > 0.2) detail(s.x + i, s.base + 2.5, s.z + radius, 0.25, 0.875, M, recess);
    for (const side of [-1, 1]) person(s.x + side * (radius - 2), s.base + 5, s.z + radius - 2, s.crown + (side > 0 ? 1 : 0));

    const face = (cy: number, cz: number, size = 1, helmet = false) => {
      fine(0, cy, cz, 0.061 * size, 0.082 * size, 0.058 * size);
      fine(0, cy - 0.032 * size, cz + 0.026 * size, 0.046 * size, 0.049 * size, 0.041 * size);
      // Brow, recessed eyes, cheekbones, nose bridge, lips and individual curls.
      for (const side of [-1, 1]) {
        limb([side * 0.012 * size, cy + 0.012 * size, cz + 0.05 * size], [side * 0.044 * size, cy + 0.015 * size, cz + 0.045 * size], 0.01 * size, 0.008 * size, edge);
        groove([side * 0.014 * size, cy + 0.004 * size, cz + 0.059 * size], [side * 0.037 * size, cy + 0.004 * size, cz + 0.055 * size]);
        fine(side * 0.034 * size, cy - 0.018 * size, cz + 0.043 * size, 0.024 * size, 0.023 * size, 0.013 * size);
        fine(side * 0.027 * size, cy + 0.004 * size, cz + 0.052 * size, 0.016 * size, 0.006 * size, 0.005 * size, recess);
        fine(side * 0.061 * size, cy - 0.007 * size, cz, 0.013 * size, 0.025 * size, 0.015 * size);
      }
      fine(0, cy - 0.008 * size, cz + 0.065 * size, 0.011 * size, 0.028 * size, 0.016 * size, edge);
      fine(0, cy - 0.024 * size, cz + 0.075 * size, 0.014 * size, 0.012 * size, 0.014 * size, edge);
      groove([-0.022 * size, cy - 0.042 * size, cz + 0.058 * size], [0.022 * size, cy - 0.042 * size, cz + 0.058 * size]);
      for (let a = 0; a < Math.PI * 2; a += 0.38) e(Math.cos(a) * 0.053 * size, cy + 0.038 * size, cz + Math.sin(a) * 0.043 * size - 0.005, 0.017 * size, 0.036 * size, 0.019 * size, recess);
      if (helmet) { e(0, cy + 0.047 * size, cz - 0.004, 0.068 * size, 0.055 * size, 0.064 * size, recess); limb([0, cy + 0.08 * size, cz - 0.04], [0, cy + 0.135 * size, cz + 0.025], 0.015 * size, 0.005 * size, stone); }
      else if (s.crown === 1) for (let i = -2; i <= 2; i++) limb([i * 0.021, cy + 0.065, cz + 0.034], [i * 0.024, cy + 0.1 - Math.abs(i) * 0.008, cz + 0.031], 0.006, 0.003, edge);
    };
    const wing = (side: number, y: number, span: number, bird = false) => {
      limb([side * 0.08, y, -0.02], [side * span * 0.55, y + 0.19, -0.04], 0.043, 0.026);
      limb([side * span * 0.55, y + 0.19, -0.04], [side * span, y + 0.3, -0.055], 0.026, 0.009);
      // Layered flight feathers have individually changing lengths and separated tips.
      for (let i = 0; i < 15; i++) {
        const t = i / 14, rootX = side * (0.09 + t * (span - 0.09)), rootY = y + t * 0.3;
        const endX = rootX + side * (0.045 + t * 0.032), endY = rootY - (0.13 + Math.sin(t * Math.PI) * (bird ? 0.14 : 0.1));
        limb([rootX, rootY, -0.04], [endX, endY, -0.012], 0.019 - t * 0.004, 0.003, i % 3 === 0 ? edge : stone);
        groove([rootX, rootY - 0.006, -0.005], [endX, endY + 0.01, 0.005], recess);
      }
      for (let i = 0; i < 11; i++) {
        const t = i / 11; limb([side * (0.08 + t * span * 0.8), y + t * 0.27, 0], [side * (0.12 + t * span * 0.8), y - 0.055 + t * 0.25, 0.01], 0.018, 0.006, edge);
      }
    };
    if (s.family === 'lion') {
      // Seated quadruped: haunches, a forward chest, paws, mane, muzzle and curved tail.
      e(0, 0.18, -0.045, 0.19, 0.21, 0.21); e(0, 0.37, 0.085, 0.15, 0.24, 0.14);
      for (const side of [-1, 1]) {
        e(side * 0.15, 0.13, -0.075, 0.105, 0.15, 0.155);
        limb([side * 0.085, 0.3, 0.16], [side * 0.11, 0.035, 0.23], 0.061, 0.04);
        e(side * 0.11, 0.029, 0.255, 0.068, 0.033, 0.102);
        for (let toe = -1; toe <= 1; toe++) groove([side * 0.11 + toe * 0.023, 0.049, 0.29], [side * 0.11 + toe * 0.023, 0.021, 0.34]);
      }
      e(0, 0.55, 0.12, 0.17, 0.18, 0.145, recess); e(0, 0.57, 0.21, 0.105, 0.112, 0.102);
      for (let a = 0; a < Math.PI * 2; a += 0.3) limb([Math.cos(a) * 0.12, 0.55 + Math.sin(a) * 0.14, 0.19], [Math.cos(a) * 0.145, 0.54 + Math.sin(a) * 0.17, 0.08], 0.025, 0.035, stone);
      for (const side of [-1, 1]) { e(side * 0.086, 0.68, 0.15, 0.033, 0.049, 0.031); e(side * 0.041, 0.533, 0.288, 0.046, 0.035, 0.038); groove([side * 0.025, 0.599, 0.297], [side * 0.075, 0.605, 0.27]); }
      e(0, 0.564, 0.307, 0.032, 0.021, 0.019, recess); groove([-0.07, 0.504, 0.28], [0.07, 0.504, 0.28]);
      limb([0.12, 0.09, -0.2], [0.26, 0.045, -0.23], 0.025, 0.02); limb([0.26, 0.045, -0.23], [0.29, 0.09, -0.06], 0.02, 0.017); e(0.29, 0.1, -0.05, 0.035, 0.035, 0.04, recess);
    } else if (s.family === 'eagle') {
      e(0, 0.23, -0.015, 0.115, 0.2, 0.105); e(0, 0.43, 0.025, 0.072, 0.076, 0.083);
      limb([0, 0.44, 0.072], [0, 0.414, 0.148], 0.035, 0.007, edge);
      for (const side of [-1, 1]) { wing(side, 0.31, s.spread * 0.55, true); limb([side * 0.044, 0.13, 0], [side * 0.048, 0.028, 0.037], 0.022, 0.013); for (let toe = -1; toe <= 1; toe++) limb([side * 0.05, 0.025, 0.04], [side * 0.05 + toe * 0.028, 0.01, 0.097], 0.011, 0.004); groove([side * 0.031, 0.451, 0.091], [side * 0.056, 0.446, 0.079]); }
      for (let i = -3; i <= 3; i++) limb([i * 0.018, 0.14, -0.07], [i * 0.026, 0.015, -0.21], 0.019, 0.007);
    } else {
      const seated = s.family === 'enthroned', atlas = s.family === 'atlas', robed = s.family === 'winged' || s.family === 'sage' || seated;
      const hip = seated ? 0.33 : atlas ? 0.39 : 0.45, shoulder = seated ? 0.65 : atlas ? 0.66 : 0.78;
      const head = seated ? 0.78 : atlas ? 0.77 : 0.9, chest = (hip + shoulder) * 0.5;
      const stance = 0.067 + s.pose * 0.025;
      for (const side of [-1, 1]) {
        const kneeZ = seated ? 0.16 : side < 0 ? 0.045 : -0.015;
        limb([side * stance, hip, 0], [side * stance * 1.2, seated ? 0.3 : 0.235, kneeZ], 0.069, 0.049);
        limb([side * stance * 1.2, seated ? 0.3 : 0.235, kneeZ], [side * stance * 1.25, 0.058, seated ? 0.17 : kneeZ + 0.02], 0.052, 0.029);
        e(side * stance * 1.25, 0.028, seated ? 0.195 : kneeZ + 0.045, 0.043, 0.032, 0.083);
      }
      e(0, hip, 0, 0.126, 0.1, 0.08); e(0, chest, -0.008, 0.121 + s.pose * 0.021, (shoulder - hip) * 0.6, 0.075);
      e(0, shoulder - 0.033, -0.004, 0.159, 0.078, 0.086); limb([0, shoulder, 0], [0, head - 0.07, 0.005], 0.038, 0.031);
      if (robed) {
        // A swept drapery field: varying hem, asymmetric folds, and layered mantle.
        for (let iy = 1; iy < hip * H; iy++) {
          const t = iy / (hip * H), rx = H * (0.17 - t * 0.055), rz = H * (0.098 - t * 0.026);
          for (let dz = -Math.ceil(rz + 2); dz <= rz + 2; dz++) for (let dx = -Math.ceil(rx + 2); dx <= rx + 2; dx++) {
            const angle = Math.atan2(dz / rz, dx / rx), rr = Math.hypot(dx / rx, dz / rz);
            const fold = 1 + Math.sin(angle * (9 + s.crown) + t * 1.5 + s.pose * 3) * 0.09;
            if (rr < fold) { const q = p(dx / H, iy / H, dz / H); box(q.x, q.y, q.z, 1, 1, 1, stone); }
          }
        }
        for (let i = -5; i <= 5; i++) {
          const x = i * 0.022; groove([x * 0.65, hip - 0.025, 0.077], [x * 1.35, 0.035 + Math.abs(i) * 0.003, 0.096 + (i % 2) * 0.012], i % 2 ? edge : recess);
          limb([-0.11 + i * 0.003, shoulder - 0.045 - (i + 5) * 0.008, 0.04], [0.078, hip + 0.017 + (i + 5) * 0.011, 0.065], 0.005, 0.005, edge);
        }
      } else {
        for (const side of [-1, 1]) { e(side * 0.06, shoulder - 0.065, 0.055, 0.069, 0.052, 0.034); for (let j = 0; j < 3; j++) e(side * 0.035, chest - j * 0.043, 0.057, 0.029, 0.031, 0.025); }
        // Short pleated armour skirt.
        for (let i = -3; i <= 3; i++) limb([i * 0.034, hip + 0.03, 0.066], [i * 0.043, hip - 0.12, 0.081], 0.021, 0.013, recess);
      }
      face(head, atlas ? 0.025 : 0, 1, s.family === 'guardian');
      if (s.family === 'sage') for (let i = -2; i <= 2; i++) limb([i * 0.016, head - 0.045, 0.043], [i * 0.01, head - 0.15 + Math.abs(i) * 0.015, 0.018], 0.012, 0.003, recess);
      for (const side of [-1, 1]) {
        let elbow: [number, number, number], hand: [number, number, number];
        if (atlas) { elbow = [side * 0.22, 0.73, 0.015]; hand = [side * 0.16, 0.89, -0.008]; }
        else if (seated) { elbow = [side * 0.19, 0.46, 0.035]; hand = [side * 0.19, 0.455, 0.17]; }
        else if (side > 0) { elbow = [0.225, shoulder - 0.08, 0.02]; hand = [0.27, shoulder + 0.09 + s.pose * 0.06, 0.035]; }
        else { elbow = [-0.22, shoulder - 0.15, 0.015]; hand = s.family === 'sage' ? [-0.095, hip + 0.14, 0.115] : [-0.245, shoulder - 0.03 + s.pose * 0.08, 0.1]; }
        limb([side * 0.143, shoulder - 0.025, 0], elbow, 0.039, 0.031); limb(elbow, hand, 0.033, 0.021);
        e(...hand, 0.028, 0.037, 0.02); for (let finger = -1; finger <= 2; finger++) groove([hand[0] + finger * 0.008, hand[1] - 0.016, hand[2] + 0.021], [hand[0] + finger * 0.008, hand[1] + 0.023, hand[2] + 0.021]);
      }
      if (s.family === 'winged') { wing(-1, 0.76, 0.51 * s.spread); wing(1, 0.76, 0.51 * s.spread); }
      if (s.family === 'guardian' || s.family === 'winged' || s.family === 'sage') {
        const tall = s.family === 'sage' ? 0.89 : 1.16;
        limb([0.27, 0.03, 0.035], [0.27, tall, 0.035], 0.007, 0.007, recess);
        if (s.family === 'winged') { for (const dx of [-0.033, 0, 0.033]) limb([0.27 + dx, tall - 0.08, 0.035], [0.27 + dx * 0.85, tall + (dx === 0 ? 0.035 : 0), 0.035], 0.008, 0.003, edge); limb([0.237, tall - 0.08, 0.035], [0.303, tall - 0.08, 0.035], 0.007); }
        else e(0.27, tall, 0.035, 0.022, 0.051, 0.016, edge);
      }
      if (seated) {
        const q = p(-0.22, 0.07, -0.16), q2 = p(0.22, 0.07, -0.16);
        box(Math.min(q.x, q2.x), q.y, q.z, H * 0.44, H * 0.73, H * 0.12, recess);
        for (const side of [-1, 1]) { limb([side * 0.22, 0.05, 0.16], [side * 0.22, 0.46, 0.16], 0.025); limb([side * 0.22, 0.46, -0.12], [side * 0.22, 0.46, 0.19], 0.028, 0.028, edge); }
      }
      if (atlas) { e(0, 1.01, -0.02, 0.2, 0.2, 0.2, recess); for (const t of [-0.1, 0, 0.1]) ring(p(0, 1.01 + t, -0.02), Math.sqrt(0.04 - t * t) * H + M, edge); ring(p(0, 1.01, 0.005), H * 0.202, edge, 0, true); }
    }
  }

  const steam = (x: number, y: number, z: number, radius: number, salt: number, dark = false) => {
    if (!includeDetails) return;
    if (config.harborSteam <= 0 || !near(x, z, radius + 18)) return;
    for (let dy = 0; dy < 27; dy += 0.625) {
      const r = radius * 0.5 + dy * 0.115, wind = dy * (0.15 + noise(x / 800, z / 800, seed, 201) * 0.3);
      for (let dz = -r; dz < r; dz += 0.75) for (let dx = -r; dx < r; dx += 0.75) {
        const rand = hash(Math.floor((x + dx) * 8), Math.floor((z + dz) * 8), salt + Math.floor(dy * 8), seed);
        const density = (1 - (dx * dx + dz * dz) / (r * r)) * (1 - dy / 31) * config.harborSteam;
        if (rand > density * 0.65) continue;
        const c = tint(dark ? 0x6e706b : C.smoke, 0.88 + rand * 0.22);
        for (const ax of [0, M]) for (const ay of [0, M]) for (const az of [0, M]) micro(x + dx + wind + ax + rand * 0.5, y + dy + ay, z + dz + az + rand * 0.5, c);
      }
    }
  };
  const pipe = (a: Point, b: Point, r: number, c = C.bronze) => capsule(a, b, r, r, c);
  for (const f of plan.factories) {
    if (!near(f.x, f.z, 48)) continue;
    const { x, z, base: y } = f, w = 62, d = 58;
    box(x - w / 2, 0, z - d / 2, w, y + 2, d, C.rock); box(x - w / 2, y, z - d / 2, w, 2, d, C.dark);
    box(x - 19, y + 2, z - 14, 29, 19, 26, C.brick); box(x - 21, y + 20, z - 16, 33, 2, 30, C.trim);
    for (let dx = -16; dx <= 7; dx += 4) for (let dy = 6; dy < 18; dy += 5) box(x + dx, y + dy, z + 12, 2, 2, 1, C.warm, 0.4);
    for (let i = 0; i < 2 + f.variant % 2; i++) {
      const cx = x + (i === 0 ? 18 : i === 1 ? -20 : 2), cz = z + (i === 0 ? 12 : -18), h = 24 + (f.variant + i) % 3 * 6, radius = 8 + i % 2;
      for (let dy = 0; dy < h; dy++) {
        const r = radius * (0.62 + Math.pow((dy / h - 0.62) / 0.82, 2) * 0.63);
        for (let dz = -Math.ceil(r + 1); dz <= r + 1; dz++) for (let dx = -Math.ceil(r + 1); dx <= r + 1; dx++) {
          const rr = Math.hypot(dx + 0.5, dz + 0.5);
          if (rr < r + (dy % 9 === 0 ? 0.5 : 0) && rr > r - 1.5) box(cx + dx, y + 2 + dy, cz + dz, 1, 1, 1, dy % 9 === 0 ? C.steel : C.brick);
        }
      }
      ring({ x: cx, y: y + h + 2, z: cz }, radius * 0.76, C.trim);
      steam(cx, y + h + 2, cz, radius, 210 + i);
    }
    for (let i = 0; i < 2; i++) {
      const cx = x + 13 + i * 9, cz = z - 19, h = f.height + i * 7;
      for (let dy = 0; dy < h; dy++) {
        const r = 2.8 - dy / h * 1.25;
        for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (Math.hypot(dx + 0.5, dz + 0.5) < r) box(cx + dx, y + 2 + dy, cz + dz, 1, 1, 1, dy % 13 < 2 ? C.steel : C.brick);
      }
      ring({ x: cx, y: y + h + 1, z: cz }, 1.7, C.warm, 0.65); steam(cx, y + h + 2, cz, 2, 230 + i, true);
    }
    for (let i = 0; i < 4; i++) {
      const p = { x: x - 26 + i * 3, y: y + 5, z: z + 24 }, q = { ...p, z: z - 7 }, t = { ...q, y: y + 27 + i * 2 };
      pipe(p, q, 0.8, i % 2 ? C.steel : C.bronze); pipe(q, t, 0.8, i % 2 ? C.steel : C.bronze);
      line({ ...p, y: p.y + 1 }, { ...q, y: q.y + 1 }, i % 2 ? C.cyan : C.warm, 0.8);
      line({ ...q, x: q.x + 1 }, { ...t, x: t.x + 1 }, i % 2 ? C.cyan : C.warm, 0.8);
    }
    rail({ x: x - 31, y: y + 2, z: z + 29 }, { x: x + 30, y: y + 2, z: z + 29 });
  }

  // Jittered, terrain-surveyed lots. Architecture changes with the district field,
  // with independent footprints, setbacks, bays, annexes, crowns and lit rooms.
  for (let iz = Math.floor((oz - 35) / 31); iz <= Math.ceil((oz + depth + 35) / 31); iz++) {
    for (let ix = Math.floor((ox - 35) / 31); ix <= Math.ceil((ox + width + 35) / 31); ix++) {
      const r = (s: number) => hash(ix, iz, s, seed), x = Math.round(ix * 31 + (r(300) - 0.5) * 9), z = Math.round(iz * 31 + (r(301) - 0.5) * 9);
      const s = sampleColossusHarbor(x, z, config), district = fbm(x / 430, z / 490, seed, 302);
      if (s.inland < 24 || s.inland > 170 || r(305) > config.harborCity * (0.65 + district * 0.5)) continue;
      const w = 12 + Math.floor(r(306) * 10), d = 12 + Math.floor(r(307) * 9), radius = Math.hypot(w, d) / 2;
      if (plan.statues.some(t => Math.hypot(t.x - x, t.z - z) < radius + t.height * 0.33 + 4)
        || plan.factories.some(f => Math.abs(f.x - x) < 34 + w / 2 && Math.abs(f.z - z) < 32 + d / 2)) continue;
      const ground = survey(x, z, Math.max(w, d) / 2, config), family = Math.floor(r(308) * 6);
      if (ground - s.height > 12) continue;
      const h = 14 + Math.floor(r(309) * 27 + district * 14), x0 = x - Math.floor(w / 2), z0 = z - Math.floor(d / 2), base = ground + 2;
      if (!near(x, z, radius + 4)) continue;
      buildings.push({ x, z, base, height: h, family, width: w, depth: d });
      const color = [0x8c8978, 0xa29376, 0x706f61, 0x92745c, 0x9c9983, 0x647879][Math.floor(r(310) * 6)];
      box(x0 - 1, 0, z0 - 1, w + 2, base, d + 2, C.rock); box(x0 - 2, base - 1, z0 - 2, w + 4, 1, d + 4, C.trim);
      const levels = family === 1 || family === 4 ? 3 : 1;
      for (let tier = 0; tier < levels; tier++) {
        const inset = tier * 2, yy = base + Math.floor(h * tier / levels), hh = Math.floor(h / levels), ww = w - inset * 2, dd = d - inset * 2;
        box(x0 + inset, yy, z0 + inset, ww, hh, dd, color);
        box(x0 + inset - 1, yy + hh - 1, z0 + inset - 1, ww + 2, 1, dd + 2, C.trim);
        const floor = 4 + Math.floor(r(311) * 2), bay = 3 + Math.floor(r(312) * 2);
        for (let dy = 2; dy < hh - 2; dy += floor) {
          for (let dx = 2; dx < ww - 1; dx += bay) for (const side of [0, dd - 1]) {
            const lit = hash(x + dx, z + side, yy + dy + 320, seed) > 0.57;
            box(x0 + inset + dx, yy + dy, z0 + inset + side, 1, 2, 1, lit ? C.warm : C.window, lit ? 0.35 + r(313) * 0.2 : 0);
            if (family === 3) detail(x0 + inset + dx - 0.25, yy + dy - 0.25, z0 + inset + side + (side ? 1 : -M), 1.5, M, M, C.trim);
          }
          for (let dz = 2; dz < dd - 1; dz += bay) for (const side of [0, ww - 1]) {
            const lit = hash(x + side, z + dz, yy + dy + 321, seed) > 0.62;
            box(x0 + inset + side, yy + dy, z0 + inset + dz, 1, 2, 1, lit ? C.warm : C.window, lit ? 0.4 : 0);
          }
        }
      }
      if (family === 0 || family === 5) {
        ellipsoid({ x, y: base + h, z }, w * 0.36, w * 0.39, d * 0.36, C.roof);
        box(x - 1, base + h, z - 1, 2, Math.ceil(w * 0.48), 2, C.trim);
      } else {
        box(x0 + 2, base + h, z0 + 3, 4, 3, 4, C.roof);
        for (let i = 0; i < 4; i++) detail(x0 + 2.25 + i * 0.75, base + h + 3, z0 + 3.25, M, M, 3.5, C.steel);
      }
      if (family === 2) {
        box(x0 - 2, base + 2, z0 + d, w + 4, 1, 3, C.roof);
        for (let dx = 1; dx < w; dx += 4) box(x0 + dx, base, z0 + d + 1, 1, 2, 1, C.trim);
      }
      if (r(314) < 0.28) {
        box(x0 + w - 3, base + h * 0.3, z0 + d, 2, 7, 1, C.dark);
        line({ x: x0 + w - 2, y: base + h * 0.3 + 0.5, z: z0 + d + 1 }, { x: x0 + w - 2, y: base + h * 0.3 + 6, z: z0 + d + 1 }, r(315) > 0.5 ? C.cyan : C.warm, 0.9);
      }
    }
  }

  // Continuous bank-following viaducts have actual ground-supported piers.
  for (let basin = Math.floor(ox / 620) - 1; basin <= Math.ceil((ox + width) / 620) + 1; basin++) {
    for (const bank of [-1, 1]) {
      // Quays follow the surveyed waterline; occasional finger piers reach the channel.
      for (let z = oz - 2; z <= oz + depth + 2; z++) {
        const r = harborChannel(z, basin, config), x = Math.round(r.center + bank * (r.radius + 2));
        if (!near(x, z, 15)) continue;
        box(x - 2, WATER - 3, z, 5, 7, 1, C.rock); box(x - 2, WATER + 4, z, 5, 1, 1, C.trim);
        if (z % 47 === 0) {
          box(x - (bank > 0 ? 13 : 0), WATER + 3, z - 2, 14, 2, 5, C.dark);
          for (const span of [4, 11]) box(x - bank * span, WATER - 4, z - 1, 1, 7, 3, C.bronze);
          person(x - bank * 7, WATER + 5, z, Math.abs(Math.floor(z / 47)) % 3);
          rail({ x, y: WATER + 5, z: z + 2 }, { x: x - bank * 12, y: WATER + 5, z: z + 2 });
        }
      }
      if (hash(basin, bank, 400, seed) > config.harborTransit) continue;
      for (let z = oz - 3; z < oz + depth + 3; z++) {
        const r = harborChannel(z, basin, config), x = Math.round(r.center + bank * (r.radius + 8));
        if (!near(x, z, 6)) continue;
        const y = 34 + Math.floor(noise(z / 300, basin * 3 + bank, seed, 401) * 6);
        box(x - 3, y, z, 7, 2, 1, C.trim); box(x - 2, y + 2, z, 5, 1, 1, C.dark);
        for (const side of [-2, 2]) { line({ x: x + side, y: y + 3.125, z }, { x: x + side, y: y + 3.125, z: z + 1 }, C.steel); line({ x: x + side * 1.625, y: y + 3.25, z }, { x: x + side * 1.625, y: y + 3.25, z: z + 1 }, C.bronze); }
        if (z % 22 === 0) { const ground = sampleColossusHarbor(x, z, config).height; box(x - 1, ground, z - 1, 3, Math.max(0, y - ground), 3, C.brick); box(x - 3, y - 2, z - 1, 7, 2, 3, C.brick); transit.push({ x, y, z, bank }); }
      }
      // A short static articulated tram stays aligned to the curved rail.
      for (let sector = Math.floor(oz / 240) - 1; sector <= Math.ceil((oz + depth) / 240); sector++) {
        if (hash(basin, sector, 405 + bank, seed) > 0.65) continue;
        const start = Math.floor(sector * 240 + hash(basin, sector, 408 + bank, seed) * 130);
        for (let i = 0; i < 16; i++) {
          const z = start + i, r = harborChannel(z, basin, config), x = Math.round(r.center + bank * (r.radius + 8));
          const y = 37 + Math.floor(noise(z / 300, basin * 3 + bank, seed, 401) * 6);
          box(x - 1, y, z, 3, 3, 1, i % 8 === 0 ? C.dark : C.stone);
          if (i % 4 < 2) for (const side of [-1, 1]) box(x + side, y + 1, z, 1, 1, 1, C.window);
          box(x - 1, y, z, 3, 1, 1, 0x985f48);
        }
      }
    }
    for (let sector = Math.floor(oz / 83) - 1; sector <= Math.ceil((oz + depth) / 83); sector++) {
      const r = (salt: number) => hash(basin, sector, salt, seed), z = Math.round(sector * 83 + r(430) * 37), river = harborChannel(z, basin, config);
      const x = Math.round(river.center + (r(431) - 0.5) * river.radius), length = 9 + Math.floor(r(432) * 8);
      if (!near(x, z, length)) continue;
      ellipsoid({ x, y: WATER + 1, z }, 2.7, 2, length / 2, C.dark); box(x - 2, WATER + 1, z - length / 2 + 2, 4, 1, length - 4, C.trim);
      box(x - 1, WATER + 2, z - 2, 2, 2, 4, C.stone); box(x - 1, WATER + 3, z, 2, 1, 1, C.window);
      line({ x, y: WATER + 4, z }, { x, y: WATER + 7, z }, C.bronze); boats.push({ x, y: WATER, z });
    }
  }

  return finishTerrainLabRegion(width, depth, ceiling, cells, palette, micros, (id, x, y, z) => {
    const p = palette[id];
    const stain = noise((x + ox) / 4.7 + y / 57, (z + oz) / 5.3, seed, 450) * 0.75 + hash(x + ox, z + oz, Math.floor(y / 7) + 451, seed) * 0.25;
    return p.emission > 0 || id === waterId ? p.color : tint(p.color, 1 + (stain - 0.5) * 0.26 * config.harborWear);
  });
}
