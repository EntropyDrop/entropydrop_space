import * as THREE from 'three';
import { ActionDomain } from '@entropydrop/space-engine/actions/BasicActions.ts';
import type {
  SpaceBuildValidation,
  SpaceBuilderJobStatus
} from '../../../engine/building/SpaceBuilder.ts';
import {
  loadAgentConfig,
  normalizeAgentConfig,
  saveAgentConfig
} from '../../../engine/contraption/AgentConfig.ts';
import { compareComponentIds, ContraptionMode } from '@entropydrop/space-engine/contraption/Contraption.ts';
import {
  MAX_INVENTORY_IMPORT_BYTES,
  SpecialTool,
  type PlayerPerspective
} from '../../../engine/controls/PlayerController.ts';
import type { SelectorShape } from '../../../engine/controls/SelectorShapes.ts';
import {
  DEFAULT_WORLD_SHAPE_MODE,
  getWorldShapeMode,
  normalizeWorldShapeMode,
  setWorldShapeMode as setGlobalWorldShapeMode,
  TORUS_SIZE_X,
  TORUS_SIZE_Z,
  wrapX,
  wrapZ,
  type WorldShapeMode,
} from '@entropydrop/space-engine/torus/TorusWorld.ts';
import {
  DEFAULT_DISTANT_SURFACE_SETTINGS,
  normalizeDistantSurfaceSettings,
  type DistantSurfaceSettingKey,
  type DistantSurfaceSettings,
} from '@entropydrop/space-engine/render/DistantSurfaceLayer.ts';
import { triggerProtobufDownload } from '../browser/downloadProtobuf.ts';
import { colorToHex, normalizeColor, PRESET_COLORS } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { SpaceApiKeyClient } from '../../../bootstrap/SpaceApiKeyClient.ts';
import { SpaceMarketClient } from '../../../bootstrap/SpaceMarketClient.ts';
import { MAX_BACKPACK_SLOTS_PER_CATEGORY } from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';
import {
  DEFAULT_LIGHTING_QUALITY, LIGHTING_PRESETS, LIGHTING_QUALITY_SETTING_KEY,
  normalizeLightingQuality, type LightingQuality,
} from '../../../engine/render/LightingQuality.ts';
import { triggerColorPickerInput } from '../utils/colorPickerInput.ts';
import {
  DEFAULT_ENTITY_IMPOSTOR_SETTINGS, ENTITY_IMPOSTOR_SETTING_KEY,
  normalizeEntityImpostorSettings, type EntityImpostorSettings,
} from '../../../engine/render/EntityImpostorSettings.ts';

export type SpaceModal = 'inventory' | 'code' | 'settings' | 'builder' | null;
export type ResolutionScaleSetting = 'auto' | '1' | '0.8' | '0.67' | '0.5';

const RESOLUTION_SCALE_PRESETS = [1, 0.8, 0.67, 0.5] as const;
const MUSIC_ENABLED_SETTING_KEY = 'space_setting_music_enabled';
const EFFECTS_ENABLED_SETTING_KEY = 'space_setting_effects_enabled';
const LEGACY_MUTED_SETTING_KEY = 'space_setting_muted';

function storedBoolean(value: string | null, fallback: boolean): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function normalizeResolutionScaleSetting(value: unknown): ResolutionScaleSetting {
  if (value === 'auto' || value === null || value === undefined || value === '') return 'auto';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'auto';
  const nearest = RESOLUTION_SCALE_PRESETS.reduce((best, candidate) => (
    Math.abs(candidate - numeric) < Math.abs(best - numeric) ? candidate : best
  ));
  return String(nearest) as ResolutionScaleSetting;
}

function resolutionSnapshot(state: any): Pick<
  SpaceUiSnapshot,
  'resolutionScaleMode' | 'resolutionScale' | 'resolutionPixelRatio' | 'resolutionEffectsQuality' | 'resolutionTargetFps'
> {
  return {
    resolutionScaleMode: state?.mode === 'fixed'
      ? normalizeResolutionScaleSetting(state.fixedScale)
      : 'auto' as ResolutionScaleSetting,
    resolutionScale: Number(state?.scale) || 1,
    resolutionPixelRatio: Number(state?.effectivePixelRatio) || 1,
    resolutionEffectsQuality: state?.effectsQuality === 'reduced' ? 'reduced' : 'full',
    resolutionTargetFps: state?.targetFps === 60 ? 60 : 120
  };
}

export interface NearbyEntityItem {
  id: string | number;
  name: string;
  pos: { x: number; y: number; z: number };
  dist: number;
  type: string;
}

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  code?: string | null;
  targetId?: string | null;
  isStreaming?: boolean;
}

export interface BuildAgentMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  transportContent?: string;
  isStreaming?: boolean;
}

export interface SelectorView {
  micro: boolean;
  shape: SelectorShape;
  title: string;
  details: string;
  canAssemble: boolean;
  assembleLabel: string;
  canCopy: boolean;
  canDelete: boolean;
}

export interface BulkEditView {
  label: string;
  phase: 'applying' | 'waiting' | 'syncing' | 'complete' | 'failed';
  processed: number;
  total: number;
  changed: number;
  detail?: string;
}

export interface WorldEditSyncView {
  pendingBatches: number;
  pendingMutations: number;
  sending: boolean;
  retrying: boolean;
  retryDelayMs: number;
  acknowledgedBatches: number;
  acknowledgedMutations: number;
  backpressured: boolean;
  quota: {
    dailyLimit: number;
    usedToday: number;
    remainingToday: number;
    resetAt: string;
  } | null;
  blockedCode: string | null;
}

export interface TelemetryView {
  groundDistance: string;
  altitude: string;
  speed: string;
  mass: string;
  powerPercent: number;
  status: string;
  executionTime: string;
  logs: string[];
}

export interface SpaceUiSnapshot {
  revision: number;
  controller: any;
  world: any;
  contraptions: any;
  sceneRenderer: any;
  navigationSystem: any;
  minimap: any;
  hasStarted: boolean;
  pointerLocked: boolean;
  activeModal: SpaceModal;
  apiDocsOpen: boolean;
  agentSetupOpen: boolean;
  hotbarSlots: Array<{ type: string; value: string; name: string; icon: string; desc: string }>;
  selectedHotbarIndex: number;
  selectedColor: number;
  selectedColorIndex: number;
  paletteColors: Array<{ hex: string; name: string }>;
  activeColorSetId: string | null;
  activeInventoryCategory: 'blockset' | 'entity' | 'colorset';
  selectedInventoryIndex: number;
  editingContraption: any;
  selectedComponentNodeId: string;
  scriptDraft: string;
  globalPlaybackState: 'play' | 'stop';
  agentMessages: AgentMessage[];
  agentBusy: boolean;
  agentConfig: any;
  builder: any;
  buildAgentMessages: BuildAgentMessage[];
  buildAgentBusy: boolean;
  buildAgentSetupOpen: boolean;
  buildValidation: SpaceBuildValidation | null;
  buildSourcePlan: any;
  builderJob: SpaceBuilderJobStatus | null;
  fpsText: string;
  pingText: string;
  pingClass: string;
  positionText: string;
  nearbyEntities: NearbyEntityItem[];
  selector: SelectorView;
  brushMicro: boolean;
  bulkEdit: BulkEditView | null;
  worldEditSync: WorldEditSyncView;
  telemetry: TelemetryView;
  fov: number;
  perspective: PlayerPerspective;
  cameraDistance: number;
  worldShapeMode: WorldShapeMode;
  renderDistance: number;
  minimapEnabled: boolean;
  distantSurfaceSettings: DistantSurfaceSettings;
  entityImpostorSettings: EntityImpostorSettings;
  resolutionScaleMode: ResolutionScaleSetting;
  resolutionScale: number;
  resolutionPixelRatio: number;
  resolutionEffectsQuality: 'full' | 'reduced';
  resolutionTargetFps: number;
  shadowsEnabled: boolean;
  lightingQuality: LightingQuality;
  skinWarning: string | null;
  currentSkin: { url: string; model: 'strong' | 'slim' } | null;
  apiWorldId: string | null;
  toast: { id: number; message: string; tone: 'default' | 'warning' } | null;
  isAdmin: boolean;
  musicEnabled: boolean;
  effectsEnabled: boolean;
  sessionMode: 'online';
  queuePosition: number | null;
  onlineReady: boolean;
}

type Listener = () => void;

const HOTBAR_SLOTS = [
  { type: 'tool', value: SpecialTool.SHOVEL, name: 'Shovel', icon: '', desc: 'Remove / place 1x1x1 standard blocks' },
  { type: 'tool', value: SpecialTool.SPOON, name: 'Spoon', icon: '', desc: 'Carve 8x8x8 micro voxels cell by cell' },
  { type: 'tool', value: SpecialTool.SELECTOR, name: 'Selector', icon: '', desc: 'Select and copy world/entity regions (max 64×64×64); no build action' },
  { type: 'tool', value: SpecialTool.HAMMER, name: 'Hammer', icon: '', desc: 'LMB build / attach to entity · RMB / Arrows rotate' },
  { type: 'tool', value: SpecialTool.WRENCH, name: 'Wrench', icon: '', desc: 'Show pivot XYZ axes · hold left-click to stop & lift · right-click to start' },
  { type: 'tool', value: SpecialTool.BRUSH, name: 'Brush', icon: '', desc: 'LMB paint · RMB 2-point dye · Tab micro/std' }
];

const EMPTY_SELECTOR: SelectorView = {
  micro: false,
  shape: 'box',
  title: 'Standard Selection',
  details: '',
  canAssemble: false,
  assembleLabel: 'Assemble (G)',
  canCopy: false,
  canDelete: false
};

const EMPTY_TELEMETRY: TelemetryView = {
  groundDistance: '0.00 m',
  altitude: '0.0 m',
  speed: '0.00 m/s',
  mass: '0.0 kg',
  powerPercent: 0,
  status: 'stopped',
  executionTime: '0.00 ms',
  logs: ['Terminal ready, waiting for script output...']
};

const EMPTY_WORLD_EDIT_SYNC: WorldEditSyncView = {
  pendingBatches: 0,
  pendingMutations: 0,
  sending: false,
  retrying: false,
  retryDelayMs: 0,
  acknowledgedBatches: 0,
  acknowledgedMutations: 0,
  backpressured: false,
  quota: null,
  blockedCode: null
};

function defaultCode(nodeId: string, node: any): string {
  if (node?.parentId === null) {
    return `// [root component controller]
// Unified API: self (every component has the same surface)
// Rigid body: self.applyForce([fx, fy, fz]), self.applyTorque([...])
// Drive children: self.child('child_name')
// Held key: ctx.input.down('KeyW')
// Edge: ctx.input.pressed('Space'), ctx.input.released('KeyW')

`;
  }
  return `// [${nodeId} child component controller]
// Unified API: self (every component has the same surface)
// Kinematics: self.setLocalPosition([x, y, z]), self.setLocalSpin(axis, rpm)
// Thrust: self.applyThrust([fx, fy, fz]) — direction decoupled from spin
// self.setLocalPosition([0, Math.sin(ctx.time * 2) * 0.5, 0]);
`;
}

function entityRootId(contraption: any): string {
  if (typeof contraption?.rootComponentId === 'string' && contraption.rootComponentId) {
    return contraption.rootComponentId;
  }
  for (const node of contraption?.entityNodes?.values?.() || []) {
    if (node?.parentId === null && typeof node.id === 'string') return node.id;
  }
  return '';
}

/**
 * Observable, DOM-free bridge between the simulation and React. The engine can
 * call its stable action surface while every visual update is rendered by
 * React components from immutable snapshots.
 */
export class SpaceUiStore {
  private listeners = new Set<Listener>();
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private bulkEditClearTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHudPublishAt = 0;
  private toastSequence = 0;
  private remotePlayers: any[] = [];
  private marketClient: SpaceMarketClient | null = null;
  private apiKeyClient: SpaceApiKeyClient | null = null;
  private queueCancelHandler: (() => Promise<void>) | null = null;
  private enterOnlineHandler: (() => void) | null = null;

  private snapshot: SpaceUiSnapshot = {
    revision: 0,
    controller: null,
    world: null,
    contraptions: null,
    sceneRenderer: null,
    navigationSystem: null,
    minimap: null,
    hasStarted: false,
    pointerLocked: false,
    activeModal: null,
    apiDocsOpen: false,
    agentSetupOpen: false,
    hotbarSlots: HOTBAR_SLOTS,
    selectedHotbarIndex: 0,
    selectedColor: normalizeColor(PRESET_COLORS[0]?.hex || '#f2a93b'),
    selectedColorIndex: 0,
    paletteColors: PRESET_COLORS.slice(0, 9).map(item => ({ hex: item.hex, name: item.name })),
    activeColorSetId: null,
    activeInventoryCategory: 'blockset',
    selectedInventoryIndex: 0,
    editingContraption: null,
    selectedComponentNodeId: '',
    scriptDraft: '',
    globalPlaybackState: 'play',
    agentMessages: [],
    agentBusy: false,
    agentConfig: loadAgentConfig(),
    builder: null,
    buildAgentMessages: [],
    buildAgentBusy: false,
    buildAgentSetupOpen: false,
    buildValidation: null,
    buildSourcePlan: null,
    builderJob: null,
    fpsText: '60 FPS',
    pingText: '-- ms',
    pingClass: 'hud-ping ping-unknown',
    positionText: 'X: -- | Y: -- | Z: --',
    nearbyEntities: [],
    selector: EMPTY_SELECTOR,
    brushMicro: false,
    bulkEdit: null,
    worldEditSync: EMPTY_WORLD_EDIT_SYNC,
    telemetry: EMPTY_TELEMETRY,
    fov: 75,
    perspective: 'first_person',
    cameraDistance: 4,
    worldShapeMode: DEFAULT_WORLD_SHAPE_MODE,
    renderDistance: 12,
    minimapEnabled: false,
    distantSurfaceSettings: { ...DEFAULT_DISTANT_SURFACE_SETTINGS },
    entityImpostorSettings: { ...DEFAULT_ENTITY_IMPOSTOR_SETTINGS },
    resolutionScaleMode: 'auto',
    resolutionScale: 1,
    resolutionPixelRatio: 1,
    resolutionEffectsQuality: 'full',
    resolutionTargetFps: 120,
    shadowsEnabled: true,
    lightingQuality: DEFAULT_LIGHTING_QUALITY,
    skinWarning: null,
    currentSkin: null,
    apiWorldId: null,
    toast: null,
    isAdmin: false,
    musicEnabled: false,
    effectsEnabled: true,
    sessionMode: 'online',
    queuePosition: null,
    onlineReady: false
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SpaceUiSnapshot => this.snapshot;

  private patch(partial: Partial<SpaceUiSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial, revision: this.snapshot.revision + 1 };
    for (const listener of this.listeners) listener();
  }

  refresh(): void {
    this.patch({});
  }

  setController(controller: any): void {
    let paletteColors = this.snapshot.paletteColors;
    try {
      const saved = localStorage.getItem('space_palette_colors');
      const parsed = saved ? JSON.parse(saved) : null;
      if (Array.isArray(parsed) && parsed.length >= 9) {
        paletteColors = parsed.slice(0, 9).map((item: any) => ({
          hex: colorToHex(normalizeColor(item.hex || item)),
          name: item.name || 'Custom'
        }));
      }
    } catch { }

    const fov = Number(controller?.fov || 75);
    const perspective = (controller?.perspective || 'first_person') as PlayerPerspective;
    const cameraDistance = Number(controller?.thirdPersonDistance || 4);
    this.patch({ controller, paletteColors, fov, perspective, cameraDistance });

    this.setBuildColor(paletteColors[0]?.hex || '#f2a93b', false);
    this.applyActiveSlot(false);
    this.syncInventoryState();

    try {
      const savedFov = localStorage.getItem('space_setting_fov');
      const savedPerspective = localStorage.getItem('space_setting_perspective') as PlayerPerspective | null;
      const savedDistance = localStorage.getItem('space_setting_cam_dist');
      const savedMusicEnabled = localStorage.getItem(MUSIC_ENABLED_SETTING_KEY);
      const savedEffectsEnabled = localStorage.getItem(EFFECTS_ENABLED_SETTING_KEY);
      const savedMuted = localStorage.getItem(LEGACY_MUTED_SETTING_KEY);
      if (savedFov) this.setFov(Number(savedFov), false);
      if (savedPerspective) this.setPerspective(savedPerspective, false);
      if (savedDistance) this.setCameraDistance(Number(savedDistance), false);

      const legacyEnabled = savedMuted === 'true' ? false : savedMuted === 'false' ? true : null;
      const musicEnabled = savedMusicEnabled === null
        ? (legacyEnabled ?? false)
        : storedBoolean(savedMusicEnabled, false);
      const effectsEnabled = savedEffectsEnabled === null
        ? (legacyEnabled ?? true)
        : storedBoolean(savedEffectsEnabled, true);
      this.setMusicEnabled(musicEnabled, false);
      this.setEffectsEnabled(effectsEnabled, false);

      // Preserve an explicit old preference once, then let the two new keys
      // evolve independently. An absent legacy key receives the new defaults.
      if (legacyEnabled !== null) {
        if (savedMusicEnabled === null) localStorage.setItem(MUSIC_ENABLED_SETTING_KEY, String(musicEnabled));
        if (savedEffectsEnabled === null) localStorage.setItem(EFFECTS_ENABLED_SETTING_KEY, String(effectsEnabled));
      }
    } catch { }
  }

  setAuthenticatedSession(apiOrigin: string, token: string, isAdmin = false, worldId: string | null = null, accountOrigin: string = apiOrigin): void {
    if (!token) {
      this.marketClient = null;
      this.apiKeyClient = null;
      this.patch({ isAdmin: false, apiWorldId: null });
      return;
    }
    this.marketClient = new SpaceMarketClient(apiOrigin, token);
    this.apiKeyClient = new SpaceApiKeyClient(accountOrigin, token, fetch, apiOrigin);
    this.patch({ isAdmin: !!isAdmin, apiWorldId: worldId });
  }

  setSessionState(
    mode: 'online' = 'online',
    queuePosition: number | null = null,
    cancelQueue: (() => Promise<void>) | null = null,
    onlineReady = false,
    enterOnline: (() => void) | null = null
  ): void {
    this.queueCancelHandler = cancelQueue;
    this.enterOnlineHandler = enterOnline;
    this.patch({ sessionMode: mode, queuePosition, onlineReady });
  }

  async cancelSpaceQueue(): Promise<void> {
    const cancel = this.queueCancelHandler;
    if (!cancel) return;
    try {
      await cancel();
    } catch {
      this.showToast('Failed to cancel queue. Please try again later.');
    }
  }

  enterOnlineSpace(): void {
    this.enterOnlineHandler?.();
  }

  getMarketClient(): SpaceMarketClient | null {
    return this.marketClient;
  }

  getApiKeyClient(): SpaceApiKeyClient | null {
    return this.apiKeyClient;
  }

  setWorld(world: any): void {
    let distantSurfaceSettings = normalizeDistantSurfaceSettings(
      world?.getDistantSurfaceSettings?.() || DEFAULT_DISTANT_SURFACE_SETTINGS,
    );
    try {
      const saved = localStorage.getItem('space_setting_distant_surface');
      if (saved) {
        const parsed = JSON.parse(saved);
        distantSurfaceSettings = world?.setDistantSurfaceSettings?.(parsed)
          || normalizeDistantSurfaceSettings(parsed);
      }
    } catch { }
    this.patch({
      world,
      renderDistance: Number(world?.renderDistance || 12),
      distantSurfaceSettings,
    });
    world?.setDistantSurfaceEnabled?.(this.snapshot.worldShapeMode !== 'earth');
    try {
      const saved = localStorage.getItem('space_setting_render_dist');
      if (saved) this.setRenderDistance(Number(saved), false);
    } catch { }
  }

  setContraptions(contraptions: any): void {
    this.patch({ contraptions });
  }

  setBuilder(builder: any): void {
    this.patch({ builder });
  }

  setBuilderJob(builderJob: SpaceBuilderJobStatus | null): void {
    this.patch({ builderJob });
    if (!builderJob) return;
    if (builderJob.phase === 'complete') {
      const result = builderJob.entityId
        ? `Entity created: ${builderJob.entityId}`
        : `${builderJob.changed.toLocaleString()} voxels changed`;
      this.showToast(`${builderJob.label} complete · ${result}`);
    } else if (builderJob.phase === 'failed') {
      this.showToast(`${builderJob.label} failed${builderJob.detail ? `: ${builderJob.detail}` : ''}`);
    }
  }

  setSceneRenderer(sceneRenderer: any): void {
    if (sceneRenderer) {
      sceneRenderer.onEntityPreviewNodeSelect = (nodeId: string) => this.selectComponentTreeNode(nodeId);
      sceneRenderer.onResolutionScaleChange = (state: any) => {
        this.patch(resolutionSnapshot(state));
      };
    }
    let setting: ResolutionScaleSetting = 'auto';
    let worldShapeMode = getWorldShapeMode();
    let shadowsEnabled = true;
    let lightingQuality = DEFAULT_LIGHTING_QUALITY;
    let entityImpostorSettings = normalizeEntityImpostorSettings(this.snapshot.entityImpostorSettings);
    try {
      setting = normalizeResolutionScaleSetting(localStorage.getItem('space_setting_resolution_scale'));
      worldShapeMode = normalizeWorldShapeMode(localStorage.getItem('space_setting_world_shape'));
      shadowsEnabled = localStorage.getItem('space_setting_shadows') !== 'false';
      lightingQuality = normalizeLightingQuality(localStorage.getItem(LIGHTING_QUALITY_SETTING_KEY));
    } catch { }
    try {
      const saved = localStorage.getItem(ENTITY_IMPOSTOR_SETTING_KEY);
      if (saved) entityImpostorSettings = normalizeEntityImpostorSettings(JSON.parse(saved));
    } catch { }
    entityImpostorSettings = sceneRenderer?.setEntityImpostorSettings?.(entityImpostorSettings) || entityImpostorSettings;
    setGlobalWorldShapeMode(worldShapeMode);
    sceneRenderer?.setWorldShapeMode?.(worldShapeMode);
    this.snapshot.world?.setDistantSurfaceEnabled?.(worldShapeMode !== 'earth');
    const state = sceneRenderer?.setResolutionScale?.(
      setting === 'auto' ? 'auto' : Number(setting)
    ) || sceneRenderer?.getResolutionScaleState?.();
    shadowsEnabled = sceneRenderer?.setShadowsEnabled?.(shadowsEnabled) ?? shadowsEnabled;
    lightingQuality = sceneRenderer?.setLightingQuality?.(lightingQuality) ?? lightingQuality;
    this.patch({
      sceneRenderer, worldShapeMode, shadowsEnabled, lightingQuality, entityImpostorSettings,
      ...resolutionSnapshot(sceneRenderer?.getResolutionScaleState?.() || state)
    });
  }

  setNavigationSystem(navigationSystem: any): void {
    this.patch({ navigationSystem });
  }

  setMinimap(minimap: any): void {
    let minimapEnabled = false;
    try {
      minimapEnabled = localStorage.getItem('space_setting_minimap') === 'true';
    } catch { }
    minimapEnabled = minimap?.setEnabled?.(minimapEnabled) ?? minimapEnabled;
    this.patch({ minimap, minimapEnabled });
  }

  setRemotePlayers(players: any[]): void {
    this.remotePlayers = Array.isArray(players) ? players : [];
    this.refresh();
  }

  startGame(): void {
    this.patch({ hasStarted: true });
    void this.snapshot.controller?.requestLock?.();
  }

  resumeFromCanvas(): void {
    const state = this.snapshot;
    if (state.hasStarted && !state.activeModal && !state.apiDocsOpen && !state.controller?.isLocked) {
      void state.controller?.requestLock?.();
    }
  }

  setPointerLocked(locked: boolean): void {
    this.patch({ pointerLocked: !!locked, hasStarted: locked ? true : this.snapshot.hasStarted });
  }

  hasAnyModalOpen(): boolean {
    return this.snapshot.activeModal !== null || this.snapshot.apiDocsOpen;
  }

  private saveCurrentDraft(): void {
    const { editingContraption, selectedComponentNodeId, scriptDraft } = this.snapshot;
    if (editingContraption && selectedComponentNodeId) {
      editingContraption.setNodeScript(selectedComponentNodeId, scriptDraft);
    }
  }

  closeAllModals(resumePointerLock = false): void {
    this.saveCurrentDraft();
    const { editingContraption, sceneRenderer, controller, builder } = this.snapshot;
    sceneRenderer?.setEntityPreviewTarget?.(null);
    editingContraption?.setHighlightedNode?.(null);
    builder?.clearPreview?.();
    this.patch({
      activeModal: null,
      apiDocsOpen: false,
      agentSetupOpen: false,
      buildAgentSetupOpen: false,
      buildValidation: null,
      buildSourcePlan: null
    });
    if (resumePointerLock) void controller?.requestLock?.();
    else controller?.unlock?.();
  }

  resolveDefaultInventoryCategory(): 'blockset' | 'entity' | 'colorset' {
    const activeTool = this.snapshot.controller?.activeTool
      || this.snapshot.hotbarSlots[this.snapshot.selectedHotbarIndex]?.value;
    if (activeTool === SpecialTool.BRUSH || activeTool === SpecialTool.PIPETTE) {
      return 'colorset';
    }
    if (activeTool === SpecialTool.WRENCH) {
      return 'entity';
    }
    // Shovel, Spoon, Selector, Hammer, and default tools map to block set
    return 'blockset';
  }

  private toggleModal(modal: Exclude<SpaceModal, null>, forceState: boolean | null = null): void {
    const open = forceState === null ? this.snapshot.activeModal !== modal : forceState;
    if (open) {
      if (modal === 'inventory') {
        const targetCategory = this.resolveDefaultInventoryCategory();
        this.snapshot.controller?.setActiveInventoryCategory?.(targetCategory);
        this.patch({ activeInventoryCategory: targetCategory });
      }
      this.patch({ activeModal: modal, apiDocsOpen: false });
      this.snapshot.controller?.unlock?.();
      if (modal === 'inventory') this.syncInventoryState();
    } else {
      if (modal === 'code') this.saveCurrentDraft();
      if (modal === 'builder') this.snapshot.builder?.clearPreview?.();
      this.patch({
        activeModal: null,
        agentSetupOpen: false,
        buildAgentSetupOpen: false,
        ...(modal === 'builder' ? { buildValidation: null, buildSourcePlan: null } : {})
      });
      this.snapshot.sceneRenderer?.setEntityPreviewTarget?.(null);
      this.snapshot.editingContraption?.setHighlightedNode?.(null);
      void this.snapshot.controller?.requestLock?.();
    }
  }

  toggleInventoryModal(forceState: boolean | null = null, defaultCategory?: 'blockset' | 'entity' | 'colorset'): void {
    if (forceState !== false && (forceState === true || this.snapshot.activeModal !== 'inventory')) {
      const targetCategory = defaultCategory || this.resolveDefaultInventoryCategory();
      this.snapshot.controller?.setActiveInventoryCategory?.(targetCategory);
      this.patch({ activeInventoryCategory: targetCategory });
    }
    this.toggleModal('inventory', forceState);
  }

  toggleGlobalSettingsModal(forceState: boolean | null = null): void {
    this.syncSettingsUI();
    this.toggleModal('settings', forceState);
  }

  toggleCodeEditorModal(forceState: boolean | null = null): void {
    this.toggleModal('code', forceState);
  }

  toggleBuildAssistant(forceState: boolean | null = null): void {
    this.toggleModal('builder', forceState);
  }

  toggleApiDocs(forceState: boolean | null = null): void {
    const open = forceState === null ? !this.snapshot.apiDocsOpen : forceState;
    this.patch({ apiDocsOpen: open });
    if (open) {
      // The reference modal covers the editor preview completely; suspend its
      // second WebGL context until the user returns to the editor.
      this.snapshot.sceneRenderer?.setEntityPreviewTarget?.(null);
      this.snapshot.controller?.unlock?.();
    } else if (this.snapshot.activeModal === 'code' && this.snapshot.editingContraption) {
      this.snapshot.sceneRenderer?.setEntityPreviewTarget?.(this.snapshot.editingContraption);
    } else {
      void this.snapshot.controller?.requestLock?.();
    }
  }

  handleEscape(): boolean {
    if (this.snapshot.apiDocsOpen) {
      this.toggleApiDocs(false);
      this.showToast('API docs closed');
      return true;
    }
    if (this.hasAnyModalOpen()) {
      this.closeAllModals(false);
      this.showToast('Panel closed · click the world to resume');
      return true;
    }
    return false;
  }

  showToast(
    message: unknown,
    options: { tone?: 'default' | 'warning'; durationMs?: number } = {}
  ): void {
    const toast = {
      id: ++this.toastSequence,
      message: String(message),
      tone: options.tone || 'default' as const,
    };
    this.patch({ toast });
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      if (this.snapshot.toast?.id === toast.id) this.patch({ toast: null });
    }, options.durationMs ?? 2800);
  }

  setCurrentSkin(url: string | null, model: 'strong' | 'slim'): void {
    this.patch({ currentSkin: url ? { url, model } : null });
  }

  setSkinWarning(message: string | null): void {
    this.patch({ skinWarning: message });
  }

  setBulkEditProgress(progress: BulkEditView | null): void {
    if (this.bulkEditClearTimer) {
      clearTimeout(this.bulkEditClearTimer);
      this.bulkEditClearTimer = null;
    }
    if (!progress) {
      this.patch({ bulkEdit: null });
      return;
    }

    const syncIdle = this.snapshot.worldEditSync.pendingBatches === 0
      && !this.snapshot.worldEditSync.sending;
    const next = progress.phase === 'syncing' && syncIdle
      ? { ...progress, phase: 'complete' as const }
      : { ...progress };
    this.patch({ bulkEdit: next });
    if (next.phase === 'complete' || next.phase === 'failed') this.scheduleBulkEditClear();
  }

  setWorldEditSync(status: Partial<WorldEditSyncView>): void {
    const previousBlockedCode = this.snapshot.worldEditSync.blockedCode;
    const worldEditSync = { ...EMPTY_WORLD_EDIT_SYNC, ...status };
    const current = this.snapshot.bulkEdit;
    const syncIdle = worldEditSync.pendingBatches === 0 && !worldEditSync.sending;
    const bulkEdit = current?.phase === 'syncing' && syncIdle
      ? { ...current, phase: 'complete' as const }
      : current;
    this.patch({ worldEditSync, bulkEdit });
    if (worldEditSync.blockedCode && worldEditSync.blockedCode !== previousBlockedCode) {
      const message = {
        TERRAIN_EDIT_QUOTA_REACHED: 'Terrain edit limit reached; queued changes will retry after reset',
        TERRAIN_BURST_QUOTA_REACHED: 'Terrain edits are arriving too quickly; syncing will retry',
        TERRAIN_WORLD_BUSY: 'The world is busy; queued terrain edits will retry',
        TERRAIN_EDIT_OUT_OF_RANGE: 'Move closer before editing this terrain',
        TERRAIN_PLAYER_POSITION_REQUIRED: 'Waiting for your position before syncing terrain edits',
        TERRAIN_PLAYER_POSITION_STALE: 'Refreshing your position before syncing terrain edits',
      }[worldEditSync.blockedCode];
      if (message) this.showToast(message);
    }
    if (bulkEdit?.phase === 'complete' && current?.phase !== 'complete') this.scheduleBulkEditClear();
  }

  private scheduleBulkEditClear(): void {
    if (this.bulkEditClearTimer) clearTimeout(this.bulkEditClearTimer);
    this.bulkEditClearTimer = setTimeout(() => {
      this.bulkEditClearTimer = null;
      if (this.snapshot.bulkEdit?.phase === 'complete' || this.snapshot.bulkEdit?.phase === 'failed') {
        this.patch({ bulkEdit: null });
      }
    }, 1_800);
  }

  setBuildColor(value: string | number, notify = true): void {
    const selectedColor = normalizeColor(value);
    const hex = colorToHex(selectedColor);
    if (this.snapshot.controller) this.snapshot.controller.selectedColor = selectedColor;
    const selectedColorIndex = this.snapshot.paletteColors.findIndex(item => item.hex.toLowerCase() === hex.toLowerCase());
    this.patch({
      selectedColor,
      selectedColorIndex: selectedColorIndex >= 0 ? selectedColorIndex : this.snapshot.selectedColorIndex
    });
    if (notify && this.snapshot.hasStarted) {
      const name = selectedColorIndex >= 0 ? this.snapshot.paletteColors[selectedColorIndex].name : '';
      this.showToast(`Palette: ${hex.toUpperCase()}${name ? ` (${name})` : ''}`);
    }
  }

  cycleColor(direction: number): void {
    const total = this.snapshot.paletteColors.length;
    if (!total) return;
    this.selectPresetColor((this.snapshot.selectedColorIndex + direction + total) % total);
  }

  setSelectorShape(shape: SelectorShape): void {
    if (this.snapshot.controller?.setSelectorShape) {
      this.snapshot.controller.setSelectorShape(shape);
    } else {
      this.patch({
        selector: {
          ...this.snapshot.selector,
          shape
        }
      });
    }
  }

  selectPresetColor(index: number): void {
    const item = this.snapshot.paletteColors[index];
    if (!item) return;
    this.patch({ selectedColorIndex: index });
    this.setBuildColor(item.hex);
  }

  openColorPicker(): void {
    this.snapshot.controller?.unlock?.();
    triggerColorPickerInput();
  }

  setPaletteColor(index: number, hex: string, notify = true): void {
    if (index < 0 || index >= this.snapshot.paletteColors.length) return;
    const safe = colorToHex(normalizeColor(hex));
    const paletteColors = this.snapshot.paletteColors.map((item, i) =>
      i === index ? { ...item, hex: safe } : item
    );
    this.patch({ paletteColors, selectedColorIndex: index });
    this.setBuildColor(safe, notify);
    try {
      localStorage.setItem('space_palette_colors', JSON.stringify(paletteColors));
    } catch { }

    const activeColorSetId = this.snapshot.activeColorSetId;
    if (activeColorSetId && this.snapshot.controller?.inventories?.colorset?.items) {
      const items = this.snapshot.controller.inventories.colorset.items;
      const found = items.find((item: any) => item && item.id === activeColorSetId);
      if (found && Array.isArray(found.colors)) {
        found.colors[index] = safe;
        this.snapshot.controller.saveInventoriesToLocalStorage?.();
      }
    }
  }

  getPaletteColors(): string[] {
    return this.snapshot.paletteColors.map(item => item.hex.toLowerCase());
  }

  applyColorSetToPalette(colorset: any): boolean {
    if (!colorset || !Array.isArray(colorset.colors)) return false;
    if (!colorset.id) {
      colorset.id = typeof globalThis.crypto?.randomUUID === 'function'
        ? `cs_${globalThis.crypto.randomUUID()}`
        : `cs_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }
    const paletteColors = colorset.colors.slice(0, 9).map((value: any) => ({
      hex: colorToHex(normalizeColor(value)),
      name: colorset.name || 'Custom'
    }));
    while (paletteColors.length < 9) paletteColors.push({ hex: '#f2a93b', name: 'Custom' });
    const selectedColorIndex = Math.min(this.snapshot.selectedColorIndex, paletteColors.length - 1);
    this.patch({ paletteColors, selectedColorIndex, activeColorSetId: colorset.id });
    this.setBuildColor(paletteColors[selectedColorIndex].hex, false);
    try { localStorage.setItem('space_palette_colors', JSON.stringify(paletteColors)); } catch { }
    return true;
  }

  savePaletteAsColorSet(): number | null {
    const name = `Palette ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const index = this.snapshot.controller?.addInventoryItem?.('colorset', { name, colors: this.getPaletteColors() });
    if (index === null || index === undefined) {
      this.showToast(`Color set inventory is full (${MAX_BACKPACK_SLOTS_PER_CATEGORY}) - delete one first`);
      return null;
    }
    this.showToast(`Added the current palette as color set ${index + 1}`);
    this.syncInventoryState();
    return index;
  }

  selectHotbarSlot(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.snapshot.hotbarSlots.length) return false;
    this.patch({ selectedHotbarIndex: index });
    this.applyActiveSlot();
    return true;
  }

  selectTool(tool: string): boolean {
    const index = this.snapshot.hotbarSlots.findIndex(slot => slot.value === tool);
    return index >= 0 ? this.selectHotbarSlot(index) : false;
  }

  selectPreviousTool(): void {
    const count = this.snapshot.hotbarSlots.length;
    const prev = (this.snapshot.selectedHotbarIndex - 1 + count) % count;
    this.selectHotbarSlot(prev);
  }

  selectNextTool(): void {
    const count = this.snapshot.hotbarSlots.length;
    const next = (this.snapshot.selectedHotbarIndex + 1) % count;
    this.selectHotbarSlot(next);
  }

  cycleHotbar(direction: number): void {
    const count = this.snapshot.hotbarSlots.length;
    this.selectHotbarSlot((this.snapshot.selectedHotbarIndex + direction + count) % count);
  }

  applyActiveSlot(notify = false): void {
    const controller = this.snapshot.controller;
    const slot = this.snapshot.hotbarSlots[this.snapshot.selectedHotbarIndex];
    if (!controller || !slot) return;
    const previous = controller.activeTool;
    if ((previous === SpecialTool.SELECTOR || previous === SpecialTool.SUPER_GLUE)
      && slot.value !== SpecialTool.SELECTOR && slot.value !== SpecialTool.SUPER_GLUE) {
      controller.clearSelection?.();
    }
    controller.activeTool = slot.value;
    controller.selectedBlock = null;
    this.patch({});
    if (notify) this.showToast(`Tool [${this.snapshot.selectedHotbarIndex + 1}]: ${slot.name} - ${slot.desc}`);
  }

  renderHotbar(): void { this.refresh(); }
  updateToolPanelMode(): void { this.refresh(); }

  syncInventoryState(): void {
    const controller = this.snapshot.controller;
    if (!controller) return;
    let activeInventoryCategory = controller.activeInventoryCategory || this.snapshot.activeInventoryCategory || 'blockset';
    if (activeInventoryCategory === 'colorset' && controller.activeTool === SpecialTool.HAMMER && this.snapshot.activeModal !== 'inventory') {
      controller.setActiveInventoryCategory?.('blockset');
      activeInventoryCategory = 'blockset';
    }
    let activeColorSetId = this.snapshot.activeColorSetId;
    if (!activeColorSetId) {
      const firstColorSet = controller.inventories?.colorset?.items?.find(Boolean);
      if (firstColorSet) {
        if (!firstColorSet.id) {
          firstColorSet.id = typeof globalThis.crypto?.randomUUID === 'function'
            ? `cs_${globalThis.crypto.randomUUID()}`
            : `cs_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        }
        activeColorSetId = firstColorSet.id;
      }
    }
    this.patch({
      activeInventoryCategory,
      selectedInventoryIndex: Number(controller.selectedInventoryIndex ?? 0),
      activeColorSetId
    });
  }

  renderInventory(): void { this.syncInventoryState(); }
  renderInventoryBar(): void { this.syncInventoryState(); }

  selectInventoryCategory(category: 'blockset' | 'entity' | 'colorset'): boolean {
    const controller = this.snapshot.controller;
    if (!controller) return false;
    controller.setActiveInventoryCategory?.(category);
    this.patch({ activeInventoryCategory: category });
    this.syncInventoryState();
    return true;
  }

  selectInventorySlot(index: number): boolean {
    const controller = this.snapshot.controller;
    const count = controller?.inventorySlots?.length || 0;
    if (!controller || !Number.isInteger(index) || index < 0 || index >= count) return false;
    controller.selectedInventoryIndex = index;
    const group = controller.inventoryCategory?.();
    if (group) group.selected = index;
    this.patch({ selectedInventoryIndex: index });
    return true;
  }

  inventoryProtobufFilename(name: unknown, fallback = 'backpack-item'): string {
    const safe = String(name || fallback).trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '').slice(0, 120) || fallback;
    return `${safe.replace(/\.(?:edpb|pb)$/i, '')}.edpb`;
  }

  downloadProtobuf(filename: string, data: Uint8Array | null | undefined): void {
    triggerProtobufDownload(filename, data);
  }

  importInventoryFile(category: 'blockset' | 'entity' | 'colorset', file: File | null): void {
    const controller = this.snapshot.controller;
    if (!file || !controller) return;
    if (file.size > MAX_INVENTORY_IMPORT_BYTES) {
      this.showToast(`Import failed: file exceeds ${Math.floor(MAX_INVENTORY_IMPORT_BYTES / (1024 * 1024))} MiB`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        this.showToast('Failed to read the Protobuf file');
        return;
      }
      const parsed = controller.parseInventoryImport(new Uint8Array(reader.result), category);
      if (!parsed.ok) {
        this.showToast(`Import failed: ${parsed.error}`);
        return;
      }
      const index = controller.addInventoryItem(category, parsed.item);
      if (index === null) {
        this.showToast(`${category} inventory is full (${MAX_BACKPACK_SLOTS_PER_CATEGORY}) - delete one first`);
        return;
      }
      controller.setActiveInventoryCategory(category);
      this.showToast(`Imported into ${category} slot ${index + 1}`);
      this.syncInventoryState();
    };
    reader.onerror = () => this.showToast('Failed to read the file');
    reader.readAsArrayBuffer(file);
  }

  renameInventoryItem(category: string, index: number, name: string): void {
    this.snapshot.controller?.renameInventoryItem?.(category, index, name);
    this.refresh();
  }

  copyInventoryItem(category: string, index: number): void {
    const controller = this.snapshot.controller;
    if (!controller) return;
    const group = controller.inventories?.[category];
    const source = group?.items?.[index];
    if (!source) return;
    const clone = JSON.parse(JSON.stringify(source));
    const baseName = controller.inventoryItemName?.(category, source, index) || source.name || 'Item';
    clone.name = `${baseName} (Copy)`;

    // Assign fresh unique IDs so copied items and entities never collide with originals
    const prefix = category === 'colorset' ? 'cs_' : category === 'blockset' ? 'bs_' : 'ent_';
    const newUniqueId = typeof globalThis.crypto?.randomUUID === 'function'
      ? `${prefix}${globalThis.crypto.randomUUID()}`
      : `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    clone.id = newUniqueId;
    if (clone.publicId !== undefined || category === 'entity') clone.publicId = newUniqueId;
    if (clone.contraptionId !== undefined) clone.contraptionId = newUniqueId;

    const newIndex = controller.addInventoryItem?.(category, clone);
    if (newIndex !== null && newIndex !== undefined && newIndex >= 0) {
      this.showToast(`Copied to slot ${newIndex + 1}`);
      this.syncInventoryState();
    } else {
      const capacity = Number(group?.items?.length) || MAX_BACKPACK_SLOTS_PER_CATEGORY;
      this.showToast(`Cannot copy: ${category} inventory is full (${capacity}/${capacity})`);
    }
  }

  deleteInventoryItem(category: string, index: number): void {
    if (category === 'colorset') {
      const items = this.snapshot.controller?.inventories?.colorset?.items || [];
      const nonNullCount = items.filter(Boolean).length;
      if (nonNullCount <= 1) {
        this.showToast('Cannot delete the only color set');
        return;
      }
    }
    const success = this.snapshot.controller?.deleteInventoryItem?.(category, index);
    if (category === 'colorset' && success) {
      const colorsets = this.snapshot.controller?.inventories?.colorset?.items || [];
      const firstAvailable = colorsets.find(Boolean);
      if (firstAvailable) {
        this.applyColorSetToPalette(firstAvailable);
      }
    }
    this.syncInventoryState();
  }

  swapInventorySlots(category: string, fromIndex: number, toIndex: number): void {
    const success = this.snapshot.controller?.swapInventorySlots?.(category, fromIndex, toIndex);
    if (success) {
      this.syncInventoryState();
    }
  }

  openCodeEditor(contraption: any): void {
    if (!contraption) return;
    const selectedComponentNodeId = entityRootId(contraption);
    const rootNode = contraption.getEntityNode?.(selectedComponentNodeId);
    const existing = contraption.getNodeScript?.(selectedComponentNodeId);
    const scriptDraft = existing || defaultCode(selectedComponentNodeId, rootNode);
    contraption.setHighlightedNode?.(selectedComponentNodeId);
    this.snapshot.sceneRenderer?.setEntityPreviewTarget?.(contraption);
    this.patch({
      editingContraption: contraption,
      selectedComponentNodeId,
      scriptDraft,
      activeModal: 'code',
      apiDocsOpen: false,
      agentMessages: [],
      agentBusy: false
    });
    this.snapshot.controller?.unlock?.();
    requestAnimationFrame(() => this.snapshot.sceneRenderer?.renderEntityPreview?.(contraption));
  }

  setScriptDraft(scriptDraft: string): void {
    const { editingContraption, selectedComponentNodeId } = this.snapshot;
    if (editingContraption) {
      editingContraption.nodeScripts?.set?.(selectedComponentNodeId, scriptDraft);
      if (selectedComponentNodeId === entityRootId(editingContraption)) editingContraption.scriptCode = scriptDraft;
    }
    this.patch({ scriptDraft });
  }

  selectComponentTreeNode(nodeId: string): void {
    const contraption = this.snapshot.editingContraption;
    if (!contraption) return;
    const targetId = String(nodeId || entityRootId(contraption));
    this.saveCurrentDraft();
    contraption.setHighlightedNode?.(targetId);
    const existing = contraption.getNodeScript?.(targetId);
    const scriptDraft = existing || defaultCode(targetId, contraption.getEntityNode?.(targetId));
    this.patch({ selectedComponentNodeId: targetId, scriptDraft });
    this.snapshot.sceneRenderer?.renderEntityPreview?.(contraption);
  }

  applyAndRunScript(): boolean {
    const { editingContraption, selectedComponentNodeId, scriptDraft } = this.snapshot;
    if (!editingContraption) return false;
    const success = editingContraption.setNodeScript(selectedComponentNodeId, scriptDraft);
    this.refresh();
    if (success) {
      const enabled = editingContraption.isNodeScriptEnabled(selectedComponentNodeId) ? 'ON' : 'OFF';
      this.showToast(`[${selectedComponentNodeId}] script updated · switch ${enabled}`);
    } else {
      const error = editingContraption.nodeScriptErrors?.get?.(selectedComponentNodeId) || editingContraption.scriptError;
      this.showToast(`Compile error: ${error}`);
    }
    return success;
  }

  async setGlobalPlayback(value: 'play' | 'stop'): Promise<void> {
    const contraption = this.snapshot.editingContraption;
    if (!contraption) return;
    if (contraption.serverManaged === true) {
      await this.snapshot.controller?.requestServerEntityRunState?.(contraption, value === 'play' ? 'running' : 'stopped');
      this.refresh();
      return;
    }
    const action = value === 'play' ? 'start-scripts' : 'stop-scripts';
    this.snapshot.contraptions?.performBasicAction?.({
      domain: ActionDomain.ENTITY,
      action,
      target: { contraption }
    });
    this.patch({ globalPlaybackState: value });
    this.snapshot.sceneRenderer?.renderEntityPreview?.(contraption);
    const message = value === 'play'
      ? 'STARTED: entity physics active; component scripts running'
      : 'STOPPED: physics disabled; PB defaults and construction pose restored';
    this.showToast(message);
  }

  getGlobalPlayback(): 'play' | 'stop' | null {
    const contraption = this.snapshot.editingContraption;
    if (!contraption) return null;
    if (contraption.isWrenchGrabbed || this.snapshot.controller?.wrenchGrab?.contraption === contraption) {
      return 'stop';
    }
    if (contraption.serverManaged && !contraption.serverExecutesLocally) {
      return contraption.serverDesiredRunState === 'running' ? 'play' : 'stop';
    }
    if (contraption.scriptStatus === 'stopped') {
      return 'stop';
    }
    return contraption.isPhysicsSimulationEnabled?.() === false ? 'stop' : 'play';
  }

  setSelectedComponentName(name: string): boolean {
    const { editingContraption, selectedComponentNodeId, contraptions } = this.snapshot;
    if (editingContraption?.serverManaged && !editingContraption.serverCanEdit) return false;
    const success = editingContraption?.setComponentName?.(selectedComponentNodeId, name) === true;
    if (success) {
      contraptions?.saveEntitiesToStorage?.();
      this.refresh();
      this.showToast('Component name updated');
    }
    return success;
  }

  renameSelectedComponent(newId: string): boolean {
    const { editingContraption, selectedComponentNodeId } = this.snapshot;
    if (!editingContraption) return false;
    if (selectedComponentNodeId === entityRootId(editingContraption)) {
      this.showToast('Renaming the entity root is not supported while it is in use');
      return false;
    }
    const normalized = newId.trim();
    if (!normalized) {
      this.showToast('Component id cannot be empty');
      return false;
    }
    const success = editingContraption.renameChildEntity(selectedComponentNodeId, normalized);
    if (success) {
      this.patch({ selectedComponentNodeId: normalized });
      this.showToast(`Component id updated: ${normalized}`);
    } else {
      this.showToast('Rename failed: id already exists or is invalid');
    }
    return success;
  }

  setSelectedBodyType(bodyType: string): void {
    const { editingContraption, selectedComponentNodeId } = this.snapshot;
    const result = this.snapshot.contraptions?.performBasicAction?.({
      domain: ActionDomain.PHYSICS,
      action: 'set-body-type',
      target: { contraption: editingContraption },
      nodeId: selectedComponentNodeId,
      bodyType
    });
    this.refresh();
    this.showToast(result?.ok ? `Rigid body: ${result.bodyType}` : 'Unable to change rigid body type');
  }

  setSelectedRestitution(value: number): void {
    const restitution = Math.max(0, Math.min(1, Number(value) || 0));
    const { editingContraption, selectedComponentNodeId } = this.snapshot;
    const result = this.snapshot.contraptions?.performBasicAction?.({
      domain: ActionDomain.PHYSICS,
      action: 'set-body-material',
      target: { contraption: editingContraption },
      nodeId: selectedComponentNodeId,
      material: { restitution }
    });
    this.refresh();
    this.showToast(result?.ok ? `Restitution: ${restitution.toFixed(2)}` : 'Unable to update restitution');
  }

  setSelectedFriction(value: number): void {
    const friction = Math.max(0, Math.min(1, Number(value) || 0));
    const { editingContraption, selectedComponentNodeId } = this.snapshot;
    const result = this.snapshot.contraptions?.performBasicAction?.({
      domain: ActionDomain.PHYSICS,
      action: 'set-body-material',
      target: { contraption: editingContraption },
      nodeId: selectedComponentNodeId,
      material: { friction }
    });
    this.refresh();
    this.showToast(result?.ok ? `Friction: ${friction.toFixed(2)}` : 'Unable to update friction');
  }

  setSelectedGravityEnabled(enabled: boolean): void {
    const { editingContraption, selectedComponentNodeId } = this.snapshot;
    const result = this.snapshot.contraptions?.performBasicAction?.({
      domain: ActionDomain.PHYSICS,
      action: 'set-body-gravity-enabled',
      target: { contraption: editingContraption },
      nodeId: selectedComponentNodeId,
      enabled
    });
    this.refresh();
    this.showToast(result?.ok ? `Gravity: ${enabled ? 'enabled' : 'disabled'}` : 'Unable to update gravity');
  }

  setSelectedCollisionEnabled(enabled: boolean): void {
    const { editingContraption, selectedComponentNodeId } = this.snapshot;
    const result = this.snapshot.contraptions?.performBasicAction?.({
      domain: ActionDomain.PHYSICS,
      action: 'set-body-collision-enabled',
      target: { contraption: editingContraption },
      nodeId: selectedComponentNodeId,
      enabled
    });
    this.refresh();
    this.showToast(result?.ok ? `Collision: ${enabled ? 'enabled' : 'disabled'}` : 'Unable to update collision');
  }

  setSelectedMass(mass: number): void {
    const { editingContraption, selectedComponentNodeId } = this.snapshot;
    const result = this.snapshot.contraptions?.performBasicAction?.({
      domain: ActionDomain.PHYSICS,
      action: 'set-body-mass',
      target: { contraption: editingContraption },
      nodeId: selectedComponentNodeId,
      mass: Number(mass)
    });
    this.refresh();
    this.showToast(result?.ok ? `Mass: ${result.mass.toFixed(1)} kg` : 'Mass must be greater than 0 kg');
  }

  notifyContraptionStructureChanged(contraption: any): void {
    if (!contraption || this.snapshot.editingContraption !== contraption) return;
    let selectedComponentNodeId = this.snapshot.selectedComponentNodeId;
    if (!contraption.entityNodes?.has?.(selectedComponentNodeId)) selectedComponentNodeId = entityRootId(contraption);
    const scriptDraft = contraption.getNodeScript?.(selectedComponentNodeId)
      || defaultCode(selectedComponentNodeId, contraption.getEntityNode?.(selectedComponentNodeId));
    this.patch({ selectedComponentNodeId, scriptDraft });
    this.snapshot.sceneRenderer?.renderEntityPreview?.(contraption);
  }

  notifyContraptionRemoved(contraption: any): void {
    if (!contraption || this.snapshot.editingContraption !== contraption) return;
    this.snapshot.sceneRenderer?.setEntityPreviewTarget?.(null);
    this.patch({ editingContraption: null, selectedComponentNodeId: '', scriptDraft: '', activeModal: null });
  }

  renderComponentTree(): void { this.refresh(); }
  renderCodeTabs(): void { this.refresh(); }
  updateInspectorProperties(nodeId?: string): void {
    if (nodeId && nodeId !== this.snapshot.selectedComponentNodeId) this.selectComponentTreeNode(nodeId);
    else this.refresh();
  }

  resetAgentChat(): void {
    this.patch({ agentMessages: [], agentBusy: false });
  }

  clearAgentChat(): void {
    this.patch({ agentMessages: [], agentBusy: false });
    this.showToast('AI chat history cleared');
  }

  toggleAgentSetup(forceState: boolean | null = null): void {
    const agentSetupOpen = forceState === null ? !this.snapshot.agentSetupOpen : forceState;
    this.patch({ agentSetupOpen });
  }

  saveAgentSettings(config: any): void {
    const normalized = normalizeAgentConfig(config);
    saveAgentConfig(normalized);
    this.patch({ agentConfig: normalized, agentSetupOpen: false, buildAgentSetupOpen: false });
    this.showToast(normalized.apiKey
      ? `Model config saved (${normalized.model}; key ${normalized.rememberApiKey ? 'remembered' : 'for this tab'})`
      : 'Saved (no key - local compiler will be used)');
  }

  toggleBuildAgentSetup(forceState: boolean | null = null): void {
    const buildAgentSetupOpen = forceState === null
      ? !this.snapshot.buildAgentSetupOpen
      : forceState;
    this.patch({ buildAgentSetupOpen });
  }

  clearBuildAgent(): void {
    this.snapshot.builder?.clearPreview?.();
    this.patch({
      buildAgentMessages: [],
      buildAgentBusy: false,
      buildValidation: null,
      buildSourcePlan: null
    });
  }

  async sendBuildAgentMessage(promptValue: string): Promise<void> {
    const prompt = String(promptValue || '').trim();
    const state = this.snapshot;
    if (!prompt || state.buildAgentBusy || !state.builder) return;

    state.builder.clearPreview?.();
    const messages: BuildAgentMessage[] = [
      ...state.buildAgentMessages,
      { role: 'user', content: prompt },
      { role: 'assistant', content: 'Generating a validated BuildPlan…', isStreaming: true }
    ];
    const assistantIndex = messages.length - 1;
    this.patch({
      buildAgentMessages: messages,
      buildAgentBusy: true,
      buildValidation: null
    });

    const ray = state.controller?.currentRaycast;
    const target = ray?.hitPos
      ? [Number(ray.hitPos.x.toFixed(2)), Number(ray.hitPos.y.toFixed(2)), Number(ray.hitPos.z.toFixed(2))]
      : null;
    const player = state.controller?.physics?.position;
    const context = {
      crosshairTarget: target,
      playerPosition: player ? [
        Number(player.x.toFixed(2)),
        Number(player.y.toFixed(2)),
        Number(player.z.toFixed(2))
      ] : null,
      palette: state.paletteColors.map(color => color.hex),
      previousPlan: state.buildSourcePlan || null
    };
    const history = state.buildAgentMessages.map(message => ({
      role: message.role,
      content: message.transportContent || message.content
    }));
    const updateStreaming = (chunk: any) => {
      const current = [...this.snapshot.buildAgentMessages];
      if (!current[assistantIndex]) return;
      current[assistantIndex] = {
        ...current[assistantIndex],
        content: 'Generating a validated BuildPlan…',
        reasoning: chunk.reasoning || ''
      };
      this.patch({ buildAgentMessages: current });
    };

    try {
      const { runSpaceBuildAgentTurn } = await import('../../../engine/building/BuildAgent.ts');
      const result: any = await runSpaceBuildAgentTurn(
        prompt,
        state.agentConfig,
        history,
        context,
        null,
        updateStreaming
      );
      const current = [...this.snapshot.buildAgentMessages];
      if (!result.ok) {
        current[assistantIndex] = {
          role: 'assistant',
          content: `[!] ${result.error}`,
          reasoning: result.reasoning || '',
          isStreaming: false
        };
        this.patch({ buildAgentMessages: current });
        return;
      }

      const validation: SpaceBuildValidation = state.builder.preview(result.plan);
      if (!validation.ok) {
        current[assistantIndex] = {
          role: 'assistant',
          content: `BuildPlan rejected:\n${validation.errors.map(error => `• ${error}`).join('\n')}`,
          reasoning: result.reasoning || '',
          transportContent: result.content || '',
          isStreaming: false
        };
        this.patch({ buildAgentMessages: current, buildValidation: validation, buildSourcePlan: result.plan });
        return;
      }

      const summary = validation.summary;
      const bounds = summary.bounds?.size.map(value => Number(value.toFixed(1))).join(' × ') || '0 × 0 × 0';
      current[assistantIndex] = {
        role: 'assistant',
        content: [
          `${summary.name} is ready to preview.`,
          `${summary.kind === 'entity' ? 'Entity' : 'Structure'} · ${summary.voxelCount.toLocaleString()} voxels`,
          `Bounds ${bounds} m${summary.componentCount > 1 ? ` · ${summary.componentCount} components` : ''}`
          + `${summary.scriptCount ? ` · ${summary.scriptCount} scripts` : ''}`
          + `${summary.constraintCount ? ` · ${summary.constraintCount} constraints` : ''}`,
          'Review the hologram, then confirm construction.'
        ].join('\n'),
        reasoning: result.reasoning || '',
        transportContent: result.content || '',
        isStreaming: false
      };
      this.patch({ buildAgentMessages: current, buildValidation: validation, buildSourcePlan: result.plan });
    } catch (error: any) {
      const current = [...this.snapshot.buildAgentMessages];
      current[assistantIndex] = {
        role: 'assistant',
        content: `Build assistant failed: ${error?.message || String(error)}`,
        isStreaming: false
      };
      this.patch({ buildAgentMessages: current });
    } finally {
      this.patch({ buildAgentBusy: false });
    }
  }

  confirmBuildPlan(): void {
    const result = this.snapshot.builder?.commit?.();
    if (!result?.ok) {
      this.showToast(`Unable to start build: ${result?.reason || 'invalid plan'}`);
      return;
    }
    this.patch({ buildValidation: null, buildSourcePlan: null });
    this.showToast(`Build queued: ${result.jobId}`);
  }

  cancelBuildPreview(): void {
    this.snapshot.builder?.clearPreview?.();
    this.patch({ buildValidation: null, buildSourcePlan: null });
  }

  cancelBuilderJob(): void {
    const result = this.snapshot.builder?.cancel?.(this.snapshot.builderJob?.id || null);
    this.showToast(result?.ok ? 'Cancelling build and rolling back changes' : 'No active build to cancel');
  }

  undoLastBuild(): void {
    const result = this.snapshot.builder?.undo?.();
    this.showToast(result?.ok ? 'Undo queued' : 'Nothing is available to undo');
    if (result?.ok && !result.jobId) this.patch({ builderJob: null });
  }

  async sendAgentMessage(promptValue: string): Promise<void> {
    const prompt = promptValue.trim();
    const state = this.snapshot;
    if (!prompt || state.agentBusy || !state.editingContraption) return;
    const targetId = state.selectedComponentNodeId || entityRootId(state.editingContraption);
    const targetNode = state.editingContraption.entityNodes?.get?.(targetId);
    const messages: AgentMessage[] = [...state.agentMessages, { role: 'user', content: prompt }];
    const assistantIndex = messages.length;
    messages.push({ role: 'assistant', content: '', reasoning: '', isStreaming: true, targetId });
    this.patch({ agentMessages: messages, agentBusy: true });

    const history = state.agentMessages
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .map(message => ({ role: message.role, content: message.content }));
    const targetContext = {
      id: targetId,
      parentId: targetNode?.parentId ?? null,
      entityId: state.editingContraption.publicId || `Entity #${state.editingContraption.id}`,
      runtimeId: state.editingContraption.id,
      allComponents: [...(state.editingContraption.entityNodes?.keys?.() || [])].sort(compareComponentIds),
      mode: state.editingContraption.mode,
      blockCount: state.editingContraption.blocks?.filter?.((block: any) => String(block.entityId ?? entityRootId(state.editingContraption)) === targetId).length || 0,
      totalBlockCount: state.editingContraption.blocks?.length || 0
    };

    const updateStreaming = (chunk: any) => {
      const current = [...this.snapshot.agentMessages];
      if (!current[assistantIndex]) return;
      current[assistantIndex] = { ...current[assistantIndex], content: chunk.content, reasoning: chunk.reasoning };
      this.patch({ agentMessages: current });
    };

    try {
      const { runAgentTurn } = await import('../../../engine/contraption/AgentChat.ts');
      const result: any = await runAgentTurn(prompt, state.agentConfig, history, null, targetContext, updateStreaming);
      const current = [...this.snapshot.agentMessages];
      current[assistantIndex] = result.ok
        ? {
          role: 'assistant',
          content: result.content || (result.code ? 'Controller code generated.' : ''),
          reasoning: result.reasoning || '',
          code: result.code || null,
          targetId: result.code ? targetId : null,
          isStreaming: false
        }
        : { role: 'assistant', content: `[!] ${result.error}`, isStreaming: false };
      this.patch({ agentMessages: current });
    } catch (error: any) {
      const current = [...this.snapshot.agentMessages];
      current[assistantIndex] = { role: 'assistant', content: `Chat failed: ${error?.message || String(error)}`, isStreaming: false };
      this.patch({ agentMessages: current });
    } finally {
      this.patch({ agentBusy: false });
    }
  }

  applyAgentCode(code: string, targetNodeId?: string, silent = false): void {
    const contraption = this.snapshot.editingContraption;
    if (!contraption) return;
    this.saveCurrentDraft();
    const targetId = String(targetNodeId || entityRootId(contraption));
    contraption.mode = ContraptionMode.PROGRAMMABLE;
    const success = contraption.setNodeScript(targetId, code);
    contraption.setHighlightedNode?.(targetId);
    this.patch({ selectedComponentNodeId: targetId, scriptDraft: code });
    this.snapshot.sceneRenderer?.renderEntityPreview?.(contraption);
    if (success) {
      if (!silent) this.showToast(`AI code applied to [${targetId}]`);
    } else {
      const error = contraption.nodeScriptErrors?.get?.(targetId) || contraption.scriptError;
      this.showToast(`Code compile failed: ${error}`);
    }
  }

  syncSettingsUI(): void {
    const { controller, world, sceneRenderer, minimap } = this.snapshot;
    if (!controller) return;
    const musicEnabled = controller.sound?.getMusicEnabled?.() ?? this.snapshot.musicEnabled;
    const effectsEnabled = controller.sound?.getEffectsEnabled?.() ?? this.snapshot.effectsEnabled;
    const resolution = resolutionSnapshot(sceneRenderer?.getResolutionScaleState?.());
    this.patch({
      fov: Number(controller.fov || 75),
      perspective: controller.perspective || 'first_person',
      cameraDistance: Number(controller.thirdPersonDistance || 4),
      worldShapeMode: sceneRenderer?.getWorldShapeMode?.() || getWorldShapeMode(),
      renderDistance: Number(world?.renderDistance || this.snapshot.renderDistance),
      distantSurfaceSettings: normalizeDistantSurfaceSettings(
        world?.getDistantSurfaceSettings?.() || this.snapshot.distantSurfaceSettings,
      ),
      entityImpostorSettings: normalizeEntityImpostorSettings(
        sceneRenderer?.getEntityImpostorSettings?.() || this.snapshot.entityImpostorSettings,
      ),
      minimapEnabled: minimap?.isEnabled?.() ?? this.snapshot.minimapEnabled,
      shadowsEnabled: sceneRenderer?.getShadowsEnabled?.() ?? this.snapshot.shadowsEnabled,
      lightingQuality: sceneRenderer?.getLightingQuality?.() ?? this.snapshot.lightingQuality,
      ...resolution,
      musicEnabled,
      effectsEnabled
    });
  }

  private applySoundSetting(method: 'setMusicEnabled' | 'setEffectsEnabled', value: boolean): void {
    const game = typeof window !== 'undefined' ? (window as any).game : (globalThis as any).game;
    const targets = new Set<any>([
      this.snapshot.controller?.sound,
      game?.soundManager
    ].filter(Boolean));
    for (const sound of targets) {
      sound?.[method]?.(value);
    }
  }

  setMusicEnabled(enabled: boolean, persist = true): void {
    const value = Boolean(enabled);
    this.applySoundSetting('setMusicEnabled', value);
    this.patch({ musicEnabled: value });
    if (persist) {
      try { localStorage.setItem(MUSIC_ENABLED_SETTING_KEY, String(value)); } catch { }
      this.showToast(value ? 'Background Music On' : 'Background Music Off');
    }
  }

  toggleMusic(): void {
    this.setMusicEnabled(!this.snapshot.musicEnabled);
  }

  setEffectsEnabled(enabled: boolean, persist = true): void {
    const value = Boolean(enabled);
    this.applySoundSetting('setEffectsEnabled', value);
    this.patch({ effectsEnabled: value });
    if (persist) {
      try { localStorage.setItem(EFFECTS_ENABLED_SETTING_KEY, String(value)); } catch { }
      this.showToast(value ? 'Sound Effects On' : 'Sound Effects Off');
    }
  }

  toggleEffects(): void {
    this.setEffectsEnabled(!this.snapshot.effectsEnabled);
  }

  setFov(fov: number, persist = true): void {
    const value = Math.max(50, Math.min(110, Number(fov) || 75));
    this.snapshot.controller?.setFov?.(value);
    this.patch({ fov: value });
    if (persist) try { localStorage.setItem('space_setting_fov', String(value)); } catch { }
  }

  setPerspective(perspective: PlayerPerspective, persist = true): void {
    this.snapshot.controller?.setPerspective?.(perspective);
    this.patch({ perspective });
    if (persist) try { localStorage.setItem('space_setting_perspective', perspective); } catch { }
  }

  setCameraDistance(distance: number, persist = true): void {
    const value = Math.max(2, Math.min(8, Number(distance) || 4));
    this.snapshot.controller?.setThirdPersonDistance?.(value);
    this.patch({ cameraDistance: value });
    if (persist) try { localStorage.setItem('space_setting_cam_dist', String(value)); } catch { }
  }

  setWorldShapeMode(mode: WorldShapeMode, persist = true): void {
    const value = normalizeWorldShapeMode(mode);
    setGlobalWorldShapeMode(value);
    this.snapshot.sceneRenderer?.setWorldShapeMode?.(value);
    this.snapshot.world?.setDistantSurfaceEnabled?.(value !== 'earth');
    this.patch({ worldShapeMode: value });
    if (persist) {
      try { localStorage.setItem('space_setting_world_shape', value); } catch { }
      this.showToast(value === 'earth' ? 'Earth mode enabled' : 'Donut mode enabled');
    }
  }

  setRenderDistance(distance: number, persist = true): void {
    const value = Math.max(4, Math.min(20, Number(distance) || 12));
    this.snapshot.world?.setRenderDistance?.(value);
    this.patch({ renderDistance: value });
    if (persist) try { localStorage.setItem('space_setting_render_dist', String(value)); } catch { }
  }

  setMinimapEnabled(enabled: boolean, persist = true): void {
    const value = this.snapshot.minimap?.setEnabled?.(Boolean(enabled)) ?? Boolean(enabled);
    this.patch({ minimapEnabled: value });
    if (persist) try { localStorage.setItem('space_setting_minimap', String(value)); } catch { }
  }

  setDistantSurfaceSetting(
    key: DistantSurfaceSettingKey,
    setting: number | boolean,
    persist = true,
  ): void {
    const candidate = { ...this.snapshot.distantSurfaceSettings, [key]: setting };
    const value = this.snapshot.world?.setDistantSurfaceSettings?.(candidate)
      || normalizeDistantSurfaceSettings(candidate);
    this.patch({ distantSurfaceSettings: value });
    if (persist) {
      try { localStorage.setItem('space_setting_distant_surface', JSON.stringify(value)); } catch { }
    }
  }

  setEntityImpostorSetting(key: keyof EntityImpostorSettings, setting: number, persist = true): void {
    const candidate = normalizeEntityImpostorSettings({ ...this.snapshot.entityImpostorSettings, [key]: setting });
    const value = this.snapshot.sceneRenderer?.setEntityImpostorSettings?.(candidate) || candidate;
    this.patch({ entityImpostorSettings: value });
    if (persist) {
      try { localStorage.setItem(ENTITY_IMPOSTOR_SETTING_KEY, JSON.stringify(value)); } catch { }
    }
  }

  resetEntityImpostorSettings(): void {
    const value = this.snapshot.sceneRenderer?.setEntityImpostorSettings?.(DEFAULT_ENTITY_IMPOSTOR_SETTINGS)
      || { ...DEFAULT_ENTITY_IMPOSTOR_SETTINGS };
    this.patch({ entityImpostorSettings: value });
    try { localStorage.setItem(ENTITY_IMPOSTOR_SETTING_KEY, JSON.stringify(value)); } catch { }
  }

  resetDistantSurfaceSettings(): void {
    const value = this.snapshot.world?.setDistantSurfaceSettings?.(
      DEFAULT_DISTANT_SURFACE_SETTINGS,
    ) || normalizeDistantSurfaceSettings(DEFAULT_DISTANT_SURFACE_SETTINGS);
    this.patch({ distantSurfaceSettings: value });
    try { localStorage.setItem('space_setting_distant_surface', JSON.stringify(value)); } catch { }
    this.showToast('Distant terrain LOD restored to recommended defaults');
  }

  setResolutionScale(setting: ResolutionScaleSetting | number, persist = true): void {
    const mode = normalizeResolutionScaleSetting(setting);
    const state = this.snapshot.sceneRenderer?.setResolutionScale?.(
      mode === 'auto' ? 'auto' : Number(mode)
    );
    this.patch(state
      ? resolutionSnapshot(state)
      : {
        resolutionScaleMode: mode,
        resolutionScale: mode === 'auto' ? this.snapshot.resolutionScale : Number(mode),
        resolutionPixelRatio: this.snapshot.resolutionPixelRatio,
        resolutionEffectsQuality: this.snapshot.resolutionEffectsQuality
      });
    if (persist) {
      try { localStorage.setItem('space_setting_resolution_scale', mode); } catch { }
    }
  }

  setShadowsEnabled(enabled: boolean, persist = true): void {
    const value = this.snapshot.sceneRenderer?.setShadowsEnabled?.(Boolean(enabled))
      ?? Boolean(enabled);
    this.patch({ shadowsEnabled: value });
    if (persist) {
      try { localStorage.setItem('space_setting_shadows', String(value)); } catch { }
      this.showToast(value ? 'Shadows enabled' : 'Shadows disabled');
    }
  }

  setLightingQuality(quality: LightingQuality, persist = true): void {
    const normalized = normalizeLightingQuality(quality);
    const value = this.snapshot.sceneRenderer?.setLightingQuality?.(normalized) ?? normalized;
    this.patch({ lightingQuality: value });
    if (persist) {
      try { localStorage.setItem(LIGHTING_QUALITY_SETTING_KEY, value); } catch { }
      this.showToast(`Lighting quality: ${LIGHTING_PRESETS[value].label}`);
    }
  }

  private buildSelectorView(): SelectorView {
    const { controller, contraptions } = this.snapshot;
    const micro = controller?.selectorMicroMode === true;
    const shape: SelectorShape = controller?.selectorShape || 'box';
    const view: SelectorView = { ...EMPTY_SELECTOR, micro, shape, title: micro ? 'Micro Selection' : 'Standard Selection' };
    if (!contraptions) return view;
    const child = contraptions.getChildSelectionInfo?.();
    const worldSelection = contraptions.getWorldGlueSelectionInfo?.();
    const worldActive = worldSelection && (worldSelection.mode === 'single' || worldSelection.pointCount > 0);
    if (child) {
      return {
        micro,
        shape,
        title: 'Entity Component Selection',
        details: `Entity #${child.contraption.id} [${child.parentId}] · ${child.count} cells · Shift multi-select · G create child · R copy${child.existingChildCount > 0 ? ` · ${child.existingChildCount} children attached` : ''}`,
        canAssemble: !!child.ready,
        assembleLabel: 'Create Child (G)',
        canCopy: true,
        canDelete: true
      };
    }
    if (controller?.selectedSubtree?.contraption) {
      const { contraption, rootId } = controller.selectedSubtree;
      return {
        micro,
        shape,
        title: rootId === entityRootId(contraption) ? 'Entity Selected' : 'Component Selected',
        details: `Entity #${contraption.id} [${rootId}] · Del delete · R copy`,
        canAssemble: false,
        assembleLabel: 'Assemble (G)',
        canCopy: true,
        canDelete: true
      };
    }
    if (controller?.selectedBlockSelection?.blocks?.length > 0) {
      const { nodeId, blocks } = controller.selectedBlockSelection;
      return {
        micro,
        shape,
        title: 'Component Blocks Selected',
        details: `[${nodeId}] · ${blocks.length} blocks · Del delete`,
        canAssemble: false,
        assembleLabel: 'Assemble (G)',
        canCopy: false,
        canDelete: true
      };
    }
    if (worldActive) {
      const isMicro = worldSelection.granularity === 'micro';
      let details = '';
      if (worldSelection.mode === 'single') {
        details = `${isMicro ? 'Micro single-select' : 'Single-select'} · ${worldSelection.count} cells · Shift+click toggle · Tab ${isMicro ? 'standard' : 'micro'} · R copy · Del delete`;
      } else if (worldSelection.ready) {
        const bounds = contraptions.getSelectionBounds?.();
        details = bounds
          ? `Box [2/2] · ${bounds.maxX - bounds.minX + 1}x${bounds.maxY - bounds.minY + 1}x${bounds.maxZ - bounds.minZ + 1} (${worldSelection.count} cells) · G assemble · R copy · Del delete`
          : `Box [2/2] · ${worldSelection.count} cells · G assemble · R copy · Del delete`;
      } else {
        details = `${isMicro ? 'Micro box' : 'Box'} [${worldSelection.pointCount}/2] · preview ${worldSelection.count} cells · need ${2 - worldSelection.pointCount} more clicks`;
      }
      return {
        micro,
        shape,
        title: isMicro ? (worldSelection.mode === 'box' ? 'World Micro Box Selection' : 'World Micro-Cell Selection') : (worldSelection.mode === 'single' ? 'World Single-Cell Selection' : 'World 3-Point Box Selection'),
        details,
        canAssemble: !!worldSelection.ready,
        assembleLabel: 'Assemble (G)',
        canCopy: !!worldSelection.ready,
        canDelete: !!worldSelection.ready || (worldSelection.mode === 'single' && worldSelection.count > 0)
      };
    }
    if (contraptions.hasValidSelection?.()) {
      const count = contraptions.getSelectionBlockCount?.() || 0;
      const bounds = contraptions.getSelectionBounds?.();
      return {
        micro,
        shape,
        title: 'Selection Ready',
        details: bounds
          ? `Region: ${bounds.maxX - bounds.minX + 1}x${bounds.maxY - bounds.minY + 1}x${bounds.maxZ - bounds.minZ + 1} (${count} blocks) · G assemble · R copy`
          : `Selected structure (${count} blocks) · G assemble · R copy`,
        canAssemble: true,
        assembleLabel: 'Assemble (G)',
        canCopy: true,
        canDelete: true
      };
    }
    return view;
  }

  updateHUD(fps: number, playerPos: any, _raycast: any, _hoveredContraption: any, pingMs: number | null = null): void {
    const { contraptions, sceneRenderer, controller, editingContraption, activeModal } = this.snapshot;
    const isEntity = Boolean(controller?.selectedBlockSelection || controller?.selectedSubtree);
    if (isEntity) {
      const isShape = controller?.selectorShape && controller.selectorShape !== 'box';
      const shapeCells = controller?.selectedBlockSelection?.shapeCells;
      const bounds = controller?.selectedBlockSelection?.bounds;
      const contraption = controller.selectedBlockSelection?.contraption || controller.selectedSubtree?.contraption;
      const nodeId = controller.selectedBlockSelection?.nodeId || controller.selectedSubtree?.rootId;
      const node = contraption?.entityNodes?.get?.(nodeId);
      const frame = node?.group ? { object: node.group, pivot: (node.pivotLocal || new THREE.Vector3()).clone() } : null;
      if (isShape && Array.isArray(shapeCells) && shapeCells.length > 0) {
        if (controller.selectorMicroMode) {
          sceneRenderer?.updateSelectionHologram?.(bounds, null, shapeCells, true, frame);
        } else {
          sceneRenderer?.updateSelectionHologram?.(bounds, shapeCells, null, false, frame);
        }
      } else if (bounds) {
        sceneRenderer?.updateSelectionHologram?.(bounds, null, null, controller.selectorMicroMode === true, frame);
      } else {
        // Whole-entity (subtree) selection has no block bounds of its own. Clear
        // the hologram so a box left over from a previous world/block selection
        // cannot linger and clip through the entity.
        sceneRenderer?.updateSelectionHologram?.(null, null, null);
      }
    } else {
      const isMicroShape = Boolean(
        controller?.selectorMicroMode && controller?.selectorShape && controller.selectorShape !== 'box'
      );
      sceneRenderer?.updateSelectionHologram?.(
        contraptions?.getSelectionBounds?.(),
        contraptions?.connectedSelection,
        contraptions?.microSelection,
        isMicroShape
      );
    }

    const now = performance.now();
    if (this.lastHudPublishAt !== 0 && now - this.lastHudPublishAt < 100) return;
    this.lastHudPublishAt = now;

    const entities: NearbyEntityItem[] = [];
    const addEntity = (id: string | number, name: string, position: any, type: string) => {
      let dx = wrapX(position.x) - wrapX(playerPos.x);
      if (dx > TORUS_SIZE_X / 2) dx -= TORUS_SIZE_X;
      else if (dx < -TORUS_SIZE_X / 2) dx += TORUS_SIZE_X;
      let dz = wrapZ(position.z) - wrapZ(playerPos.z);
      if (dz > TORUS_SIZE_Z / 2) dz -= TORUS_SIZE_Z;
      else if (dz < -TORUS_SIZE_Z / 2) dz += TORUS_SIZE_Z;
      entities.push({ id, name, pos: { x: position.x, y: position.y, z: position.z }, dist: Math.hypot(dx, position.y - playerPos.y, dz), type });
    };
    for (const contraption of contraptions?.contraptions || []) {
      if (contraption?.position) addEntity(contraption.id, contraption.getComponentName?.() || contraption.rootComponentId || `Entity #${contraption.id}`, contraption.position, contraption.bodyType || 'dynamic');
    }
    for (const player of this.remotePlayers) {
      if (!player.is_self) addEntity(String(player.user_id || player.player_entity_id), `Player: ${player.username || 'Player'}`, player, 'player');
    }
    entities.sort((a, b) => a.dist - b.dist);

    let telemetry = this.snapshot.telemetry;
    if (activeModal === 'code' && editingContraption) {
      const powerPercent = Math.round(Math.min(1, Math.max(0, editingContraption.powerUtilization || 0)) * 100);
      telemetry = {
        groundDistance: `${(editingContraption.groundDistance || 0).toFixed(2)} m`,
        altitude: `${editingContraption.position.y.toFixed(1)} m`,
        speed: `${editingContraption.velocity.length().toFixed(2)} m/s`,
        mass: `${editingContraption.mass.toFixed(1)} kg`,
        powerPercent,
        status: editingContraption.scriptStatus || 'stopped',
        executionTime: `${(editingContraption.lastExecutionTimeMs || 0).toFixed(2)} ms`,
        logs: editingContraption.scriptLogs?.length ? [...editingContraption.scriptLogs].map(String) : ['No log output yet...']
      };
    }

    const roundedPing = typeof pingMs === 'number' && Number.isFinite(pingMs) && pingMs >= 0 ? Math.max(1, Math.round(pingMs)) : null;
    this.patch({
      fpsText: `${Math.round(fps)} FPS`,
      pingText: roundedPing === null ? '-- ms' : `${roundedPing} ms`,
      pingClass: roundedPing === null ? 'hud-ping ping-unknown' : `hud-ping ${roundedPing < 80 ? 'ping-good' : roundedPing < 180 ? 'ping-medium' : 'ping-poor'}`,
      positionText: `X: ${playerPos.x.toFixed(1)} | Y: ${playerPos.y.toFixed(1)} | Z: ${playerPos.z.toFixed(1)}`,
      nearbyEntities: entities,
      selector: this.buildSelectorView(),
      brushMicro: Boolean(controller?.brushMicroMode),
      telemetry,
      activeInventoryCategory: controller?.activeInventoryCategory || this.snapshot.activeInventoryCategory,
      selectedInventoryIndex: Number(controller?.selectedInventoryIndex ?? this.snapshot.selectedInventoryIndex)
    });
  }
}

export const spaceUiStore = new SpaceUiStore();
