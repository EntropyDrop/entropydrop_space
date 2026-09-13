import React, { useEffect, useState } from 'react';
import {
  LiaCubeSolid,
  LiaUtensilSpoonSolid,
  LiaPaintBrushSolid,
  LiaVectorSquareSolid,
  LiaHammerSolid,
  LiaWrenchSolid,
  LiaCogSolid,
  LiaHomeSolid,
  LiaAngleLeftSolid,
  LiaAngleRightSolid,
  LiaAngleDownSolid,
  LiaExchangeAltSolid,
  LiaShapesSolid,
  LiaBoxesSolid,
  LiaRobotSolid
} from 'react-icons/lia';
import { ContraptionMode } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { colorToHex } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { TbBox, TbCylinder, TbSphere, TbStairs, TbLine } from 'react-icons/tb';
import { SpecialTool } from '../../../engine/controls/PlayerController.ts';
import type { SelectorShape } from '../../../engine/controls/SelectorShapes.ts';
import { InventoryThumbnailRenderer } from '../../../engine/render/InventoryThumbnailRenderer.ts';
import { spaceUiStore } from '../store/SpaceUiStore.ts';
import { useSpaceUi } from '../store/useSpaceUi.ts';
import { getAltKeyLabel } from '../../../bootstrap/SpaceBootstrap.ts';

import { LuShovel } from "react-icons/lu";

function getHotbarToolIcon(toolValue: string): React.ReactNode {
  switch (toolValue) {
    case SpecialTool.SHOVEL:
      return <LuShovel size={20} className="slot-pixel-icon" aria-hidden="true" />;
    case SpecialTool.SPOON:
      return <LiaUtensilSpoonSolid size={20} className="slot-pixel-icon" aria-hidden="true" />;
    case SpecialTool.BRUSH:
      return <LiaPaintBrushSolid size={20} className="slot-pixel-icon" aria-hidden="true" />;
    case SpecialTool.SELECTOR:
      return <LiaVectorSquareSolid size={20} className="slot-pixel-icon" aria-hidden="true" />;
    case SpecialTool.HAMMER:
      return <LiaHammerSolid size={20} className="slot-pixel-icon" aria-hidden="true" />;
    case SpecialTool.WRENCH:
      return <LiaWrenchSolid size={20} className="slot-pixel-icon" aria-hidden="true" />;
    default:
      return <LiaCubeSolid size={20} className="slot-pixel-icon" aria-hidden="true" />;
  }
}

function NearbyEntities() {
  const { nearbyEntities, navigationSystem } = useSpaceUi(state => state);
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 3;
  const pageCount = Math.max(1, Math.ceil(nearbyEntities.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const rows = nearbyEntities.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  return (
    <div className="hud-entities-section" id="hud-entities-section">
      <div
        className="hud-entities-header"
        id="hud-entities-toggle"
        role="button"
        tabIndex={-1}
        title="Toggle nearby entities list"
        onClick={() => setExpanded(value => !value)}
        onKeyDown={event => {
          if (event.key === 'Enter') setExpanded(value => !value);
        }}
      >
        <div className="hud-entities-title">
          <span className="hud-entities-icon"><LiaShapesSolid size={14} /></span>
          <span>Nearby Entities (<span id="hud-entities-count">{nearbyEntities.length}</span>)</span>
        </div>
        <button
          type="button"
          id="hud-entities-toggle-btn"
          tabIndex={-1}
          className={`hud-entities-toggle-btn ${expanded ? 'expanded' : ''}`}
          aria-label="Toggle entities list"
          onClick={event => {
            event.stopPropagation();
            setExpanded(value => !value);
          }}
        >
          <LiaAngleDownSolid style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }} />
        </button>
      </div>
      <div className="hud-entities-body" id="hud-entities-body" style={{ display: expanded ? 'flex' : 'none' }}>
        <div className="hud-entities-list" id="hud-entities-list">
          {rows.length === 0 ? <div className="hud-entity-empty">No entities detected nearby</div> : rows.map(item => (
            <div className="hud-entity-item" key={`${item.type}:${item.id}`}>
              <div className="hud-entity-info">
                <div className="hud-entity-name" title={item.name}>{item.name}</div>
                <div className="hud-entity-meta">
                  <span className="hud-entity-pos">X:{item.pos.x.toFixed(0)} Y:{item.pos.y.toFixed(0)} Z:{item.pos.z.toFixed(0)}</span>
                  <span className="hud-entity-dist">{item.dist < 1000 ? `${item.dist.toFixed(1)}m` : `${(item.dist / 1000).toFixed(2)}km`}</span>
                </div>
              </div>
              <button
                type="button"
                tabIndex={-1}
                className="hud-entity-nav-btn"
                title={`Navigate to ${item.name}`}
                onClick={() => navigationSystem?.startNavigation?.(item.pos.x, Math.max(item.pos.y + 1.5, 20), item.pos.z)}
              >NAV</button>
            </div>
          ))}
        </div>
        <div className="hud-entities-pagination" id="hud-entities-pagination" style={{ display: pageCount > 1 ? 'flex' : 'none' }}>
          <button type="button" id="hud-entities-prev-btn" tabIndex={-1} className="hud-page-btn" disabled={currentPage <= 1} title="Previous page" onClick={() => setPage(value => Math.max(1, value - 1))}>
            <LiaAngleLeftSolid />
          </button>
          <span id="hud-entities-page-info" className="hud-page-info">{currentPage} / {pageCount}</span>
          <button type="button" id="hud-entities-next-btn" tabIndex={-1} className="hud-page-btn" disabled={currentPage >= pageCount} title="Next page" onClick={() => setPage(value => Math.min(pageCount, value + 1))}>
            <LiaAngleRightSolid />
          </button>
        </div>
      </div>
    </div>
  );
}

function PaletteBar({ isBrush = false }: { isBrush?: boolean }) {
  const { paletteColors, selectedColorIndex, brushMicro, controller } = useSpaceUi(state => state);
  const altLabel = getAltKeyLabel();
  return (
    <div className="color-palette-bar-wrapper" id="color-palette-wrapper">
      <div className="palette-info-row">
        {isBrush ? (
          <div className="selector-title-group">
            <span className="palette-title flex items-center gap-1">
              <LiaPaintBrushSolid size={14} style={{ display: 'inline', verticalAlign: 'text-bottom' }} /> Brush
            </span>
            <button
              id="brush-mode-toggle"
              type="button"
              tabIndex={-1}
              className="selector-mode-btn"
              title="Click or press Tab to switch mode"
              onClick={() => controller?.toggleBrushMicroMode?.()}
            >
              <span id="brush-mode-badge" className={`mode-badge ${brushMicro ? 'micro' : 'std'}`}>
                {brushMicro ? 'MICRO' : 'STANDARD'}
              </span>
              <span className="mode-tab-hint flex items-center gap-0.5">
                Tab <LiaExchangeAltSolid style={{ display: 'inline' }} />
              </span>
            </button>
          </div>
        ) : (
          <span className="palette-title flex items-center gap-1">
            <LiaPaintBrushSolid size={14} style={{ display: 'inline', verticalAlign: 'text-bottom' }} /> Palette
          </span>
        )}
        <span className="palette-hotkey-hint">
          {isBrush ? (
            <><b>LMB</b> paint · <b>RMB</b> sample · <b>I</b> set color</>
          ) : (
            <><b>{altLabel}+1~9</b> pick · <b>I</b> set color</>
          )}
        </span>
      </div>
      <div id="color-palette-bar" className="color-palette-bar">
        {paletteColors.map((item, index) => {
          const isActive = index === selectedColorIndex;
          return (
            <button
              type="button"
              tabIndex={-1}
              key={`${item.hex}:${index}`}
              id={isActive ? 'active-palette-color-chip' : undefined}
              className={`color-chip ${isActive ? 'active' : ''}`}
              style={{ backgroundColor: item.hex }}
              title={`${item.name || 'Custom'} (${item.hex.toUpperCase()}) · ${altLabel}+${index + 1}${isActive ? ' · I to set color' : ''}`}
              onClick={() => {
                if (isActive) {
                  spaceUiStore.openColorPicker();
                } else {
                  spaceUiStore.selectPresetColor(index);
                }
              }}
            >
              <span className="chip-num">{index + 1}</span>
              {isActive && (
                <input
                  id="active-color-picker-input"
                  type="color"
                  className="palette-color-picker-input"
                  value={item.hex}
                  tabIndex={-1}
                  aria-label={`Set color for slot ${index + 1}`}
                  onChange={e => spaceUiStore.setPaletteColor(index, e.target.value, true)}
                  onInput={e => spaceUiStore.setPaletteColor(index, (e.target as HTMLInputElement).value, false)}
                  onClick={e => e.stopPropagation()}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function InventoryBar() {
  const { controller, activeInventoryCategory, selectedInventoryIndex } = useSpaceUi(state => state);
  const category = activeInventoryCategory === 'entity' ? 'entity' : 'blockset';
  const items = controller?.inventories?.[category]?.items || [];
  const renderer = InventoryThumbnailRenderer.getInstance();
  return (
    <div className="inventory-bar-wrapper" id="inventory-bar-wrapper">
      <div className="palette-info-row">
        <div className="palette-title-group">
          <button type="button" tabIndex={-1} className="palette-title" id="backpack-bar-title" title="Click or press E to open full backpack" onClick={() => spaceUiStore.toggleInventoryModal(true)}>
            <LiaBoxesSolid size={14} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 3 }} />Backpack
          </button>
          <div id="inv-cat-tabs" className="inv-cat-tabs">
            {(['blockset', 'entity'] as const).map(key => (
              <button type="button" tabIndex={-1} key={key} className={`inv-cat-tab ${category === key ? 'active' : ''}`} onClick={() => spaceUiStore.selectInventoryCategory(key)}>{key === 'blockset' ? 'BKS' : 'ENT'}</button>
            ))}
          </div>
        </div>
        <span className="palette-hotkey-hint"><b>E</b> Full Backpack · <b>Tab</b> BKS↔ENT · <b>Arrows/RMB</b> Rotate{category === 'entity' ? <> · <b>LMB</b> Auto-attach</> : null}</span>
      </div>
      <div id="inventory-bar" className="inventory-bar">
        {Array.from({ length: 9 }, (_, index) => {
          const item = items[index];
          const count = item?.blockCount || item?.blocks?.length || 0;
          const name = item ? controller?.inventoryItemName?.(category, item, index) || item.name || `Slot ${index + 1}` : '';
          const thumbnail = item ? renderer.getThumbnail(item, 64) : null;
          return (
            <button
              type="button"
              tabIndex={-1}
              key={index}
              className={`inventory-slot ${selectedInventoryIndex === index ? 'active' : ''} ${item ? 'filled' : 'empty'}`}
              title={item ? `Slot ${index + 1}: "${name}" · ${count} blocks · Shift+${index + 1}` : `Slot ${index + 1}: empty · Shift+${index + 1}`}
              onClick={() => spaceUiStore.selectInventorySlot(index)}
            >
              {thumbnail ? <img className="inv-slot-thumb" src={thumbnail} alt={name} draggable={false} /> : null}
              {item ? <span className="inv-slot-count">{count}</span> : <span className="inv-slot-empty">-</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function getSelectorShapeItems() {
  const altLabel = getAltKeyLabel();
  return [
    { id: 'box' as const, name: '长方体 (Box)', shortcut: `${altLabel}+1`, icon: TbBox },
    { id: 'cylinder' as const, name: '圆柱 (Cylinder)', shortcut: `${altLabel}+2`, icon: TbCylinder },
    { id: 'sphere' as const, name: '球体/圆 (Sphere)', shortcut: `${altLabel}+3`, icon: TbSphere },
    { id: 'stairs' as const, name: '阶梯 (Stairs)', shortcut: `${altLabel}+4`, icon: TbStairs },
    { id: 'line' as const, name: '线条 (Line)', shortcut: `${altLabel}+5`, icon: TbLine },
  ];
}

function SelectorPanel() {
  const { selector, controller, selectedColor } = useSpaceUi(state => state);
  const activeHex = colorToHex(selectedColor ?? 0xf2a93b);
  const altLabel = getAltKeyLabel();
  const selectorShapeItems = getSelectorShapeItems();

  return (
    <div className="selector-panel-wrapper" id="selector-panel-wrapper">
      <div className="palette-info-row">
        <div className="selector-title-group">
          <span className="palette-title">Selector</span>
          <button id="selector-mode-toggle" tabIndex={-1} className="selector-mode-btn" title="Click or press Tab to switch mode" onClick={() => controller?.toggleSelectorMicroMode?.()}>
            <span id="selector-mode-badge" className={`mode-badge ${selector.micro ? 'micro' : 'std'}`}>{selector.micro ? 'MICRO' : 'STANDARD'}</span>
            <span className="mode-tab-hint flex items-center gap-0.5">Tab <LiaExchangeAltSolid style={{ display: 'inline' }} /></span>
          </button>
          <div className="selector-recent-color" id="selector-recent-color" title={`Recent Color: ${activeHex.toUpperCase()} · Click to pick · ${altLabel}+1~9 · Press I to set color`}>
            <label className="selector-recent-color-chip" style={{ backgroundColor: activeHex }}>
              <input
                id="selector-color-picker-input"
                type="color"
                value={activeHex}
                onChange={event => spaceUiStore.setBuildColor(event.target.value)}
              />
            </label>
            <span className="selector-recent-color-hex">{activeHex.toUpperCase()}</span>
          </div>
        </div>
        <span className="palette-hotkey-hint"><b>{altLabel}+1~5</b> shape · <b>Arrows</b> rotate · <b>F</b> fill · <b>P</b> recolor</span>
      </div>
      <div className="selector-toolbox-content" id="selector-toolbox-content">
        <div className="selector-shapes-bar" id="selector-shapes-bar" role="group" aria-label="Selection Shape">
          {selectorShapeItems.map(item => {
            const Icon = item.icon;
            const isActive = (selector.shape || 'box') === item.id;
            return (
              <button
                key={item.id}
                type="button"
                id={`selector-shape-${item.id}`}
                tabIndex={-1}
                className={`selector-shape-btn ${isActive ? 'active' : ''}`}
                title={`${item.name} · ${item.shortcut}`}
                aria-label={`${item.name} · ${item.shortcut}`}
                onClick={() => spaceUiStore.setSelectorShape(item.id)}
              >
                <Icon size={15} className="shape-icon" />
              </button>
            );
          })}
        </div>
        <div className="selector-action-buttons">
          <button id="assemble-btn" tabIndex={-1} className="banner-btn primary" disabled={!selector.canAssemble} onClick={() => controller?.assembleSelection?.(ContraptionMode.PROGRAMMABLE)}>{selector.assembleLabel}</button>
          <button id="fill-btn" tabIndex={-1} className="banner-btn secondary" title={`Fill selection with ${activeHex.toUpperCase()} (F)`} disabled={!selector.canDelete} onClick={() => controller?.fillSelectionBlocks?.()}>
            <span className="btn-color-dot" style={{ backgroundColor: activeHex }} />
            Fill (F)
          </button>
          <button id="paint-btn" tabIndex={-1} className="banner-btn secondary" title={`Recolor selection with ${activeHex.toUpperCase()} (P)`} disabled={!selector.canDelete} onClick={() => controller?.paintSelectionBlocks?.()}>
            <span className="btn-color-dot" style={{ backgroundColor: activeHex }} />
            Paint (P)
          </button>
          <button id="copy-btn" tabIndex={-1} className="banner-btn secondary" title="Copy selection to backpack (R)" disabled={!selector.canCopy} onClick={() => controller?.copySelectionSmart?.()}>Copy (R)</button>
          <button id="delete-btn" tabIndex={-1} className="banner-btn danger" title="Delete selection (Del)" disabled={!selector.canDelete} onClick={() => controller?.deleteSelectionBlocks?.()}>Delete (Del)</button>
        </div>
      </div>
    </div>
  );
}

function WrenchPanel() {
  const { controller } = useSpaceUi(state => state);
  return (
    <div className="selector-panel-wrapper wrench-panel-wrapper" id="wrench-panel-wrapper">
      <div className="palette-info-row">
        <div className="selector-title-group">
          <span className="palette-title flex items-center gap-1">
            <LiaWrenchSolid size={14} style={{ display: 'inline', verticalAlign: 'text-bottom' }} /> Wrench
          </span>
          <span className="mode-badge std">PHYSICS & CONTROL</span>
        </div>
        <span className="palette-hotkey-hint"><b>XYZ</b> pivot · <b>Hold LMB</b> stop & lift · <b>RMB</b> start</span>
      </div>
      <div className="selector-toolbox-content" id="wrench-toolbox-content">
        <div className="wrench-action-buttons">
          <button type="button" tabIndex={-1} className="banner-btn secondary" title="Hold left-click on an entity to stop and lift it (LMB)" onClick={() => controller?.startWrenchGrab?.()}><b>LMB</b> Stop & Lift</button>
          <button type="button" tabIndex={-1} className="banner-btn secondary" title="Right-click on an entity to start physics and scripts (RMB)" onClick={() => controller?.startHoveredEntity?.()}><b>RMB</b> Start</button>
          <button type="button" tabIndex={-1} className="banner-btn secondary" title="Point at an entity and press C to open its code editor" onClick={() => controller?.openCodeEditorForTarget?.()}><b>C</b> Code</button>
          <button type="button" tabIndex={-1} className="banner-btn secondary" title="Point at a seat block and press V to mount/drive" onClick={() => controller?.toggleDriveVehicle?.()}><b>V</b> Drive</button>
        </div>
      </div>
    </div>
  );
}

function Hotbar() {
  const { hotbarSlots, selectedHotbarIndex, selector, brushMicro } = useSpaceUi(state => state);
  return (
    <div id="hotbar">
      {hotbarSlots.map((slot, index) => (
        <button type="button" tabIndex={-1} key={slot.value} className={`hotbar-slot ${index === selectedHotbarIndex ? 'active' : ''}`} onClick={() => spaceUiStore.selectHotbarSlot(index)}>
          <span className="slot-num">{index + 1}</span>
          <span className="slot-icon">{getHotbarToolIcon(slot.value)}</span>
          <span className="slot-name">{slot.name}</span>
          {slot.value === SpecialTool.SELECTOR ? (
            <span className={`slot-mode-badge ${selector.micro ? 'micro' : 'std'}`}>{selector.micro ? 'MICRO' : 'STD'}</span>
          ) : slot.value === SpecialTool.BRUSH ? (
            <span className={`slot-mode-badge ${brushMicro ? 'micro' : 'std'}`}>{brushMicro ? 'MICRO' : 'STD'}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function BulkEditProgressPanel() {
  const { bulkEdit, worldEditSync } = useSpaceUi(state => state);
  if (!bulkEdit) return null;

  const percent = bulkEdit.total > 0
    ? Math.min(100, Math.round((bulkEdit.processed / bulkEdit.total) * 100))
    : 100;
  const phaseLabel = bulkEdit.phase === 'waiting'
    ? 'SERVER BACKPRESSURE'
    : bulkEdit.phase === 'syncing'
      ? 'SYNCING'
      : bulkEdit.phase === 'complete'
        ? 'COMPLETE'
        : bulkEdit.phase === 'failed'
          ? 'FAILED'
          : 'APPLYING';
  const syncIdle = worldEditSync.pendingBatches === 0 && !worldEditSync.sending;
  const syncText = worldEditSync.retrying
    ? `${worldEditSync.blockedCode === 'TERRAIN_EDIT_QUOTA_REACHED' ? 'Edit limit reached' : 'Retrying'} in ${Math.max(1, Math.ceil(worldEditSync.retryDelayMs / 1_000))}s · ${worldEditSync.pendingBatches} batches queued`
    : worldEditSync.backpressured
      ? `Queue paused · ${worldEditSync.pendingBatches} batches / ${worldEditSync.pendingMutations} edits pending`
      : syncIdle
        ? 'Server synced'
        : `Server sync · ${worldEditSync.pendingBatches} batches / ${worldEditSync.pendingMutations} edits pending`;
  const quotaText = worldEditSync.quota
    ? `${worldEditSync.quota.remainingToday.toLocaleString()} / ${worldEditSync.quota.dailyLimit.toLocaleString()} daily edits remaining`
    : null;

  return (
    <div className={`bulk-edit-progress phase-${bulkEdit.phase}`} role="status" aria-live="polite">
      <div className="bulk-edit-heading">
        <span>{bulkEdit.label}</span>
        <span className="bulk-edit-phase">{phaseLabel}</span>
      </div>
      <div className="bulk-edit-row">
        <span className="bulk-edit-row-label">Local</span>
        <div className="bulk-edit-track"><span style={{ width: `${percent}%` }} /></div>
        <span className="bulk-edit-value">{bulkEdit.processed.toLocaleString()} / {bulkEdit.total.toLocaleString()} · {percent}%</span>
      </div>
      <div className="bulk-edit-row">
        <span className="bulk-edit-row-label">Sync</span>
        <div className={`bulk-edit-track sync ${syncIdle ? 'idle' : 'active'}`}><span /></div>
        <span className="bulk-edit-value">{syncText}</span>
      </div>
      {quotaText ? <div className="bulk-edit-detail">{quotaText}</div> : null}
      {bulkEdit.detail ? <div className="bulk-edit-detail">{bulkEdit.detail}</div> : null}
    </div>
  );
}

export function Hud() {
  const state = useSpaceUi(snapshot => snapshot);
  const activeTool = state.hotbarSlots[state.selectedHotbarIndex]?.value;
  return (
    <>
      <div id="crosshair" />
      <div id="hud-overlay">
        <div className="hud-top">
          <div className="hud-card">
            <div className="hud-badge"><span className="hud-badge-dot" />EntropyDrop · Space <span className="hud-beta-badge">BETA</span></div>
            <div className="hud-metrics-row"><span id="fps-val">{state.fpsText}</span><span className="hud-metric-sep">·</span><span id="ping-val" className={state.pingClass}>{state.pingText}</span></div>
            <div id="pos-val">{state.positionText}</div>
            <NearbyEntities />
          </div>
          <div className="hud-actions">
            <button
              id="ai-builder-btn"
              type="button"
              tabIndex={-1}
              className="icon-btn ai-builder-hud-btn"
              title="AI Builder (Natural Language Construction)"
              onClick={() => spaceUiStore.toggleBuildAssistant(true)}
            >
              <span className="ai-builder-pulse-dot" />
              <LiaRobotSolid size={16} className="ai-builder-icon" />
              <span className="ai-builder-label">AI BUILD</span>
            </button>
            <button
              id="home-btn"
              type="button"
              tabIndex={-1}
              className="icon-btn"
              title="Home (H)"
              onClick={() => { window.location.href = '/'; }}
            >
              <LiaHomeSolid size={18} />
            </button>
            <button
              id="global-settings-btn"
              type="button"
              tabIndex={-1}
              className="icon-btn"
              title="Global Settings (O)"
              onClick={() => spaceUiStore.toggleGlobalSettingsModal(true)}
            >
              <LiaCogSolid size={18} />
            </button>
          </div>
        </div>
        <div className="hud-bottom">
          <div className="hud-bottom-stack">
            <BulkEditProgressPanel />
            <div className="builder-toolbar">
              <div className="toolbar-center-panel">
                {activeTool === SpecialTool.HAMMER ? (
                  <InventoryBar />
                ) : activeTool === SpecialTool.SELECTOR ? (
                  <SelectorPanel />
                ) : activeTool === SpecialTool.WRENCH ? (
                  <WrenchPanel />
                ) : (
                  <PaletteBar isBrush={activeTool === SpecialTool.BRUSH} />
                )}
                <Hotbar />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div
        id="toast"
        className={`toast ${state.toast ? `show ${state.toast.tone}` : ''}`}
        role={state.toast?.tone === 'warning' ? 'alert' : 'status'}
      >
        {state.toast?.message || ''}
      </div>
    </>
  );
}
