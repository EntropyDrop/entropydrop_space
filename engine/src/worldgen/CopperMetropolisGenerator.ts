import { Chunk, CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from '../voxel/Chunk.ts';
import { BlockTypes } from '../voxel/BlockTypes.ts';
import { getTerrainKernels } from '../wasm/TerrainKernels.ts';
import {
  TORUS_SIZE_X,
  TORUS_SIZE_Z,
  TORUS_SPAWN_X,
  TORUS_SPAWN_Z,
} from '../torus/TorusWorld.ts';

/**
 * Chunk-local port of terrain-lab's Copper Metropolis algorithm.
 *
 * The source design lives in entropydrop_frontend/terrain-lab. The one-metre
 * architecture and eighth-metre ornamental layer are both
 * generated from the same world-anchored grammar. Details are returned as
 * chunk-local micro-grid cells; World composes them into its authoritative
 * MicroVoxelLayer without treating deterministic terrain as authored edits.
 */

const METROPOLIS_HEIGHT = 112;
const METROPOLIS_PARKS = 0.1;
const METROPOLIS_DETAIL = 0.7;
const METROPOLIS_BRIDGES = 0.35;
const MICRO_DIVISIONS = 8;
const MICRO_SIZE = 1 / MICRO_DIVISIONS;

type DistrictKind = 'old-town' | 'gardens' | 'works' | 'terraces' | 'civic' | 'business';
type LandmarkKind = 'park' | 'hall' | 'court' | 'terraces' | 'gateway';
type District = {
  kind: DistrictKind;
  lotSize: number;
  palette: number;
  centreX: number;
  centreZ: number;
  radiusX: number;
  radiusZ: number;
  landmark: LandmarkKind | null;
  landmarkId: number;
};
type Parcel = { x: number; z: number; w: number; d: number; id: number; district: District; landmark?: boolean };
type Section = { x: number; z: number; w: number; d: number; bottom: number; top: number };
type Building = Parcel & {
  height: number;
  roof: number;
  family: number;
  crown: number;
  sections: Section[];
};

function hash(x: number, z: number, salt: number, seed: number): number {
  let h = Math.imul(x, 374761393)
    ^ Math.imul(z, 668265263)
    ^ Math.imul(salt, 1442695041)
    ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothField(x: number, z: number, scale: number, salt: number, seed: number) {
  const ix = Math.floor(x / scale), iz = Math.floor(z / scale);
  const fx = x / scale - ix, fz = z / scale - iz;
  const tx = fx * fx * (3 - 2 * fx), tz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz, salt, seed) * (1 - tx) + hash(ix + 1, iz, salt, seed) * tx;
  const b = hash(ix, iz + 1, salt, seed) * (1 - tx) + hash(ix + 1, iz + 1, salt, seed) * tx;
  return a * (1 - tz) + b * tz;
}

function makeDistrict(rx: number, rz: number, x: number, z: number, w: number, d: number, seed: number): District {
  const random = (salt: number) => hash(rx, rz, 200 + salt, seed);
  const kinds: DistrictKind[] = ['old-town', 'old-town', 'gardens', 'works', 'terraces', 'terraces', 'civic', 'business', 'business'];
  const kind = rx === 0 && rz === 0 ? 'business' : kinds[Math.floor(random(0) * kinds.length)];
  const lots = { 'old-town': 19, gardens: 30, works: 54, terraces: 38, civic: 44, business: 38 };
  const landmarks: LandmarkKind[] = ['hall', 'court', 'terraces', 'gateway'];
  const landmark = kind === 'gardens' ? 'park' : kind === 'works' ? 'hall'
    : kind === 'civic' ? 'court' : landmarks[Math.floor(random(4) * landmarks.length)];
  return {
    kind,
    lotSize: lots[kind] * (0.88 + random(1) * 0.26),
    palette: Math.floor(random(2) * PALETTES.length),
    centreX: x + w * (0.36 + random(3) * 0.28),
    centreZ: z + d * (0.36 + random(5) * 0.28),
    radiusX: w * (0.3 + random(6) * 0.12),
    radiusZ: d * (0.3 + random(7) * 0.12),
    landmark: rx === 0 && rz === 0 ? 'gateway'
      : random(8) < (kind === 'gardens' || kind === 'civic' ? 0.85 : 0.48) ? landmark : null,
    landmarkId: 7 + Math.floor(random(9) * 4),
  };
}

const C = {
  road: 0x414c51,
  paving: 0xb9aa87,
  stone: 0xe3d2a2,
  ivory: 0xf1e3bd,
  clay: 0xba6335,
  rust: 0x8d492f,
  teal: 0x376870,
  patina: 0x528c8b,
  slate: 0x49626d,
  dark: 0x233d48,
  glass: 0x6b9395,
  gold: 0xcf993e,
  brass: 0xb9894b,
  leaf: 0x537851,
  leafLight: 0x799453,
  grass: 0x66834b,
  wood: 0x68543e,
};

const PALETTES = [
  { wall: C.clay, frame: C.ivory, roof: C.teal },
  { wall: C.slate, frame: C.stone, roof: C.patina },
  { wall: 0xc39159, frame: C.ivory, roof: C.slate },
  { wall: C.rust, frame: C.stone, roof: C.teal },
  { wall: 0x74908b, frame: C.ivory, roof: C.clay },
  { wall: 0xceb582, frame: C.stone, roof: C.teal },
];

function centeredCoordinate(value: number, center: number, period: number) {
  let delta = value - center;
  if (delta < -period / 2) delta += period;
  if (delta >= period / 2) delta -= period;
  return delta;
}

export function generateCopperMetropolisChunk(chunk: Chunk, seed: number, includeDetails = true) {
  const worldOrigin = chunk.getWorldOrigin();
  const originX = centeredCoordinate(worldOrigin.x, TORUS_SPAWN_X, TORUS_SIZE_X);
  const originZ = centeredCoordinate(worldOrigin.z, TORUS_SPAWN_Z, TORUS_SIZE_Z);
  const width = CHUNK_SIZE_X;
  const depth = CHUNK_SIZE_Z;
  const ceiling = CHUNK_SIZE_Y;
  const maxHeight = METROPOLIS_HEIGHT;
  const detail = METROPOLIS_DETAIL;
  const parcels: Parcel[] = [];
  const buildings: Building[] = [];
  const rawDetails: number[] = [];
  const kernels = getTerrainKernels();
  const solidOps: number[] = [];
  const microOps: number[] = [];

  const box = (
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: number,
  ) => {
    const x0 = Math.max(0, Math.floor(x - originX));
    const x1 = Math.min(width, Math.floor(x + w - originX));
    const z0 = Math.max(0, Math.floor(z - originZ));
    const z1 = Math.min(depth, Math.floor(z + d - originZ));
    const y0 = Math.max(0, Math.floor(y));
    const y1 = Math.min(ceiling, Math.floor(y + h));
    if (x0 >= x1 || z0 >= z1 || y0 >= y1) return;
    if (kernels) {
      solidOps.push(x0, y0, z0, x1, y1, z1, color);
      return;
    }
    const block = color === 0 ? BlockTypes.AIR : BlockTypes.COLOR_BLOCK;
    for (let iy = y0; iy < y1; iy++) {
      for (let iz = z0; iz < z1; iz++) {
        const start = Chunk.getIndex(x0, iy, iz);
        const end = start + x1 - x0;
        chunk.blocks.fill(block, start, end);
        chunk.colors.fill(color, start, end);
        chunk.materials.fill(0, start, end);
      }
    }
  };
  const micro = (x: number, y: number, z: number, color: number) => {
    if (
      x < originX
      || x + MICRO_SIZE > originX + width
      || z < originZ
      || z + MICRO_SIZE > originZ + depth
      || y < 0
      || y + MICRO_SIZE > ceiling
    ) return;
    rawDetails.push(
      Math.round((x - originX) * MICRO_DIVISIONS),
      Math.round(y * MICRO_DIVISIONS),
      Math.round((z - originZ) * MICRO_DIVISIONS),
      color,
    );
  };
  const microBox = (
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: number,
  ) => {
    if (!includeDetails) return;
    if (kernels) {
      if (x >= originX + width || x + w <= originX || z >= originZ + depth
        || z + d <= originZ || y >= ceiling || y + h <= 0) return;
      microOps.push(
        Math.round((x - originX) * MICRO_DIVISIONS), Math.round(y * MICRO_DIVISIONS),
        Math.round((z - originZ) * MICRO_DIVISIONS),
        Math.round((x + w - originX) * MICRO_DIVISIONS), Math.round((y + h) * MICRO_DIVISIONS),
        Math.round((z + d - originZ) * MICRO_DIVISIONS), color,
      );
      return;
    }
    for (let iy = 0; iy < h; iy += MICRO_SIZE) {
      for (let iz = 0; iz < d; iz += MICRO_SIZE) {
        for (let ix = 0; ix < w; ix += MICRO_SIZE) {
          if (
            ix > 0 && ix + MICRO_SIZE < w
            && iy > 0 && iy + MICRO_SIZE < h
            && iz > 0 && iz + MICRO_SIZE < d
          ) continue;
          micro(x + ix, y + iy, z + iz, color);
        }
      }
    }
  };
  const rim = (x: number, y: number, z: number, w: number, d: number, color: number) => {
    box(x, y, z, w, 1, 1, color);
    box(x, y, z + d - 1, w, 1, 1, color);
    box(x, y, z, 1, 1, d, color);
    box(x + w - 1, y, z, 1, 1, d, color);
  };
  const tree = (x: number, y: number, z: number, id: number) => {
    box(x, y, z, 1, 3, 1, C.wood);
    const green = id % 2 ? C.leaf : C.leafLight;
    box(x - 1, y + 2, z, 3, 2, 1, green);
    box(x, y + 2, z - 1, 1, 2, 3, green);
    box(x, y + 4, z, 1, 1, 1, green);
  };
  const park = (parcel: Parcel) => {
    const { x: px, z: pz, w: pw, d: pd } = parcel;
    const pathX = px + Math.floor(pw / 2) - 1;
    const pathZ = pz + Math.floor(pd / 2) - 1;
    const large = Math.min(pw, pd) >= 40;
    box(px, 1, pz, pw, 1, pd, C.paving);
    box(px + 1, 1, pz + 1, pw - 2, 1, pd - 2, C.grass);
    rim(px + 2, 1, pz + 2, pw - 4, pd - 4, C.stone);
    box(pathX, 1, pz + 1, large ? 4 : 2, 1, pd - 2, C.stone);
    box(px + 1, 1, pathZ, pw - 2, 1, large ? 4 : 2, C.stone);
    const spacing = large ? 9 : 5;
    for (let tx = px + 4; tx < px + pw - 3; tx += spacing) {
      for (let tz = pz + 4; tz < pz + pd - 3; tz += spacing) {
        const treeX = tx + Math.floor(hash(tx, tz, 19, seed) * 3);
        const treeZ = tz + Math.floor(hash(tx, tz, 20, seed) * 3);
        if ((treeX >= pathX - 1 && treeX <= pathX + (large ? 4 : 2))
          || (treeZ >= pathZ - 1 && treeZ <= pathZ + (large ? 4 : 2))) continue;
        tree(treeX, 2, treeZ, Math.floor(hash(tx, tz, 21, seed) * 2));
      }
    }
    const benchW = large ? 3 : 2;
    const benchX = Math.min(px + pw - benchW - 2, pathX + (large ? 6 : 3));
    for (const benchZ of [pz + 2, pz + pd - 3]) {
      box(benchX, 2, benchZ, benchW, 1, 1, C.wood);
      microBox(benchX, 3, benchZ + 0.75, benchW, 0.5, 0.25, C.brass);
    }
    if (large) {
      // A broad reflecting pool and its crossing read as one civic space at LOD.
      const poolW = Math.floor(pw * 0.28), poolD = Math.floor(pd * 0.48);
      const poolX = px + Math.floor(pw * 0.16), poolZ = pz + Math.floor(pd * 0.26);
      box(poolX, 1, poolZ, poolW, 1, poolD, C.glass);
      rim(poolX, 2, poolZ, poolW, poolD, C.teal);
      box(poolX, 2, pathZ, poolW, 1, 4, C.stone);
    } else if (pw >= 16 && pd >= 16 && hash(px, pz, 22, seed) < 0.4) {
      box(pathX - 1, 2, pathZ - 1, 4, 1, 4, C.teal);
      box(pathX, 2, pathZ, 2, 1, 2, C.glass);
    }
  };
  const mass = (x: number, z: number, w: number, d: number, bottom: number, top: number,
    colors: typeof PALETTES[number]) => {
    box(x, bottom, z, w, top - bottom, d, colors.wall);
    for (let y = bottom + 3; y < top - 2; y += 6) {
      for (const far of [false, true]) {
        for (let u = 3; u < w - 3; u += 5) box(x + u, y, z + (far ? d - 1 : 0), 2, 2, 1, C.glass);
        for (let u = 3; u < d - 3; u += 5) box(x + (far ? w - 1 : 0), y, z + u, 1, 2, 2, C.glass);
      }
    }
    for (let y = bottom + 9; y < top; y += 12) rim(x, y, z, w, d, colors.frame);
    box(x, top, z, w, 2, d, colors.roof);
    rim(x, top + 2, z, w, d, colors.frame);
  };
  const landmark = (parcel: Parcel) => {
    if (parcel.district.landmark === 'park') { park(parcel); return; }
    const { x: px, z: pz, w: pw, d: pd, district } = parcel;
    const x = px + 5, z = pz + 5, w = pw - 10, d = pd - 10;
    const colors = PALETTES[district.palette];
    const random = (salt: number) => hash(px, pz, 300 + salt, seed);
    box(px, 1, pz, pw, 1, pd, C.paving);
    box(x - 2, 2, z - 2, w + 4, 2, d + 4, colors.frame);
    if (district.landmark === 'hall') {
      // A long station/exhibition hall, with one continuous barrel-like roof.
      const alongX = w > d;
      const high = 17 + Math.floor(random(0) * 10);
      mass(x, z, w, d, 4, high, colors);
      const narrow = Math.min(w, d);
      for (let step = 0; step < 9; step++) {
        const inset = Math.floor(step * narrow / 20);
        box(x + (alongX ? 0 : inset), high + 2 + step, z + (alongX ? inset : 0),
          alongX ? w : w - inset * 2, 1, alongX ? d - inset * 2 : d, step % 3 ? colors.roof : C.brass);
      }
      for (let t = 6; t < (alongX ? w : d) - 6; t += 12) {
        box(x + (alongX ? t : 2), high + 11, z + (alongX ? 2 : t),
          alongX ? 3 : w - 4, 1, alongX ? d - 4 : 3, C.glass);
      }
    } else if (district.landmark === 'court') {
      const wing = Math.max(10, Math.floor(Math.min(w, d) * 0.2));
      const high = 28 + Math.floor(random(0) * 18);
      mass(x, z, w, wing, 4, high, colors);
      mass(x, z + d - wing, w, wing, 4, high, colors);
      mass(x, z + wing, wing, d - wing * 2, 4, high - 6, colors);
      mass(x + w - wing, z + wing, wing, d - wing * 2, 4, high - 6, colors);
      box(x + wing, 4, z + wing, w - wing * 2, 1, d - wing * 2, C.grass);
      box(x + Math.floor(w / 2) - 3, 4, z + wing, 6, 1, d - wing * 2, C.stone);
      // Two arcaded entrances leave the courtyard visible from the street.
      for (const gateZ of [z, z + d - wing]) {
        box(x + Math.floor(w / 2) - 4, 4, gateZ, 8, 9, wing, 0);
        box(x + Math.floor(w / 2) - 5, 13, gateZ, 10, 2, wing, colors.frame);
      }
      const cx = x + Math.floor(w / 2), cz = z + Math.floor(d / 2);
      const poolW = Math.min(18, w - wing * 2 - 4), poolD = Math.min(12, d - wing * 2 - 4);
      const poolX = cx - Math.floor(poolW / 2), poolZ = cz - Math.floor(poolD / 2);
      box(poolX, 5, poolZ, poolW, 1, poolD, C.teal);
      box(poolX + 1, 5, poolZ + 1, poolW - 2, 1, poolD - 2, C.glass);
      for (const tx of [x + wing + 3, x + w - wing - 4]) {
        for (let tz = z + wing + 4; tz < z + d - wing - 3; tz += 9) tree(tx, 5, tz, tz);
      }
    } else if (district.landmark === 'gateway' && w >= 48) {
      const towerW = Math.floor(w * 0.31), high = 82 + Math.floor(random(0) * 24);
      mass(x, z, towerW, d, 4, high, colors);
      mass(x + w - towerW, z, towerW, d, 4, high, colors);
      const deck = Math.floor(high * 0.64), deckD = Math.max(10, Math.floor(d * 0.34));
      mass(x + towerW, z + Math.floor((d - deckD) / 2), w - towerW * 2, deckD, deck, deck + 12, colors);
      box(x + towerW + 1, deck + 13, z + Math.floor((d - deckD) / 2) + 1,
        w - towerW * 2 - 2, 1, deckD - 2, C.grass);
      box(x + towerW, 4, z, w - towerW * 2, 1, d, C.stone);
    } else {
      // Broad occupied terraces create a mountain-like landmark, not a needle.
      const high = 68 + Math.floor(random(0) * 24);
      for (let tier = 0; tier < 4; tier++) {
        const insetX = tier * Math.max(4, Math.floor(w * 0.065));
        const insetZ = tier * Math.max(4, Math.floor(d * 0.065));
        const bottom = tier === 0 ? 4 : 4 + Math.floor((high - 4) * tier / 4) + 2;
        const top = 4 + Math.floor((high - 4) * (tier + 1) / 4);
        mass(x + insetX, z + insetZ, w - insetX * 2, d - insetZ * 2, bottom, top, colors);
        box(x + insetX + 2, top + 1, z + insetZ + 2, w - insetX * 2 - 4, 1, 3, C.grass);
        for (let tx = x + insetX + 5; tx < x + w - insetX - 5; tx += 12) tree(tx, top + 2, z + insetZ + 3, tx);
      }
    }
  };

  box(originX, 0, originZ, width, 1, depth, C.road);

  const regionSize = 240;
  const edge = (i: number, axis: number) => (
    i * regionSize - 120 + Math.floor(hash(i, axis, 8, seed) * 44)
  );
  const split = (parcel: Parcel, level: number) => {
    const random = (salt: number) => hash(parcel.x, parcel.z, parcel.id + salt, seed);
    if (level === 2 && parcel.id === parcel.district.landmarkId && parcel.district.landmark
      && Math.min(parcel.w, parcel.d) >= 44) {
      parcels.push({ ...parcel, landmark: true });
      return;
    }
    const alongX = parcel.w / parcel.d > 1.3
      || (parcel.w / parcel.d > 0.77 && random(5) > 0.5);
    const length = alongX ? parcel.w : parcel.d;
    const stop = parcel.district.lotSize * (1 + random(6) * 0.35);
    const road = level < 2
      ? 5 + Math.floor(random(7) * 3)
      : level < 4 ? 4 : 2 + Math.floor(random(8) * 2);
    if ((parcel.w <= stop && parcel.d <= stop) || length < 23 || level > 8) {
      parcels.push(parcel);
      return;
    }
    const cut = Math.max(
      10,
      Math.min(length - road - 10, Math.floor(length * (0.34 + random(9) * 0.32))),
    );
    const remainder = length - cut - road;
    if (remainder < 10) {
      parcels.push(parcel);
      return;
    }
    if (road >= 4) {
      const run = alongX ? parcel.d : parcel.w;
      for (let t = 2; t < run - 2; t += 6) {
        const x = alongX ? parcel.x + cut + Math.floor(road / 2) : parcel.x + t;
        const z = alongX ? parcel.z + t : parcel.z + cut + Math.floor(road / 2);
        microBox(x, 1, z, alongX ? 0.5 : 2, 0.25, alongX ? 2 : 0.5, C.stone);
      }
    }
    split({
      ...parcel,
      w: alongX ? cut : parcel.w,
      d: alongX ? parcel.d : cut,
      id: parcel.id * 2 + 1,
    }, level + 1);
    split({
      ...parcel,
      x: alongX ? parcel.x + cut + road : parcel.x,
      z: alongX ? parcel.z : parcel.z + cut + road,
      w: alongX ? remainder : parcel.w,
      d: alongX ? parcel.d : remainder,
      id: parcel.id * 2 + 2,
    }, level + 1);
  };

  for (
    let rx = Math.floor((originX + 120) / regionSize) - 1;
    rx <= Math.floor((originX + width + 120) / regionSize) + 1;
    rx++
  ) {
    for (
      let rz = Math.floor((originZ + 120) / regionSize) - 1;
      rz <= Math.floor((originZ + depth + 120) / regionSize) + 1;
      rz++
    ) {
      const x = edge(rx, 0);
      const z = edge(rz, 1);
      const w = edge(rx + 1, 0) - x - 6;
      const d = edge(rz + 1, 1) - z - 6;
      if (
        x > originX + width + 32
        || x + w < originX - 32
        || z > originZ + depth + 32
        || z + d < originZ - 32
      ) continue;
      split({ x, z, w, d, id: 1, district: makeDistrict(rx, rz, x, z, w, d, seed) }, 0);
    }
  }

  for (const parcel of parcels) {
    if (
      parcel.x > originX + width + 24
      || parcel.x + parcel.w < originX - 24
      || parcel.z > originZ + depth + 24
      || parcel.z + parcel.d < originZ - 24
    ) continue;
    const random = (salt: number) => hash(parcel.x, parcel.z, salt, seed);
    const { x: px, z: pz, w: pw, d: pd } = parcel;
    const { district } = parcel;
    if (parcel.landmark) { landmark(parcel); continue; }
    box(px, 1, pz, pw, 1, pd, C.paving);

    if (random(18) < (district.kind === 'gardens' ? 0.28 : METROPOLIS_PARKS)) {
      park(parcel);
      continue;
    }

    if (random(10) < 0.065 && pw > 12 && pd > 12) {
      box(px + 3, 2, pz + 3, pw - 6, 1, pd - 6, C.stone);
      rim(px + 4, 3, pz + 4, pw - 8, pd - 8, C.teal);
      box(px + 5, 3, pz + 5, pw - 10, 1, pd - 10, C.glass);
      for (const dx of [2, pw - 3]) {
        for (const dz of [2, pd - 3]) tree(px + dx, 2, pz + dz, dx);
      }
      continue;
    }

    const family = district.kind === 'business' ? 1 : district.kind === 'works' ? 3 : Math.floor(random(11) * 6);
    const crown = district.kind === 'old-town' || district.kind === 'works' ? 7
      : district.kind === 'business' ? 1 : district.kind === 'civic' && random(17) < 0.12 ? Math.floor(random(24) * 7) : 5;
    const colors = PALETTES[random(12) < 0.18 ? Math.floor(random(23) * PALETTES.length) : district.palette];
    const yard = district.kind === 'gardens' ? Math.max(2, Math.floor(Math.min(pw, pd) * 0.16)) : 1;
    const x = px + yard;
    const z = pz + yard;
    const w = pw - yard * 2;
    const d = pd - yard * 2;
    if (yard > 1) {
      box(px + 1, 1, pz + 1, pw - 2, 1, pd - 2, C.grass);
      box(x, 1, z, w, 1, d, C.paving);
      tree(px + 2, 2, pz + 2, parcel.id);
    }
    const cx = x + w / 2;
    const cz = z + d / 2;
    const variation = smoothField(cx, cz, 96, 240, seed);
    const centre = Math.exp(-((cx - district.centreX) ** 2 / district.radiusX ** 2
      + (cz - district.centreZ) ** 2 / district.radiusZ ** 2));
    const cluster = Math.max(0, Math.min(1, (centre - 0.18) / 0.7));
    const heights = { 'old-town': 10 + variation * 12, gardens: 12 + variation * 10,
      works: 14 + variation * 14, terraces: 30 + variation * 28,
      civic: 25 + variation * 18, business: 24 + variation * 9 + cluster * 76 };
    // Ninety-six-metre height fields and larger tower lots give adjacent
    // buildings related heights. Distinct districts supply the large changes.
    const height = Math.max(12, Math.min(maxHeight, Math.round(heights[district.kind] + (random(13) - 0.5) * 4)));
    const floorHeight = 3 + Math.floor(random(14) * 2);
    const bay = 2 + Math.floor(random(15) * 3);
    const tiers = district.kind === 'old-town' || district.kind === 'works' || district.kind === 'gardens'
      ? 1 : Math.min(3, 1 + Math.floor(height / 38));
    const sections: Section[] = [];
    let sx = x;
    let sz = z;
    let sw = w;
    let sd = d;
    let bottom = 5;

    box(x, 2, z, w, 3, d, colors.wall);
    for (let a = 2; a < w - 2; a += 4) {
      box(x + a, 2, z, 2, 2, 1, C.dark);
      box(x + a, 2, z + d - 1, 2, 2, 1, C.dark);
      if (family === 4) box(x + a, 2, z + d - 2, 2, 2, 2, 0);
    }
    box(x - 1, 5, z - 1, w + 2, 1, d + 2, colors.frame);

    for (let tier = 0; tier < tiers; tier++) {
      const top = tier === tiers - 1
        ? height
        : Math.floor(6 + (height - 6) * (
          (tier + 1) / tiers + (random(80 + tier) - 0.5) * 0.15
        ));
      sections.push({ x: sx, z: sz, w: sw, d: sd, bottom, top: top + 2 });
      box(sx, bottom, sz, sw, top - bottom, sd, colors.wall);
      for (let face = 0; face < 4; face++) {
        const side = face >= 2;
        const far = face % 2 === 1;
        const length = side ? sd : sw;
        const put = (u: number, y: number, span: number, high: number, color: number) => {
          box(
            side ? sx + (far ? sw - 1 : 0) : sx + u,
            y,
            side ? sz + u : sz + (far ? sd - 1 : 0),
            side ? 1 : span,
            high,
            side ? span : 1,
            color,
          );
        };
        for (let y = bottom + 1; y < top - 1; y += floorHeight) {
          for (let u = 1; u < length - 1; u++) {
            const rib = (u + (family === 3 ? tier : 0)) % bay === 0;
            if (rib && family !== 1) {
              put(u, y, 1, Math.min(floorHeight, top - y), colors.frame);
              continue;
            }
            const lit = hash(px + u, pz + face, y, seed);
            put(
              u,
              y,
              1,
              Math.min(floorHeight - 1, top - 1 - y),
              lit < 0.12 ? C.brass : lit < 0.32 ? C.glass : C.dark,
            );
            if (detail > 0 && lit < detail * 0.38) {
              const mx = side ? sx + (far ? sw : -0.25) : sx + u;
              const mz = side ? sz + u : sz + (far ? sd : -0.25);
              microBox(
                mx,
                y,
                mz,
                side ? 0.25 : 1,
                0.25,
                side ? 1 : 0.25,
                colors.frame,
              );
            }
          }
          if (
            family === 1
            || family === 5
            || (y - bottom - 1) % (floorHeight * 3) === 0
          ) put(0, y - 1, length, 1, family === 1 ? colors.frame : C.clay);
        }
        for (const u of [0, length - 1]) put(u, bottom, 1, top - bottom, colors.frame);
      }
      box(sx - 1, top, sz - 1, sw + 2, 1, sd + 2, C.clay);
      box(sx, top + 1, sz, sw, 1, sd, colors.roof);
      rim(sx, top + 2, sz, sw, sd, colors.frame);
      if (detail > 0.25) {
        for (let vent = 0; vent < 1 + Math.floor(random(25 + tier) * 3); vent++) {
          microBox(sx + 1 + vent * 2, top + 2, sz + 1, 1, 0.5, 1, C.slate);
        }
      }
      if (tier < tiers - 1) {
        const shrinkX = sw > 8 ? 2 + Math.floor(random(30 + tier) * 2) : 0;
        const shrinkZ = sd > 8 ? 2 + Math.floor(random(40 + tier) * 2) : 0;
        sx += Math.floor(shrinkX * (0.25 + random(50 + tier) * 0.5));
        sz += Math.floor(shrinkZ * (0.25 + random(60 + tier) * 0.5));
        sw -= shrinkX;
        sd -= shrinkZ;
        bottom = top + 2;
      }
    }

    const roofY = height + 3;
    const rw = Math.max(3, sw - 4);
    const rd = Math.max(3, sd - 4);
    const roofX = sx + Math.floor((sw - rw) / 2);
    const roofZ = sz + Math.floor((sd - rd) / 2);
    if (crown === 0 || crown === 3) {
      const radius = Math.max(2, Math.floor(Math.min(sw, sd) / 2) - 1);
      const centreX = sx + Math.floor(sw / 2);
      const centreZ = sz + Math.floor(sd / 2);
      box(centreX - radius, roofY, centreZ - radius, radius * 2 + 1, 2, radius * 2 + 1, colors.frame);
      for (let dy = 0; dy <= radius; dy++) {
        const radiusAtY = Math.max(
          0,
          Math.ceil(Math.sqrt(Math.max(0, radius * radius - dy * dy))) - (dy === radius ? 0 : 1),
        );
        for (let dx = -radiusAtY; dx <= radiusAtY; dx++) {
          for (let dz = -radiusAtY; dz <= radiusAtY; dz++) {
            if (Math.abs(dx) + Math.abs(dz) <= radiusAtY * 1.55) {
              box(
                centreX + dx,
                roofY + 2 + dy,
                centreZ + dz,
                1,
                1,
                1,
                crown === 3 ? C.gold : colors.roof,
              );
            }
          }
        }
      }
      box(centreX, roofY + radius + 3, centreZ, 1, 3, 1, C.brass);
      microBox(
        centreX + 0.25,
        roofY + radius + 6,
        centreZ + 0.25,
        0.5,
        2,
        0.5,
        colors.frame,
      );
    } else if (crown === 2 || crown === 4) {
      const crownHeight = crown === 4 ? 6 : 3;
      box(roofX, roofY, roofZ, rw, crownHeight, rd, C.dark);
      for (const dx of [0, rw - 1]) {
        for (const dz of [0, rd - 1]) {
          box(roofX + dx, roofY, roofZ + dz, 1, crownHeight, 1, colors.frame);
        }
      }
      for (let tier = 0; tier < (crown === 2 ? 3 : 1); tier++) {
        const inset = Math.min(tier, Math.floor(Math.min(rw, rd) / 2) - 1);
        box(
          roofX - 1 + inset,
          roofY + crownHeight + tier * 2,
          roofZ - 1 + inset,
          rw + 2 - inset * 2,
          1,
          rd + 2 - inset * 2,
          colors.roof,
        );
        box(
          roofX + inset,
          roofY + crownHeight + tier * 2 + 1,
          roofZ + inset,
          rw - inset * 2,
          1,
          rd - inset * 2,
          colors.roof,
        );
      }
      box(
        roofX + Math.floor(rw / 2),
        roofY + crownHeight + (crown === 2 ? 6 : 2),
        roofZ + Math.floor(rd / 2),
        1,
        3,
        1,
        C.brass,
      );
    } else if (crown === 6) {
      const tw = Math.max(3, Math.floor(rw * 0.6));
      const td = Math.max(3, Math.floor(rd * 0.55));
      const th = 5 + Math.floor(random(74) * 5);
      box(roofX, roofY, roofZ, tw, th, td, colors.frame);
      for (let y = roofY + 1; y < roofY + th - 1; y += 2) {
        box(roofX + 1, y, roofZ, tw - 2, 1, 1, C.dark);
        box(roofX + 1, y, roofZ + td - 1, tw - 2, 1, 1, C.dark);
        box(roofX + tw - 1, y, roofZ + 1, 1, 1, td - 2, C.dark);
      }
      box(roofX, roofY + th, roofZ, tw, 1, td, colors.roof);
      box(roofX + rw - 1, roofY, roofZ + rd - 1, 1, 3, 1, C.brass);
      if (detail > 0.2) {
        microBox(roofX + rw - 1.5, roofY, roofZ, 0.5, 4, 0.5, C.slate);
      }
    } else if (crown === 7) {
      const alongX = rw > rd;
      const narrow = Math.min(rw, rd);
      for (let t = 0; t <= Math.floor(narrow / 2); t++) {
        box(
          roofX + (alongX ? 0 : t),
          roofY + t,
          roofZ + (alongX ? t : 0),
          alongX ? rw : Math.max(1, rw - t * 2),
          1,
          alongX ? Math.max(1, rd - t * 2) : rd,
          colors.roof,
        );
      }
    } else {
      box(roofX, roofY, roofZ, rw, 2, rd, colors.frame);
      box(roofX, roofY + 2, roofZ, rw, 1, rd, colors.roof);
      if (crown === 5) {
        box(roofX, roofY + 3, roofZ, rw, 1, 1, C.leaf);
        box(roofX, roofY + 3, roofZ, 1, 1, rd, C.leafLight);
        box(roofX + rw - 1, roofY + 3, roofZ + rd - 1, 1, 2, 1, C.brass);
      } else if (detail > 0.15) {
        microBox(roofX + 0.5, roofY + 3, roofZ + 0.5, 1.5, 1, 1, C.slate);
        microBox(
          roofX + rw - 1,
          roofY + 3,
          roofZ + rd - 1,
          0.5,
          3 + Math.floor(random(71) * 3),
          0.5,
          C.brass,
        );
      }
    }

    if (detail > 0.3 && random(72) < 0.45) {
      for (let a = 1; a < w - 1; a++) {
        microBox(x + a, 4, z + d, 1, 0.5, 1, a % 3 ? colors.roof : colors.frame);
      }
    }
    if (random(73) < 0.23 && pw > 14) tree(px + pw - 2, 2, pz + 1, parcel.id);
    buildings.push({
      ...parcel,
      x,
      z,
      w,
      d,
      id: parcel.id,
      height,
      roof: roofY,
      family,
      crown,
      sections,
    });
  }

  for (const a of buildings) {
    if (hash(a.x, a.z, 90, seed) >= METROPOLIS_BRIDGES) continue;
    const alongX = hash(a.x, a.z, 91, seed) > 0.5;
    let best: Building | undefined;
    let distance = 16;
    for (const b of buildings) {
      const gap = alongX ? b.x - a.x - a.w : b.z - a.z - a.d;
      const overlap = alongX
        ? Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z)
        : Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      if (gap >= 2 && gap < distance && overlap >= 5) {
        best = b;
        distance = gap;
      }
    }
    if (!best) continue;
    const level = Math.max(
      7,
      Math.floor(Math.min(a.height, best.height) * (0.4 + hash(a.x, a.z, 92, seed) * 0.3)),
    );
    const from = a.sections.find(section => level >= section.bottom && level < section.top);
    const to = best.sections.find(section => level >= section.bottom && level < section.top);
    if (!from || !to) continue;
    const low = alongX ? Math.max(from.z, to.z) : Math.max(from.x, to.x);
    const high = alongX
      ? Math.min(from.z + from.d, to.z + to.d)
      : Math.min(from.x + from.w, to.x + to.w);
    if (high - low < 3) continue;
    const cross = Math.floor((low + high - 3) / 2);
    distance = alongX ? to.x - from.x - from.w : to.z - from.z - from.d;
    const bridgeX = alongX ? from.x + from.w : cross;
    const bridgeZ = alongX ? cross : from.z + from.d;
    const bridgeW = alongX ? distance : 3;
    const bridgeD = alongX ? 3 : distance;
    box(bridgeX, level, bridgeZ, bridgeW, 1, bridgeD, C.stone);
    box(bridgeX, level + 3, bridgeZ, bridgeW, 1, bridgeD, C.teal);
    for (let t = 0; t < distance; t += 3) {
      for (const side of [0, 2]) {
        box(
          bridgeX + (alongX ? t : side),
          level + 1,
          bridgeZ + (alongX ? side : t),
          1,
          2,
          1,
          C.stone,
        );
      }
    }
  }

  if (kernels) return kernels.rasterizeCopper(chunk, solidOps, microOps);

  const details: number[] = [];
  for (let index = 0; index < rawDetails.length; index += 4) {
    const mx = rawDetails[index];
    const my = rawDetails[index + 1];
    const mz = rawDetails[index + 2];
    const parentX = Math.floor(mx / MICRO_DIVISIONS);
    const parentY = Math.floor(my / MICRO_DIVISIONS);
    const parentZ = Math.floor(mz / MICRO_DIVISIONS);
    if (chunk.blocks[Chunk.getIndex(parentX, parentY, parentZ)] !== BlockTypes.AIR) continue;
    details.push(mx, my, mz, rawDetails[index + 3]);
  }

  let minOccupiedY = CHUNK_SIZE_Y;
  let maxOccupiedY = -1;
  for (let y = 0; y < CHUNK_SIZE_Y; y++) {
    for (let z = 0; z < CHUNK_SIZE_Z; z++) {
      for (let x = 0; x < CHUNK_SIZE_X; x++) {
        if (chunk.blocks[Chunk.getIndex(x, y, z)] === BlockTypes.AIR) continue;
        minOccupiedY = Math.min(minOccupiedY, y);
        maxOccupiedY = Math.max(maxOccupiedY, y);
      }
    }
  }
  chunk.setGeneratedOccupiedYRange(minOccupiedY, maxOccupiedY);
  chunk.hasGenerated = true;
  return Uint32Array.from(details);
}
