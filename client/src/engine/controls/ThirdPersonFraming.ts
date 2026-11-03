import type { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import type { CollisionBounds } from '@entropydrop/space-engine/physics/CollisionGeometry.ts';
import * as THREE from 'three';

// Keep the complete bounding box inside the viewport with 10% padding per edge.
const SCREEN_FRACTION = 0.80;

/** Walking fits the current body. Mounted framing fits a cached swept envelope. */
export class ThirdPersonFraming {
  private vehicle: Contraption | null = null;
  private version = -1;
  private seatKey = '';
  private mountedRadius = 0;
  private readonly inverseView = new THREE.Quaternion();
  private readonly eye = new THREE.Vector3();
  private readonly corner = new THREE.Vector3();
  private readonly box = new THREE.Box3();
  private readonly worldBounds = new THREE.Box3();
  private horizontalLimit = 1;
  private verticalLimit = 1;
  private near = 0.1;
  private distance = 0;

  reset() { this.vehicle = null; }

  measure(camera: THREE.PerspectiveCamera, eye: THREE.Vector3,
    vehicle: Contraption | null, playerBounds?: CollisionBounds, seatKey = ''): number {
    if (vehicle) {
      if (vehicle !== this.vehicle || vehicle.definitionVersion !== this.version || seatKey !== this.seatKey) {
        this.vehicle = vehicle;
        this.version = vehicle.definitionVersion;
        this.seatKey = seatKey;
        this.mountedRadius = this.measureMountedEnvelope(vehicle, eye, playerBounds);
      }
      // A sphere fits at every camera/vehicle heading and every rotor phase.
      // Only an explicit FOV/aspect/zoom change alters this arm while mounted.
      const tangent = Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2)
        * Math.min(1, camera.aspect) * SCREEN_FRACTION;
      return Math.max(this.mountedRadius / Math.sin(Math.atan(tangent)), this.mountedRadius + camera.near * 2);
    }
    this.vehicle = null;
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
    this.fitBox(this.worldBounds);
    return this.distance;
  }

  private measureMountedEnvelope(vehicle: Contraption, eye: THREE.Vector3, playerBounds?: CollisionBounds) {
    const root = vehicle.entityNodes.get(vehicle.rootComponentId);
    if (!root) return 0;
    root.group.updateWorldMatrix(true, true);
    const localCorner = new THREE.Vector3();
    const radiusOfBox = (box: THREE.Box3, matrix?: THREE.Matrix4) => {
      let radius = 0;
      for (let i = 0; i < 8; i++) {
        localCorner.set(i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
        if (matrix) localCorner.applyMatrix4(matrix);
        radius = Math.max(radius, localCorner.length());
      }
      return radius;
    };
    const measureNode = (id: string): number => {
      const node = vehicle.entityNodes.get(id)!;
      let radius = 0;
      const bounds = vehicle.getNodeBlocksBounds(id);
      if (bounds) {
        this.box.min.fromArray(bounds.min).sub(node.pivotLocal);
        this.box.max.fromArray(bounds.max).sub(node.pivotLocal);
        radius = radiusOfBox(this.box);
      }
      const inverse = node.group.matrixWorld.clone().invert();
      for (const object of vehicle.decorationGroups.get(id)?.children || []) {
        if (!object.userData.decorationId) continue;
        const mesh = object as THREE.Mesh;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        if (mesh.geometry.boundingBox) radius = Math.max(radius,
          radiusOfBox(mesh.geometry.boundingBox, inverse.clone().multiply(mesh.matrixWorld)));
      }
      for (const childId of node.children) {
        const child = vehicle.entityNodes.get(childId)!;
        // Rotation cannot change a child's pivot radius. Include all possible
        // rotations before flight, instead of following its animated AABB.
        radius = Math.max(radius, child.group.position.length()
          + measureNode(childId) * Math.max(...child.group.scale.toArray().map(Math.abs)));
      }
      return radius;
    };
    const rootPosition = root.group.getWorldPosition(new THREE.Vector3());
    const scale = root.group.getWorldScale(new THREE.Vector3());
    let radius = measureNode(root.id) * Math.max(...scale.toArray().map(Math.abs)) + eye.distanceTo(rootPosition);
    if (playerBounds) {
      this.box.min.set(playerBounds.minX, playerBounds.minY, playerBounds.minZ).sub(eye);
      this.box.max.set(playerBounds.maxX, playerBounds.maxY, playerBounds.maxZ).sub(eye);
      radius = Math.max(radius, radiusOfBox(this.box));
    }
    return radius;
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
