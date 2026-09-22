import { Chunk, CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from '../voxel/Chunk.ts';
import { BlockTypes } from '../voxel/BlockTypes.ts';
import { TORUS_SIZE_X, TORUS_SIZE_Z, TORUS_SPAWN_X, TORUS_SPAWN_Z } from '../torus/TorusWorld.ts';

/** Port of entropydrop_frontend/src/pages/terrainLab/aetherArchipelago.ts.
 * Preserves its world-addressed islands, castle grammar, bridges and vegetation.
 * Standard cells are solid 1m cubes; details use the authoritative 0.125m grid.
 * The nearest major island is aligned with the torus spawn for a safe landing.
 */
export interface AetherConfig {
  sizeX: number; sizeY: number; sizeZ: number;
  offsetX: number; offsetZ: number; yCutoff: number; seed: number;
  aetherScale: number; aetherDensity: number; aetherCastles: number;
  aetherForest: number; aetherCrystals: number; aetherWaterfalls: number;
  aetherBridges: number; aetherGlow: number;
}
export const AETHER_DEFAULTS = {
  aetherScale: 1, aetherDensity: 0.85, aetherCastles: 0.7,
  aetherForest: 0.7, aetherCrystals: 0.65, aetherWaterfalls: 0.7,
  aetherBridges: 0.75, aetherGlow: 0.35,
};
export interface AetherIsland {
  id: string; x: number; z: number; radius: number; stretch: number; angle: number;
  altitude: number; drop: number; priority: number; major: boolean;
  biome: number; role: 'citadel' | 'woodland' | 'village' | 'ruins' | 'sanctuary';
  style: number; rotation: number; landform: 'spire' | 'mesa' | 'ridge' | 'cleft';
}
const M = 0.125;
const C = {
  stone: 0x73777c, strata: 0x555c68, deep: 0x3b4350, soil: 0x61523b,
  grass: 0x627d36, moss: 0x435c33, leaf: 0x365426, lightLeaf: 0x627833,
  limestone: 0xaaa38c, masonry: 0x757a7f, shadow: 0x343d4b, roof: 0x3c4656,
  wood: 0x68513b, bark: 0x4d4030, gold: 0xa38b53, water: 0x398ea7,
  foam: 0x91ccd2, cyan: 0x7ae1ef, violet: 0xc091fc, warm: 0xffcf83, pink: 0xd283a7,
};
const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
function hash(x: number, z: number, salt: number, seed: number) {
  // Ordered mixing avoids the mirrored-coordinate collisions of x*A ^ z*B.
  let h = Math.imul((seed ^ 0x9e3779b9) ^ x, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16) ^ z, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13) ^ salt, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x: number, z: number, seed: number, salt = 0) {
  const ix = Math.floor(x), iz = Math.floor(z), dx = x - ix, dz = z - iz;
  const u = dx * dx * (3 - 2 * dx), v = dz * dz * (3 - 2 * dz);
  const a = hash(ix, iz, salt, seed), b = hash(ix + 1, iz, salt, seed);
  const c = hash(ix, iz + 1, salt, seed), d = hash(ix + 1, iz + 1, salt, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
function fbm(x: number, z: number, seed: number, salt: number) {
  return noise(x, z, seed, salt) * 0.57 + noise(x * 2.13 + 41, z * 2.13 - 17, seed, salt + 1) * 0.28
    + noise(x * 4.37 - 13, z * 4.37 + 57, seed, salt + 2) * 0.15;
}
const shade = (color: number, factor: number) => {
  const channel = (shift: number) => Math.round(clamp(((color >> shift) & 255) * factor, 0, 255));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
};

/** Variable-radius hard-core sampling. Cells only locate candidates; their
 * centres, acceptance and shapes do not repeat. Acceptance uses a fixed world
 * neighbourhood, so loading a different chunk cannot move an existing island. */
export function planAetherWorld(config: AetherConfig, margin = 160): AetherIsland[] {
  const seed = Math.floor(config.seed), scale = clamp(config.aetherScale, 0.75, 1.35);
  const density = clamp(config.aetherDensity), majorPitch = 168 * scale, minorPitch = 52 * scale;
  const majorCache = new Map<string, AetherIsland>(), minorCache = new Map<string, AetherIsland>();
  const make = (ix: number, iz: number, major: boolean) => {
    const cache = major ? majorCache : minorCache, key = `${ix}:${iz}`;
    const found = cache.get(key); if (found) return found;
    const r = (salt: number) => hash(ix, iz, salt + (major ? 0 : 500), seed);
    const pitch = major ? majorPitch : minorPitch;
    const x = Math.round((ix + (r(1) - 0.5) * 0.84) * pitch);
    const z = Math.round((iz + (r(2) - 0.5) * 0.84) * pitch);
    const biome = fbm(x / 850, z / 850, seed, 40);
    const population = fbm(x / 530 + 21, z / 530 - 37, seed, 70);
    const role = major && r(4) < config.aetherCastles ? 'citadel'
      : population > 0.58 && r(5) < 0.6 ? 'village' : r(6) < 0.26 ? 'ruins' : r(7) < 0.3 ? 'sanctuary' : 'woodland';
    const island: AetherIsland = {
      id: `${major ? 'L' : 'S'}:${ix}:${iz}`, x, z, major, role,
      radius: (major ? 40 + r(8) * 15 : 10 + r(8) * 10) * scale,
      stretch: 0.75 + r(9) * 0.35, angle: r(10) * Math.PI * 2,
      altitude: Math.floor((major ? 69 : 49) + r(11) * (major ? 13 : 25) + (biome - 0.5) * 12),
      drop: Math.floor((major ? 39 : 23) + r(12) * (major ? 19 : 14)),
      priority: r(13), biome, style: Math.floor(r(14) * 4), rotation: Math.floor(r(15) * 4),
      landform: (['spire', 'mesa', 'ridge', 'cleft'] as const)[Math.floor(r(16) * 4)],
    };
    cache.set(key, island); return island;
  };
  const majorPresent = (ix: number, iz: number) => {
    const a = make(ix, iz, true);
    if (a.priority > density * (0.6 + fbm(a.x / 1100, a.z / 1100, seed, 101) * 0.45)) return false;
    for (let j = iz - 1; j <= iz + 1; j++) for (let i = ix - 1; i <= ix + 1; i++) {
      const b = make(i, j, true);
      if (b.priority < a.priority && Math.hypot(b.x - a.x, b.z - a.z) < a.radius + b.radius + 20 * scale) return false;
    }
    return true;
  };
  const minorPresent = (ix: number, iz: number) => {
    const a = make(ix, iz, false);
    if (a.priority > density * (0.48 + fbm(a.x / 330, a.z / 330, seed, 110) * 0.62)) return false;
    const mx = Math.round(a.x / majorPitch), mz = Math.round(a.z / majorPitch);
    for (let j = mz - 1; j <= mz + 1; j++) for (let i = mx - 1; i <= mx + 1; i++) {
      const b = make(i, j, true);
      if (majorPresent(i, j) && Math.hypot(a.x - b.x, a.z - b.z) < a.radius + b.radius + 8 * scale) return false;
    }
    for (let j = iz - 1; j <= iz + 1; j++) for (let i = ix - 1; i <= ix + 1; i++) {
      const b = make(i, j, false);
      if (b.priority < a.priority && Math.hypot(b.x - a.x, b.z - a.z) < a.radius + b.radius + 7 * scale) return false;
    }
    return true;
  };
  const islands: AetherIsland[] = [];
  for (const major of [true, false]) {
    const pitch = major ? majorPitch : minorPitch;
    const x0 = Math.floor((config.offsetX - config.sizeX / 2 - margin) / pitch) - 1;
    const x1 = Math.ceil((config.offsetX + config.sizeX / 2 + margin) / pitch) + 1;
    const z0 = Math.floor((config.offsetZ - config.sizeZ / 2 - margin) / pitch) - 1;
    const z1 = Math.ceil((config.offsetZ + config.sizeZ / 2 + margin) / pitch) + 1;
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      if ((major ? majorPresent : minorPresent)(x, z)) islands.push(make(x, z, major));
    }
  }
  return islands.sort((a, b) => a.id.localeCompare(b.id));
}

/** Organic plan and fracture roots are sampled in absolute world coordinates. */
export function sampleAetherIsland(island: AetherIsland, x: number, z: number, seed: number) {
  const wx = x + (fbm(x / 31, z / 31, seed, 150) - 0.5) * 7;
  const wz = z + (fbm(x / 27 + 17, z / 27, seed, 160) - 0.5) * 7;
  const dx = wx - island.x, dz = wz - island.z, ca = Math.cos(island.angle), sa = Math.sin(island.angle);
  const u = (dx * ca + dz * sa) / island.radius, v = (-dx * sa + dz * ca) / (island.radius * island.stretch);
  const radial = Math.hypot(u, v);
  const lobes = 3 + Math.floor(hash(island.x, island.z, 175, seed) * 4);
  const phase = hash(island.x, island.z, 176, seed) * Math.PI * 2;
  const outline = 0.92 + (fbm(x / 12, z / 12, seed, 170) - 0.5) * 0.24 + Math.sin(Math.atan2(v, u) * lobes + phase) * 0.055;
  if (radial > outline) return null;
  if (!island.major && island.landform === 'cleft' && Math.abs(u + 0.13) < 0.12 && v > 0.22) return null;
  const inner = island.role === 'citadel' ? 0.6 : 0.22;
  const terraces = Math.floor((fbm(x / 17, z / 17, seed, 180) - 0.4) * 8);
  const surface = island.altitude + Math.round(terraces * clamp((radial - inner) / 0.3));
  const root1 = clamp(1 - Math.hypot(u + 0.18, v - 0.13));
  const root2 = clamp(1 - Math.hypot((u - 0.32) * 1.7, (v + 0.18) * 1.8));
  const keel = island.landform === 'mesa' ? clamp(1 - radial) ** 0.22 * 0.72
    : island.landform === 'ridge' ? clamp(1 - Math.abs(v) * 1.2) * clamp(1 - Math.abs(u)) ** 0.4
    : island.landform === 'cleft' ? Math.max(clamp(1 - Math.hypot(u + 0.38, v) * 1.45), clamp(1 - Math.hypot(u - 0.35, v - 0.15) * 1.6)) ** 0.6
    : Math.max(root1 ** 0.65, root2 ** 0.8 * 0.92);
  const fracture = fbm(x / 6, z / 6, seed, 190);
  const bottom = Math.max(3, Math.floor(surface - 4 - island.drop * keel - fracture * 6));
  return { surface, bottom, radial };
}

export function generateAetherRegion(config: AetherConfig, includeDetails = true) {
  const width = Math.max(1, Math.floor(config.sizeX)), depth = Math.max(1, Math.floor(config.sizeZ));
  const ceiling = Math.max(1, Math.floor(Math.min(config.sizeY, config.yCutoff)));
  const ox = Math.floor(config.offsetX - width / 2), oz = Math.floor(config.offsetZ - depth / 2), seed = Math.floor(config.seed);
  const layer = width * depth, cells = new Uint16Array(layer * ceiling);
  const palette = [{ color: 0, emission: 0 }], ids = new Map<string, number>();
  const micros = new Map<number, number>();
  const islands = planAetherWorld(config, 170);
  const bridges: { from: string; to: string; start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } }[] = [];
  const waterfalls: { island: string; x: number; z: number; top: number; bottom: number }[] = [];
  const castles: { island: string; style: number; towers: number; rotation: number }[] = [];
  let frame: { x: number; z: number; rotation: number } | null = null;
  let architecturalColors: Map<number, number> | null = null;
  const transform = (x: number, z: number, w: number, d: number) => {
    if (!frame) return { x, z, w, d };
    const { x: cx, z: cz, rotation: r } = frame;
    return r === 1 ? { x: cx - z - d, z: cz + x, w: d, d: w }
      : r === 2 ? { x: cx - x - w, z: cz - z - d, w, d }
      : r === 3 ? { x: cx + z, z: cz - x - w, w: d, d: w } : { x: cx + x, z: cz + z, w, d };
  };
  const near = (x: number, z: number, w: number, d: number) => x < ox + width && x + w > ox && z < oz + depth && z + d > oz;
  const inside = (x: number, y: number, z: number) => x >= 0 && x < width && z >= 0 && z < depth && y >= 0 && y < ceiling;
  const get = (x: number, y: number, z: number) => inside(x, y, z) ? cells[x + z * width + y * layer] : 0;
  const colorId = (color: number, emission: number) => {
    if (!color) return 0;
    const key = `${color}:${emission}`;
    let id = ids.get(key);
    if (id === undefined) { id = palette.length; palette.push({ color, emission }); ids.set(key, id); }
    return id;
  };
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, color: number, emission = 0) => {
    const r = transform(x, z, w, d);
    const x0 = Math.max(0, Math.floor(r.x - ox)), x1 = Math.min(width, Math.floor(r.x + r.w - ox));
    const z0 = Math.max(0, Math.floor(r.z - oz)), z1 = Math.min(depth, Math.floor(r.z + r.d - oz));
    const y0 = Math.max(0, Math.floor(y)), y1 = Math.min(ceiling, Math.floor(y + h));
    if (x0 >= x1 || z0 >= z1 || y0 >= y1) return;
    const id = colorId(architecturalColors?.get(color) ?? color, emission);
    for (let iy = y0; iy < y1; iy++) for (let iz = z0; iz < z1; iz++) cells.fill(id, x0 + iz * width + iy * layer, x1 + iz * width + iy * layer);
  };
  const micro = (x: number, y: number, z: number, color: number, intensity = 0) => {
    if (!includeDetails) return;
    const r = transform(x, z, M, M);
    x = Math.round(r.x * 8) / 8; z = Math.round(r.z * 8) / 8; y = Math.round(y * 8) / 8;
    if (!near(x, z, M, M) || x < ox || z < oz || x + M > ox + width || z + M > oz + depth || y < 0 || y + M > ceiling) return;
    const key = (x - ox) * 8 + (z - oz) * 8 * width * 8 + y * 8 * layer * 64;
    // RGB occupies the low 24 bits; the high byte carries the voxel material.
    micros.set(key, ((architecturalColors?.get(color) ?? color) | ((intensity > 0 ? 1 : 0) << 24)) >>> 0);
  };
  const detail = (x: number, y: number, z: number, w: number, h: number, d: number, color: number, emission = 0) => {
    if (!includeDetails) return;
    const r = transform(x, z, w, d);
    if (!near(r.x, r.z, r.w, r.d) || y >= ceiling || y + h <= 0) return;
    for (let iy = 0; iy < h; iy += M) for (let iz = 0; iz < d; iz += M) for (let ix = 0; ix < w; ix += M) {
      if (ix && iy && iz && ix + M < w && iy + M < h && iz + M < d) continue;
      micro(x + ix, y + iy, z + iz, color, emission);
    }
  };
  const stroke = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, color: number, emission = 0) => {
    if (!includeDetails || !near(Math.min(a.x, b.x) - M, Math.min(a.z, b.z) - M, Math.abs(b.x - a.x) + M * 2, Math.abs(b.z - a.z) + M * 2)) return;
    const length = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z));
    for (let t = 0; t <= length; t += M) {
      const f = length ? t / length : 0;
      micro(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f, color, emission);
    }
  };
  const cylinder = (x: number, y: number, z: number, radius: number, height: number, color: number, hollow = false) => {
    for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
      const distance = Math.hypot(dx, dz);
      if (distance > radius + 0.3 || (hollow && distance < radius - 1.5)) continue;
      box(x + dx, y, z + dz, 1, height, 1, color);
    }
  };
  const crystal = (x: number, y: number, z: number, height: number, radius: number, violet: boolean) => {
    const color = violet ? C.violet : C.cyan;
    const r = transform(x - radius * 1.5, z - radius * 1.5, radius * 3 + 1, radius * 3 + 1);
    if (!near(r.x, r.z, r.w, r.d)) return;
    // Standard-block core, with 1/8m faceted surfaces and a tapering mineral tip.
    box(x, y, z, 1, Math.floor(height * 0.4), 1, color, 1.1);
    if (!includeDetails) return;
    const extent = Math.ceil(radius * 1.5 * 8) / 8;
    const crossSection = (dy: number) => Math.max(0, radius * Math.min(1, (height - dy) / (height * 0.52)) * 1.35);
    for (let dy = 0; dy < height; dy += M) {
      const limit = crossSection(dy), next = crossSection(dy + M);
      for (let dz = -extent; dz <= extent; dz += M) for (let dx = -extent; dx <= extent; dx += M) {
        const distance = Math.abs(dx + M / 2) + Math.abs(dz + M / 2);
        if (distance > limit || (dy > 0 && distance + M < limit && distance < next)) continue;
        const lit = dx + dz > 0;
        micro(x + 0.5 + dx, y + dy, z + 0.5 + dz, shade(color, lit ? 0.85 : 0.48), lit ? 1.25 : 0);
      }
    }
    stroke({ x: x + 0.5, y: y + height * 0.48, z: z + radius * 1.35 + 0.5 }, { x: x + 0.5, y: y + height - M, z: z + 0.5 }, color, 1.8);
  };
  const tree = (x: number, y: number, z: number, tall: boolean, salt: number) => {
    const random = (s: number) => hash(x, z, salt + s, seed);
    const h = 5 + Math.floor(random(1) * 5), radius = 2 + Math.floor(random(2) * 2);
    box(x, y, z, 1, h, 1, C.bark);
    if (tall) {
      for (let dy = 2; dy < h + 4; dy++) {
        const r = Math.max(0, Math.floor((h + 4 - dy) * 0.42));
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (Math.abs(dx) + Math.abs(dz) <= r * 1.5) box(x + dx, y + dy, z + dz, 1, 1, 1, dy % 3 ? C.leaf : C.lightLeaf);
      }
    } else {
      for (let branch = 0; branch < 3; branch++) {
        const bx = x + Math.round((random(10 + branch) - 0.5) * 5), bz = z + Math.round((random(20 + branch) - 0.5) * 5);
        const by = y + h - 2 + branch;
        box(Math.min(x, bx), by, Math.min(z, bz), Math.abs(x - bx) + 1, 1, Math.abs(z - bz) + 1, C.bark);
        for (let dy = -1; dy <= 2; dy++) for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
          if ((dx * dx + dz * dz) / (radius * radius) + dy * dy / 5 > 1.3 + random(30 + dx + dz * 11) * 0.3) continue;
          box(bx + dx, by + dy, bz + dz, 1, 1, 1, shade(dy > 0 ? C.lightLeaf : C.leaf, 0.85 + random(dx + dz * 7 + dy * 13 + 50) * 0.3));
        }
      }
    }
  };
  const cottage = (x: number, y: number, z: number, salt: number) => {
    const w = 5 + salt % 3, d = 6 + salt % 2;
    box(x, y - 3, z, w, 3, d, C.masonry);
    box(x, y, z, w, 5, d, C.limestone);
    box(x + 1, y + 1, z + 1, w - 2, 3, d - 2, 0);
    box(x + 2, y, z + d - 1, 1, 3, 1, C.wood);
    for (let u = 1; u < w - 1; u += 3) box(x + u, y + 2, z + d - 1, 1, 1, 1, C.warm, 0.8);
    for (let dy = 0; dy < 5; dy++) {
      const inset = Math.floor(dy * 0.7);
      if (w + 2 - inset * 2 > 0) box(x - 1 + inset, y + 5 + dy, z - 1, w + 2 - inset * 2, 1, d + 2, salt % 2 ? C.roof : C.wood);
    }
    box(x + w - 2, y + 5, z + 1, 1, 5, 1, C.masonry);
  };

  // Rock, strata, overhangs and topsoil. There is deliberately no ground plane.
  const visibleIslands = islands.filter(i => near(i.x - i.radius - 8, i.z - i.radius - 8, i.radius * 2 + 16, i.radius * 2 + 16));
  for (const island of visibleIslands) {
    const radius = Math.ceil(island.radius + 6);
    for (let z = Math.max(oz, island.z - radius); z < Math.min(oz + depth, island.z + radius); z++) {
      for (let x = Math.max(ox, island.x - radius); x < Math.min(ox + width, island.x + radius); x++) {
        const sample = sampleAetherIsland(island, x, z, seed); if (!sample) continue;
        const { surface, bottom } = sample;
        for (let y = bottom; y < Math.min(ceiling, surface); y++) {
          const strata = Math.floor((y + fbm(x / 21, z / 21, seed, 205) * 5) / 4);
          const fracture = noise(x / 5 + y * 0.09, z / 6 - y * 0.07, seed, 208);
          if (y < surface - 7 && y > bottom + 3 && fracture > 0.83) continue;
          const base = y === surface - 1 ? (island.biome > 0.53 ? C.moss : C.grass)
            : y > surface - 4 ? C.soil : strata % 6 === 0 ? C.strata : y < bottom + 4 ? C.deep : C.stone;
          const factor = Math.round((0.82 + hash(x, z, y + 200, seed) * 0.16 + noise(x / 7, z / 7, seed, strata) * 0.14) * 16) / 16;
          cells[x - ox + (z - oz) * width + y * layer] = colorId(shade(base, factor), 0);
        }
      }
    }
  }

  const archWindow = (x: number, y: number, z: number, w: number, h: number, glow: number, color: number) => {
    for (let dy = 0; dy < h; dy++) {
      const inset = Math.max(0, dy - h + 3);
      const span = w - inset * 2; if (span <= 0) continue;
      box(x + inset, y + dy, z, span, 1, 1, C.shadow);
      detail(x + inset + 0.25, y + dy + 0.125, z + 1, Math.max(0.125, span - 0.5), 0.75, M, color, glow);
    }
    for (let u = 0; u <= w; u += Math.max(1, Math.floor(w / 2))) detail(x + u - M, y, z + 1.125, M, h - Math.max(0, u === w / 2 ? 1 : 2), M, C.limestone);
  };
  const tower = (x: number, y: number, z: number, radius: number, height: number, salt: number) => {
    cylinder(x, y - 4, z, radius + 1, 6, C.masonry);
    cylinder(x, y + 2, z, radius, height - 2, C.masonry, true);
    for (let dy = 6; dy < height - 3; dy += 7) {
      cylinder(x, y + dy, z, radius + 1, 1, C.limestone, true);
      archWindow(x - 1, y + dy + 1, z + radius, 3, 5, 0.7, (dy + salt) % 3 ? C.warm : C.cyan);
      // Slit windows on all four elevations, not only the camera-facing facade.
      box(x + radius, y + dy + 2, z, 1, 3, 1, C.shadow);
      detail(x + radius + 1, y + dy + 2.25, z + 0.25, M, 1.5, 0.5, C.warm, 0.8);
      box(x - radius, y + dy + 2, z, 1, 3, 1, C.shadow);
      detail(x - radius - M, y + dy + 2.25, z + 0.25, M, 1.5, 0.5, C.warm, 0.8);
    }
    cylinder(x, y + height, z, radius + 1, 2, C.limestone);
    const spire = 10 + radius * 2 + salt % 6;
    for (let dy = 0; dy < spire; dy++) cylinder(x, y + height + 2 + dy, z, Math.max(0, Math.floor((radius + 1) * (1 - dy / spire))), 1, dy % 6 ? C.roof : C.gold);
    detail(x + 0.375, y + height + spire + 2, z + 0.375, 0.25, 3, 0.25, C.gold);
    for (const [dx, dz] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius]]) {
      box(x + dx, y + height - 1, z + dz, 1, 4, 1, C.limestone);
    }
  };
  const castle = (island: AetherIsland) => {
    frame = { x: island.x, z: island.z, rotation: island.rotation };
    const b = island.altitude, rand = (s: number) => hash(island.x, island.z, s, seed);
    const stonePalette = [[0x757a7f, 0xaaa38c, 0x3c4656], [0x8b806d, 0xb8a582, 0x445458], [0x69717b, 0x969dac, 0x494158], [0x807b70, 0xb4b095, 0x5e4940]][Math.floor(rand(309) * 4)];
    architecturalColors = new Map([[C.masonry, stonePalette[0]], [C.limestone, stonePalette[1]], [C.roof, stonePalette[2]]]);
    const w = island.style === 0 ? 22 : island.style === 1 ? 12 : 16;
    const d = island.style === 0 ? 18 : island.style === 1 ? 28 : 22 + Math.floor(rand(308) * 3) * 2;
    const wallHeight = (island.style === 0 ? 17 : 23) + Math.floor(rand(310) * 10);
    box(-w / 2 - 2, b - 2, -d / 2 - 3, w + 4, 6, d + 6, C.masonry);
    box(-w / 2, b + 4, -d / 2, w, wallHeight, d, C.masonry);
    box(-w / 2 + 2, b + 5, -d / 2 + 2, w - 4, wallHeight - 2, d - 4, 0);
    for (let dy = 0; dy < 8; dy++) box(-2 + Math.max(0, dy - 5), b + 4 + dy, d / 2 - 2, 4 - Math.max(0, dy - 5) * 2, 1, 2, 0);
    for (let x = -w / 2 + 1; x < w / 2; x += 5) archWindow(x, b + 15, d / 2 - 1, 3, 8, 1, C.cyan);
    for (let z = -d / 2; z < d / 2; z += 6) {
      box(-w / 2 - 2, b, z, 2, wallHeight + 5, 2, C.limestone);
      box(w / 2, b, z, 2, wallHeight + 5, 2, C.limestone);
      // Side aisle glazing and stepped flying buttresses.
      box(w / 2 - 1, b + 9, z + 2, 1, 8, 2, C.shadow);
      detail(w / 2, b + 9.25, z + 2.25, M, 6, 1.25, C.cyan, 0.75);
      for (let j = 0; j < 5; j++) {
        box(w / 2 + j, b + 15 - j, z, 1, 2, 2, C.limestone);
        box(-w / 2 - j - 1, b + 15 - j, z, 1, 2, 2, C.limestone);
      }
      box(w / 2 + 4, b, z, 2, 13, 2, C.masonry);
      box(-w / 2 - 6, b, z, 2, 13, 2, C.masonry);
    }
    for (let dy = 0; dy < (island.style === 0 ? 2 : 11); dy++) {
      const inset = Math.floor(dy * 0.7);
      if (w + 2 > inset * 2) box(-w / 2 - 1 + inset, b + wallHeight + 4 + dy, -d / 2 - 1, w + 2 - inset * 2, 1, d + 2, dy % 4 ? C.roof : C.gold);
    }
    if (island.style === 0) {
      for (let x = -w / 2; x < w / 2; x += 3) {
        box(x, b + wallHeight + 6, -d / 2, 1, 2, 1, C.limestone);
        box(x, b + wallHeight + 6, d / 2, 1, 2, 1, C.limestone);
      }
    }
    // Rose window: coloured glass sectors and stone tracery assembled from micro cubes.
    const roseY = b + wallHeight - 1;
    if (includeDetails) for (let v = -2.5; v <= 2.5; v += M) for (let u = -2.5; u <= 2.5; u += M) {
      const r = Math.hypot(u, v); if (r > 2.5) continue;
      const spoke = Math.abs(Math.sin(Math.atan2(v, u) * 4)) < 0.18;
      micro(u, roseY + v, d / 2 + M, r > 2.2 || spoke ? C.limestone : u * v > 0 ? C.cyan : C.violet, r > 2.2 || spoke ? 0 : 1.2);
    }
    const towers = 4 + island.style;
    const positions = [[-11, -11, 4], [11, -9, 4], [-11, 11, 3], [11, 12, 3], [0, -7, 4], [-18, 0, 3], [18, -2, 3]];
    for (let i = 0; i < towers; i++) {
      const [px, pz, radius] = positions[i];
      const x = px + Math.floor(rand(335 + i) * 3) - 1, z = pz + Math.floor(rand(345 + i) * 3) - 1;
      const height = i === 0 ? 45 + Math.floor(rand(330) * 10) : 25 + Math.floor(rand(331 + i) * 17);
      tower(x, b, z, radius, height, i + island.style);
    }
    // Asymmetric lower wings and arcaded terraces make a inhabited compound,
    // not a ring of identical turrets. The wing dimensions are independently seeded.
    const wings = [
      { x: w / 2 + 5, z: -13, w: 9 + Math.floor(rand(390) * 5), d: 18, h: 13 + Math.floor(rand(391) * 5) },
      { x: -w / 2 - 16, z: 1, w: 12, d: 13 + Math.floor(rand(392) * 6), h: 10 + Math.floor(rand(393) * 5) },
    ];
    if (island.style > 1) wings.push({ x: -12, z: -27, w: 25, d: 9, h: 12 });
    for (const wing of wings) {
      box(wing.x - 1, b - 5, wing.z - 1, wing.w + 2, 7, wing.d + 2, C.masonry);
      box(wing.x, b + 2, wing.z, wing.w, wing.h, wing.d, C.masonry);
      box(wing.x + 2, b + 3, wing.z + 2, wing.w - 4, wing.h - 2, wing.d - 4, 0);
      for (let u = 1; u < wing.w - 2; u += 4) archWindow(wing.x + u, b + 5, wing.z + wing.d - 1, 3, 6, 0.65, C.warm);
      for (let dy = 0; dy < 7; dy++) {
        const inset = Math.floor(dy * 0.7);
        if (wing.w + 2 > inset * 2) box(wing.x - 1 + inset, b + wing.h + 2 + dy, wing.z - 1, wing.w + 2 - inset * 2, 1, wing.d + 2, C.roof);
      }
      box(wing.x - 1, b + wing.h + 1, wing.z - 1, wing.w + 2, 1, wing.d + 2, C.limestone);
    }
    // A raised arched walk joins two unequal gate towers across the courtyard.
    const terraceZ = 22 + island.style % 2;
    for (let u = -19; u <= 17; u += 6) {
      box(u, b - 3, terraceZ, 2, 10, 3, C.masonry);
      for (let step = 0; step < 3; step++) {
        box(u + 2 + step, b + 3 + step, terraceZ, 1, 1, 3, C.limestone);
        box(u + 5 - step, b + 3 + step, terraceZ, 1, 1, 3, C.limestone);
      }
    }
    box(-19, b + 7, terraceZ, 40, 2, 3, C.limestone);
    for (let u = -19; u < 21; u += 3) box(u, b + 9, terraceZ + 2, 1, 1, 1, C.masonry);
    tower(-20, b, terraceZ, 2, 17 + island.style, 5);
    tower(20, b, terraceZ, 2, 22 + Math.floor(rand(398) * 7), 7);
    // A paved round forecourt carries an inset luminous seal and low stone rim.
    cylinder(0, b - 1, 22, 7, 1, C.limestone);
    for (let a = 0; a < Math.PI * 2; a += 0.025) {
      for (const r of [4, 5.5]) micro(Math.cos(a) * r, b, 22 + Math.sin(a) * r, C.violet, 0.8);
    }
    // Approach stair, terraced courtyard and a luminous circular waystone.
    for (let i = 0; i < 5; i++) box(-3, b + 3 - i, d / 2 + i, 6, 1, 1, C.limestone);
    frame = null;
    architecturalColors = null;
    castles.push({ island: island.id, style: island.style, towers: towers + 2, rotation: island.rotation });
  };

  for (const island of visibleIslands) {
    const rand = (s: number) => hash(island.x, island.z, s, seed), sample = (x: number, z: number) => sampleAetherIsland(island, x, z, seed);
    if (island.role === 'citadel') castle(island);
    // Plants are scattered through a hashed fine grid, with canopy-safe spacing.
    const r = Math.ceil(island.radius + 5);
    for (let gz = Math.floor((island.z - r) / 7); gz <= Math.ceil((island.z + r) / 7); gz++) for (let gx = Math.floor((island.x - r) / 7); gx <= Math.ceil((island.x + r) / 7); gx++) {
      const x = gx * 7 + Math.floor(hash(gx, gz, 350, seed) * 5), z = gz * 7 + Math.floor(hash(gx, gz, 351, seed) * 5);
      const s = sample(x, z); if (!s || s.radial > 0.8 || (island.role === 'citadel' && s.radial < 0.76)) continue;
      const choice = hash(gx, gz, 352, seed);
      if (island.role === 'village' && choice < 0.2 && s.radial < 0.55) cottage(x - 2, s.surface, z - 2, gx + gz + 10000);
      else if (choice < config.aetherForest * (island.role === 'woodland' ? 0.95 : 0.6)) tree(x, s.surface, z, island.biome > 0.55, 360);
    }
    // Ruins and sanctuaries have their own footprints rather than smaller castles.
    if (island.role === 'ruins') {
      const b = island.altitude;
      for (let j = 0; j < 5; j++) {
        const a = j * Math.PI * 0.4, x = Math.round(island.x + Math.cos(a) * 5), z = Math.round(island.z + Math.sin(a) * 5);
        cylinder(x, b, z, 1, 4 + Math.floor(rand(370 + j) * 6), C.limestone);
      }
      box(island.x - 5, b, island.z - 1, 10, 2, 3, C.masonry);
      box(island.x - 5, b + 7, island.z - 1, 4, 2, 3, C.limestone);
    } else if (island.role === 'sanctuary') {
      for (let z = -6; z <= 6; z++) for (let x = -6; x <= 6; x++) if (Math.hypot(x, z) < 6) box(island.x + x, island.altitude - 1, island.z + z, 1, 1, 1, C.masonry);
      for (let a = 0; a < Math.PI * 2; a += 0.025) {
        for (const radius of [3.5, 5]) micro(island.x + Math.cos(a) * radius, island.altitude, island.z + Math.sin(a) * radius, C.violet, 1.1);
      }
      crystal(island.x, island.altitude, island.z, 8, 1.5, true);
    }
    if (rand(380) < config.aetherCrystals) {
      const a = rand(381) * Math.PI * 2;
      const x = Math.round(island.x + Math.cos(a) * island.radius * 0.66), z = Math.round(island.z + Math.sin(a) * island.radius * 0.5);
      const s = sample(x, z);
      if (s) {
        crystal(x, s.surface, z, 7 + Math.floor(rand(382) * 7), 1.5, rand(383) > 0.5);
        crystal(x + 2, s.surface, z + 2, 5, 1, rand(383) > 0.5);
      }
    }
    // Moss and flowers occupy tiny patches, with site-dependent colour mixtures.
    for (let j = 0; j < island.radius * 4; j++) {
      const x = Math.round(island.x + (rand(410 + j) - 0.5) * island.radius * 2), z = Math.round(island.z + (rand(610 + j) - 0.5) * island.radius * 2);
      const s = sample(x, z); if (!s || (island.role === 'citadel' && s.radial < 0.72)) continue;
      detail(x, s.surface, z, 0.25, 0.5, 0.25, C.moss);
      detail(x - M, s.surface + 0.5, z - M, 0.5, 0.125, 0.5, j % 3 ? C.warm : C.pink);
    }
    if (rand(800) < config.aetherWaterfalls) {
      const a = rand(801) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
      let last: { x: number; z: number; surface: number } | null = null;
      for (let t = island.radius * 0.55; t < island.radius * 1.3; t += 0.75) {
        const x = Math.round(island.x + dx * t), z = Math.round(island.z + dz * t), s = sample(x, z);
        if (!s) break;
        last = { x, z, surface: s.surface };
        box(x, s.surface - 1, z, 2, 1, 2, C.water);
        if (Math.floor(t) % 3 === 0) detail(x, s.surface, z, 1.5, M, M, C.foam);
      }
      if (last) {
        const x = last.x + Math.round(dx), z = last.z + Math.round(dz), bottom = Math.max(2, last.surface - island.drop - 13);
        box(x, bottom, z, 2, last.surface - bottom, 1, C.water);
        for (let j = 0; j < 6; j++) stroke({ x: x + j * 0.375, y: bottom + j * 0.25, z: z + 1 }, { x: x + j * 0.375, y: last.surface, z: z + 1 }, j % 2 ? C.foam : C.cyan, j % 3 ? 0 : 0.45);
        waterfalls.push({ island: island.id, x, z, top: last.surface, bottom });
      }
    }
  }

  const shore = (a: AetherIsland, b: AetherIsland) => {
    const length = Math.hypot(b.x - a.x, b.z - a.z), dx = (b.x - a.x) / length, dz = (b.z - a.z) / length;
    let result = { x: a.x, z: a.z, y: a.altitude };
    for (let t = 0; t < a.radius * 1.3; t++) {
      const x = Math.round(a.x + dx * t), z = Math.round(a.z + dz * t), s = sampleAetherIsland(a, x + dx * 3, z + dz * 3, seed);
      if (!s) break;
      result = { x, z, y: sampleAetherIsland(a, x, z, seed)?.surface ?? a.altitude };
    }
    return result;
  };
  // At most two locally selected links per island; no global spanning-tree state
  // that would change already loaded chunks when more of the world is explored.
  const edgeIds = new Set<string>();
  for (const a of islands) {
    const neighbours = islands.filter(b => b !== a && Math.abs(b.altitude - a.altitude) < 19 && Math.hypot(b.x - a.x, b.z - a.z) < 108)
      .sort((b, c) => Math.hypot(b.x - a.x, b.z - a.z) - Math.hypot(c.x - a.x, c.z - a.z)).slice(0, 2);
    for (const b of neighbours) {
      const key = [a.id, b.id].sort().join('/'); if (edgeIds.has(key)) continue;
      edgeIds.add(key);
      const first = a.id < b.id ? a : b, second = first === a ? b : a;
      if (hash(first.x, second.z, 850, seed) > config.aetherBridges) continue;
      const start = shore(first, second), end = shore(second, first);
      if (!near(Math.min(start.x, end.x) - 2, Math.min(start.z, end.z) - 2, Math.abs(end.x - start.x) + 4, Math.abs(end.z - start.z) + 4)) continue;
      const length = Math.hypot(end.x - start.x, end.z - start.z);
      if (length < 4 || length > 65) continue;
      const nx = -(end.z - start.z) / length, nz = (end.x - start.x) / length;
      const stone = first.major && second.major || hash(first.x, second.x, 851, seed) < 0.3;
      let previous: { x: number; y: number; z: number }[] | null = null;
      for (let i = 0; i <= Math.ceil(length); i++) {
        const t = Math.min(1, i / length), x = start.x + (end.x - start.x) * t, z = start.z + (end.z - start.z) * t;
        const y = Math.floor(start.y + (end.y - start.y) * t - (stone ? 0 : Math.sin(t * Math.PI) * 2));
        for (let side = -1; side <= 1; side++) box(Math.round(x + nx * side), y - 1, Math.round(z + nz * side), 1, 1, 1, stone ? C.limestone : C.wood);
        const rails = [-1.6, 1.6].map(side => ({ x: x + nx * side + 0.5, y: y + 1.25, z: z + nz * side + 0.5 }));
        rails.forEach((p, index) => {
          if (previous) stroke(previous[index], p, stone ? C.gold : C.wood);
          if (i % 3 === 0) stroke({ ...p, y: y - 1 }, p, stone ? C.masonry : C.wood);
        });
        previous = rails;
        if (stone && (t < 0.14 || t > 0.86)) box(Math.round(x), y - 5, Math.round(z), 2, 4, 2, C.masonry);
      }
      bridges.push({ from: first.id, to: second.id, start, end });
    }
  }

  // Sparse airships use another world-addressed field, independent of island
  // templates. Their envelopes stay out of citadel airspace.
  for (let gz = Math.floor((oz - 20) / 140); gz <= Math.ceil((oz + depth + 20) / 140); gz++) {
    for (let gx = Math.floor((ox - 20) / 140); gx <= Math.ceil((ox + width + 20) / 140); gx++) {
      if (hash(gx, gz, 901, seed) > config.aetherDensity * 0.42) continue;
      const x = gx * 140 + Math.floor(hash(gx, gz, 902, seed) * 90);
      const z = gz * 140 + Math.floor(hash(gx, gz, 903, seed) * 90);
      const y = 100 + Math.floor(hash(gx, gz, 904, seed) * 33);
      if (!near(x - 11, z - 5, 23, 11) || islands.some(i => i.major && Math.hypot(x - i.x, z - i.z) < i.radius + 18)) continue;
      for (let dz = -4; dz <= 4; dz++) for (let dy = -4; dy <= 4; dy++) for (let dx = -10; dx <= 10; dx++) {
        if (dx * dx / 100 + dy * dy / 16 + dz * dz / 16 > 1) continue;
        box(x + dx, y + dy, z + dz, 1, 1, 1, dx % 4 === 0 ? C.wood : 0xc6b59c);
      }
      box(x - 6, y - 9, z - 1, 12, 2, 3, C.wood);
      box(x - 3, y - 7, z, 5, 2, 2, C.limestone);
      for (const dx of [-5, 5]) for (const dz of [-1, 2]) stroke({ x: x + dx, y: y - 7, z: z + dz }, { x: x + dx, y: y - 2, z: z + dz * 1.5 }, C.wood);
      detail(x + 3, y - 6.5, z + 2, 0.5, 0.5, 0.25, C.warm, 0.8);
    }
  }

  // Keep interiors solid: the lab preview only exports the visible shell, but
  // playable terrain must retain rock after mining and for collision queries.
  const details: number[] = [];
  for (const [key, colorMaterial] of micros) {
    const mx = key % (width * 8);
    const mz = Math.floor(key / (width * 8)) % (depth * 8);
    const my = Math.floor(key / (layer * 64));
    if (!get(Math.floor(mx / 8), Math.floor(my / 8), Math.floor(mz / 8))) {
      details.push(mx, my, mz, colorMaterial);
    }
  }
  return { cells, palette, details: new Uint32Array(details), islands: visibleIslands, castles, bridges, waterfalls };
}

const spawnAnchors = new Map<number, { x: number; z: number }>();
export function aetherSpawnAnchor(seed: number) {
  let anchor = spawnAnchors.get(seed);
  if (!anchor) {
    const sites = planAetherWorld({ ...AETHER_DEFAULTS, seed, sizeX: 16, sizeZ: 16,
      sizeY: CHUNK_SIZE_Y, yCutoff: CHUNK_SIZE_Y, offsetX: 0, offsetZ: 0 }, 512);
    const candidates = sites.filter(site => site.major);
    candidates.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z) || a.id.localeCompare(b.id));
    if (!candidates.length) throw new Error('Aether spawn island not found');
    anchor = { x: candidates[0].x, z: candidates[0].z };
    if (spawnAnchors.size >= 16) spawnAnchors.clear();
    spawnAnchors.set(seed, anchor);
  }
  return anchor;
}

export function generateAetherArchipelagoChunk(chunk: Chunk, seed: number, includeDetails = true) {
  const anchor = aetherSpawnAnchor(seed);
  const origin = chunk.getWorldOrigin();
  const centered = (value: number, spawn: number, period: number) =>
    ((value - spawn + period / 2) % period + period) % period - period / 2;
  const region = generateAetherRegion({ ...AETHER_DEFAULTS, seed,
    sizeX: CHUNK_SIZE_X, sizeZ: CHUNK_SIZE_Z, sizeY: CHUNK_SIZE_Y, yCutoff: CHUNK_SIZE_Y,
    offsetX: centered(origin.x, TORUS_SPAWN_X, TORUS_SIZE_X) + anchor.x + CHUNK_SIZE_X / 2,
    offsetZ: centered(origin.z, TORUS_SPAWN_Z, TORUS_SIZE_Z) + anchor.z + CHUNK_SIZE_Z / 2,
  }, includeDetails);
  let minY = CHUNK_SIZE_Y, maxY = -1;
  for (let index = 0; index < region.cells.length; index++) {
    const id = region.cells[index];
    if (!id) continue;
    const { color, emission } = region.palette[id];
    chunk.blocks[index] = BlockTypes.COLOR_BLOCK;
    chunk.colors[index] = color;
    chunk.materials[index] = emission > 0 ? 1 : 0;
    const y = Math.floor(index / (CHUNK_SIZE_X * CHUNK_SIZE_Z));
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  chunk.setGeneratedOccupiedYRange(minY, maxY);
  chunk.hasGenerated = true;
  return region.details;
}
