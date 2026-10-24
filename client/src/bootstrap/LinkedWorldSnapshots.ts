import * as THREE from 'three/webgpu';
import { getWorldProjection } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { readJsonResponse, resolveSafeHttpUrl } from './NetworkSafety.ts';
import { createSpaceSurfaceSnapshotRemote, type SpaceSurfaceSnapshotRemote } from './SpaceSurfaceSnapshot.ts';
import { buildLinkedWorldZone, LINKED_WORLD_ROTATION_CYCLE_SECONDS } from '../engine/render/LinkedWorldGeometry.ts';
import { LinkedWorldRig } from '../engine/render/LinkedWorldRig.ts';

export const LINKED_WORLDS_SETTING_KEY = 'space_setting_linked_worlds';
export interface LinkedWorldState {
  enabled: boolean;
  status: 'off' | 'loading' | 'ready' | 'error';
  message: string;
}
export const LINKED_WORLDS_OFF: LinkedWorldState = { enabled: false, status: 'off', message: '' };
interface SnapshotWorld {
  id: string;
  slug: string | null;
  name: string;
  seed: number;
  terrain_generator_version: number;
  joined: boolean;
}

export function selectSnapshotWorlds(value: unknown, currentWorldId: string): SnapshotWorld[] {
  const worlds = (value as { worlds?: unknown })?.worlds;
  if (!Array.isArray(worlds) || worlds.length > 256 || worlds.some(world =>
    !world || typeof world.id !== 'string' || !world.id || world.id.length > 128
    || typeof world.name !== 'string' || !world.name || world.name.length > 128
    || !(world.slug === null || typeof world.slug === 'string')
    || !Number.isSafeInteger(world.seed) || world.seed < -2147483648 || world.seed > 2147483647
    || !Number.isSafeInteger(world.terrain_generator_version) || world.terrain_generator_version < 1
    || typeof world.joined !== 'boolean')) throw new Error('Invalid world catalog.');
  const preferred = ['nature', 'copper-metropolis', 'aether-archipelago'];
  const rank = (world: SnapshotWorld) => {
    const index = preferred.indexOf(world.slug ?? '');
    return index < 0 ? preferred.length : index;
  };
  const candidates = [...new Map((worlds as SnapshotWorld[]).map(world => [world.id, world])).values()]
    .filter(world => world.id !== currentWorldId).sort((a, b) => rank(a) - rank(b)).slice(0, 2);
  if (candidates.length !== 2) throw new Error('Two additional worlds are required.');
  return candidates;
}

interface Options {
  scene: THREE.Scene;
  apiOrigin: string;
  token: string;
  currentWorldId: string;
  onState: (state: LinkedWorldState) => void;
  fetchImpl?: typeof fetch;
  createRemote?: typeof createSpaceSurfaceSnapshotRemote;
}

/** A disposable, one-shot render layer. No World, admission, simulation,
 * websocket, heartbeat, edits, entity execution or recurring snapshot refresh.
 */
export class LinkedWorldSnapshots {
  private abort: AbortController | null = null;
  private group: THREE.Group | null = null;
  private rig: LinkedWorldRig | null = null;
  private rotationSeconds = 0;
  private state: LinkedWorldState = { ...LINKED_WORLDS_OFF };
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }

  getState(): LinkedWorldState { return { ...this.state }; }

  /** Presentation only: slowly spin the two end links around their own normals.
   * Fixed centers and ring planes preserve the chain links and their clearance.
   * Game supplies its bounded render delta so background tabs cannot jump ahead.
   */
  update(dt: number): void {
    // The linked-ring composition belongs to torus presentation. Retain its
    // snapshots and preference so manually returning to torus restores it.
    if (this.group) this.group.visible = getWorldProjection() === 'torus';
    if (this.state.status !== 'ready' || !Number.isFinite(dt) || dt <= 0) return;
    this.rotationSeconds = (this.rotationSeconds + dt) % LINKED_WORLD_ROTATION_CYCLE_SECONDS;
    this.rig?.update(this.rotationSeconds);
  }

  private publish(state: LinkedWorldState) {
    this.state = state;
    this.options.onState(this.getState());
  }

  private release(group: THREE.Group | null) {
    if (!group) return;
    group.removeFromParent();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>([group.userData.snapshotMaterial]);
    group.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    group.clear();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled && this.state.enabled && this.state.status !== 'error') return;
    this.abort?.abort();
    this.abort = null;
    this.release(this.group);
    this.group = null;
    this.rig = null;
    this.rotationSeconds = 0;
    if (!enabled) { this.publish({ ...LINKED_WORLDS_OFF }); return; }

    const abort = new AbortController();
    this.abort = abort;
    const rig = new LinkedWorldRig();
    const group = rig.group;
    const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 1 });
    group.userData.snapshotMaterial = material;
    this.group = group;
    this.publish({ enabled: true, status: 'loading', message: 'Loading two world snapshots…' });
    const fetchImpl: typeof fetch = (input, init) => (this.options.fetchImpl ?? fetch)(input, { ...init, signal: abort.signal });
    let origin: string;
    const headers = { Authorization: `Bearer ${this.options.token}`, Accept: 'application/json' };
    const request = async (path: string, method = 'GET') => {
      abort.signal.throwIfAborted();
      const response = await fetchImpl(`${origin}/space/api/v2${path}`, { method, headers, cache: 'no-store' });
      if (!response.ok) throw new Error(`World snapshots could not be loaded (HTTP ${response.status}).`);
      return readJsonResponse(response, 256 * 1024);
    };
    try {
      origin = resolveSafeHttpUrl(this.options.apiOrigin).origin;
      const worlds = selectSnapshotWorlds(await request('/worlds'), this.options.currentWorldId);
      const localTransform = new THREE.Matrix4();
      // Sequential worlds keep snapshot downloads within the existing six-request cap.
      for (const [index, world] of worlds.entries()) {
        abort.signal.throwIfAborted();
        // Existing snapshot endpoints require membership. This creates only the
        // access profile: it neither admits a player nor saves a player pose.
        if (!world.joined) await request(`/worlds/${encodeURIComponent(world.id)}/join`, 'POST');
        const remote: SpaceSurfaceSnapshotRemote = (this.options.createRemote ?? createSpaceSurfaceSnapshotRemote)(
          origin, this.options.token, `/space/api/v2/worlds/${encodeURIComponent(world.id)}/surface-zones`,
          world.seed, world.terrain_generator_version, fetchImpl,
        );
        const surface = rig.surfaces[index];
        surface.name = `${world.name} snapshot ring`;
        const meshes = new Map<string, THREE.Mesh>();
        const result = await remote.loadAll(async zone => {
          abort.signal.throwIfAborted();
          const key = `${zone.zoneX},${zone.zoneZ}`;
          const previous = meshes.get(key);
          if (previous) { previous.removeFromParent(); previous.geometry.dispose(); }
          const mesh = new THREE.Mesh(buildLinkedWorldZone(zone, localTransform), material);
          mesh.name = `${world.name} snapshot ${zone.zoneX},${zone.zoneZ}`;
          mesh.userData.torusPreBent = true;
          mesh.raycast = () => {};
          meshes.set(key, mesh);
          surface.add(mesh);
          // Keep per-zone CPU work out of a single long task.
          await new Promise(resolve => setTimeout(resolve, 0));
        }, undefined, {
          getDataBudgetBytes: () => 8 * 1024 * 1024,
          getZoneDemand: () => ({ sampleSize: 32, priority: 0 }),
          onProgress: progress => {
            if (abort.signal.aborted) return;
            this.publish({ enabled: true, status: 'loading',
              message: `${world.name}: ${progress.loadedZones}/${progress.totalZones} zones (${index + 1}/2 worlds)` });
          },
        });
        abort.signal.throwIfAborted();
        if (!result.complete) throw new Error(`${world.name}'s snapshot is still being prepared. Try again shortly.`);
      }
      this.rig = rig;
      this.options.scene.add(group);
      this.publish({ enabled: true, status: 'ready', message: `${worlds.map(world => world.name).join(' + ')} · read-only snapshots` });
    } catch (error) {
      if (abort.signal.aborted) return;
      abort.abort();
      this.release(group);
      this.group = null;
      this.publish({ enabled: true, status: 'error', message: error instanceof Error ? error.message : 'World snapshots could not be loaded.' });
    }
  }

  dispose() { void this.setEnabled(false); }
}
