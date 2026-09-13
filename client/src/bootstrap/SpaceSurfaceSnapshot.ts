import type { SurfaceZoneSnapshot } from '@entropydrop/space-engine/voxel/SurfaceZoneSnapshot.ts';
export type { SurfaceZoneSnapshot } from '@entropydrop/space-engine/voxel/SurfaceZoneSnapshot.ts';

import {
  readJsonResponse,
  readResponseBytes,
  resolveSafeHttpUrl,
  sha256Hex,
} from './NetworkSafety.ts';

export const SURFACE_ZONE_SCHEMA_VERSION = 3;
export const SURFACE_ZONE_SAMPLES_PER_CHUNK_AXIS = 8;
export const SURFACE_ZONE_SIZE_CHUNKS = 32;
export const SURFACE_ZONE_HEADER_BYTES = 32;
export const SURFACE_ZONE_RECORD_BYTES = 5;
export const MAX_SURFACE_ZONE_BYTES = 384 * 1024;
const MAX_SURFACE_MANIFEST_BYTES = 256 * 1024;
const MAX_SURFACE_ZONES = 128;
const SURFACE_DOWNLOAD_CONCURRENCY = 6;
const SURFACE_MANIFEST_POLL_MS = 2_500;

interface SurfaceZoneManifestEntry {
  zone_x: number;
  zone_z: number;
  revision: number;
  source_terrain_revision: number;
  digest: string;
  byte_length: number;
  url: string;
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
    manifest?.schema_version !== SURFACE_ZONE_SCHEMA_VERSION
    || manifest?.samples_per_chunk_axis !== SURFACE_ZONE_SAMPLES_PER_CHUNK_AXIS
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
  const samplesPerChunkAxis = view.getUint8(5);
  const zoneSizeChunks = view.getUint8(6);
  const recordBytes = view.getUint8(7);
  const zoneX = view.getUint16(8, true);
  const zoneZ = view.getUint16(10, true);
  const seed = view.getInt32(12, true);
  const terrainGeneratorVersion = view.getUint32(16, true);
  const sourceTerrainRevision = Number(view.getBigUint64(20, true));
  const recordCount = view.getUint32(28, true);
  const expectedRecords = zoneSizeChunks * zoneSizeChunks * samplesPerChunkAxis ** 2;
  const expectedBytes = SURFACE_ZONE_HEADER_BYTES + recordCount * SURFACE_ZONE_RECORD_BYTES;
  if (
    magic !== 'EDSZ'
    || schemaVersion !== SURFACE_ZONE_SCHEMA_VERSION
    || samplesPerChunkAxis !== SURFACE_ZONE_SAMPLES_PER_CHUNK_AXIS
    || zoneSizeChunks !== SURFACE_ZONE_SIZE_CHUNKS
    || recordBytes !== SURFACE_ZONE_RECORD_BYTES
    || !Number.isSafeInteger(sourceTerrainRevision)
    || recordCount !== expectedRecords
    || bytes.byteLength !== expectedBytes
  ) {
    throw new Error('Invalid Space surface-zone snapshot.');
  }

  const heightsMicro = new Uint16Array(recordCount);
  const colors = new Uint8Array(recordCount * 3);
  let offset = SURFACE_ZONE_HEADER_BYTES;
  for (let index = 0; index < recordCount; index++) {
    heightsMicro[index] = view.getUint16(offset, true);
    colors[index * 3] = view.getUint8(offset + 2);
    colors[index * 3 + 1] = view.getUint8(offset + 3);
    colors[index * 3 + 2] = view.getUint8(offset + 4);
    offset += SURFACE_ZONE_RECORD_BYTES;
  }
  return {
    zoneX,
    zoneZ,
    seed,
    terrainGeneratorVersion,
    sourceTerrainRevision,
    zoneSizeChunks,
    samplesPerChunkAxis,
    heightsMicro,
    colors,
  };
}

export interface SpaceSurfaceSnapshotRemote {
  loadAll(
    onZone: (zone: SurfaceZoneSnapshot) => void,
    onZoneRemoved?: (zoneX: number, zoneZ: number) => void,
  ): Promise<{
    loaded: number;
    complete: boolean;
  }>;
}

export function createSpaceSurfaceSnapshotRemote(
  apiOrigin: string,
  token: string,
  manifestUrl: string,
  expectedSeed: number,
  expectedGeneratorVersion: number,
  fetchImpl: typeof fetch = fetch,
): SpaceSurfaceSnapshotRemote {
  const installedDigests = new Map<string, string>();
  return {
    async loadAll(onZone, onZoneRemoved) {
      const safeManifestUrl = resolveSurfaceApiUrl(manifestUrl, apiOrigin);
      let loaded = 0;
      while (true) {
        const response = await fetchImpl(safeManifestUrl.toString(), {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          cache: 'no-store',
        });
        const manifestBody = await readJsonResponse(response, MAX_SURFACE_MANIFEST_BYTES);
        if (!response.ok) {
          throw new Error(`Space surface manifest failed with HTTP ${response.status}.`);
        }
        const manifest = parseManifest(manifestBody);
        const readyZoneKeys = new Set(
          manifest.zones.map(entry => `${entry.zone_x},${entry.zone_z}`)
        );
        for (const key of installedDigests.keys()) {
          if (readyZoneKeys.has(key)) continue;
          installedDigests.delete(key);
          const [zoneX, zoneZ] = key.split(',').map(Number);
          onZoneRemoved?.(zoneX, zoneZ);
        }
        const zones = manifest.zones
          .filter(entry => installedDigests.get(`${entry.zone_x},${entry.zone_z}`) !== entry.digest)
          .sort((a, b) => a.zone_x - b.zone_x || a.zone_z - b.zone_z);
        let cursor = 0;
        const worker = async () => {
          while (cursor < zones.length) {
            const entry = zones[cursor++];
            const url = resolveSurfaceApiUrl(entry.url, apiOrigin);
            const zoneResponse = await fetchImpl(url.toString(), {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.entropydrop.surface-zone',
              },
              cache: 'force-cache',
            });
            if (!zoneResponse.ok) {
              throw new Error(`Space surface zone failed with HTTP ${zoneResponse.status}.`);
            }
            const bytes = await readResponseBytes(zoneResponse, MAX_SURFACE_ZONE_BYTES);
            if (bytes.byteLength !== entry.byte_length || await sha256Hex(bytes) !== entry.digest) {
              throw new Error('Space surface-zone snapshot checksum mismatch.');
            }
            const zone = parseSurfaceZoneSnapshot(bytes);
            if (
              zone.zoneX !== entry.zone_x
              || zone.zoneZ !== entry.zone_z
              || zone.seed !== expectedSeed
              || zone.terrainGeneratorVersion !== expectedGeneratorVersion
            ) {
              throw new Error('Space surface-zone snapshot identity mismatch.');
            }
            onZone(zone);
            installedDigests.set(`${entry.zone_x},${entry.zone_z}`, entry.digest);
            loaded++;
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(SURFACE_DOWNLOAD_CONCURRENCY, zones.length) }, worker)
        );
        if (manifest.complete) {
          return { loaded, complete: true };
        }
        await new Promise(resolve => setTimeout(resolve, SURFACE_MANIFEST_POLL_MS));
      }
    },
  };
}
