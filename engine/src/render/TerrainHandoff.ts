import * as THREE from 'three/webgpu';
import { reference, modelWorldMatrix, floor, vec4, int } from 'three/tsl';
import { asNodeMaterial, terrainCoverage, terrainDither, discardWhen } from './NodeMaterials.ts';
import { hookSceneMaterials } from '../torus/TorusWorld.ts';

type NearMaterial = { opaque: THREE.NodeMaterial; masked: THREE.NodeMaterial };
type NearDraw = {
  mesh: THREE.Mesh;
  index: number;
  opaque: THREE.Material | THREE.Material[];
  masked: THREE.Material | THREE.Material[];
};

export const TERRAIN_FADE_MS = 400;
/** Coverage lives independently of meshes, so reversing an AOI crossing does
 * not restart its fade or let standard and micro terrain disagree. */
export class TerrainHandoff {
  readonly data = new Uint8Array(1024 * 128 * 2);
  readonly texture = new THREE.DataTexture(this.data, 1024, 128, THREE.RGFormat);
  readonly enabled = { value: false };
  private readonly changes = new Map<number, { from: number; to: number; start: number; duration: number }>();
  private readonly roots = new WeakMap<THREE.Object3D, NearDraw[]>();
  private readonly materials = new WeakMap<THREE.Material, NearMaterial>();
  private opaqueFastPath = true;

  constructor() {
    this.texture.userData.voxelVisibilityVersion = 0;
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
    const index = this.index(cx, cz) + 1;
    if (this.data[index] === 255) return;
    this.data[index] = 255;
    this.texture.userData.voxelVisibilityVersion++;
    this.texture.needsUpdate = true;
  }

  private setCoverage(index: number, value: number) {
    const previous = this.data[index];
    if (previous === value) return;
    const classification = (v: number) => v === 0 ? 0 : v === 255 ? 2 : 1;
    if (classification(previous) !== classification(value)) this.texture.userData.voxelVisibilityVersion++;
    this.data[index] = value; this.texture.needsUpdate = true;
  }

  setReady(cx: number, cz: number, ready: boolean, animate: boolean, now = performance.now()) {
    const index = this.index(cx, cz), to = ready ? 255 : 0;
    this.advanceOne(index, now);
    if (this.changes.get(index)?.to === to && animate) return;
    this.changes.delete(index);
    const from = this.data[index];
    if (from === to) return;
    if (animate) this.changes.set(index, { from, to, start: now, duration: TERRAIN_FADE_MS * Math.abs(to - from) / 255 });
    else this.setCoverage(index, to);
  }

  private advanceOne(index: number, now: number) {
    const change = this.changes.get(index);
    if (!change) return;
    const t = Math.min(1, Math.max(0, (now - change.start) / change.duration));
    this.setCoverage(index, Math.round(change.from + (change.to - change.from) * t));
    if (t === 1) this.changes.delete(index);
  }

  advance(now = performance.now()) {
    for (const index of this.changes.keys()) this.advanceOne(index, now);
  }

  retains(cx: number, cz: number) {
    return this.enabled.value && this.data[this.index(cx, cz)] > 0;
  }

  getOpaqueFastPathEnabled() { return this.opaqueFastPath; }
  setOpaqueFastPathEnabled(enabled: boolean) { this.opaqueFastPath = enabled; }

  hook(root: THREE.Object3D) {
    let draws = this.roots.get(root);
    if (!draws) {
      // Bend before cloning so both pipelines share exactly the same position,
      // normal and emission nodes, including the shadow deformation.
      hookSceneMaterials(root);
      root.updateWorldMatrix(true, true);
      draws = [];
      const origin = new THREE.Vector3();
      root.traverse(object => {
        const mesh = object as THREE.Mesh, material = mesh.material;
        if (!material) return;
        const pairs = (Array.isArray(material) ? material : [material]).map(source => this.materialPair(source));
        mesh.getWorldPosition(origin);
        draws!.push({ mesh, index: this.index(Math.floor((origin.x + .01) / 16), Math.floor((origin.z + .01) / 16)),
          opaque: Array.isArray(material) ? pairs.map(pair => pair.opaque) : pairs[0].opaque,
          masked: Array.isArray(material) ? pairs.map(pair => pair.masked) : pairs[0].masked });
      });
      this.roots.set(root, draws);
    }
    // Reclassify on every culling pass: a reversal must return to the masked
    // shader before the next draw. Do not allocate materials/arrays per frame.
    for (const draw of draws) {
      const opaque = this.opaqueFastPath && (!this.enabled.value || this.data[draw.index] === 255);
      draw.mesh.material = opaque ? draw.opaque : draw.masked;
    }
  }

  private materialPair(source: THREE.Material): NearMaterial {
    const mat = asNodeMaterial(source), existing = this.materials.get(mat);
    if (existing) return existing;
    const masked = mat.clone();
    // r183 NodeMaterial.copy omits classic subclass fields such as flatShading,
    // roughness and metalness, and callbacks. Share all shading state while
    // retaining the variant's identity, version and disposal listeners.
    for (const key of Object.keys(mat)) {
      if (['id', 'uuid', 'type', 'version', '_listeners'].includes(key)) continue;
      (masked as any)[key] = (mat as any)[key];
    }
    const flat = vec4(modelWorldMatrix.element(int(3))).xz.add(.01);
    const coverage = terrainCoverage(this.texture, flat).r;
    discardWhen(masked, reference('value', 'bool', this.enabled).and(terrainDither().greaterThanEqual(coverage)));
    const pair = { opaque: mat, masked };
    this.materials.set(mat, pair); this.materials.set(masked, pair);
    const dispose = () => {
      mat.removeEventListener('dispose', dispose);
      this.texture.removeEventListener('dispose', dispose);
      masked.dispose();
    };
    mat.addEventListener('dispose', dispose);
    this.texture.addEventListener('dispose', dispose);
    return pair;
  }
}
