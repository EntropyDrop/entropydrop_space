// UI ports expose only the engine surface consumed by React and its store.
import type { PlayerController } from '../../../engine/controls/PlayerController.ts';
import type { World } from '@entropydrop/space-engine/voxel/World.ts';
import type { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import type { SceneRenderer } from '../../../engine/render/SceneRenderer.ts';
import type { NavigationSystem } from '../../NavigationSystem.ts';
import type { Minimap } from '../../Minimap.ts';

export type UiPlayerController = Pick<PlayerController,
  'activeInventoryCategory'
  | 'activeTool'
  | 'addInventoryItem'
  | 'brushMicroMode'
  | 'canEditEntityInternals'
  | 'canUseSelectionActions'
  | 'clearSelection'
  | 'copySelectionSmart'
  | 'deleteInventoryItem'
  | 'deleteSelectionBlocks'
  | 'encodeInventoryItem'
  | 'fillSelectionBlocks'
  | 'fov'
  | 'getSelectorSelectAllTarget'
  | 'hoveredContraption'
  | 'hoveredContraptionHit'
  | 'importBlockSetToInventory'
  | 'inventories'
  | 'inventoryCategory'
  | 'inventoryItemName'
  | 'inventorySlots'
  | 'isDriving'
  | 'isLocked'
  | 'modeling'
  | 'openCodeEditorForTarget'
  | 'paintSelectionBlocks'
  | 'parseInventoryImport'
  | 'performEntityMenuAction'
  | 'perspective'
  | 'physics'
  | 'releaseWrenchGrab'
  | 'renameInventoryItem'
  | 'requestLock'
  | 'requestServerEntityRunState'
  | 'rotateSelection'
  | 'saveInventoriesToLocalStorage'
  | 'selectAllSelectionBlocks'
  | 'selectedBlock'
  | 'selectedBlockSelection'
  | 'selectedColor'
  | 'selectedGradientStops'
  | 'selectedInventoryIndex'
  | 'selectedMaterialId'
  | 'selectedSubtree'
  | 'selectorMicroMode'
  | 'selectorShape'
  | 'setActiveInventoryCategory'
  | 'setFov'
  | 'setPerspective'
  | 'setSelectorShape'
  | 'setThirdPersonDistance'
  | 'setWorldPickingSuspended'
  | 'sound'
  | 'startWrenchGrab'
  | 'swapInventorySlots'
  | 'thirdPersonDistance'
  | 'toggleBrushMicroMode'
  | 'toggleDriveVehicle'
  | 'toggleSelectorMicroMode'
  | 'unlock'
  | 'wrenchGrab'
>;

export type UiWorld = Pick<World,
  'distantSurface'
  | 'getDistantSurfaceSettings'
  | 'getTerrainAoiLoadProgress'
  | 'preloadTerrainAoi'
  | 'renderDistance'
  | 'setDistantSurfaceEnabled'
  | 'setDistantSurfaceSettings'
  | 'setRenderDistance'
>;

export type UiContraptionManager = Pick<ContraptionManager,
  'connectedSelection'
  | 'contraptions'
  | 'getChildSelectionInfo'
  | 'getSelectionBlockCount'
  | 'getSelectionBounds'
  | 'getWorldGlueSelectionInfo'
  | 'hasValidSelection'
  | 'microSelection'
  | 'performBasicAction'
  | 'saveEntitiesToStorage'
  | 'selectionBoxConfirmed'
  | 'worldName'
  | 'worldSlug'
>;

export type UiSceneRenderer = Pick<SceneRenderer,
  'captureCleanScreenshotPng'
  | 'getLightingQuality'
  | 'getResolutionScaleState'
  | 'getShadowsEnabled'
  | 'onEntityPreviewNodeSelect'
  | 'onResolutionScaleChange'
  | 'renderEntityPreview'
  | 'setEntityPreviewCanvas'
  | 'setEntityPreviewTarget'
  | 'setLightingQuality'
  | 'setResolutionScale'
  | 'setShadowsEnabled'
  | 'subscribeWorldOverlay'
  | 'updateSelectionHologram'
>;

export type UiNavigationSystem = Pick<NavigationSystem,
  'isNavigating'
  | 'startFromInputValues'
  | 'startNavigation'
  | 'stopNavigation'
  | 'target'
>;

export type UiMinimap = Pick<Minimap,
  'attachCanvas'
  | 'isEnabled'
  | 'setEnabled'
>;
