import type { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import type { CollisionBounds } from '@entropydrop/space-engine/physics/CollisionGeometry.ts';
import * as THREE from 'three';

// Keep the complete bounding box inside the viewport with 10% padding per edge.
const SCREEN_FRACTION = 0.80;

/** Fits the combined world bounding box without scanning every vehicle voxel. */
export class ThirdPersonFraming {
  private readonly inverseView = new THREE.Quaternion();
  private readonly eye = new THREE.Vector3();
  private readonly corner = new THREE.Vector3();
  private readonly box = new THREE.Box3();
  private readonly worldBounds = new THREE.Box3();
  private horizontalLimit = 1;
  private verticalLimit = 1;
  private near = 0.1;
  private distance = 0;

  measure(camera: THREE.PerspectiveCamera, eye: THREE.Vector3,
    vehicle: Contraption | null, playerBounds?: CollisionBounds): number {
    this.eye.copy(eye);
    this.inverseView.copy(camera.quaternion).invert();
    const tanVertical = Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2);
    this.horizontalLimit = tanVertical * camera.aspect * SCREEN_FRACTION;
    this.verticalLimit = tanVertical * SCREEN_FRACTION;
    this.near = camera.near;
    this.distance = 0;
    this.worldBounds.makeEmpty();

    if (playerBounds) {
      this.box.min.set(playerBounds.minX, playerBounds.minY, playerBounds.minZ);
      this.box.max.set(playerBounds.maxX, playerBounds.maxY, playerBounds.maxZ);
      this.worldBounds.union(this.box);
    }
    if (vehicle) {
      // Authored bounds are cached by the entity and invalidated by geometry edits.
      // Combine transformed components, decorations and rider before fitting:
      // even empty corners of the overall box must stay in frame.
      for (const node of vehicle.entityNodes?.values() || []) {
        const bounds = vehicle.getNodeBlocksBounds(node.id);
        if (!bounds) continue;
        node.group.updateWorldMatrix(true, false);
        this.box.min.fromArray(bounds.min).sub(node.pivotLocal);
        this.box.max.fromArray(bounds.max).sub(node.pivotLocal);
        this.worldBounds.union(this.box.applyMatrix4(node.group.matrixWorld));
      }
      for (const group of vehicle.decorationGroups?.values() || []) {
        group.updateWorldMatrix(true, true);
        for (const object of group.children) {
          if (!object.userData.decorationId) continue;
          const mesh = object as THREE.Mesh;
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          if (mesh.geometry.boundingBox) {
            this.worldBounds.union(this.box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
          }
        }
      }
    }
    this.fitBox(this.worldBounds);
    return this.distance;
  }

  private fitBox(box: THREE.Box3) {
    if (box.isEmpty()) return;
    for (let i = 0; i < 8; i++) {
      this.corner.set(i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      this.corner.sub(this.eye).applyQuaternion(this.inverseView);
      // With the camera at local +Z distance d, a point's depth is d - z.
      // Fit all eight corners against horizontal, vertical and near-plane limits.
      const required = this.corner.z + Math.max(
        Math.abs(this.corner.x) / this.horizontalLimit,
        Math.abs(this.corner.y) / this.verticalLimit,
        this.near * 2
      );
      if (Number.isFinite(required)) this.distance = Math.max(this.distance, required);
    }
  }
}
