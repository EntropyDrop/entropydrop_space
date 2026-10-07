/** Optional cache writes retain at most this many uncompressed bytes, including
 * the active write. Saturation drops cache work, never terrain publication. */
export const MAX_PENDING_SURFACE_CACHE_BYTES = 64 * 1024 * 1024;

export class SurfaceCacheWrites {
  private readonly pending = new Map<string, Promise<void>>();
  private tail = Promise.resolve();
  private retainedBytes = 0;
  private readonly write: (digest: string, bytes: Uint8Array) => Promise<void>;
  readonly byteLimit: number;
  readonly entryLimit: number;

  constructor(
    write: (digest: string, bytes: Uint8Array) => Promise<void>,
    byteLimit = MAX_PENDING_SURFACE_CACHE_BYTES,
    entryLimit = 128,
  ) {
    this.write = write;
    this.byteLimit = byteLimit;
    this.entryLimit = entryLimit;
  }

  get pendingBytes() { return this.retainedBytes; }
  get pendingEntries() { return this.pending.size; }

  enqueue(digest: string, bytes: Uint8Array): Promise<void> {
    const existing = this.pending.get(digest);
    if (existing) return existing;
    if (this.pending.size >= this.entryLimit || this.retainedBytes + bytes.byteLength > this.byteLimit) {
      return Promise.resolve();
    }
    this.retainedBytes += bytes.byteLength;
    const result = this.tail.then(() => this.write(digest, bytes))
      .catch(() => { /* Caching must never fail a terrain load. */ })
      .finally(() => {
        this.retainedBytes -= bytes.byteLength;
        this.pending.delete(digest);
      });
    this.pending.set(digest, result);
    this.tail = result;
    return result;
  }
}
