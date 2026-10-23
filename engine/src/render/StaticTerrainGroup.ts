import * as THREE from 'three/webgpu';

/** Avoid recomputing unchanged static leaf matrices when Scene propagates force.
 * Dynamic children, descendants and custom update methods keep Three's path. */
export class StaticTerrainGroup extends THREE.BundleGroup {
  matrixCachingEnabled = true;
  private readonly previousWorld = new THREE.Matrix4();
  private readonly leaves = new WeakMap<THREE.Object3D, { local: THREE.Matrix4; world: THREE.Matrix4 }>();
  private readonly ownedLeaves = new WeakSet<THREE.Object3D>();

  constructor() {
    super();
    this.addEventListener('childadded', ({ child }) => {
      if (this.ownedLeaves.has(child)) child.matrixWorldNeedsUpdate = true;
    });
  }

  /** Only for terrain-owned leaves: their local transforms are immutable during
   * publication/culling. A future transform edit must call updateMatrix() or set
   * matrixWorldNeedsUpdate. Other objects retain exact matrix-value validation. */
  registerStaticLeaf(child: THREE.Object3D) {
    this.ownedLeaves.add(child);
    child.matrixWorldNeedsUpdate = true;
  }

  override updateMatrixWorld(force?: boolean) {
    if (!this.matrixCachingEnabled) { super.updateMatrixWorld(force); return; }
    if (this.matrixAutoUpdate) this.updateMatrix();
    if (this.matrixWorldNeedsUpdate || force) {
      if (this.matrixWorldAutoUpdate) {
        if (this.parent) this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
        else this.matrixWorld.copy(this.matrix);
      }
      this.matrixWorldNeedsUpdate = false;
      force = true;
    }
    const parentChanged = !this.previousWorld.equals(this.matrixWorld);
    if (parentChanged) this.previousWorld.copy(this.matrixWorld);
    for (const child of this.children) {
      if (child.matrixAutoUpdate || !child.matrixWorldAutoUpdate || child.children.length
        || child.updateMatrixWorld !== THREE.Object3D.prototype.updateMatrixWorld) {
        this.leaves.delete(child);
        child.updateMatrixWorld(force);
        continue;
      }
      if (this.ownedLeaves.has(child)) {
        child.updateMatrixWorld(parentChanged);
        continue;
      }
      const previous = this.leaves.get(child);
      if (!previous || child.matrixWorldNeedsUpdate || (force && (parentChanged
        || !previous.local.equals(child.matrix) || !previous.world.equals(child.matrixWorld)))) {
        child.updateMatrixWorld(force);
        if (previous) { previous.local.copy(child.matrix); previous.world.copy(child.matrixWorld); }
        else this.leaves.set(child, { local: child.matrix.clone(), world: child.matrixWorld.clone() });
      }
    }
  }
}
