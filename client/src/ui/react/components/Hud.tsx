import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EntityContextMenu, EntityNameplates } from './EntityMenus.tsx';
import { HostedEntities } from './HostedEntities.tsx';
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
  LiaRobotSolid,
  LiaEyeDropperSolid
} from 'react-icons/lia';
import { ContraptionMode } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { colorToHex } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { gradientCss, MAX_GRADIENT_STOPS, normalizePaletteEntry } from '@entropydrop/space-engine/voxel/Palette.ts';
import { TbBox, TbCylinder, TbSphere, TbStairs, TbLine } from 'react-icons/tb';
import { SpecialTool } from '../../../engine/controls/PlayerController.ts';
import type { SelectorShape } from '../../../engine/controls/SelectorShapes.ts';
import { InventoryThumbnailRenderer } from '../../../engine/render/InventoryThumbnailRenderer.ts';
import { spaceUiStore } from '../store/SpaceUiStore.ts';
import { useSpaceUi } from '../store/useSpaceUi.ts';
import { getAltKeyLabel } from '../../../bootstrap/SpaceBootstrap.ts';
import { selectorMenuPosition } from '../utils/selectorMenuPosition.ts';
import { SiDiscord } from 'react-icons/si';
import { formatByteRate } from '../../../bootstrap/NetworkTraffic.ts';

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

function hexToHsv(hex: string) {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

function hsvToHex(h: number, s: number, v: number) {
  const chroma = v * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - chroma;
  const sector = Math.floor((h % 360) / 60);
  const rgb = [
    [chroma, x, 0], [x, chroma, 0], [0, chroma, x],
    [0, x, chroma], [x, 0, chroma], [chroma, 0, x],
  ][sector] || [chroma, x, 0];
  return `#${rgb.map(channel => Math.round((channel + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function PaletteEditor() {
  const { paletteColors, selectedColorIndex, paletteEditorOpen } = useSpaceUi(state => state);
  const [activeStop, setActiveStop] = useState(0);
  const [draggedStop, setDraggedStop] = useState<{ index: number; position: number } | null>(null);
  const draggedStopRef = useRef<{ index: number; position: number } | null>(null);
  const fallbackColorPickerRef = useRef<HTMLInputElement>(null);
  const entry = normalizePaletteEntry(paletteColors[selectedColorIndex]);
  const stopIndex = Math.min(activeStop, entry.stops.length - 1);
  const stop = entry.stops[stopIndex];
  const hsv = hexToHsv(stop.color);
  const displayedStops = draggedStop
    ? entry.stops.map((item, index) => index === draggedStop.index ? { ...item, position: draggedStop.position } : item)
    : entry.stops;

  useEffect(() => {
    setActiveStop(0);
    draggedStopRef.current = null;
    setDraggedStop(null);
  }, [selectedColorIndex]);
  useEffect(() => {
    if (activeStop >= entry.stops.length) setActiveStop(Math.max(0, entry.stops.length - 1));
  }, [activeStop, entry.stops.length]);

  if (!paletteEditorOpen) return null;

  const updateSv = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const s = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const v = Math.max(0, Math.min(1, 1 - (event.clientY - rect.top) / rect.height));
    spaceUiStore.setPaletteStop(selectedColorIndex, stopIndex, { color: hsvToHex(hsv.h, s, v) });
  };

  const stopPositionAt = (clientX: number, rail: HTMLElement) => {
    const rect = rail.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const updateDraggedStop = (event: React.PointerEvent<HTMLButtonElement>, index: number) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const rail = event.currentTarget.parentElement?.parentElement;
    if (!rail) return;
    const next = { index, position: stopPositionAt(event.clientX, rail) };
    draggedStopRef.current = next;
    setDraggedStop(next);
  };

  const finishDraggingStop = (event: React.PointerEvent<HTMLButtonElement>) => {
    const dragged = draggedStopRef.current;
    if (!dragged) return;
    event.stopPropagation();
    const rail = event.currentTarget.parentElement?.parentElement;
    const position = rail ? stopPositionAt(event.clientX, rail) : dragged.position;
    const nextIndex = spaceUiStore.setPaletteStop(selectedColorIndex, dragged.index, { position });
    if (nextIndex !== null && nextIndex >= 0) setActiveStop(nextIndex);
    draggedStopRef.current = null;
    setDraggedStop(null);
  };

  const pickScreenColor = async () => {
    const EyeDropperConstructor = (globalThis as any).EyeDropper;
    if (globalThis.isSecureContext && typeof EyeDropperConstructor === 'function') {
      try {
        const result = await new EyeDropperConstructor().open();
        if (/^#[0-9a-f]{6}$/i.test(result?.sRGBHex)) {
          spaceUiStore.setPaletteStop(selectedColorIndex, stopIndex, { color: result.sRGBHex });
        }
      } catch (error: any) {
        if (error?.name !== 'AbortError') spaceUiStore.showToast('Could not sample a screen color');
      }
      return;
    }
    fallbackColorPickerRef.current?.click();
  };

  return (
    <div className="palette-editor" role="dialog" aria-label="Palette editor">
      <div className="palette-editor-header">
        <div>
          <strong>Palette {selectedColorIndex + 1}</strong>
          <span>{entry.stops.length > 1 ? `${entry.stops.length}-stop gradient` : 'Solid color'}</span>
        </div>
        <button type="button" className="palette-editor-close" onClick={() => spaceUiStore.closeColorPicker()} aria-label="Close palette editor">×</button>
      </div>
      <div
        className="gradient-stop-rail"
        style={{ background: gradientCss(displayedStops) }}
        title={entry.stops.length >= MAX_GRADIENT_STOPS ? 'Maximum of 5 stops' : 'Click to add a stop'}
        onPointerDown={event => {
          if (event.target !== event.currentTarget || entry.stops.length >= MAX_GRADIENT_STOPS) return;
          const index = spaceUiStore.addPaletteStop(
            selectedColorIndex,
            stopPositionAt(event.clientX, event.currentTarget),
          );
          if (index !== null) setActiveStop(index);
        }}
      >
        {entry.stops.map((gradientStop, index) => (
          <div
            key={index}
            className={`gradient-stop-control ${index === stopIndex ? 'active' : ''}`}
            style={{ left: `${(draggedStop?.index === index ? draggedStop.position : gradientStop.position) * 100}%` }}
          >
            <button
              type="button"
              className={`gradient-stop-node ${index === stopIndex ? 'active' : ''}`}
              style={{ background: gradientStop.color }}
              title={`Drag stop ${index + 1}`}
              aria-label={`Gradient stop ${index + 1}`}
              onPointerDown={event => {
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                const rail = event.currentTarget.parentElement?.parentElement;
                const next = {
                  index,
                  position: rail ? stopPositionAt(event.clientX, rail) : gradientStop.position,
                };
                draggedStopRef.current = next;
                setDraggedStop(next);
                setActiveStop(index);
              }}
              onPointerMove={event => updateDraggedStop(event, index)}
              onPointerUp={finishDraggingStop}
              onPointerCancel={() => {
                draggedStopRef.current = null;
                setDraggedStop(null);
              }}
              onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const direction = event.key === 'ArrowLeft' ? -1 : 1;
                const nextIndex = spaceUiStore.setPaletteStop(selectedColorIndex, index, {
                  position: gradientStop.position + direction * 0.01,
                });
                if (nextIndex !== null && nextIndex >= 0) setActiveStop(nextIndex);
              }}
            />
            {index > 0 ? (
              <button
                type="button"
                className="gradient-stop-delete"
                aria-label={`Delete gradient stop ${index + 1}`}
                title={`Delete stop ${index + 1}`}
                onPointerDown={event => event.stopPropagation()}
                onClick={event => {
                  event.stopPropagation();
                  spaceUiStore.removePaletteStop(selectedColorIndex, index);
                  setActiveStop(current => current > index ? current - 1 : Math.min(current, index - 1));
                }}
              >×</button>
            ) : null}
          </div>
        ))}
      </div>
      <div className="gradient-stop-actions">
        <span>Click the strip to add · Drag stops to position</span>
        <span className="gradient-stop-count">{entry.stops.length}/{MAX_GRADIENT_STOPS}</span>
      </div>
      <div
        className="palette-sv-field"
        style={{ backgroundColor: hsvToHex(hsv.h, 1, 1) }}
        onPointerDown={event => {
          event.currentTarget.setPointerCapture(event.pointerId);
          updateSv(event);
        }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updateSv(event); }}
      >
        <span className="palette-sv-cursor" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <label className="palette-editor-field hue-field">
        <span>Hue</span>
        <input type="range" min="0" max="359" value={Math.round(hsv.h)} onChange={event => {
          spaceUiStore.setPaletteStop(selectedColorIndex, stopIndex, { color: hsvToHex(Number(event.target.value), hsv.s, hsv.v) });
        }} />
      </label>
      <div className="palette-editor-fields">
        <label className="palette-editor-field">
          <span>Hex</span>
          <input value={stop.color.toUpperCase()} maxLength={7} onChange={event => {
            if (/^#[0-9a-f]{6}$/i.test(event.target.value)) {
              spaceUiStore.setPaletteStop(selectedColorIndex, stopIndex, { color: event.target.value });
            }
          }} />
        </label>
        <button
          type="button"
          className="palette-eyedropper"
          onClick={pickScreenColor}
          title="Pick a color from the screen"
        >
          <LiaEyeDropperSolid size={14} aria-hidden="true" />
          Pick color
        </button>
        <input
          ref={fallbackColorPickerRef}
          className="palette-fallback-color-picker"
          type="color"
          value={stop.color}
          aria-label="Choose stop color"
          onChange={event => spaceUiStore.setPaletteStop(selectedColorIndex, stopIndex, { color: event.target.value })}
        />
      </div>
      <div className="palette-material-options" role="group" aria-label="Material">
        <span>Material</span>
        <button type="button" className={entry.materialId === 0 ? 'active' : ''} onClick={() => spaceUiStore.setPaletteMaterial(selectedColorIndex, 0)}>Default</button>
        <button type="button" className={entry.materialId === 1 ? 'active' : ''} onClick={() => spaceUiStore.setPaletteMaterial(selectedColorIndex, 1)}>Emissive</button>
      </div>
      <p className="palette-editor-note">Selector gradients run from point A to B. Brush, shovel, spoon, and non-box selections use the first stop.</p>
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
              style={{ background: gradientCss(item.stops) }}
              title={`${item.name || 'Custom'} (${item.stops.length > 1 ? `${item.stops.length}-stop gradient` : item.hex.toUpperCase()}) · ${item.materialId === 1 ? 'Emissive' : 'Default'} · ${altLabel}+${index + 1}${isActive ? ' · I to edit' : ''}`}
              onClick={() => {
                if (isActive) {
                  spaceUiStore.openColorPicker();
                } else {
                  spaceUiStore.selectPresetColor(index);
                }
              }}
            >
              <span className="chip-num">{index + 1}</span>
              {item.materialId === 1 && <span className="chip-material">E</span>}
            </button>
          );
        })}
      </div>
      <PaletteEditor />
    </div>
  );
}

function InventoryBar() {
  const { controller, activeInventoryCategory, selectedInventoryIndex } = useSpaceUi(state => state);
  const category = 'item';
  const items = controller?.inventories?.[category]?.items || [];
  const renderer = InventoryThumbnailRenderer.getInstance();
  React.useSyncExternalStore(renderer.subscribe, renderer.getRevision, renderer.getRevision);
  return (
    <div className="inventory-bar-wrapper" id="inventory-bar-wrapper">
      <div className="palette-info-row">
        <div className="palette-title-group">
          <button type="button" tabIndex={-1} className="palette-title" id="backpack-bar-title" title="Click or press E to open full backpack" onClick={() => spaceUiStore.toggleInventoryModal(true)}>
            <LiaBoxesSolid size={14} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 3 }} />Backpack
          </button>
          <div id="inv-cat-tabs" className="inv-cat-tabs">
            <span className="inv-cat-tab active">Items</span>
          </div>
        </div>
        <span className="palette-hotkey-hint"><b>E</b> Full Backpack · <b>Arrows/RMB</b> Rotate · <b>LMB</b> Build</span>
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
    { id: 'box' as const, name: 'Box', shortcut: `${altLabel}+1`, icon: TbBox },
    { id: 'cylinder' as const, name: 'Cylinder', shortcut: `${altLabel}+2`, icon: TbCylinder },
    { id: 'sphere' as const, name: 'Sphere / Circle', shortcut: `${altLabel}+3`, icon: TbSphere },
    { id: 'stairs' as const, name: 'Stairs', shortcut: `${altLabel}+4`, icon: TbStairs },
    { id: 'line' as const, name: 'Line', shortcut: `${altLabel}+5`, icon: TbLine },
  ];
}

function assembleCurrentSelection(controller: any) {
  if (controller?.selectedBlockSelection) {
    return controller.createChildFromSelectedBlocks?.();
  }
  return controller?.assembleSelection?.(ContraptionMode.PROGRAMMABLE);
}

function SelectorPanel() {
  const { selector, controller, selectedColor, paletteColors, selectedColorIndex } = useSpaceUi(state => state);
  const activeHex = colorToHex(selectedColor ?? 0xf2a93b);
  const activeEntry = normalizePaletteEntry(paletteColors[selectedColorIndex], activeHex);
  const activeBackground = gradientCss(activeEntry.stops);
  const altLabel = getAltKeyLabel();
  const selectorShapeItems = getSelectorShapeItems();

  return (
    <div className="selector-panel-wrapper" id="selector-panel-wrapper">
      <div className="palette-info-row">
        <div className="selector-title-group">
          <button id="selector-mode-toggle" tabIndex={-1} className="selector-mode-btn" title="Click or press Tab to switch mode" onClick={() => controller?.toggleSelectorMicroMode?.()}>
            <span id="selector-mode-badge" className={`mode-badge ${selector.micro ? 'micro' : 'std'}`}>{selector.micro ? 'MICRO' : 'STANDARD'}</span>
            <span className="mode-tab-hint flex items-center gap-0.5">Tab <LiaExchangeAltSolid style={{ display: 'inline' }} /></span>
          </button>
          <div className="selector-recent-color" id="selector-recent-color" title={`Active palette · Click to edit · ${altLabel}+1~9`}>
            <button type="button" className="selector-recent-color-chip" style={{ background: activeBackground }} onClick={() => spaceUiStore.openColorPicker()} />
          </div>
        </div>
        <span className="palette-hotkey-hint"><b>I</b> set color · <b>{altLabel}+1~5</b> shape · <b>Arrows</b> rotate</span>
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
          <button id="assemble-btn" tabIndex={-1} className="banner-btn primary" disabled={!selector.canAssemble} onClick={() => assembleCurrentSelection(controller)}>{selector.assembleLabel}</button>
          <button id="fill-btn" tabIndex={-1} className="banner-btn secondary" title="Fill selection with the active color (F)" disabled={!selector.canModify} onClick={() => controller?.fillSelectionBlocks?.()}>
            <span className="btn-color-dot" style={{ background: activeBackground }} />
            Fill (F)
          </button>
          <button id="paint-btn" tabIndex={-1} className="banner-btn secondary" title="Recolor selection with the active color (P)" disabled={!selector.canModify} onClick={() => controller?.paintSelectionBlocks?.()}>
            <span className="btn-color-dot" style={{ background: activeBackground }} />
            Paint (P)
          </button>
          <button id="copy-btn" tabIndex={-1} className="banner-btn secondary" title="Copy selection to backpack (R)" disabled={!selector.canCopy} onClick={() => controller?.copySelectionSmart?.()}>Copy (R)</button>
          <button id="delete-btn" tabIndex={-1} className="banner-btn danger" title="Delete selection (Del)" disabled={!selector.canDelete} onClick={() => controller?.deleteSelectionBlocks?.()}>Delete (Del)</button>
        </div>
      </div>
      <PaletteEditor />
    </div>
  );
}

function SelectorContextMenu() {
  const { selectorContextMenu, selector, controller, selectedColor, paletteColors, selectedColorIndex } = useSpaceUi(state => state);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !selectorContextMenu) return;
    const updatePosition = () => {
      const next = selectorMenuPosition(selectorContextMenu,
        { width: menu.offsetWidth, height: menu.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight });
      setPosition(current => current.left === next.left && current.top === next.top ? current : next);
    };
    updatePosition(); // Measure before first paint: no off-screen flash.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition);
    observer?.observe(menu);
    window.addEventListener('resize', updatePosition);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updatePosition);
    };
  }, [selectorContextMenu]);
  if (!selectorContextMenu) return null;

  const activeHex = colorToHex(selectedColor ?? 0xf2a93b);
  const activeBackground = gradientCss(normalizePaletteEntry(paletteColors[selectedColorIndex], activeHex).stops);
  const selectorShapeItems = getSelectorShapeItems();
  const selectedEntity = controller?.selectedBlockSelection?.contraption
    || controller?.selectedSubtree?.contraption
    || null;
  const canRotate = selector.canModify
    && (!selectedEntity || controller?.canEditEntityInternals?.(selectedEntity));
  const canSelectAll = !!controller?.getSelectorSelectAllTarget?.();
  const close = () => spaceUiStore.closeSelectorContextMenu(true);
  const run = (action: () => unknown) => {
    close();
    action();
  };
  const setMicro = (micro: boolean) => {
    if (selector.micro !== micro) controller?.toggleSelectorMicroMode?.();
  };

  return (
    <div
      id="selector-context-menu-layer"
      className="selector-context-menu-layer"
      onMouseDown={event => {
        event.stopPropagation();
        if (event.target === event.currentTarget) close();
      }}
      onMouseUp={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    >
      <div
        id="selector-context-menu"
        ref={menuRef}
        className="selector-context-menu"
        role="menu"
        aria-label="Selector actions"
        style={position}
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="selector-context-header">
          <div>
            <div className="selector-context-kicker">SELECTOR MENU</div>
            <div className="selector-context-title">{selector.title}</div>
          </div>
          <button type="button" className="selector-context-close" aria-label="Close selector menu" onClick={close}>×</button>
        </div>
        {selector.details ? <div className="selector-context-details">{selector.details}</div> : null}

        <div className="selector-context-section">
          <div className="selector-context-section-title">Grid</div>
          <div className="selector-context-grid two">
            <button type="button" role="menuitemradio" aria-checked={!selector.micro} className={!selector.micro ? 'active' : ''} onClick={() => run(() => setMicro(false))}>Standard <kbd>Tab</kbd></button>
            <button type="button" role="menuitemradio" aria-checked={selector.micro} className={selector.micro ? 'active' : ''} onClick={() => run(() => setMicro(true))}>Micro <kbd>Tab</kbd></button>
          </div>
        </div>

        <div className="selector-context-section">
          <div className="selector-context-section-title">Shape</div>
          <div className="selector-context-shapes">
            {selectorShapeItems.map(item => {
              const Icon = item.icon;
              const isActive = selector.shape === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  className={isActive ? 'active' : ''}
                  title={`${item.name} · ${item.shortcut}`}
                  onClick={() => run(() => spaceUiStore.setSelectorShape(item.id))}
                >
                  <Icon size={16} />
                  <span>{item.name}</span>
                  <kbd>{item.shortcut}</kbd>
                </button>
              );
            })}
          </div>
        </div>

        <div className="selector-context-section">
          <div className="selector-context-section-title">Rotate Selection</div>
          <div className="selector-context-grid four">
            <button type="button" role="menuitem" disabled={!canRotate} title="Rotate left around Y (Left Arrow)" onClick={() => run(() => controller?.rotateSelection?.(-1, 'y'))}>Y− <kbd>←</kbd></button>
            <button type="button" role="menuitem" disabled={!canRotate} title="Rotate right around Y (Right Arrow)" onClick={() => run(() => controller?.rotateSelection?.(1, 'y'))}>Y+ <kbd>→</kbd></button>
            <button type="button" role="menuitem" disabled={!canRotate} title="Rotate up around X (Up Arrow)" onClick={() => run(() => controller?.rotateSelection?.(1, 'x'))}>X+ <kbd>↑</kbd></button>
            <button type="button" role="menuitem" disabled={!canRotate} title="Rotate down around X (Down Arrow)" onClick={() => run(() => controller?.rotateSelection?.(-1, 'x'))}>X− <kbd>↓</kbd></button>
          </div>
        </div>

        <div className="selector-context-section">
          <div className="selector-context-section-title selector-context-color-title">
            <span>Actions</span>
            <button type="button" className="selector-context-color" title="Edit active palette" onClick={() => run(() => spaceUiStore.openColorPicker())}>
              <span style={{ background: activeBackground }} />
              <code>{activeHex.toUpperCase()}</code>
            </button>
          </div>
          <div className="selector-context-actions">
            <button type="button" role="menuitem" disabled={!canSelectAll} title="Select all directly owned blocks of the current entity component and confirm A/B" onClick={() => run(() => controller?.selectAllSelectionBlocks?.())}>Select All</button>
            <button type="button" role="menuitem" className="primary" disabled={!selector.canAssemble} onClick={() => run(() => assembleCurrentSelection(controller))}>{selector.assembleLabel}</button>
            <button type="button" role="menuitem" disabled={!selector.canModify} onClick={() => run(() => controller?.fillSelectionBlocks?.())}>Fill <kbd>F</kbd></button>
            <button type="button" role="menuitem" disabled={!selector.canModify} onClick={() => run(() => controller?.paintSelectionBlocks?.())}>Paint <kbd>P</kbd></button>
            <button type="button" role="menuitem" disabled={!selector.canCopy} onClick={() => run(() => controller?.copySelectionSmart?.())}>Copy <kbd>R</kbd></button>
            <button type="button" role="menuitem" className="danger" disabled={!selector.canDelete} onClick={() => run(() => controller?.deleteSelectionBlocks?.())}>Delete <kbd>Del</kbd></button>
            <button type="button" role="menuitem" disabled={!selector.hasSelection} onClick={() => run(() => controller?.clearSelection?.())}>Clear Selection</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WrenchPanel() {
  const { controller } = useSpaceUi(state => state);
  const targetEntity = controller?.hoveredContraptionHit?.contraption || controller?.hoveredContraption || null;
  const hasTargetEntity = Boolean(targetEntity);
  return (
    <div className="selector-panel-wrapper wrench-panel-wrapper" id="wrench-panel-wrapper">
      <div className="palette-info-row">
        <div className="selector-title-group">
          <span className="palette-title flex items-center gap-1">
            <LiaWrenchSolid size={14} style={{ display: 'inline', verticalAlign: 'text-bottom' }} /> Wrench
          </span>
          <span className="mode-badge std">PHYSICS & CONTROL</span>
        </div>
      </div>
      <div className="selector-toolbox-content" id="wrench-toolbox-content">
        <div className="wrench-action-buttons">
          <button type="button" tabIndex={-1} className="banner-btn secondary" disabled={!hasTargetEntity} title="Hold left-click on an entity to stop and lift it (LMB)" onClick={() => controller?.startWrenchGrab?.()}><b>LMB</b> Stop & Lift</button>
          <button type="button" tabIndex={-1} className="banner-btn secondary" disabled={!hasTargetEntity} title="When focused on an entity, scroll to move it closer or farther"><b>Scroll</b> Closer / Farther</button>
          <button type="button" tabIndex={-1} className="banner-btn secondary" disabled={!hasTargetEntity} title="Open more actions for the focused entity (RMB)" onClick={event => targetEntity && spaceUiStore.showEntityContextMenu(targetEntity, { x: event.clientX, y: event.clientY })}><b>RMB</b> More Actions</button>
          <button type="button" tabIndex={-1} className="banner-btn secondary" disabled={!hasTargetEntity} title="Point at an entity and press C to open its code editor" onClick={() => controller?.openCodeEditorForTarget?.()}><b>C</b> Code</button>
          <button type="button" tabIndex={-1} className="banner-btn secondary" disabled={!hasTargetEntity} title="Point at a seat block and press V to mount/drive" onClick={() => controller?.toggleDriveVehicle?.()}><b>V</b> Drive</button>
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
  const { bulkEdit, worldEditSync, isAdmin } = useSpaceUi(state => state);
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
  const quotaText = isAdmin
    ? `Terrain edit allowance: unlimited (administrator)${worldEditSync.quota ? ` · ${worldEditSync.quota.usedToday.toLocaleString()} edits today` : ''}`
    : worldEditSync.quota
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
  const terrain = state.terrainLoadProgress;
  const terrainPercent = terrain.totalChunks > 0
    ? Math.floor(terrain.readyChunks / terrain.totalChunks * 100) : 0;
  return (
    <>
      <div id="crosshair" />
      <div id="hud-overlay">
        <div className="hud-top">
          <div className="hud-card">
            <div className="hud-badge"><span className="hud-badge-dot" />EntropyDrop · Space <span className="hud-beta-badge">BETA</span></div>
            <div className="hud-metrics-row"><span id="fps-val">{state.fpsText}</span><span className="hud-metric-sep">·</span><span id="ping-val" className={state.pingClass}>{state.pingText}</span></div>
            <div id="pos-val">{state.positionText}</div>
            <div className={`hud-terrain ${terrain.ready ? 'is-ready' : ''}`}>
              <div className="hud-terrain-label">
                <span>{terrain.ready ? 'Chunks ready' : 'Loading chunks'}</span>
                <span>{terrain.readyChunks}/{terrain.totalChunks} · {terrainPercent}%</span>
              </div>
              <div id="terrain-load-progress" className="hud-terrain-track" role="progressbar"
                aria-label="Nearby chunks loaded" aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={terrainPercent}
                aria-valuetext={`${terrain.readyChunks} of ${terrain.totalChunks} chunks ready, including micro blocks`}
                title="Nearby chunks, including standard and micro blocks">
                <div className="hud-terrain-fill" style={{ width: `${terrainPercent}%` }} />
              </div>
            </div>
            <div id="network-bandwidth" className="hud-bandwidth"
              title="Live application data over the last second. Downloads count response-body bytes after decompression; uploads count transfer progress and drained realtime messages. Excludes protocol overhead and browser-cache hits when timing is available.">
              <span aria-label={`Download ${formatByteRate(state.networkRates.downloadBytesPerSecond)}`}>
                <span className="hud-bandwidth-arrow" aria-hidden="true">↓</span> {formatByteRate(state.networkRates.downloadBytesPerSecond)}
              </span>
              <span aria-label={`Upload ${formatByteRate(state.networkRates.uploadBytesPerSecond)}`}>
                <span className="hud-bandwidth-arrow" aria-hidden="true">↑</span> {formatByteRate(state.networkRates.uploadBytesPerSecond)}
              </span>
            </div>
            <NearbyEntities />
            <HostedEntities />
          </div>
          <div className="hud-actions">
            <button
              id="agent-build-btn"
              type="button"
              tabIndex={-1}
              className="icon-btn agent-build-hud-btn"
              title="Agent Build (External Agent Construction)"
              onClick={() => spaceUiStore.toggleAgentBuild(true)}
            >
              <span className="agent-build-pulse-dot" />
              <LiaRobotSolid size={16} className="agent-build-icon" />
              <span className="agent-build-label">AGENT BUILD</span>
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
              id="discord-btn"
              type="button"
              tabIndex={-1}
              className="icon-btn"
              title="Discord Community"
              aria-label="Discord Community"
              onClick={() => window.open('https://discord.gg/zxd8RjUyYt', '_blank', 'noopener,noreferrer')}
            >
              <SiDiscord size={18} />
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
      <SelectorContextMenu />
      <EntityNameplates />
      <EntityContextMenu />
    </>
  );
}
