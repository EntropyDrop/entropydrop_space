import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import source from '../src/tutorial/tutorial-level.json' with { type: 'json' };

const featureUrl = new URL('../src/bootstrap/SpaceFeatures.ts', import.meta.url).href;
const writerUrl = new URL('../src/bootstrap/TutorialLevelWriter.ts', import.meta.url).href;
const hook = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.svg?raw')) return {
    format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(readFileSync(new URL(url), 'utf8'))};`,
  };
  if (url !== featureUrl && url !== writerUrl && !url.endsWith('.tsx')) return nextLoad(url, context);
  const source = readFileSync(new URL(url), 'utf8')
    .replace(/export const SPACE_TUTORIAL = [^\n]+/, 'export const SPACE_TUTORIAL = true;')
    .replace(/export const SPACE_TUTORIAL_AUTHORING = [\s\S]*?;/, 'export const SPACE_TUTORIAL_AUTHORING = true;')
    .replace('import.meta.env.BASE_URL', "'/space/app/'");
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText };
} });
after(() => hook.deregister());

const { SpaceUiStore, spaceUiStore } = await import('../src/ui/react/store/SpaceUiStore.ts');
const { Hud } = await import('../src/ui/react/components/Hud.tsx');
const { writeTutorialLevel } = await import('../src/bootstrap/TutorialLevelWriter.ts');
const { parseTutorialLevel } = await import('../src/tutorial/TutorialLevelFormat.ts');
const { isLocalTutorialHost } = await import('../src/bootstrap/SpaceFeatures.ts');

test('only loopback hosts qualify for local tutorial authoring', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(isLocalTutorialHost(host), true);
  for (const host of ['space.entropydrop.com', '192.168.1.2', 'localhost.example.com', '']) {
    assert.equal(isLocalTutorialHost(host), false);
  }
});

test('local save waits for disk acknowledgement, blocks double clicks and reports failures', async () => {
  const store = new SpaceUiStore();
  let writes = 0;
  let finish!: () => void;
  store.setTutorialActions({
    navigate: async () => {},
    save: () => { writes++; return new Promise<void>(resolve => { finish = resolve; }); },
  });
  (store as any).patch({ bulkEdit: { phase: 'applying' } });
  await store.saveTutorialLevel();
  assert.equal(writes, 0);
  (store as any).patch({ bulkEdit: null, toast: null });
  const pending = store.saveTutorialLevel();
  assert.equal(store.getSnapshot().tutorialSaving, true);
  assert.equal(store.getSnapshot().toast, null);
  await store.saveTutorialLevel();
  assert.equal(writes, 1);
  finish();
  await pending;
  assert.equal(store.getSnapshot().tutorialSaving, false);
  assert.equal(store.getSnapshot().toast?.message, 'Tutorial level saved.');
  store.setTutorialActions({ navigate: async () => {}, save: async () => { throw new Error('disk full'); } });
  await store.saveTutorialLevel();
  assert.equal(store.getSnapshot().tutorialSaving, false);
  assert.match(store.getSnapshot().toast?.message ?? '', /Could not save the tutorial: disk full/);
});

test('local authoring shows Save Level and disables it while saving', () => {
  const original = spaceUiStore.getSnapshot();
  try {
    assert.match(renderToStaticMarkup(React.createElement(Hud)), /id="save-tutorial-btn"/);
    (spaceUiStore as any).patch({ tutorialSaving: true });
    const button = renderToStaticMarkup(React.createElement(Hud)).match(/<button id="save-tutorial-btn"[\s\S]*?<\/button>/)?.[0] ?? '';
    assert.match(button, /disabled/);
    assert.match(button, /Saving/);
  } finally { (spaceUiStore as any).patch(original); }
});

test('local writer sends the captured level to the development endpoint and rejects unsuccessful responses', async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const level = parseTutorialLevel(source);
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/space/app/__dev/tutorial-level');
    assert.equal(options?.method, 'PUT');
    assert.equal(options?.credentials, 'omit');
    assert.deepEqual(JSON.parse(String(options?.body)), level);
    return new Response(JSON.stringify({ saved: true }), { status: 200 });
  };
  await writeTutorialLevel(level);
  for (const response of [
    new Response(JSON.stringify({ error: 'disk full' }), { status: 500 }),
    new Response('<html>Missing endpoint</html>', { status: 200 }),
  ]) {
    globalThis.fetch = async () => response;
    await assert.rejects(writeTutorialLevel(level), /disk full|could not save/);
  }
});
