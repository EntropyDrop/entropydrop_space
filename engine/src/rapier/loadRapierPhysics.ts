import type { World } from '../voxel/World.ts';

let ready: Promise<typeof import('@dimforge/rapier3d-compat')> | undefined;

export async function preloadRapierPhysics() {
  if (typeof WebAssembly !== 'object') throw new Error('WebAssembly is unavailable');
  return ready ??= import('@dimforge/rapier3d-compat').then(async module => {
    await module.init();
    return module;
  });
}

export async function loadRapierPhysics(world: World) {
  const [rapier, { RapierContraptionPhysics }] = await Promise.all([preloadRapierPhysics(), import('./RapierContraptionPhysics.ts')]);
  return new RapierContraptionPhysics(rapier, world);
}
