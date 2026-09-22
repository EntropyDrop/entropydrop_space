import { Chunk, CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from '../voxel/Chunk.ts';
import { BlockTypes } from '../voxel/BlockTypes.ts';
import { TORUS_SIZE_X, TORUS_SIZE_Z, TORUS_SPAWN_X, TORUS_SPAWN_Z } from '../torus/TorusWorld.ts';
import { terrainLabSpawnAnchor } from './TerrainLabGenerator.ts';
import { AETHER_DEFAULTS, aetherSpawnAnchor, generateAetherRegion } from './AetherArchipelagoGenerator.ts';
import { HARBOR_DEFAULTS, generateHarborRegion, sampleColossusHarbor } from './ColossusHarborGenerator.ts';
import { CANYON_DEFAULTS, generateCanyonRegion, sampleTitanCanyon } from './TitanCanyonGenerator.ts';
import { FOUNDRY_DEFAULTS, generateFoundryRegion } from './AstralFoundryGenerator.ts';
import { BRUTALIST_DUSK_DEFAULTS, generateBrutalistDuskRegion } from './BrutalistDuskGenerator.ts';
import type { TerrainLabRegion } from './TerrainLabRegion.ts';

export const TERRAIN_GENERATOR_MIXED = 8;
export const MIXED_BIOME_PITCH = 1024;
/** Half-width: a two-biome boundary blends across 256 metres. */
export const MIXED_BLEND_RADIUS = 128;
export const MIXED_BIOMES = [
  { name: 'Brutalist Dusk', version: 7 }, { name: 'Colossus Harbor', version: 4 },
  { name: 'Titan Canyon', version: 5 }, { name: 'Astral Foundry', version: 6 },
  { name: 'Aether Archipelago', version: 3 },
] as const;
export interface MixedBiomeSite {
  id: number; ix: number; iz: number; x: number; z: number; seed: number; biome: number;
}
export interface MixedRegionConfig {
  seed: number; sizeX: number; sizeY: number; sizeZ: number;
  offsetX: number; offsetZ: number; yCutoff: number;
}
const NX = TORUS_SIZE_X / MIXED_BIOME_PITCH, NZ = TORUS_SIZE_Z / MIXED_BIOME_PITCH;
const OCCUPIED = 0x80000000;
const mod = (x: number, period: number) => ((x % period) + period) % period;
const smooth = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * t * (t * (t * 6 - 15) + 10); };
function hash(x: number, z: number, seed: number) {
  let n = Math.imul(seed ^ x ^ 0x9e3779b9, 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 16) ^ z, 0xc2b2ae35);
  return (n ^ (n >>> 13)) >>> 0;
}

export function mixedBiomeSite(seed: number, ix: number, iz: number): MixedBiomeSite {
  const cx = mod(ix, NX), cz = mod(iz, NZ), id = cx + cz * NX;
  // Balanced labels guarantee every biome on the finite ring; jitter and warp
  // prevent chunk-aligned borders. The spawn district remains Brutalist Dusk.
  const jitter = (salt: number) => (hash(cx, cz + salt, seed) % 15 - 7) * 16;
  return { id, ix, iz, biome: mod(cx + cz * 2, MIXED_BIOMES.length),
    seed: id === 0 ? seed : hash(cx, cz, seed) & 0x7fffffff,
    x: ix * MIXED_BIOME_PITCH + (id === 0 ? 0 : jitter(71)),
    z: iz * MIXED_BIOME_PITCH + (id === 0 ? 0 : jitter(83)) };
}

function warp(x: number, z: number) {
  const u = mod(x, 4096) * Math.PI * 2 / 4096, v = mod(z, 2048) * Math.PI * 2 / 2048;
  return { x: x + 40 * Math.sin(v) + 24 * Math.sin(u), z: z + 32 * Math.sin(u) + 24 * Math.sin(v) };
}
const neighbours = (seed: number, x: number, z: number) => {
  const ix = Math.round(x / MIXED_BIOME_PITCH), iz = Math.round(z / MIXED_BIOME_PITCH), sites: MixedBiomeSite[] = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) sites.push(mixedBiomeSite(seed, ix + dx, iz + dz));
  return sites;
};
function margin(site: MixedBiomeSite, sites: MixedBiomeSite[], x: number, z: number) {
  let distance = Infinity;
  // Exact distance to the unwarped Voronoi bisectors, not a chunk-level vote.
  for (const other of sites) {
    if (other.ix === site.ix && other.iz === site.iz) continue;
    const dx = other.x - site.x, dz = other.z - site.z;
    distance = Math.min(distance, ((dx * dx + dz * dz) / 2 - (x - site.x) * dx - (z - site.z) * dz) / Math.hypot(dx, dz));
  }
  return distance;
}

export function sampleMixedBiomes(seed: number, x: number, z: number) {
  const cx = mod(x + TORUS_SIZE_X / 2, TORUS_SIZE_X) - TORUS_SIZE_X / 2;
  const cz = mod(z + TORUS_SIZE_Z / 2, TORUS_SIZE_Z) - TORUS_SIZE_Z / 2;
  const shiftX = x - cx, shiftZ = z - cz;
  x = cx; z = cz;
  const p = warp(x, z), sites = neighbours(seed, p.x, p.z);
  const active = sites.map(site => ({ site, weight: smooth((margin(site, sites, p.x, p.z) + MIXED_BLEND_RADIUS) / (MIXED_BLEND_RADIUS * 2)) }))
    .filter(entry => entry.weight > 0);
  const sum = active.reduce((n, entry) => n + entry.weight, 0);
  for (const entry of active) {
    entry.weight /= sum;
    if (shiftX || shiftZ) entry.site = { ...entry.site, x: entry.site.x + shiftX, z: entry.site.z + shiftZ,
      ix: entry.site.ix + shiftX / MIXED_BIOME_PITCH, iz: entry.site.iz + shiftZ / MIXED_BIOME_PITCH };
  }
  return active;
}

/** Keep complete footprints. The periodic warp's Lipschitz bound is < 1.4,
 * so this conservative radius also protects curved borders and triple points.
 * Floating islands can extend into the transition while keeping their roots. */
export function mixedFeatureFits(seed: number, site: MixedBiomeSite, x: number, z: number, radius: number) {
  const cx = mod(x + TORUS_SIZE_X / 2, TORUS_SIZE_X) - TORUS_SIZE_X / 2;
  const cz = mod(z + TORUS_SIZE_Z / 2, TORUS_SIZE_Z) - TORUS_SIZE_Z / 2;
  const shiftX = x - cx, shiftZ = z - cz;
  site = { ...site, x: site.x - shiftX, z: site.z - shiftZ,
    ix: site.ix - shiftX / MIXED_BIOME_PITCH, iz: site.iz - shiftZ / MIXED_BIOME_PITCH };
  x = cx; z = cz;
  const p = warp(x, z), sites = neighbours(seed, p.x, p.z);
  const threshold = site.biome === 4 ? -MIXED_BLEND_RADIUS : MIXED_BLEND_RADIUS;
  return margin(site, sites, p.x, p.z) >= threshold + radius * 1.4 + 8;
}

function anchor(site: MixedBiomeSite) {
  return site.biome === 4 ? aetherSpawnAnchor(site.seed) : terrainLabSpawnAnchor(site.seed, MIXED_BIOMES[site.biome].version);
}
function groundHeight(site: MixedBiomeSite, x: number, z: number) {
  if (site.biome === 4) return 0;
  if (site.biome === 0 || site.biome === 3) return 1;
  const a = anchor(site), offsetX = x - site.x + a.x, offsetZ = z - site.z + a.z;
  const base = { seed: site.seed, sizeX: 1, sizeZ: 1, sizeY: 256, yCutoff: 256, offsetX, offsetZ };
  return site.biome === 1
    ? Math.max(12, sampleColossusHarbor(offsetX, offsetZ, { ...base, ...HARBOR_DEFAULTS }).height)
    : Math.max(15, sampleTitanCanyon(offsetX, offsetZ, { ...base, ...CANYON_DEFAULTS }).height);
}

function transitionGroundHeight(site: MixedBiomeSite, x: number, z: number, weight: number, raw: number) {
  if (weight === 1 || site.biome === 0 || site.biome >= 3) return raw;
  // Basin samplers contain intentional terraces and occasional watershed jumps.
  // Ease those into a continuous 16m terrain lattice in the shared border;
  // restore the original relief as a biome reaches full strength.
  const gx = Math.floor(x / 16) * 16, gz = Math.floor(z / 16) * 16, u = (x - gx) / 16, v = (z - gz) / 16;
  const a = groundHeight(site, gx, gz), b = groundHeight(site, gx + 16, gz);
  const c = groundHeight(site, gx, gz + 16), d = groundHeight(site, gx + 16, gz + 16);
  const filtered = (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  return raw + (filtered - raw) * smooth((1 - weight) / 0.15);
}

export function sampleMixedGroundHeight(seed: number, x: number, z: number) {
  return sampleMixedBiomes(seed, x, z).reduce((height, { site, weight }) =>
    height + transitionGroundHeight(site, x, z, weight, groundHeight(site, x, z)) * weight, 0);
}

function generateSource(config: MixedRegionConfig, site: MixedBiomeSite, includeDetails: boolean): TerrainLabRegion {
  const a = anchor(site), source = { ...config, seed: site.seed,
    offsetX: config.offsetX - site.x + a.x, offsetZ: config.offsetZ - site.z + a.z,
    placement: (x: number, z: number, radius: number) => mixedFeatureFits(config.seed, site, x + site.x - a.x, z + site.z - a.z, radius) };
  if (site.biome === 0) return generateBrutalistDuskRegion({ ...source, ...BRUTALIST_DUSK_DEFAULTS }, includeDetails);
  if (site.biome === 1) return generateHarborRegion({ ...source, ...HARBOR_DEFAULTS }, includeDetails);
  if (site.biome === 2) return generateCanyonRegion({ ...source, ...CANYON_DEFAULTS }, includeDetails);
  if (site.biome === 3) return generateFoundryRegion({ ...source, ...FOUNDRY_DEFAULTS }, includeDetails);
  const r = generateAetherRegion({ ...source, ...AETHER_DEFAULTS }, includeDetails), voxels = new Uint32Array(r.cells.length);
  for (let i = 0; i < r.cells.length; i++) if (r.cells[i]) {
    const p = r.palette[r.cells[i]];
    voxels[i] = (OCCUPIED | p.color | (p.emission > 0 ? 1 << 24 : 0)) >>> 0;
  }
  return { width: config.sizeX, depth: config.sizeZ, height: Math.min(config.sizeY, config.yCutoff), voxels, details: r.details };
}

export function generateMixedRegion(config: MixedRegionConfig, includeDetails = true): TerrainLabRegion {
  const width = Math.max(1, Math.floor(config.sizeX)), depth = Math.max(1, Math.floor(config.sizeZ));
  const height = Math.max(1, Math.floor(Math.min(config.sizeY, config.yCutoff))), layer = width * depth;
  const ox = Math.floor(config.offsetX - width / 2), oz = Math.floor(config.offsetZ - depth / 2);
  const sources = new Map<string, { site: MixedBiomeSite; weights: Float64Array; region?: TerrainLabRegion }>();
  for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
    for (const { site, weight } of sampleMixedBiomes(config.seed, ox + x, oz + z)) {
      const key = `${site.ix}:${site.iz}`;
      if (!sources.has(key)) sources.set(key, { site, weights: new Float64Array(layer) });
      sources.get(key)!.weights[x + z * width] = weight;
    }
  }
  const ordered = [...sources.values()].sort((a, b) => a.site.id - b.site.id || a.site.ix - b.site.ix || a.site.iz - b.site.iz);
  for (const source of ordered) source.region = generateSource({ ...config, sizeX: width, sizeZ: depth, sizeY: height, yCutoff: height }, source.site, includeDetails);
  const voxels = new Uint32Array(layer * height), details = new Map<number, number>();
  for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
    const column = x + z * width, core = ordered.find(s => s.weights[column] === 1);
    if (core) {
      for (let y = 0; y < height; y++) voxels[column + y * layer] = core.region!.voxels[column + y * layer];
      continue;
    }
    // Interpolate the actual source ground columns, retaining layer colours.
    // Do not blend tower tops as terrain heights or fill the hollow architecture.
    const ground = ordered.filter(s => s.weights[column] > 0 && s.site.biome !== 4).map(s => {
      const raw = groundHeight(s.site, ox + x, oz + z), weight = s.weights[column];
      return { source: s, h: Math.min(height, raw), weight,
        blended: transitionGroundHeight(s.site, ox + x, oz + z, weight, raw) };
    });
    const top = Math.min(height, Math.round(ground.reduce((n, g) => n + g.blended * g.weight, 0)));
    const total = ground.reduce((n, g) => n + g.weight, 0);
    for (let y = 0; y < top; y++) {
      let red = 0, green = 0, blue = 0;
      for (const g of ground) {
        const sy = Math.min(g.h - 1, Math.floor(y * g.h / top)), value = g.source.region!.voxels[column + sy * layer];
        red += (value >>> 16 & 255) * g.weight; green += (value >>> 8 & 255) * g.weight; blue += (value & 255) * g.weight;
      }
      voxels[column + y * layer] = (OCCUPIED | Math.round(red / total) << 16 | Math.round(green / total) << 8 | Math.round(blue / total)) >>> 0;
    }
    for (const source of ordered) if (source.site.biome === 4 && source.weights[column] > 0) {
      for (let y = top; y < height; y++) {
        const i = column + y * layer, value = source.region!.voxels[i];
        if (value) voxels[i] = value;
      }
    }
  }
  for (const source of ordered) {
    const d = source.region!.details;
    for (let i = 0; i < d.length; i += 4) {
      const [x, y, z, packed] = d.subarray(i, i + 4), column = (x >> 3) + (z >> 3) * width;
      if (source.weights[column] <= 0 || (source.site.biome !== 4 && source.weights[column] !== 1)
        || voxels[column + (y >> 3) * layer]) continue;
      details.set(x + z * width * 8 + y * layer * 64, packed);
    }
  }
  const micro: number[] = [];
  for (const [key, packed] of details) micro.push(key % (width * 8), Math.floor(key / (layer * 64)), Math.floor(key / (width * 8)) % (depth * 8), packed);
  return { width, depth, height, voxels, details: new Uint32Array(micro) };
}

export function generateMixedChunk(chunk: Chunk, seed: number, includeDetails: boolean) {
  const origin = chunk.getWorldOrigin();
  const region = generateMixedRegion({ seed, sizeX: CHUNK_SIZE_X, sizeZ: CHUNK_SIZE_Z, sizeY: CHUNK_SIZE_Y, yCutoff: CHUNK_SIZE_Y,
    offsetX: origin.x - TORUS_SPAWN_X + CHUNK_SIZE_X / 2, offsetZ: origin.z - TORUS_SPAWN_Z + CHUNK_SIZE_Z / 2 }, includeDetails);
  let minY = CHUNK_SIZE_Y, maxY = -1;
  for (let i = 0; i < region.voxels.length; i++) if (region.voxels[i]) {
    const value = region.voxels[i], y = Math.floor(i / (CHUNK_SIZE_X * CHUNK_SIZE_Z));
    chunk.blocks[i] = BlockTypes.COLOR_BLOCK; chunk.colors[i] = value & 0xffffff; chunk.materials[i] = value >>> 24 & 1;
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  chunk.setGeneratedOccupiedYRange(minY, maxY); chunk.hasGenerated = true;
  return region.details;
}
