import * as THREE from 'three/webgpu';
import { reference, modelWorldMatrix, floor, vec4, int } from 'three/tsl';
import { asNodeMaterial, terrainCoverage, terrainDither, discardWhen } from './NodeMaterials.ts';

export const TERRAIN_FADE_MS = 400;
/** Coverage lives independently of meshes, so reversing an AOI crossing does
 * not restart its fade or let standard and micro terrain disagree. */
export class TerrainHandoff {
  readonly data = new Uint8Array(1024 * 128 * 2);
  readonly texture = new THREE.DataTexture(this.data, 1024, 128, THREE.RGFormat);
  readonly enabled = { value: false };
  private readonly changes = new Map<number, { from: number; to: number; start: number; duration: number }>();
  private readonly roots = new WeakSet<THREE.Object3D>();
  private readonly materials = new WeakSet<THREE.Material>();

  constructor() {
    this.texture.name = 'TerrainHandoffCoverage';
    this.texture.magFilter = this.texture.minFilter = THREE.NearestFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  private index(cx: number, cz: number) {
    return ((cz % 128 + 128) % 128 * 1024 + (cx % 1024 + 1024) % 1024) * 2;
  }

  setAuthored(cx: number, cz: number) {
    this.data[this.index(cx, cz) + 1] = 255;
    this.texture.needsUpdate = true;
  }

  setReady(cx: number, cz: number, ready: boolean, animate: boolean, now = performance.now()) {
    const index = this.index(cx, cz), to = ready ? 255 : 0;
    this.advanceOne(index, now);
    if (this.changes.get(index)?.to === to && animate) return;
    this.changes.delete(index);
    const from = this.data[index];
    if (from === to) return;
    if (animate) this.changes.set(index, { from, to, start: now, duration: TERRAIN_FADE_MS * Math.abs(to - from) / 255 });
    else { this.data[index] = to; this.texture.needsUpdate = true; }
  }

  private advanceOne(index: number, now: number) {
    const change = this.changes.get(index);
    if (!change) return;
    const t = Math.min(1, Math.max(0, (now - change.start) / change.duration));
    this.data[index] = Math.round(change.from + (change.to - change.from) * t);
    if (t === 1) this.changes.delete(index);
    this.texture.needsUpdate = true;
  }

  advance(now = performance.now()) {
    for (const index of this.changes.keys()) this.advanceOne(index, now);
  }

  retains(cx: number, cz: number) {
    return this.enabled.value && this.data[this.index(cx, cz)] > 0;
  }

  hook(root: THREE.Object3D) {
    if (this.roots.has(root)) return;
    this.roots.add(root);
    root.traverse(object => {
      const material = (object as THREE.Mesh).material;
      const hooked = (Array.isArray(material) ? material : material ? [material] : []).map(source => {
        const mat = asNodeMaterial(source);
        if (!this.materials.has(mat)) {
          this.materials.add(mat);
          const flat = vec4(modelWorldMatrix.element(int(3))).xz.add(.01);
          const coverage = terrainCoverage(this.texture, flat).r;
          discardWhen(mat, reference('value', 'bool', this.enabled).and(terrainDither().greaterThanEqual(coverage)));
          mat.needsUpdate = true;
        }
        return mat;
      });
      if (material) (object as THREE.Mesh).material = Array.isArray(material) ? hooked : hooked[0];
    });
  }
}
