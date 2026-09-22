import { acceptsTerrainFeature, type TerrainFeaturePolicy } from './TerrainFeaturePolicy.ts';
// Ported from entropydrop_frontend/src/pages/terrainLab/titanCanyon.ts.
// Keep solid interiors for collisions and volumetric LOD; retain the original 1/8m details.
import { finishTerrainLabRegion } from './TerrainLabRegion.ts';
/** Coordinate-addressed river basins and terrain-fitted industrial installations.
 * All exported geometry: 1m / 0.125m cubes, normal / emissive materials.
 * X/Z are centres relative to the crop; Y is the cube's bottom in metres. */
export interface CanyonConfig extends TerrainFeaturePolicy {
  sizeX: number; sizeY: number; sizeZ: number;
  offsetX: number; offsetZ: number; yCutoff: number; seed: number;
  canyonDepth: number; canyonWidth: number; canyonIndustry: number;
  canyonGears: number; canyonWind: number; canyonPipes: number;
  canyonSteam: number; canyonWear: number; canyonGlow: number;
}
export const CANYON_DEFAULTS = {
  canyonDepth: 72, canyonWidth: 1, canyonIndustry: 0.8, canyonGears: 0.8,
  canyonWind: 0.7, canyonPipes: 0.8, canyonSteam: 0.65, canyonWear: 0.65, canyonGlow: 0.35,
};

export interface CanyonSite {
  id: string; x: number; z: number; base: number; rotation: number;
  family: number; radius: number; towerHeight: number; priority: number; bank: number; basin: number;
  mirror: boolean; alloy: number;
}
interface Point { x: number; y: number; z: number }
const M = 0.125, WATER = 15;
const C = {
  rock: 0x716259, shale: 0x54483f, ledge: 0x897568, darkRock: 0x483f3c,
  gravel: 0x726962, water: 0x496a7b, ripple: 0x8da4ae,
  floor: 0x3d4449, metal: 0x525e65, steel: 0x839097, bronze: 0x90744e,
  brass: 0xb3996a, concrete: 0x787d7c, dark: 0x252f36,
  cyan: 0x43d6ed, blue: 0x3ca1db, warm: 0xf5ae61, red: 0xcd5c3c, blade: 0xc8c3b1,
};
const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const smooth = (x: number) => { const t = clamp(x); return t * t * (3 - 2 * t); };
function hash(x: number, z: number, salt: number, seed: number) {
  let h = Math.imul(seed ^ 0x9e3779b9 ^ x, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16) ^ z, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13) ^ salt, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x: number, z: number, seed: number, salt = 0) {
  const ix = Math.floor(x), iz = Math.floor(z), u = smooth(x - ix), v = smooth(z - iz);
  const a = hash(ix, iz, salt, seed), b = hash(ix + 1, iz, salt, seed);
  const c = hash(ix, iz + 1, salt, seed), d = hash(ix + 1, iz + 1, salt, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
const fbm = (x: number, z: number, seed: number, salt: number) => noise(x, z, seed, salt) * 0.58
  + noise(x * 2.13 + 29, z * 2.13 - 17, seed, salt + 1) * 0.28
  + noise(x * 4.31 - 13, z * 4.31 + 31, seed, salt + 2) * 0.14;
const tint = (color: number, f: number) => {
  const c = (s: number) => Math.round(clamp(((color >> s) & 255) * f, 0, 255));
  return (c(16) << 16) | (c(8) << 8) | c(0);
};

/** Each catchment has its own nonperiodic centreline, width and regional uplift. */
export function canyonRiver(z: number, basin: number, config: CanyonConfig) {
  const seed = Math.floor(config.seed);
  const center = basin * 480 + (hash(basin, 0, 10, seed) - 0.5) * 120
    + (noise(z / 610, basin * 7.1 + 19, seed, 11) - 0.5) * 160
    + (noise(z / 173, basin * 13.7 - 7, seed, 12) - 0.5) * 66;
  const halfWidth = (66 + noise(z / 390, basin * 17 + 5, seed, 13) * 29) * clamp(config.canyonWidth, 0.7, 1.4);
  const riverWidth = 9 + noise(z / 280, basin * 3.9 + 41, seed, 14) * 9;
  return { center, halfWidth, riverWidth };
}

export function sampleTitanCanyon(x: number, z: number, config: CanyonConfig) {
  const seed = Math.floor(config.seed), basin = Math.round(x / 480);
  let nearest = Infinity, river = canyonRiver(z, basin, config), owner = basin;
  for (let i = basin - 1; i <= basin + 1; i++) {
    const candidate = canyonRiver(z, i, config), distance = Math.abs(x - candidate.center);
    if (distance < nearest) { nearest = distance; river = candidate; owner = i; }
  }
  const uplift = (fbm(x / 740, z / 850, seed, 30) - 0.5) * 20;
  const depth = clamp(config.canyonDepth, 44, 94), rim = WATER + depth + uplift;
  // Drainage gullies enter the main canyon at changing angles and intervals.
  const fold = fbm(x / 90 + z / 260, z / 110, seed, 35);
  const gully = Math.pow(1 - Math.abs(fold * 2 - 1), 20) * 11;
  const rough = (fbm(x / 24, z / 31, seed, 40) - 0.5) * 7;
  const t = clamp((nearest - river.riverWidth) / (river.halfWidth - river.riverWidth));
  const walls = smooth((t - 0.06) / 0.86);
  const raw = WATER - 4 + (rim - WATER + 4) * walls + (rough - gully) * Math.sin(t * Math.PI) + rough * t * 0.35;
  const layer = 3 + noise(x / 260, z / 310, seed, 45) * 3;
  const terrace = Math.floor(raw / layer) * layer;
  const height = Math.max(5, Math.floor(raw * 0.35 + terrace * 0.65));
  return { height, rim, riverDistance: nearest, ...river, basin: owner, water: height < WATER };
}

/** Installations occupy surveyed bank shelves; wind turbines use flatter uplands. */
export function planTitanCanyon(config: CanyonConfig, margin = 180): CanyonSite[] {
  const seed = Math.floor(config.seed), cache = new Map<string, CanyonSite>();
  const make = (basin: number, sector: number, bank: number) => {
    const id = `${basin}:${sector}:${bank}`, cached = cache.get(id); if (cached) return cached;
    const r = (s: number) => hash(basin * 2 + (bank > 0 ? 1 : 0), sector, s, seed);
    const z = Math.round((sector + (r(50) - 0.5) * 0.6) * 128), river = canyonRiver(z, basin, config);
    const x = Math.round(river.center + bank * river.halfWidth * (0.79 + r(51) * 0.13));
    const surface = sampleTitanCanyon(x, z, config);
    const site = { id, x, z, bank, basin, base: Math.floor(surface.height - 5), rotation: bank > 0 ? 1 : 3,
      family: Math.floor(r(52) * 5), radius: 23 + Math.floor(r(53) * 11),
      towerHeight: 34 + Math.floor(r(54) * 22), priority: r(55), mirror: r(56) < 0.5,
      alloy: Math.floor(fbm(x / 900, z / 1100, seed, 57) * 3 + r(58) * 3) % 3 };
    cache.set(id, site); return site;
  };
  const sites: CanyonSite[] = [];
  const x0 = config.offsetX - config.sizeX / 2 - margin, x1 = config.offsetX + config.sizeX / 2 + margin;
  const z0 = config.offsetZ - config.sizeZ / 2 - margin, z1 = config.offsetZ + config.sizeZ / 2 + margin;
  for (let basin = Math.floor(x0 / 480) - 1; basin <= Math.ceil(x1 / 480) + 1; basin++) {
    for (let sector = Math.floor(z0 / 128) - 1; sector <= Math.ceil(z1 / 128) + 1; sector++) for (const bank of [-1, 1]) {
      const a = make(basin, sector, bank);
      if (a.x < x0 - 60 || a.x > x1 + 60 || a.z < z0 - 60 || a.z > z1 + 60) continue;
      const district = fbm(a.x / 1300, a.z / 1100, seed, 58);
      if (a.priority > config.canyonIndustry * (0.75 + district * 0.35) || a.base < WATER + 20) continue;
      const conflict = [-1, 1].some(ds => {
        const b = make(basin, sector + ds, bank);
        return b.priority < a.priority && Math.hypot(a.x - b.x, a.z - b.z) < 90;
      });
      if (!conflict) sites.push(a);
    }
  }
  return sites.sort((a, b) => a.id.localeCompare(b.id));
}

export function generateCanyonRegion(config: CanyonConfig, includeDetails = true) {
  const width = Math.max(1, Math.floor(config.sizeX)), depth = Math.max(1, Math.floor(config.sizeZ));
  const ceiling = Math.max(1, Math.floor(Math.min(config.sizeY, config.yCutoff))), seed = Math.floor(config.seed);
  const ox = Math.floor(config.offsetX - width / 2), oz = Math.floor(config.offsetZ - depth / 2), layer = width * depth;
  const cells = new Uint16Array(layer * ceiling), terrain = new Float32Array(layer);
  const palette = [{ color: 0, emission: 0, weather: false }], ids = new Map<string, number>();
  const micros = new Map<number, number>();
  const sites = planTitanCanyon(config, 440).filter(s => acceptsTerrainFeature(config, s.x, s.z, 88)), gears: { site: string; radius: number; center: Point }[] = [];
  const cooling: { site: string; center: Point; height: number; radius: number }[] = [];
  const turbines: { x: number; y: number; z: number; height: number; radius: number; phase: number }[] = [];
  const bridges: { from: string; to: string; start: Point; end: Point }[] = [];
  let frame: CanyonSite | null = null;
  let activePalette: Map<number, number> | null = null;
  const transform = (x: number, z: number, w = 0, d = 0, node = frame) => {
    if (!node) return { x, z, w, d };
    if (node.mirror) x = -x - w;
    return node.rotation === 1 ? { x: node.x - z - d, z: node.z + x, w: d, d: w }
      : { x: node.x + z, z: node.z - x - w, w: d, d: w };
  };
  const near = (x: number, z: number, w: number, d: number) => x < ox + width && z < oz + depth && x + w > ox && z + d > oz;
  const get = (x: number, y: number, z: number) => x >= 0 && x < width && z >= 0 && z < depth && y >= 0 && y < ceiling ? cells[x + z * width + y * layer] : 0;
  const material = (color: number, emission: number, weather: boolean) => {
    if (!color) return 0;
    const key = `${color}:${emission}:${weather}`, old = ids.get(key); if (old) return old;
    const id = palette.length; ids.set(key, id); palette.push({ color, emission, weather }); return id;
  };
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, color: number, emission = 0, weather = true) => {
    const p = transform(x, z, w, d), x0 = Math.max(0, Math.floor(p.x - ox)), x1 = Math.min(width, Math.floor(p.x + p.w - ox));
    const z0 = Math.max(0, Math.floor(p.z - oz)), z1 = Math.min(depth, Math.floor(p.z + p.d - oz));
    const y0 = Math.max(0, Math.floor(y)), y1 = Math.min(ceiling, Math.floor(y + h));
    if (x0 >= x1 || z0 >= z1 || y0 >= y1) return;
    const id = material(activePalette?.get(color) ?? color, emission, weather);
    for (let iy = y0; iy < y1; iy++) for (let iz = z0; iz < z1; iz++) cells.fill(id, x0 + iz * width + iy * layer, x1 + iz * width + iy * layer);
  };
  const micro = (x: number, y: number, z: number, color: number, emission = 0) => {
    if (!includeDetails) return;
    const p = transform(x, z, M, M);
    x = Math.round(p.x * 8) / 8; z = Math.round(p.z * 8) / 8; y = Math.round(y * 8) / 8;
    if (x < ox || z < oz || x + M > ox + width || z + M > oz + depth || y < 0 || y + M > ceiling) return;
    const key = (x - ox) * 8 + (z - oz) * width * 64 + y * layer * 512;
    micros.set(key, ((activePalette?.get(color) ?? color) | (emission > 0 ? 1 << 24 : 0)) >>> 0);
  };
  const detail = (x: number, y: number, z: number, w: number, h: number, d: number, color: number, emission = 0) => {
    if (!includeDetails) return;
    const p = transform(x, z, w, d); if (!near(p.x, p.z, p.w, p.d)) return;
    for (let dy = 0; dy < h; dy += M) for (let dz = 0; dz < d; dz += M) for (let dx = 0; dx < w; dx += M) {
      if (dx && dy && dz && dx + M < w && dy + M < h && dz + M < d) continue;
      micro(x + dx, y + dy, z + dz, color, emission);
    }
  };
  const line = (a: Point, b: Point, color: number, emission = 0) => {
    if (!includeDetails) return;
    const p = transform(Math.min(a.x, b.x), Math.min(a.z, b.z), Math.abs(a.x - b.x) + 1, Math.abs(a.z - b.z) + 1);
    if (!near(p.x, p.z, p.w, p.d)) return;
    const length = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z));
    for (let i = 0; i <= length; i += M) {
      const t = length ? i / length : 0;
      micro(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t, color, emission);
    }
  };
  const brace = (a: Point, b: Point, thickness: number, color: number) => {
    const length = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z));
    for (let i = 0; i <= length; i++) {
      const t = length ? i / length : 0;
      box(Math.round(a.x + (b.x - a.x) * t), Math.round(a.y + (b.y - a.y) * t), Math.round(a.z + (b.z - a.z) * t), thickness, thickness, thickness, color);
    }
  };
  const rail = (a: Point, b: Point) => {
    if (!includeDetails) return;
    for (const dy of [0.625, 1.25]) line({ ...a, y: a.y + dy }, { ...b, y: b.y + dy }, C.bronze);
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    for (let i = 0; i <= length; i += 3) {
      const t = length ? i / length : 0, p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
      line(p, { ...p, y: p.y + 1.25 }, C.steel);
    }
  };
  const ring = (x: number, y: number, z: number, radius: number, color: number, emission = 0, horizontal = false) => {
    if (!includeDetails) return;
    for (let a = 0; a < Math.PI * 2; a += M / Math.max(1, radius)) {
      micro(x + Math.cos(a) * radius, horizontal ? y : y + Math.sin(a) * radius, horizontal ? z + Math.sin(a) * radius : z, color, emission);
    }
  };
  const pipe = (a: Point, b: Point, radius: number, color = C.metal) => {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const axis = Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) >= Math.abs(dz) ? 0 : Math.abs(dy) >= Math.abs(dz) ? 1 : 2;
    const length = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
    for (let i = 0; i <= length; i++) {
      const t = length ? i / length : 0, r = i % 11 < 1 ? radius + 0.6 : radius;
      for (let u = -Math.ceil(r); u <= r; u++) for (let v = -Math.ceil(r); v <= r; v++) {
        if (Math.hypot(u, v) > r) continue;
        box(Math.round(a.x + dx * t + (axis === 0 ? 0 : u)), Math.round(a.y + dy * t + (axis === 1 ? 0 : axis === 0 ? u : v)),
          Math.round(a.z + dz * t + (axis === 2 ? 0 : v)), 1, 1, 1, i % 11 < 1 ? C.steel : color);
      }
    }
  };

  // Layered erosion uses the same world sampler for surface, placement and water.
  const rockIds = [C.rock, C.shale, C.ledge, C.darkRock, C.gravel].map(c => material(c, 0, true));
  const waterId = material(C.water, 0, false);
  for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
    const wx = ox + x, wz = oz + z, s = sampleTitanCanyon(wx, wz, config), top = Math.min(ceiling, s.height);
    terrain[x + z * width] = s.height;
    const shift = Math.floor(fbm(wx / 180, wz / 210, seed, 80) * 10);
    const thickness = 4 + Math.floor(noise(wx / 470, wz / 430, seed, 83) * 3);
    for (let y = 0; y < top; y++) {
      const stratum = Math.floor((y + shift) / thickness);
      cells[x + z * width + y * layer] = rockIds[y >= s.height - 2 ? 4 : stratum % 7 === 0 ? 2 : stratum % 4 === 0 ? 1 : 0];
    }
    if (s.water) for (let y = s.height; y < Math.min(WATER, ceiling); y++) cells[x + z * width + y * layer] = waterId;
    if (s.height < WATER && hash(wx, wz, 84, seed) < 0.022) {
      line({ x: wx, y: WATER, z: wz }, { x: wx + M, y: WATER, z: wz + 0.75 }, C.ripple);
    }
  }

  const gear = (site: CanyonSite, x: number, y: number, z: number, radius: number, teeth: number, phase: number) => {
    for (let dy = -radius - 3; dy <= radius + 3; dy++) for (let dx = -radius - 3; dx <= radius + 3; dx++) {
      const rr = Math.hypot(dx + 0.5, dy + 0.5), angle = Math.atan2(dy + 0.5, dx + 0.5);
      const tooth = Math.cos(angle * teeth + phase) > 0.05 ? 2 : 0;
      if (rr > radius + tooth || rr < radius - 3) continue;
      box(x + dx, y + dy, z, 1, 1, 4, rr > radius - 0.75 ? C.bronze : C.metal);
    }
    const spokes = 6 + Math.floor(hash(site.x, site.z, 90, seed) * 4);
    for (let j = 0; j < spokes; j++) {
      const a = j / spokes * Math.PI * 2 + phase, q = a + 0.12;
      brace({ x: x + Math.cos(a) * 4, y: y + Math.sin(a) * 4, z: z + 1 },
        { x: x + Math.cos(q) * (radius - 2), y: y + Math.sin(q) * (radius - 2), z: z + 1 }, 2, C.bronze);
    }
    for (let dz = 0; dz < 6; dz++) for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
      const r = Math.hypot(dx + 0.5, dy + 0.5); if (r < (dz > 3 ? 3.5 : 5.5)) box(x + dx, y + dy, z + dz, 1, 1, 1, dz > 3 ? C.bronze : C.metal);
    }
    for (const r of [radius - 0.625, radius - 2.875, 4.5, 3.25]) ring(x, y, z + 4, r, C.brass);
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 18) detail(x + Math.cos(a) * (radius - 1.5), y + Math.sin(a) * (radius - 1.5), z + 4, 0.25, 0.25, 0.25, C.steel);
    ring(x, y, z + 6, 2.25, C.warm, 0.7);
    // Bearing pedestals connect the axle to the machinery floor.
    brace({ x: x - 5, y: site.base + 4, z: z + 4 }, { x: x - 1, y: y - 3, z: z + 4 }, 3, C.metal);
    brace({ x: x + 4, y: site.base + 4, z: z + 4 }, { x: x + 1, y: y - 3, z: z + 4 }, 3, C.metal);
    const p = transform(x, z); gears.push({ site: site.id, radius, center: { x: p.x, y, z: p.z } });
  };
  const steam = (x: number, y: number, z: number, radius: number, site: CanyonSite, salt: number) => {
    if (!includeDetails) return;
    if (config.canyonSteam <= 0) return;
    const drift = hash(site.x, site.z, salt, seed) * 0.25 + 0.12;
    for (let iy = 0; iy < 22; iy += 0.5) {
      const r = radius * 0.35 + iy * 0.13, cx = x + iy * drift, cz = z + iy * 0.07;
      for (let iz = -r; iz <= r; iz += 0.5) for (let ix = -r; ix <= r; ix += 0.5) {
        const radial = Math.hypot(ix, iz) / r;
        const rand = hash(Math.floor((site.x + ix) * 8), Math.floor((site.z + iz) * 8), salt + Math.floor(iy * 8), seed);
        const billow = 0.35 + noise(ix / 3 + site.x, iy / 4 + iz / 5, seed, salt + 30) * 0.9;
        const density = (1 - radial * radial) * (1 - iy / 27) * config.canyonSteam * billow;
        if (rand > density * 0.6) continue;
        const jitter = hash(Math.floor(ix * 8), Math.floor(iz * 8), salt + Math.floor(iy * 8) + 999, seed);
        const color = tint(0xc1ccd2, 0.8 + rand * 0.35);
        for (const dx of [0, M]) for (const dy of [0, M]) for (const dz of [0, M]) {
          micro(cx + ix + dx + jitter * 0.375, y + iy + dy + rand * 0.5, cz + iz + dz + (1 - jitter) * 0.375, color);
        }
      }
    }
  };
  const cooler = (site: CanyonSite, x: number, z: number, h: number, radius: number, salt: number) => {
    const base = site.base + 4;
    const profile = (t: number) => radius * (0.59 + Math.pow((t - 0.61) / 0.8, 2) * 0.68);
    for (let y = 4; y < h; y++) {
      const r = profile(y / h), collar = y < 7 || y > h - 3 || y % 13 === 0;
      for (let dz = -Math.ceil(r + 1); dz <= r + 1; dz++) for (let dx = -Math.ceil(r + 1); dx <= r + 1; dx++) {
        const rr = Math.hypot(dx + 0.5, dz + 0.5), outer = r + (collar ? 0.6 : 0);
        if (rr <= outer && rr > r - 1.7) box(x + dx, base + y, z + dz, 1, 1, 1, collar ? C.metal : C.concrete);
      }
    }
    const foot = profile(0.07), lip = profile(1);
    for (let j = 0; j < 12; j++) {
      const a = j / 12 * Math.PI * 2;
      brace({ x: x + Math.cos(a) * (foot + 1), y: base, z: z + Math.sin(a) * (foot + 1) },
        { x: x + Math.cos(a) * foot, y: base + 6, z: z + Math.sin(a) * foot }, 1, C.metal);
      line({ x: x + Math.cos(a) * lip, y: base + h, z: z + Math.sin(a) * lip },
        { x: x + Math.cos(a) * lip, y: base + h + 1, z: z + Math.sin(a) * lip }, C.steel);
      if (j % 3 === 0) micro(x + Math.cos(a) * lip, base + h + 1, z + Math.sin(a) * lip, C.red, 1);
    }
    for (const dy of [0, 0.625, 1.125]) ring(x, base + h + dy, z, lip, C.steel, 0, true);
    for (const t of [0.16, 0.5, 0.77]) ring(x, base + h * t, z, profile(t) + 0.8, C.bronze, 0, true);
    const p = transform(x, z); cooling.push({ site: site.id, center: { x: p.x, y: base, z: p.z }, height: h, radius });
    steam(x, base + h + 1, z, radius, site, salt);
  };
  const person = (x: number, y: number, z: number, variant: number) => {
    if (!includeDetails) return;
    const shirt = [C.metal, C.bronze, C.dark][variant % 3];
    for (const dx of [0, 0.375]) detail(x + dx, y, z, 0.25, 0.875, 0.25, C.dark);
    detail(x, y + 0.875, z, 0.625, 0.625, 0.375, shirt);
    detail(x + 0.125, y + 1.5, z, 0.375, 0.375, 0.375, C.gravel);
    detail(x + 0.125, y + 1.75, z - 0.125, 0.5, 0.125, 0.5, C.brass);
    detail(x - 0.25, y + 0.75, z, 0.25, 0.625, 0.25, shirt);
    detail(x + 0.625, y + 0.75, z, 0.25, 0.625, 0.25, shirt);
  };

  const visible = sites.filter(s => near(s.x - 58, s.z - 58, 116, 116));
  for (const site of visible) {
    frame = site;
    const alloy = [[0x525e65, 0x90744e, 0x787d7c], [0x505b64, 0x786b55, 0x7a807f], [0x4a504e, 0x8e684b, 0x827f76]][site.alloy];
    activePalette = new Map([[C.metal, alloy[0]], [C.bronze, alloy[1]], [C.concrete, alloy[2]]]);
    const { base: b, family: f } = site, r = (salt: number) => hash(site.x, site.z, salt, seed);
    const w = 62 + Math.floor(r(100) * 9), left = -Math.floor(w / 2), back = -27;
    // Quarried shelf and concrete raft bear on the natural cliff instead of floating.
    box(left, b + 4, back, w, ceiling, 58, 0);
    box(left, b - 10, back, w, 14, 58, C.darkRock);
    box(left - 1, b + 1, back - 1, w + 2, 3, 60, C.floor);
    for (let x = left + 2; x < left + w; x += 8) {
      box(x, b - 13, 28, 3, 17, 4, C.metal);
      brace({ x, y: b - 12, z: 28 }, { x, y: b + 1, z: 38 }, 2, C.bronze);
      const p = transform(x, 28), foot = sampleTitanCanyon(p.x, p.z, config).height - 2;
      box(x, foot, 28, 3, Math.max(1, b - foot), 3, C.metal);
    }
    box(left, b + 2, 30, w, 2, 11, C.floor);
    rail({ x: left, y: b + 4, z: 40.875 }, { x: left + w, y: b + 4, z: 40.875 });
    for (let x = left + 2; x < left + w - 2; x += 5) {
      if (r(x + 111) < 0.6) person(x + r(x + 112), b + 4, 35 + r(x + 113) * 3, Math.floor(r(x + 114) * 10));
      detail(x, b + 4, 40.75, 0.25, 0.625, M, C.warm, 0.7);
    }
    // Independent workshop proportions and facade divisions, not one copied prefab.
    const workshopHeight = 10 + Math.floor(r(120) * 10);
    box(left + 2, b + 4, back + 2, 18, workshopHeight, 20, C.metal);
    box(left + 1, b + workshopHeight + 4, back + 1, 20, 2, 22, C.bronze);
    for (let x = left + 4; x < left + 19; x += 4) {
      box(x, b + 4, back + 21, 2, 7, 1, C.dark);
      detail(x, b + 12, back + 22, 2, 0.375, M, C.warm, 0.8);
      box(x, b + 4, back + 22, 1, workshopHeight, 1, C.bronze);
    }
    for (let j = 0; j < 3; j++) {
      const x = left + 5 + j * 5;
      box(x, b + workshopHeight + 6, back + 5, 3, 3, 6, C.dark);
      for (let i = 0; i < 5; i++) detail(x, b + workshopHeight + 9, back + 5 + i, 3, M, 0.25, C.steel);
    }
    const gearRadius = f === 0 || f === 3 ? site.radius : Math.floor(site.radius * 0.77);
    if (r(130) < config.canyonGears) {
      gear(site, -2, b + gearRadius + 5, -17, gearRadius, 34 + Math.floor(r(131) * 9) * 2, r(132) * 3);
      if (f === 0) gear(site, -24, b + 18, 6, 12 + Math.floor(r(133) * 4), 26, r(134) * 3);
    }
    const count = f === 1 || f === 2 ? 2 : f === 4 ? 0 : 1;
    for (let j = 0; j < count; j++) cooler(site, 18, 12 - j * 25, site.towerHeight - j * 9, 10 + r(140 + j) * 2, 145 + j);
    // Reactor lens: a true hollow rim around an emissive voxel core.
    const rx = f === 2 ? -13 : -5, ry = b + 16, rz = 21, rr = f === 4 ? 8 : 10;
    for (let dy = -rr - 2; dy <= rr + 2; dy++) for (let dx = -rr - 2; dx <= rr + 2; dx++) {
      const radius = Math.hypot(dx + 0.5, dy + 0.5);
      if (radius <= rr + 1 && radius > rr - 2) box(rx + dx, ry + dy, rz, 1, 1, 3, C.metal);
      if (radius < rr * 0.52) box(rx + dx, ry + dy, rz + 1, 1, 1, 1, C.blue, 1.05, false);
    }
    for (const rad of [rr - 0.5, rr - 1.5, rr * 0.57]) for (const dz of [3, 3.125]) ring(rx, ry, rz + dz, rad, C.cyan, 1.4);
    brace({ x: rx - 7, y: b + 4, z: rz }, { x: rx - 4, y: ry - 6, z: rz }, 2, C.bronze);
    brace({ x: rx + 5, y: b + 4, z: rz }, { x: rx + 3, y: ry - 6, z: rz }, 2, C.bronze);
    if (r(155) < config.canyonPipes) for (let j = 0; j < 3; j++) {
      const a = { x: left + 4 + j * 4, y: b + 8, z: 25 }, elbow = { ...a, y: b + 26 + j * 3 };
      pipe(a, elbow, 1); pipe(elbow, { ...elbow, z: -10 }, 1);
      line({ ...a, z: a.z + 1.125 }, { ...elbow, z: elbow.z + 1.125 }, j === 2 ? C.warm : C.cyan, 1.1);
    }
    if (f === 4) {
      box(10, b + 4, 6, 17, 11, 18, C.metal);
      box(12, b + 4, 20, 13, 8, 5, 0);
      for (let i = 0; i < 3; i++) detail(13 + i * 4, b + 13, 24, 2, 0.375, M, C.warm, 0.8);
    }
    frame = null; activePalette = null;
  }

  // Irregular upland wind farms: reject steep terrain and occupied machinery yards.
  for (let j = Math.floor((oz - 12) / 39); j <= Math.ceil((oz + depth + 12) / 39); j++) {
    for (let i = Math.floor((ox - 12) / 39); i <= Math.ceil((ox + width + 12) / 39); i++) {
      const r = (s: number) => hash(i, j, 180 + s, seed);
      if (r(0) >= config.canyonWind * (0.65 + noise(i / 12, j / 12, seed, 183) * 0.35)) continue;
      const x = Math.round((i + (r(1) - 0.5) * 0.65) * 39), z = Math.round((j + (r(2) - 0.5) * 0.65) * 39);
      const s = sampleTitanCanyon(x, z, config);
      if (s.height < s.rim - 6 || sites.some(a => Math.abs(a.x - x) < 48 && Math.abs(a.z - z) < 49)) continue;
      const survey = [[-3, -3], [3, -3], [-3, 3], [3, 3]].map(([dx, dz]) => sampleTitanCanyon(x + dx, z + dz, config).height);
      if (Math.max(...survey) - Math.min(...survey) > 4) continue;
      const y = Math.max(s.height, ...survey), h = 17 + Math.floor(r(3) * 12), rotor = 22 + Math.floor(r(4) * 12), radius = 3.25 + r(5) * 2, phase = r(6) * Math.PI * 2;
      if (!near(x - radius - 2, z - radius - 2, radius * 2 + 4, radius * 2 + 4)
        || !acceptsTerrainFeature(config, x, z, radius + 6)) continue;
      turbines.push({ x, y, z, height: h + rotor, radius, phase });
      box(x - 3, Math.min(...survey) - 1, z - 3, 7, y - Math.min(...survey) + 3, 7, C.floor);
      for (const dx of [-2, 2]) for (const dz of [-2, 2]) brace({ x: x + dx, y: y + 2, z: z + dz }, { x, y: y + h, z }, 1, C.metal);
      for (const dy of [5, 10, h - 2]) box(x - 2, y + dy, z - 2, 5, 1, 5, C.bronze);
      box(x, y + 2, z, 1, h - 1, 1, C.dark);
      detail(x + 0.375, y + h, z + 0.375, 0.25, rotor + 1, 0.25, C.steel);
      // Three swept blade ribbons. Every sample is quantised to an eighth metre.
      if (includeDetails) for (let dy = 0; dy <= rotor; dy += M) {
        const t = dy / rotor, radiusAt = radius * Math.pow(Math.sin(t * Math.PI), 0.8);
        for (let blade = 0; blade < 3; blade++) {
          const angle = phase + blade * Math.PI * 2 / 3 + t * Math.PI * 1.3;
          for (let u = -0.25; u <= 0.25; u += M) {
            micro(x + 0.5 + Math.cos(angle) * radiusAt - Math.sin(angle) * u, y + h + dy,
              z + 0.5 + Math.sin(angle) * radiusAt + Math.cos(angle) * u, Math.abs(u) > 0.2 ? C.bronze : C.blade);
          }
        }
      }
      for (const t of [0.25, 0.5, 0.75]) for (let blade = 0; blade < 3; blade++) {
        const a = phase + blade * Math.PI * 2 / 3 + t * Math.PI * 1.3, rr = radius * Math.pow(Math.sin(t * Math.PI), 0.8);
        line({ x: x + 0.5, y: y + h + t * rotor, z: z + 0.5 }, { x: x + 0.5 + Math.cos(a) * rr, y: y + h + t * rotor, z: z + 0.5 + Math.sin(a) * rr }, C.steel);
      }
      micro(x + 0.5, y + h + rotor + 1, z + 0.5, C.red, 0.8);
    }
  }

  // Pipeline bridges use actual shelf ports and deterministic neighbour choices.
  const port = (a: CanyonSite): Point => {
    const p = transform(0, 36, 0, 0, a); return { x: p.x, y: a.base + 4, z: p.z };
  };
  const seen = new Set<string>();
  for (const a of sites) {
    const candidates = sites.filter(b => b.id !== a.id && Math.hypot(a.x - b.x, a.z - b.z) < 190)
      .sort((b, c) => Math.hypot(a.x - b.x, a.z - b.z) - Math.hypot(a.x - c.x, a.z - c.z) || b.id.localeCompare(c.id)).slice(0, 2);
    for (const b of candidates) {
      const [first, second] = a.id < b.id ? [a, b] : [b, a], id = `${first.id}/${second.id}`;
      if (seen.has(id)) continue; seen.add(id);
      if (hash(first.x + second.x, first.z + second.z, 220, seed) >= config.canyonPipes) continue;
      const start = port(first), end = port(second), length = Math.hypot(end.x - start.x, end.z - start.z);
      if (length < 12 || !near(Math.min(start.x, end.x) - 5, Math.min(start.z, end.z) - 5, Math.abs(end.x - start.x) + 10, Math.abs(end.z - start.z) + 10)) continue;
      if (!acceptsTerrainFeature(config, (start.x + end.x) / 2, (start.z + end.z) / 2, length / 2 + 8)) continue;
      bridges.push({ from: first.id, to: second.id, start, end });
      const px = -(end.z - start.z) / length, pz = (end.x - start.x) / length;
      const at = (t: number, side = 0, dy = 0): Point => ({ x: start.x + (end.x - start.x) * t + px * side, y: start.y + (end.y - start.y) * t + dy, z: start.z + (end.z - start.z) * t + pz * side });
      for (let i = 0; i <= length * 2; i++) {
        const p = at(i / (length * 2)); box(Math.floor(p.x) - 1, Math.floor(p.y) - 2, Math.floor(p.z) - 1, 3, 2, 3, C.floor);
      }
      for (const side of [-2, 2]) {
        pipe(at(0, side, -2), at(1, side, -2), 1);
        rail(at(0, side), at(1, side));
        line(at(0, side, -0.75), at(1, side, -0.75), side > 0 ? C.cyan : C.warm, 0.85);
      }
      const divisions = Math.ceil(length / 9);
      for (let i = 0; i < divisions; i++) for (const side of [-2, 2]) {
        brace(at(i / divisions, side, -2), at((i + 0.5) / divisions, side, -6), 1, C.bronze);
        brace(at((i + 0.5) / divisions, side, -6), at((i + 1) / divisions, side, -2), 1, C.bronze);
      }
    }
  }

  return finishTerrainLabRegion(width, depth, ceiling, cells, palette, micros, (id, x, y, z) => {
    const p = palette[id];
    const stain = hash(Math.floor((x + ox) / 3), Math.floor((z + oz) / 3), Math.floor(y / 11) + 300, seed);
    return p.weather && !p.emission ? tint(p.color, 1 + (stain - 0.5) * 0.16 * config.canyonWear) : p.color;
  });
}
