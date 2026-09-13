import { DEFAULT_PLAYER_SKIN_URL } from './bootstrap/SpaceBootstrap.ts';
import * as THREE from 'three';
import { SceneRenderer } from './engine/render/SceneRenderer.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { worldEditStorageKey } from '@entropydrop/space-engine/voxel/WorldEditPersistence.ts';
import { PlayerPhysics } from '@entropydrop/space-engine/physics/PlayerPhysics.ts';
import { ContraptionPhysics } from '@entropydrop/space-engine/physics/ContraptionPhysics.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { EntitySimulationClock } from '@entropydrop/space-engine/simulation/EntitySimulationClock.ts';
import { PlayerController } from './engine/controls/PlayerController.ts';
import { SpaceBuilder } from './engine/building/SpaceBuilder.ts';
import { SoundManager } from './engine/audio/SoundManager.ts';
import { ParticleSystem } from './engine/render/ParticleSystem.ts';
import { Minimap } from './ui/Minimap.ts';
import { NavigationSystem } from './ui/NavigationSystem.ts';
import {
  encodePlayerPosition,
  enterSpace,
  initialTerrainStreamArea,
  resolveInitialPlayerPose,
  TERRAIN_STREAM_SWITCH_DEBOUNCE_MS,
  terrainStreamAreaForPositionWithHysteresis,
  type PlayerPositionPayload,
  type PlayerPositionRemote,
  type ReadySpaceSession,
  type TerrainStreamArea,
} from './bootstrap/SpaceBootstrap.ts';
import { MultiplayerSync, type RemotePlayerInfo } from './engine/network/MultiplayerSync.ts';
import { SpaceEntitySync } from './engine/network/SpaceEntitySync.ts';
import { mountSpaceUi } from './ui/react/mountSpaceUi.tsx';
import { spaceUiStore, type SpaceUiStore } from './ui/react/store/SpaceUiStore.ts';
import {
  createSpacePersistentStorage,
  type SpaceStorage,
} from './engine/storage/BrowserStorage.ts';
import { logConsoleSecurityWarning } from './bootstrap/ConsoleSecurityWarning.ts';

logConsoleSecurityWarning();

// Mount the 2D interface as soon as the module starts. The authentication gate
// remains above it until bootstrap succeeds, and every engine adapter created
// later can synchronously resolve the React-owned DOM.
mountSpaceUi();

class Game {
  canvasContainer: HTMLElement | null;
  sceneRenderer: any;
  world: World;
  soundManager: any;
  particleSystem: any;
  contraptionPhysics: any;
  contraptionManager: any;
  playerPhysics: any;
  uiStore: SpaceUiStore;
  minimap: Minimap;
  navigationSystem: NavigationSystem;
  controller: PlayerController;
  spaceBuilder: SpaceBuilder;
  clock: THREE.Clock;
  entitySimulationClock: EntitySimulationClock;
  frameCount: number;
  lastFpsTime: number;
  currentFps: number;
  latencyMonitor: ReadySpaceSession['latency_monitor'];
  playerPositionRemote: PlayerPositionRemote;
  lastSavedPlayerPosition: string;
  pendingPlayerPosition: PlayerPositionPayload | null;
  playerPositionSaveInFlight: boolean;
  multiplayerSync: MultiplayerSync | null;
  entitySync: SpaceEntitySync | null;
  remotePlayers: RemotePlayerInfo[];
  terrainEditRemote: ReadySpaceSession['terrain_edit_remote'];
  terrainArea: TerrainStreamArea;
  terrainAreaLoadedKey: string;
  terrainAreaCandidateKey: string;
  terrainAreaCandidateSince: number;
  terrainAreaLoadInFlight: boolean;
  terrainAreaRetryAt: number;
  started: boolean;

  constructor(
    session: ReadySpaceSession,
    persistentStorage: SpaceStorage | null
  ) {
    this.canvasContainer = document.getElementById('canvas-container');

    // 1. Core Engine Systems
    this.sceneRenderer = new SceneRenderer(this.canvasContainer, {
      skinUrl: session.skin_object_url,
      skinModel: session.player.skin_type
    });

    // Procedural terrain must use the durable, server-authoritative seed so all
    // players reconstruct the same base world.
    this.world = new World(
      this.sceneRenderer.scene,
      session.world.seed,
      {
        worldId: session.world.id,
        remote: session.terrain_edit_remote,
        storage: persistentStorage,
        onSyncStatus: status => spaceUiStore.setWorldEditSync(status),
        // A batch older than the bounded server dedupe window is intentionally
        // not replayed over newer shared-world edits. Reload the authoritative
        // AOI after removing that stale outbox entry.
        onResyncRequired: () => {
          window.location.reload();
        }
      }
    );
    if (session.surface_snapshot_remote) {
      const syncSurfaceSnapshots = () => {
        void session.surface_snapshot_remote!.loadAll(
          zone => this.world.installSurfaceZone(zone),
          (zoneX, zoneZ) => this.world.removeSurfaceZone(zoneX, zoneZ),
        ).then(() => this.world.finalizeSurfaceConnections()).catch(error => {
          console.warn('Space far-surface snapshots are temporarily unavailable.', error);
        }).finally(() => {
          window.setTimeout(syncSurfaceSnapshots, 10_000);
        });
      };
      syncSurfaceSnapshots();
    }
    this.sceneRenderer.setWorld(this.world);
    this.soundManager = new SoundManager();
    this.particleSystem = new ParticleSystem(this.sceneRenderer.scene);
    this.contraptionPhysics = new ContraptionPhysics(this.world);
    this.contraptionManager = new ContraptionManager(
      this.sceneRenderer.scene,
      this.world,
      this.soundManager,
      this.particleSystem,
      persistentStorage
    );
    this.contraptionManager.setPhysics(this.contraptionPhysics);
    this.sceneRenderer.setContraptions(this.contraptionManager);
    this.contraptionManager.setWorldId(session.world.id);
    this.contraptionManager.setEntityPersistenceMode('remote');

    this.playerPhysics = new PlayerPhysics(this.world, this.contraptionManager);
    this.uiStore = spaceUiStore;
    this.uiStore.setAuthenticatedSession(
      session.api_origin,
      session.token,
      session.player.is_admin === true,
      session.world.id,
      session.account_api_origin || session.api_origin
    );
    this.uiStore.setSkinWarning(session.entry_warning);
    this.uiStore.setCurrentSkin(
      session.entry_warning || session.skin_object_url === DEFAULT_PLAYER_SKIN_URL ? null : session.skin_object_url,
      session.player.skin_type
    );
    this.minimap = new Minimap(this.world, this.contraptionManager);

    // 2. Player Controller
    this.controller = new PlayerController(
      this.sceneRenderer.camera,
      this.playerPhysics,
      this.world,
      this.soundManager,
      this.particleSystem,
      this.contraptionManager,
      this.uiStore,
      persistentStorage
    );
    this.controller.setSceneRenderer(this.sceneRenderer);
    this.spaceBuilder = new SpaceBuilder({
      world: this.world,
      contraptions: this.contraptionManager,
      controller: this.controller,
      onStatus: status => this.uiStore.setBuilderJob(status)
    });
    this.remotePlayers = [];
    this.contraptionManager.setRuntimeContextProvider(() => {
      const eye = this.playerPhysics.getEyePosition();
      const feet = this.playerPhysics.position;
      const allPlayers = [
        {
          id: 'local',
          position: [eye.x, eye.y, eye.z],
          eyePosition: [eye.x, eye.y, eye.z],
          feetPosition: [feet.x, feet.y, feet.z],
          velocity: this.playerPhysics.velocity.toArray(),
          yaw: this.controller.viewYaw,
          pitch: this.controller.pitch,
          isLocal: true,
          isOnGround: this.playerPhysics.isOnGround,
          isFlying: this.playerPhysics.isFlying,
          isCrouching: this.playerPhysics.isCrouching,
          isSprinting: this.playerPhysics.isSprinting,
          isInWater: this.playerPhysics.isInWater,
          ridingEntityId: this.playerPhysics.ridingContraption?.publicId ?? null,
          ridingBodyId: this.playerPhysics.ridingBodyId ?? null,
          mass: this.playerPhysics.mass
        },
        ...(this.remotePlayers || []).filter(p => !p.is_self).map(p => ({
          id: p.user_id,
          position: [p.x, p.y + 1.62, p.z],
          eyePosition: [p.x, p.y + 1.62, p.z],
          feetPosition: [p.x, p.y, p.z],
          velocity: null,
          yaw: p.yaw,
          pitch: p.pitch,
          isLocal: false,
          isOnGround: null,
          isFlying: null,
          isCrouching: null,
          isSprinting: null,
          isInWater: null,
          ridingEntityId: null,
          ridingBodyId: null,
          avatarEntityId: p.player_entity_id,
          mass: this.playerPhysics.mass
        }))
      ];
      const driven = this.controller.isDriving ? this.controller.drivenContraption : null;
      return {
        players: allPlayers,
        driver: driven ? {
          entityId: driven.publicId,
          playerId: 'local',
          componentId: this.controller.drivenSeat?.componentId || driven.rootComponentId,
          seatIndex: this.controller.drivenSeat?.seatIndex || 0
        } : null
      };
    });

    // 3. Connect UI
    this.uiStore.setController(this.controller);
    this.uiStore.setWorld(this.world);
    this.uiStore.setContraptions(this.contraptionManager);
    this.uiStore.setBuilder(this.spaceBuilder);
    this.uiStore.setSceneRenderer(this.sceneRenderer);
    this.uiStore.setMinimap(this.minimap);
    this.navigationSystem = new NavigationSystem(
      this.playerPhysics,
      this.controller,
      this.uiStore
    );
    this.controller.navigationSystem = this.navigationSystem;
    this.uiStore.setNavigationSystem(this.navigationSystem);

    // 4. Clock & FPS tracking
    this.clock = new THREE.Clock();
    this.entitySimulationClock = new EntitySimulationClock();
    this.frameCount = 0;
    this.lastFpsTime = performance.now();
    this.currentFps = 60;
    this.latencyMonitor = session.latency_monitor;
    this.playerPositionRemote = session.player_position_remote;
    this.terrainEditRemote = session.terrain_edit_remote;
    this.pendingPlayerPosition = null;
    this.playerPositionSaveInFlight = false;
    this.terrainArea = initialTerrainStreamArea(session.player);
    this.terrainAreaLoadedKey = this.terrainArea.key;
    this.terrainAreaCandidateKey = '';
    this.terrainAreaCandidateSince = 0;
    this.terrainAreaLoadInFlight = false;
    this.terrainAreaRetryAt = 0;
    this.started = false;

    // 5. Initial Spawn & Worldgen
    const spawnAdjusted = this.initializeSpawn(session);
    // bootstrapSpace already loaded this window. If a first-entry random spawn
    // crosses into an adjacent tile, the first frame will fetch that tile too.
    this.lastSavedPlayerPosition = session.player.resumed && !spawnAdjusted
      ? JSON.stringify(this.currentPlayerPosition())
      : '';
    this.installPlayerPositionPersistence();
    // Persist a first-entry position or a recovered embedded spawn immediately.
    if (!session.player.resumed || spawnAdjusted) this.queuePlayerPositionSave(true);

    // 5b. Multiplayer Synchronizer (Real-time player presence & terrain updates)
    this.multiplayerSync = new MultiplayerSync({
        apiOrigin: session.api_origin,
        token: session.token,
        worldId: session.world.id,
        currentUserId: session.player.user_id,
        websocketUrl: session.websocket_url,
        poseIntervalMs: 50,
        terrainPollIntervalMs: 1000,
        onPlayersUpdate: (players) => {
          this.remotePlayers = players;
          this.minimap.setRemotePlayers(players);
          this.uiStore.setRemotePlayers(players);
        },
        onTerrainUpdate: (chunks) => {
          this.world.queueRemoteChunkUpdates(chunks);
        }
      });
      this.multiplayerSync.getPlayerPosition = () => ({
        x: this.playerPhysics.position.x,
        y: this.playerPhysics.position.y,
        z: this.playerPhysics.position.z,
        yaw: this.controller.viewYaw,
        pitch: this.controller.pitch
      });
      this.multiplayerSync.setSinceTerrainRevision(session.world.terrain_revision);
      this.multiplayerSync.start();

      this.entitySync = new SpaceEntitySync({
        apiOrigin: session.api_origin,
        token: session.token,
        worldId: session.world.id,
        currentUserId: session.player.user_id,
        controller: this.controller,
        contraptions: this.contraptionManager,
        world: this.world,
        getPlayerPosition: () => this.playerPhysics.position,
        getEntityImpostorDistance: () => this.sceneRenderer.getEntityImpostorSettings().maxDistance,
      });
      this.sceneRenderer.setEntityImpostorRetention(id => this.entitySync?.hasRetainedImpostor(id) ?? false);
      this.entitySync.start();

    // The entry gate owns when gameplay starts. It waits for preloadTerrainAoi
    // to publish the complete initial detailed window first.
    this.animate = this.animate.bind(this);
  }

  initializeSpawn(session: ReadySpaceSession) {
    // The backend returns either the latest durable state or an ephemeral random
    // position for a player who has no snapshot yet.
    const pose = resolveInitialPlayerPose(session.player);

    // Pre-generate initial chunks around the restored position.
    this.world.updateChunksAround(pose.x, pose.z);

    const spawnAdjusted = this.playerPhysics.setInitialPosition(pose.x, pose.y, pose.z);
    this.sceneRenderer.camera.position.copy(this.playerPhysics.getEyePosition());

    // The initial view follows the inner-ring horizon; look up through the central hole to see the opposite surface.
    this.controller.yaw = pose.yaw;
    this.controller.pitch = 0;
    this.sceneRenderer.camera.rotation.set(this.controller.pitch, this.controller.yaw, 0, 'YXZ');

    return spawnAdjusted;
  }

  async preloadInitialTerrain(
    reportProgress?: (value: number, message: string) => void,
  ) {
    return this.world.preloadTerrainAoi(
      this.playerPhysics.position.x,
      this.playerPhysics.position.z,
      progress => {
        const ratio = progress.totalChunks > 0
          ? progress.readyChunks / progress.totalChunks
          : 0;
        const value = Math.min(99, 92 + Math.floor(ratio * 7));
        const count = `${progress.readyChunks}/${progress.totalChunks}`;
        reportProgress?.(
          value,
          document.documentElement.lang.toLowerCase().startsWith('zh')
            ? `正在加载 AOI 全部地形（${count}）…`
            : `Loading all AOI terrain (${count})…`,
        );
      },
    );
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.frameCount = 0;
    this.lastFpsTime = performance.now();
    requestAnimationFrame(this.animate);
  }

  currentPlayerPosition() {
    return encodePlayerPosition(this.playerPhysics.position, this.controller.viewYaw, this.controller.pitch);
  }

  queuePlayerPositionSave(force = false, keepalive = false) {
    const position = this.currentPlayerPosition();
    const serialized = JSON.stringify(position);
    if (!force && serialized === this.lastSavedPlayerPosition) return;

    if (keepalive) {
      // A keepalive fetch is deliberately sent immediately instead of waiting
      // behind an older request that may not finish before the page is frozen.
      void this.playerPositionRemote.save(position, true).catch(() => undefined);
      return;
    }

    this.pendingPlayerPosition = position;
    if (!this.playerPositionSaveInFlight) void this.drainPlayerPositionSave();
  }

  async drainPlayerPositionSave() {
    const position = this.pendingPlayerPosition;
    if (!position) return;
    this.pendingPlayerPosition = null;
    this.playerPositionSaveInFlight = true;
    try {
      await this.playerPositionRemote.save(position);
      this.lastSavedPlayerPosition = JSON.stringify(position);
    } catch (error) {
      console.warn('Space player position sync failed; it will be retried.', error);
    } finally {
      this.playerPositionSaveInFlight = false;
      if (this.pendingPlayerPosition) void this.drainPlayerPositionSave();
    }
  }

  installPlayerPositionPersistence() {
    const persistBeforeSuspension = () => {
      this.queuePlayerPositionSave(true, true);
      this.contraptionManager?.saveEntitiesToStorage?.();
    };
    window.addEventListener('pagehide', persistBeforeSuspension);
    window.addEventListener('beforeunload', persistBeforeSuspension);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') persistBeforeSuspension();
    });
  }

  ensureTerrainArea(playerX: number, playerZ: number) {
    const remote = this.terrainEditRemote;
    if (!remote?.loadArea) return;

    const now = Date.now();
    const candidate = terrainStreamAreaForPositionWithHysteresis(
      playerX,
      playerZ,
      this.terrainArea
    );
    if (candidate.key === this.terrainArea.key) {
      this.terrainAreaCandidateKey = '';
      this.terrainAreaCandidateSince = 0;
    } else if (candidate.key !== this.terrainAreaCandidateKey) {
      this.terrainAreaCandidateKey = candidate.key;
      this.terrainAreaCandidateSince = now;
    } else if (now - this.terrainAreaCandidateSince >= TERRAIN_STREAM_SWITCH_DEBOUNCE_MS) {
      this.terrainArea = candidate;
      this.terrainAreaCandidateKey = '';
      this.terrainAreaCandidateSince = 0;
    }

    const area = this.terrainArea;
    if (
      area.key === this.terrainAreaLoadedKey
      || this.terrainAreaLoadInFlight
      || now < this.terrainAreaRetryAt
    ) return;

    // Serialize AOI loads. If the player crosses another tile while this one is
    // loading, the next frame starts the latest target after this request ends.
    this.terrainAreaLoadInFlight = true;
    void remote.loadArea(
      area.centerChunkX,
      area.centerChunkZ,
      area.radiusChunks,
      chunks => this.world.queueRemoteChunkUpdates(chunks)
    )
      .then(() => {
        this.terrainAreaLoadedKey = area.key;
        this.terrainAreaRetryAt = 0;
      })
      .catch(error => {
        this.terrainAreaRetryAt = Date.now() + 2_000;
        console.warn('Space terrain area loading is temporarily unavailable.', error);
      })
      .finally(() => {
        this.terrainAreaLoadInFlight = false;
      });
  }

  animate() {
    requestAnimationFrame(this.animate);

    const dt = Math.min(this.clock.getDelta(), 0.08);

    // Track FPS
    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsTime >= 500) {
      this.currentFps = (this.frameCount * 1000) / (now - this.lastFpsTime);
      this.frameCount = 0;
      this.lastFpsTime = now;
    }

    // Render-owned work remains responsive at the display refresh rate. Player
    // movement, entity code, and entity physics advance only on the immutable
    // 20 Hz simulation clock below.
    this.controller.updateRender();
    this.spaceBuilder.update();
    const simulation = this.entitySimulationClock.advance(dt, simulationDt => {
      this.controller.updateSimulation(simulationDt);

      // Entity streaming consumes this exact active window, so chunks must be
      // current after player movement and before entities run.
      const simulationPlayerPos = this.playerPhysics.position;
      this.world.updateChunksAround(simulationPlayerPos.x, simulationPlayerPos.z, false);

      const entityInput = this.controller.consumeEntityInputFrame();
      this.contraptionManager.update(simulationDt, entityInput);

      // A contraption can move into the player after the player's own physics
      // step. Resolve that new overlap now. Mounted players are re-seated by
      // updateAimRaycast after the vehicle's solved pose is available.
      if (!this.controller.isDriving) {
        this.playerPhysics.resolveDynamicContraptionOverlaps();
      }
    });

    const playerPos = this.playerPhysics.position;
    // Keep movement and camera presentation independent from terrain loading.
    // The actual stream work is requested after rendering below.
    this.world.updateChunksAround(playerPos.x, playerPos.z, false);
    this.ensureTerrainArea(playerPos.x, playerPos.z);

    // Publish/dispatch direct terrain edits before picking. Raycasts, cursor
    // overlays and the draw submitted below must all observe the same latest
    // terrain publication for this frame.
    this.world.processInteractiveTerrainWork();

    // Pick only after programmable child motion and rigid-body physics have
    // finished, before presentation-only interpolation changes the scene graph.
    this.controller.updateAimRaycast();

    // Physics state stays on exact 50 ms boundaries. Only the temporary scene
    // graph pose is interpolated for this render, then restored below.
    this.contraptionManager.beginRenderInterpolation(simulation.alpha);
    this.playerPhysics.beginRenderInterpolation(simulation.alpha);
    this.controller.syncDrivenVehiclePose();
    this.controller.updateCameraPosition();

    // 4. Update Particles
    this.particleSystem.update(dt);

    // 5. Update Scene Lighting, Sky & Player Avatar
    this.sceneRenderer.update(dt, playerPos, this.controller.viewYaw, {
      velocity: this.playerPhysics.velocity,
      grounded: this.playerPhysics.isOnGround,
      flying: this.playerPhysics.isFlying,
      maxSpeed: this.playerPhysics.isFlying
        ? this.playerPhysics.flySpeed
        : (this.playerPhysics.isSprinting ? this.playerPhysics.sprintSpeed : this.playerPhysics.walkSpeed),
      lookPitch: this.controller.pitch,
      activeTool: this.controller.activeTool,
      toolUseSequence: this.controller.toolUseSequence
    });
    this.sceneRenderer.updateRemotePlayers(this.remotePlayers || [], dt);

    // 6. Update Cursor Highlight
    const cursor = this.controller.getCursorHighlight();
    if (cursor) {
      this.sceneRenderer.setCursor(cursor.pos, cursor.size, cursor.quaternion, cursor.center);
    } else {
      this.sceneRenderer.setCursor(null);
    }

    // 6b. Spoon micro-carve 8x8x8 grid preview
    this.sceneRenderer.setMicroCarvePreview(this.controller.microCarvePreview);

    // 6c. Selector focus-block guide (orange after point 1 is set; micro-sized
    // when aiming at a 0.125 m block in the selector's Tab micro mode).
    if (this.controller.focusBlockPreview) {
      const p = this.controller.focusBlockPreview;
      this.sceneRenderer.setFocusBlockGuide(p.center, !!p.active, p.cellSize ?? 1, p.quaternion);
    } else {
      this.sceneRenderer.clearFocusBlockGuide();
    }

    // 6d. Selector box selection live preview (windows-drag style)
    if (this.controller.boxSelectionPreview) {
      this.sceneRenderer.setBoxSelectionPreview(
        this.controller.boxSelectionPreview.pointA,
        this.controller.boxSelectionPreview.cursor,
        this.controller.boxSelectionPreview.micro === true,
        this.controller.boxSelectionPreview.frame
      );
    } else {
      this.sceneRenderer.clearBoxSelectionPreview();
    }

    // 6e. Hammer inventory hover ghost (entity slots and plain block sets).
    this.sceneRenderer.setInventoryPlacementPreview(
      this.spaceBuilder.getRenderPreview() || this.controller.inventoryPlacementPreview
    );

    // 7. Update UI HUD
    this.uiStore.updateHUD(
      this.currentFps,
      playerPos,
      this.controller.currentRaycast,
      this.controller.hoveredContraption,
      this.latencyMonitor?.getPing() ?? null
    );

    // 7b. Minimap (bottom-right)
    this.minimap.update(
      playerPos,
      this.controller.viewYaw,
      this.controller.isDriving,
      this.controller.drivenContraption
    );

    // 7c. Navigation System is updated in controller.updateSimulation()

    // 8. Draw, then request idle-budgeted background chunk streaming.
    this.sceneRenderer.render([
      this.controller.hoveredContraption,
      this.controller.selectedBlockSelection?.contraption,
      this.controller.selectedSubtree?.contraption,
      this.controller.selectorLevel?.contraption,
      this.controller.drivenContraption,
    ]);
    this.world.scheduleStreamingWork();
    this.playerPhysics.endRenderInterpolation();
    this.contraptionManager.endRenderInterpolation();
  }
}

// Start Game on page load
window.addEventListener('DOMContentLoaded', () => {
  void enterSpace(
    async (session, reportProgress) => {
      const persistentStorage = await createSpacePersistentStorage();
      const game = new Game(session, persistentStorage);
      await game.preloadInitialTerrain(reportProgress);
      game.start();
      if (session.entry_warning) {
        requestAnimationFrame(() => {
          spaceUiStore.showToast(session.entry_warning, {
            tone: 'warning',
            durationMs: 8000,
          });
        });
      }
      // Keep the convenient engine handle for local debugging without exposing
      // the authenticated session graph to every production-page script.
      if (import.meta.env.DEV) (window as any).game = game;
    },
    {
      onStateChange: state => {
        spaceUiStore.setSessionState(
          state.mode,
          state.queuePosition,
          state.cancelQueue,
          state.onlineReady,
          state.enterOnline
        );
      }
    }
  );
});
