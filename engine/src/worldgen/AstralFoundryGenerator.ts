// Ported from entropydrop_frontend/src/pages/terrainLab/astralFoundry.ts.
// Keep solid interiors for collisions and volumetric LOD; retain the original 1/8m details.
import { finishTerrainLabRegion, generatePaddedTerrainLabRegion } from './TerrainLabRegion.ts';
/** Coordinate-addressed industrial world. No finite repeating city tile.
 * Geometry is exclusively 1m / 0.125m cubes, normal / emissive materials.
 * X/Z are cube centres relative to the crop; Y is the bottom in metres. */
export interface FoundryConfig {
  sizeX: number; sizeY: number; sizeZ: number;
  offsetX: number; offsetZ: number; yCutoff: number; seed: number;
  forgeScale: number; forgeHeight: number; forgeDensity: number;
  forgeMachinery: number; forgeConduits: number; forgeLinks: number;
  forgeTraffic: number; forgeWear: number; forgeGlow: number;
}
export const FOUNDRY_DEFAULTS = {
  forgeScale: 1, forgeHeight: 148, forgeDensity: 0.85, forgeMachinery: 0.75,
  forgeConduits: 0.7, forgeLinks: 0.7, forgeTraffic: 0.55, forgeWear: 0.7, forgeGlow: 0.4,
};

export interface FoundryNode {
  id: string; x: number; z: number; w: number; d: number; height: number;
  major: boolean; family: number; rotation: number; priority: number;
  district: number; alloy: number; accent: number; decks: number[];
}
interface Point { x: number; y: number; z: number }
const M = 0.125;
const C = {
  bedrock: 0x242b36, floor: 0x37414b, wall: 0x4a525a, plate: 0x60666b,
  dark: 0x161f2a, bronze: 0x8d7351, brass: 0xb09a70, steel: 0x687683,
  cyan: 0x4acfe5, blue: 0x4379bc, violet: 0xb777e7, amber: 0xeeb66b,
};
const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
function hash(x: number, z: number, salt: number, seed: number) {
  let h = Math.imul(seed ^ 0x9e3779b9 ^ x, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16) ^ z, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13) ^ salt, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x: number, z: number, seed: number, salt: number) {
  const ix = Math.floor(x), iz = Math.floor(z), dx = x - ix, dz = z - iz;
  const u = dx * dx * (3 - 2 * dx), v = dz * dz * (3 - 2 * dz);
  const a = hash(ix, iz, salt, seed), b = hash(ix + 1, iz, salt, seed);
  const c = hash(ix, iz + 1, salt, seed), d = hash(ix + 1, iz + 1, salt, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
const field = (x: number, z: number, seed: number, salt: number) => noise(x, z, seed, salt) * 0.65 + noise(x * 2.17 + 37, z * 2.17 - 19, seed, salt + 1) * 0.35;
const tint = (color: number, f: number) => {
  const c = (shift: number) => Math.round(clamp(((color >> shift) & 255) * f, 0, 255));
  return (c(16) << 16) | (c(8) << 8) | c(0);
};

/** Two-scale, variable-size hard-core sampling. District fields vary over
 * hundreds of metres and kilometres; seed hashing does not wrap at a tile edge. */
export function planAstralFoundry(config: FoundryConfig, margin = 140): FoundryNode[] {
  const scale = clamp(config.forgeScale, 0.8, 1.3), density = clamp(config.forgeDensity), seed = Math.floor(config.seed);
  const cache = new Map<string, FoundryNode>();
  const make = (ix: number, iz: number, major: boolean) => {
    const id = `${major ? 'H' : 'T'}:${ix}:${iz}`, found = cache.get(id); if (found) return found;
    const r = (salt: number) => hash(ix, iz, salt + (major ? 0 : 700), seed);
    const pitch = (major ? 116 : 35) * scale;
    const x = Math.round((ix + (r(1) - 0.5) * 0.78) * pitch), z = Math.round((iz + (r(2) - 0.5) * 0.78) * pitch);
    const district = field(x / 930, z / 930, seed, 40), cluster = field(x / 270, z / 270, seed, 45);
    const height = Math.round(clamp(config.forgeHeight, 80, 176) * (major ? 0.66 + r(3) * 0.25 + cluster * 0.13 : 0.19 + r(3) * 0.3 + cluster * 0.1));
    const family = Math.floor(r(4) * 5);
    const node: FoundryNode = {
      id, x, z, major, family, district, rotation: Math.floor(r(5) * 4), priority: r(6), height,
      w: Math.round((major ? 22 + r(7) * 8 : 8 + r(7) * 9) * scale),
      d: Math.round((major ? 21 + r(8) * 9 : 9 + r(8) * 8) * scale),
      alloy: Math.floor(r(9) * 4), accent: district > 0.62 ? C.amber : r(10) < 0.75 ? C.cyan : C.violet,
      decks: major ? [18 + Math.floor(r(11) * 9), Math.floor(height * (0.4 + r(12) * 0.13)), Math.floor(height * 0.7)] : [9 + Math.floor(r(11) * 9), Math.floor(height * 0.65)],
    };
    cache.set(id, node); return node;
  };
  const radius = (a: FoundryNode) => Math.hypot(a.w, a.d) * 0.5 + (a.major ? 6 : 2);
  const majorPresent = (ix: number, iz: number) => {
    const a = make(ix, iz, true);
    if (a.priority > density * (0.67 + field(a.x / 1200, a.z / 1200, seed, 60) * 0.35)) return false;
    for (let j = iz - 1; j <= iz + 1; j++) for (let i = ix - 1; i <= ix + 1; i++) {
      const b = make(i, j, true);
      if (b.priority < a.priority && Math.hypot(a.x - b.x, a.z - b.z) < radius(a) + radius(b) + 12) return false;
    }
    return true;
  };
  const minorPresent = (ix: number, iz: number) => {
    const a = make(ix, iz, false);
    if (a.priority > density * (0.67 + field(a.x / 310, a.z / 310, seed, 65) * 0.35)) return false;
    const mx = Math.round(a.x / (116 * scale)), mz = Math.round(a.z / (116 * scale));
    for (let j = mz - 1; j <= mz + 1; j++) for (let i = mx - 1; i <= mx + 1; i++) {
      const b = make(i, j, true);
      if (majorPresent(i, j) && Math.hypot(a.x - b.x, a.z - b.z) < radius(a) + radius(b) + 5) return false;
    }
    // Radius two covers the largest possible small-tower collision at scale 0.8.
    for (let j = iz - 2; j <= iz + 2; j++) for (let i = ix - 2; i <= ix + 2; i++) {
      const b = make(i, j, false);
      if (b.priority < a.priority && Math.hypot(a.x - b.x, a.z - b.z) < radius(a) + radius(b) + 4) return false;
    }
    return true;
  };
  const nodes: FoundryNode[] = [];
  for (const major of [true, false]) {
    const pitch = (major ? 116 : 35) * scale;
    for (let z = Math.floor((config.offsetZ - config.sizeZ / 2 - margin) / pitch) - 1; z <= Math.ceil((config.offsetZ + config.sizeZ / 2 + margin) / pitch) + 1; z++) {
      for (let x = Math.floor((config.offsetX - config.sizeX / 2 - margin) / pitch) - 1; x <= Math.ceil((config.offsetX + config.sizeX / 2 + margin) / pitch) + 1; x++) {
        if ((major ? majorPresent : minorPresent)(x, z)) nodes.push(make(x, z, major));
      }
    }
  }
  return nodes.sort((a, b) => a.id.localeCompare(b.id));
}

function generateFoundryRaw(config: FoundryConfig, includeDetails = true) {
  const width = Math.max(1, Math.floor(config.sizeX)), depth = Math.max(1, Math.floor(config.sizeZ));
  const ceiling = Math.max(1, Math.floor(Math.min(config.sizeY, config.yCutoff)));
  const ox = Math.floor(config.offsetX - width / 2), oz = Math.floor(config.offsetZ - depth / 2), seed = Math.floor(config.seed);
  const layer = width * depth, cells = new Uint16Array(layer * ceiling);
  const micros = new Map<number, number>();
  const palette = [{ color: 0, emission: 0, weather: false }], ids = new Map<string, number>();
  // A second connection radius makes nearest-neighbour choices crop independent.
  const nodes = planAstralFoundry(config, 240);
  const links: { from: string; to: string; start: Point; end: Point }[] = [];
  const machinery: { node: string; x: number; y: number; z: number; radius: number }[] = [];
  const ships: { x: number; y: number; z: number }[] = [];
  let frame: FoundryNode | null = null;
  let materialMap: Map<number, number> | null = null;
  const transform = (x: number, z: number, w: number, d: number, node = frame) => {
    if (!node) return { x, z, w, d };
    return node.rotation === 1 ? { x: node.x - z - d, z: node.z + x, w: d, d: w }
      : node.rotation === 2 ? { x: node.x - x - w, z: node.z - z - d, w, d }
      : node.rotation === 3 ? { x: node.x + z, z: node.z - x - w, w: d, d: w }
      : { x: node.x + x, z: node.z + z, w, d };
  };
  const near = (x: number, z: number, w: number, d: number) => x < ox + width && x + w > ox && z < oz + depth && z + d > oz;
  const inside = (x: number, y: number, z: number) => x >= 0 && x < width && z >= 0 && z < depth && y >= 0 && y < ceiling;
  const get = (x: number, y: number, z: number) => inside(x, y, z) ? cells[x + z * width + y * layer] : 0;
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, color: number, emission = 0, weather = true) => {
    const r = transform(x, z, w, d);
    const x0 = Math.max(0, Math.floor(r.x - ox)), x1 = Math.min(width, Math.floor(r.x + r.w - ox));
    const z0 = Math.max(0, Math.floor(r.z - oz)), z1 = Math.min(depth, Math.floor(r.z + r.d - oz));
    const y0 = Math.max(0, Math.floor(y)), y1 = Math.min(ceiling, Math.floor(y + h));
    if (x0 >= x1 || z0 >= z1 || y0 >= y1) return;
    color = materialMap?.get(color) ?? color;
    const key = `${color}:${emission}:${weather}`;
    let id = color === 0 ? 0 : ids.get(key);
    if (id === undefined) { id = palette.length; ids.set(key, id); palette.push({ color, emission, weather }); }
    for (let iy = y0; iy < y1; iy++) for (let iz = z0; iz < z1; iz++) cells.fill(id, x0 + iz * width + iy * layer, x1 + iz * width + iy * layer);
  };
  const micro = (x: number, y: number, z: number, color: number, intensity = 0) => {
    if (!includeDetails) return;
    const r = transform(x, z, M, M);
    x = Math.round(r.x * 8) / 8; z = Math.round(r.z * 8) / 8; y = Math.round(y * 8) / 8;
    if (x < ox || z < oz || x + M > ox + width || z + M > oz + depth || y < 0 || y + M > ceiling) return;
    const key = (x - ox) * 8 + (z - oz) * 8 * width * 8 + y * 8 * layer * 64;
    micros.set(key, ((materialMap?.get(color) ?? color) | (intensity > 0 ? 1 << 24 : 0)) >>> 0);
  };
  const detail = (x: number, y: number, z: number, w: number, h: number, d: number, color: number, emission = 0) => {
    if (!includeDetails) return;
    const r = transform(x, z, w, d); if (!near(r.x, r.z, r.w, r.d) || y >= ceiling) return;
    for (let iy = 0; iy < h; iy += M) for (let iz = 0; iz < d; iz += M) for (let ix = 0; ix < w; ix += M) {
      if (ix && iy && iz && ix + M < w && iy + M < h && iz + M < d) continue;
      micro(x + ix, y + iy, z + iz, color, emission);
    }
  };
  const line = (a: Point, b: Point, color: number, emission = 0) => {
    if (!includeDetails) return;
    const r = transform(Math.min(a.x, b.x), Math.min(a.z, b.z), Math.abs(b.x - a.x) + 1, Math.abs(b.z - a.z) + 1);
    if (!near(r.x, r.z, r.w, r.d)) return;
    const length = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z));
    for (let n = 0; n <= length; n += M) {
      const t = length ? n / length : 0;
      micro(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t, color, emission);
    }
  };
  const brace = (a: Point, b: Point, thick: number, color: number) => {
    const length = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z));
    for (let n = 0; n <= length; n++) {
      const t = length ? n / length : 0;
      box(Math.round(a.x + (b.x - a.x) * t), Math.round(a.y + (b.y - a.y) * t), Math.round(a.z + (b.z - a.z) * t), thick, thick, thick, color);
    }
  };
  const rail = (a: Point, b: Point) => {
    if (!includeDetails) return;
    for (const dy of [0.6, 1.25]) line({ ...a, y: a.y + dy }, { ...b, y: b.y + dy }, C.bronze);
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    for (let n = 0; n <= length; n += 2.5) {
      const t = n / length, p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
      line(p, { ...p, y: p.y + 1.25 }, C.bronze);
    }
  };
  const ring = (x: number, y: number, z: number, radius: number, accent: number, gear: boolean) => {
    // Full-size structural annulus, with micro-scale concentric bearing races.
    for (let dy = -radius - 2; dy <= radius + 2; dy++) for (let dx = -radius - 2; dx <= radius + 2; dx++) {
      const r = Math.hypot(dx, dy), angle = Math.atan2(dy, dx);
      const teeth = gear && Math.cos(angle * 14) > 0.25 ? 1.5 : 0;
      if (r > radius + teeth || r < radius - 2.5) continue;
      box(x + dx, y + dy, z, 1, 1, 2, r > radius - 0.5 ? C.bronze : C.plate);
    }
    if (includeDetails) for (const rr of [radius - 0.75, radius - 2.75, radius - 3.125]) {
      const step = M / Math.max(1, rr);
      for (let a = 0; a < Math.PI * 2; a += step) micro(x + 0.5 + Math.cos(a) * rr, y + 0.5 + Math.sin(a) * rr, z + 2, rr < radius - 2 ? accent : C.brass, rr < radius - 2 ? 1.25 : 0);
    }
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
      brace({ x: x + Math.cos(a) * 2, y: y + Math.sin(a) * 2, z }, { x: x + Math.cos(a) * (radius - 2), y: y + Math.sin(a) * (radius - 2), z }, 1, C.steel);
    }
    if (includeDetails) for (let dy = -2; dy <= 2; dy += M) for (let dx = -2; dx <= 2; dx += M) {
      const r = Math.hypot(dx, dy); if (r < 2) micro(x + 0.5 + dx, y + 0.5 + dy, z + 2.125, r < 1.5 ? accent : C.brass, r < 1.5 ? 1.6 : 0);
    }
  };
  const crew = (x: number, y: number, z: number, accent: number, variant: number) => {
    if (!includeDetails) return;
    const armor = [C.steel, C.bronze, C.plate, C.dark][variant % 4], reach = variant % 3 === 0;
    for (const dx of [0, 0.375]) {
      const stride = dx > 0 && variant % 2 ? 0.125 : 0;
      detail(x + dx, y, z + stride, 0.25, 0.875, 0.375, armor);
      detail(x + dx, y, z + 0.25 + stride, 0.25, 0.125, 0.375, C.dark);
    }
    detail(x, y + 0.875, z, 0.625, 0.625, 0.5, armor);
    detail(x - 0.25, y + 1.25, z, 0.25, 0.375, 0.375, C.bronze);
    detail(x + 0.625, y + 1.25, z, 0.25, 0.375, 0.375, C.bronze);
    detail(x - 0.25, y + 0.75, z, 0.25, 0.5, 0.25, C.steel);
    detail(x + 0.625, y + (reach ? 1 : 0.75), z, 0.25, reach ? 0.25 : 0.5, reach ? 0.75 : 0.25, armor);
    detail(x + 0.125, y + 1.5, z, 0.375, 0.375, 0.375, C.bronze);
    detail(x + 0.125, y + 1.625, z + 0.375, 0.375, 0.125, M, accent, 1.2);
    detail(x + 0.125, y + 1, z - 0.25, 0.375, 0.5, 0.25, C.dark);
    detail(x + 0.125, y + 1.375, z - 0.375, 0.125, 0.125, M, accent, 0.8);
  };

  box(ox, 0, oz, width, 1, depth, C.bedrock);
  const visible = nodes.filter(n => near(n.x - 33, n.z - 33, 66, 66));
  for (const node of visible) {
    frame = node;
    const r = (s: number) => hash(node.x, node.z, s, seed), { w, d, height: h } = node;
    const x = -Math.floor(w / 2), z = -Math.floor(d / 2), front = z + d, accent = node.accent;
    const alloys = [[0x4a525a, 0x8d7351], [0x4c4844, 0xa0865b], [0x3d4c5c, 0x768995], [0x55504c, 0x978668]][node.alloy];
    materialMap = new Map([[C.wall, alloys[0]], [C.bronze, alloys[1]]]);
    box(x - 2, 1, z - 2, w + 4, 5, d + 4, C.floor);
    box(x, 6, z, w, 10, d, C.wall);
    if (node.family === 0) {
      const leg = Math.max(3, Math.floor(w * 0.3));
      box(x, 16, z, leg, h - 16, d, C.wall);
      box(x + w - leg, 16, z + 1, leg, h - 26, d - 2, C.wall);
      box(x + leg, node.decks[1] - 3, z + 2, w - leg * 2, 8, d - 4, C.plate);
      brace({ x: x + leg - 1, y: node.decks[1] - 15, z: front - 3 }, { x: 0, y: node.decks[1] - 1, z: front - 3 }, 2, C.bronze);
    } else if (node.family === 1) {
      const leg = Math.max(3, Math.floor(w * 0.27));
      box(x, 16, z, leg, h * 0.7 - 16, d, C.wall);
      box(x + w - leg, 16, z, leg, h - 16, d, C.wall);
      box(x, Math.floor(h * 0.62), z, w, 10, d, C.plate);
      brace({ x: x - 4, y: 6, z: front - 1 }, { x, y: Math.floor(h * 0.45), z: front - 1 }, 3, C.bronze);
      brace({ x: x + w + 1, y: 6, z: front - 1 }, { x: x + w - 3, y: Math.floor(h * 0.45), z: front - 1 }, 3, C.bronze);
    } else if (node.family === 2) {
      for (let y = 16; y < h; y++) {
        const inset = Math.floor(Math.max(0, y - h * 0.55) / (h * 0.45) * Math.min(w, d) * 0.32);
        box(x + inset, y, z + inset, w - inset * 2, 1, d - inset * 2, C.wall);
      }
      for (let j = 0; j < 3; j++) box(x - 2, Math.floor(h * (0.3 + j * 0.2)), z - 2, w + 4, 2, d + 4, C.bronze);
    } else if (node.family === 3) {
      box(x, 16, z, Math.max(4, Math.floor(w * 0.64)), h - 16, d, C.wall);
      box(x + Math.floor(w * 0.64), 16, z + 2, Math.ceil(w * 0.36), Math.floor(h * 0.65) - 16, d - 4, C.plate);
      for (let j = 0; j < 3; j++) {
        const offset = j * 3;
        box(x - 1 - offset, 6, z + 2, 1, Math.floor(h * (0.85 - j * 0.13)), 3, C.bronze);
        brace({ x: x - 1 - offset, y: Math.floor(h * (0.85 - j * 0.13)), z: z + 2 }, { x: x + 2, y: Math.floor(h * (0.95 - j * 0.13)), z: z + 2 }, 1, C.bronze);
      }
    } else {
      box(x, 16, z, w, Math.floor(h * 0.48) - 16, d, C.wall);
      box(x, Math.floor(h * 0.48), z, Math.max(4, Math.floor(w * 0.36)), h - Math.floor(h * 0.48), Math.floor(d * 0.65), C.wall);
      box(x + 3, 8, front - 2, w - 6, 7, 2, 0);
    }
    // Load-bearing floors span the core. All network ports belong to these decks.
    for (const level of node.decks) {
      box(x - 1, level - 2, z - 1, w + 2, 2, d + 2, C.floor);
      box(x - 2, level - 2, front + 1, w + 4, 1, 1, C.bronze);
      if (node.major) rail({ x: x - 1, y: level, z: front + 1 }, { x: x + w + 1, y: level, z: front + 1 });
      if (r(level + 200) < config.forgeConduits) line({ x, y: level - 1.75, z: front + 2 }, { x: x + w, y: level - 1.75, z: front + 2 }, accent, 1.7);
      if (node.major) for (const bx of [x + 2, x + w - 4]) {
        brace({ x: bx, y: level - 8, z: front - 2 }, { x: bx, y: level - 2, z: front + 1 }, 2, C.bronze);
      }
    }
    if (node.major) {
      const shoulder = Math.floor(h * (0.42 + r(191) * 0.1));
      for (const sign of [-1, 1]) {
        const bx = sign < 0 ? x - 6 : x + w + 4, tx = sign < 0 ? x + 1 : x + w - 3;
        brace({ x: bx, y: 3, z: front - 3 }, { x: tx, y: shoulder, z: front - 3 }, 2, C.bronze);
        if (config.forgeConduits > 0) line({ x: bx + 0.75, y: 4, z: front - 0.875 }, { x: tx + 0.75, y: shoulder, z: front - 0.875 }, accent, 1.15);
      }
    }
    // Narrow inhabited/ventilation strips, plate seams and routed power buses.
    for (let face = 0; face < 4; face++) {
      const side = face >= 2, far = face % 2 === 1, length = side ? d : w;
      const point = (u: number, y: number, outset: number): Point => ({
        x: side ? x + (far ? w + outset : -outset - M) : x + u,
        y, z: side ? z + u : z + (far ? d + outset : -outset - M),
      });
      for (let y = 20 + Math.floor(r(face + 210) * 5); y < h - 8; y += 7 + node.family) {
        for (let u = 2; u < length - 2; u += 4) {
          // Only stamp facade details where solid tower mass actually exists.
          const p = point(u, y, -M), world = transform(p.x, p.z, M, M);
          const bx = Math.floor(world.x - ox), bz = Math.floor(world.z - oz);
          if (!get(bx, y, bz)) continue;
          const start = point(u + 0.25, y + 0.25, 0.125);
          // A micro frame around each inset keeps detail economical at city scale.
          for (const dy of [0, 1.375]) {
            const a = point(u, y + dy, 0), b = point(u + 2.375, y + dy, 0);
            line(a, b, C.steel);
          }
          for (const du of [0, 2.375]) {
            const a = point(u + du, y, 0), b = point(u + du, y + 1.375, 0);
            line(a, b, C.dark);
          }
          if (r(y * 11 + u + face * 1000) < config.forgeConduits) {
            detail(start.x, start.y, start.z, side ? M : 1.75, 0.25, side ? 1.75 : M, (u + face) % 5 ? accent : C.amber, 1.35);
          } else if (r(u + y + 240) < config.forgeMachinery) {
            for (let j = 0; j < 3; j++) {
              const a = point(u, y + j * 0.5, 0.25), b = point(u + 2.5, y + j * 0.5, 0.25);
              line(a, b, C.steel);
            }
          }
        }
      }
      // Structural ribs stop at genuine setbacks and openings. Their unequal spacing
      // distinguishes the load path from the small inhabited facade strips.
      for (const u of [1, Math.floor(length * 0.43), length - 2]) {
        for (let y = 6; y < h - 3; y++) {
          const p = point(u, y, -M), world = transform(p.x, p.z, M, M);
          if (!get(Math.floor(world.x - ox), y, Math.floor(world.z - oz))) continue;
          const a = point(u, y, 0);
          box(a.x, y, a.z, 1, 1, 1, u === 1 ? C.bronze : C.plate);
        }
      }
      // Buses bend at independently chosen levels rather than repeating on each storey.
      if (r(260 + face) < config.forgeConduits) {
        const u = 1 + Math.floor(r(265 + face) * Math.max(1, length - 5));
        const y = Math.floor(h * (0.32 + r(270 + face) * 0.3));
        const points = [point(u, 7, 1), point(u, y, 1), point(u + 3, y + 4, 1), point(u + 3, h - 4, 1)];
        for (let j = 1; j < points.length; j++) {
          line(points[j - 1], points[j], C.bronze);
          line({ ...points[j - 1], x: points[j - 1].x + M }, { ...points[j], x: points[j].x + M }, accent, 1.5);
        }
      }
    }
    // Needles and shoulder fins use independently seeded taper and height.
    const spireX = node.family === 2 ? 0 : node.family === 1 ? x + w - 3 : x + 1;
    const spireZ = node.family === 2 ? 0 : z + 2;
    box(spireX, h - 3, spireZ, 2, 7 + Math.floor(r(280) * 7), 2, C.wall);
    detail(spireX + 0.75, h + 4, spireZ + 0.75, 0.25, 9, 0.25, C.bronze);
    if (config.forgeConduits > 0) box(spireX, h + 3, spireZ + 2, 1, 1, 1, accent, 1.4, false);
    if (node.major && r(290) < config.forgeMachinery) {
      const radius = 5 + Math.floor(r(291) * 4), y = node.decks[1] + radius + 2;
      const cx = node.family === 1 ? x + w - 4 : x + Math.floor(w / 2), rz = front + 2;
      box(cx - 2, node.decks[1], front - 2, 5, radius + 3, 5, C.dark);
      brace({ x: cx - radius, y: node.decks[1] - 2, z: front }, { x: cx - radius, y, z: rz }, 2, C.bronze);
      brace({ x: cx + radius, y: node.decks[1] - 2, z: front }, { x: cx + radius, y, z: rz }, 2, C.bronze);
      ring(cx, y, rz, radius, accent, node.family % 2 === 0);
      const position = transform(cx, rz, 0, 0);
      machinery.push({ node: node.id, x: position.x, z: position.z, y, radius });
    }
    if (node.major) {
      const level = node.decks[0];
      box(x - 2, level - 2, front + 1, w + 4, 2, 10, C.floor);
      rail({ x: x - 2, y: level, z: front + 10.875 }, { x: x + w + 2, y: level, z: front + 10.875 });
      for (let i = 0; i < 5; i++) {
        brace({ x: x + i * Math.floor(w / 4), y: level - 8, z: front - 1 }, { x: x + i * Math.floor(w / 4), y: level - 2, z: front + 7 }, 1, C.bronze);
        if (r(301 + i) < config.forgeMachinery) crew(x + 3 + i * 3 + r(320 + i), level, front + 5 + r(310 + i) * 4, accent, Math.floor(r(330 + i) * 12));
      }
      for (let i = 0; i < 3; i++) {
        box(x + 2 + i * 4, level, front + 2, 2, 1 + i % 2, 2, C.plate);
        detail(x + 2 + i * 4, level + 0.75, front + 4, 1.5, 0.125, M, C.amber, 0.6);
      }
    }
    frame = null; materialMap = null;
  }

  const port = (a: FoundryNode, b: FoundryNode, y: number): Point => {
    const rect = transform(-Math.floor(a.w / 2) - 1, -Math.floor(a.d / 2) - 1, a.w + 2, a.d + 2, a);
    const cx = rect.x + rect.w / 2, cz = rect.z + rect.d / 2, dx = b.x - cx, dz = b.z - cz;
    const t = Math.min((rect.w / 2 - 1) / Math.max(0.001, Math.abs(dx)), (rect.d / 2 - 1) / Math.max(0.001, Math.abs(dz)));
    return { x: Math.floor(cx + dx * t) + 0.5, y, z: Math.floor(cz + dz * t) + 0.5 };
  };
  const pairs = new Set<string>();
  for (const a of nodes) {
    const neighbors = nodes.filter(b => b.id !== a.id && Math.hypot(a.x - b.x, a.z - b.z) < 100)
      .sort((b, c) => Math.hypot(a.x - b.x, a.z - b.z) - Math.hypot(a.x - c.x, a.z - c.z) || b.id.localeCompare(c.id)).slice(0, a.major ? 3 : 2);
    for (const b of neighbors) {
      const [first, second] = a.id < b.id ? [a, b] : [b, a], key = `${first.id}/${second.id}`;
      if (pairs.has(key)) continue; pairs.add(key);
      if (hash(first.x + second.x, first.z + second.z, 410, seed) >= config.forgeLinks) continue;
      const levels = first.decks.flatMap(y => second.decks.map(v => [y, v])).filter(v => Math.abs(v[0] - v[1]) <= 18)
        .sort((c, d) => Math.abs(c[0] - c[1]) - Math.abs(d[0] - d[1]));
      if (!levels.length) continue;
      const upper = [...levels].sort((c, d) => d[0] + d[1] - c[0] - c[1])[0];
      const [y0, y1] = hash(first.x, second.z, 411, seed) < 0.5 ? upper : levels[0];
      const start = port(first, second, y0), end = port(second, first, y1);
      if (!near(Math.min(start.x, end.x) - 3, Math.min(start.z, end.z) - 3, Math.abs(end.x - start.x) + 6, Math.abs(end.z - start.z) + 6)) continue;
      const dx = end.x - start.x, dz = end.z - start.z, length = Math.hypot(dx, dz);
      if (length < 6) continue;
      // Do not drive a bridge through an unrelated tower.
      if (nodes.some(n => {
        if (n === first || n === second) return false;
        const t = clamp(((n.x - start.x) * dx + (n.z - start.z) * dz) / (length * length));
        return Math.hypot(start.x + dx * t - n.x, start.z + dz * t - n.z) < Math.hypot(n.w, n.d) / 2 + 3 && start.y + (end.y - start.y) * t < n.height + 5;
      })) continue;
      links.push({ from: first.id, to: second.id, start, end });
      const px = -dz / length, pz = dx / length;
      const at = (t: number, side = 0, down = 0): Point => ({ x: start.x + dx * t + px * side, y: start.y + (end.y - start.y) * t - down, z: start.z + dz * t + pz * side });
      // Service trunks and pumps give the canyon floor a functional scale.
      brace({ ...start, y: 1 }, { ...end, y: 1 }, 1, C.bronze);
      for (let step = 9; step < length - 5; step += 19) {
        const p = at(step / length, 3);
        box(Math.floor(p.x) - 1, 1, Math.floor(p.z) - 1, 3, 3, 3, C.dark);
        box(Math.floor(p.x) - 1, 4, Math.floor(p.z) - 1, 3, 1, 3, C.plate);
        if (config.forgeConduits > 0) detail(Math.floor(p.x) - 0.75, 2.5, Math.floor(p.z) + 2, 2.5, 0.25, M, first.accent, 1);
      }
      for (let step = 0; step <= length * 2; step++) {
        const p = at(step / (length * 2));
        box(Math.floor(p.x) - 1, Math.floor(p.y) - 2, Math.floor(p.z) - 1, 3, 2, 3, C.floor);
      }
      for (const side of [-1.65, 1.65]) {
        rail(at(0, side), at(1, side));
        if (config.forgeConduits > 0) line(at(0, side, 1.5), at(1, side, 1.5), first.accent, 1.5);
        const segments = Math.ceil(length / 7);
        for (let i = 0; i < segments; i++) {
          brace(at(i / segments, side, 2), at((i + 0.5) / segments, side, 5), 1, C.bronze);
          brace(at((i + 0.5) / segments, side, 5), at((i + 1) / segments, side, 2), 1, C.bronze);
        }
      }
      if (config.forgeMachinery > 0.25) for (let i = 0; i < 32; i++) {
        const p = at(i / 32, 1, 2 + Math.sin(i / 32 * Math.PI) * Math.min(14, length * 0.2));
        const q = at((i + 1) / 32, 1, 2 + Math.sin((i + 1) / 32 * Math.PI) * Math.min(14, length * 0.2));
        line(p, q, C.dark);
      }
    }
  }

  // Traffic is addressed in world space independently of the visible crop.
  for (let j = Math.floor((oz - 20) / 52); j <= Math.ceil((oz + depth + 20) / 52); j++) {
    for (let i = Math.floor((ox - 20) / 52); i <= Math.ceil((ox + width + 20) / 52); i++) {
      const r = (s: number) => hash(i, j, 500 + s, seed);
      if (r(0) > config.forgeTraffic * 0.65) continue;
      const x = Math.round((i + r(1)) * 52), z = Math.round((j + r(2)) * 52), y = 34 + Math.floor(r(3) * 90);
      if (nodes.some(n => Math.hypot(n.x - x, n.z - z) < Math.hypot(n.w, n.d) / 2 + 15 && y < n.height + 24)) continue;
      if (!near(x - 14, z - 14, 28, 28)) continue;
      frame = { x, z, rotation: Math.floor(r(4) * 4) } as FoundryNode;
      const len = 7 + Math.floor(r(5) * 5), accent = r(6) < 0.7 ? C.cyan : C.amber;
      box(-1, y, -len / 2, 2, 1, len, C.plate);
      box(-2, y, -2, 4, 1, 4, C.bronze);
      box(-5, y, -1, 10, 1, 2, C.dark);
      detail(-0.75, y + 1, -2, 1.5, 0.5, 2.5, C.steel);
      detail(-0.625, y + 1.5, -1.875, 1.25, M, 1.5, accent, 0.6);
      for (const xx of [-3, 2]) {
        box(xx, y, 1, 1, 1, 3, C.plate);
        detail(xx + 0.125, y + 0.125, 4, 0.75, 0.75, M, accent, 2);
        line({ x: xx + 0.5, y: y + 0.375, z: 4.125 }, { x: xx + 0.5, y: y + 0.375, z: 8 + r(7) * 3 }, accent, 1.4);
      }
      ships.push({ x, y, z }); frame = null;
    }
  }

  return finishTerrainLabRegion(width, depth, ceiling, cells, palette, micros, (id, x, y, z) => {
    const p = palette[id];
    const stain = hash(Math.floor((x + ox) / 3), Math.floor((z + oz) / 3), Math.floor(y / 17) + 900, seed);
    const grain = hash(x + ox, z + oz, y + 1000, seed);
    return p.weather && !p.emission ? tint(p.color, 1 + ((stain - 0.5) * 0.10 + (grain - 0.5) * 0.035) * config.forgeWear) : p.color;
  });
}

/** Facade strips and ribs inspect their supporting cells. A four-metre halo
 * keeps these reads available even when the supporting tower is next door. */
export function generateFoundryRegion(config: FoundryConfig, includeDetails = true) {
  return generatePaddedTerrainLabRegion(config, includeDetails, generateFoundryRaw, 4);
}
