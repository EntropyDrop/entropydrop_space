import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { spaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

const componentUrl = new URL('../src/ui/react/components/ModelingPanel.tsx', import.meta.url).href;
const hook = registerHooks({ load(url, context, nextLoad) {
  if (url !== componentUrl) return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText };
} });
const { ModelingPanel, ModelingToolbar } = await import(componentUrl);
hook.deregister();

function render(selected = true, editable = true, precisionOpen = false) {
  const original = spaceUiStore.getSnapshot();
  const selection = selected ? { contraption: { id: 1, getComponentName: () => 'Base' }, componentId: 'base',
    decorationId: 'trim', value: { id: 'trim', color: 0x123456, position: [2, 3, 4], scale: [2, 0.1, 1] } } : null;
  try {
    (spaceUiStore as any).patch({ selectedColor: 0xf2a93b, controller: { isLocked: !precisionOpen, selectedColor: 0xf2a93b, selectedMaterialId: 0,
      canEditEntityInternals: () => editable,
      modeling: { precisionOpen, canUndo: true, canRedo: false, isDragging: false,
        getSelection: () => selection, getDisplaySelection: () => selection } } });
    return { panel: renderToStaticMarkup(React.createElement(ModelingPanel)),
      toolbar: renderToStaticMarkup(React.createElement(ModelingToolbar)) };
  } finally { (spaceUiStore as any).patch(original); }
}

test('selected decorations expose all nine numeric fields while the game cursor is locked', () => {
  for (const precisionOpen of [false, true]) {
    const { panel, toolbar } = render(true, true, precisionOpen);
    for (const field of ['position', 'rotation', 'scale']) for (const axis of ['X', 'Y', 'Z']) {
      assert.ok(panel.includes(`aria-label="Decoration ${field} ${axis}"`));
    }
    assert.match(panel, /aria-label="Decoration properties"/);
    assert.doesNotMatch(panel, /Exact values|>Duplicate</);
    assert.doesNotMatch(panel, /Back to game|Local axes|resize from center|Position relative to component|release cursor|aria-label="Decoration color"/);
    assert.match(toolbar, /aria-label="Set color \(I\)"/);
    assert.doesNotMatch(toolbar, /Use palette color|Emissive|type="color"/);
    assert.match(toolbar, /<b>R<\/b> Copy/);
    assert.match(toolbar, /class="banner-btn danger"[^>]*title="Delete only the selected decoration/);
    assert.doesNotMatch(toolbar, /type="number"/);
  }
});

test('empty and read-only selections keep the inspector visible and disable destructive toolbar actions', () => {
  for (const selected of [false, true]) {
    const { panel, toolbar } = render(selected, false);
    assert.match(panel, /id="modeling-panel"/);
    for (const title of ['Copy the selected decoration', 'Delete only the selected decoration']) {
      const button = [...toolbar.matchAll(/<button\b([^>]*)>/g)].find(match => match[1].includes(title));
      assert.ok(button?.[1].includes('disabled=""'));
    }
    if (selected) assert.match(panel, /<fieldset disabled="">/);
    else assert.match(panel, /Select a decoration with LMB/);
    assert.match(toolbar, /aria-label="Set color \(I\)"/);
  }
});
