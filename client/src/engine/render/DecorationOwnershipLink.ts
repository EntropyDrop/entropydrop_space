import * as THREE from 'three/webgpu';
import { hookSceneMaterials } from '@entropydrop/space-engine/torus/TorusWorld.ts';

const SEGMENTS = 64;
const SIDES = 6;

/** Selection-only overlay. Reuse the vertex buffer while the wave travels toward the owner. */
export class DecorationOwnershipLink {
  readonly group = new THREE.Group();
  private readonly geometry = new THREE.BufferGeometry();
  private readonly positions = new THREE.Float32BufferAttribute(new Float32Array((SEGMENTS + 1) * SIDES * 3), 3);
  private readonly material = new THREE.MeshBasicNodeMaterial({
    color: 0xffdc73, transparent: true, opacity: 0.85,
    depthTest: false, depthWrite: false, fog: false, toneMapped: false,
  });
  private readonly arrow = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 10), this.material);
  private readonly pivot = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), this.material);

  constructor() {
    this.group.name = 'DecorationOwnershipLink';
    this.group.visible = false;
    this.positions.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.positions);
    const indices: number[] = [];
    for (let i = 0; i < SEGMENTS; i++) {
      for (let j = 0; j < SIDES; j++) {
        const a = i * SIDES + j, b = i * SIDES + (j + 1) % SIDES;
        indices.push(a, b, a + SIDES, b, b + SIDES, a + SIDES);
      }
    }
    this.geometry.setIndex(indices);
    const wave = new THREE.Mesh(this.geometry, this.material);
    wave.name = 'OwnershipWave';
    this.arrow.name = 'OwnershipArrow';
    this.pivot.name = 'OwnerPivot';
    this.group.add(wave, this.arrow, this.pivot);
    this.group.traverse(object => { object.renderOrder = 94; });
    hookSceneMaterials(this.group);
  }

  setEndpoints(center: THREE.Vector3, pivot: THREE.Vector3, camera: THREE.Camera, size: number, seconds: number) {
    this.group.position.copy(center);
    const delta = pivot.clone().sub(center);
    const distance = delta.length();
    this.group.visible = true;
    this.pivot.position.copy(delta);
    this.pivot.scale.setScalar(size * 0.026);
    const wave = this.group.children[0];
    // A coincident center and pivot still has a marker, but no direction to draw.
    wave.visible = this.arrow.visible = distance > 1e-5;
    if (!wave.visible) return;

    const direction = delta.clone().divideScalar(distance);
    const normal = new THREE.Vector3().crossVectors(direction, camera.position.clone().sub(center));
    if (normal.lengthSq() < 1e-8) {
      normal.set(0, 1, 0).applyQuaternion(camera.quaternion);
      normal.addScaledVector(direction, -normal.dot(direction));
      if (normal.lengthSq() < 1e-8) normal.crossVectors(direction, Math.abs(direction.y) < 0.9
        ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0));
    }
    normal.normalize();
    const binormal = direction.clone().cross(normal).normalize();
    const amplitude = Math.min(size * 0.065, distance * 0.08);
    const radius = Math.min(size * 0.008, distance * 0.025);
    const cycles = THREE.MathUtils.clamp(distance / Math.max(size * 0.65, 0.01), 1, 6);
    const phase = seconds * Math.PI * 2 * 1.25;
    const point = new THREE.Vector3(), ringNormal = new THREE.Vector3();
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS;
      // Squared taper pins both ends and their tangents while the interior moves.
      const envelope = Math.sin(Math.PI * t) ** 2;
      const angle = t * Math.PI * 2 * cycles - phase;
      const offset = amplitude * envelope * Math.sin(angle);
      const slope = amplitude * (Math.PI * Math.sin(2 * Math.PI * t) * Math.sin(angle)
        + envelope * Math.PI * 2 * cycles * Math.cos(angle));
      point.copy(delta).multiplyScalar(t).addScaledVector(normal, offset);
      ringNormal.copy(normal).multiplyScalar(distance).addScaledVector(direction, -slope).normalize();
      for (let j = 0; j < SIDES; j++) {
        const theta = j / SIDES * Math.PI * 2;
        const u = Math.cos(theta) * radius, v = Math.sin(theta) * radius;
        this.positions.setXYZ(i * SIDES + j,
          point.x + ringNormal.x * u + binormal.x * v,
          point.y + ringNormal.y * u + binormal.y * v,
          point.z + ringNormal.z * u + binormal.z * v);
      }
    }
    this.positions.needsUpdate = true;
    const arrowLength = Math.min(size * 0.13, distance * 0.22);
    this.arrow.position.copy(delta).addScaledVector(direction, -arrowLength / 2);
    this.arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    this.arrow.scale.set(arrowLength * 0.3, arrowLength, arrowLength * 0.3);
    this.group.updateWorldMatrix(true, true);
  }

  dispose() {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.arrow.geometry.dispose();
    this.pivot.geometry.dispose();
    this.material.dispose();
  }
}
