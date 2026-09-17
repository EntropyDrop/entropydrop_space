import * as THREE from 'three';

export const TERRAIN_FADE_MS = 400;
// A fixed screen-space pattern: no frame/time seed, alpha blending or depth
// write changes. The two owners accept complementary sets of pixels.
export const TERRAIN_DITHER_GLSL = `
float terrainDither(vec2 pixel) {
  return fract(52.9829189 * fract(dot(floor(pixel), vec2(0.06711056, 0.00583715))));
}
`;

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
      for (const mat of Array.isArray(material) ? material : material ? [material] : []) {
        if (this.materials.has(mat)) continue;
        this.materials.add(mat);
        const previous = mat.onBeforeCompile, previousKey = mat.customProgramCacheKey();
        mat.onBeforeCompile = (shader, renderer) => {
          previous.call(mat, shader, renderer);
          shader.uniforms.uTerrainHandoff = { value: this.texture };
          shader.uniforms.uTerrainHandoffEnabled = this.enabled;
          shader.vertexShader = shader.vertexShader.replace('#include <common>',
            '#include <common>\nvarying vec2 vNearTerrainChunk;')
            .replace('#include <begin_vertex>', `#include <begin_vertex>
              vNearTerrainChunk = floor((modelMatrix[3].xz + 0.01) / 16.0);`);
          shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
            uniform sampler2D uTerrainHandoff;
            uniform bool uTerrainHandoffEnabled;
            varying vec2 vNearTerrainChunk;
            ${TERRAIN_DITHER_GLSL}`)
            .replace('#include <color_fragment>', `
              if (uTerrainHandoffEnabled && terrainDither(gl_FragCoord.xy) >=
                texture2D(uTerrainHandoff, (vNearTerrainChunk + 0.5) / vec2(1024.0, 128.0)).r) discard;
              #include <color_fragment>`);
        };
        mat.customProgramCacheKey = () => `${previousKey}|terrain-handoff-v1`;
        mat.needsUpdate = true;
      }
    });
  }
}
