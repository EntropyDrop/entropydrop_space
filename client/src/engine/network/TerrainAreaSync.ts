import type { World } from '@entropydrop/space-engine/voxel/World.ts';
import type { WorldEditRemote } from '@entropydrop/space-engine/voxel/WorldEditPersistence.ts';
import {
  TERRAIN_STREAM_SWITCH_DEBOUNCE_MS,
  terrainStreamAreaForPositionWithHysteresis,
  type TerrainStreamArea,
} from '../../bootstrap/SpaceBootstrap.ts';
import type { MultiplayerSync } from './MultiplayerSync.ts';

const TERRAIN_AREA_RETRY_MS = 2_000;

interface TerrainAreaSyncOptions {
  initialArea: TerrainStreamArea;
  loadArea: NonNullable<WorldEditRemote['loadArea']>;
  world: Pick<World, 'queueRemoteChunkUpdates' | 'setTerrainDataWindow'>;
  realtime: Pick<MultiplayerSync, 'getTerrainSnapshotBaseline' | 'setTerrainArea'>;
}

export class TerrainAreaSync {
  private readonly options: TerrainAreaSyncOptions;
  private target: TerrainStreamArea;
  private loadedKey: string;
  private candidateKey = '';
  private candidateSince = 0;
  private request: AbortController | null = null;
  private retryAt = 0;

  constructor(options: TerrainAreaSyncOptions) {
    this.options = options;
    this.target = options.initialArea;
    this.loadedKey = this.target.key;
  }

  update(playerX: number, playerZ: number) {
    const now = performance.now();
    const candidate = terrainStreamAreaForPositionWithHysteresis(playerX, playerZ, this.target);
    if (candidate.key === this.target.key) {
      this.candidateKey = '';
    } else if (candidate.key !== this.candidateKey) {
      this.candidateKey = candidate.key;
      this.candidateSince = now;
    } else if (now - this.candidateSince >= TERRAIN_STREAM_SWITCH_DEBOUNCE_MS) {
      this.target = candidate;
      this.candidateKey = '';
      this.request?.abort();
      this.request = null;
      this.retryAt = 0;
    }
    if (this.target.key === this.loadedKey || this.request || now < this.retryAt) return;
    void this.load(this.target);
  }

  private async load(area: TerrainStreamArea) {
    const request = new AbortController();
    this.request = request;
    const { realtime, world, loadArea } = this.options;
    // Each snapshot page can observe a different database state. Catch up
    // from a committed revision sampled before the first page was requested.
    const baseline = realtime.getTerrainSnapshotBaseline();
    try {
      await loadArea(
        area.centerChunkX,
        area.centerChunkZ,
        area.radiusChunks,
        chunks => {
          if (!request.signal.aborted) world.queueRemoteChunkUpdates(chunks);
        },
        area.radiusChunksZ,
        request.signal,
      );
      request.signal.throwIfAborted();
      world.setTerrainDataWindow(area);
      realtime.setTerrainArea(area, baseline);
      this.loadedKey = area.key;
    } catch (error) {
      if (!request.signal.aborted) {
        this.retryAt = performance.now() + TERRAIN_AREA_RETRY_MS;
        console.warn('Space terrain area loading is temporarily unavailable.', error);
      }
    } finally {
      if (this.request === request) this.request = null;
    }
  }
}
