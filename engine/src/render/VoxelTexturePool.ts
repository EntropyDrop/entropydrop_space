import * as THREE from 'three/webgpu';
import { VOXEL_BAKE_SIZE } from './VoxelTextureBake.ts';

/** One immutable atlas region per live geometry generation. Slot ownership lasts
 * through fades and arena migration; source replacement explicitly releases it. */
export class VoxelTexturePool {
  readonly texture: THREE.DataArrayTexture;
  readonly stats = { bytes: 0, used: 0, layers: 0, preparedBytes: 0, uploadedBytes: 0, misses: 0 };
  private readonly occupied: Uint16Array;
  private readonly active = new Set<number>();
  private readonly updates = new Map<string, { layer: number; x: number; y: number; size: number }>();
  constructor(budgetMiB: number, linear: boolean) {
    const bytes = VOXEL_BAKE_SIZE ** 2 * 4;
    const layers = Math.max(1, Math.min(256, Math.floor(budgetMiB * 1024 * 1024 / bytes)));
    this.texture = new THREE.DataArrayTexture(new Uint8Array(bytes * layers), VOXEL_BAKE_SIZE, VOXEL_BAKE_SIZE, layers);
    this.texture.name = 'DistantVoxelBakedColors';
    this.texture.userData.voxelBakeLayers = this.active;
    this.texture.userData.voxelBakeStats = this.stats;
    this.texture.userData.voxelBakeRegions = this.updates;
    this.texture.minFilter = this.texture.magFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
    this.texture.generateMipmaps = false; this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;
    this.occupied = new Uint16Array(layers);
    this.stats.bytes = bytes * layers;
  }
  acquire(pixels: Uint8Array, size = VOXEL_BAKE_SIZE) {
    if (![64, 128, 256].includes(size) || pixels.byteLength !== size ** 2 * 4) throw new Error('Invalid baked voxel atlas');
    let layer = -1, x = 0, y = 0, mask = 0;
    const units = size / 64;
    outer: for (let page = 0; page < this.occupied.length; page++) {
      for (let py = 0; py < 4; py += units) for (let px = 0; px < 4; px += units) {
        let bits = 0;
        for (let dy = 0; dy < units; dy++) for (let dx = 0; dx < units; dx++) bits |= 1 << ((py + dy) * 4 + px + dx);
        if (!(this.occupied[page] & bits)) { layer = page; x = px * 64; y = py * 64; mask = bits; break outer; }
      }
    }
    if (layer < 0) { this.stats.misses++; return null; }
    this.occupied[layer] |= mask;
    const bytes = VOXEL_BAKE_SIZE ** 2 * 4;
    for (let row = 0; row < size; row++) this.texture.image.data!.set(pixels.subarray(row * size * 4, (row + 1) * size * 4),
      layer * bytes + ((y + row) * VOXEL_BAKE_SIZE + x) * 4);
    this.texture.addLayerUpdate(layer); this.texture.needsUpdate = true;
    this.updates.set(`${layer}/${x}/${y}/${size}`, { layer, x, y, size });
    this.active.add(layer);
    this.stats.used++; this.stats.layers = this.active.size; this.stats.preparedBytes += pixels.byteLength;
    let released = false;
    return { layer: layer + 1, x, y, release: () => {
      if (released) return; released = true; this.occupied[layer] &= ~mask;
      if (!this.occupied[layer]) this.active.delete(layer);
      this.stats.used--; this.stats.layers = this.active.size;
    } };
  }
  dispose() { this.texture.dispose(); }
}
