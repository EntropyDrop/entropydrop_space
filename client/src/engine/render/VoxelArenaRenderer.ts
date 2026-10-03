import { REVISION } from 'three/webgpu';

/** r183 integration for shared terrain storage. Invariant positions prevent
 * different buffer-access pipelines from rounding coplanar terrain differently.
 * Retirement also clears r183's cached CPU vertex arrays and geometry state. */
export function installVoxelArenaSupport(renderer: any) {
  const backend = renderer.backend, objects = renderer._objects, geometries = renderer._geometries;
  if (REVISION !== '183' || !backend?.isWebGPUBackend || typeof backend.createNodeBuilder !== 'function'
    || typeof objects?.createRenderObject !== 'function' || typeof geometries?.delete !== 'function') return false;
  const build = backend.createNodeBuilder;
  backend.createNodeBuilder = function(...args: any[]) {
    const builder = build.apply(this, args), builtins = builder.getBuiltins;
    builder.getBuiltins = function(stage: string) {
      const result = builtins.call(this, stage);
      // The node manager assigns the pass material after constructing a builder.
      return stage === 'vertex' && this.material?.userData?.voxelArenaPosition
        ? result.replace('@builtin( position )', '@invariant @builtin( position )') : result;
    };
    return builder;
  };
  const create = objects.createRenderObject;
  objects.createRenderObject = function(...args: any[]) {
    const object = create.apply(this, args);
    if (!object.object.userData.voxelArenaCompatible) return object;
    const geometry = object.geometry, dispose = object.onDispose;
    const retire = () => {
      // Ordinary geometry.dispose already freed GPU attributes. It can rebuild
      // getAttributes() while doing so, leaving CPU arrays cached on RenderObject.
      object.dispose(); object.attributes = null; object.vertexBuffers = null;
      geometries.delete(geometry);
    };
    geometry.addEventListener('voxelarenaretire', retire);
    object.onDispose = () => { geometry.removeEventListener('voxelarenaretire', retire); dispose(); };
    return object;
  };
  return true;
}
