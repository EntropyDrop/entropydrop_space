import { Chunk, CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from '../voxel/Chunk.ts';
import { BlockTypes } from '../voxel/BlockTypes.ts';
import {
  TORUS_SIZE_X,
  TORUS_SIZE_Z,
  TORUS_SPAWN_X,
  TORUS_SPAWN_Z,
} from '../torus/TorusWorld.ts';

/**
 * Chunk-local port of terrain-lab's Copper Metropolis algorithm.
 *
 * The source design lives in entropydrop_frontend/terrain-lab. The world
 * generator keeps its one-metre architecture while deliberately omitting the
 * preview's eighth-metre ornaments: generated terrain has no persistent micro
 * layer, and all authored micro voxels must continue to come from world edits.
 */

const METROPOLIS_HEIGHT = 112;
const METROPOLIS_LOTS = 19;
const METROPOLIS_SPREAD = 0.7;
const METROPOLIS_BRIDGES = 0.35;

type Parcel = { x: number; z: number; w: number; d: number; id: number };
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

export function generateCopperMetropolisChunk(chunk: Chunk, seed: number) {
  const worldOrigin = chunk.getWorldOrigin();
  const originX = centeredCoordinate(worldOrigin.x, TORUS_SPAWN_X, TORUS_SIZE_X);
  const originZ = centeredCoordinate(worldOrigin.z, TORUS_SPAWN_Z, TORUS_SIZE_Z);
  const width = CHUNK_SIZE_X;
  const depth = CHUNK_SIZE_Z;
  const ceiling = CHUNK_SIZE_Y;
  const lotSize = METROPOLIS_LOTS;
  const maxHeight = METROPOLIS_HEIGHT;
  const spread = METROPOLIS_SPREAD;
  const parcels: Parcel[] = [];
  const buildings: Building[] = [];

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

  box(originX, 0, originZ, width, 1, depth, C.road);

  const regionSize = 240;
  const edge = (i: number, axis: number) => (
    i * regionSize - 120 + Math.floor(hash(i, axis, 8, seed) * 44)
  );
  const split = (parcel: Parcel, level: number) => {
    const random = (salt: number) => hash(parcel.x, parcel.z, parcel.id + salt, seed);
    const alongX = parcel.w / parcel.d > 1.3
      || (parcel.w / parcel.d > 0.77 && random(5) > 0.5);
    const length = alongX ? parcel.w : parcel.d;
    const stop = lotSize * (1 + random(6) * 0.58);
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
    split({
      ...parcel,
      w: alongX ? cut : parcel.w,
      d: alongX ? parcel.d : cut,
      id: parcel.id * 2 + 1,
    }, level + 1);
    split({
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
      split({ x, z, w, d, id: 1 }, 0);
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
    box(px, 1, pz, pw, 1, pd, C.paving);

    if (random(10) < 0.065 && pw > 12 && pd > 12) {
      box(px + 3, 2, pz + 3, pw - 6, 1, pd - 6, C.stone);
      rim(px + 4, 3, pz + 4, pw - 8, pd - 8, C.teal);
      box(px + 5, 3, pz + 5, pw - 10, 1, pd - 10, C.glass);
      for (const dx of [2, pw - 3]) {
        for (const dz of [2, pd - 3]) tree(px + dx, 2, pz + dz, dx);
      }
      continue;
    }

    const family = Math.floor(random(11) * 6);
    const crown = Math.floor(random(17) * 8);
    const colors = PALETTES[Math.floor(random(12) * PALETTES.length)];
    const x = px + 1;
    const z = pz + 1;
    const w = pw - 2;
    const d = pd - 2;
    const cx = x + w / 2;
    const cz = z + d / 2;
    const centre = Math.exp(-((cx + 9) ** 2 / 4900 + (cz + 16) ** 2 / 3600));
    const secondary = Math.max(
      Math.exp(-((cx - 75) ** 2 + (cz + 51) ** 2) / 1800) * 0.57,
      Math.exp(-((cx + 68) ** 2 + (cz - 29) ** 2) / 1500) * 0.49,
    );
    const cluster = Math.max(centre, secondary);
    const variation = 0.54 + random(13) * 0.46;
    const height = Math.max(
      12,
      Math.floor(maxHeight * (0.16 + cluster * 0.78) * (1 - spread + spread * variation)),
    );
    const floorHeight = 3 + Math.floor(random(14) * 2);
    const bay = 2 + Math.floor(random(15) * 3);
    const tiers = Math.min(4, 1 + Math.floor(height / 23) + (family === 2 ? 1 : 0));
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
      }
    }

    if (random(73) < 0.23 && pw > 14) tree(px + pw - 2, 2, pz + 1, parcel.id);
    buildings.push({
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
}
