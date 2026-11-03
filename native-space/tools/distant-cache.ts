/** Optional, source-scoped disk coverage. Never cache the player's edit overlay. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { encodeVoxelLevels } from '../../engine/src/worldgen/VoxelSurfaceGenerator.ts';
import type { VoxelSurfaceMip } from '../../engine/src/voxel/SurfaceZoneSnapshot.ts';

export type SourceIdentity = { world: string; seed: number; generator: number; source_hash: string };
type Entry = { x: number; z: number; digest: string; rawBytes: number };
const MAX_OVERVIEW_BYTES = 1024 * 1024;
export const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const identityKey = (v: SourceIdentity) => JSON.stringify([v.world, v.seed, v.generator, v.source_hash]);

export function decodeVoxelCache(bytes: Uint8Array): VoxelSurfaceMip[] {
  if (bytes.byteLength < 8 || bytes.byteLength > MAX_SOURCE_BYTES
    || Buffer.from(bytes.subarray(0, 4)).toString() !== 'VXL7' || bytes[4] < 1 || bytes[4] > 7)
    throw Error('Invalid voxel surface cache');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), levels: VoxelSurfaceMip[] = [];
  let at = 8, previous = 0;
  for (let i = 0; i < bytes[4]; i++) {
    if (at + 8 > bytes.length) throw Error('Truncated voxel mip header');
    const cellSize = bytes[at], length = view.getUint32(at + 4, true) * 16; at += 8;
    if (![1, 2, 4, 8, 16, 32, 64].includes(cellSize) || cellSize <= previous || at + length > bytes.length)
      throw Error('Invalid voxel mip length or order');
    // A Buffer.slice would retain the complete decompressed source when the
    // planner drops fine mips to enforce its source-memory budget.
    levels.push({ cellSize, faces: new Uint8Array(bytes.subarray(at, at + length)) }); at += length; previous = cellSize;
  }
  if (at !== bytes.length || previous !== 64) throw Error('Incomplete voxel cache');
  return levels;
}

export class DistantCoverageCache {
  private entries = new Map<string, Entry>();
  private readonly key: string;
  private readonly indexPath: string;
  private readonly dir: string;
  constructor(dir: string, identity: SourceIdentity) {
    this.dir = dir;
    this.key = identityKey(identity); this.indexPath = join(dir, 'coverage-v1.json');
    try {
      const bytes = readFileSync(this.indexPath);
      if (bytes.length > 128 * 1024) return;
      const index = JSON.parse(bytes.toString());
      if (index.schema !== 1 || index.identity !== this.key || !Array.isArray(index.zones) || index.zones.length > 128) return;
      const entries = new Map<string, Entry>();
      for (const e of index.zones) {
        if (!Number.isInteger(e.x) || e.x < 0 || e.x >= 32 || !Number.isInteger(e.z) || e.z < 0 || e.z >= 4
          || !/^[a-f0-9]{64}$/.test(e.digest) || !Number.isSafeInteger(e.rawBytes) || e.rawBytes < 16
          || e.rawBytes > MAX_OVERVIEW_BYTES || entries.has(`${e.x},${e.z}`)) return;
        entries.set(`${e.x},${e.z}`, e);
      }
      this.entries = entries;
    } catch { /* Missing/corrupt metadata is a cache miss, not a loading failure. */ }
  }
  read(x: number, z: number): VoxelSurfaceMip[] | undefined {
    const entry = this.entries.get(`${x},${z}`);
    if (!entry) return;
    try {
      const bytes = readFileSync(join(this.dir, `${x}_${z}.overview.vxl.gz`));
      if (bytes.length > MAX_OVERVIEW_BYTES || digest(bytes) !== entry.digest) return;
      const raw = gunzipSync(bytes, { maxOutputLength: MAX_OVERVIEW_BYTES });
      if (raw.length !== entry.rawBytes) return;
      const mips = decodeVoxelCache(raw);
      return mips.length === 1 && mips[0].cellSize === 64 ? mips : undefined;
    } catch { return; }
  }
  store(x: number, z: number, mips: VoxelSurfaceMip[]): boolean {
    const overview = mips.find(m => m.cellSize === 64);
    if (!overview) return false;
    try {
      const raw = encodeVoxelLevels([overview]);
      if (raw.byteLength > MAX_OVERVIEW_BYTES) return false;
      const bytes = gzipSync(raw, { level: 1 }), entry = { x, z, digest: digest(bytes), rawBytes: raw.byteLength };
      if (this.entries.get(`${x},${z}`)?.digest === entry.digest && this.read(x, z)) return true;
      mkdirSync(this.dir, { recursive: true });
      const write = (path: string, data: Uint8Array | string) => {
        const temporary = `${path}.${process.pid}.tmp`; writeFileSync(temporary, data); renameSync(temporary, path);
      };
      write(join(this.dir, `${x}_${z}.overview.vxl.gz`), bytes);
      // Merge partial progress into the last-good index; never replace complete
      // coverage with only the zones refined during this entry.
      const entries = new Map(this.entries); entries.set(`${x},${z}`, entry);
      write(this.indexPath, JSON.stringify({ schema: 1, identity: this.key, complete: entries.size === 128,
        zones: [...entries.values()] }));
      this.entries = entries;
      return true;
    } catch { return false; }
  }
}
