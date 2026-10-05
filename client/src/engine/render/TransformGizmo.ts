import * as THREE from 'three/webgpu';
import { applyCameraBend, bendPointForView, hookSceneMaterials } from '@entropydrop/space-engine/torus/TorusWorld.ts';

export type TransformAxis = 'x' | 'y' | 'z';
export type TransformOperation = 'move' | 'rotate' | 'scale';
export type TransformHandle = { key: string; kind: TransformOperation; axis: TransformAxis; worldPoint: THREE.Vector3 };
export const transformAxis = (axis: TransformAxis) => new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
export const TRANSFORM_GIZMO_ROTATION_RADIUS = 0.76;
/** Use the same distance scaling for both tools, including their stroke widths. */
export const transformGizmoSize = (position: THREE.Vector3, cameraPosition: THREE.Vector3) =>
  Math.max(0.15, position.distanceTo(cameraPosition) * 0.13);
type Handle = { key: string; kind: TransformOperation; axis: TransformAxis; material: THREE.MeshBasicNodeMaterial;
  color: number; segments: THREE.Vector3[][]; radius: number };

/** Shared local-frame overlay. Wrench disables scale; Modeling uses all nine handles. */
export class TransformGizmo {
  readonly group = new THREE.Group();
  private handles: Handle[] = [];

  constructor({ includeScale = true, name = 'TransformGizmo' } = {}) {
    this.group.name = name;
    this.group.visible = false;
    const colors = { x: 0xff5757, y: 0x65de88, z: 0x589aff };
    for (const axis of ['x', 'y', 'z'] as const) {
      const vector = transformAxis(axis);
      for (const kind of ['move', 'rotate', 'scale'] as const) {
        if (kind === 'scale' && !includeScale) continue;
        const material = new THREE.MeshBasicNodeMaterial({ color: colors[axis], depthTest: false, depthWrite: false, fog: false, toneMapped: false });
        const handle: Handle = { key: `${kind}-${axis}`, kind, axis, material, color: colors[axis], segments: [], radius: kind === 'scale' ? 0.09 : 0.055 };
        const mesh = (geometry: THREE.BufferGeometry, position: THREE.Vector3, direction?: THREE.Vector3) => {
          const object = new THREE.Mesh(geometry, material);
          object.position.copy(position);
          if (direction) object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
          object.renderOrder = 100;
          object.userData.transformHandle = handle.key;
          this.group.add(object);
        };
        if (kind === 'move') {
          mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.73, 6), vector.clone().multiplyScalar(0.525), vector);
          mesh(new THREE.ConeGeometry(0.06, 0.18, 12), vector.clone().multiplyScalar(0.97), vector);
          handle.segments.push([vector.clone().multiplyScalar(0.18), vector.clone().multiplyScalar(1.06)]);
        } else if (kind === 'scale') {
          mesh(new THREE.BoxGeometry(0.13, 0.13, 0.13), vector.clone().multiplyScalar(1.38));
          const point = vector.clone().multiplyScalar(1.38);
          handle.segments.push([point, point.clone()]);
        } else {
          const u = axis === 'x' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
          const v = vector.clone().cross(u);
          const points = Array.from({ length: 65 }, (_, i) => {
            const angle = -0.12 * Math.PI + i / 64 * Math.PI * 1.75;
            return u.clone().multiplyScalar(Math.cos(angle) * TRANSFORM_GIZMO_ROTATION_RADIUS)
              .addScaledVector(v, Math.sin(angle) * TRANSFORM_GIZMO_ROTATION_RADIUS);
          });
          mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 64, 0.012, 6, false), new THREE.Vector3());
          mesh(new THREE.ConeGeometry(0.037, 0.13, 10), points.at(-1)!, points.at(-1)!.clone().sub(points.at(-2)!).normalize());
          for (let i = 1; i < points.length; i++) handle.segments.push([points[i - 1], points[i]]);
        }
        this.handles.push(handle);
      }
    }
    hookSceneMaterials(this.group);
  }

  setPose(position: THREE.Vector3, rotation: THREE.Quaternion, size: number, highlighted?: string) {
    this.group.position.copy(position);
    this.group.quaternion.copy(rotation);
    this.group.scale.setScalar(size);
    this.group.visible = true;
    this.group.updateWorldMatrix(true, true);
    for (const handle of this.handles) handle.material.color.setHex(handle.key === highlighted ? 0xffdc73 : handle.color);
  }

  pick(ray: THREE.Ray): TransformHandle | null {
    if (!this.group.visible) return null;
    this.group.updateWorldMatrix(true, false);
    let best: (TransformHandle & { score: number; distance: number }) | null = null;
    for (const handle of this.handles) {
      const radius = handle.radius * this.group.scale.x;
      for (const [start, end] of handle.segments) {
        const a = this.group.localToWorld(start.clone()), b = this.group.localToWorld(end.clone());
        const ba = bendPointForView(a.x, a.y, a.z), bb = bendPointForView(b.x, b.y, b.z);
        const onRay = new THREE.Vector3(), onHandle = new THREE.Vector3();
        const miss = ray.distanceSqToSegment(ba, bb, onRay, onHandle);
        const distance = onRay.clone().sub(ray.origin).dot(ray.direction);
        const score = miss / (radius * radius);
        if (distance <= 0 || score > 1 || (best && (score > best.score + 1e-8
          || (Math.abs(score - best.score) <= 1e-8 && distance >= best.distance)))) continue;
        const t = ba.distanceToSquared(bb) > 1e-12 ? ba.distanceTo(onHandle) / ba.distanceTo(bb) : 0;
        best = { key: handle.key, kind: handle.kind, axis: handle.axis, worldPoint: a.lerp(b, THREE.MathUtils.clamp(t, 0, 1)), score, distance };
      }
    }
    return best;
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse(object => { (object as THREE.Mesh).geometry?.dispose(); });
    for (const handle of this.handles) handle.material.dispose();
  }
}

/** Project using the same camera bend as rendering, without mutating the FPS camera. */
export function transformViewCamera(camera: THREE.PerspectiveCamera) {
  const view = camera.clone();
  applyCameraBend(view);
  view.updateMatrixWorld(true);
  return view;
}

export function transformScreenPoint(point: THREE.Vector3, camera: THREE.Camera, width: number, height: number) {
  const p = bendPointForView(point.x, point.y, point.z).project(camera);
  return new THREE.Vector2(p.x * width * 0.5, -p.y * height * 0.5);
}
