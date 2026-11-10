/** Counter bumped by every write to the containers that share it. */
export type MutationEpoch = { value: number };

/**
 * A Map whose writes advance a shared epoch. Readers may skip revalidating
 * cached lookups while the epoch is unchanged; because the counter lives in
 * the container itself, a new write path cannot forget to bump it.
 */
export class EpochMap<K, V> extends Map<K, V> {
  private readonly epoch: MutationEpoch;
  constructor(epoch: MutationEpoch) { super(); this.epoch = epoch; }
  override set(key: K, value: V) { this.epoch.value++; return super.set(key, value); }
  override delete(key: K) { const removed = super.delete(key); if (removed) this.epoch.value++; return removed; }
  override clear() { if (this.size) this.epoch.value++; super.clear(); }
}

export class EpochSet<T> extends Set<T> {
  private readonly epoch: MutationEpoch;
  constructor(epoch: MutationEpoch) { super(); this.epoch = epoch; }
  override add(value: T) { if (!this.has(value)) this.epoch.value++; return super.add(value); }
  override delete(value: T) { const removed = super.delete(value); if (removed) this.epoch.value++; return removed; }
  override clear() { if (this.size) this.epoch.value++; super.clear(); }
}
