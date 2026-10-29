import * as THREE from 'three';
import { StaticTerrainGroup } from './StaticTerrainGroup.ts';

/** Reuse near opaque commands in their original global material/depth order.
 * Geometry, per-chunk culling, collision and ownership remain unchanged.
 * Transparent chunks remain in the ordinary globally sorted render list. */
export class NearTerrainBatches {
  private enabled = true;
  private readonly regions = new Map<string, StaticTerrainGroup>();
  private readonly members = new Map<THREE.Object3D, { region: StaticTerrainGroup; visible: boolean; leaves: { mesh: THREE.Mesh; visible: boolean; castShadow: boolean; geometry: THREE.BufferGeometry; materials: { material: THREE.Material; version: number; visible: boolean }[] }[] }>();
  private readonly root: THREE.Group;

  constructor(root: THREE.Group) { this.root = root; }

  add(mesh: THREE.Object3D) {
    const key = 'opaque';
    let region = this.regions.get(key);
    if (!region) {
      region = new StaticTerrainGroup();
      region.name = `NearTerrain:${key}`;
      region.userData.spaceOpaqueTerrain = true;
      this.regions.set(key, region);
      this.root.add(region);
      // Ordinary near meshes precede far terrain bundles. Preserve that depth
      // tie order when near draws become bundles as well.
      this.root.children.splice(this.root.children.indexOf(region), 1);
      this.root.children.unshift(region);
    }
    const leaves: { mesh: THREE.Mesh; visible: boolean; castShadow: boolean; geometry: THREE.BufferGeometry; materials: { material: THREE.Material; version: number; visible: boolean }[] }[] = [];
    mesh.traverse(child => {
      const leaf = child as THREE.Mesh;
      if (!leaf.isMesh) return;
      const materials = Array.isArray(leaf.material) ? leaf.material : [leaf.material];
      leaves.push({ mesh: leaf, visible: leaf.visible, castShadow: leaf.castShadow, geometry: leaf.geometry,
        materials: materials.map(material => ({ material, version: material.version, visible: material.visible })) });
    });
    this.members.set(mesh, { region, visible: mesh.visible, leaves });
    (this.enabled && this.isOpaque(mesh) ? region : this.root).add(mesh);
    region.needsUpdate = true;
  }

  remove(mesh: THREE.Object3D) {
    const member = this.members.get(mesh);
    mesh.removeFromParent();
    if (!member) return;
    this.members.delete(mesh);
    member.region.needsUpdate = true;
    if (![...this.members.values()].some(value => value.region === member.region)) {
      member.region.removeFromParent();
      for (const [key, region] of this.regions) if (region === member.region) this.regions.delete(key);
    }
  }

  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    for (const [mesh, member] of this.members) {
      (enabled && this.isOpaque(mesh) ? member.region : this.root).add(mesh);
      member.region.needsUpdate = true;
    }
  }

  private isOpaque(mesh: THREE.Object3D) {
    let opaque = true;
    mesh.traverse(child => {
      const leaf = child as THREE.Mesh;
      if (!leaf.isMesh) return;
      if (Array.isArray(leaf.material)) {
        for (const group of leaf.geometry.groups) if (group.count && leaf.material[group.materialIndex ?? 0]?.transparent) opaque = false;
      } else if (leaf.material.transparent) opaque = false;
    });
    return opaque;
  }

  /** Call after bent culling for each camera, before Three builds its lists. */
  sync() {
    if (!this.enabled) return;
    for (const [mesh, member] of this.members) {
      const parent = this.isOpaque(mesh) ? member.region : this.root;
      if (mesh.parent !== parent) { parent.add(mesh); member.region.needsUpdate = true; }
      let changed = mesh.visible !== member.visible;
      member.visible = mesh.visible;
      for (const state of member.leaves) {
        const leaf = state.mesh;
        changed ||= leaf.visible !== state.visible || leaf.castShadow !== state.castShadow || leaf.geometry !== state.geometry;
        state.visible = leaf.visible; state.castShadow = leaf.castShadow; state.geometry = leaf.geometry;
        const count = Array.isArray(leaf.material) ? leaf.material.length : 1;
        if (state.materials.length !== count) { state.materials.length = count; changed = true; }
        for (let i = 0; i < count; i++) {
          const material = Array.isArray(leaf.material) ? leaf.material[i] : leaf.material;
          const previous = state.materials[i];
          if (!previous || previous.material !== material || previous.version !== material.version || previous.visible !== material.visible) {
            state.materials[i] = { material, version: material.version, visible: material.visible };
            changed = true;
          }
        }
      }
      if (changed) member.region.needsUpdate = true;
    }
  }

  getStats() {
    let recordings = 0, replays = 0;
    for (const region of this.regions.values()) {
      recordings += region.userData.commandCacheStats?.recordings ?? 0;
      replays += region.userData.commandCacheStats?.replays ?? 0;
    }
    return { enabled: this.enabled, regions: this.regions.size, recordings, replays };
  }
}
