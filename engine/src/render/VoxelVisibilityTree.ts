import type * as THREE from 'three';
import { VOXEL_VISIBILITY_STRIDE as STRIDE } from './VoxelFaceVisibility.ts';

type Node = { x: number; y: number; z: number; radius: number; ax: number; ay: number; az: number;
  axisDeviation: number; coneDeviation: number; normalLength: number; deviation: number;
  start: number; end: number; right: number };

/** Ordered native-style hierarchy. Ancestors discharge plane/cone tests, while
 * uncertain leaves use the original Float64 expressions and motion margins.
 * The output stores rejection reasons; the arena still emits its original order.
 * Distance/facing caches are lazy and position-keyed, so turning reuses them. */
export class VoxelVisibilityTree {
  private readonly nodes: Node[] = [];
  private readonly stamps: Float64Array;
  readonly result: Uint8Array;
  readonly selected: Uint32Array;
  count = 0;
  back = 0;
  outside = 0;
  positionTests = 0;
  private readonly data: Float32Array;
  constructor(data: Float32Array) {
    this.data = data;
    const count = Math.floor(data.length / STRIDE);
    this.stamps = new Float64Array(count); this.stamps.fill(-1);
    this.result = new Uint8Array(count); this.selected = new Uint32Array(count);
    if (count) this.build(0, count);
  }
  get bytes() { return this.stamps.byteLength + this.result.byteLength + this.selected.byteLength + this.nodes.length * 14 * 8; }
  private build(start: number, end: number): number {
    const data = this.data;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = start; i < end; i++) {
      const at = i * STRIDE;
      x0 = Math.min(x0, data[at]); x1 = Math.max(x1, data[at]);
      y0 = Math.min(y0, data[at + 1]); y1 = Math.max(y1, data[at + 1]);
      z0 = Math.min(z0, data[at + 2]); z1 = Math.max(z1, data[at + 2]);
    }
    const node: Node = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2, radius: 0,
      ax: data[start * STRIDE + 4], ay: data[start * STRIDE + 5], az: data[start * STRIDE + 6],
      axisDeviation: 0, coneDeviation: 0, normalLength: 0, deviation: 0, start, end, right: 0 };
    for (let i = start; i < end; i++) {
      const at = i * STRIDE, ax = data[at + 4], ay = data[at + 5], az = data[at + 6];
      node.radius = Math.max(node.radius, Math.hypot(node.x - data[at], node.y - data[at + 1], node.z - data[at + 2]) + data[at + 3] + .001);
      const deviation = Math.hypot(ax - node.ax, ay - node.ay, az - node.az);
      node.axisDeviation = Math.max(node.axisDeviation, deviation);
      node.coneDeviation = Math.max(node.coneDeviation, deviation + data[at + 7]);
      node.normalLength = Math.max(node.normalLength, Math.hypot(ax, ay, az));
      node.deviation = Math.max(node.deviation, data[at + 7]);
    }
    const index = this.nodes.length; this.nodes.push(node);
    if (end - start > 16) {
      const mid = (start + end) >>> 1;
      this.build(start, mid); node.right = this.build(mid, end);
    }
    return index;
  }

  select(camera: THREE.Vector3, frustum: THREE.Frustum, padding: number, angular: number,
    flattening: boolean, position: number, distances: Float64Array, facing: Uint8Array, covered?: Uint32Array) {
    this.positionTests = this.count = this.back = this.outside = 0;
    if (!this.nodes.length) return this.result;
    // Support unnormalised and zero planes used by custom cameras and tests.
    const lengths = frustum.planes.map(p => Math.max(1, p.normal.length()));
    const accept = (start: number, end: number) => {
      this.result.fill(0, start, end);
      for (let block = start; block < end; block++) if (!covered || covered[block + 1] === covered[block]) {
        this.selected[this.count++] = block;
      }
    };
    const reject = (n: Node, reason: number) => {
      this.result.fill(reason, n.start, n.end);
      const count = n.end - n.start - (covered ? covered[n.end] - covered[n.start] : 0);
      if (reason === 1) this.back += count; else this.outside += count;
    };
    const visit = (index: number, pending: number) => {
      const n = this.nodes[index], dx = camera.x - n.x, dy = camera.y - n.y, dz = camera.z - n.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const local = flattening && distance + n.radius <= 256 + padding;
      const outside = !flattening || distance - n.radius > 256 + padding;
      if (local) { accept(n.start, n.end); return; }
      // Reject a whole outside range immediately. Back/outside counters record
      // the proof used, not the old per-leaf test precedence. Visible order is exact.
      for (let i = 0; i < 6; i++) if (pending & (1 << i)) {
        const p = frustum.planes[i], normal = p.normal;
        const value = normal.x * n.x + normal.y * n.y + normal.z * n.z + p.constant;
        const extent = n.radius * lengths[i];
        if (outside && value + extent + padding + (distance + n.radius) * angular < -.001) {
          reject(n, 2); return;
        }
        if (value - extent > .001) pending &= ~(1 << i);
      }
      if (pending & 64) {
        const dot = n.ax * dx + n.ay * dy + n.az * dz;
        const upper = dot + distance * n.coneDeviation + n.radius * (n.normalLength + n.deviation + 1) + padding;
        if (outside && upper < -.001) { reject(n, 1); return; }
        if (dot - distance * n.axisDeviation - n.radius * n.normalLength + padding > .001) pending &= ~64;
      }
      if (!pending) { accept(n.start, n.end); return; }
      if (n.right) { visit(index + 1, pending); visit(n.right, pending); return; }
      for (let block = n.start; block < n.end; block++) {
        if (covered && covered[block + 1] !== covered[block]) continue;
        const at = block * STRIDE, data = this.data;
        if (this.stamps[block] !== position) {
          const x = camera.x - data[at], y = camera.y - data[at + 1], z = camera.z - data[at + 2];
          const d = Math.sqrt(x * x + y * y + z * z), r = data[at + 3];
          distances[block] = d;
          facing[block] = flattening && d - r <= 256 + padding ? 2
            : data[at + 4] * x + data[at + 5] * y + data[at + 6] * z + d * data[at + 7] + r + padding < 0 ? 1 : 0;
          this.stamps[block] = position; this.positionTests++;
        }
        let reason = facing[block] === 1 ? 1 : 0;
        if (!reason && facing[block] !== 2) {
          const margin = -data[at + 3] - padding - distances[block] * angular;
          for (let i = 0; i < 6; i++) if (pending & (1 << i)) {
            const p = frustum.planes[i], normal = p.normal;
            if (normal.x * data[at] + normal.y * data[at + 1] + normal.z * data[at + 2] + p.constant < margin) { reason = 2; break; }
          }
        }
        this.result[block] = reason;
        if (reason === 1) this.back++; else if (reason === 2) this.outside++; else this.selected[this.count++] = block;
      }
    };
    visit(0, 127);
    return this.result;
  }
}
