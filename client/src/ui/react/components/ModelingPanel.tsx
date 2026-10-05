import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
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
  const selection = tool?.getSelection();
  const editable = selection && controller.canEditEntityInternals(selection.contraption);
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

  return <div id="modeling-panel" className={`selector-panel-wrapper modeling-panel${tool?.precisionOpen ? ' is-precision' : ''}`} onPointerDown={() => controller?.unlock?.()}>
    <div className="palette-info-row">
      <span className="palette-title">Modeling</span>
      <span className="mode-badge std">DECORATION</span>
      {tool?.precisionOpen && <button type="button" className="banner-btn secondary" onClick={() => tool.continueBuilding()}>Back to game</button>}
    </div>
    {creationDimensions && <div className="modeling-hint" role="status">Creating {creationDimensions.map(value => Number(value.toFixed(3))).join(' × ')} m<br />Wheel: thickness · release RMB: create · Esc: cancel</div>}
    {selection ? <>
      <div className="modeling-owner">{selection.contraption.getComponentName(selection.componentId)} · {selection.decorationId}</div>
      <div className="modeling-hint">Aim + LMB: select / drag · arrows: move · arcs: rotate · cubes: resize<br />RMB: add · RMB drag: draw size · wheel while drawing: thickness<br /><kbd>Shift</kbd> snap · <kbd>Esc</kbd> exact values / cancel drag</div>
      <div className="modeling-axis-legend"><span className="axis-x">X</span><span className="axis-y">Y</span><span className="axis-z">Z</span><span>Local axes · resize from center</span></div>
      {!tool.precisionOpen && <button type="button" className="banner-btn secondary" onClick={() => tool.openPrecision()}>Exact values · Esc</button>}
      {tool.precisionOpen && <fieldset disabled={!editable}>
        {vectorField('position', position, 0.125)}
        {vectorField('rotation', rotation, 5)}
        {vectorField('scale', scale, 0.125)}
        <div className="modeling-appearance">
          <label>Color <input type="color" aria-label="Decoration color" value={`#${value.color.toString(16).padStart(6, '0')}`}
            onChange={event => tool.change({ color: Number.parseInt(event.target.value.slice(1), 16) })} /></label>
          <label><input type="checkbox" checked={value.materialId === 1}
            onChange={event => tool.change({ materialId: event.target.checked ? 1 : 0 })} /> Emissive</label>
          <button type="button" className="banner-btn secondary" onClick={() => tool.change({ color: controller.selectedColor, materialId: controller.selectedMaterialId })}>Use palette color</button>
        </div>
      </fieldset>}
      {tool.precisionOpen && <div className="modeling-hint">Position relative to component · rotation in degrees · dimensions in meters. Press Enter to apply.</div>}
      {!editable && <div className="modeling-hint">Stop the entity and obtain edit access to change this decoration.</div>}
    </> : <div className="modeling-hint">RMB: add a cube · RMB drag: draw size · wheel while drawing: thickness<br />LMB: select or drag a decoration · Esc: exact values / cancel drag</div>}
    <div className="modeling-actions">
      <button type="button" className="banner-btn secondary" onClick={() => tool?.undo()}>Undo</button>
      <button type="button" className="banner-btn secondary" onClick={() => tool?.undo(true)}>Redo</button>
      <button type="button" className="banner-btn secondary" disabled={!editable} onClick={() => tool?.duplicate()}>Duplicate</button>
      <button type="button" className="banner-btn secondary" disabled={!editable} onClick={() => tool?.remove()}>Delete</button>
      <button type="button" className="banner-btn" onClick={() => tool?.continueBuilding()}>Continue building</button>
    </div>
  </div>;
}
