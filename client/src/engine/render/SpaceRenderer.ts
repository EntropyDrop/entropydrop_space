import { WebGPURenderer } from 'three/webgpu';
import { installOpaqueTerrainBundles } from './OpaqueTerrainBundles.ts';
import { installVoxelArenaSupport } from './VoxelArenaRenderer.ts';

/** WebGPU only: never silently render the production game with WebGL. */
export class SpaceRenderer extends WebGPURenderer {
  readonly terrainCommandCaching: boolean;
  terrainMergedBuffers = false;
  constructor(options: ConstructorParameters<typeof WebGPURenderer>[0] = {}) {
    super(options);
    // r183 installs its fallback unconditionally in WebGPURenderer. Disable
    // that single callback; keep all materials/renderers on the public bundle
    // so there is exactly one TSL stack (mixing src/ imports duplicates it).
    if (!('_getFallback' in this)) throw new Error('Three renderer initialization contract changed.');
    (this as unknown as { _getFallback: unknown })._getFallback = null;
    this.terrainCommandCaching = installOpaqueTerrainBundles(this);
  }
  async initialize() {
    if (!globalThis.navigator?.gpu) throw new Error('WebGPU is required. Open Space in a browser with WebGPU enabled.');
    try { await this.init(); }
    catch (cause) { throw new Error('Unable to initialize WebGPU. Check browser GPU acceleration and reload Space.', { cause }); }
    if (!(this.backend as any).isWebGPUBackend) throw new Error('Space requires the WebGPU backend.');
    if (!this.terrainMergedBuffers) this.terrainMergedBuffers = installVoxelArenaSupport(this);
  }
  get maxTextureSize() { return (this.backend as any).device?.limits.maxTextureDimension2D ?? 8192; }
}
