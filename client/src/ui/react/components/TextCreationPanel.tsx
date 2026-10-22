import React, { useEffect, useRef, useState } from 'react';
import { colorToHex } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { MICRO_SIZE } from '@entropydrop/space-engine/voxel/MicroGrid.ts';
import { TEXT_MAX_LENGTH } from '../../../engine/voxel/TextVoxelizer.ts';
import { useSpaceUiFields } from '../store/useSpaceUi.ts';
import { MaterialSelector } from './MaterialSelector.tsx';

export function TextCreationPanel() {
  const { textCreation: view, controller } = useSpaceUiFields('textCreation', 'controller');
  const composing = useRef(false);
  const [draft, setDraft] = useState(view.text);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!composing.current) setDraft(view.text); }, [view.text, view.open]);
  useEffect(() => { if (view.open) input.current?.focus(); }, [view.open]);
  if (!view.open) return null;
  const session = controller?.textCreation;
  return <aside className="text-creation-panel" aria-label="Create voxel text"
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onContextMenu={event => event.preventDefault()}>
    <header><div><span className="text-creation-eyebrow">HAMMER / TEXT</span><h2>Create text</h2></div>
      <button type="button" aria-label="Close text creation" onClick={() => session?.close()}>×</button></header>
    <p className="text-creation-description">Drag the X / Y / Z arrows to position text.<br />Movement snaps to 0.125 m. Chinese and multiline text supported.</p>
    <label htmlFor="voxel-text-content">Text</label>
    <textarea ref={input} id="voxel-text-content" value={draft} rows={3} maxLength={TEXT_MAX_LENGTH}
      placeholder="Enter text…"
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={event => { composing.current = false; session?.edit({ text: event.currentTarget.value }); }}
      onChange={event => { const text = event.target.value; setDraft(text); if (!composing.current) session?.edit({ text }); }} />
    <div className="text-creation-fields">
      <label>Font size<input aria-label="Font size" type="number" min={8} max={128} step={1} value={view.fontSize}
        onChange={event => session?.edit({ fontSize: Number(event.target.value) })} /><small>8–128 cells</small></label>
      <label>Voxel size<select aria-label="Voxel size" value={view.micro ? 'micro' : 'standard'}
        onChange={event => session?.edit({ micro: event.target.value === 'micro' })}>
        <option value="micro">Micro · 0.125 m</option><option value="standard">Standard · 1 m</option>
      </select><small>One cell thick</small></label>
    </div>
    <div className="text-creation-orientation">
      <span>Orientation</span>
      <div role="group" aria-label="Text orientation">
        <button type="button" aria-pressed={view.orientation === 'vertical'}
          onClick={() => session?.edit({ orientation: 'vertical' })}>Vertical</button>
        <button type="button" aria-pressed={view.orientation === 'horizontal'}
          onClick={() => session?.edit({ orientation: 'horizontal' })}>Horizontal</button>
      </div>
      <small>{view.orientation === 'vertical' ? 'Standing upright' : 'Lying flat'}</small>
    </div>
    <div className="text-creation-position">
      <span>Position offset (m)</span>
      <div>{(['X', 'Y', 'Z'] as const).map((axis, index) => <label key={axis} className={`axis-${axis.toLowerCase()}`}>{axis}
        <input aria-label={`Text offset ${axis}`} type="number" step={MICRO_SIZE} disabled={view.busy}
          value={view[`offset${axis}`]} onChange={event => session?.setOffset(session.offset.setComponent(index, event.currentTarget.valueAsNumber))} />
      </label>)}</div>
      <small>Drag an axis or enter an offset · 0.125 m steps</small>
    </div>
    <label className="text-creation-color">Color<input aria-label="Text color" type="color" value={colorToHex(view.color)}
      onChange={event => session?.edit({ color: parseInt(event.target.value.slice(1), 16) })} /><span>{colorToHex(view.color).toUpperCase()}</span></label>
    <MaterialSelector materialId={view.materialId} onChange={materialId => session?.edit({ materialId })} />
    <div className="text-creation-metrics" aria-live="polite">
      {view.busy ? <span role="status">Generating preview…</span> : view.error ? <span role="alert">{view.error}</span>
        : <><strong>{view.blockCount.toLocaleString()} voxels</strong><span>{view.width.toFixed(2)} × {view.height.toFixed(2)} m</span></>}
    </div>
    <footer><button type="button" onClick={() => session?.close()}>Cancel <kbd>Esc</kbd></button>
      <button type="button" className="text-creation-submit" disabled={!view.canCreate} onClick={() => session?.create()}>Create text</button></footer>
  </aside>;
}
