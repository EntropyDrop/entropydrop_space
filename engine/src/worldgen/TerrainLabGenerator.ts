import { Chunk, CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from '../voxel/Chunk.ts';
import { BlockTypes } from '../voxel/BlockTypes.ts';
import { TORUS_SIZE_X, TORUS_SIZE_Z, TORUS_SPAWN_X, TORUS_SPAWN_Z } from '../torus/TorusWorld.ts';
import { HARBOR_DEFAULTS, generateHarborRegion, planColossusHarbor } from './ColossusHarborGenerator.ts';
import { CANYON_DEFAULTS, generateCanyonRegion, planTitanCanyon } from './TitanCanyonGenerator.ts';
import { FOUNDRY_DEFAULTS, generateFoundryRegion, planAstralFoundry } from './AstralFoundryGenerator.ts';
import { BRUTALIST_DUSK_DEFAULTS, generateBrutalistDuskRegion, brutalistDuskSpawnAnchor } from './BrutalistDuskGenerator.ts';

export const TERRAIN_GENERATOR_COLOSSUS_HARBOR = 4;
export const TERRAIN_GENERATOR_TITAN_CANYON = 5;
export const TERRAIN_GENERATOR_ASTRAL_FOUNDRY = 6;
export const TERRAIN_GENERATOR_BRUTALIST_DUSK = 7;
const anchors = new Map<string, { x: number; z: number }>();
const centered = (value: number, spawn: number, period: number) =>
  ((value - spawn + period / 2) % period + period) % period - period / 2;

/** Align a landmark's solid plinth/deck with the shared torus spawn. */
export function terrainLabSpawnAnchor(seed: number, version: number) {
  const key = `${seed}:${version}`, cached = anchors.get(key);
  if (cached) return cached;
  const config = { seed, sizeX: 384, sizeZ: 384, sizeY: 256, yCutoff: 256, offsetX: 0, offsetZ: 0 };
  const nearest = <T extends { x: number; z: number }>(sites: T[]) =>
    sites.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
  let anchor = { x: 0, z: 0 };
  if (version === TERRAIN_GENERATOR_COLOSSUS_HARBOR) {
    const site = nearest(planColossusHarbor({ ...config, ...HARBOR_DEFAULTS }).statues);
    if (site) anchor = { x: site.x + 4, z: site.z + Math.ceil(site.height * (site.family === 'lion' ? .23 : .18)) - 2 };
  } else if (version === TERRAIN_GENERATOR_TITAN_CANYON) {
    const site = nearest(planTitanCanyon({ ...config, ...CANYON_DEFAULTS }));
    if (site) anchor = { x: site.x - site.bank * 35, z: site.z + site.bank * (site.mirror ? -24 : 24) };
  } else if (version === TERRAIN_GENERATOR_BRUTALIST_DUSK) {
    anchor = brutalistDuskSpawnAnchor(seed);
  } else {
    const site = nearest(planAstralFoundry({ ...config, ...FOUNDRY_DEFAULTS }).filter(node => node.major));
    if (site) {
      const x = -Math.floor(site.w / 2) + site.w - 2, z = -Math.floor(site.d / 2) + site.d + 6;
      anchor = site.rotation === 1 ? { x: site.x - z, z: site.z + x }
        : site.rotation === 2 ? { x: site.x - x, z: site.z - z }
          : site.rotation === 3 ? { x: site.x + z, z: site.z - x } : { x: site.x + x, z: site.z + z };
    }
  }
  if (anchors.size >= 32) anchors.delete(anchors.keys().next().value!);
  anchors.set(key, anchor);
  return anchor;
}

export function generateTerrainLabChunk(chunk: Chunk, seed: number, version: number, includeDetails: boolean) {
  const origin = chunk.getWorldOrigin(), anchor = terrainLabSpawnAnchor(seed, version);
  const config = { seed, sizeX: CHUNK_SIZE_X, sizeZ: CHUNK_SIZE_Z, sizeY: CHUNK_SIZE_Y, yCutoff: CHUNK_SIZE_Y,
    offsetX: centered(origin.x, TORUS_SPAWN_X, TORUS_SIZE_X) + anchor.x + CHUNK_SIZE_X / 2,
    offsetZ: centered(origin.z, TORUS_SPAWN_Z, TORUS_SIZE_Z) + anchor.z + CHUNK_SIZE_Z / 2 };
  const region = version === TERRAIN_GENERATOR_COLOSSUS_HARBOR ? generateHarborRegion({ ...config, ...HARBOR_DEFAULTS }, includeDetails)
    : version === TERRAIN_GENERATOR_TITAN_CANYON ? generateCanyonRegion({ ...config, ...CANYON_DEFAULTS }, includeDetails)
      : version === TERRAIN_GENERATOR_BRUTALIST_DUSK ? generateBrutalistDuskRegion({ ...config, ...BRUTALIST_DUSK_DEFAULTS }, includeDetails)
        : generateFoundryRegion({ ...config, ...FOUNDRY_DEFAULTS }, includeDetails);
  let minY = CHUNK_SIZE_Y, maxY = -1;
  for (let i = 0; i < region.voxels.length; i++) {
    const value = region.voxels[i];
    if (!value) continue;
    chunk.blocks[i] = BlockTypes.COLOR_BLOCK;
    chunk.colors[i] = value & 0xffffff;
    chunk.materials[i] = value >>> 24 & 1;
    const y = Math.floor(i / (CHUNK_SIZE_X * CHUNK_SIZE_Z));
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  chunk.setGeneratedOccupiedYRange(minY, maxY);
  chunk.hasGenerated = true;
  return region.details;
}
