import type { SurfaceZoneSnapshot, DistantChunkSnapshot, VoxelSurfaceMip } from '@entropydrop/space-engine/voxel/SurfaceZoneSnapshot.ts';
import { createSurfaceDiskCache, type SurfaceByteCache } from './SurfaceDiskCache.ts';
export type { SurfaceZoneSnapshot } from '@entropydrop/space-engine/voxel/SurfaceZoneSnapshot.ts';

import {
  readJsonResponse,
  readResponseBytes,
  resolveSafeHttpUrl,
  sha256Hex,
} from './NetworkSafety.ts';

export const SURFACE_ZONE_SCHEMA_VERSION = 7;
export const SURFACE_ZONE_SAMPLES_PER_CHUNK_AXIS = 16;
export const SURFACE_ZONE_SIZE_CHUNKS = 32;
export const SURFACE_ZONE_HEADER_BYTES = 32;
export const SURFACE_ZONE_RECORD_BYTES = 8;
export const LEGACY_SURFACE_ZONE_RECORD_BYTES = 5;
export const MAX_SURFACE_ZONE_BYTES = 32 * 1024 * 1024;
// 128 zones with seven full authenticated digest URLs exceed 256 KiB in v6.
const MAX_SURFACE_MANIFEST_BYTES = 512 * 1024;
const MAX_SURFACE_ZONES = 128;
const SURFACE_DOWNLOAD_CONCURRENCY = 6;
const SURFACE_LOD_SIZES = [2, 4, 8, 16, 32, 64];
const SURFACE_REFINEMENT_BUDGET_BYTES = 4 * 1024 * 1024;

interface SurfaceLodManifestEntry {
  sample_size: number;
  digest: string;
  byte_length: number;
  url: string;
}

interface SurfaceZoneManifestEntry {
  sample_size?: number;
  zone_x: number;
  zone_z: number;
  revision: number;
  source_terrain_revision: number;
  digest: string;
  byte_length: number;
  url: string;
  lods?: SurfaceLodManifestEntry[];
}

interface SurfaceZoneManifest {
  schema_version: number;
  samples_per_chunk_axis: number;
  zone_size_chunks: number;
  width_chunks: number;
  length_chunks: number;
  complete: boolean;
  zones: SurfaceZoneManifestEntry[];
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}

function resolveSurfaceApiUrl(input: string, apiOrigin: string): URL {
  const url = resolveSafeHttpUrl(input, apiOrigin);
  if (url.origin !== new URL(apiOrigin).origin) {
    throw new Error('Space surface snapshots must use the authenticated API origin.');
  }
  return url;
}

function parseManifest(value: unknown): SurfaceZoneManifest {
  const manifest = value as any;
  if (
    ![3, 5, 6, SURFACE_ZONE_SCHEMA_VERSION].includes(manifest?.schema_version)
    || ![8, 16].includes(manifest?.samples_per_chunk_axis)
    || manifest?.zone_size_chunks !== SURFACE_ZONE_SIZE_CHUNKS
    || !boundedInteger(manifest?.width_chunks, SURFACE_ZONE_SIZE_CHUNKS, 2048)
    || !boundedInteger(manifest?.length_chunks, SURFACE_ZONE_SIZE_CHUNKS, 2048)
    || typeof manifest?.complete !== 'boolean'
    || !Array.isArray(manifest?.zones)
    || manifest.zones.length > MAX_SURFACE_ZONES
  ) {
    throw new Error('Invalid Space surface-zone manifest.');
  }
  const maxZoneX = manifest.width_chunks / manifest.zone_size_chunks;
  const maxZoneZ = manifest.length_chunks / manifest.zone_size_chunks;
  if (
    !Number.isInteger(maxZoneX)
    || !Number.isInteger(maxZoneZ)
    || maxZoneX * maxZoneZ > MAX_SURFACE_ZONES
    || (manifest.complete && manifest.zones.length !== maxZoneX * maxZoneZ)
  ) {
    throw new Error('Invalid Space surface-zone manifest dimensions.');
  }
  const seen = new Set<string>();
  for (const zone of manifest.zones) {
    const key = `${zone?.zone_x},${zone?.zone_z}`;
    if (
      !boundedInteger(zone?.zone_x, 0, maxZoneX - 1)
      || (zone.sample_size !== undefined && ![1, 2].includes(zone.sample_size))
      || !boundedInteger(zone?.zone_z, 0, maxZoneZ - 1)
      || !boundedInteger(zone?.revision, 1, Number.MAX_SAFE_INTEGER)
      || !boundedInteger(zone?.source_terrain_revision, 0, Number.MAX_SAFE_INTEGER)
      || typeof zone?.digest !== 'string'
      || !/^[0-9a-f]{64}$/.test(zone.digest)
      || !boundedInteger(zone?.byte_length, SURFACE_ZONE_HEADER_BYTES, MAX_SURFACE_ZONE_BYTES)
      || typeof zone?.url !== 'string'
      || zone.url.length < 1
      || zone.url.length > 4096
      || seen.has(key)
    ) {
      throw new Error('Invalid Space surface-zone manifest entry.');
    }
    seen.add(key);
    if (zone.lods !== undefined) {
      if (!Array.isArray(zone.lods) || zone.lods.length > SURFACE_LOD_SIZES.length) {
        throw new Error('Invalid Space surface LOD manifest.');
      }
      const levels = new Set<number>();
      for (const level of zone.lods) {
        if (!SURFACE_LOD_SIZES.includes(level?.sample_size)
          || levels.has(level.sample_size)
          || typeof level.digest !== 'string' || !/^[0-9a-f]{64}$/.test(level.digest)
          || !boundedInteger(level.byte_length, SURFACE_ZONE_HEADER_BYTES + (512 / level.sample_size) ** 2 * LEGACY_SURFACE_ZONE_RECORD_BYTES, MAX_SURFACE_ZONE_BYTES)
          || typeof level.url !== 'string' || level.url.length < 1 || level.url.length > 4096) {
          throw new Error('Invalid Space surface LOD manifest entry.');
        }
        levels.add(level.sample_size);
      }
    }
  }
  return manifest;
}

export function parseSurfaceZoneSnapshot(bytes: Uint8Array): SurfaceZoneSnapshot {
  if (bytes.byteLength < SURFACE_ZONE_HEADER_BYTES) {
    throw new Error('Space surface-zone snapshot is truncated.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const schemaVersion = view.getUint8(4);
  const sampleSize = schemaVersion >= 4 ? view.getUint8(5) : undefined;
  const samplesPerChunkAxis = sampleSize ? 16 / sampleSize : view.getUint8(5);
  const zoneSizeChunks = view.getUint8(6);
  const recordBytes = view.getUint8(7);
  const zoneX = view.getUint16(8, true);
  const zoneZ = view.getUint16(10, true);
  const seed = view.getInt32(12, true);
  const terrainGeneratorVersion = view.getUint32(16, true);
  const sourceTerrainRevision = Number(view.getBigUint64(20, true));
  const recordCount = view.getUint32(28, true);
  const expectedRecords = zoneSizeChunks * zoneSizeChunks * samplesPerChunkAxis ** 2;
  const expectedBytes = SURFACE_ZONE_HEADER_BYTES + recordCount * recordBytes;
  if (
    magic !== 'EDSZ'
    || ![3, 4, 5, 6, 7].includes(schemaVersion)
    || (schemaVersion >= 4 ? ![...(schemaVersion >= 6 ? [1] : []), ...SURFACE_LOD_SIZES].includes(sampleSize!)
      : samplesPerChunkAxis !== 8)
    || zoneSizeChunks !== SURFACE_ZONE_SIZE_CHUNKS
    || recordBytes !== (schemaVersion >= 5 ? SURFACE_ZONE_RECORD_BYTES : LEGACY_SURFACE_ZONE_RECORD_BYTES)
    || !Number.isSafeInteger(sourceTerrainRevision)
    || recordCount !== expectedRecords
    || (schemaVersion >= 5 ? bytes.byteLength < expectedBytes + 4 : bytes.byteLength !== expectedBytes)
    || bytes.byteLength > MAX_SURFACE_ZONE_BYTES
  ) {
    throw new Error('Invalid Space surface-zone snapshot.');
  }

  const heightsMicro = new Uint16Array(recordCount);
  const colors = new Uint8Array(recordCount * 3);
  const minHeightsMicro = schemaVersion >= 5 ? new Uint16Array(recordCount) : undefined;
  const colorErrors = schemaVersion >= 5 ? new Uint8Array(recordCount) : undefined;
  let offset = SURFACE_ZONE_HEADER_BYTES;
  for (let index = 0; index < recordCount; index++) {
    heightsMicro[index] = view.getUint16(offset, true);
    if (heightsMicro[index] > 2048) throw new Error('Invalid surface height.');
    const colorOffset = offset + (schemaVersion >= 5 ? 4 : 2);
    colors.set(bytes.subarray(colorOffset, colorOffset + 3), index * 3);
    if (minHeightsMicro && colorErrors) {
      minHeightsMicro[index] = view.getUint16(offset + 2, true);
      colorErrors[index] = bytes[offset + 7];
      if (minHeightsMicro[index] > heightsMicro[index]) throw new Error('Invalid surface error bound.');
    }
    offset += recordBytes;
  }
  let detailChunks: DistantChunkSnapshot[] | undefined;
  let voxelMips: VoxelSurfaceMip[] | undefined;
  if (schemaVersion >= 5) {
    detailChunks = [];
    const count = view.getUint32(offset, true);
    offset += 4;
    if (count > 1024) throw new Error('Invalid surface chunk count.');
    const seen = new Set<number>();
    for (let i = 0; i < count; i++) {
      if (offset + 14 > bytes.length) throw new Error('Truncated surface chunk.');
      const cx = bytes[offset], cz = bytes[offset + 1];
      const revision = Number(view.getBigUint64(offset + 2, true));
      const boxesCount = view.getUint32(offset + 10, true);
      offset += 14;
      if (cx >= 32 || cz >= 32 || seen.has(cx * 32 + cz)
        || !Number.isSafeInteger(revision) || offset + boxesCount * 15 > bytes.length) {
        throw new Error('Invalid surface chunk.');
      }
      seen.add(cx * 32 + cz);
      const boxes = new Uint16Array(boxesCount * 6), boxColors = new Uint8Array(boxesCount * 3);
      for (let b = 0; b < boxesCount; b++) {
        for (let c = 0; c < 6; c++) boxes[b * 6 + c] = view.getUint16(offset + c * 2, true);
        const [x, y, z, w, h, d] = boxes.subarray(b * 6, b * 6 + 6);
        if (!w || !h || !d || x + w > 128 || z + d > 128 || y + h > 2048) {
          throw new Error('Invalid surface solid bounds.');
        }
        boxColors.set(bytes.subarray(offset + 12, offset + 15), b * 3);
        offset += 15;
      }
      detailChunks.push({ chunkX: zoneX * 32 + cx, chunkZ: zoneZ * 32 + cz,
        revision, boxes, colors: boxColors });
    }
    if (schemaVersion === 7) {
      if (offset + 8 > bytes.length || String.fromCharCode(...bytes.subarray(offset, offset + 4)) !== 'VXL7') {
        throw new Error('Missing volumetric surface data.');
      }
      const sizes = [1, ...SURFACE_LOD_SIZES].filter(size => size >= sampleSize!);
      if (bytes[offset + 4] !== sizes.length) throw new Error('Invalid voxel mip count.');
      offset += 8;
      voxelMips = [];
      for (const cellSize of sizes) {
        if (offset + 8 > bytes.length || bytes[offset] !== cellSize) throw new Error('Invalid voxel mip level.');
        const count = view.getUint32(offset + 4, true);
        offset += 8;
        const end = offset + count * 16;
        if (end > bytes.length) throw new Error('Truncated voxel faces.');
        for (let at = offset; at < end; at += 16) {
          const coords = [0, 2, 4].map(delta => view.getUint16(at + delta, true));
          const w = view.getUint16(at + 6, true), h = view.getUint16(at + 8, true);
          const dir = bytes[at + 10], dim = dir >> 1, u = (dim + 1) % 3, v = (dim + 2) % 3;
          const bounds = [4096, 2048, 4096], unit = cellSize * 8;
          if (dir > 5 || bytes[at + 11] > 1 || !w || !h || w % unit || h % unit
            || coords.some((n, axis) => n > bounds[axis] || n % unit)
            || coords[u] + w > bounds[u] || coords[v] + h > bounds[v]
            || ((dir & 1) ? coords[dim] < unit : coords[dim] + unit > bounds[dim])) {
            throw new Error('Invalid voxel face bounds.');
          }
        }
        voxelMips.push({ cellSize, faces: bytes.slice(offset, end) });
        offset = end;
      }
    }
    if (offset !== bytes.length) throw new Error('Unexpected surface snapshot trailer.');
  }
  return {
    ...(sampleSize === undefined ? {} : { sampleSize }),
    zoneX,
    zoneZ,
    seed,
    terrainGeneratorVersion,
    sourceTerrainRevision,
    zoneSizeChunks,
    samplesPerChunkAxis,
    heightsMicro,
    colors,
    minHeightsMicro, colorErrors, detailChunks, voxelMips,
  };
}

export interface SpaceSurfaceSnapshotRemote {
  loadAll(
    onZone: (zone: SurfaceZoneSnapshot) => void,
    onZoneRemoved?: (zoneX: number, zoneZ: number) => void,
    options?: SurfaceStreamOptions,
  ): Promise<{
    loaded: number;
    complete: boolean;
  }>;
}

export interface SurfaceStreamOptions {
  getDataBudgetBytes?: () => number;
  /** Camera demand is evaluated on each pass; 64 keeps only the overview. */
  getZoneDemand(zoneX: number, zoneZ: number): { sampleSize: number; priority: number };
}

export function createSpaceSurfaceSnapshotRemote(
  apiOrigin: string,
  token: string,
  manifestUrl: string,
  expectedSeed: number,
  expectedGeneratorVersion: number,
  fetchImpl: typeof fetch = fetch,
  byteCache: SurfaceByteCache = createSurfaceDiskCache(),
): SpaceSurfaceSnapshotRemote {
  const installed = new Map<string, { sourceDigest: string; sampleSize: number; revision: number }>();
  // Fine decoded data belongs to the renderer; downloaded immutable snapshots
  // survive eviction in the optional disk cache without a second JS lattice.
  const overviews = new Map<string, { digest: string; zone: SurfaceZoneSnapshot }>();
  let cachedManifest: SurfaceZoneManifest | null = null;
  let manifestFetchedAt = 0;
  let inFlight: Promise<{ loaded: number; complete: boolean }> | null = null;
  let installationQueue = Promise.resolve();
  const run: SpaceSurfaceSnapshotRemote['loadAll'] = async (onZone, onZoneRemoved, options) => {
    const safeManifestUrl = resolveSurfaceApiUrl(manifestUrl, apiOrigin);
    let loaded = 0;
    while (true) {
      if (!options || !cachedManifest || Date.now() - manifestFetchedAt >= 10_000 || !cachedManifest.complete) {
        const response = await fetchImpl(safeManifestUrl.toString(), {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          cache: 'no-store',
        });
        const manifestBody = await readJsonResponse(response, MAX_SURFACE_MANIFEST_BYTES);
        if (!response.ok) throw new Error(`Space surface manifest failed with HTTP ${response.status}.`);
        cachedManifest = parseManifest(manifestBody);
        manifestFetchedAt = Date.now();
      }
      const manifest = cachedManifest;
      // An absent zone is unavailable (initial build, migration, or a legacy
      // dirty manifest), never a deletion. Retain last-good coverage until an
      // authenticated replacement arrives. The world has a fixed zone domain.
      const zones = manifest.zones.map(entry => ({
        entry, demand: options?.getZoneDemand(entry.zone_x, entry.zone_z)
          ?? { sampleSize: 2, priority: entry.zone_x * 32 + entry.zone_z },
      })).sort((a, b) => a.demand.priority - b.demand.priority);
      const targets = new Map<string, SurfaceLodManifestEntry>();
      const selectTargets = () => {
        const candidates = zones.map(({ entry }) => {
          const demand = options?.getZoneDemand(entry.zone_x, entry.zone_z)
            ?? { sampleSize: entry.sample_size ?? 2, priority: 0 };
          const available = [{ ...entry, sample_size: entry.sample_size ?? 2 }, ...(entry.lods ?? [])]
            .sort((a, b) => b.sample_size - a.sample_size);
          targets.set(`${entry.zone_x},${entry.zone_z}`, available[0]);
          const previous = installed.get(`${entry.zone_x},${entry.zone_z}`);
          // A small priority dead band avoids exchanging two large source mips
          // every second when walking along their equal-distance boundary.
          const priority = demand.priority - (previous && previous.sampleSize < 64
            ? Math.min(128, Math.max(0, demand.priority) * 0.1) : 0);
          // Downloaded detail is a residency high-water mark. Measuring a
          // smaller error after refinement must not downgrade that source and
          // immediately rediscover the coarse error on the following poll.
          const sampleSize = Math.min(demand.sampleSize, previous?.sampleSize ?? 64);
          return { entry, sampleSize, available, priority, index: 0 };
        }).sort((a, b) => a.priority - b.priority);
        let refinementBytes = 0;
        // Refine in waves, so a full-detail nearby zone cannot consume the
        // cache before the rest of the visible terrain gets even its 32m mip.
        for (let round = 0; round < 6; round++) for (const candidate of candidates) {
          const { entry, sampleSize, available, index } = candidate;
          const current = available[index], next = available[index + 1];
          if (!next || current.sample_size <= sampleSize) continue;
          const cost = next.byte_length - current.byte_length;
          if (options && available[0].sample_size === 64 && refinementBytes + cost
            > (options.getDataBudgetBytes?.() ?? SURFACE_REFINEMENT_BUDGET_BYTES)) continue;
          refinementBytes += cost;
          candidate.index++;
          targets.set(`${entry.zone_x},${entry.zone_z}`, next);
        }
      };
      const download = async (entry: SurfaceZoneManifestEntry, level: SurfaceLodManifestEntry) => {
        const key = `${entry.zone_x},${entry.zone_z}`;
        const cached = overviews.get(key);
        const url = resolveSurfaceApiUrl(level.url, apiOrigin);
        if (level.sample_size === 64 && cached?.digest === level.digest) return cached.zone;
        let bytes = await byteCache.get(level.digest).catch(() => undefined);
        if (bytes && (bytes.byteLength !== level.byte_length || await sha256Hex(bytes) !== level.digest)) {
          await byteCache.remove(level.digest).catch(() => {});
          bytes = undefined;
        }
        const downloaded = !bytes;
        if (!bytes) {
          let zoneResponse: Response | undefined;
          for (let attempt = 0; attempt < 3; attempt++) {
            zoneResponse = await fetchImpl(url.toString(), {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.entropydrop.surface-zone',
              },
              cache: 'force-cache',
            });
            if (zoneResponse.status === 429 && attempt < 2) {
              const retryAfter = zoneResponse.headers?.get?.('Retry-After');
              const seconds = retryAfter ? Number(retryAfter) : NaN;
              const delayMs = Number.isFinite(seconds) && seconds > 0
                ? seconds * 1000
                : 500 * (attempt + 1);
              await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, 3000)));
              continue;
            }
            break;
          }
          if (!zoneResponse || !zoneResponse.ok) {
            throw new Error(`Space surface zone failed with HTTP ${zoneResponse?.status}.`);
          }
          bytes = await readResponseBytes(zoneResponse, MAX_SURFACE_ZONE_BYTES);
          if (bytes.byteLength !== level.byte_length || await sha256Hex(bytes) !== level.digest) {
            throw new Error('Space surface-zone snapshot checksum mismatch.');
          }
        }
        const zone = parseSurfaceZoneSnapshot(bytes);
        if (
          zone.zoneX !== entry.zone_x
          || zone.zoneZ !== entry.zone_z
          || zone.seed !== expectedSeed
          || zone.terrainGeneratorVersion !== expectedGeneratorVersion
          || zone.sourceTerrainRevision !== entry.source_terrain_revision
          || (zone.sampleSize ?? 2) !== level.sample_size
        ) {
          throw new Error('Space surface-zone snapshot identity mismatch.');
        }
        // Do not keep a duplicate decoded fine lattice in JS memory. The GPU
        // working set can shrink independently without losing downloaded data.
        if (downloaded) await byteCache.put(level.digest, bytes).catch(() => {});
        if (level.sample_size === 64) overviews.set(key, { digest: level.digest, zone });
        return zone;
      };
      const install = async (entry: SurfaceZoneManifestEntry, level: SurfaceLodManifestEntry) => {
        const key = `${entry.zone_x},${entry.zone_z}`;
        const current = installed.get(key);
        if (current && (current.revision > entry.revision
          || (current.sourceDigest === entry.digest && current.sampleSize === level.sample_size))) return;
        const zone = await download(entry, level);
        const publication = installationQueue.then(async () => {
          // Network concurrency must not turn six fine mip builds into one
          // long render-frame task. Keep downloads parallel, install one fine
          // source per frame; hidden tabs continue warming via a timer.
          if (level.sample_size <= 2 && typeof requestAnimationFrame === 'function') {
            await new Promise<void>(resolve => {
              if (typeof document !== 'undefined' && document.visibilityState === 'hidden') setTimeout(resolve, 16);
              else requestAnimationFrame(() => resolve());
            });
          }
          await onZone(zone);
          installed.set(key, { sourceDigest: entry.digest, sampleSize: level.sample_size, revision: entry.revision });
          loaded++;
        });
        installationQueue = publication.catch(() => {});
        await publication;
      };
      const pass = async (overview: boolean) => {
        let cursor = 0;
        let failed = false;
        const worker = async () => {
          while (cursor < zones.length && !failed) {
            const { entry } = zones[cursor++];
            const key = `${entry.zone_x},${entry.zone_z}`;
            const coarse = entry.lods?.find(level => level.sample_size === 64);
            if (overview) {
              // Refresh existing zones directly at their requested resolution;
              // inserting a new overview first causes a visible 64m flash.
              if (!options || !coarse || installed.has(key)) continue;
              await install(entry, coarse);
            } else {
              await install(entry, targets.get(key)!);
            }
          }
        };
        // Drain every worker before retrying so a failed pass cannot leave
        // late responses installing an older revision over the next pass.
        const results = await Promise.allSettled(Array.from(
          { length: Math.min(SURFACE_DOWNLOAD_CONCURRENCY, zones.length) },
          () => worker().catch(error => { failed = true; throw error; }),
        ));
        const error = results.find(result => result.status === 'rejected');
        if (error?.status === 'rejected') throw error.reason;
      };
      await pass(true);
      // Overview residuals are now known. Request real refinement in this same
      // pass instead of waiting for another poll / an idle rendering queue.
      selectTargets();
      await pass(false);
      return { loaded, complete: manifest.complete };
    }
  };
  return {
    loadAll(onZone, onZoneRemoved, options) {
      if (inFlight) return inFlight;
      inFlight = run(onZone, onZoneRemoved, options).catch(error => {
        cachedManifest = null;
        throw error;
      }).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
