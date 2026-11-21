import type { World } from '@entropydrop/space-engine/voxel/World.ts';

let ready: Promise<typeof import('@dimforge/rapier3d-compat')> | undefined;

export async function loadRapierPhysics(world: World) {
  if (typeof WebAssembly !== 'object') throw new Error('WebAssembly is unavailable');
  const [rapier, { RapierContraptionPhysics }] = await Promise.all([
    ready ??= import('@dimforge/rapier3d-compat').then(async module => {
      await module.init();
      return module;
    }),
    import('./RapierContraptionPhysics.ts'),
  ]);
  return new RapierContraptionPhysics(rapier, world);
}
