import type { World } from '../voxel/World.ts';

let ready: Promise<typeof import('@entropydrop/rapier3d-compat')> | undefined;

export async function preloadRapierPhysics() {
  if (typeof WebAssembly !== 'object') throw new Error('WebAssembly is unavailable');
  // Vite hosts Space alongside packages that use an older Rapier. Use a
  // distinct dependency specifier so prebundling cannot substitute that copy.
  return ready ??= import('@entropydrop/rapier3d-compat').then(async module => {
    await module.init();
    if (module.CompoundFlags?.FIX_INTERNAL_EDGES === undefined) {
      throw new Error(`Rapier ${module.version()} is missing compound collider support`);
    }
    return module;
  });
}

export async function loadRapierPhysics(world: World) {
  const [rapier, { RapierContraptionPhysics }] = await Promise.all([preloadRapierPhysics(), import('./RapierContraptionPhysics.ts')]);
  return new RapierContraptionPhysics(rapier, world);
}
