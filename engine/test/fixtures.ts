import assert from 'node:assert/strict';

/** Assert positive setup before reading a nullable result in a regression test. */
export function requireValue<T>(value: T): NonNullable<T> {
  assert.ok(value !== null && value !== undefined, 'Expected the test fixture to produce a value');
  return value;
}

/** A deliberately partial terrain host; omitted methods must not be called by the test. */
export function worldStub(overrides: Partial<Omit<import('../src/voxel/World.ts').World, 'terrainGen'>> & {
  terrainGen?: Pick<import('../src/worldgen/TerrainGenerator.ts').TerrainGenerator, 'seed' | 'version'>;
} = {}): import('../src/voxel/World.ts').World {
  return overrides as import('../src/voxel/World.ts').World;
}
