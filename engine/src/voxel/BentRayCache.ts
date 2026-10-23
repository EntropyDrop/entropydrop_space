/** Reuse exact geometry intersections only after validating every previously
 * read cell, including empty cells and face neighbours. This deliberately avoids
 * relying on incomplete edit/publication revision signals. */
export class BentRayCache<Value, Result> {
  readonly stats = { hits: 0, misses: 0 };
  private key: number[] = [];
  private coordinates: number[] = [];
  private values: Value[] = [];
  private valid = false;
  private result!: Result;

  run(key: readonly number[], read: (x: number, y: number, z: number) => Value,
    compute: (read: (x: number, y: number, z: number) => Value) => Result,
    clone: (result: Result) => Result): Result {
    const sameRay = key.length === this.key.length && key.every((v, i) => v === this.key[i]);
    // Moving rays use the original path without recording thousands of cells.
    // Admit a ray only after it repeats; still evaluate the first two queries.
    if (!sameRay) {
      this.key = key.slice(); this.valid = false; this.stats.misses++;
      return compute(read);
    }
    let unchanged = this.valid;
    if (unchanged) for (let i = 0; i < this.values.length; i++) {
      const at = i * 3;
      if (read(this.coordinates[at], this.coordinates[at + 1], this.coordinates[at + 2]) !== this.values[i]) {
        unchanged = false; break;
      }
    }
    if (unchanged) { this.stats.hits++; return clone(this.result); }
    this.stats.misses++; this.valid = false;
    this.coordinates.length = this.values.length = 0;
    const result = compute((x, y, z) => {
      const value = read(x, y, z);
      this.coordinates.push(x, y, z); this.values.push(value); return value;
    });
    this.key = key.slice(); this.result = clone(result); this.valid = true;
    return result;
  }
}
