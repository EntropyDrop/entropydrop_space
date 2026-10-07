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

import type { UiPlayerController, UiWorld, UiContraptionManager, UiSceneRenderer, UiNavigationSystem, UiMinimap } from '../src/ui/react/store/UiPorts.ts';
interface UiTestPorts {
  controller: UiPlayerController;
  world: UiWorld;
  contraptions: UiContraptionManager;
  sceneRenderer: UiSceneRenderer;
  navigationSystem: UiNavigationSystem;
  minimap: UiMinimap;
}
/** Deliberately partial test hosts; production entry points keep complete ports. */
export function uiStub<K extends keyof UiTestPorts>(_kind: K, value: Stub<UiTestPorts[K]>): UiTestPorts[K] {
  return value as UiTestPorts[K];
}
