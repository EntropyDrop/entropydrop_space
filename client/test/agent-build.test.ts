import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

function fixture() {
  const store = new SpaceUiStore();
  const calls: string[] = [];
  store.setController({
    unlock: () => calls.push('unlock'),
    requestLock: () => calls.push('lock'),
  });
  calls.length = 0;
  return { store, calls };
}

test('HUD opens Agent Build instead of the retired model assistant', () => {
  const hud = source('ui/react/components/Hud.tsx');
  const root = source('ui/react/SpaceRoot.tsx');
  assert.match(hud, /id="agent-build-btn"/);
  assert.match(hud, />AGENT BUILD</);
  assert.match(hud, /onClick=\{\(\) => spaceUiStore\.toggleAgentBuild\(true\)\}/);
  assert.match(root, /React\.lazy\(\(\) => import\('\.\/components\/AgentBuildModal\.tsx'\)/);
  assert.match(root, /activeModal === 'agent-build'/);
  assert.doesNotMatch(`${hud}\n${root}`, /AI BUILD|ai-builder|BuildAssistantModal|toggleBuildAssistant|'builder'/);
  assert.equal(existsSync(new URL('../src/ui/react/components/BuildAssistantModal.tsx', import.meta.url)), false);
});

test('Agent Build unlocks controls on open and resumes them on explicit close', () => {
  const { store, calls } = fixture();
  store.toggleAgentBuild(true);
  assert.equal(store.getSnapshot().activeModal, 'agent-build');
  assert.equal(store.hasAnyModalOpen(), true);
  assert.deepEqual(calls, ['unlock']);
  store.toggleAgentBuild(false);
  assert.equal(store.getSnapshot().activeModal, null);
  assert.equal(store.hasAnyModalOpen(), false);
  assert.deepEqual(calls, ['unlock', 'lock']);
});

test('Escape closes Agent Build without capturing controls until the world is clicked', () => {
  const { store, calls } = fixture();
  store.startGame();
  calls.length = 0;
  store.toggleAgentBuild();
  assert.equal(store.handleEscape(), true);
  assert.equal(store.getSnapshot().activeModal, null);
  assert.deepEqual(calls, ['unlock', 'unlock']);
  store.resumeFromCanvas();
  assert.deepEqual(calls, ['unlock', 'unlock', 'lock']);
});

test('Agent Build replaces other panels and dismisses overlays without legacy state', () => {
  const { store } = fixture();
  store.toggleCodeEditorModal(true);
  store.toggleApiDocs(true);
  store.toggleAgentBuild(true);
  assert.equal(store.getSnapshot().activeModal, 'agent-build');
  assert.equal(store.getSnapshot().apiDocsOpen, false);
  assert.equal(store.getSnapshot().selectorContextMenu, null);
  const retiredFields = ['builder', 'buildAgentMessages', 'buildAgentBusy', 'buildAgentSetupOpen', 'buildValidation', 'buildSourcePlan', 'builderJob'];
  const retiredMethods = ['toggleBuildAssistant', 'setBuilder', 'setBuilderJob', 'sendBuildAgentMessage', 'confirmBuildPlan', 'undoLastBuild'];
  for (const name of retiredFields) assert.equal(name in store.getSnapshot(), false, name);
  for (const name of retiredMethods) assert.equal(name in store, false, name);
  store.toggleAgentBuild();
  assert.equal(store.getSnapshot().activeModal, null);
});

test('Agent Build reuses external-agent instructions and existing key management', () => {
  const modal = source('ui/react/components/AgentBuildModal.tsx');
  const settings = source('ui/react/components/SimpleModals.tsx');
  const guide = source('ui/react/components/SpaceAgentInstructions.tsx');
  assert.match(modal, /<SpaceApiKeysSettings\s*\/>/);
  assert.match(modal, /role="dialog" aria-modal="true" aria-labelledby="agent-build-title"/);
  assert.match(modal, /event\.target === event\.currentTarget/);
  assert.match(settings, /export function SpaceApiKeysSettings/);
  assert.match(settings, /<SpaceAgentInstructions\s*\/>/);
  assert.match(settings, /client\.create\(name\.trim\(\)\)/);
  assert.match(settings, /client\.revoke\(apiKey\.id\)/);
  assert.match(guide, /spaceAgentPrompt\(connection\.origin\)/);
  assert.match(guide, /navigator\.clipboard\.writeText\(prompt\)/);
  assert.doesNotMatch(modal, /AgentModelField|runSpaceBuildAgentTurn|saveAgentSettings|commit\(|preview\(/);
});

test('opening and closing Agent Build leaves existing API-key clients untouched', () => {
  const { store } = fixture();
  const client = {
    create() { assert.fail('opening a panel must not create a key'); },
    revoke() { assert.fail('closing a panel must not revoke a key'); },
  };
  (store as any).apiKeyClient = client;
  store.toggleAgentBuild(true);
  store.closeAllModals();
  assert.equal(store.getApiKeyClient(), client);
});

test('application startup, render loop and styles no longer activate the old BuildPlan flow', () => {
  const main = source('main.ts');
  const store = source('ui/react/store/SpaceUiStore.ts');
  const css = source('style.css');
  assert.doesNotMatch(main, /SpaceBuilder|spaceBuilder|getRenderPreview\(\)/);
  assert.match(main, /inventoryPlacementPreview/);
  assert.doesNotMatch(store, /SpaceBuilder|runSpaceBuildAgentTurn|buildSourcePlan|buildValidation|builderJob/);
  assert.match(css, /\.agent-build-modal-content\s*\{[^}]*overflow-y: auto/s);
  assert.match(css, /\.agent-build-hud-btn/);
  assert.doesNotMatch(css, /ai-builder-|\.build-assistant-|\.build-agent-/);
  assert.match(css, /\.agent-send-btn/, 'entity editor assistant styling is preserved');
});
