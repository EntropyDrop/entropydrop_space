import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { spaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

// Node's built-in type stripping does not handle JSX. Compile only this UI
// module in memory so these assertions cover rendered React, not source strings.
const componentUrl = new URL('../src/ui/react/components/EntityMenus.tsx', import.meta.url).href;
const hook = registerHooks({ load(url, context, nextLoad) {
  if (url !== componentUrl) return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText };
} });
const { EntityContextMenu, EntityNameplates } = await import(componentUrl);
hook.deregister();

function render(entity: any, component: any) {
  const original = spaceUiStore.getSnapshot();
  try {
    (spaceUiStore as any).patch({ hasStarted: true, activeModal: null, apiDocsOpen: false,
      currentUserName: 'Alice <Engineer>', contraptions: { contraptions: [entity] },
      entityContextMenu: { contraption: entity, x: 1, y: 2 } });
    return renderToStaticMarkup(React.createElement(component));
  } finally { (spaceUiStore as any).patch(original); }
}

function button(markup: string, label: string) {
  const result = [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .find(match => match[1].includes(`aria-label="${label}"`));
  assert.ok(result, `button must retain the accessible name: ${label}`);
  return { attributes: result[1], content: result[2] };
}

test('every entity action retains a shortened visible caption alongside its icon and descriptive hover title', () => {
  const markup = render({ id: 'one', rootComponentName: 'Walker', scriptStatus: 'stopped' }, EntityContextMenu);
  for (const [label, caption] of [['Start entity', 'Start'], ['Stop entity', 'Stop'], ['Copy entity to backpack', 'Copy to backpack'],
    ['Open programming interface', 'Program'], ['Select all root blocks', 'Select all'], ['Copy entity ID', 'Copy ID'], ['Delete entity…', 'Delete…']]) {
    const action = button(markup, label);
    assert.match(action.attributes, /title="[^"]+"/);
    assert.match(action.content, /^<svg\b/);
    assert.match(action.content, /aria-hidden="true"/);
    assert.equal(action.content.replace(/<[^>]*>/g, ''), caption, 'actions must not become icon-only');
  }
  assert.equal(button(markup, 'Close entity menu').content.replace(/<[^>]*>/g, ''), '');
  assert.match(markup, /class="entity-run-caption">Stopped</, 'menu keeps the full written status');
  assert.doesNotMatch(button(markup, 'Start entity').attributes, /disabled=/);
  assert.match(button(markup, 'Stop entity').attributes, /disabled=/);
});

test('iconifying actions preserves remote ownership and server-hosting availability restrictions', () => {
  const markup = render({ id: 'hosted', rootComponentName: 'Beacon', serverManaged: true,
    serverExecutionMode: 'hosted', serverHostingEnabled: true, serverDesiredRunState: 'running',
    serverCanControl: false, serverCanEdit: false }, EntityContextMenu);
  for (const label of ['Start entity', 'Stop entity', 'Open programming interface', 'Select all root blocks', 'Delete entity…']) {
    assert.match(button(markup, label).attributes, /disabled=/);
  }
  for (const label of ['Copy entity to backpack', 'Copy entity ID']) {
    assert.doesNotMatch(button(markup, label).attributes, /disabled=/);
  }
  assert.match(markup, /class="entity-run-status hosted"/);
  assert.match(markup, /aria-label="Server hosting · running"/);
});

test('nameplates show icon-only Stop, executor below the entity name, and distinct server-hosted icons/caption', () => {
  const stopped = render({ id: 'one', rootComponentName: 'Walker', scriptStatus: 'stopped' }, EntityNameplates);
  assert.match(stopped, /aria-label="Stopped" title="Stopped"><span class="entity-playback-icon stop"><svg/);
  assert.doesNotMatch(stopped, />Stopped</);
  assert.doesNotMatch(stopped, /class="entity-nameplate-executor"/);
  const running = render({ id: 'one', rootComponentName: 'Walker', scriptStatus: 'running' }, EntityNameplates);
  assert.match(running, /aria-label="Running · Alice &lt;Engineer&gt;"/);
  assert.match(running, /class="entity-playback-icon play"><svg/);
  assert.match(running, /class="entity-nameplate-labels"><span class="entity-nameplate-name" title="Walker">Walker<\/span><span class="entity-nameplate-executor" title="Executor: Alice &lt;Engineer&gt;">Alice &lt;Engineer&gt;<\/span><\/div>/);
  assert.doesNotMatch(running, /class="entity-run-caption"/, 'executor is not duplicated beside the status icon');
  assert.match(button(running, 'Entity actions: Walker').attributes, /data-entity-menu-id="one"/);
  const hosted = render({ id: 'two', rootComponentName: 'Beacon', serverManaged: true,
    serverExecutionMode: 'hosted', serverHostingEnabled: true, serverDesiredRunState: 'running' }, EntityNameplates);
  const badge = hosted.match(/class="entity-run-status hosted"([\s\S]*?)<\/span><button/);
  assert.ok(badge);
  assert.equal((badge[1].match(/<svg\b/g) || []).length, 2, 'server and playback icons distinguish hosting');
  assert.match(badge[1], /class="entity-run-caption">Server hosting</);
  assert.doesNotMatch(badge[1], /Alice/);
  assert.doesNotMatch(hosted, /class="entity-nameplate-executor"/);
});

test('the smaller second nameplate line uses the actual remote executor, while menu status remains unchanged', () => {
  const entity = { id: 'remote', rootComponentName: 'Rover', serverManaged: true,
    serverDesiredRunState: 'running', serverOwnerName: 'Owner', serverExecutorName: 'Bob',
    serverExecutionLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
  const nameplate = render(entity, EntityNameplates);
  assert.match(nameplate, /class="entity-nameplate-executor" title="Executor: Bob">Bob</);
  assert.doesNotMatch(nameplate, /class="entity-nameplate-executor"[^>]*>Owner</);
  const menu = render(entity, EntityContextMenu);
  assert.match(menu, /class="entity-run-caption">Running · Bob</);
  assert.doesNotMatch(menu, /class="entity-nameplate-labels"/);
});
