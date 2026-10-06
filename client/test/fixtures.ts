import type { World } from '@entropydrop/space-engine/voxel/World.ts';
export { requireValue } from '../../engine/test/fixtures.ts';

/** A test host implements only the paths exercised by that test. Keep supplied
 * scalar fields checked while allowing deliberately absent subsystems. */
type Stub<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => Stub<R> | void
  : T extends Map<infer K, infer V> ? Map<K, Stub<V>>
  : T extends Set<infer V> ? Set<Stub<V>>
  : T extends readonly (infer V)[] ? Stub<V>[]
  : T extends object ? { [K in keyof T]?: Stub<T[K]> } : T;
export function worldStub(value: Stub<World> = {}): World {
  return value as World;
}
