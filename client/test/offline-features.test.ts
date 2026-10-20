import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Exercise the same compile-time flag as Vite's offline mode, in an isolated test process.
const featureUrl = new URL('../src/bootstrap/SpaceFeatures.ts', import.meta.url).href;
const hook = registerHooks({ load(url, context, nextLoad) {
  if (url !== featureUrl && !url.endsWith('.tsx')) return nextLoad(url, context);
  const source = readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env?.VITE_SPACE_OFFLINE', "'1'");
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText };
} });
after(() => hook.deregister());

const { SPACE_OFFLINE_BUILD, SPACE_HOSTING_UI_ENABLED } = await import('../src/bootstrap/SpaceFeatures.ts');
const { SpaceUiStore, spaceUiStore } = await import('../src/ui/react/store/SpaceUiStore.ts');
const { ONLINE_SPACE_FEATURES, onlineSpaceUrl, onlinePanelSettingsTab } = await import('../src/bootstrap/SpaceSiteLinks.ts');
const { SpaceApiKeysSettings } = await import('../src/ui/react/components/SimpleModals.tsx');
const { AgentBuildModal } = await import('../src/ui/react/components/AgentBuildModal.tsx');
const { InventoryModal } = await import('../src/ui/react/components/InventoryModal.tsx');
const { CodeEditorModal, ApiDocsModal } = await import('../src/ui/react/components/EditorModal.tsx');
const { EntityContextMenu } = await import('../src/ui/react/components/EntityMenus.tsx');
assert.equal(SPACE_OFFLINE_BUILD, true);
assert.equal(SPACE_HOSTING_UI_ENABLED, false);

function render(component: React.ComponentType, state: Record<string, unknown> = {}) {
  const original = spaceUiStore.getSnapshot();
  try {
    (spaceUiStore as any).patch(state);
    return renderToStaticMarkup(React.createElement(component));
  } finally { (spaceUiStore as any).patch(original); }
}

test('offline policy rejects account clients and does not read or save model credentials', async t => {
  const stored = new Map([
    ['space.agent.config.v1', JSON.stringify({ apiKey: 'test-model-key', rememberApiKey: true })],
    ['space.agent.api-key.session.v1', 'test-session-key'],
  ]);
  const reads: string[] = [];
  const original = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['localStorage', 'sessionStorage', 'fetch']) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  const storage = { getItem(key: string) { reads.push(key); return stored.get(key) ?? null; },
    setItem() { assert.fail('offline model settings must not write credentials'); }, removeItem() {} };
  for (const key of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: storage });
  }
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: () => assert.fail('offline actions must not fetch') });
  t.after(() => {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const store = new SpaceUiStore();
  store.setAuthenticatedSession('https://space.entropydrop.com', 'test-token', true, 'test-world');
  assert.equal(store.getMarketClient(), null);
  assert.equal(store.getApiKeyClient(), null);
  assert.equal(store.getSnapshot().isAdmin, false);
  store.toggleAdminMonitoring(true);
  assert.notEqual(store.getSnapshot().activeModal, 'monitoring');
  assert.equal(store.getSnapshot().agentConfig.apiKey, '');
  assert.ok(!reads.some(key => key.startsWith('space.agent.')));
  store.toggleAgentSetup(true);
  store.saveAgentSettings({ apiKey: 'new-test-key', rememberApiKey: true });
  await store.sendAgentMessage('follow me');
  assert.equal(store.getSnapshot().agentConfig.apiKey, '');
  assert.equal(store.getSnapshot().agentSetupOpen, false);
  assert.equal(store.getSnapshot().agentBusy, false);
});

test('offline policy cannot install hosting or linked-world network handlers', async () => {
  const store = new SpaceUiStore();
  const forbidden = async (): Promise<never> => assert.fail('offline handler must not run');
  store.setEntityHostingHandlers({ host: forbidden, stop: forbidden, get: forbidden, refresh: forbidden });
  assert.equal(await store.hostEntity({ publicId: 'local' }, 1), false);
  assert.equal(await store.stopHostedEntity('local'), false);
  await store.refreshHosting();
  store.connectLinkedWorlds(() => assert.fail('offline world linking must not run'));
  store.setLinkedWorldsEnabled(true);
  assert.equal(store.getSnapshot().linkedWorlds.enabled, false);
});

test('offline API keys and Agent Build expose separate online links without key controls', () => {
  const keys = render(SpaceApiKeysSettings);
  assert.match(keys, /API Keys &amp; Account Usage/);
  assert.match(keys, /https:\/\/space\.entropydrop\.com\/\?panel=api-keys/);
  assert.doesNotMatch(keys, /<input|Revoke|Copy the Agent Prompt/);
  const agent = render(AgentBuildModal, { activeModal: 'agent-build' });
  assert.match(agent, /\?panel=agent-build/);
  assert.doesNotMatch(agent, /<input|Revoke/);
});

test('offline market renders an online invitation instead of market queries and filters', () => {
  const markup = render(InventoryModal, { activeModal: 'inventory' });
  assert.match(markup, /\?panel=market/);
  assert.match(markup, /Open Online Market/);
  assert.doesNotMatch(markup, /Loading market resources|market-scope-buttons|market-sort-buttons/);
});

test('offline entity editor retains local scripting and replaces model setup with online guidance', () => {
  const markup = render(CodeEditorModal, { activeModal: 'code', editingContraption: {
    id: 1, publicId: 'offline-test', blocks: [], entityNodes: new Map(), bodyType: 'dynamic',
  } });
  assert.match(markup, /id="script-textarea"/);
  assert.match(markup, /AI Assistant Online/);
  assert.match(markup, /\?panel=agent-build/);
  assert.doesNotMatch(markup, /id="agent-api-key"|id="agent-api-base"|id="agent-api-model"|id="agent-chat-send-btn"/);
  const docs = render(ApiDocsModal, { apiDocsOpen: true });
  assert.match(docs, /https:\/\/space\.entropydrop\.com\/space\/agent/);
  assert.doesNotMatch(docs, /localhost|127\.0\.0\.1/);
});

test('offline entity menu offers online hosting instead of a local credit form', () => {
  const markup = render(EntityContextMenu, { entityContextMenu: {
    contraption: { id: 1, publicId: 'offline-test', blocks: [], mode: 'building' }, x: 100, y: 100,
  } });
  assert.match(markup, /Server Hosting Online/);
  assert.match(markup, /\?panel=hosting/);
  assert.doesNotMatch(markup, /aria-label="Host on server"|Hosting credit budget|Confirm hosting/);
});

test('every offline online-only feature opens the production Space in the intended settings or panel', () => {
  for (const feature of Object.values(ONLINE_SPACE_FEATURES)) {
    const url = new URL(onlineSpaceUrl(feature.panel));
    assert.equal(url.origin, 'https://space.entropydrop.com');
    assert.equal(url.searchParams.get('panel'), feature.panel);
  }
  assert.equal(onlinePanelSettingsTab('api-keys'), 'api');
  assert.equal(onlinePanelSettingsTab('hosting'), 'api');
  assert.equal(onlinePanelSettingsTab('character'), 'character');
  assert.equal(onlinePanelSettingsTab('worlds'), 'graphics');
  assert.equal(onlinePanelSettingsTab('unknown'), null);
});
