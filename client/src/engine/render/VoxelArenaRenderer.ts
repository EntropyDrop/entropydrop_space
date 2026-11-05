import { REVISION } from 'three/webgpu';

/** r183 integration for shared terrain storage. Invariant positions prevent
 * different buffer-access pipelines from rounding coplanar terrain differently.
 * Retirement also clears r183's cached CPU vertex arrays and geometry state. */
export function installVoxelArenaSupport(renderer: any) {
  const backend = renderer.backend, objects = renderer._objects, geometries = renderer._geometries;
  if (REVISION !== '183' || !backend?.isWebGPUBackend || typeof backend.createNodeBuilder !== 'function'
    || typeof objects?.createRenderObject !== 'function' || typeof geometries?.delete !== 'function') return false;
  // r183's WebGPU array uploader ignores DataArrayTexture.layerUpdates. Honor
  // immutable baked-layer updates without re-uploading the entire texture pool.
  const uploadTexture = backend.updateTexture;
  const initializedTextures = new WeakMap<object, object>();
  backend.updateTexture = function(texture: any, options: any) {
    const active = texture.userData?.voxelBakeLayers, data = backend.get(texture);
    if (!(active instanceof Set) || !texture.isDataArrayTexture || !data.texture) return uploadTexture.call(this, texture, options);
    const initialized = initializedTextures.get(texture) === data.texture;
    const layers = initialized ? texture.layerUpdates : active;
    const { width, height } = texture.image, stride = width * height * 4;
    const regions = texture.userData.voxelBakeRegions;
    if (initialized && regions instanceof Map) for (const {layer,x,y,size} of regions.values()) {
      const offset = layer * stride + (y * width + x) * 4;
      backend.device.queue.writeTexture({ texture: data.texture, origin: [x, y, layer] },
        texture.image.data.subarray(offset, offset + ((size - 1) * width + size) * 4),
        { bytesPerRow: width * 4, rowsPerImage: size }, { width: size, height: size, depthOrArrayLayers: 1 });
      if (texture.userData.voxelBakeStats) texture.userData.voxelBakeStats.uploadedBytes += size * size * 4;
    }
    else for (const layer of layers) {
      backend.device.queue.writeTexture({ texture: data.texture, origin: [0, 0, layer] },
      texture.image.data.subarray(layer * stride, (layer + 1) * stride),
      { bytesPerRow: width * 4, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
      if (texture.userData.voxelBakeStats) texture.userData.voxelBakeStats.uploadedBytes += stride;
    }
    regions?.clear();
    texture.clearLayerUpdates(); data.version = texture.version;
    initializedTextures.set(texture, data.texture);
  };
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
