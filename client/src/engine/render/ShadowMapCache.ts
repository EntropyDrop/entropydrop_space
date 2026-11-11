import * as THREE from 'three/webgpu';

/**
 * Sun shadow reuse for frames whose shadow-pass inputs are unchanged.
 *
 * The sun direction is fixed, but the shadow camera follows the player and the
 * torus view correction re-bends nearby vertices whenever the camera position
 * changes. A cached map is therefore only valid while every input of the
 * shadow pass is identical: light/camera parameters, global projection state
 * and each visible caster's transform, geometry, material and draw range.
 *
 * Inputs are compared value by value against the previous capture rather than
 * hashed, so a collision can never keep a stale map. `maxReuseFrames` bounds
 * staleness from state the capture cannot observe (for example a uniform node
 * value changed in place).
 */
export class ShadowMapCache {
  enabled = true;
  maxReuseFrames = 60;
  readonly stats = { rendered: 0, reused: 0, captureMs: 0 };

  private values = new Float64Array(4096);
  private length = 0;
  private cursor = 0;
  private changed = false;
  private valid = false;
  private reusedFrames = 0;

  /** Forget the previous capture; the next frame redraws the map. */
  invalidate() { this.valid = false; }

  /**
   * Returns true when the shadow map must be rendered this frame. `extras`
   * carries global state that affects caster vertices without touching the
   * scene graph (projection and view-correction revisions, coverage textures).
   */
  needsRender(scene: THREE.Object3D, shadow: THREE.LightShadow, light: THREE.Light, extras: ArrayLike<number>) {
    const started = performance.now();
    this.cursor = 0;
    this.changed = false;
    for (let i = 0; i < extras.length; i++) this.write(extras[i]);
    this.writeMatrix(light.matrixWorld);
    const target = (light as THREE.DirectionalLight).target;
    if (target) this.writeMatrix(target.matrixWorld);
    const camera = shadow.camera as THREE.OrthographicCamera;
    this.write(camera.left); this.write(camera.right); this.write(camera.top); this.write(camera.bottom);
    this.write(camera.near); this.write(camera.far);
    this.write(camera.up.x); this.write(camera.up.y); this.write(camera.up.z);
    this.write(shadow.mapSize.x); this.write(shadow.mapSize.y);
    this.write(shadow.bias); this.write(shadow.normalBias);
    this.visit(scene);
    if (this.cursor !== this.length) this.changed = true;
    this.length = this.cursor;
    this.stats.captureMs = performance.now() - started;

    const reuse = this.valid && !this.changed && this.reusedFrames < this.maxReuseFrames;
    this.valid = true;
    if (reuse) {
      this.reusedFrames++;
      this.stats.reused++;
      return false;
    }
    this.reusedFrames = 0;
    this.stats.rendered++;
    return true;
  }

  private visit(object: THREE.Object3D) {
    // Three skips invisible subtrees in the shadow pass as well.
    if (!object.visible) return;
    if (object.castShadow) this.writeCaster(object);
    const children = object.children;
    for (let i = 0; i < children.length; i++) this.visit(children[i]);
  }

  private writeCaster(object: THREE.Object3D) {
    this.write(object.id);
    this.write(object.layers.mask);
    this.writeMatrix(object.matrixWorld);
    const mesh = object as THREE.Mesh & { count?: number; instanceMatrix?: THREE.BufferAttribute;
      morphTargetInfluences?: number[]; skeleton?: THREE.Skeleton };
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    if (geometry) {
      this.write(geometry.id);
      this.write(geometry.drawRange.start); this.write(geometry.drawRange.count);
      const instanced = geometry as THREE.InstancedBufferGeometry;
      if (instanced.instanceCount !== undefined) this.write(instanced.instanceCount);
      if (geometry.index) { this.write(geometry.index.id ?? 0); this.write(geometry.index.version); }
      const attributes = geometry.attributes;
      for (const name in attributes) {
        const attribute = attributes[name] as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
        const versioned = (attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
          ? (attribute as THREE.InterleavedBufferAttribute).data : attribute as THREE.BufferAttribute;
        this.write((versioned as { id?: number }).id ?? 0);
        this.write(versioned.version);
      }
      const groups = geometry.groups;
      this.write(groups.length);
      for (let i = 0; i < groups.length; i++) { this.write(groups[i].start); this.write(groups[i].count); }
    }
    if (mesh.count !== undefined) this.write(mesh.count);
    if (mesh.instanceMatrix) this.write(mesh.instanceMatrix.version);
    const influences = mesh.morphTargetInfluences;
    if (influences) for (let i = 0; i < influences.length; i++) this.write(influences[i]);
    const bones = mesh.skeleton?.bones;
    if (bones) for (let i = 0; i < bones.length; i++) this.writeMatrix(bones[i].matrixWorld);
    const material = mesh.material;
    if (Array.isArray(material)) for (let i = 0; i < material.length; i++) this.writeMaterial(material[i]);
    else if (material) this.writeMaterial(material);
  }

  private writeMaterial(material: THREE.Material) {
    this.write((material as THREE.Material & { id: number }).id);
    this.write(material.version);
    this.write(material.visible ? 1 : 0);
    this.write(material.side);
    this.write(material.alphaTest);
  }

  private writeMatrix(matrix: THREE.Matrix4) {
    const e = matrix.elements;
    for (let i = 0; i < 16; i++) this.write(e[i]);
  }

  private write(value: number) {
    const at = this.cursor++;
    if (at >= this.values.length) {
      const grown = new Float64Array(this.values.length * 2);
      grown.set(this.values);
      this.values = grown;
    }
    // NaN never equals itself; treat it as stable so it cannot defeat reuse.
    if (this.values[at] !== value && !(value !== value && this.values[at] !== this.values[at])) {
      this.values[at] = value;
      this.changed = true;
    }
  }
}

const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _back = new THREE.Vector3();

/**
 * Move a directional light and its target together so the shadow camera's
 * origin lands on whole shadow-map texels in light space. Stationary geometry
 * then rasterizes to identical texels as the player moves, removing shadow-edge
 * crawl. The shift is below one texel and does not change the light direction.
 */
export function snapShadowToTexels(light: THREE.DirectionalLight, up: THREE.Vector3, extent: number, mapSize: number) {
  if (!(extent > 0) || !(mapSize > 0)) return;
  // Same basis as Object3D.lookAt for a camera at light.position.
  _back.subVectors(light.position, light.target.position);
  if (_back.lengthSq() === 0) return;
  _back.normalize();
  _right.crossVectors(up, _back);
  if (_right.lengthSq() < 1e-12) return;
  _right.normalize();
  _up.crossVectors(_back, _right);
  const texel = (2 * extent) / mapSize;
  const target = light.target.position;
  const x = target.dot(_right);
  const y = target.dot(_up);
  const dx = Math.round(x / texel) * texel - x;
  const dy = Math.round(y / texel) * texel - y;
  target.addScaledVector(_right, dx).addScaledVector(_up, dy);
  light.position.addScaledVector(_right, dx).addScaledVector(_up, dy);
}
