import * as THREE from 'three/webgpu';
import { hookSceneMaterials } from '@entropydrop/space-engine/torus/TorusWorld.ts';

export interface PivotLinkEndpoints {
  start: THREE.Vector3;
  end: THREE.Vector3;
}

const SEGMENTS = 64;

/** Reusable white straight links, subdivided to follow the world's torus bend. */
export class PivotLinks {
  private positions = new THREE.Float32BufferAttribute(new Float32Array(0), 3);
  readonly lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicNodeMaterial({
    color: 0xffffff, transparent: true, opacity: 0.8,
    depthTest: false, depthWrite: false, fog: false, toneMapped: false,
  }));

  constructor(name: string) {
    this.lines.name = name;
    this.lines.visible = false;
    this.lines.renderOrder = 93;
    this.lines.geometry.setAttribute('position', this.positions);
    hookSceneMaterials(this.lines);
  }

  setLinks(entries: PivotLinkEndpoints[]) {
    const vertices = entries.length * SEGMENTS * 2;
    if (this.positions.count < vertices) {
      const capacity = 2 ** Math.ceil(Math.log2(vertices));
      this.positions = new THREE.Float32BufferAttribute(new Float32Array(capacity * 3), 3);
      this.positions.setUsage(THREE.DynamicDrawUsage);
      this.lines.geometry.dispose();
      this.lines.geometry = new THREE.BufferGeometry();
      this.lines.geometry.setAttribute('position', this.positions);
    }
    let vertex = 0;
    const point = new THREE.Vector3();
    for (const entry of entries) {
      for (let segment = 0; segment < SEGMENTS; segment++) {
        for (let end = segment; end <= segment + 1; end++) {
          point.lerpVectors(entry.start, entry.end, end / SEGMENTS);
          this.positions.setXYZ(vertex++, point.x, point.y, point.z);
        }
      }
    }
    this.positions.needsUpdate = true;
    this.lines.geometry.setDrawRange(0, vertex);
    this.lines.visible = vertex > 0;
  }

  dispose() {
    this.lines.removeFromParent();
    this.lines.geometry.dispose();
    this.lines.material.dispose();
  }
}
