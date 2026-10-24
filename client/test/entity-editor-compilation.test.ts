import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { executeBasicAction } from '@entropydrop/space-engine/actions/BasicActions.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

const originalAnimationFrame = globalThis.requestAnimationFrame;
test.before(() => { globalThis.requestAnimationFrame = () => 0; });
test.after(() => { globalThis.requestAnimationFrame = originalAnimationFrame; });

function fixture() {
  const entity = new Contraption(1, [0, 1].map(localX => ({ localX, localY: 0, localZ: 0, block: 1 })),
    new THREE.Vector3(), new THREE.Scene(), { rootComponentId: 'root' });
  assert.ok(entity.createChildEntity('root', [entity.blocks[1]], 'arm'));
  entity.stopAllNodeScripts();
  const store = new SpaceUiStore();
  const compiled: string[] = [];
  const compile = entity.scriptRuntimeClient.setScript.bind(entity.scriptRuntimeClient);
  entity.scriptRuntimeClient.setScript = (id, code) => { if (code.trim()) compiled.push(code); return compile(id, code); };
  let saves = 0;
  (store as any).patch({ hasStarted: true, contraptions: { contraptions: [entity], saveEntitiesToStorage() { saves++; },
    performBasicAction: (command: any) => executeBasicAction({ contraption: entity }, command) } });
  store.showToast = () => {};
  return { entity, store, compiled, saves: () => saves };
}

test('editing, switching components and closing only save; Start compiles the newest drafts', async () => {
  const { entity, store, compiled, saves } = fixture();
  try {
    store.openCodeEditor(entity);
    store.setScriptDraft('unfinished syntax !!!');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.deepEqual(compiled, [], 'there is no debounced background compilation');
    assert.equal(entity.nodeScriptErrors.size, 0, 'unfinished text is not compiled');
    store.setScriptDraft('ctx.log("latest root");');
    store.selectComponentTreeNode('arm');
    store.setScriptDraft('ctx.log("latest arm");');
    store.closeAllModals();
    assert.deepEqual(compiled, [], 'switching nodes and closing the editor must not compile');
    assert.ok(saves() > 0);
    assert.equal(entity.isPhysicsSimulationEnabled(), false);
    store.openCodeEditor(entity);
    await store.setGlobalPlayback('play');
    assert.deepEqual(compiled.sort(), ['ctx.log("latest arm");', 'ctx.log("latest root");']);
    entity.update(0.05, null, {});
    assert.deepEqual(entity.output.entries.filter(entry => entry.kind === 'console').map(entry => [entry.nodeId, entry.text]),
      [['root', 'latest root'], ['arm', 'latest arm']]);
    await store.setGlobalPlayback('stop');
    await store.setGlobalPlayback('play');
    assert.equal(compiled.length, 2, 'unchanged code reuses compiled programs');
  } finally { entity.dispose(); }
});

test('AI Apply saves without compiling, and errors appear only when Start is requested', async () => {
  const { entity, store, compiled } = fixture();
  try {
    store.openCodeEditor(entity);
    await store.applyAgentCode('const broken: MissingType = 1;', 'arm');
    assert.equal(entity.getNodeScript('arm'), 'const broken: MissingType = 1;');
    assert.deepEqual(compiled, []);
    assert.equal(entity.nodeScriptErrors.size, 0);
    await store.setGlobalPlayback('play');
    assert.ok(entity.nodeScriptErrors.has('arm'));
    assert.ok(entity.output.entries.some(entry => entry.kind === 'error' && entry.text.includes('Compile error')));
  } finally { entity.dispose(); }
});

test('renaming a component preserves its pending draft and clearing it never revives old code', async () => {
  const { entity, compiled } = fixture();
  try {
    entity.setNodeScriptDraft('arm', 'ctx.log("renamed");');
    entity.renameChildEntity('arm', 'tip');
    assert.deepEqual(compiled, []);
    entity.enableAllNodeScripts();
    await entity.scriptRuntimeClient.ready();
    entity.update(0.05, null, {});
    assert.ok(entity.output.entries.some(entry => entry.nodeId === 'tip' && entry.text === 'renamed'));
    entity.stopAllNodeScripts();
    entity.setNodeScriptDraft('tip', '');
    entity.enableAllNodeScripts();
    entity.update(0.05, null, {});
    assert.equal(entity.compiledNodeScripts.has('tip'), false);
    assert.equal(compiled.length, 1);
  } finally { entity.dispose(); }
});
