import * as THREE from 'three';
import { bendPoint } from '@entropydrop/space-engine/torus/TorusWorld.ts';

export function entityDisplayName(entity: any): string {
  return entity.getComponentName?.() || entity.rootComponentName || entity.rootComponentId || `Entity #${entity.id}`;
}

export interface EntityRunStatus {
  running: boolean;
  tone: 'hosted' | 'stopped' | 'waiting' | 'running';
  icon: 'play' | 'stop' | 'pause' | 'waiting';
  caption: string;
  text: string;
}

export function entityRunStatus(entity: any, currentUserName: string | null = null, now = Date.now()): EntityRunStatus {
  const running = entity.serverManaged && !entity.serverExecutesLocally
    ? entity.serverDesiredRunState === 'running'
    : !entity.isWrenchGrabbed && (entity.scriptStatus === 'running' || entity.isPhysicsSimulationEnabled?.() === true);
  if (entity.serverExecutionMode === 'hosted') {
    return { running, tone: 'hosted', icon: !running ? 'stop' : entity.serverHostingEnabled ? 'play' : 'pause',
      caption: 'Server hosting', text: running && entity.serverHostingEnabled
      ? 'Server hosting · running' : running ? 'Server hosting · paused' : 'Server hosting · stopped' };
  }
  if (!running) return { running: false, tone: 'stopped', icon: 'stop', caption: '', text: 'Stopped' };
  if (entity.serverManaged && !entity.serverExecutesLocally
    && !(Date.parse(entity.serverExecutionLeaseExpiresAt || '') > now)) {
    return { running: true, tone: 'waiting', icon: 'waiting', caption: 'Waiting for executor', text: 'Starting · waiting for an execution endpoint' };
  }
  const executor = entity.serverExecutorName || (entity.serverExecutesLocally ? currentUserName : null)
    || (entity.serverManaged ? 'execution endpoint' : currentUserName || 'this browser');
  return { running: true, tone: 'running', icon: 'play', caption: executor, text: `Running · ${executor}` };
}

/** CSS handles the unlocked cursor; this handles pointer-locked crosshair aim.
 * One topmost DOM hit after projection avoids per-control rect reads/rerenders. */
export class EntityNameplateAimHighlighter {
  private highlighted: HTMLElement | null = null;

  update(root: HTMLElement, locked: boolean, viewport: { width: number; height: number }, blocked = false): void {
    root.classList.toggle('is-pointer-locked', locked);
    let control: HTMLElement | null = null;
    if (locked && !blocked && viewport.width > 0 && viewport.height > 0) {
      const hit = root.ownerDocument.elementFromPoint?.(viewport.width / 2, viewport.height / 2);
      control = hit?.closest<HTMLElement>('[data-entity-nameplate-control]') || null;
      if (control && (!root.contains(control) || (control as HTMLButtonElement).disabled)) control = null;
    }
    if (control === this.highlighted) return;
    this.clear();
    this.highlighted = control;
    control?.classList.add('is-aimed');
  }

  clear(root?: HTMLElement | null): void {
    this.highlighted?.classList.remove('is-aimed');
    this.highlighted = null;
    root?.classList.remove('is-pointer-locked');
  }
}

/** Cache authored per-component extents, then transform only eight corners per
 * component each frame. Disabled collision still has visible blocks and a label. */
export class EntityNameplateProjector {
  private shapes = new WeakMap<object, { shape: any; blocks: any; bounds: Map<string, THREE.Box3> }>();
  private bounds = new THREE.Box3();
  private partBounds = new THREE.Box3();
  private point = new THREE.Vector3();

  project(entity: any, camera: THREE.Camera, viewport: { width: number; height: number }) {
    let cached = this.shapes.get(entity);
    const shape = entity.collisionEntries;
    if (!cached || cached.shape !== shape || cached.blocks !== entity.blocks) {
      const bounds = new Map<string, THREE.Box3>();
      for (const block of entity.blocks || []) {
        const id = block.entityId || entity.rootComponentId;
        let part = bounds.get(id);
        if (!part) bounds.set(id, part = new THREE.Box3());
        const size = block.size || 1;
        part.expandByPoint(this.point.set(block.localX, block.localY, block.localZ));
        part.expandByPoint(this.point.set(block.localX + size, block.localY + size, block.localZ + size));
      }
      cached = { shape, blocks: entity.blocks, bounds };
      this.shapes.set(entity, cached);
    }
    entity.rootGroup?.updateWorldMatrix(true, true);
    this.bounds.makeEmpty();
    for (const [id, local] of cached.bounds) {
      const node = entity.entityNodes?.get(id);
      if (!node) continue;
      this.partBounds.copy(local);
      this.partBounds.min.sub(node.pivotLocal);
      this.partBounds.max.sub(node.pivotLocal);
      this.partBounds.applyMatrix4(node.group.matrixWorld);
      this.bounds.union(this.partBounds);
    }
    if (this.bounds.isEmpty() || viewport.width <= 0 || viewport.height <= 0) return null;
    this.bounds.getCenter(this.point);
    this.point.y = this.bounds.max.y + 0.3;
    bendPoint(this.point.x, this.point.y, this.point.z, this.point);
    this.point.project(camera);
    if (![this.point.x, this.point.y, this.point.z].every(Number.isFinite)
      || this.point.z < -1 || this.point.z > 1 || Math.abs(this.point.x) > 1 || Math.abs(this.point.y) > 1) return null;
    return { x: (this.point.x + 1) * viewport.width / 2,
      y: (1 - this.point.y) * viewport.height / 2, depth: this.point.z };
  }
}
