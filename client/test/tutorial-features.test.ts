import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as THREE from 'three';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { configureTutorialTerrain } from '../src/bootstrap/TutorialTerrain.ts';
import level from '../src/tutorial/tutorial-level.json' with { type: 'json' };

// Exercise tutorial policy in the normal online build, independently of offline mode.
const featureUrl = new URL('../src/bootstrap/SpaceFeatures.ts', import.meta.url).href;
const hook = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.svg?raw')) return {
    format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(readFileSync(new URL(url), 'utf8'))};`,
  };
  if (url !== featureUrl && !url.endsWith('.tsx')) return nextLoad(url, context);
  const source = readFileSync(new URL(url), 'utf8')
    .replace(/export const SPACE_TUTORIAL = [^\n]+/, 'export const SPACE_TUTORIAL = true;');
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText };
} });
after(() => hook.deregister());

const { SPACE_OFFLINE_BUILD, SPACE_LOCAL_SESSION, SPACE_HOSTING_UI_ENABLED, SPACE_TUTORIAL_AUTHORING } = await import('../src/bootstrap/SpaceFeatures.ts');
const { SpaceUiStore, spaceUiStore } = await import('../src/ui/react/store/SpaceUiStore.ts');
const { SpaceApiKeysSettings, PauseScreen } = await import('../src/ui/react/components/SimpleModals.tsx');
const { AgentBuildModal } = await import('../src/ui/react/components/AgentBuildModal.tsx');
const { InventoryModal } = await import('../src/ui/react/components/InventoryModal.tsx');
const { CodeEditorModal } = await import('../src/ui/react/components/EditorModal.tsx');
const { EntityContextMenu } = await import('../src/ui/react/components/EntityMenus.tsx');
const { Hud } = await import('../src/ui/react/components/Hud.tsx');

function render(component: React.ComponentType, state: Record<string, unknown> = {}) {
  const original = spaceUiStore.getSnapshot();
  try {
    (spaceUiStore as any).patch(state);
    return renderToStaticMarkup(React.createElement(component));
  } finally { (spaceUiStore as any).patch(original); }
}

test('tutorial denies all network capabilities even in an online build with credentials supplied', async t => {
  assert.equal(SPACE_OFFLINE_BUILD, false);
  assert.equal(SPACE_LOCAL_SESSION, true);
  assert.equal(SPACE_HOSTING_UI_ENABLED, false);
  const original = globalThis.fetch;
  globalThis.fetch = () => { assert.fail('tutorial must not send API requests'); };
  t.after(() => { globalThis.fetch = original; });
  const store = new SpaceUiStore();
  store.setAuthenticatedSession('https://example.com', 'test-token', true, 'test-world', 'https://example.com', 'Tutorial Player');
  assert.equal(store.getMarketClient(), null);
  assert.equal(store.getApiKeyClient(), null);
  assert.equal(store.getSnapshot().isAdmin, false);
  assert.equal(store.getSnapshot().currentUserName, 'Tutorial Player');
  const forbidden = async (): Promise<never> => assert.fail('tutorial network adapter must not run');
  store.setEntityHostingHandlers({ host: forbidden, stop: forbidden, get: forbidden, refresh: forbidden });
  assert.equal(await store.hostEntity({ publicId: 'local' }, 1), false);
  await store.refreshHosting();
  store.connectLinkedWorlds(() => assert.fail('tutorial must not link remote worlds'));
  store.setLinkedWorldsEnabled(true);
  await store.sendAgentMessage('build a lesson');
  store.toggleAdminMonitoring(true);
  assert.equal(store.getSnapshot().linkedWorlds.enabled, false);
  assert.equal(store.getSnapshot().agentBusy, false);
  assert.notEqual(store.getSnapshot().activeModal, 'monitoring');
});

test('tutorial entity editor and menu display the current player without browser labels', () => {
  const entity = { id: 1, publicId: 'tutorial-test', blocks: [], entityNodes: new Map(),
    bodyType: 'dynamic', scriptStatus: 'running', isPhysicsSimulationEnabled: () => true };
  const state = { currentUserName: 'Alice <Engineer>', contraptions: { contraptions: [entity] } };
  const editor = render(CodeEditorModal, { ...state, activeModal: 'code', editingContraption: entity });
  const menu = render(EntityContextMenu, { ...state, entityContextMenu: { contraption: entity, x: 100, y: 100 } });
  assert.match(editor, /Alice &lt;Engineer&gt;/);
  assert.match(menu, /Running · Alice &lt;Engineer&gt;/);
  assert.doesNotMatch(editor, /this browser/);
  assert.doesNotMatch(menu, /this browser/);
  assert.doesNotMatch(menu, /Server Hosting|Server hosting|Host on server|Hosting credit budget|Leave tutorial/);
});

test('published tutorial keeps controls and feature notices but has no save button', () => {
  assert.equal(SPACE_TUTORIAL_AUTHORING, false);
  const pause = render(PauseScreen);
  assert.match(pause, /id="tutorial-btn"/);
  const hud = render(Hud);
  assert.doesNotMatch(hud, /id="save-tutorial-btn"/);
  for (const [component, state] of [
    [SpaceApiKeysSettings, {}],
    [AgentBuildModal, { activeModal: 'agent-build' }],
    [InventoryModal, { activeModal: 'inventory' }],
    [CodeEditorModal, { activeModal: 'code', editingContraption: {
      id: 1, publicId: 'tutorial-test', blocks: [], entityNodes: new Map(), bodyType: 'dynamic',
    } }],
  ] as const) {
    const markup = render(component, state);
    assert.match(markup, /tutorial/);
    assert.match(markup, /Leave tutorial/);
    assert.doesNotMatch(markup, /id="agent-api-key"|id="agent-chat-send-btn"|Hosting credit budget|market-sort-buttons/);
  }
});

test('published tutorials cannot install a writer and still report navigation failures', async () => {
  const store = new SpaceUiStore();
  store.setTutorialActions({
    save: async () => assert.fail('a deployed tutorial must never write its source file'),
    navigate: async () => { throw new Error('disk full'); },
  });
  await store.saveTutorialLevel();
  await store.navigateTutorial(false);
  assert.match(store.getSnapshot().toast?.message ?? '', /Could not save your backpack/);
});

test('tutorial settings keep the fixed terrain window and preserve other worlds preferences', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const saved = new Map([
    ['space_setting_render_dist', '4'],
    ['space_setting_distant_surface', '{"renderDistanceChunks":32}'],
  ]);
  const before = [...saved];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const world = new World(new THREE.Scene(), level.generator.seed, null, level.generator.version);
  configureTutorialTerrain(world, level.spawn);
  const store = new SpaceUiStore();
  store.setWorld(world);
  store.setSceneRenderer(null);
  store.setRenderDistance(16);
  store.setDistantSurfaceSetting('renderDistanceChunks', 64);
  store.resetDistantSurfaceSettings();
  world.updateChunksAround(0, 0, false);
  assert.equal(world.activeChunkKeys.size, 625);
  assert.equal(world.distantSurface.isEnabled(), false);
  assert.equal(store.getSnapshot().renderDistance, 12);
  assert.deepEqual([...saved], before);
});
