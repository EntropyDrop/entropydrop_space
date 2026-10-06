import { worldStub } from './fixtures.ts';
import { requireValue } from './fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { setScript } from './script-helpers.ts';

const trim: import('../src/contraption/Decorations.ts').DecorationDefinition = { id: 'trim', color: 0xff0000, position: [2, 0, 0], scale: [2, 0.1, 1] };
const block = (x: number, entityId: string) => ({ localX: x, localY: 0, localZ: 0, size: 1, color: 1, block: 1, entityId });
function fixture() {
  return new Contraption(1, [block(0, 'base'), block(2, 'arm')], new THREE.Vector3(), new THREE.Scene(), {
    rootComponentId: 'base', decorations: [trim],
    childEntities: [{ id: 'arm', parentId: 'base', pivot: [2, 0, 0], decorations: [trim] }],
  });
}

test('compiled decoration commands animate both component types without changing authored data or physics', async () => {
  const entity = fixture();
  try {
    const original = entity.serializeSubtree();
    const collision = entity.collisionCells;
    const bodies = entity.getRigidBodies().map(body => [body, body.mass, body.inverseInertia]);
    const mesh = entity.decorationGroups.get('base')!.children[0] as THREE.Mesh;
    const geometry = mesh.geometry, material = mesh.material;
    assert.equal(await setScript(entity, `
      self.decorations.upsert("trim", Value.object().setVector("position", [4, 1, 0])
        .setVector("scale", [3, 0.2, 1]).setVector("rotation", [0, 1, 0, 0]).setNumber("color", 0x00ff00));
      const arm = self.child("arm");
      if (arm) {
        arm.decorations.remove("trim");
        arm.decorations.upsert("glow", Value.object().setNumber("materialId", 1));
      }
      self.state.setString("command", self.decorations.upsert("spark", Value.object()).getString("commandId"));
    `), true);
    entity.update(0.05, null, {});
    assert.equal(entity.nodeScriptErrors.size, 0);
    assert.equal(entity.getRuntimeComponentDecorations('base').length, 2);
    assert.deepEqual(entity.getRuntimeComponentDecorations('arm'), [{ id: 'glow', color: 0, materialId: 1 }]);
    assert.deepEqual(mesh.scale.toArray(), [3, 0.2, 1]);
    assert.deepEqual(mesh.quaternion.toArray(), [0, 1, 0, 0]);
    assert.equal(mesh.geometry, geometry);
    assert.equal(mesh.material, material);
    assert.equal(entity.decorationGroups.get('base')!.children.find(value => value.userData.decorationId === 'trim'), mesh);
    assert.equal((material as THREE.MeshStandardNodeMaterial).color.getHex(), 0x00ff00);
    assert.equal(entity.collisionCells, collision);
    assert.deepEqual(entity.getRigidBodies().map(body => [body, body.mass, body.inverseInertia]), bodies);
    assert.deepEqual(requireValue(entity.serializeSubtree()).decorations, requireValue(original).decorations);
    assert.deepEqual(requireValue(entity.serializeSubtree()).childEntities[0].decorations, requireValue(original).childEntities[0].decorations);
    const command = entity.getComponentState('base').command;
    assert.equal(entity.pendingScriptCommandResults.find(result => result.commandId === command)?.reason, 'applied');
    entity.stopAllNodeScripts();
    assert.deepEqual(entity.getRuntimeComponentDecorations('base'), [trim]);
    assert.deepEqual(entity.getRuntimeComponentDecorations('arm'), [trim]);
    assert.equal(entity.runtimeDecorations.size, 0);
  } finally { entity.dispose(); }
});

test('runtime overrides survive checkpoint restore while inventory export retains authored decorations', () => {
  const entity = fixture();
  const manager = new ContraptionManager(new THREE.Scene(), worldStub(), null, null);
  let restored: any;
  try {
    entity.scriptStatus = 'running';
    const api = requireValue(entity.getChildScriptApi('base')).decorations;
    assert.equal(api.remove('trim').ok, true);
    assert.equal(requireValue(entity.getChildScriptApi('arm')).decorations.upsert('extra', { position: [5, 2, 1] }).ok, true);
    const record = manager.captureContraptionForStreaming(entity, { id: '0,0' });
    assert.deepEqual(requireValue(record.slot).decorations, [trim]);
    assert.deepEqual(requireValue(record.runtimeDecorations.find(value => value.id === 'base')).decorations, []);
    restored = manager.buildFromSlot(record.slot, new THREE.Vector3().fromArray(record.constructorOrigin), record, false);
    assert.deepEqual(restored.captureRuntimeDecorations(), record.runtimeDecorations);
    assert.equal(restored.decorationGroups.get('base').children.length, 0);
    assert.equal(restored.getRuntimeComponentDecorations('arm').length, 2);
    restored.stopAllNodeScripts();
    assert.deepEqual(restored.getRuntimeComponentDecorations('base'), [trim]);
    assert.deepEqual(restored.getRuntimeComponentDecorations('arm'), [trim]);
    const stopped = { ...record, scriptStatus: 'stopped' };
    manager.restoreContraptionStreamingState(restored, stopped);
    assert.equal(restored.runtimeDecorations.size, 0, 'stopped snapshots cannot resurrect overrides');
  } finally { entity.dispose(); restored?.dispose(); }
});

test('runtime validates updates atomically, limits across components, and immutable reads', () => {
  const entity = fixture();
  try {
    const api = requireValue(entity.getChildScriptApi('arm')).decorations;
    for (const patch of [{ color: null }, { scale: [0, 1, 1] }, { rotation: [0, 0, 0, 0] },
      { color: true }, { position: [Infinity, 0, 0] }, { id: 'oops' }, { unknown: 1 }]) {
      assert.equal(api.upsert('trim', patch).reason, 'invalid_decoration');
    }
    assert.deepEqual(api.get('trim'), trim);
    assert.throws(() => { requireValue(requireValue(api.get('trim')).position)[0] = 100; });
    assert.equal(api.remove('missing').reason, 'decoration_not_found');
    assert.equal(api.upsert('bad space', {}).reason, 'invalid_decoration');
    entity.setComponentDecorations('base', Array.from({ length: 1023 }, (_, i) => ({ id: `d${i}`, color: 1 })));
    assert.equal(api.upsert('extra', {}).reason, 'too_many_decorations');
    assert.equal(api.upsert('trim', { position: [0, 0, 0], color: 3 }).ok, true);
    assert.deepEqual(api.get('trim'), { id: 'trim', color: 3, scale: trim.scale });
    const before = entity.captureRuntimeDecorations();
    assert.throws(() => entity.restoreRuntimeDecorations([{ id: 'arm', decorations: [trim, { id: 'extra', color: 0 }] }]));
    assert.throws(() => entity.restoreRuntimeDecorations([{ id: 'missing', decorations: [] }]));
    assert.deepEqual(entity.captureRuntimeDecorations(), before);
    assert.equal(entity.getRuntimeDecorationCount(), 1024);
    assert.equal(api.remove('trim').ok, true);
    assert.equal(api.upsert('extra', {}).ok, true);
  } finally { entity.dispose(); }
});
