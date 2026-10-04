import type * as THREE from 'three/webgpu';
import type { SpaceRenderer } from './SpaceRenderer.ts';

type Compiler = Pick<SpaceRenderer, 'compileAsync' | 'getRenderTarget' | 'setRenderTarget'>;
type TerrainObject = THREE.Object3D & { isBundleGroup?: boolean; needsUpdate?: boolean };

/** Compile the resident terrain in every direction before releasing the entry
 * gate. Three r183's compileAsync skips BundleGroup render lists, and normal
 * culling hides the very pipelines that cause Firefox's first-turn stalls. */
export async function warmTerrainPipelines(renderer: Compiler, scene: THREE.Scene, camera: THREE.Camera,
  roots: Iterable<THREE.Object3D>, target: THREE.RenderTarget | null) {
  const saved = new Map<TerrainObject, { visible: boolean; frustumCulled: boolean; bundle?: boolean }>();
  const previousTarget = renderer.getRenderTarget();
  try {
    for (const root of roots) root.traverse((object: TerrainObject) => {
      if (saved.has(object)) return;
      saved.set(object, { visible: object.visible, frustumCulled: object.frustumCulled, bundle: object.isBundleGroup });
      // Migrated source meshes have no instance attributes. Their arena page
      // owns the draw; compiling the retired source would recreate bad buffers.
      const mesh = object as THREE.Mesh;
      object.visible = !(object.userData.voxelArenaCompatible && !mesh.geometry.getAttribute('voxelOffset'));
      object.frustumCulled = false;
      if (object.isBundleGroup) object.isBundleGroup = false;
    });
    renderer.setRenderTarget(target);
    await renderer.compileAsync(scene, camera);
  } finally {
    renderer.setRenderTarget(previousTarget);
    for (const [object, state] of saved) {
      object.visible = state.visible; object.frustumCulled = state.frustumCulled;
      if (state.bundle !== undefined) {
        object.isBundleGroup = state.bundle;
        if (state.bundle) object.needsUpdate = true;
      }
    }
  }
}
