import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { colorToHex } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { gradientCss, normalizePaletteEntry } from '@entropydrop/space-engine/voxel/Palette.ts';
import { spaceUiStore } from '../store/SpaceUiStore.ts';
import { useSpaceUi } from '../store/useSpaceUi.ts';

function NumberField({ label, value, step, onCommit }: {
  label: string; value: number; step: number; onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(Number(value.toFixed(6))));
  const focused = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(String(Number(value.toFixed(6)))); }, [value]);
  return <input aria-label={label} type="number" step={step} value={draft}
    onFocus={() => { focused.current = true; cancelled.current = false; }}
    onChange={event => setDraft(event.target.value)}
    onKeyDown={event => {
      if (event.key === 'Enter') event.currentTarget.blur();
      if (event.key === 'Escape') { cancelled.current = true; setDraft(String(Number(value.toFixed(6)))); event.currentTarget.blur(); }
    }}
    onBlur={() => {
      focused.current = false;
      const parsed = draft.trim() ? Number(draft) : NaN;
      if (!cancelled.current && Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
      setDraft(String(Number(value.toFixed(6))));
    }} />;
}

export function ModelingPanel() {
  const { controller } = useSpaceUi(state => state);
  const tool = controller?.modeling;
  const selection = tool?.getDisplaySelection();
  const editable = selection && !tool.isDragging && controller.canEditEntityInternals(selection.contraption);
  const value = selection?.value;
  const creationDimensions = tool?.creationDimensions;
  const position = value?.position || [0, 0, 0];
  const scale = value?.scale || [1, 1, 1];
  const euler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(value?.rotation || [0, 0, 0, 1]), 'XYZ');
  const rotation = [euler.x, euler.y, euler.z].map(THREE.MathUtils.radToDeg);
  const vectorField = (field: 'position' | 'rotation' | 'scale', values: number[], step: number) => <div className="modeling-vector-row">
    <span>{field === 'scale' ? 'Dimensions' : field === 'rotation' ? 'Rotation °' : 'Position'}</span>
    {['X', 'Y', 'Z'].map((axis, index) => <label key={axis}><b className={`axis-${axis.toLowerCase()}`}>{axis}</b>
      <NumberField label={`Decoration ${field} ${axis}`} value={values[index]} step={step} onCommit={next => {
        const vector = [...values]; vector[index] = next;
        if (field === 'rotation') {
          const [x, y, z] = vector.map(THREE.MathUtils.degToRad);
          tool.change({ rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ')).toArray() });
        } else tool.change({ [field]: vector });
        spaceUiStore.refresh();
      }} />
    </label>)}
  </div>;

  return <aside id="modeling-panel" aria-label="Decoration properties" className="selector-panel-wrapper modeling-panel"
    onPointerDown={event => { event.stopPropagation(); if (controller?.isLocked) tool?.openPrecision(); }}
    onMouseDown={event => event.stopPropagation()}>
    <div className="palette-info-row">
      <span className="palette-title">Modeling</span>
      <span className="mode-badge std">DECORATION</span>
    </div>
    {creationDimensions && <div className="modeling-hint" role="status">Creating {creationDimensions.map((value: number) => Number(value.toFixed(3))).join(' × ')} m<br />Wheel: thickness · release RMB: create · Esc: cancel</div>}
    {selection ? <>
      <div className="modeling-owner">{selection.contraption.getComponentName(selection.componentId) || selection.componentId} · {selection.decorationId}</div>
      <fieldset disabled={!editable} key={`${selection.contraption.id}:${selection.componentId}:${selection.decorationId}`}>
        {vectorField('position', position, 0.125)}
        {vectorField('rotation', rotation, 5)}
        {vectorField('scale', scale, 0.125)}
      </fieldset>
      {!controller.canEditEntityInternals(selection.contraption) && <div className="modeling-hint">Stop the entity and obtain edit access to change this decoration.</div>}
    </> : <div className="modeling-hint">Select a decoration with LMB to inspect its position, rotation and dimensions.</div>}
  </aside>;
}

export function ModelingToolbar() {
  const { controller, selectedColor, paletteColors, selectedColorIndex } = useSpaceUi(state => state);
  const tool = controller?.modeling;
  const selection = tool?.getSelection();
  const editable = selection && !tool.isDragging && controller.canEditEntityInternals(selection.contraption);
  const activeEntry = normalizePaletteEntry(paletteColors[selectedColorIndex], colorToHex(selectedColor));
  return <div id="modeling-toolbar" className="selector-panel-wrapper wrench-panel-wrapper">
    <div className="palette-info-row">
      <div className="selector-title-group">
        <span className="palette-title">Modeling</span>
        <span className="mode-badge std">DECORATION</span>
        <div className="selector-recent-color" title="Active palette · Click or press I to edit">
          <button type="button" tabIndex={-1} className="selector-recent-color-chip" aria-label="Set color (I)"
            style={{ background: gradientCss(activeEntry.stops) }} onClick={() => spaceUiStore.openColorPicker()} />
        </div>
      </div>
      <span className="palette-hotkey-hint"><b>I</b> set color · LMB select / drag · RMB add / draw size</span>
    </div>
    <div className="selector-toolbox-content" id="modeling-toolbox-content">
      <div className="wrench-action-buttons">
        <button type="button" tabIndex={-1} className="banner-btn secondary" disabled={!editable}
          title="Copy the selected decoration in its component (R or Ctrl/Cmd+D)" onClick={() => tool?.duplicate()}><b>R</b> Copy</button>
        <button type="button" tabIndex={-1} className="banner-btn danger" disabled={!editable}
          title="Delete only the selected decoration (Del)" onClick={() => tool?.remove()}><b>Del</b> Delete</button>
        <button type="button" tabIndex={-1} className="banner-btn secondary" disabled={!tool?.canUndo || tool.isDragging}
          title="Undo decoration edit (Ctrl/Cmd+Z)" onClick={() => tool?.undo()}>Undo</button>
        <button type="button" tabIndex={-1} className="banner-btn secondary" disabled={!tool?.canRedo || tool.isDragging}
          title="Redo decoration edit (Ctrl/Cmd+Shift+Z)" onClick={() => tool?.undo(true)}>Redo</button>
      </div>
    </div>
  </div>;
}
