import * as THREE from 'three';
import { TERRAIN_FADE_MS } from './TerrainHandoff.ts';

type Mesh = THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardMaterial>;
type Slot = { top: Mesh; side: Mesh; coverage: THREE.Vector2; lastUsed: number };

function matches(target: Mesh, source: Mesh, start: number, count: number) {
  if (target.geometry.instanceCount !== count) return false;
  for (const [name, attribute] of Object.entries(source.geometry.attributes)) {
    if (!(attribute instanceof THREE.InstancedBufferAttribute)) continue;
    const existing = target.geometry.getAttribute(name);
    if (!existing) return false;
    const offset = start * attribute.itemSize, length = count * attribute.itemSize;
    for (let i = 0; i < length; i++) if (existing.array[i] !== attribute.array[offset + i]) return false;
  }
  return true;
}

function copy(target: Mesh, source: Mesh, start: number, count: number) {
  for (const [name, attribute] of Object.entries(source.geometry.attributes)) {
    if (!(attribute instanceof THREE.InstancedBufferAttribute)) continue;
    let existing = target.geometry.getAttribute(name) as THREE.InstancedBufferAttribute | undefined;
    const length = count * attribute.itemSize;
    if (!existing || existing.array.length < length
      || existing.array.length > Math.max(64, count * 4) * attribute.itemSize) {
      // WebGL buffers cannot grow in place. Geometric capacity growth keeps
      // ordinary motion within the two reusable sets of GPU allocations.
      const capacity = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
      const ArrayType = attribute.array.constructor as { new(length: number): typeof attribute.array };
      existing = new THREE.InstancedBufferAttribute(new ArrayType(capacity * attribute.itemSize),
        attribute.itemSize, attribute.normalized).setUsage(THREE.DynamicDrawUsage);
      // Dispose the old GPU attributes before replacing one of their handles.
      target.geometry.dispose();
      target.geometry.setAttribute(name, existing);
    }
    existing.array.set(attribute.array.subarray(start * attribute.itemSize, start * attribute.itemSize + length));
    existing.clearUpdateRanges();
    if (length) existing.addUpdateRange(0, length);
    existing.needsUpdate = true;
  }
  target.geometry.instanceCount = count;
}

/** At most two drawn generations and one coalesced pending generation per
 * zone. In-flight updates never mutate either side of a visible transition. */
export class SurfaceBatch {
  readonly bounds: THREE.Sphere;
  private readonly slots: Slot[] = [];
  private current: Slot;
  private previous: Slot | null = null;
  private pending: Slot | null = null;
  private startedAt = 0;
  private visible = true;
  private readonly root: THREE.Object3D;
  private readonly key: string;
  private readonly make: (side: boolean, coverage: THREE.Vector2) => Mesh;

  constructor(root: THREE.Object3D, key: string, bounds: THREE.Sphere,
    make: (side: boolean, coverage: THREE.Vector2) => Mesh) {
    this.root = root; this.key = key; this.bounds = bounds.clone(); this.make = make;
    this.current = this.allocate();
  }

  get top() { return this.current.top; }
  get side() { return this.current.side; }
  get transitioning() { return this.previous !== null; }

  private allocate() {
    const coverage = new THREE.Vector2(0, 1);
    const slot = { top: this.make(false, coverage), side: this.make(true, coverage), coverage, lastUsed: 0 };
    this.slots.push(slot);
    return slot;
  }

  submit(top: Mesh, topStart: number, topCount: number, side: Mesh, sideStart: number,
    sideCount: number, animate: boolean, now = performance.now()) {
    const same = (slot: Slot) => matches(slot.top, top, topStart, topCount)
      && matches(slot.side, side, sideStart, sideCount);
    if (same(this.pending ?? this.current)) return false;
    if (same(this.current)) { this.pending = null; return false; }
    let target = this.pending ?? this.slots.find(slot => slot !== this.current && slot !== this.previous);
    if (!target) target = this.allocate();
    target.lastUsed = now;
    copy(target.top, top, topStart, topCount);
    copy(target.side, side, sideStart, sideCount);
    if (this.previous) this.pending = target;
    else this.activate(target, animate, now);
    return true;
  }

  private activate(next: Slot, animate: boolean, now: number) {
    const old = this.current;
    old.lastUsed = next.lastUsed = now;
    this.current = next;
    this.pending = null;
    this.root.add(next.top, next.side);
    next.top.name = `DistantSurface:${this.key}:tops`;
    next.side.name = `DistantSurface:${this.key}:sides`;
    if (animate && (old.top.geometry.instanceCount || old.side.geometry.instanceCount)) {
      this.previous = old;
      this.startedAt = now;
      next.coverage.set(0, 0);
      old.top.name = `DistantSurface:${this.key}:previous-tops`;
      old.side.name = `DistantSurface:${this.key}:previous-sides`;
    } else {
      this.root.remove(old.top, old.side);
      next.coverage.set(0, 1);
    }
    this.setVisible(this.visible);
  }

  advance(now = performance.now()) {
    for (const slot of this.slots) {
      if (slot === this.current || slot === this.previous || slot === this.pending || now - slot.lastUsed < 5000) continue;
      for (const mesh of [slot.top, slot.side]) {
        if (!mesh.geometry.instanceCount) continue;
        mesh.geometry.dispose();
        for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) {
          if (attribute instanceof THREE.InstancedBufferAttribute) mesh.geometry.deleteAttribute(name);
        }
        mesh.geometry.instanceCount = 0;
      }
    }
    if (!this.previous) return;
    const linear = Math.max(0, Math.min(1, (now - this.startedAt) / TERRAIN_FADE_MS));
    const t = linear * linear * (3 - 2 * linear);
    this.current.coverage.set(0, t);
    this.previous.coverage.set(t, 1);
    if (linear < 1) return;
    this.root.remove(this.previous.top, this.previous.side);
    this.previous = null;
    if (this.pending) this.activate(this.pending, this.visible, now);
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    for (const slot of [this.current, this.previous]) if (slot) {
      slot.top.visible = visible && slot.top.geometry.instanceCount > 0;
      slot.side.visible = visible && slot.side.geometry.instanceCount > 0;
    }
  }

  dispose() {
    for (const slot of this.slots) for (const mesh of [slot.top, slot.side]) {
      this.root.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}
